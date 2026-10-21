import { BitReader } from './bit-reader';
import type { DeblockInput } from './deblock';
import type { Pps, SliceHeader, Sps } from './headers';
import type { KernelMemory } from './kernels';
import { Picture, PROGRESS_DONE, type RefEntry } from './picture';
import { buildScalingTables, type ScalingTables, type SliceContext } from './slice-context';
import { SliceDecoder } from './slice-decoder';
import { PICT_FRAME } from './tables';

/** A picture in kernel memory as another thread addresses it. */
export interface PictureSlot {
    readonly id: number;
    readonly base: number;
    readonly mbWidth: number;
    readonly mbHeight: number;
    readonly chromaFormat: number;
}

/** One reference list entry by picture id. */
export interface EntryJob {
    readonly picture: number;
    /** RefEntry.id. */
    readonly id: number;
    readonly parity: number;
    readonly poc: number;
    readonly longTerm: boolean;
}

type ListsJob = readonly [readonly EntryJob[], readonly EntryJob[]];

/**
 * One slice of a picture job: its SliceContext by picture ids, and its RBSP from the first
 * slice_data() bit.
 */
export interface SliceJob {
    readonly header: SliceHeader;
    readonly sps: Sps;
    readonly pps: Pps;
    readonly sliceNum: number;
    readonly refList: ListsJob;
    readonly fieldRefList: readonly [ListsJob, ListsJob] | null;
    /**
     * Scaling lists of resolveScalingLists, and a key naming them for the tables built from them.
     */
    readonly scalingKey: number;
    readonly scalingLists: Uint8Array[] | null;
    readonly implicitWeights: Int8Array | null;
    readonly implicitWeightsField: readonly [Int8Array, Int8Array] | null;
    readonly distScale: Int32Array;
    readonly distScaleField: readonly [Int32Array, Int32Array] | null;
    readonly colParity: number;
    readonly colFieldOffset: number;
    readonly rbsp: Uint8Array<ArrayBuffer>;
    readonly pos: number;
    readonly end: number;
    readonly byteLength: number;
}

/** Decoding of every slice of one picture or field, then its concealment and deblocking. */
export interface FrameJob {
    /** Sequence number; the job's state lives at job % JOB_SLOTS of the control block. */
    readonly job: number;
    readonly picture: PictureSlot;
    /**
     * Every other picture the job reads: references, the colocated picture and the concealment
     * source.
     */
    readonly references: readonly PictureSlot[];
    readonly structure: number;
    readonly mbaff: boolean;
    readonly slices: readonly SliceJob[];
    /** Picture id to copy undecoded macroblocks from, or -1 for grey. */
    readonly concealSource: number;
    /** A job that must finish first (the first field of the same frame), or -1. */
    readonly after: number;
    /**
     * Whether the job completes its picture: false for a first field, whose frame is complete
     * (PROGRESS_DONE) only once the second field or the decoding thread completes it.
     */
    readonly completes: boolean;
}

/** Job states in the control block. */
const JOB_FREE = 0;
export const JOB_QUEUED = 1;
const JOB_RUNNING = 2;
export const JOB_DONE = 3;
const JOB_SLOTS = 32;

/** UTF-16 units of warning text kept per job. */
const WARNING_UNITS = 1024;

/**
 * Control block of a threaded decoder in kernel memory, as Int32 elements: job number and state per
 * slot, then per slot the length and text of the warnings the job raised.
 */
export const CONTROL_BYTES = JOB_SLOTS * 8 + JOB_SLOTS * (4 + WARNING_UNITS * 2);

export class ControlBlock {
    private readonly jobs: Int32Array;
    private readonly states: Int32Array;
    private readonly lengths: Int32Array;
    private readonly text: Uint16Array;

    constructor(
        buffer: ArrayBufferLike,
        address: number,
        /** Whether this thread may block in Atomics.wait (not a browser main thread). */
        readonly canBlock: boolean,
    ) {
        this.jobs = new Int32Array(buffer, address, JOB_SLOTS);
        this.states = new Int32Array(buffer, address + JOB_SLOTS * 4, JOB_SLOTS);
        this.lengths = new Int32Array(buffer, address + JOB_SLOTS * 8, JOB_SLOTS);
        this.text = new Uint16Array(buffer, address + JOB_SLOTS * 12, JOB_SLOTS * WARNING_UNITS);
    }

    /** Publishes a job as queued; a thread claims it with claim(). */
    queue(job: number): void {
        const slot = job % JOB_SLOTS;
        this.jobs[slot] = job;
        this.lengths[slot] = 0;
        Atomics.store(this.states, slot, JOB_QUEUED);
    }

    /** Takes a queued job for this thread; false when another thread has. */
    claim(job: number): boolean {
        const slot = job % JOB_SLOTS;
        return (
            this.jobs[slot] === job &&
            Atomics.compareExchange(this.states, slot, JOB_QUEUED, JOB_RUNNING) === JOB_QUEUED
        );
    }

    state(job: number): number {
        const slot = job % JOB_SLOTS;
        const state = Atomics.load(this.states, slot);
        return this.jobs[slot] === job ? state : JOB_FREE;
    }

    /** Marks a queued job done without running it. */
    cancel(job: number): void {
        const slot = job % JOB_SLOTS;
        if (
            this.jobs[slot] === job &&
            Atomics.compareExchange(this.states, slot, JOB_QUEUED, JOB_DONE) === JOB_QUEUED
        )
            Atomics.notify(this.states, slot);
    }

    /** Stores the job's warnings and marks it done. */
    finish(job: number, warnings: readonly string[]): void {
        const slot = job % JOB_SLOTS;
        const text = warnings.join('\n').slice(0, WARNING_UNITS);
        for (let i = 0; i < text.length; i++)
            this.text[slot * WARNING_UNITS + i] = text.charCodeAt(i);
        this.lengths[slot] = text.length;
        Atomics.store(this.states, slot, JOB_DONE);
        Atomics.notify(this.states, slot);
    }

    /** Warnings of a finished job, and frees its slot. */
    collect(job: number): string[] {
        const slot = job % JOB_SLOTS;
        const length = this.lengths[slot];
        let text = '';
        for (let i = 0; i < length; i++)
            text += String.fromCharCode(this.text[slot * WARNING_UNITS + i]);
        Atomics.store(this.states, slot, JOB_FREE);
        return text ? text.split('\n') : [];
    }

    /** Returns once the job is done (or already collected). */
    waitDone(job: number): void {
        const slot = job % JOB_SLOTS;
        for (;;) {
            const state = Atomics.load(this.states, slot);
            if (state === JOB_DONE || state === JOB_FREE || this.jobs[slot] !== job) return;
            if (this.canBlock) Atomics.wait(this.states, slot, state, 100);
        }
    }
}

/** Returns once `progress` exceeds `row`. */
function waitProgress(progress: Int32Array, row: number, canBlock: boolean): void {
    for (;;) {
        const value = Atomics.load(progress, 0);
        if (value > row) return;
        if (canBlock) Atomics.wait(progress, 0, value, 100);
    }
}

function publishProgress(progress: Int32Array, rows: number): void {
    if (rows <= Atomics.load(progress, 0)) return;
    Atomics.store(progress, 0, rows);
    Atomics.notify(progress, 0);
}

/**
 * Runs frame jobs on one thread: a worker, or the main thread when it takes a job no worker has
 * started. Pictures are views of the shared kernel memory; waits on references follow their
 * decoding progress.
 */
export class FrameJobRunner {
    private readonly br = new BitReader();
    private readonly views = new Map<number, Picture>();
    private scalingKey = -1;
    private scaling: ScalingTables | null = null;

    constructor(
        private readonly memory: KernelMemory,
        readonly control: ControlBlock,
        private readonly slices: SliceDecoder = new SliceDecoder(),
    ) {
        slices.useKernels(memory);
    }

    private view(slot: PictureSlot): Picture {
        const known = this.views.get(slot.id);
        if (known && known.base === slot.base) return known;
        const picture = new Picture(
            slot.id,
            slot.mbWidth,
            slot.mbHeight,
            slot.chromaFormat,
            this.memory,
            slot.base,
        );
        this.views.set(slot.id, picture);
        return picture;
    }

    private tables(slice: SliceJob): ScalingTables {
        if (this.scalingKey !== slice.scalingKey || !this.scaling) {
            this.scalingKey = slice.scalingKey;
            this.scaling = buildScalingTables(slice.scalingLists);
        }
        return this.scaling;
    }

    /**
     * Decodes the job's picture and marks the job done with the warnings it raised; the picture's
     * progress ends at PROGRESS_DONE even when decoding fails. The caller has claimed the job.
     */
    run(job: FrameJob): void {
        const warnings: string[] = [];
        const control = this.control;
        const slices = this.slices;
        let picture: Picture | null = null;
        try {
            picture = this.view(job.picture);
            const own = picture;
            const pictures = new Map<number, Picture>([[picture.id, picture]]);
            for (const slot of job.references) pictures.set(slot.id, this.view(slot));
            for (const id of this.views.keys()) if (!pictures.has(id)) this.views.delete(id);
            if (job.after >= 0) control.waitDone(job.after);
            if (
                slices.mbWidth !== picture.mbWidth ||
                slices.mbHeight !== picture.mbHeight ||
                slices.chromaFormat !== picture.chromaFormat
            )
                slices.configure(picture.mbWidth, picture.mbHeight, picture.chromaFormat);

            const deblock: DeblockInput = {
                picture,
                mbaff: job.mbaff,
                structure: job.structure,
                kernels: this.memory.kernels,
            };

            const canBlock = control.canBlock;
            slices.startPicture(picture, deblock);
            slices.refWait = (reference, row) => {
                if (reference !== own)
                    waitProgress(
                        reference.progress,
                        row < reference.mbHeight - 1 ? row : PROGRESS_DONE - 1,
                        canBlock,
                    );
            };
            slices.onRows =
                job.structure === PICT_FRAME && !job.mbaff
                    ? rows => publishProgress(own.progress, rows)
                    : null;
            const entry = (data: EntryJob): RefEntry => {
                const pic = pictures.get(data.picture)!;
                return {
                    pic,
                    parity: data.parity,
                    poc: data.poc,
                    longTerm: data.longTerm,
                    id: data.id,
                    luma: pic.lumaPlane(data.parity),
                    cb: pic.chromaPlane(data.parity, false),
                    cr: pic.chromaPlane(data.parity, true),
                };
            };

            const lists = (data: ListsJob): [RefEntry[], RefEntry[]] => [
                data[0].map(entry),
                data[1].map(entry),
            ];
            for (const slice of job.slices) {
                const ctx: SliceContext = {
                    header: slice.header,
                    sps: slice.sps,
                    pps: slice.pps,
                    sliceNum: slice.sliceNum,
                    picture,
                    structure: job.structure,
                    mbaff: job.mbaff,
                    refList: lists(slice.refList),
                    fieldRefList: slice.fieldRefList
                        ? [lists(slice.fieldRefList[0]), lists(slice.fieldRefList[1])]
                        : null,
                    scaling: this.tables(slice),
                    implicitWeights: slice.implicitWeights,
                    implicitWeightsField: slice.implicitWeightsField,
                    distScale: slice.distScale,
                    distScaleField: slice.distScaleField,
                    colParity: slice.colParity,
                    colFieldOffset: slice.colFieldOffset,
                };

                const br = this.br;
                br.data = slice.rbsp;
                br.pos = slice.pos;
                br.end = slice.end;
                br.byteLength = slice.byteLength;
                const result = slices.decodeSlice(ctx, br);
                if (result.error)
                    warnings.push(
                        `${result.error}; ${result.decoded} macroblocks decoded before concealment`,
                    );
            }

            const source =
                job.concealSource >= 0 ? (pictures.get(job.concealSource) ?? null) : null;
            const missing = slices.concealMissing(job.structure, source);
            if (missing)
                warnings.push(`${missing} macroblocks were missing and have been concealed`);
            slices.finishPicture();
        } catch (failure) {
            warnings.push(
                `picture decoding failed: ` +
                    `${failure instanceof Error ? failure.message : String(failure)}`,
            );
        } finally {
            slices.refWait = null;
            slices.onRows = null;
            if (picture && job.completes) publishProgress(picture.progress, PROGRESS_DONE);
            control.finish(job.job, warnings);
        }
    }
}
