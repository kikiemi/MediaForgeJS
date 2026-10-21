import type { Sample } from '../../../core/model/track';
import type { SampleIndex } from '../../../core/model/sample-index';
import { DurationFiller, ReorderClock, type ReorderTiming } from './reorder';
import { decodeTime } from '../../../core/model/media-time';

const KEYFRAME = 1;
const PRORES_HEADERLESS = 2;

/**
 * Explicit H.264 framing of V_MS/VFW/FOURCC frames: Annex B start codes or four-byte NAL lengths.
 */
const ANNEX_B = 4;
const NAL_LENGTHS = 8;

/**
 * Frames a column holds at first: a window of a stream holds a few dozen; larger indexes double
 * from here.
 */
const INITIAL_CAPACITY = 64;

type Numbers = Uint32Array | Float64Array;

type Column = Uint8Array | Uint32Array | Float64Array;

function numbersOf(wide: boolean, length: number): Numbers {
    return wide ? new Float64Array(length) : new Uint32Array(length);
}

function grown<T extends Column>(column: T, capacity: number): T {
    const next = new (column.constructor as new (length: number) => T)(capacity);
    next.set(column);
    return next;
}

/**
 * Copies a column only when trimming would free more than an eighth of it; the length bounds every
 * read.
 */
function trimmed<T extends Column>(column: T, length: number): T {
    return column.length - length <= length >> 3 ? column : (column.slice(0, length) as T);
}

/** Byte offsets, sizes, seconds and flags per frame; `get` builds one owned object per call. */
class MatroskaSampleIndex implements SampleIndex {
    constructor(
        readonly length: number,
        readonly byteLength: number,
        /** Largest coded frame plus its alpha side data, in bytes. */
        readonly maxSampleSize: number,
        readonly allKeyframes: boolean,
        readonly presentationSorted: boolean,
        readonly decodeSorted: boolean,
        readonly firstPresentation: number,
        readonly lastPresentationEnd: number,
        private readonly offsets: Numbers,
        private readonly sizes: Numbers,
        private readonly timestamps: Float64Array,
        private readonly durations: Float64Array,
        private readonly flags: Uint8Array,
        private readonly alphaOffsets: Numbers | undefined,
        private readonly alphaSizes: Numbers | undefined,
        private readonly decodeTimes: Float64Array | undefined,
        private readonly compositionOffsets: Float64Array | undefined,
        private readonly data: readonly Uint8Array[] | undefined,
        private readonly discards: ReadonlyMap<number, number> | undefined,
    ) {}

    timestampAt(index: number): number {
        return this.timestamps[index]!;
    }

    decodeTimeAt(index: number): number {
        return this.decodeTimes ? this.decodeTimes[index]! : this.timestamps[index]!;
    }

    durationAt(index: number): number {
        return this.durations[index]!;
    }

    isKeyframeAt(index: number): boolean {
        return (this.flags[index]! & KEYFRAME) !== 0;
    }

    get(index: number): Sample {
        const flags = this.flags[index]!;
        const timestamp = this.timestamps[index]!;
        const sample: Sample = {
            offset: this.offsets[index]!,
            size: this.sizes[index]!,
            timestamp,
            decodeTimestamp: this.decodeTimes ? this.decodeTimes[index]! : timestamp,
            compositionTimeOffset: this.compositionOffsets ? this.compositionOffsets[index]! : 0,
            duration: this.durations[index]!,
            isKeyframe: (flags & KEYFRAME) !== 0,
        };

        if (flags & PRORES_HEADERLESS) sample.proResHeaderless = true;
        if (flags & ANNEX_B) sample.nalUnitFormat = 'annexb';
        else if (flags & NAL_LENGTHS) sample.nalUnitFormat = 'avcc';
        const data = this.data?.[index];
        if (data) sample.data = data;
        const discard = this.discards?.get(index);
        if (discard) sample.trailingDiscard = discard;
        if (this.alphaSizes && this.alphaSizes[index]! > 0) {
            sample.alphaOffset = this.alphaOffsets![index]!;
            sample.alphaSize = this.alphaSizes[index]!;
        }

        return sample;
    }
}

/**
 * Growable per-track columns filled during cluster parsing. Capacity doubles when full
 * and `reserve` is charged for the added capacity before each allocation; `finish`
 * trims the columns to the appended length.
 */
export class MatroskaSampleIndexBuilder {
    length = 0;
    private capacity = 0;
    private offsets: Numbers;
    private sizes: Numbers;
    private timestamps = new Float64Array(0);
    private durations = new Float64Array(0);
    private flags = new Uint8Array(0);
    private alphaOffsets?: Numbers;
    private alphaSizes?: Numbers;
    private decodeTimes?: Float64Array;
    private compositionOffsets?: Float64Array;
    private data?: Uint8Array[];
    private discards?: Map<number, number>;

    constructor(
        private readonly wide: boolean,
        private readonly reserve: (bytes: number) => void,
    ) {
        this.offsets = numbersOf(wide, 0);
        this.sizes = numbersOf(wide, 0);
    }

    private get numberWidth(): number {
        return this.wide ? 8 : 4;
    }

    private grow(): void {
        const capacity = this.capacity === 0 ? INITIAL_CAPACITY : this.capacity * 2;
        const added = capacity - this.capacity;
        const alphaWidth = this.alphaSizes ? this.numberWidth * 2 : 0;
        this.reserve(added * (this.numberWidth * 2 + 17 + alphaWidth));
        this.offsets = grown(this.offsets, capacity);
        this.sizes = grown(this.sizes, capacity);
        this.timestamps = grown(this.timestamps, capacity);
        this.durations = grown(this.durations, capacity);
        this.flags = grown(this.flags, capacity);
        if (this.alphaOffsets) this.alphaOffsets = grown(this.alphaOffsets, capacity);
        if (this.alphaSizes) this.alphaSizes = grown(this.alphaSizes, capacity);
        this.capacity = capacity;
    }

    /** The latest presentation time appended so far. */
    latestTimestamp = Number.NEGATIVE_INFINITY;

    append(
        offset: number,
        size: number,
        timestamp: number,
        duration: number,
        keyframe: boolean,
        proResHeaderless: boolean,
        alphaOffset: number,
        alphaSize: number,
        /**
         * The frame's bytes when they differ from its stored range, such as a restored stripped
         * header.
         */
        data?: Uint8Array,
    ): void {
        if (this.length === this.capacity) this.grow();
        if (alphaSize > 0 && !this.alphaSizes) {
            this.reserve(this.capacity * this.numberWidth * 2);
            this.alphaOffsets = numbersOf(this.wide, this.capacity);
            this.alphaSizes = numbersOf(this.wide, this.capacity);
        }

        const at = this.length++;
        this.latestTimestamp = Math.max(this.latestTimestamp, timestamp);
        this.offsets[at] = offset;
        this.sizes[at] = size;
        this.timestamps[at] = timestamp;
        this.durations[at] = duration;
        this.flags[at] = (keyframe ? KEYFRAME : 0) | (proResHeaderless ? PRORES_HEADERLESS : 0);
        if (this.alphaSizes) {
            this.alphaOffsets![at] = alphaOffset;
            this.alphaSizes[at] = alphaSize;
        }

        if (data) {
            this.reserve(data.length + 16);
            (this.data ??= [])[at] = data;
        }
    }

    /** Frame `index` presents all but its last `samples` decoded samples. */
    discard(index: number, samples: number): void {
        this.reserve(32);
        (this.discards ??= new Map()).set(index, samples);
    }

    /** The presentation time of frame `index`. */
    timestampAt(index: number): number {
        return this.timestamps[index]!;
    }

    /** Frames appended so far, with their stored range, timing and restored bytes. */
    sampleAt(index: number): Sample {
        const sample: Sample = {
            offset: this.offsets[index]!,
            size: this.sizes[index]!,
            timestamp: this.timestamps[index]!,
            duration: this.durations[index]!,
            isKeyframe: (this.flags[index]! & KEYFRAME) !== 0,
        };
        const data = this.data?.[index];
        if (data) sample.data = data;
        return sample;
    }

    /**
     * Points frame `index` at another stored range (or restored bytes) with its own keyframe flag.
     */
    replaceFrame(
        index: number,
        offset: number,
        size: number,
        keyframe: boolean,
        data?: Uint8Array,
    ): void {
        this.offsets[index] = offset;
        this.sizes[index] = size;
        this.flags[index] = (this.flags[index]! & ~KEYFRAME) | (keyframe ? KEYFRAME : 0);
        if (data) {
            this.reserve(data.length + 16);
            (this.data ??= [])[index] = data;
        } else if (this.data) delete this.data[index];
    }

    /**
     * Frames whose block times are decode times (V_MS/VFW/FOURCC) take the presentation and decode
     * times of `samples`, one per frame in order, and their NAL framing.
     */
    presentFromDecodeOrder(samples: readonly Sample[]): void {
        const count = this.length;
        this.reserve(count * 16);
        const decodeTimes = new Float64Array(count);
        const compositionOffsets = new Float64Array(count);
        for (let index = 0; index < count; index++) {
            const sample = samples[index]!;
            this.timestamps[index] = sample.timestamp;
            this.durations[index] = sample.duration;
            decodeTimes[index] = decodeTime(sample);
            compositionOffsets[index] = sample.timestamp - decodeTimes[index]!;
            if (sample.nalUnitFormat)
                this.flags[index]! |= sample.nalUnitFormat === 'annexb' ? ANNEX_B : NAL_LENGTHS;
        }
        this.decodeTimes = decodeTimes;
        this.compositionOffsets = compositionOffsets;
    }

    /**
     * Audio decodes in storage order: where block times run back (a block timed inside the laced
     * frames before it), a frame's decode time holds at the latest earlier presentation time.
     */
    keepStorageOrder(): void {
        const count = this.length;
        const timestamps = this.timestamps;
        let regresses = false;
        for (let index = 1; index < count && !regresses; index++)
            regresses = timestamps[index]! < timestamps[index - 1]!;
        if (!regresses) return;
        this.reserve(count * 16);
        const decodeTimes = new Float64Array(count);
        const compositionOffsets = new Float64Array(count);
        let latest = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < count; index++) {
            latest = Math.max(latest, timestamps[index]!);
            decodeTimes[index] = latest;
            compositionOffsets[index] = timestamps[index]! - latest;
        }
        this.decodeTimes = decodeTimes;
        this.compositionOffsets = compositionOffsets;
    }

    /**
     * Times presentation-reordered video by the rule of ReorderClock (by `timing` where given); a
     * track it keeps as stored is left as it is.
     */
    reconstructVideoDecodeTimes(timing?: ReorderTiming): void {
        const count = this.length;
        const timestamps = this.timestamps;
        let decodeTimes: Float64Array | undefined;
        let compositionOffsets: Float64Array | undefined;
        const clock = new ReorderClock<number>(
            index => timestamps[index]!,
            (index, decode, duration) => {
                if (!decodeTimes) {
                    this.reserve(count * 24);
                    decodeTimes = new Float64Array(count);
                    compositionOffsets = new Float64Array(count);
                }

                decodeTimes[index] = decode;
                compositionOffsets![index] = timestamps[index]! - decode;
                if (duration !== undefined) this.durations[index] = duration;
            },
            () => undefined,
            timing,
        );

        for (let index = 0; index < count; index++) clock.push(index);
        clock.flush();
        if (!decodeTimes) return;
        this.decodeTimes = decodeTimes;
        this.compositionOffsets = compositionOffsets;
    }

    /** Durations of the frames stored without one, by the rule of DurationFiller. */
    fillDurations(): void {
        const { timestamps, durations } = this;
        const filler = new DurationFiller<number>(
            index => timestamps[index]!,
            index => durations[index]!,
            (index, timestamp, duration) => {
                // A spread frame keeps its reconstructed decode delay.
                if (this.decodeTimes) this.decodeTimes[index]! += timestamp - timestamps[index]!;
                timestamps[index] = timestamp;
                durations[index] = duration;
            },
            () => undefined,
        );
        for (let index = 0; index < this.length; index++) filler.push(index);
        filler.flush();
    }

    finish(): MatroskaSampleIndex {
        const count = this.length;
        const offsets = trimmed(this.offsets, count);
        const sizes = trimmed(this.sizes, count);
        const timestamps = trimmed(this.timestamps, count);
        const durations = trimmed(this.durations, count);
        const flags = trimmed(this.flags, count);
        const alphaOffsets = this.alphaOffsets && trimmed(this.alphaOffsets, count);
        const alphaSizes = this.alphaSizes && trimmed(this.alphaSizes, count);
        const decodeTimes = this.decodeTimes;
        let maxSampleSize = 0;
        let allKeyframes = true;
        let presentationSorted = true;
        let decodeSorted = true;
        let firstPresentation = Number.POSITIVE_INFINITY;
        let lastPresentationEnd = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < count; index++) {
            const timestamp = timestamps[index]!;
            maxSampleSize = Math.max(
                maxSampleSize,
                sizes[index]! + (alphaSizes ? alphaSizes[index]! : 0),
            );
            if ((flags[index]! & KEYFRAME) === 0) allKeyframes = false;
            firstPresentation = Math.min(firstPresentation, timestamp);
            lastPresentationEnd = Math.max(lastPresentationEnd, timestamp + durations[index]!);
            if (index > 0) {
                if (timestamp < timestamps[index - 1]!) presentationSorted = false;
                if (decodeTimes && decodeTimes[index]! < decodeTimes[index - 1]!)
                    decodeSorted = false;
            }
        }

        if (!decodeTimes) decodeSorted = presentationSorted;
        const byteLength =
            offsets.byteLength +
            sizes.byteLength +
            timestamps.byteLength +
            durations.byteLength +
            flags.byteLength +
            (alphaOffsets?.byteLength ?? 0) +
            (alphaSizes?.byteLength ?? 0) +
            (decodeTimes?.byteLength ?? 0) +
            (this.compositionOffsets?.byteLength ?? 0);

        return new MatroskaSampleIndex(
            count,
            byteLength,
            maxSampleSize,
            allKeyframes,
            presentationSorted,
            decodeSorted,
            firstPresentation,
            lastPresentationEnd,
            offsets,
            sizes,
            timestamps,
            durations,
            flags,
            alphaOffsets,
            alphaSizes,
            decodeTimes,
            this.compositionOffsets,
            this.data,
            this.discards,
        );
    }
}
