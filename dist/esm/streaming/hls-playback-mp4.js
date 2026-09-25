import { MediaForgeError } from '../core/errors.js';
function invalid(message) {
    throw new MediaForgeError(`HLS playback: ${message}`, 'FORMAT');
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get;
const buffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const tag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag).get;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
export function hlsPlaybackBytes(value) {
    try {
        if (tag.call(value) !== 'Uint8Array')
            invalid('media data must be Uint8Array bytes');
        const backing = buffer.call(value);
        arrayLength.call(backing);
        return new Uint8Array(backing, byteOffset.call(value), byteLength.call(value));
    }
    catch {
        return invalid('media data must be attached, non-shared Uint8Array bytes');
    }
}
class Mp4TimingReader {
    view;
    remainingBoxes = 10000;
    remainingSamples = 1000000;
    constructor(bytes) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    uint(offset, end) {
        if (offset < 0 || offset + 4 > end)
            invalid('truncated fMP4 timing field');
        return this.view.getUint32(offset);
    }
    wide(offset, end) {
        const value = this.uint(offset, end) * 0x100000000 + this.uint(offset + 4, end);
        if (!Number.isSafeInteger(value))
            invalid('fMP4 timestamp or size exceeds the safe integer range');
        return value;
    }
    signed(offset, end) {
        this.uint(offset, end);
        return this.view.getInt32(offset);
    }
    boxes(start = 0, end = this.view.byteLength) {
        const boxes = [];
        while (start < end) {
            if (--this.remainingBoxes < 0)
                invalid('fMP4 timing inspection exceeds 10000 boxes per unit');
            const size32 = this.uint(start, end);
            this.uint(start + 4, end);
            const type = String.fromCharCode(...[0, 1, 2, 3].map(index => this.view.getUint8(start + 4 + index)));
            const header = size32 === 1 ? 16 : 8;
            const size = size32 === 1 ? this.wide(start + 8, end) : size32 || end - start;
            if (size < header || size > end - start)
                invalid('invalid or truncated fMP4 box; MPEG-TS playback is unsupported');
            boxes.push({ type, start: start + header, end: start + size });
            start += size;
        }
        return boxes;
    }
    children(parent) {
        return this.boxes(parent.start, parent.end);
    }
    one(boxes, type) {
        const matches = boxes.filter(box => box.type === type);
        if (matches.length !== 1)
            invalid(`fMP4 requires exactly one ${type} box`);
        return matches[0];
    }
    version(box) {
        const version = this.uint(box.start, box.end) >>> 24;
        if (version > 1)
            invalid(`unsupported ${box.type} version`);
        return version;
    }
}
export function hlsPlaybackTracks(bytes) {
    const reader = new Mp4TimingReader(bytes);
    const top = reader.boxes();
    reader.one(top, 'ftyp');
    const movie = reader.children(reader.one(top, 'moov'));
    const defaults = reader.children(reader.one(movie, 'mvex'));
    const tracks = new Map();
    const kinds = new Set();
    for (const track of movie.filter(box => box.type === 'trak')) {
        const children = reader.children(track);
        const header = reader.one(children, 'tkhd');
        const id = reader.uint(header.start + (reader.version(header) === 1 ? 20 : 12), header.end);
        const media = reader.children(reader.one(children, 'mdia'));
        const mediaHeader = reader.one(media, 'mdhd');
        const timescale = reader.uint(mediaHeader.start + (reader.version(mediaHeader) === 1 ? 20 : 12), mediaHeader.end);
        const handler = reader.one(media, 'hdlr');
        const kind = reader.uint(handler.start + 8, handler.end);
        if ((kind !== 0x76696465 && kind !== 0x736f756e) || kinds.has(kind)) {
            invalid('fMP4 playback requires at most one video and one audio track');
        }
        kinds.add(kind);
        if (!id || tracks.has(id) || !timescale)
            invalid('invalid fMP4 track identifier or timescale');
        const edits = children.filter(box => box.type === 'edts');
        if (edits.length > 1)
            invalid('multiple fMP4 edit boxes are unsupported');
        if (edits[0]) {
            const edit = reader.one(reader.children(edits[0]), 'elst');
            const version = reader.version(edit);
            const mediaTime = version ? reader.wide(edit.start + 16, edit.end) : reader.uint(edit.start + 12, edit.end);
            if (reader.uint(edit.start + 4, edit.end) !== 1 ||
                mediaTime !== 0 ||
                reader.uint(edit.start + (version ? 24 : 16), edit.end) !== 0x10000) {
                invalid('fMP4 edit lists require a single zero-offset, rate-one edit');
            }
        }
        const trex = defaults.filter(box => box.type === 'trex' && reader.uint(box.start + 4, box.end) === id);
        if (trex.length !== 1)
            invalid('missing or duplicate fMP4 track defaults');
        tracks.set(id, {
            timescale,
            defaultDuration: reader.uint(trex[0].start + 12, trex[0].end),
            defaultFlags: reader.uint(trex[0].start + 20, trex[0].end),
            video: kind === 0x76696465,
        });
    }
    if (!tracks.size)
        invalid('fMP4 initialization has no audio or video tracks');
    return tracks;
}
export function hlsPlaybackTiming(bytes, tracks) {
    const reader = new Mp4TimingReader(bytes);
    const top = reader.boxes();
    if (!top.some(box => box.type === 'moof') || !top.some(box => box.type === 'mdat')) {
        invalid('media units must contain complete fMP4 moof/mdat fragments; MPEG-TS playback is unsupported');
    }
    let start = Infinity;
    let end = -Infinity;
    const randomAccess = [];
    for (const movie of top.filter(box => box.type === 'moof')) {
        const fragments = reader.children(movie).filter(box => box.type === 'traf');
        if (!fragments.length)
            invalid('fMP4 fragment has no tracks');
        for (const fragment of fragments) {
            const children = reader.children(fragment);
            const header = reader.one(children, 'tfhd');
            const flags = reader.uint(header.start, header.end) & 0xffffff;
            const track = tracks.get(reader.uint(header.start + 4, header.end));
            if (!track)
                invalid('fMP4 fragment references an uninitialized track');
            if (flags & 1)
                invalid('fMP4 playback requires movie-fragment-relative addressing');
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
                    invalid('fMP4 timing inspection exceeds 1000000 samples per unit');
                cursor = run.start + 8;
                if (runFlags & 1) {
                    reader.uint(cursor, run.end);
                    cursor += 4;
                }
                const firstFlags = runFlags & 4 ? reader.uint(cursor, run.end) : defaultFlags;
                if (runFlags & 4)
                    cursor += 4;
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
                    const sampleFlags = runFlags & 0x400 ? reader.uint(cursor, run.end) : index ? defaultFlags : firstFlags;
                    if (runFlags & 0x400)
                        cursor += 4;
                    let compositionOffset = 0;
                    if (runFlags & 0x800) {
                        compositionOffset = version ? reader.signed(cursor, run.end) : reader.uint(cursor, run.end);
                        cursor += 4;
                    }
                    const presentation = time + compositionOffset;
                    if (!duration ||
                        !Number.isSafeInteger(presentation + duration) ||
                        !Number.isSafeInteger(time + duration)) {
                        invalid('missing, zero, or unsafe fMP4 sample duration/timestamp');
                    }
                    start = Math.min(start, presentation / track.timescale);
                    end = Math.max(end, (presentation + duration) / track.timescale);
                    if (track.video &&
                        !foundRandomAccess &&
                        !(sampleFlags & 0x10000) &&
                        ((sampleFlags >>> 24) & 3) !== 1) {
                        randomAccess.push(presentation / track.timescale);
                        foundRandomAccess = true;
                    }
                    time += duration;
                }
            }
        }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end))
        invalid('fMP4 media unit has no timed samples');
    if (![...tracks.values()].some(track => track.video))
        randomAccess.push(start);
    return { start, end, randomAccess };
}
