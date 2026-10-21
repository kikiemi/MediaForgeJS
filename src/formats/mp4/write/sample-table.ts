import type { EncodedPacket } from '../../../core/model/media';
import { MediaForgeError } from '../../../core/errors/errors';
import { decodeTime, secondsToTicks } from '../../../core/model/media-time';

const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;
// Small tracks need only a few rows; later pages avoid reallocating an ever-growing buffer.
const FIRST_PAGE_SIZE = 32;
const KEYFRAME = 1;
const DECODE_TIMESTAMP = 2;
const COMPOSITION_OFFSET = 4;

function pageFor(index: number): number {
    return index < FIRST_PAGE_SIZE ? 0 : ((index - FIRST_PAGE_SIZE) >>> PAGE_BITS) + 1;
}

function slotFor(index: number): number {
    return index < FIRST_PAGE_SIZE ? index : (index - FIRST_PAGE_SIZE) & PAGE_MASK;
}

function pageCapacity(pageIndex: number): number {
    return pageIndex === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE;
}

/** `value` when it is a safe integer within [min, max]; a MUX error naming `label` otherwise. */
export function checkedInteger(
    value: number,
    label: string,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new MediaForgeError(
            `MP4 ${label} is outside the exact integer range [${min}, ${max}]`,
            'MUX',
        );
    }
    return value;
}

/** Where a sample is: its size, file offset and keyframe flag, the bytes of a buffered one. */
interface SamplePage {
    sizes: Uint32Array;
    offsets: Float64Array;
    flags: Uint8Array;
    data?: Uint8Array[];
}

/** The times of samples kept as given, for a track whose timescale is known only once it ends. */
interface TimePage {
    timestamps: Float64Array;
    decodeTimestamps?: Float64Array;
    compositionOffsets?: Float64Array;
}

/**
 * A track's timing in its timescale: decode durations and composition offsets (stts and ctts runs),
 * its decode duration, its first presentation time and the media time where that presentation
 * starts.
 */
export interface SampleTiming {
    readonly decodeDurations: Mp4SampleRuns;
    readonly compositionOffsets: Mp4SampleRuns;
    readonly durationUnits: number;
    readonly startSeconds: number;
    readonly mediaTimeUnits: number;
}

/**
 * `timing` with its edit starting on a picture: when the latest picture presented at or before the
 * edit's media time presents before it, that picture is presented from there, its decode time
 * unchanged. Browsers show the picture an edit starts inside, while readers that drop every sample
 * presented before an edit (ffmpeg) drop it too, showing the next one late or, after the last,
 * nothing.
 */
export function presentedFromEdit<T extends SampleTiming>(timing: T): T {
    const edit = timing.mediaTimeUnits;
    const { decodeDurations: durations, compositionOffsets: offsets } = timing;
    let covering = -Infinity;
    let sample = -1;
    let offset = 0;
    let decode = 0;
    let first = 0;
    let durationRun = 0;
    let offsetRun = 0;
    let durationsLeft = durations.length ? durations.count(0) : 0;
    let offsetsLeft = offsets.length ? offsets.count(0) : 0;
    // Where both runs hold, the composition times rise by the decode duration.
    while (durationsLeft > 0 && offsetsLeft > 0) {
        const span = Math.min(durationsLeft, offsetsLeft);
        const step = durations.value(durationRun);
        const start = decode + offsets.value(offsetRun);
        if (start <= edit) {
            const steps = Math.min(span - 1, Math.floor((edit - start) / step));
            if (start + steps * step > covering) {
                covering = start + steps * step;
                sample = first + steps;
                offset = offsets.value(offsetRun);
            }
        }
        decode += span * step;
        first += span;
        durationsLeft -= span;
        offsetsLeft -= span;
        if (durationsLeft === 0 && ++durationRun < durations.length)
            durationsLeft = durations.count(durationRun);
        if (offsetsLeft === 0 && ++offsetRun < offsets.length)
            offsetsLeft = offsets.count(offsetRun);
    }
    if (sample < 0 || covering === edit) return timing;
    return {
        ...timing,
        compositionOffsets: offsets.withSample(sample, offset + edit - covering),
    };
}

/**
 * Turns sample times in seconds into a track's timing in `timescale` units, one sample at a time: a
 * sample's decode duration is the step to the next decode time (the last one's own duration);
 * decode times that do not increase are written one tick apart, the difference taken from the
 * samples after them, and a composition offset is taken from where its sample is written, so its
 * presentation time stays where the input put it.
 */
/**
 * Decode durations written as runs, their sum, and the units the next one owes to keep durations
 * positive.
 */
interface WrittenDurations {
    readonly decodeDurations: Mp4SampleRuns;
    durationUnits: number;
    debt: number;
}

class TimingBuilder {
    readonly compositionOffsets = new Mp4SampleRuns();
    /** The decode durations written, their sum and the units the next one owes. */
    private readonly written: WrittenDurations = {
        decodeDurations: new Mp4SampleRuns(),
        durationUnits: 0,
        debt: 0,
    };
    count = 0;
    private firstDecode = 0;
    /** Decode units of the latest sample, from the first. */
    private decodeUnits = 0;
    private startSeconds = Number.POSITIVE_INFINITY;
    /** The composition offset of the latest sample and its own duration in seconds. */
    private lastOffset = 0;
    private lastDuration = 0;
    /** The state before the latest add, which removeLast() restores. */
    private undo?: {
        readonly decodeUnits: number;
        readonly durationUnits: number;
        readonly debt: number;
        readonly startSeconds: number;
        readonly lastOffset: number;
        readonly lastDuration: number;
    };

    constructor(readonly timescale: number) {}

    add(
        decodeSeconds: number,
        presentationSeconds: number,
        explicitOffset: number | undefined,
        duration: number,
    ): void {
        const undo = {
            decodeUnits: this.decodeUnits,
            durationUnits: this.written.durationUnits,
            debt: this.written.debt,
            startSeconds: this.startSeconds,
            lastOffset: this.lastOffset,
            lastDuration: this.lastDuration,
        };

        const timescale = this.timescale;
        if (this.count === 0) this.firstDecode = decodeSeconds;
        else {
            const decodeUnits = secondsToTicks(
                decodeSeconds - this.firstDecode,
                timescale,
                'MP4 relative decode timestamp',
            );
            this.writeDuration(this.written, decodeUnits - this.decodeUnits);
            this.decodeUnits = decodeUnits;
        }

        const offset =
            (explicitOffset !== undefined
                ? this.decodeUnits +
                  secondsToTicks(explicitOffset, timescale, 'MP4 composition offset')
                : secondsToTicks(
                      presentationSeconds - this.firstDecode,
                      timescale,
                      'MP4 relative presentation timestamp',
                  )) - this.written.durationUnits;
        this.compositionOffsets.append(
            checkedInteger(offset, 'composition offset', -0x80000000, 0xffffffff),
        );
        this.lastOffset = offset;
        this.lastDuration = duration;
        if (presentationSeconds < this.startSeconds) this.startSeconds = presentationSeconds;
        this.count++;
        this.undo = undo;
    }

    /** Undoes the latest add, once. */
    removeLast(): void {
        const undo = this.undo!;
        this.undo = undefined;
        this.count--;
        this.compositionOffsets.removeLast();
        if (this.count > 0) this.written.decodeDurations.removeLast();
        this.decodeUnits = undo.decodeUnits;
        this.written.durationUnits = undo.durationUnits;
        this.written.debt = undo.debt;
        this.startSeconds = undo.startSeconds;
        this.lastOffset = undo.lastOffset;
        this.lastDuration = undo.lastDuration;
    }

    /**
     * The timing of the samples added so far, the last one lasting its own duration; the builder
     * goes on.
     */
    timing(): SampleTiming {
        const decodeDurations = this.written.decodeDurations.clone();
        if (this.count === 0)
            return {
                decodeDurations,
                compositionOffsets: this.compositionOffsets,
                durationUnits: 0,
                startSeconds: 0,
                mediaTimeUnits: 0,
            };

        const end = {
            decodeDurations,
            durationUnits: this.written.durationUnits,
            debt: this.written.debt,
        };
        this.writeDuration(
            end,
            Math.max(1, secondsToTicks(this.lastDuration, this.timescale, 'MP4 sample duration')),
        );
        const mediaTimeUnits = Math.max(
            0,
            secondsToTicks(
                this.startSeconds - this.firstDecode,
                this.timescale,
                'MP4 edit media time',
            ),
        );

        return {
            decodeDurations,
            compositionOffsets: this.compositionOffsets,
            durationUnits: end.durationUnits,
            startSeconds: this.startSeconds,
            mediaTimeUnits,
        };
    }

    /**
     * Writes the latest sample's decode duration, `step` units less what earlier samples borrowed,
     * into `state`.
     */
    private writeDuration(state: WrittenDurations, step: number): void {
        checkedInteger(step, 'sample decode delta', -Number.MAX_SAFE_INTEGER);
        let duration = step - state.debt;
        state.debt = 0;
        if (duration < 1) {
            state.debt = 1 - duration;
            duration = 1;
        }
        state.decodeDurations.append(checkedInteger(duration, 'sample duration', 1, 0xffffffff));
        state.durationUnits = checkedInteger(
            state.durationUnits + duration,
            'track decode duration',
        );
        checkedInteger(
            state.durationUnits + this.lastOffset,
            'presentation end',
            -Number.MAX_SAFE_INTEGER,
        );
    }
}

/**
 * The samples of an MP4 track in typed-array pages, without a JavaScript object per sample. A track
 * whose timescale is known as it starts keeps its timing as stts and ctts runs built sample by
 * sample; another keeps its sample times until timing() is asked with the timescale they decide.
 */
export class Mp4SampleTable {
    private readonly pages: SamplePage[] = [];
    private readonly times: TimePage[] = [];
    private builder?: TimingBuilder;
    length = 0;
    /** The largest step between decode times, and the latest sample's duration, in seconds. */
    private largestStep = 0;
    private lastDecode = 0;
    private lastDuration = 0;
    private previous?: {
        readonly largestStep: number;
        readonly lastDecode: number;
        readonly lastDuration: number;
    };
    /** Decoder configurations of the sample descriptions after the track's first. */
    readonly descriptionConfigs: Uint8Array[] = [];
    /** Samples where another sample description (0-based, 0 the track's first) takes over. */
    readonly descriptionRuns: { readonly first: number; readonly description: number }[] = [];

    /** `timescale`: the track's media timescale where it is known before the first sample. */
    constructor(private readonly timescale?: number) {
        if (timescale !== undefined) this.builder = new TimingBuilder(timescale);
    }

    /**
     * Selects the sample description of `config` for the next sample; `base` is the first
     * description's.
     */
    describeNext(base: Uint8Array | undefined, config: Uint8Array): void {
        const same = (other: Uint8Array | undefined): boolean =>
            !!other &&
            other.length === config.length &&
            other.every((byte, index) => byte === config[index]);
        let description = same(base) ? 0 : this.descriptionConfigs.findIndex(same) + 1;
        if (description === 0 && !same(base))
            description = this.descriptionConfigs.push(new Uint8Array(config));
        const current = this.descriptionRuns[this.descriptionRuns.length - 1]?.description ?? 0;
        if (description !== current) this.descriptionRuns.push({ first: this.length, description });
    }

    add(chunk: EncodedPacket, offset: number, retainData: boolean): void {
        const pageIndex = pageFor(this.length);
        const index = slotFor(this.length);
        let page = this.pages[pageIndex];
        if (!page) {
            const capacity = pageCapacity(pageIndex);
            page = {
                sizes: new Uint32Array(capacity),
                offsets: new Float64Array(capacity),
                flags: new Uint8Array(capacity),
            };
            this.pages.push(page);
        }

        const decode = decodeTime(chunk);
        const duration = chunk.duration ?? 0;
        if (this.builder)
            this.builder.add(decode, chunk.timestamp, chunk.compositionTimeOffset, duration);
        else this.keepTimes(chunk, index, pageIndex);

        page.sizes[index] = chunk.data.byteLength;
        page.offsets[index] = offset;
        let flags = chunk.isKeyframe ? KEYFRAME : 0;
        if (chunk.decodeTimestamp !== undefined) flags |= DECODE_TIMESTAMP;
        if (chunk.compositionTimeOffset !== undefined) flags |= COMPOSITION_OFFSET;
        page.flags[index] = flags;
        if (retainData) {
            page.data ??= [];
            page.data[index] = new Uint8Array(chunk.data);
        }

        this.previous = {
            largestStep: this.largestStep,
            lastDecode: this.lastDecode,
            lastDuration: this.lastDuration,
        };
        if (this.length > 0 && decode - this.lastDecode > this.largestStep)
            this.largestStep = decode - this.lastDecode;
        this.lastDecode = decode;
        this.lastDuration = duration;
        this.length++;
    }

    private keepTimes(chunk: EncodedPacket, index: number, pageIndex: number): void {
        let page = this.times[pageIndex];
        if (!page) {
            page = { timestamps: new Float64Array(pageCapacity(pageIndex)) };
            this.times.push(page);
        }
        page.timestamps[index] = chunk.timestamp;
        if (chunk.decodeTimestamp !== undefined) {
            page.decodeTimestamps ??= new Float64Array(page.timestamps.length);
            page.decodeTimestamps[index] = chunk.decodeTimestamp;
        }
        if (chunk.compositionTimeOffset !== undefined) {
            page.compositionOffsets ??= new Float64Array(page.timestamps.length);
            page.compositionOffsets[index] = chunk.compositionTimeOffset;
        }
    }

    clear(): void {
        this.pages.length = 0;
        this.times.length = 0;
        this.length = 0;
        if (this.timescale !== undefined) this.builder = new TimingBuilder(this.timescale);
        this.largestStep = this.lastDecode = this.lastDuration = 0;
        this.descriptionConfigs.length = 0;
        this.descriptionRuns.length = 0;
    }

    /** Removes the latest sample, once after each add. */
    removeLast(): void {
        this.length--;
        this.builder?.removeLast();
        ({
            largestStep: this.largestStep,
            lastDecode: this.lastDecode,
            lastDuration: this.lastDuration,
        } = this.previous!);
        if (slotFor(this.length) === 0) {
            this.pages.pop();
            this.times.pop();
        } else this.pages[pageFor(this.length)]!.data?.pop();
    }

    /**
     * The largest step between consecutive decode times, or the last sample's duration if larger,
     * in seconds.
     */
    get largestDecodeStep(): number {
        return Math.max(this.largestStep, this.length > 0 ? this.lastDuration : 0);
    }

    /**
     * The track's timing in `timescale` units: the one the table was made with, or any for a table
     * without one.
     */
    timing(timescale: number): SampleTiming {
        if (this.builder) {
            if (timescale !== this.builder.timescale)
                throw new MediaForgeError(
                    'MP4 track timescale changed after its first sample',
                    'MUX',
                );
            return this.builder.timing();
        }

        const builder = new TimingBuilder(timescale);
        for (let index = 0; index < this.length; index++) {
            const page = this.times[pageFor(index)]!;
            const slot = slotFor(index);
            const flags = this.pages[pageFor(index)]!.flags[slot]!;
            const timestamp = page.timestamps[slot]!;
            builder.add(
                flags & DECODE_TIMESTAMP ? page.decodeTimestamps![slot]! : timestamp,
                timestamp,
                flags & COMPOSITION_OFFSET ? page.compositionOffsets![slot]! : undefined,
                index === this.length - 1 ? this.lastDuration : 0,
            );
        }
        return builder.timing();
    }

    byteLength(index: number): number {
        return this.pages[pageFor(index)]!.sizes[slotFor(index)]!;
    }

    offset(index: number): number {
        return this.pages[pageFor(index)]!.offsets[slotFor(index)]!;
    }

    setOffset(index: number, offset: number): void {
        this.pages[pageFor(index)]!.offsets[slotFor(index)] = offset;
    }

    isKeyframe(index: number): boolean {
        return (this.pages[pageFor(index)]!.flags[slotFor(index)]! & KEYFRAME) !== 0;
    }

    data(index: number): Uint8Array | undefined {
        return this.pages[pageFor(index)]!.data?.[slotFor(index)];
    }
}

interface RunPage {
    values: Float64Array;
    counts: Uint32Array;
}

/** Run-length timing tables stay compact for both constant and irregular sample timing. */
export class Mp4SampleRuns {
    private readonly pages: RunPage[] = [];
    length = 0;

    append(value: number): void {
        const last = this.length - 1;
        if (last >= 0 && this.value(last) === value) {
            this.pages[pageFor(last)]!.counts[slotFor(last)]!++;
            return;
        }
        const pageIndex = pageFor(this.length);
        let page = this.pages[pageIndex];
        if (!page) {
            const capacity = pageCapacity(pageIndex);
            page = { values: new Float64Array(capacity), counts: new Uint32Array(capacity) };
            this.pages.push(page);
        }
        const index = slotFor(this.length);
        page.values[index] = value;
        page.counts[index] = 1;
        this.length++;
    }

    /** Removes the latest appended value. */
    removeLast(): void {
        const last = this.length - 1;
        if (--this.pages[pageFor(last)]!.counts[slotFor(last)]! === 0) this.length--;
    }

    value(index: number): number {
        return this.pages[pageFor(index)]!.values[slotFor(index)]!;
    }

    count(index: number): number {
        return this.pages[pageFor(index)]!.counts[slotFor(index)]!;
    }

    get lastValue(): number {
        return this.length === 0 ? 0 : this.value(this.length - 1);
    }

    replaceLast(value: number): void {
        const last = this.length - 1;
        const page = this.pages[pageFor(last)]!;
        const index = slotFor(last);
        if (--page.counts[index]! === 0) this.length--;
        this.append(value);
    }

    /** A copy with the value of sample `sample` replaced by `value`. */
    withSample(sample: number, value: number): Mp4SampleRuns {
        const copy = new Mp4SampleRuns();
        for (let run = 0, first = 0; run < this.length; run++) {
            const count = this.count(run);
            const runValue = this.value(run);
            if (sample >= first && sample < first + count) {
                copy.appendRun(runValue, sample - first);
                copy.appendRun(value, 1);
                copy.appendRun(runValue, first + count - sample - 1);
            } else copy.appendRun(runValue, count);
            first += count;
        }
        return copy;
    }

    private appendRun(value: number, count: number): void {
        if (count === 0) return;
        this.append(value);
        const last = this.length - 1;
        this.pages[pageFor(last)]!.counts[slotFor(last)]! += count - 1;
    }

    /** A copy whose changes leave these runs as they are. */
    clone(): Mp4SampleRuns {
        const copy = new Mp4SampleRuns();
        for (const page of this.pages)
            copy.pages.push({ values: page.values.slice(), counts: page.counts.slice() });
        copy.length = this.length;
        return copy;
    }
}
