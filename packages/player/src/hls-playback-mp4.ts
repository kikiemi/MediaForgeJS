import {
    invalidArgument,
    malformed,
    overLimit,
    typedArrayBuffer as buffer,
    typedArrayByteLength as byteLength,
    typedArrayOffset as byteOffset,
    typedArrayTag as tag,
    unsupported,
} from './support.js';

interface Box {
    type: string;
    start: number;
    end: number;
}

interface PlaybackTrack {
    timescale: number;
    defaultDuration: number;
    defaultFlags: number;
    video: boolean;
    /**
     * Media time in ticks that a single rate-one edit skips (Opus pre-roll); presentation starts
     * there.
     */
    editOffset: number;
}

export type HlsPlaybackTracks = ReadonlyMap<number, PlaybackTrack>;

const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;

/** Borrows attached, non-shared bytes until the current append has completed. */
export function hlsPlaybackBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
    try {
        if (tag.call(value) !== 'Uint8Array')
            invalidArgument('HLS playback: media data must be Uint8Array bytes');
        const backing = buffer.call(value) as ArrayBuffer;
        arrayLength.call(backing);
        return new Uint8Array(backing, byteOffset.call(value), byteLength.call(value));
    } catch {
        return invalidArgument(
            'HLS playback: media data must be attached, non-shared Uint8Array bytes',
        );
    }
}

class Mp4TimingReader {
    private readonly view: DataView;
    private remainingBoxes = 10000;
    remainingSamples = 1000000;

    constructor(bytes: Uint8Array<ArrayBuffer>) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    uint(offset: number, end: number): number {
        if (offset < 0 || offset + 4 > end) malformed('HLS playback: truncated fMP4 timing field');
        return this.view.getUint32(offset);
    }

    wide(offset: number, end: number): number {
        const value = this.uint(offset, end) * 0x100000000 + this.uint(offset + 4, end);
        if (!Number.isSafeInteger(value))
            unsupported('HLS playback: fMP4 timestamp or size exceeds the safe integer range');
        return value;
    }

    signed(offset: number, end: number): number {
        this.uint(offset, end);
        return this.view.getInt32(offset);
    }

    boxes(start = 0, end = this.view.byteLength): Box[] {
        const boxes: Box[] = [];
        while (start < end) {
            if (--this.remainingBoxes < 0)
                overLimit('HLS playback: fMP4 timing inspection exceeds 10000 boxes per unit');
            const size32 = this.uint(start, end);
            this.uint(start + 4, end);
            const type = String.fromCharCode(
                ...[0, 1, 2, 3].map(index => this.view.getUint8(start + 4 + index)),
            );
            const header = size32 === 1 ? 16 : 8;
            const size = size32 === 1 ? this.wide(start + 8, end) : size32 || end - start;
            if (size < header || size > end - start)
                malformed('HLS playback: invalid or truncated fMP4 box');
            boxes.push({ type, start: start + header, end: start + size });
            start += size;
        }
        return boxes;
    }

    children(parent: Box): Box[] {
        return this.boxes(parent.start, parent.end);
    }

    one(boxes: Box[], type: string): Box {
        const matches = boxes.filter(box => box.type === type);
        if (matches.length !== 1) malformed(`HLS playback: fMP4 requires exactly one ${type} box`);
        return matches[0]!;
    }

    version(box: Box): number {
        const version = this.uint(box.start, box.end) >>> 24;
        if (version > 1) unsupported(`HLS playback: unsupported ${box.type} version`);
        return version;
    }
}

export function hlsPlaybackTracks(bytes: Uint8Array<ArrayBuffer>): HlsPlaybackTracks {
    const reader = new Mp4TimingReader(bytes);
    const top = reader.boxes();
    reader.one(top, 'ftyp');
    const movie = reader.children(reader.one(top, 'moov'));
    const defaults = reader.children(reader.one(movie, 'mvex'));
    const tracks = new Map<number, PlaybackTrack>();
    const kinds = new Set<number>();
    for (const track of movie.filter(box => box.type === 'trak')) {
        const children = reader.children(track);
        const header = reader.one(children, 'tkhd');
        const id = reader.uint(header.start + (reader.version(header) === 1 ? 20 : 12), header.end);
        const media = reader.children(reader.one(children, 'mdia'));
        const mediaHeader = reader.one(media, 'mdhd');
        const timescale = reader.uint(
            mediaHeader.start + (reader.version(mediaHeader) === 1 ? 20 : 12),
            mediaHeader.end,
        );
        const handler = reader.one(media, 'hdlr');
        const kind = reader.uint(handler.start + 8, handler.end);
        if ((kind !== 0x76696465 && kind !== 0x736f756e) || kinds.has(kind)) {
            unsupported(
                'HLS playback: fMP4 playback requires at most one video and one audio track',
            );
        }
        kinds.add(kind);
        if (!id || tracks.has(id) || !timescale)
            malformed('HLS playback: invalid fMP4 track identifier or timescale');
        const edits = children.filter(box => box.type === 'edts');
        if (edits.length > 1) unsupported('HLS playback: multiple fMP4 edit boxes are unsupported');
        let editOffset = 0;
        if (edits[0]) {
            const edit = reader.one(reader.children(edits[0]), 'elst');
            const version = reader.version(edit);
            const mediaTime = version
                ? reader.wide(edit.start + 16, edit.end)
                : reader.uint(edit.start + 12, edit.end);

            // A single forward media-time edit is how Opus pre-roll is expressed; browsers apply it
            // as an offset.
            if (
                reader.uint(edit.start + 4, edit.end) !== 1 ||
                !Number.isSafeInteger(mediaTime) ||
                mediaTime < 0 ||
                reader.uint(edit.start + (version ? 24 : 16), edit.end) !== 0x10000
            ) {
                unsupported('HLS playback: fMP4 edit lists require a single forward rate-one edit');
            }
            editOffset = mediaTime;
        }
        const trex = defaults.filter(
            box => box.type === 'trex' && reader.uint(box.start + 4, box.end) === id,
        );
        if (trex.length !== 1) malformed('HLS playback: missing or duplicate fMP4 track defaults');
        tracks.set(id, {
            timescale,
            defaultDuration: reader.uint(trex[0]!.start + 12, trex[0]!.end),
            defaultFlags: reader.uint(trex[0]!.start + 20, trex[0]!.end),
            video: kind === 0x76696465,
            editOffset,
        });
    }
    if (!tracks.size) unsupported('HLS playback: fMP4 initialization has no audio or video tracks');
    return tracks;
}

/** Presentation range in seconds; all tracks share one offset so A/V skew is preserved. */
export function hlsPlaybackTiming(
    bytes: Uint8Array<ArrayBuffer>,
    tracks: HlsPlaybackTracks,
): {
    start: number;
    end: number;
    randomAccess: number[];
} {
    const reader = new Mp4TimingReader(bytes);
    const top = reader.boxes();
    if (!top.some(box => box.type === 'moof') || !top.some(box => box.type === 'mdat')) {
        unsupported('HLS playback: media units must hold whole fMP4 fragments (moof and mdat)');
    }

    let start = Infinity;
    let end = -Infinity;
    const randomAccess: number[] = [];
    for (const movie of top.filter(box => box.type === 'moof')) {
        const fragments = reader.children(movie).filter(box => box.type === 'traf');
        if (!fragments.length) malformed('HLS playback: fMP4 fragment has no tracks');
        for (const fragment of fragments) {
            const children = reader.children(fragment);
            const header = reader.one(children, 'tfhd');
            const flags = reader.uint(header.start, header.end) & 0xffffff;
            const track = tracks.get(reader.uint(header.start + 4, header.end));
            if (!track) malformed('HLS playback: fMP4 fragment references an uninitialized track');
            if (flags & 1)
                unsupported(
                    'HLS playback: fMP4 playback requires movie-fragment-relative addressing',
                );

            let cursor = header.start + 8;
            if (flags & 2) {
                reader.uint(cursor, header.end);
                cursor += 4;
            }

            let defaultDuration = track.defaultDuration;
            if (flags & 8) {
                defaultDuration = reader.uint(cursor, header.end);
                cursor += 4;
            }
            if (flags & 16) {
                reader.uint(cursor, header.end);
                cursor += 4;
            }

            const defaultFlags = flags & 32 ? reader.uint(cursor, header.end) : track.defaultFlags;
            const decode = reader.one(children, 'tfdt');
            let time = reader.version(decode)
                ? reader.wide(decode.start + 4, decode.end)
                : reader.uint(decode.start + 4, decode.end);

            for (const run of children.filter(box => box.type === 'trun')) {
                const version = reader.version(run);
                const runFlags = reader.uint(run.start, run.end) & 0xffffff;
                const count = reader.uint(run.start + 4, run.end);
                reader.remainingSamples -= count;
                if (reader.remainingSamples < 0)
                    overLimit(
                        'HLS playback: fMP4 timing inspection exceeds 1000000 samples per unit',
                    );

                cursor = run.start + 8;
                if (runFlags & 1) {
                    reader.uint(cursor, run.end);
                    cursor += 4;
                }

                const firstFlags = runFlags & 4 ? reader.uint(cursor, run.end) : defaultFlags;
                if (runFlags & 4) cursor += 4;

                let foundRandomAccess = false;
                for (let index = 0; index < count; index++) {
                    let duration = defaultDuration;
                    if (runFlags & 0x100) {
                        duration = reader.uint(cursor, run.end);
                        cursor += 4;
                    }
                    if (runFlags & 0x200) {
                        reader.uint(cursor, run.end);
                        cursor += 4;
                    }
                    const sampleFlags =
                        runFlags & 0x400
                            ? reader.uint(cursor, run.end)
                            : index
                              ? defaultFlags
                              : firstFlags;
                    if (runFlags & 0x400) cursor += 4;
                    let compositionOffset = 0;
                    if (runFlags & 0x800) {
                        compositionOffset = version
                            ? reader.signed(cursor, run.end)
                            : reader.uint(cursor, run.end);
                        cursor += 4;
                    }

                    const presentation = time + compositionOffset - track.editOffset;
                    if (
                        !duration ||
                        !Number.isSafeInteger(presentation + duration) ||
                        !Number.isSafeInteger(time + duration)
                    ) {
                        malformed(
                            'HLS playback: missing, zero, or unsafe fMP4 sample duration/timestamp',
                        );
                    }

                    start = Math.min(start, presentation / track.timescale);
                    end = Math.max(end, (presentation + duration) / track.timescale);
                    if (
                        track.video &&
                        !foundRandomAccess &&
                        !(sampleFlags & 0x10000) &&
                        ((sampleFlags >>> 24) & 3) !== 1
                    ) {
                        randomAccess.push(presentation / track.timescale);
                        foundRandomAccess = true;
                    }

                    time += duration;
                }
            }
        }
    }

    if (!Number.isFinite(start) || !Number.isFinite(end))
        malformed('HLS playback: fMP4 media unit has no timed samples');
    if (![...tracks.values()].some(track => track.video)) randomAccess.push(start);
    return { start, end, randomAccess };
}
