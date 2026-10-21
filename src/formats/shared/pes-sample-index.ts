import type { Sample } from '../../core/model/track';
import { SummarizedSampleIndex, type SampleIndex } from '../../core/model/sample-index';
import { ownBytes } from '../../core/bytes/shared-bytes';

const DURATION_CODES = 255;

/**
 * Growable sample table of PES streams (MPEG-TS, MPEG-PS) in typed arrays. Video keeps 90 kHz
 * presentation and decode ticks, audio its times in seconds, so `get` returns the values the
 * object form held; a sample's bytes are a transport location, held inline, or both when the
 * table `holdsLocatedBytes`. Durations are coded against the few distinct values a stream uses
 * until more than 255 appear.
 */
export class PesSampleIndex extends SummarizedSampleIndex implements SampleIndex {
    /** Bytes per audio and per video sample while durations stay coded. */
    static readonly AUDIO_BYTES = 26;
    static readonly VIDEO_BYTES = 38;
    // A window of a stream holds a few dozen samples; larger tables double from here.
    private times = new Float64Array(64);
    private decodes: Float64Array | undefined;
    private offsets = new Float64Array(64);
    private sizes = new Uint32Array(64);
    private skips = new Uint32Array(64);
    private packetBytes: Uint32Array | undefined;
    /** Bit 0 keyframe, bit 1 transport location. */
    private flags = new Uint8Array(64);
    private durationCodes: Uint8Array | undefined = new Uint8Array(64);
    private durationValues: number[] = [];
    private durations: Float64Array | undefined;
    private shifts: Float64Array | undefined;
    private readonly inline = new Map<number, Uint8Array>();

    constructor(
        readonly video: boolean,
        private readonly holdsLocatedBytes = false,
    ) {
        super();
        if (video) {
            this.decodes = new Float64Array(64);
            this.packetBytes = new Uint32Array(64);
        }
    }

    get byteLength(): number {
        return this.length * (this.video ? PesSampleIndex.VIDEO_BYTES : PesSampleIndex.AUDIO_BYTES);
    }

    /**
     * Appends a sample: `time` is seconds for audio and presentation ticks for video (`decode` its
     * decode ticks); `location` places its bytes in the transport stream, and `data` holds them
     * unless the table keeps the location alone.
     */
    push(
        time: number,
        decode: number,
        duration: number,
        size: number,
        keyframe: boolean,
        location: { pos: number; skip: number; bytes: number } | undefined,
        data: (() => Uint8Array) | undefined,
    ): void {
        const index = this.length;
        if (index === this.times.length) this.grow(index * 2);
        this.times[index] = time;
        if (this.decodes) this.decodes[index] = decode;
        this.sizes[index] = size;
        this.flags[index] = (keyframe ? 1 : 0) | (location ? 2 : 0);
        if (location) {
            this.offsets[index] = location.pos;
            this.skips[index] = location.skip;
            if (this.packetBytes && location.bytes !== size)
                this.packetBytes[index] = location.bytes;
        }
        if (!location || this.holdsLocatedBytes) this.inline.set(index, ownBytes(data!()));
        this.length++;
        this.setDuration(index, duration);
    }

    setDuration(index: number, duration: number): void {
        if (this.durationCodes) {
            let code = this.durationValues.indexOf(duration);
            if (code < 0 && this.durationValues.length < DURATION_CODES)
                code = this.durationValues.push(duration) - 1;
            if (code >= 0) {
                this.durationCodes[index] = code;
                return;
            }
            const durations = new Float64Array(this.times.length);
            for (let at = 0; at < this.length; at++)
                durations[at] = this.durationValues[this.durationCodes[at]!]!;
            this.durations = durations;
            this.durationCodes = undefined;
        }
        this.durations![index] = duration;
    }

    /** Marks a sample as a keyframe. */
    setKeyframe(index: number): void {
        this.flags[index]! |= 1;
    }

    /** Replaces a sample's bytes with `data`, which it then holds. */
    hold(index: number, data: Uint8Array): void {
        this.inline.set(index, ownBytes(data));
        this.sizes[index] = data.length;
        this.offsets[index] = 0;
        this.flags[index]! &= ~2;
        if (this.packetBytes) this.packetBytes[index] = 0;
    }

    /** Moves a sample's times by `offset` seconds, as a timeline splice places its segment. */
    shift(index: number, offset: number): void {
        this.shifts ??= new Float64Array(this.times.length);
        this.shifts[index]! += offset;
    }

    get located(): boolean {
        for (let index = 0; index < this.length; index++) if (this.flags[index]! & 2) return true;
        return false;
    }

    durationAt(index: number): number {
        return this.durationCodes
            ? this.durationValues[this.durationCodes[index]!]!
            : this.durations![index]!;
    }

    timestampAt(index: number): number {
        const time = this.video ? this.times[index]! / 90000 : this.times[index]!;
        return this.shifts ? time + this.shifts[index]! : time;
    }

    decodeTimeAt(index: number): number {
        if (!this.decodes) return this.timestampAt(index);
        const time = this.decodes[index]! / 90000;
        return this.shifts ? time + this.shifts[index]! : time;
    }

    isKeyframeAt(index: number): boolean {
        return (this.flags[index]! & 1) !== 0;
    }

    get(index: number): Sample {
        const sample: Sample = {
            offset: this.offsets[index]!,
            size: this.sizes[index]!,
            timestamp: this.timestampAt(index),
            duration: this.durationAt(index),
            isKeyframe: this.isKeyframeAt(index),
        };

        if (this.decodes) {
            sample.decodeTimestamp = this.decodeTimeAt(index);
            sample.compositionTimeOffset =
                this.times[index]! / 90000 - this.decodes[index]! / 90000;
        }

        if (this.flags[index]! & 2) {
            sample.packetSkip = this.skips[index]!;
            if (this.packetBytes?.[index]) sample.packetBytes = this.packetBytes[index];
        }

        const data = this.inline.get(index);
        if (data) sample.data = data;
        return sample;
    }

    /** Presentation end of the latest sample. */
    end(): number {
        let end = 0;
        for (let index = 0; index < this.length; index++)
            end = Math.max(end, this.timestampAt(index) + this.durationAt(index));
        return end;
    }

    /** Computes the table summary and trims the arrays to the samples. */
    finish(): void {
        this.summarize(this.sizes, index => this.durationAt(index));
        this.grow(this.length);
    }

    private grow(capacity: number): void {
        this.times = this.resized(this.times, capacity);
        this.offsets = this.resized(this.offsets, capacity);
        this.sizes = this.resized(this.sizes, capacity);
        this.skips = this.resized(this.skips, capacity);
        this.flags = this.resized(this.flags, capacity);
        if (this.decodes) this.decodes = this.resized(this.decodes, capacity);
        if (this.packetBytes) this.packetBytes = this.resized(this.packetBytes, capacity);
        if (this.durationCodes) this.durationCodes = this.resized(this.durationCodes, capacity);
        if (this.durations) this.durations = this.resized(this.durations, capacity);
        if (this.shifts) this.shifts = this.resized(this.shifts, capacity);
    }
}

/**
 * Bytes per video sample, with the decode times and unit indexes kept until the durations are
 * known.
 */
export const VIDEO_SAMPLE_BYTES = PesSampleIndex.VIDEO_BYTES + 16;
