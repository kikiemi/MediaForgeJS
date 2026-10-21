import type { Sample, TrackInfo } from './track';
import type { Source } from './types';

/**
 * The samples of a track held compactly, such as in typed arrays, in place of an array of sample
 * objects: `get` builds the sample at a position, and the summary fields describe them all.
 */
export interface SampleIndex {
    readonly length: number;
    /** The memory the index holds, which maxIndexBytes limits. */
    readonly byteLength: number;
    readonly maxSampleSize: number;
    readonly allKeyframes: boolean;
    /** Whether presentation times never decrease. */
    readonly presentationSorted: boolean;
    /** Whether decode times never decrease. */
    readonly decodeSorted: boolean;
    readonly firstPresentation: number;
    readonly lastPresentationEnd: number;
    get(index: number): Sample;
    timestampAt(index: number): number;
    decodeTimeAt(index: number): number;
    isKeyframeAt(index: number): boolean;
}

/**
 * Reads samples whose bytes are not one contiguous source range (MPEG-TS elementary streams split
 * across transport packets). `sample.offset` and `sample.packetSkip` locate the bytes for the
 * reader; the result is owned by the caller.
 */
export interface PacketizedSampleReader {
    read(source: Source, sample: Sample, signal?: AbortSignal): Promise<Uint8Array>;
    /**
     * read() only scans the bytes it reads and returns bytes of its own, so a pass in file order
     * hands it views of its read-ahead spans, which it must not keep.
     */
    readonly scansReads?: boolean;
    /**
     * The sample's bytes, without a promise, when the borrow of `source` (cachedBorrower) lends
     * every byte they are gathered from; undefined otherwise, and read() reads them.
     */
    readLent?(source: Source, sample: Sample): Uint8Array | undefined;
}

const compactRequests = new WeakSet<object>();
const packetizedTracks = new WeakMap<TrackInfo, PacketizedSampleReader>();

/** Reads the samples of `track` that carry `packetSkip` through `reader`. */
export function bindPacketizedReader(track: TrackInfo, reader: PacketizedSampleReader): void {
    packetizedTracks.set(track, reader);
}

export function packetizedReaderOf(track: TrackInfo): PacketizedSampleReader | undefined {
    return packetizedTracks.get(track);
}

/**
 * The encoded bytes of one sample: its inline data, its packetized locator or its contiguous source
 * range.
 */
export function readSampleBytes(
    track: TrackInfo,
    sample: Sample,
    source: Source,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    if (sample.data) return Promise.resolve(sample.data);
    const reader = sample.packetSkip === undefined ? undefined : packetizedTracks.get(track);
    return reader ? reader.read(source, sample, signal) : source.read(sample.offset, sample.size);
}

/**
 * Marks a demuxer of the library (or its options) to describe long tracks by compact sample
 * indexes, as a read with ReadOptions.compactIndex does.
 */
export function enableCompactSampleIndex<T extends object>(target: T): T {
    compactRequests.add(target);
    return target;
}

/** Whether enableCompactSampleIndex() marked `target`. */
export function usesCompactSampleIndex(target: object): boolean {
    return compactRequests.has(target);
}

/**
 * The compact index of a track (bindCompactSampleIndex), kept on the track itself: it lives as
 * long as the track, without the side table every bind and every collection would pay for. The
 * samples property builds them from `index` (calling `reserve` first) while `listed` says whether
 * the index still describes them to the file's reads.
 */
const BOUND = Symbol('compact samples');

interface Bound {
    readonly index: SampleIndex;
    readonly reserve?: () => void;
    listed: boolean;
}

interface BoundTrack {
    [BOUND]?: Bound;
}

/** The binds of tracks that take no new property (Object.preventExtensions), and whether any. */
const heldBinds = new WeakMap<TrackInfo, Bound>();
let anyHeld = false;

function boundOf(track: TrackInfo): Bound | undefined {
    return (track as BoundTrack)[BOUND] ?? (anyHeld ? heldBinds.get(track) : undefined);
}

export function getCompactSampleIndex(track: TrackInfo): SampleIndex | undefined {
    const bound = boundOf(track);
    return bound?.listed ? bound.index : undefined;
}

/**
 * Drops the index and packet reader registered for a track whose samples were all read, as those of
 * one window of a stream are. V8 clears weakly keyed entries only in full collections; until then
 * an entry would keep the packet reader and the bytes it holds.
 */
export function releaseSampleIndex(track: TrackInfo): void {
    const bound = boundOf(track);
    if (bound) bound.listed = false;
    packetizedTracks.delete(track);
}

/** Gives `track` its samples as a data property, as the reader would have, and drops the index. */
function settleSamples(track: TrackInfo, samples: Sample[]): void {
    Object.defineProperty(track, 'samples', {
        value: samples,
        enumerable: true,
        configurable: true,
        writable: true,
    });
    if (Object.hasOwn(track, BOUND)) (track as BoundTrack)[BOUND] = undefined;
    else heldBinds.delete(track);
}

/**
 * The samples property of every track a compact index describes: one pair of functions, so tracks
 * that add it as a new property keep shared shapes, and the index is kept on the track.
 */
const COMPACT_SAMPLES: PropertyDescriptor = {
    enumerable: true,
    configurable: true,
    get(this: TrackInfo): Sample[] {
        const { index, reserve } = boundOf(this)!;
        reserve?.();
        const samples = Array.from({ length: index.length }, (_, position) => index.get(position));
        settleSamples(this, samples);
        return samples;
    },
    set(this: TrackInfo, samples: Sample[]): void {
        settleSamples(this, samples);
    },
};

/**
 * Describes the samples of `track` by `index` instead of `track.samples`, for a reader that hands
 * its results over. Reading `track.samples` builds the array from the index (`reserve` is called
 * first) and drops the index.
 */
export function bindCompactSampleIndex(
    track: TrackInfo,
    index: SampleIndex,
    reserve?: () => void,
): void {
    const bound: Bound = { index, reserve, listed: true };
    if (Object.isExtensible(track) || Object.hasOwn(track, BOUND))
        Object.defineProperty(track, BOUND, { value: bound, writable: true, configurable: true });
    else {
        heldBinds.set(track, bound);
        anyHeld = true;
    }
    Object.defineProperty(track, 'samples', COMPACT_SAMPLES);
}

/**
 * A view of `index` without its first `skip` samples; the table summary is taken again over the
 * rest.
 */
export function skipLeadingSamples(index: SampleIndex, skip: number): SampleIndex {
    let firstPresentation = Number.POSITIVE_INFINITY;
    let allKeyframes = true;
    let presentationSorted = true;
    let decodeSorted = true;
    for (let position = skip; position < index.length; position++) {
        const presentation = index.timestampAt(position);
        firstPresentation = Math.min(firstPresentation, presentation);
        if (!index.isKeyframeAt(position)) allKeyframes = false;
        if (position > skip) {
            if (presentation < index.timestampAt(position - 1)) presentationSorted = false;
            if (index.decodeTimeAt(position) < index.decodeTimeAt(position - 1))
                decodeSorted = false;
        }
    }

    return {
        length: Math.max(0, index.length - skip),
        byteLength: index.byteLength,
        maxSampleSize: index.maxSampleSize,
        allKeyframes,
        presentationSorted,
        decodeSorted,
        firstPresentation,
        lastPresentationEnd: index.lastPresentationEnd,
        get: position => index.get(position + skip),
        timestampAt: position => index.timestampAt(position + skip),
        decodeTimeAt: position => index.decodeTimeAt(position + skip),
        isKeyframeAt: position => index.isKeyframeAt(position + skip),
    };
}

export function sampleCount(track: TrackInfo): number {
    return getCompactSampleIndex(track)?.length ?? track.samples.length;
}

export function sampleAt(track: TrackInfo, position: number): Sample | undefined {
    const index = getCompactSampleIndex(track);
    return index
        ? Number.isInteger(position) && position >= 0 && position < index.length
            ? index.get(position)
            : undefined
        : track.samples[position];
}

/**
 * The summary of a sample table built in typed arrays, taken once the table is complete, and the
 * growth of its columns.
 */
export abstract class SummarizedSampleIndex {
    length = 0;
    maxSampleSize = 0;
    allKeyframes = true;
    presentationSorted = true;
    decodeSorted = true;
    firstPresentation = Number.POSITIVE_INFINITY;
    lastPresentationEnd = Number.NEGATIVE_INFINITY;

    abstract timestampAt(index: number): number;
    abstract decodeTimeAt(index: number): number;
    abstract isKeyframeAt(index: number): boolean;

    /** Takes the summary from the samples' times, keyframes, `sizes` and `durationAt`. */
    protected summarize(sizes: ArrayLike<number>, durationAt: (index: number) => number): void {
        let previousDecode = Number.NEGATIVE_INFINITY;
        let previousPresentation = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < this.length; index++) {
            const decode = this.decodeTimeAt(index);
            const presentation = this.timestampAt(index);
            if (decode < previousDecode) this.decodeSorted = false;
            if (presentation < previousPresentation) this.presentationSorted = false;
            if (!this.isKeyframeAt(index)) this.allKeyframes = false;
            this.maxSampleSize = Math.max(this.maxSampleSize, sizes[index]!);
            this.firstPresentation = Math.min(this.firstPresentation, presentation);
            this.lastPresentationEnd = Math.max(
                this.lastPresentationEnd,
                presentation + durationAt(index),
            );
            previousDecode = decode;
            previousPresentation = presentation;
        }
    }

    /** `column` resized to `capacity` entries, keeping those of the samples it holds. */
    protected resized<T extends Float64Array | Uint32Array | Uint16Array | Uint8Array>(
        column: T,
        capacity: number,
    ): T {
        const to = new (column.constructor as new (length: number) => T)(capacity);
        to.set(column.subarray(0, Math.min(this.length, capacity)) as never);
        return to;
    }
}

/**
 * Growable sample table in typed arrays for samples found while walking a file (MP4 fragments): 37
 * bytes per sample. Times are integer ticks of one timescale plus a fixed shift in seconds, and
 * `get` returns the values the object form holds: timestamp (dts + cto) / timescale + shift,
 * decodeTimestamp dts / timescale + shift.
 */
export class PackedSampleIndex extends SummarizedSampleIndex implements SampleIndex {
    static readonly BYTES_PER_SAMPLE = 37;
    private offsets = new Float64Array(256);
    private sizes = new Uint32Array(256);
    private decodeTicks = new Float64Array(256);
    private compositionTicks = new Float64Array(256);
    private durations = new Float64Array(256);
    /** Bit 0 keyframe, bit 1 leading discard. */
    private flags = new Uint8Array(256);

    constructor(
        private readonly timescale: number,
        private readonly shift: number,
    ) {
        super();
    }

    get byteLength(): number {
        return this.length * PackedSampleIndex.BYTES_PER_SAMPLE;
    }

    /** Appends one sample; times are ticks of the table's timescale. */
    push(
        offset: number,
        size: number,
        decodeTicks: number,
        compositionTicks: number,
        durationTicks: number,
        keyframe: boolean,
        leadingDiscard: boolean,
    ): void {
        const index = this.length;
        if (index === this.offsets.length) this.grow(index * 2);
        this.offsets[index] = offset;
        this.sizes[index] = size;
        this.decodeTicks[index] = decodeTicks;
        this.compositionTicks[index] = compositionTicks;
        this.durations[index] = durationTicks / this.timescale;
        this.flags[index] = (keyframe ? 1 : 0) | (leadingDiscard ? 2 : 0);
        this.length++;
    }

    /**
     * Drops the trailing samples that decode at or after `decodeTicks`; returns how many were
     * dropped.
     */
    dropFrom(decodeTicks: number): number {
        const before = this.length;
        while (this.length > 0 && this.decodeTicks[this.length - 1]! >= decodeTicks) this.length--;
        return before - this.length;
    }

    /**
     * Fills zero durations from the next decode time (or the previous duration) and computes the
     * table summary.
     */
    finish(): void {
        const count = this.length;
        for (let index = 0; index < count; index++) {
            if (this.durations[index]! > 0) continue;
            if (index + 1 < count) {
                const step = this.decodeTimeAt(index + 1) - this.decodeTimeAt(index);
                if (step > 0) {
                    this.durations[index] = step;
                    continue;
                }
            }
            const previous = index > 0 ? this.durations[index - 1]! : 0;
            this.durations[index] = previous > 0 ? previous : 1 / 1000;
        }
        this.summarize(this.sizes, index => this.durations[index]!);
        this.grow(count);
    }

    get(index: number): Sample {
        const composition = this.compositionTicks[index]!;
        const sample: Sample = {
            offset: this.offsets[index]!,
            size: this.sizes[index]!,
            timestamp: this.timestampAt(index),
            decodeTimestamp: this.decodeTimeAt(index),
            compositionTimeOffset: composition / this.timescale,
            duration: this.durations[index]!,
            isKeyframe: (this.flags[index]! & 1) !== 0,
        };
        if (this.flags[index]! & 2) sample.leadingDiscard = true;
        return sample;
    }

    timestampAt(index: number): number {
        return (
            (this.decodeTicks[index]! + this.compositionTicks[index]!) / this.timescale + this.shift
        );
    }

    decodeTimeAt(index: number): number {
        return this.decodeTicks[index]! / this.timescale + this.shift;
    }

    isKeyframeAt(index: number): boolean {
        return (this.flags[index]! & 1) !== 0;
    }

    private grow(capacity: number): void {
        this.offsets = this.resized(this.offsets, capacity);
        this.sizes = this.resized(this.sizes, capacity);
        this.decodeTicks = this.resized(this.decodeTicks, capacity);
        this.compositionTicks = this.resized(this.compositionTicks, capacity);
        this.durations = this.resized(this.durations, capacity);
        this.flags = this.resized(this.flags, capacity);
    }
}
