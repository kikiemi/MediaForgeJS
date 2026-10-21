import {
    CONTROL_BYTES,
    ControlBlock,
    type FrameJob,
    FrameJobRunner,
    JOB_DONE,
    JOB_QUEUED,
} from './frame-job';
import type { FrameWorkerMessage } from './frame-worker';
import { frameWorker } from './frame-worker-url';
import { type KernelArena, kernelModule, SCRATCH_BYTES } from './kernels';
import type { Picture } from './picture';
import type { SliceDecoder } from './slice-decoder';

interface WorkerHandle {
    post(message: FrameWorkerMessage): void;
    terminate(): void;
}

/** A worker of a closed decoder, and the memory it still holds. */
interface IdleWorker {
    readonly handle: WorkerHandle;
    readonly memory: WebAssembly.Memory;
}

/**
 * Workers of closed decoders, kept for the next decoder: a new worker compiles the decoder's code
 * again before it runs at full speed. They end after a minute unused.
 */
const idle: IdleWorker[] = [];
const IDLE_MS = 60000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A worker keeps the memory of the decoders it served until its own heap is collected, which an
 * idle worker seldom does. The memory of a closed decoder that grew past `keptMemoryBytes` is kept
 * for the next threaded decoder with the workers that hold it, which serve only that memory;
 * workers holding another one end, and so do the workers of a memory not kept (an idle one would
 * hold it on, one more memory for each decoder).
 */
let kept: KernelArena | undefined;

/**
 * The number of the next job in each memory: a stale offer of a closed decoder's job never names a
 * later one's.
 */
const nextJobs = new WeakMap<WebAssembly.Memory, number>();

function retire(workers: WorkerHandle[], arena: KernelArena): void {
    if (arena.buffer.byteLength <= keptMemoryBytes) {
        for (const worker of workers.splice(0)) worker.terminate();
        return;
    }
    keep(arena);
    const memory = arena.memory;
    for (const worker of workers) worker.post({ type: 'release' });
    idle.push(...workers.splice(0).map(handle => ({ handle, memory })));
    while (idle.length > 8) idle.shift()!.handle.terminate();
    clearTimeout(idleTimer);
    const timer = setTimeout(() => {
        for (const worker of idle.splice(0)) worker.handle.terminate();
        kept = undefined;
    }, IDLE_MS);
    // Node keeps the process alive for a pending timer unless it is unreferenced.
    (timer as { unref?(): void }).unref?.();
    idleTimer = timer;
}

/**
 * Keeps `arena` for the next threaded decoder and ends the idle workers holding another large
 * memory.
 */
function keep(arena: KernelArena): void {
    kept = arena;
    for (let index = idle.length - 1; index >= 0; index--) {
        const worker = idle[index]!;
        if (worker.memory !== arena.memory) {
            idle.splice(index, 1);
            worker.handle.terminate();
        }
    }
}

/** An idle worker already holding `memory`, for a decoder in it. */
function idleWorker(memory: WebAssembly.Memory): WorkerHandle | undefined {
    const index = idle.findIndex(worker => worker.memory === memory);
    return index < 0 ? undefined : idle.splice(index, 1)[0]!.handle;
}

/** Workers of closed decoders waiting for the next one. */
export function idleFrameWorkers(): number {
    return idle.length;
}

/**
 * The memory a closed decoder kept, cleared, for a new decoder on frame threads (whose workers hold
 * it already), or null when none is kept.
 */
export function keptKernelArena(): KernelArena | null {
    const arena = kept;
    kept = undefined;
    arena?.clear();
    return arena ?? null;
}

interface NodeWorker {
    postMessage(message: unknown): void;
    terminate(): unknown;
    unref(): void;
    on(event: 'error', listener: (error: unknown) => void): void;
}

interface HostGlobals {
    process?: { getBuiltinModule?(name: string): unknown };
    navigator?: { hardwareConcurrency?: number };
    crossOriginIsolated?: boolean;
}

let maximumWorkers: number | undefined;
let minimumMacroblocks = 1000;
let warmupPictures = 16;

/** Bytes of decoder memory past which a closed decoder's memory (and workers) are kept. */
let keptMemoryBytes = 0;

/**
 * Frame threading of decoders created afterwards: `workers` per decoder (0 decodes on the calling
 * thread; by default one less than the host's hardware concurrency, at most 8) for pictures of at
 * least `macroblocks` macroblocks (default 1000, about 640x400). The first `warmup` pictures
 * (default 16) after the decoder starts or is reset decode on the calling thread, so the first
 * frames (a thumbnail, a seek) leave without the threads' latency. A closed decoder whose memory
 * grew past `keptMemory` bytes (default 0, any) leaves it and its workers to the next one; the
 * workers of a smaller memory end.
 */
export function setH264Threads(options: {
    readonly workers?: number;
    readonly macroblocks?: number;
    readonly warmup?: number;
    readonly keptMemory?: number;
}): void {
    maximumWorkers = options.workers;
    minimumMacroblocks = options.macroblocks ?? 1000;
    warmupPictures = options.warmup ?? 16;
    keptMemoryBytes = options.keptMemory ?? 0;
}

/** Pictures a threaded decoder decodes on the calling thread after it starts or is reset. */
export function threadWarmup(): number {
    return warmupPictures;
}

/** Whether pictures of `macroblocks` macroblocks are worth decoding on frame threads. */
export function threadedSize(macroblocks: number): boolean {
    return macroblocks >= minimumMacroblocks;
}

function workerCount(): number {
    if (maximumWorkers !== undefined) return maximumWorkers;
    const cores = (globalThis as HostGlobals).navigator?.hardwareConcurrency ?? 1;
    return Math.max(0, Math.min(8, cores - 1));
}

/**
 * Whether this host can run frame threads: frame workers of the build (Node worker_threads, or
 * browser workers) and memory shared with them, which browsers offer to cross-origin isolated
 * pages.
 */
export function threadsAvailable(): boolean {
    const host = globalThis as HostGlobals;
    return (
        workerCount() > 0 &&
        frameWorker !== null &&
        typeof SharedArrayBuffer === 'function' &&
        host.crossOriginIsolated !== false &&
        (typeof host.process?.getBuiltinModule === 'function'
            ? frameWorker.node !== null
            : frameWorker.browser !== null)
    );
}

/** Whether Atomics.wait may block this thread (not on a browser's main thread). */
function mayBlock(): boolean {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
        return true;
    } catch {
        return false;
    }
}

function spawn(): WorkerHandle | null {
    const host = globalThis as HostGlobals;
    const threads = host.process?.getBuiltinModule?.('node:worker_threads') as
        { Worker: new (url: URL) => NodeWorker } | undefined;
    try {
        if (threads && frameWorker?.node) {
            const worker = new threads.Worker(frameWorker.node());

            // A worker that fails to start leaves its jobs queued; the decoding thread takes them.
            worker.on('error', () => undefined);
            worker.unref();
            return {
                post: message => worker.postMessage(message),
                terminate: () => void worker.terminate(),
            };
        }
        if (!threads && frameWorker?.browser) {
            const worker = frameWorker.browser();
            worker.onerror = () => undefined;
            return {
                post: message => worker.postMessage(message),
                terminate: () => worker.terminate(),
            };
        }
    } catch {
        // No worker could be created: jobs run on the decoding thread.
    }
    return null;
}

interface PendingJob {
    readonly job: FrameJob;
    /** Every picture the job writes or reads. */
    readonly uses: readonly Picture[];
}

/**
 * Frame-level threading of one decoder: pictures decode as jobs on workers sharing the kernel
 * memory, each waiting for the rows of its references it reads. The decoding thread runs a job
 * itself when it needs one no worker has started, in decoding order, so the jobs complete even
 * without workers.
 */
export class FrameThreads {
    private readonly workers: WorkerHandle[] = [];
    private readonly pending: PendingJob[] = [];
    /** The latest job using each picture. */
    private readonly lastUse = new Map<Picture, number>();
    private readonly control: ControlBlock;
    private readonly runner: FrameJobRunner;
    private readonly arena: KernelArena;
    private nextJob: number;
    /** Jobs in flight at most: the workers and the decoding thread. */
    readonly limit: number;

    private constructor(
        arena: KernelArena,
        slices: SliceDecoder,
        count: number,
        module: WebAssembly.Module,
    ) {
        this.arena = arena;
        this.nextJob = nextJobs.get(arena.memory) ?? 0;
        const control = arena.allocate(CONTROL_BYTES);
        this.control = new ControlBlock(arena.buffer, control, mayBlock());
        this.runner = new FrameJobRunner(arena, this.control, slices);
        for (let i = 0; i < count; i++) {
            const worker = idleWorker(arena.memory) ?? spawn();
            if (!worker) break;
            worker.post({
                type: 'init',
                memory: arena.memory,
                module,
                scratch: arena.allocate(SCRATCH_BYTES),
                control,
            });
            this.workers.push(worker);
        }
        this.limit = this.workers.length + 1;
    }

    /**
     * Threads for a decoder whose pictures live in the shared `arena`, or null when the host cannot
     * run them.
     */
    static create(arena: KernelArena, slices: SliceDecoder): FrameThreads | null {
        const module = kernelModule(true);
        if (!arena.shared || !threadsAvailable() || !module) return null;
        const threads = new FrameThreads(arena, slices, workerCount(), module);
        if (threads.workers.length) return threads;
        threads.close();
        return null;
    }

    /**
     * Numbers `job` and offers it to every worker; the first one free takes it. The caller has
     * reset the progress of its picture.
     */
    submit(job: Omit<FrameJob, 'job'>, uses: readonly Picture[]): number {
        const number = this.nextJob++;
        const numbered: FrameJob = { ...job, job: number };
        this.control.queue(number);
        this.pending.push({ job: numbered, uses });
        for (const picture of uses) this.lastUse.set(picture, number);
        for (const worker of this.workers) worker.post({ type: 'job', job: numbered });
        return number;
    }

    /** The last pending job writing `picture`, or -1. */
    lastJobOf(picture: Picture): number {
        for (let i = this.pending.length - 1; i >= 0; i--) {
            if (this.pending[i].uses[0] === picture) return this.pending[i].job.job;
        }
        return -1;
    }

    /**
     * Whether one of the last `limit` jobs uses `picture`. After throttle() the older ones are
     * done, so pictures are reused in the same order however fast the workers are.
     */
    busy(picture: Picture): boolean {
        return (this.lastUse.get(picture) ?? -1) > this.nextJob - this.limit;
    }

    /** Forgets pictures the decoder no longer holds. */
    forget(picture: Picture): void {
        this.lastUse.delete(picture);
    }

    /**
     * Collects the finished jobs at the head of the queue, passing their warnings on in decoding
     * order.
     */
    collect(warn: (message: string) => void): void {
        const control = this.control;
        while (this.pending.length && control.state(this.pending[0].job.job) === JOB_DONE) {
            for (const message of control.collect(this.pending.shift()!.job.job)) warn(message);
        }
    }

    /**
     * Completes the pending job at `index`: runs every earlier job no worker has started, then
     * waits for it.
     */
    private complete(index: number): void {
        const control = this.control;
        for (let i = 0; i <= index; i++) {
            const number = this.pending[i].job.job;
            if (control.state(number) === JOB_QUEUED && control.claim(number))
                this.runner.run(this.pending[i].job);
        }
        control.waitDone(this.pending[index].job.job);
    }

    /**
     * Makes room for another job while `limit` jobs are pending: runs the first job no worker has
     * started, or waits for the oldest.
     */
    throttle(warn: (message: string) => void): void {
        this.collect(warn);
        const control = this.control;
        while (this.pending.length >= this.limit) {
            const queued = this.pending.find(
                pending => control.state(pending.job.job) === JOB_QUEUED,
            );
            if (queued && control.claim(queued.job.job)) this.runner.run(queued.job);
            else if (!queued) control.waitDone(this.pending[0].job.job);
            this.collect(warn);
        }
    }

    /** Completes the jobs writing `picture` (the later field's job follows the earlier one's). */
    awaitWrites(picture: Picture, warn: (message: string) => void): void {
        for (let i = this.pending.length - 1; i >= 0; i--) {
            if (this.pending[i].uses[0] === picture) {
                this.complete(i);
                break;
            }
        }
        this.collect(warn);
    }

    /** Completes every job writing or reading `picture`, before the decoding thread changes it. */
    awaitUsers(picture: Picture, warn: (message: string) => void): void {
        let last = -1;
        for (let i = 0; i < this.pending.length; i++)
            if (this.pending[i].uses.includes(picture)) last = i;
        if (last >= 0) this.complete(last);
        for (let i = 0; i < last; i++) {
            if (this.pending[i].uses.includes(picture))
                this.control.waitDone(this.pending[i].job.job);
        }
        this.collect(warn);
    }

    /** Completes every pending job. */
    drain(warn: (message: string) => void): void {
        if (this.pending.length) this.complete(this.pending.length - 1);
        for (let i = 0; i < this.pending.length; i++)
            this.control.waitDone(this.pending[i].job.job);
        this.collect(warn);
    }

    /**
     * Drops the queued jobs, waits for those workers started (the memory may serve another decoder
     * next) and hands the workers on to later decoders.
     */
    close(): void {
        for (const pending of this.pending) this.control.cancel(pending.job.job);
        for (const pending of this.pending) this.control.waitDone(pending.job.job);
        this.pending.length = 0;
        nextJobs.set(this.arena.memory, this.nextJob);
        retire(this.workers, this.arena);
    }
}
