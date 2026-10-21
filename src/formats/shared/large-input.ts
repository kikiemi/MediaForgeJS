import type { Source } from '../../core/model/types';
import type { DemuxResult, TrackInfo } from '../../core/model/track';
import { getCompactSampleIndex, sampleAt, type SampleIndex } from '../../core/model/sample-index';
import { DemuxError } from '../../core/errors/errors';
import { ConcatSource } from '../../core/io/sources/concat-source';
import { ChunkReader, CHUNK_BYTES, type ByteReader } from '../../core/io/sources/chunk-reader';
import { demuxAssert } from '../../core/errors/demux-guard';
import { uncachedReads, uncachedSource, uncachedViews } from '../../core/io/sources/cached-source';
import { registerViewReads } from '../../core/io/sources/source-read';
import { SourceRope } from '../../core/io/sources/source-rope';
import { BufferPool, ByteArena } from '../../core/bytes/buffer-pool';
import { releaseBytes } from '../../core/bytes/byte-holds';
import { readerInto, type ReadInto } from '../../core/bytes/read-into';
import { RangeSource, UnchangingBytesSource } from '../../core/io/sources/sources';

/**
 * What a probe, or a window it reads, gives when its read fails: undefined for a DemuxError (the
 * input is damaged or laid out otherwise there, so another window or a full read follows); any
 * other error propagates.
 */
export function probeMiss(error: unknown): undefined {
    if (!(error instanceof DemuxError)) throw error;
    return undefined;
}

/** The video, audio and subtitle tracks of a result. */
export function tracksOf(result: DemuxResult): TrackInfo[] {
    return [...result.videoTracks, ...result.audioTracks, ...(result.subtitleTracks ?? [])];
}

/**
 * Views of the bytes of `input` where it is, or is a range of, a source that reads views of bytes
 * it never changes past its cache (a Blob's); undefined where it reads none. Chunks a window or a
 * stream only reads are taken so, not copied.
 */
function inputViews(
    input: Source,
): ((offset: number, length: number) => Promise<Uint8Array>) | undefined {
    const range = SourceRope.treeOf(input, input.read, input.size);
    if (!range) return uncachedViews(input);
    const views = 'source' in range && uncachedViews(range.source);
    return views ? (offset, length) => views(range.offset + offset, length) : undefined;
}

/**
 * The bytes of a window of `input` from `from` on, for a demux that reads the structures at the
 * start of the input (`head`: Matroska's elements before its first cluster, MPEG-TS program tables)
 * and then passes over everything before `from`: those from `head`, which a read that runs past its
 * end stops at, the others in chunks counted from `from`. Nothing between them is read.
 */
export class WindowBytes implements ByteReader {
    readonly size: number;
    private readonly window: ChunkReader;

    constructor(
        private readonly head: ByteReader,
        input: Source,
        readonly from: number,
    ) {
        this.size = input.size;
        const window = new RangeSource(input, from, input.size - from);
        const views = inputViews(input);
        if (views) registerViewReads(window, (offset, length) => views(from + offset, length));
        this.window = new ChunkReader(window, CHUNK_BYTES, true);
    }

    bytes(pos: number, len: number): Promise<Uint8Array> {
        if (pos >= this.from) return this.window.bytes(pos - this.from, len);
        demuxAssert(pos < this.head.size, 'A window read the input before its start');
        return this.head.bytes(pos, Math.min(len, this.head.size - pos));
    }
}

/** A place in an input (a cluster, a fragment) and the time its first sample is shown at. */
export interface TimedPlace {
    readonly position: number;
    readonly time: number;
}

/**
 * The places of an index (Cues, a walk of the clusters, tfra) listed in file order, searched
 * without a copy of the list: by halves where their positions and times rise together, as an
 * index's do, else one by one.
 */
export class PlaceSearch {
    private readonly rising: boolean;
    readonly length: number;

    constructor(private readonly places: readonly TimedPlace[]) {
        this.length = places.length;
        this.rising = places.every(
            (place, index) =>
                !index ||
                (place.position >= places[index - 1]!.position &&
                    place.time >= places[index - 1]!.time),
        );
    }

    /** The last place in the list shown at or before `time`. */
    lastAtOrBefore(time: number): TimedPlace | undefined {
        const { places } = this;
        if (this.rising) return places[this.firstPast(place => place.time, time) - 1];
        for (let index = places.length - 1; index >= 0; index--)
            if (places[index]!.time <= time) return places[index];
        return undefined;
    }

    /** The first place in the list past `position` and shown after `time`. */
    firstAfter(position: number, time: number): TimedPlace | undefined {
        const { places } = this;
        if (this.rising)
            return places[
                Math.max(
                    this.firstPast(place => place.position, position),
                    this.firstPast(place => place.time, time),
                )
            ];
        for (const place of places)
            if (place.position > position && place.time > time) return place;
        return undefined;
    }

    /** The first index whose `key` is past `value`, the keys rising. */
    private firstPast(key: (place: TimedPlace) => number, value: number): number {
        let low = 0;
        let high = this.places.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (key(this.places[middle]!) > value) high = middle;
            else low = middle + 1;
        }
        return low;
    }
}

/**
 * The times and keyframe flags of the samples of `track`, read from its compact index without a
 * sample object each, or from its samples.
 */
function timesOf(
    track: TrackInfo,
): Pick<SampleIndex, 'length' | 'timestampAt' | 'decodeTimeAt' | 'isKeyframeAt'> {
    const index = getCompactSampleIndex(track);
    if (index) return index;
    const samples = track.samples;
    return {
        length: samples.length,
        timestampAt: position => samples[position]!.timestamp,
        decodeTimeAt: position =>
            samples[position]!.decodeTimestamp ?? samples[position]!.timestamp,
        isKeyframeAt: position => samples[position]!.isKeyframe,
    };
}

/**
 * Whether the samples of a probe's window decode `span` (seconds): a keyframe at or before its
 * start, unless `opensSpan` (the window starts the input before the span), and a sample shown a
 * second after its end, unless `endsInput`: the samples stored after the window's last one are
 * shown after the span where every picture of the window is shown less than a second after its
 * decode time, as the window requires.
 */
export function windowCovers(
    track: TrackInfo,
    span: { readonly start: number; readonly end: number },
    opensSpan: boolean,
    endsInput: boolean,
): boolean {
    let keyframe = opensSpan;
    let after = endsInput;
    const times = timesOf(track);
    for (let index = 0; index < times.length; index++) {
        const timestamp = times.timestampAt(index);
        if (timestamp - times.decodeTimeAt(index) >= 1) return false;
        if (timestamp <= span.start && times.isKeyframeAt(index)) keyframe = true;
        if (timestamp > span.end + 1) after = true;
    }
    return keyframe && after;
}

/**
 * How windows of a probed input hold the samples of `span` (seconds) of its first track, as the
 * head tells: whether a window's track, read from the input's start (`first`) or to its end
 * (`last`), holds them, and whether the head does; undefined when the span cannot be placed.
 */
export function spanWindows(
    head: DemuxResult,
    span: { readonly start: number; readonly end: number },
):
    | { covers: (track: TrackInfo, first: boolean, last: boolean) => boolean; inHead: boolean }
    | undefined {
    const leading = head.videoTracks[0] ?? head.audioTracks[0];
    if (!leading || !Number.isFinite(span.start) || Number.isNaN(span.end)) return undefined;
    const firstSample = sampleAt(leading, 0)?.timestamp ?? Infinity;
    const covers = (track: TrackInfo, first: boolean, last: boolean): boolean =>
        windowCovers(track, span, first && span.start <= firstSample, last);
    return {
        covers,
        inHead:
            (span.start === span.end && span.start <= firstSample) || covers(leading, true, false),
    };
}

/**
 * Whether every audio track of a window has a sample before the keyframe a copy from `start`
 * (seconds) starts `leading` at, its last at or before `start`.
 */
export function holdsAudioBefore(result: DemuxResult, leading: TrackInfo, start: number): boolean {
    let keyframe = -Infinity;
    const times = timesOf(leading);
    for (let index = 0; index < times.length; index++) {
        const timestamp = times.timestampAt(index);
        if (timestamp <= start && times.isKeyframeAt(index))
            keyframe = Math.max(keyframe, timestamp);
    }
    return result.audioTracks.every(
        track => track === leading || (sampleAt(track, 0)?.timestamp ?? Infinity) < keyframe,
    );
}

/**
 * Bytes of input a stream demuxes at a time, and the most a window grows to while no sample
 * completes in it. A window and the chunk read ahead of it are the input a stream holds at once,
 * whatever the length of the input.
 */
export const WINDOW_BYTES = CHUNK_BYTES;
export const MAX_WINDOW_BYTES = 256 * CHUNK_BYTES;

/**
 * An input read forward once, in chunks aligned to the demuxers' read chunk, for demuxing it in
 * windows. A window is the input's leading bytes (the headers a demux reads first) and the chunks
 * from its start to its end; each chunk is read once and held while a window still covers it, and
 * the chunks of the next window are read while one is demuxed. A demuxer's chunk read of a window
 * is a view of one held chunk, never a copy.
 *
 * Where the input reads into the caller's bytes, the chunks are pooled buffers refilled for later
 * windows: the bytes of a window, and the samples that view them, are valid until the next window
 * is asked for or the windows close, unless a hold is taken on them (holdBytes).
 */
export class ForwardWindows {
    /**
     * Chunks read or being read, by index; the leading ones stay, the others go once a window
     * starts past them.
     */
    private readonly chunks = new Map<number, Promise<Uint8Array>>();
    /** The bytes of the chunks read so far, by index, for views without waiting. */
    private readonly held = new Map<number, Uint8Array>();
    private readonly leadingChunks: number;
    /**
     * Reads past the input's page cache: each chunk is read once, and its pages would only evict
     * others. Into pooled buffers where the input reads into the caller's bytes, else as views
     * where it reads views of bytes it never changes (a Blob's), else as copies.
     */
    private readonly read: Source['read'];
    private readonly readInto?: ReadInto;
    private readonly pool = new BufferPool(CHUNK_BYTES);
    /**
     * Bytes a window's demux assembles (samples gathered from several places), released with the
     * window.
     */
    readonly arena = new ByteArena(this.pool);

    /**
     * Every window holds the input's first `leading` bytes; `ahead` bytes past a window are read
     * while it is demuxed.
     */
    constructor(
        private readonly source: Source,
        leading: number,
        private readonly ahead: number,
    ) {
        this.read = inputViews(source) ?? uncachedReads(source);
        this.readInto = readerInto(uncachedSource(source));
        this.leadingChunks = Math.ceil(Math.min(leading, source.size) / CHUNK_BYTES);
    }

    /** The held bytes of `length` at `offset` as a view, when one chunk holds all of them. */
    view(offset: number, length: number): Uint8Array | undefined {
        const index = Math.floor(offset / CHUNK_BYTES);
        const chunk = this.held.get(index);
        const at = offset - index * CHUNK_BYTES;
        return chunk && at + length <= chunk.length ? chunk.subarray(at, at + length) : undefined;
    }

    /**
     * The input up to `end` for demuxing from `from`, with `size` bytes; bytes past `end` are read
     * through.
     */
    async window(from: number, end: number, size = end): Promise<Source> {
        const first = Math.floor(from / CHUNK_BYTES);
        const last = Math.ceil(end / CHUNK_BYTES) - 1;

        this.arena.reset();
        for (const index of this.chunks.keys())
            if (index < first && index >= this.leadingChunks) this.drop(index);
        for (let index = 0; index < this.leadingChunks; index++) this.chunk(index);
        const lastAhead = Math.min(
            Math.ceil(this.source.size / CHUNK_BYTES),
            Math.ceil((end + this.ahead) / CHUNK_BYTES),
        );
        for (let index = first; index < lastAhead; index++) this.chunk(index);

        const parts: Source[] = [];
        const leading = Math.min(this.leadingChunks, first);
        for (let index = 0; index < leading; index++)
            parts.push(new UnchangingBytesSource(await this.chunk(index)));
        if (first > leading)
            parts.push(
                new RangeSource(
                    this.source,
                    leading * CHUNK_BYTES,
                    (first - leading) * CHUNK_BYTES,
                ),
            );
        for (let index = first; index <= last; index++) {
            const chunk = await this.chunk(index);
            parts.push(
                new UnchangingBytesSource(
                    chunk.subarray(0, Math.min(chunk.length, end - index * CHUNK_BYTES)),
                ),
            );
        }

        if (size > end) parts.push(new RangeSource(this.source, end, size - end));
        return new ConcatSource(parts);
    }

    /** Releases every chunk: the windows are done. */
    close(): void {
        this.arena.reset();
        for (const index of [...this.chunks.keys()]) this.drop(index);
    }

    private drop(index: number): void {
        const read = this.chunks.get(index)!;
        this.chunks.delete(index);
        this.held.delete(index);
        if (this.readInto) read.then(releaseBytes, () => undefined);
    }

    private chunk(index: number): Promise<Uint8Array> {
        let read = this.chunks.get(index);
        if (!read) {
            const start = index * CHUNK_BYTES;
            const length = Math.min(CHUNK_BYTES, this.source.size - start);
            const into = this.readInto;
            if (into) {
                const bytes = this.pool.acquire().subarray(0, length);
                read = into(start, bytes).then(
                    () => bytes,
                    error => {
                        releaseBytes(bytes);
                        throw error;
                    },
                );
            } else read = this.read(start, length);
            const reading = read.then(bytes => {
                if (this.chunks.get(index) === reading) this.held.set(index, bytes);
                return bytes;
            });

            // A chunk read ahead and never asked for must not report its failure as unhandled.
            reading.catch(() => undefined);
            this.chunks.set(index, reading);
            return reading;
        }
        return read;
    }
}
