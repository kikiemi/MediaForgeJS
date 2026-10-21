import { demuxAssert, malformedInput } from '../../../core/errors/demux-guard';
import type { DemuxIndexBudget } from '../../shared/demux-budget';
import type { Sample } from '../../../core/model/track';
import type { SampleIndex } from '../../../core/model/sample-index';
import { dataView } from '../../../core/bytes/byte-fields';
import { MediaForgeError } from '../../../core/errors/errors';
import { forEachGroupedSample } from './boxes';

interface Box {
    type: string;
    offset: number;
    size: number;
}

interface Tables {
    sizes: Box;
    chunks: Box;
    layout: Box;
    timing: Box;
    composition: Box | null;
    sync: Box | null;
    /** stps: open-GOP random access points, sync samples like ffmpeg reads them. */
    partialSync: Box | null;
    /** The 'prol' sbgp, whose members are sync samples too (preRollGroups). */
    preRoll?: Box | null;
}

interface IndexOptions {
    tables: Tables;
    bytes: Uint8Array;
    timescale: number;
    shift: number;
    budget: DemuxIndexBudget;
    breathe: () => Promise<void>;
    fitsMedia: (offset: number, size: number) => boolean;
    /**
     * The one range media lies in, when it is one (the input's media data box, or the whole input):
     * a chunk is checked against it in place, as fitsMedia would, without a call per chunk.
     */
    mediaSpan?: { readonly start: number; readonly end: number };
    missing: (count: number, offset: number) => void;
    strict: boolean;
    fileSize: number;
    /** Bytes per uncompressed audio frame; such tracks legitimately hold one-byte samples. */
    pcmFrameBytes: number;
    /**
     * Composition entries past the last sample are ignored after this report; strict validation
     * rejects them.
     */
    compositionExcess: (entries: number) => void;
    /**
     * Decode times past the last sample and out-of-order sync entries, ignored after this report
     * like ctts.
     */
    timingExcess: (samples: number) => void;
    timingShort: (samples: number) => void;
    syncIgnored: (table: string, entries: number) => void;
    /**
     * A text track: a zero stts delta is the instant of the empty sample that ends a cue (ffmpeg
     * writes one last), not a sample whose duration the table leaves out.
     */
    instants?: boolean;
    /** The presentation range and order a summary of the same tables found. */
    presentation?: Presentation;
}

interface Presentation {
    readonly first: number;
    readonly last: number;
    readonly sorted: boolean;
}

/** The options of a summary: an index's, but none for samples outside the media (it has none). */
export type SummaryOptions = Omit<IndexOptions, 'missing'>;

/** Where a track's tables lie in its movie box and how they are timed and placed. */
export type TableLayout = Pick<
    IndexOptions,
    'tables' | 'timescale' | 'shift' | 'mediaSpan' | 'strict' | 'fileSize' | 'pcmFrameBytes'
> & { readonly instants?: boolean; readonly presentation?: Presentation };

/** The samples a summary keeps: those an open reads (first pictures, sound shape, start time). */
const SUMMARY_SAMPLES = 64;

/** Entries a scan reads between yields (see classicIndex). */
const STEP = 0x8000;
const OFFSET_STRIDE = 256;
const STRIDE_BITS = 8;
const STRIDE_MASK = OFFSET_STRIDE - 1;

type SampleSizes = Uint8Array | Uint16Array | Uint32Array | number;

/** The size of sample `index` in a stsz/stz2 table of `field`-bit entries at `base`. */
function sampleSize(view: DataView, base: number, field: number, index: number): number {
    if (field === 32) return view.getUint32(base + index * 4);
    if (field === 16) return view.getUint16(base + index * 2);
    if (field === 8) return view.getUint8(base + index);
    return (view.getUint8(base + (index >>> 1)) >>> (index & 1 ? 0 : 4)) & 15;
}

/** Adds the sizes of samples [start, end) to totals[0] and keeps the largest in totals[1]. */
function sizeTotals(
    view: DataView,
    base: number,
    field: number,
    start: number,
    end: number,
    totals: Float64Array,
): void {
    let sum = totals[0]!;
    let largest = totals[1]!;
    if (field === 32)
        for (let index = start; index < end; index++) {
            const size = view.getUint32(base + index * 4);
            sum += size;
            if (size > largest) largest = size;
        }
    else
        for (let index = start; index < end; index++) {
            const size = sampleSize(view, base, field, index);
            sum += size;
            if (size > largest) largest = size;
        }
    totals[0] = sum;
    totals[1] = largest;
}

/** The stsc entries as checkRuns() reads them. */
interface StscRuns {
    readonly view: DataView;
    readonly base: number;
    readonly chunkCount: number;
    readonly strict: boolean;
    /** Where the runs are kept: their 0-based first chunks. */
    readonly firstChunks: Uint32Array;
    readonly perChunk: Uint32Array;
    /** The first chunk (from 1) of the entry before. */
    previous: number;
}

/**
 * Whether the stsc entry at `at` passes checkRuns(): it follows the one that starts at chunk
 * `previous` (from 1) within the table's chunks, of sample description 1.
 */
function validRun(
    view: DataView,
    at: number,
    previous: number,
    chunkCount: number,
    strict: boolean,
): boolean {
    const first = view.getUint32(at);
    return (
        first > previous &&
        first <= chunkCount &&
        (view.getUint32(at + 4) > 0 || !strict) &&
        view.getUint32(at + 8) === 1
    );
}

/** Checks stsc entries [start, end) and keeps them. */
function checkRuns(runs: StscRuns, start: number, end: number): void {
    const { view, base, chunkCount, strict, firstChunks, perChunk: samples } = runs;
    let previous = runs.previous;
    for (let entry = start; entry < end; entry++) {
        const at = base + entry * 12;
        const first = view.getUint32(at);
        const perChunk = view.getUint32(at + 4);

        // Empty chunks hold no samples; only strict validation rejects them.
        if (!(first > previous && first <= chunkCount && (perChunk > 0 || !strict)))
            malformedInput('invalid stsc chunk layout');
        const description = view.getUint32(at + 8);
        if (description !== 1)
            malformedInput(`stsc selects unsupported sample_description_index ${description}`);
        firstChunks[entry] = first - 1;
        samples[entry] = perChunk;
        previous = first;
    }
    runs.previous = previous;
}

/** An index's pass over the chunks, between its steps (scanChunks). */
interface ChunkScan {
    readonly view: DataView;
    readonly count: number;
    readonly runFirstChunk: Uint32Array;
    readonly runSamples: Uint32Array;
    /** Filled by the pass: the first sample of each run. */
    readonly runFirstSample: Uint32Array;
    readonly runCount: number;
    readonly chunkBase: number;
    readonly chunkWidth: number;
    readonly chunkCount: number;
    readonly chunkOffsets: Uint32Array | Float64Array;
    readonly sizeBase: number;
    readonly field: number;
    readonly constantSize: number;
    /** The sizes as read, where they are not constant. */
    readonly sizes: Uint32Array | undefined;
    /** The media is one span, from spanStart to spanEnd. */
    readonly span: boolean;
    readonly spanStart: number;
    readonly spanEnd: number;
    readonly fitsMedia: (offset: number, size: number) => boolean;
    readonly strict: boolean;
    readonly fileSize: number;
    sample: number;
    run: number;
    /** Where the chunk before ends. */
    end: number;
    checkpoints: number;
    largest: number;
    /** The bytes of the chunks so far. */
    total: number;
    /** The samples that lie in the media, and the offset of the first that does not. */
    kept: number;
    missingAt: number;
}

/**
 * One step of an index's pass over the chunks from `from`, which reads each sample's size once: it
 * keeps the sizes, the chunk offsets and the first sample of each stsc run, and checks that each
 * chunk lies in the media. Returns the chunk after the step: it ends after the chunk that reaches
 * a step of chunks or samples.
 */
function scanChunks(scan: ChunkScan, from: number): number {
    const { view, count, runFirstChunk, runSamples, runFirstSample, runCount, chunkBase } = scan;
    const { chunkWidth, chunkCount, chunkOffsets, sizeBase, field, constantSize, sizes } = scan;
    const { span, spanStart, spanEnd, fitsMedia, strict, fileSize } = scan;
    const first = scan.sample;
    let at = first;
    let run = scan.run;
    let end = scan.end;
    let checkpoints = scan.checkpoints;
    let largest = scan.largest;
    let total = scan.total;
    let kept = scan.kept;
    let missingAt = scan.missingAt;
    let chunk = from;
    let nextRun = run + 1 < runCount ? runFirstChunk[run + 1]! : chunkCount;
    let samplesInChunk = runSamples[run]!;

    for (; chunk < chunkCount && chunk - from < STEP && at - first < STEP; chunk++) {
        if (chunk >= nextRun) {
            while (chunk >= nextRun) {
                runFirstSample[++run] = at;
                nextRun = run + 1 < runCount ? runFirstChunk[run + 1]! : chunkCount;
            }
            samplesInChunk = runSamples[run]!;
        }
        if (!(samplesInChunk <= count - at))
            malformedInput('stsc/stco cover more samples than the track');

        const offset =
            chunkWidth === 8
                ? view.getUint32(chunkBase + chunk * 8) * 0x100000000 +
                  view.getUint32(chunkBase + chunk * 8 + 4)
                : view.getUint32(chunkBase + chunk * 4);
        chunkOffsets[chunk] = offset;
        const endSample = at + samplesInChunk;
        let endOffset = offset;

        if (constantSize) {
            if (offset !== end) checkpoints++;
            endOffset += samplesInChunk * constantSize;
        } else {
            // A checkpoint at every OFFSET_STRIDE-th sample and at a chunk that does not continue
            // the one before it, counted in integer steps (sample numbers are 32-bit).
            if (samplesInChunk > 0) {
                const strides = (at >>> STRIDE_BITS) + (at & STRIDE_MASK ? 1 : 0);
                checkpoints += ((endSample - 1) >>> STRIDE_BITS) - strides + 1;
                if (offset !== end && at & STRIDE_MASK) checkpoints++;
            }
            if (field === 32)
                for (let index = at; index < endSample; index++) {
                    const size = view.getUint32(sizeBase + index * 4);
                    sizes![index] = size;
                    endOffset += size;
                    if (size > largest) largest = size;
                }
            else
                for (let index = at; index < endSample; index++) {
                    const size = sampleSize(view, sizeBase, field, index);
                    sizes![index] = size;
                    endOffset += size;
                    if (size > largest) largest = size;
                }
        }

        // Offsets and sizes are whole numbers from zero, so a range is safe when its end is.
        if (!(endOffset <= Number.MAX_SAFE_INTEGER))
            malformedInput(`chunk ${chunk} has an invalid byte range`);

        total += endOffset - offset;
        if (
            span
                ? offset >= spanStart && endOffset <= spanEnd
                : fitsMedia(offset, endOffset - offset)
        )
            kept += samplesInChunk;
        else {
            let cursor = offset;
            for (let index = at; index < endSample; index++) {
                const size = constantSize || sampleSize(view, sizeBase, field, index);
                if (fitsMedia(cursor, size)) kept++;
                else {
                    if (strict)
                        malformedInput(
                            `sample ${index} spans ${cursor}+${size} past EOF ${fileSize}`,
                        );
                    if (kept === index) missingAt = cursor;
                }
                cursor += size;
            }
        }

        at = endSample;
        end = endOffset;
    }

    scan.sample = at;
    scan.run = run;
    scan.end = end;
    scan.checkpoints = checkpoints;
    scan.largest = largest;
    scan.total = total;
    scan.kept = kept;
    scan.missingAt = missingAt;
    return chunk;
}

/** A summary's pass over the chunks, between its steps (summarizeChunks). */
interface ChunkSummary {
    readonly view: DataView;
    readonly count: number;
    /** The samples whose runs and chunk offsets are kept. */
    readonly prefix: number;
    readonly runBase: number;
    readonly runCount: number;
    readonly chunkBase: number;
    readonly chunkWidth: number;
    readonly chunkCount: number;
    readonly sizeBase: number;
    readonly field: number;
    readonly constantSize: number;
    readonly largest: number;
    readonly spanStart: number;
    readonly spanEnd: number;
    /** Where the media is not one span. */
    readonly fitsMedia?: (offset: number, size: number) => boolean;
    readonly strict: boolean;
    /** The first chunk, samples per chunk and first sample of each run the prefix enters. */
    readonly runs: number[];
    readonly offsets: number[];
    sample: number;
    run: number;
    /** The first chunk (from 1) of the run. */
    first: number;
}

/**
 * Checks a step of chunks from `from` against the media: a chunk lies in its span when its samples
 * times the largest do, else when their sizes add up to an end in it. Returns the chunk after the
 * step, or -1 at a chunk outside the media.
 */
function summarizeChunks(pass: ChunkSummary, from: number): number {
    const { view, count, prefix, runBase, runCount, chunkBase, chunkWidth, chunkCount } = pass;
    const { sizeBase, field, constantSize, largest, spanStart, spanEnd, fitsMedia, strict } = pass;
    let at = pass.sample;
    let run = pass.run;
    let previous = pass.first;
    let nextRun = run + 1 < runCount ? view.getUint32(runBase + run * 12 + 12) - 1 : chunkCount;
    let samplesInChunk = view.getUint32(runBase + run * 12 + 4);
    const stop = Math.min(chunkCount, from + STEP);
    let chunk = from;
    for (; chunk < stop; chunk++) {
        while (chunk >= nextRun) {
            run++;
            const entry = runBase + run * 12;
            const first = view.getUint32(entry);
            samplesInChunk = view.getUint32(entry + 4);
            if (!validRun(view, entry, previous, chunkCount, strict)) return -1;
            previous = first;
            nextRun = run + 1 < runCount ? view.getUint32(entry + 12) - 1 : chunkCount;
            if (at < prefix) pass.runs.push(first - 1, samplesInChunk, at);
        }
        if (!(samplesInChunk <= count - at))
            malformedInput('stsc/stco cover more samples than the track');
        const offset =
            chunkWidth === 8
                ? view.getUint32(chunkBase + chunk * 8) * 0x100000000 +
                  view.getUint32(chunkBase + chunk * 8 + 4)
                : view.getUint32(chunkBase + chunk * 4);
        if (at < prefix) pass.offsets.push(offset);
        const endSample = at + samplesInChunk;
        if (fitsMedia || !(offset >= spanStart && offset + samplesInChunk * largest <= spanEnd)) {
            let end = offset;
            for (let index = at; index < endSample; index++)
                end += constantSize || sampleSize(view, sizeBase, field, index);
            if (!(end <= Number.MAX_SAFE_INTEGER))
                malformedInput(`chunk ${chunk} has an invalid byte range`);
            if (
                !(fitsMedia
                    ? fitsMedia(offset, end - offset)
                    : offset >= spanStart && end <= spanEnd)
            )
                return -1;
        }
        at = endSample;
    }
    pass.sample = at;
    pass.run = run;
    pass.first = previous;
    return chunk;
}

/** The presentation pass of an index between its steps (presentRuns). */
interface PresentPass {
    readonly starts: Uint32Array;
    readonly decodeStarts: Float64Array;
    readonly deltas: Uint32Array;
    readonly durations: Uint32Array;
    readonly compositionStarts: Uint32Array | undefined;
    readonly compositionOffsets: Int32Array | Uint32Array | undefined;
    /** The samples kept where some lie outside the media. */
    readonly retained: Uint32Array | undefined;
    readonly sizes: SampleSizes;
    readonly sync: Uint8Array | undefined;
    readonly count: number;
    readonly kept: number;
    readonly timescale: number;
    readonly shift: number;
    readonly wholeShift: number;
    readonly exactShift: boolean;
    earliest: number;
    latestEnd: number;
    /** The presentation of the run before. */
    previous: number;
    position: number;
    timingRun: number;
    compositionRun: number;
    sorted: boolean;
    largest: number;
    allKeyframes: boolean;
}

/**
 * The presentation range and order over segments [start, end) of the timing and composition runs
 * (samples, where some were left out).
 */
function presentRuns(pass: PresentPass, start: number, end: number): void {
    const { starts, decodeStarts, deltas, durations, compositionStarts, compositionOffsets } = pass;
    const { retained, sizes, sync, count, kept, timescale, shift, wholeShift, exactShift } = pass;
    const timingCount = starts.length;
    const compositionCount = compositionStarts ? compositionStarts.length : 0;
    let earliest = pass.earliest;
    let latestEnd = pass.latestEnd;
    let previous = pass.previous;
    let at = pass.position;
    let timed = pass.timingRun;
    let composed = pass.compositionRun;
    let sorted = pass.sorted;
    let largest = pass.largest;
    let allKeyframes = pass.allKeyframes;
    for (let segment = start; segment < end && at < kept; segment++) {
        const first = retained ? retained[at]! : at;
        timed = runAt(starts, first, timed);
        if (compositionStarts) composed = runAt(compositionStarts, first, composed);

        let next = at + 1;
        if (!retained) {
            next = timed + 1 < timingCount ? Math.min(count, starts[timed + 1]!) : count;
            if (compositionStarts && composed + 1 < compositionCount)
                next = Math.min(next, compositionStarts[composed + 1]!);
        }
        const last = retained ? first : next - 1;
        const compositionOffset = compositionOffsets?.[composed] ?? 0;
        const decodeStart = decodeStarts[timed]!;
        const delta = deltas[timed]!;
        const runStart = starts[timed]!;

        const firstTicks = decodeStart + (first - runStart) * delta + compositionOffset;
        const lastTicks = decodeStart + (last - runStart) * delta + compositionOffset;
        const firstPts = exactShift
            ? (firstTicks + wholeShift) / timescale
            : firstTicks / timescale + shift;
        const lastPts = exactShift
            ? (lastTicks + wholeShift) / timescale
            : lastTicks / timescale + shift;
        const endPts = lastPts + durations[timed]! / timescale;
        if (!(Number.isFinite(firstPts) && Number.isFinite(endPts)))
            malformedInput('sample presentation time is non-finite');
        earliest = Math.min(earliest, firstPts);
        latestEnd = Math.max(latestEnd, endPts);
        if (firstPts < previous) sorted = false;
        previous = lastPts;

        if (retained) {
            largest = Math.max(largest, typeof sizes === 'number' ? sizes : sizes[first]!);
            if (sync && !(sync[first >>> 3]! & (1 << (first & 7)))) allKeyframes = false;
        }
        at = next;
    }
    pass.earliest = earliest;
    pass.latestEnd = latestEnd;
    pass.previous = previous;
    pass.position = at;
    pass.timingRun = timed;
    pass.compositionRun = composed;
    pass.sorted = sorted;
    pass.largest = largest;
    pass.allKeyframes = allKeyframes;
}

function runAt(starts: Uint32Array, index: number, cursor: number): number {
    if (starts[cursor]! <= index) {
        if (cursor + 1 === starts.length || starts[cursor + 1]! > index) return cursor;
        if (cursor + 2 === starts.length || starts[cursor + 2]! > index) return cursor + 1;
    }
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle]! <= index) low = middle + 1;
        else high = middle;
    }
    return low - 1;
}

/**
 * Seconds of a media time in ticks moved by `shift` seconds. An edit that moves the track by whole
 * ticks is added in ticks before dividing, so a picture at 98 ticks of 24 moved back 2 is at
 * exactly 4 s rather than 3.9999999999999996.
 */
export function shiftedSeconds(ticks: number, timescale: number, shift: number): number {
    const shiftTicks = shift * timescale;
    const whole = Math.round(shiftTicks);
    return Math.abs(shiftTicks - whole) < 1e-6
        ? (ticks + whole) / timescale
        : ticks / timescale + shift;
}

class ClassicSampleIndex implements SampleIndex {
    readonly decodeSorted = true;
    private timingRun = 0;
    private compositionRun = 0;
    private layoutRun = 0;
    /** The sample after the last one located, its offset, and the end of its chunk. */
    private nextSample = -1;
    private nextOffset = 0;
    private chunkEnd = 0;
    /** Offsets at every OFFSET_STRIDE-th sample of each long chunk a random read went into. */
    private checkpoints?: Map<number, Float64Array>;
    constructor(
        readonly length: number,
        readonly byteLength: number,
        readonly maxSampleSize: number,
        readonly allKeyframes: boolean,
        readonly presentationSorted: boolean,
        readonly firstPresentation: number,
        readonly lastPresentationEnd: number,
        private readonly chunkOffsets: Uint32Array | Float64Array,
        /** Per stsc run: its first chunk (from 0), samples per chunk and first sample. */
        private readonly runFirstChunk: Uint32Array,
        private readonly runSamples: Uint32Array,
        private readonly runFirstSample: Uint32Array,
        private readonly sizes: SampleSizes,
        private readonly starts: Uint32Array,
        private readonly decodeStarts: Float64Array,
        private readonly deltas: Uint32Array,
        private readonly durations: Uint32Array,
        private readonly compositionStarts: Uint32Array | undefined,
        private readonly compositionOffsets: Int32Array | Uint32Array | undefined,
        private readonly sync: Uint8Array | undefined,
        private readonly retained: Uint32Array | undefined,
        private readonly timescale: number,
        private readonly shift: number,
        /**
         * Ticks every decode time moves earlier so no negative composition offset presents a sample
         * before it is decoded.
         */
        private readonly decodeShift: number,
    ) {}

    private physical(index: number): number {
        return this.retained ? this.retained[index]! : index;
    }

    private decode(index: number): number {
        const run = (this.timingRun = runAt(this.starts, index, this.timingRun));
        return this.decodeStarts[run]! + (index - this.starts[run]!) * this.deltas[run]!;
    }

    private composition(index: number): number {
        if (!this.compositionStarts) return 0;
        this.compositionRun = runAt(this.compositionStarts, index, this.compositionRun);
        return this.compositionOffsets![this.compositionRun]!;
    }

    private sizeAt(index: number): number {
        return typeof this.sizes === 'number' ? this.sizes : this.sizes[index]!;
    }

    /**
     * A sample's offset: its chunk's offset and the sizes of the samples before it there. Reads in
     * order add one size per sample; a random read finds the chunk through the stsc runs and adds
     * at most OFFSET_STRIDE sizes past a checkpoint, even in a chunk of millions of samples.
     */
    private offset(index: number): number {
        if (index === this.nextSample && index < this.chunkEnd) {
            const offset = this.nextOffset;
            this.nextOffset = offset + this.sizeAt(index);
            this.nextSample = index + 1;
            return offset;
        }
        const run = (this.layoutRun = runAt(this.runFirstSample, index, this.layoutRun));
        const perChunk = this.runSamples[run]!;
        const inRun = index - this.runFirstSample[run]!;
        const chunkInRun = Math.floor(inRun / perChunk);
        const chunk = this.runFirstChunk[run]! + chunkInRun;
        const first = index - (inRun - chunkInRun * perChunk);
        let offset = this.chunkOffsets[chunk]!;
        const sizes = this.sizes;
        if (typeof sizes === 'number') offset += (index - first) * sizes;
        else {
            let at = first;
            if (index - first > OFFSET_STRIDE) {
                const mark = Math.floor((index - first) / OFFSET_STRIDE);
                offset = this.checkpointsOf(chunk, first, perChunk, sizes)[mark]!;
                at = first + mark * OFFSET_STRIDE;
            }
            while (at < index) offset += sizes[at++]!;
        }
        this.chunkEnd = first + perChunk;
        this.nextSample = index + 1;
        this.nextOffset = offset + this.sizeAt(index);
        return offset;
    }

    private checkpointsOf(
        chunk: number,
        first: number,
        count: number,
        sizes: Uint8Array | Uint16Array | Uint32Array,
    ): Float64Array {
        let marks = this.checkpoints?.get(chunk);
        if (!marks) {
            marks = new Float64Array(Math.ceil(count / OFFSET_STRIDE));
            let offset = this.chunkOffsets[chunk]!;
            for (let at = 0; at < count; at++) {
                if (at % OFFSET_STRIDE === 0) marks[at / OFFSET_STRIDE] = offset;
                offset += sizes[first + at]!;
            }
            (this.checkpoints ??= new Map()).set(chunk, marks);
        }
        return marks;
    }

    timestampAt(index: number): number {
        const physical = this.physical(index);
        return shiftedSeconds(
            this.decode(physical) + this.composition(physical),
            this.timescale,
            this.shift,
        );
    }

    decodeTimeAt(index: number): number {
        return shiftedSeconds(
            this.decode(this.physical(index)) - this.decodeShift,
            this.timescale,
            this.shift,
        );
    }

    isKeyframeAt(index: number): boolean {
        const physical = this.physical(index);
        return !this.sync || (this.sync[physical >>> 3]! & (1 << (physical & 7))) !== 0;
    }

    get(index: number): Sample {
        const physical = this.physical(index);
        const run = (this.timingRun = runAt(this.starts, physical, this.timingRun));
        const dts = this.decodeStarts[run]! + (physical - this.starts[run]!) * this.deltas[run]!;
        const composition = this.composition(physical);
        const sample: Sample = {
            offset: this.offset(physical),
            size: typeof this.sizes === 'number' ? this.sizes : this.sizes[physical]!,
            timestamp: shiftedSeconds(dts + composition, this.timescale, this.shift),
            duration: this.durations[run]! / this.timescale,
            isKeyframe: !this.sync || (this.sync[physical >>> 3]! & (1 << (physical & 7))) !== 0,
        };

        if (this.compositionStarts) {
            sample.decodeTimestamp = shiftedSeconds(
                dts - this.decodeShift,
                this.timescale,
                this.shift,
            );
            sample.compositionTimeOffset = (composition + this.decodeShift) / this.timescale;
        }

        return sample;
    }
}

/**
 * The index of a described track: its summary and its first samples; a sample after them has no
 * index to be read from.
 */
class SummaryIndex extends ClassicSampleIndex {
    constructor(
        private readonly kept: number,
        ...index: ConstructorParameters<typeof ClassicSampleIndex>
    ) {
        super(...index);
    }

    override get(index: number): Sample {
        if (index >= this.kept)
            throw new MediaForgeError('A probed input has no packet index', 'INPUT');
        return super.get(index);
    }
}

/** Keeps timing runs and numeric byte ranges; no per-sample objects survive open. */
export async function createClassicSampleIndex(options: IndexOptions): Promise<SampleIndex> {
    return (await classicIndex(options))!;
}

/**
 * The summary of a track's sample tables without its index: the tables are checked as an index
 * checks them, the largest sample and the presentation range are those it would give, its
 * byteLength is at least the index's, and get() reads its first samples. Undefined where a sample
 * lies outside the media (the index leaves it out).
 */
export function describeClassicSamples(options: SummaryOptions): Promise<SampleIndex | undefined> {
    return classicIndex({ ...options, missing: () => undefined }, SUMMARY_SAMPLES);
}

async function classicIndex(
    options: IndexOptions,
    summary?: number,
): Promise<SampleIndex | undefined> {
    const { tables, bytes, timescale, shift, budget, breathe } = options;
    const view = dataView(bytes);
    const u32 = (offset: number): number => view.getUint32(offset, false);
    const { sizes: sizeBox, chunks, layout, timing, composition, sync, partialSync } = tables;
    if (!(sizeBox.size >= 20)) malformedInput(`${sizeBox.type} box is truncated`);
    for (const box of [chunks, layout, timing, composition, sync, partialSync]) {
        if (box) if (!(box.size >= 16)) malformedInput(`${box.type} box is truncated`);
    }
    const count = u32(sizeBox.offset + 16);
    budget.checkSamples(count, 'MP4 sample table');
    demuxAssert(
        count > 0 && timescale > 0 && Number.isFinite(shift),
        'invalid compact sample timing',
    );
    const constantSize = sizeBox.type === 'stsz' ? u32(sizeBox.offset + 12) : 0;
    const field = sizeBox.type === 'stsz' ? 32 : bytes[sizeBox.offset + 15]!;
    if (!(field === 4 || field === 8 || field === 16 || (field === 32 && sizeBox.type === 'stsz')))
        malformedInput(`stz2 field size ${field}`);
    if (!(constantSize > 0 || 20 + Math.ceil((count * field) / 8) <= sizeBox.size))
        malformedInput(`${sizeBox.type} table exceeds its box`);
    demuxAssert(
        !options.strict || constantSize * count <= options.fileSize,
        'stsz sample bytes exceed file size',
    );
    const chunkCount = u32(chunks.offset + 12);
    const layoutCount = u32(layout.offset + 12);
    const timingCount = u32(timing.offset + 12);
    const compositionCount = composition ? u32(composition.offset + 12) : 0;
    const syncCount = sync ? u32(sync.offset + 12) : 0;
    for (const entries of [chunkCount, layoutCount, timingCount, compositionCount, syncCount])
        budget.checkSamples(entries, 'MP4 table entries');
    const chunkWidth = chunks.type === 'co64' ? 8 : 4;
    if (!(16 + chunkCount * chunkWidth <= chunks.size))
        malformedInput(`${chunks.type} table exceeds its box`);
    demuxAssert(
        layoutCount > 0 && 16 + layoutCount * 12 <= layout.size,
        'stsc table exceeds its box or has no entries',
    );
    demuxAssert(u32(layout.offset + 16) === 1, 'stsc first entry must start at chunk 1');
    demuxAssert(
        timingCount > 0 && 16 + timingCount * 8 <= timing.size,
        'stts table exceeds its box or has no entries',
    );
    if (composition)
        demuxAssert(16 + compositionCount * 8 <= composition.size, 'ctts table exceeds its box');
    if (sync) demuxAssert(16 + syncCount * 4 <= sync.size, 'stss table exceeds its box');
    const compositionVersion = composition ? bytes[composition.offset + 8] : 0;
    if (!(compositionVersion === 0 || compositionVersion === 1))
        malformedInput(`unsupported ctts version ${compositionVersion}`);

    // The scans run in synchronous steps with a yield between them: V8 does not optimize a loop
    // inside an async function while it runs, so steps keep the first scan of a large table fast. A
    // chunk step ends after the chunk that reaches 32,768 chunks or samples. The steps of the long
    // scans are functions of the module that take their scan's state as an object and work on
    // locals: V8 keeps their optimized code from one index to the next, where a closure made for
    // each index loses it whenever a closure it calls is another one, and a number past 31 bits
    // written to a variable shared with the async function would be boxed on every write. Their
    // loops read the tables through `view` rather than through helpers.
    const inSteps = async (
        total: number,
        step: (start: number, end: number) => void,
    ): Promise<void> => {
        for (let start = 0; start < total; start += STEP) {
            if (start > 0) await breathe();
            step(start, Math.min(total, start + STEP));
        }
    };

    // A table of a step or more yields once before its scans, so a cancellation lands before the
    // work; a smaller one runs without waiting for the event loop.
    if (count >= 0x8000) await breathe();

    // The stsc runs as arrays: the 0-based first chunk and the samples per chunk of each, and
    // (filled by the chunk scan) the first sample of each, through which a sample finds its chunk.
    // A summary keeps those of its first samples only, which its chunk scan collects.
    const whole = summary === undefined;
    const prefix = whole ? count : Math.min(count, summary);
    let runFirstChunk = new Uint32Array(whole ? layoutCount : 0);
    let runSamples = new Uint32Array(whole ? layoutCount : 0);
    let runFirstSample = new Uint32Array(whole ? layoutCount : 0);
    const entries: StscRuns = {
        view,
        base: layout.offset + 16,
        chunkCount,
        strict: options.strict,
        firstChunks: runFirstChunk,
        perChunk: runSamples,
        previous: 0,
    };
    // A summary checks the entries as its chunk scan enters them (summarizeChunks), all of them.
    if (whole) await inSteps(layoutCount, (start, end) => checkRuns(entries, start, end));
    const span = options.mediaSpan;
    const spanStart = span ? span.start : 0;
    const spanEnd = span ? span.end : 0;
    const sizeBase = sizeBox.offset + 20;
    const chunkBase = chunks.offset + 16;
    const wideOffsets = options.fileSize > 0xffffffff;
    let chunkOffsets: Uint32Array | Float64Array = wideOffsets
        ? new Float64Array(whole ? chunkCount : 0)
        : new Uint32Array(whole ? chunkCount : 0);

    const overChunks = async (step: (chunk: number) => number): Promise<void> => {
        for (let chunk = 0; chunk < chunkCount;) {
            if (chunk > 0) await breathe();
            chunk = step(chunk);
        }
    };

    // One pass over the chunks reads each sample's size once: it keeps the sizes (as 32-bit values
    // until the largest is known), the chunk offsets and the first sample of each stsc run, and
    // checks that each chunk lies in the media. The table stays in its container form: a sample's
    // offset is found from its chunk when it is read, not stored for every sample. The budget
    // charges the offsets as one per checkpoint (each chunk that does not continue the one before
    // it, and every OFFSET_STRIDE-th sample) with its sample number, or one per sample where that
    // is less.
    let wide = constantSize ? undefined : new Uint32Array(whole ? count : 0);
    let checkpointCount = 0;
    let maxSampleSize = constantSize;
    let sample = 0;
    let declared = 0;
    let retainedCount = 0;
    let firstMissing = 0;

    // A summary reads the sizes in one pass for their sum and the largest, and places each chunk
    // in the media by its samples times the largest: only a chunk that bound leaves out is summed
    // sample by sample. It keeps the runs, chunk offsets and sizes of its first samples.
    const summarize = async (): Promise<boolean> => {
        const totals = new Float64Array([constantSize * count, constantSize]);
        if (!constantSize)
            await inSteps(count, (start, end) =>
                sizeTotals(view, sizeBase, field, start, end, totals),
            );
        declared = totals[0]!;
        maxSampleSize = totals[1]!;
        const pass: ChunkSummary = {
            view,
            count,
            prefix,
            runBase: layout.offset + 16,
            runCount: layoutCount,
            chunkBase,
            chunkWidth,
            chunkCount,
            sizeBase,
            field,
            constantSize,
            largest: constantSize || maxSampleSize,
            spanStart,
            spanEnd,
            fitsMedia: span ? undefined : options.fitsMedia,
            strict: options.strict,
            runs: [0, view.getUint32(layout.offset + 20), 0],
            offsets: [],
            sample: 0,
            run: 0,
            first: 1,
        };
        if (!validRun(view, layout.offset + 16, 0, chunkCount, options.strict)) return false;
        let fits = true;
        await overChunks(from => {
            const next = summarizeChunks(pass, from);
            fits = next >= 0;
            return fits ? next : chunkCount;
        });
        if (!fits || pass.run !== layoutCount - 1) return false;
        sample = pass.sample;
        const { runs, offsets } = pass;
        const kept = runs.length / 3;
        runFirstChunk = new Uint32Array(kept);
        runSamples = new Uint32Array(kept);
        runFirstSample = new Uint32Array(kept);
        for (let run = 0; run < kept; run++) {
            runFirstChunk[run] = runs[run * 3]!;
            runSamples[run] = runs[run * 3 + 1]!;
            runFirstSample[run] = runs[run * 3 + 2]!;
        }
        chunkOffsets = wideOffsets ? Float64Array.from(offsets) : Uint32Array.from(offsets);
        if (wide)
            wide = Uint32Array.from({ length: prefix }, (_, index) =>
                sampleSize(view, sizeBase, field, index),
            );
        retainedCount = count;
        return true;
    };
    if (whole) {
        const scan: ChunkScan = {
            view,
            count,
            runFirstChunk,
            runSamples,
            runFirstSample,
            runCount: layoutCount,
            chunkBase,
            chunkWidth,
            chunkCount,
            chunkOffsets,
            sizeBase,
            field,
            constantSize,
            sizes: wide,
            span: span !== undefined,
            spanStart,
            spanEnd,
            fitsMedia: options.fitsMedia,
            strict: options.strict,
            fileSize: options.fileSize,
            sample: 0,
            run: 0,
            end: -1,
            checkpoints: 0,
            largest: constantSize,
            total: 0,
            kept: 0,
            missingAt: 0,
        };
        await overChunks(from => scanChunks(scan, from));
        ({ sample, checkpoints: checkpointCount, largest: maxSampleSize, total: declared } = scan);
        ({ kept: retainedCount, missingAt: firstMissing } = scan);
    } else if (!(await summarize())) return undefined;
    if (!(sample === count)) malformedInput(`stsc/stco cover ${sample}/${count} samples`);
    demuxAssert(
        count < 4096 ||
            declared / count >= 2 ||
            (options.pcmFrameBytes > 0 && declared === count * options.pcmFrameBytes),
        'MP4 sample table implausibly small (ledger-flood input)',
    );
    const sizeWidth = maxSampleSize <= 0xff ? 1 : maxSampleSize <= 0xffff ? 2 : 4;
    const offsetWidth = options.fileSize <= 0xffffffff ? 4 : 8;
    // A summary counts no checkpoints: it charges the offsets at their most, one per sample.
    const sparseOffsets = whole && checkpointCount * (offsetWidth + 4) < count * offsetWidth;
    const offsetCount = sparseOffsets ? checkpointCount : count;
    const syncBytes = sync ? Math.ceil(count / 8) : 0;
    const byteLength =
        offsetCount * offsetWidth +
        (sparseOffsets ? offsetCount * 4 : 0) +
        (constantSize ? 0 : count * sizeWidth) +
        timingCount * 20 +
        compositionCount * 8 +
        syncBytes +
        (retainedCount === count ? 0 : retainedCount * 4);
    budget.reserveBytes(byteLength, 'MP4 compact sample tables');
    const sizes: SampleSizes =
        constantSize ||
        (sizeWidth === 1
            ? new Uint8Array(wide!)
            : sizeWidth === 2
              ? new Uint16Array(wide!)
              : wide!);
    const retained = retainedCount === count ? undefined : new Uint32Array(retainedCount);
    const starts = new Uint32Array(timingCount);
    const decodeStarts = new Float64Array(timingCount);
    const deltas = new Uint32Array(timingCount);
    const durations = new Uint32Array(timingCount);
    const compositionStarts = composition ? new Uint32Array(compositionCount) : undefined;
    const compositionOffsets = composition
        ? compositionVersion === 1
            ? new Int32Array(compositionCount)
            : new Uint32Array(compositionCount)
        : undefined;
    const syncFlags = sync ? new Uint8Array(syncBytes) : undefined;
    let covered = 0;
    let decode = 0;
    let previousDuration = Math.max(1, Math.round(timescale / 1000));
    await inSteps(timingCount, (start, end) => {
        let timed = covered;
        let ticks = decode;
        let previous = previousDuration;
        for (let run = start; run < end; run++) {
            let runCount = view.getUint32(timing.offset + 16 + run * 8);
            if (runCount > count - timed) {
                // Only a final run may overclaim: every sample before its end keeps the timing the
                // table gives it.
                if (!(!options.strict && run === timingCount - 1))
                    malformedInput('stts covers more samples than the track');
                options.timingExcess(runCount - (count - timed));
                runCount = count - timed;
            }

            const delta = view.getUint32(timing.offset + 20 + run * 8);
            starts[run] = timed;
            decodeStarts[run] = ticks;
            deltas[run] = delta;
            durations[run] = delta || (options.instants ? 0 : previous);
            if (runCount && durations[run]) previous = durations[run]!;
            timed += runCount;
            ticks += runCount * delta;
            if (!Number.isSafeInteger(ticks))
                malformedInput('stts decode time exceeds exact integer range');
        }
        covered = timed;
        decode = ticks;
        previousDuration = previous;
    });
    if (covered < count && covered > 0 && !options.strict) {
        // A table that times only the first samples: the rest continue its last duration, as ffmpeg
        // reads them.
        options.timingShort(count - covered);
        covered = count;
    }
    if (!(covered === count)) malformedInput(`stts covers ${covered}/${count} samples`);
    covered = 0;
    await inSteps(compositionCount, (start, end) => {
        let timed = covered;
        for (let run = start; run < end; run++) {
            let runCount = view.getUint32(composition!.offset + 16 + run * 8);
            if (runCount > count - timed) {
                if (options.strict) malformedInput('ctts covers more samples than the track');
                if (timed < count || runCount > 0)
                    options.compositionExcess(runCount - (count - timed));
                runCount = count - timed;
            }
            compositionStarts![run] = timed;
            compositionOffsets![run] =
                compositionVersion === 1
                    ? view.getInt32(composition!.offset + 20 + run * 8)
                    : view.getUint32(composition!.offset + 20 + run * 8);
            timed += runCount;
        }
        covered = timed;
    });
    if (!(!composition || covered === count))
        malformedInput(`ctts covers ${covered}/${count} samples`);
    for (const table of sync && partialSync ? [sync, partialSync] : sync ? [sync] : []) {
        const entries = u32(table.offset + 12);
        budget.checkSamples(entries, 'MP4 table entries');
        if (!(16 + entries * 4 <= table.size))
            malformedInput(`${table.type} table exceeds its box`);
        let previousSync = 0;
        let ignored = 0;
        await inSteps(entries, (start, end) => {
            for (let entry = start; entry < end; entry++) {
                const sample = view.getUint32(table.offset + 16 + entry * 4);
                if (!(sample > previousSync && sample <= count)) {
                    if (options.strict)
                        malformedInput(
                            `${table.type} entries must increase within the sample count`,
                        );
                    ignored++;
                    continue;
                }
                syncFlags![(sample - 1) >>> 3]! |= 1 << ((sample - 1) & 7);
                previousSync = sample;
            }
        });
        if (ignored) options.syncIgnored(table.type, ignored);
    }
    if (sync && tables.preRoll)
        forEachGroupedSample(view, tables.preRoll, count, member => {
            syncFlags![(member - 1) >>> 3]! |= 1 << ((member - 1) & 7);
        });
    // Samples outside the media are left out: the index keeps the positions of the others.
    sample = 0;
    let layoutRun = 0;
    let retainedPosition = 0;
    const keepChunks = (from: number): number => {
        let at = sample;
        let run = layoutRun;
        let kept = retainedPosition;
        let chunk = from;
        let nextRun = run + 1 < layoutCount ? runFirstChunk[run + 1]! : chunkCount;
        let samplesInChunk = runSamples[run]!;
        for (; chunk < chunkCount && chunk - from < STEP && at - sample < STEP; chunk++) {
            if (chunk >= nextRun) {
                while (chunk >= nextRun) {
                    run++;
                    nextRun = run + 1 < layoutCount ? runFirstChunk[run + 1]! : chunkCount;
                }
                samplesInChunk = runSamples[run]!;
            }
            const endSample = at + samplesInChunk;
            let cursor = chunkOffsets[chunk]!;
            for (let index = at; index < endSample; index++) {
                const size = typeof sizes === 'number' ? sizes : sizes[index]!;
                if (options.fitsMedia(cursor, size)) retained![kept++] = index;
                cursor += size;
            }
            at = endSample;
        }
        sample = at;
        layoutRun = run;
        retainedPosition = kept;
        return chunk;
    };
    if (retained) await overChunks(keepChunks);
    // The presentation range and order, one timing and composition run at a time (one sample at a
    // time when samples past the end of the input were left out), in synchronous steps like the
    // scans above; shiftedSeconds() with what it works out per call worked out once. An index of
    // tables a summary described takes the presentation it found.
    const shiftTicks = shift * timescale;
    const wholeShift = Math.round(shiftTicks);
    const pass: PresentPass = {
        starts,
        decodeStarts,
        deltas,
        durations,
        compositionStarts,
        compositionOffsets,
        retained,
        sizes,
        sync: syncFlags,
        count,
        kept: retainedCount,
        timescale,
        shift,
        wholeShift,
        exactShift: Math.abs(shiftTicks - wholeShift) < 1e-6,
        earliest: Infinity,
        latestEnd: -Infinity,
        previous: -Infinity,
        position: 0,
        timingRun: 0,
        compositionRun: 0,
        sorted: true,
        largest: retained ? 0 : maxSampleSize,
        allKeyframes: retained ? true : !sync || syncCount === count,
    };
    const known = retained ? undefined : options.presentation;
    if (known) {
        pass.earliest = known.first;
        pass.latestEnd = known.last;
        pass.sorted = known.sorted;
    } else
        for (let segments = 0; pass.position < retainedCount; segments += STEP) {
            if (segments > 0) await breathe();
            presentRuns(pass, segments, segments + STEP);
        }
    maxSampleSize = pass.largest;
    if (retained) options.missing(count - retainedCount, firstMissing);
    const index: ConstructorParameters<typeof ClassicSampleIndex> = [
        retainedCount,
        byteLength,
        maxSampleSize,
        pass.allKeyframes,
        pass.sorted,
        pass.earliest,
        pass.latestEnd,
        chunkOffsets,
        runFirstChunk,
        runSamples,
        runFirstSample,
        sizes,
        starts,
        decodeStarts,
        deltas,
        durations,
        compositionStarts,
        compositionOffsets,
        syncFlags,
        retained,
        timescale,
        shift,
        leastCompositionShift(compositionOffsets),
    ];
    return whole ? new ClassicSampleIndex(...index) : new SummaryIndex(prefix, ...index);
}

/**
 * Ticks decode times move earlier so the least (negative) composition offset becomes zero, as a
 * cslg shift would.
 */
export function leastCompositionShift(offsets: Int32Array | Uint32Array | undefined): number {
    if (!(offsets instanceof Int32Array)) return 0;
    let least = 0;
    for (let index = 0; index < offsets.length; index++)
        if (offsets[index]! < least) least = offsets[index]!;
    return -least;
}
