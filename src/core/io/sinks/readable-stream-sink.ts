import { MediaForgeError } from '../../errors/errors';
import type { Sink } from '../../model/types';
import {
    adoptOutputBuffer,
    copyOutputBytes,
    outputByteLength,
    outputByteLimit,
    outputError,
} from '../../bytes/output-data';
import { declareCopyingSink } from './copying-sinks';

export interface ReadableStreamSinkOptions {
    /** Maximum queued output bytes before producers wait (default 1 MiB). */
    readonly highWaterMark?: number;
    /**
     * Maximum total output bytes, including bytes already consumed; defaults to
     * Number.MAX_SAFE_INTEGER.
     */
    readonly maxBytes?: number;
}

interface DrainWaiter {
    resolve(): void;
    reject(reason: unknown): void;
}

/**
 * Output as a ReadableStream of byte chunks. The first write of a burst reaches the stream at once;
 * appends below 64 KiB that follow it in the same task are coalesced into chunks of up to 64 KiB,
 * queued after the task (a timer of zero delay) and on close(), so a copy that writes one packet at
 * a time does not make one chunk per packet.
 */
export class ReadableStreamSink implements Sink {
    readonly stream: ReadableStream<Uint8Array>;
    private static readonly BATCH_BYTES = 64 * 1024;

    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private readonly waiters: DrainWaiter[] = [];
    private failure: MediaForgeError | null = null;
    private readonly maxBytes: number;
    private writtenBytes = 0;
    private closed = false;
    private consumerCancelled = false;
    private readonly cancellation = new AbortController();
    private batch: Uint8Array<ArrayBuffer> | null = null;
    private batchUsed = 0;
    private flushScheduled = false;

    get signal(): AbortSignal {
        return this.cancellation.signal;
    }

    constructor(options: ReadableStreamSinkOptions = {}) {
        declareCopyingSink(this);
        let highWaterMark: number | undefined;
        let maxBytes: number | undefined;
        try {
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new Error();
            highWaterMark = options.highWaterMark;
            maxBytes = options.maxBytes;
        } catch {
            throw new MediaForgeError('expected ReadableStreamSink options', 'INPUT');
        }

        if (highWaterMark === undefined) highWaterMark = 1024 * 1024;
        this.maxBytes = outputByteLimit(maxBytes);
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'INPUT');
        }

        this.stream = new ReadableStream<Uint8Array>(
            {
                start: controller => {
                    this.controller = controller;
                },
                pull: () => {
                    this.releaseDrainsIfReady();
                },
                cancel: reason => {
                    this.consumerCancelled = true;
                    const abort =
                        reason === undefined
                            ? new MediaForgeError('Output stream was cancelled', 'ABORT')
                            : outputError(reason, 'Output stream was cancelled', 'ABORT');
                    this.fail(abort, false);
                    this.cancellation.abort(abort);
                },
            },
            {
                highWaterMark,
                size: chunk => chunk.byteLength,
            },
        );
    }

    write(data: Uint8Array): void {
        this.assertWritable();
        const count = outputByteLength(data);
        if (count === 0) return;
        if (count > this.maxBytes - this.writtenBytes)
            throw new MediaForgeError('output exceeds maxBytes', 'OOM');

        const burst = this.flushScheduled;
        if (!burst) this.scheduleFlush();
        if (count >= ReadableStreamSink.BATCH_BYTES || !burst) {
            this.flushBatch();
            const adopted = adoptOutputBuffer(data);
            this.enqueue(adopted ? new Uint8Array(adopted) : copyOutputBytes(data));
        } else {
            if (this.batch && count > this.batch.byteLength - this.batchUsed) this.flushBatch();
            if (!this.batch) {
                try {
                    this.batch = new Uint8Array(ReadableStreamSink.BATCH_BYTES);
                } catch {
                    throw new MediaForgeError('could not allocate output bytes', 'OOM');
                }
            }
            this.batch.set(data, this.batchUsed);
            this.batchUsed += count;
        }
        this.writtenBytes += count;
    }

    /** Ends the current burst after this task: its coalesced appends are queued then. */
    private scheduleFlush(): void {
        this.flushScheduled = true;
        setTimeout(() => {
            this.flushScheduled = false;
            if (this.failure !== null || this.closed) return;
            try {
                this.flushBatch();
            } catch {}
        }, 0);
    }

    private enqueue(chunk: Uint8Array): void {
        try {
            this.controller.enqueue(chunk);
        } catch (error) {
            throw this.fail(error, false);
        }
    }

    /**
     * Queues the coalesced appends as one chunk. A batch at least half full is handed to the
     * reader; a shorter one is copied out, so a queued chunk never holds more than twice its bytes.
     */
    private flushBatch(): void {
        if (!this.batch || this.batchUsed === 0) return;
        const used = this.batchUsed;
        this.batchUsed = 0;
        if (used * 2 < this.batch.byteLength) {
            this.enqueue(this.batch.slice(0, used));
            return;
        }
        const chunk = this.batch.subarray(0, used);
        this.batch = null;
        this.enqueue(chunk);
    }

    drain(): Promise<void> {
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.closed || (this.controller.desiredSize ?? 0) > 0) return Promise.resolve();
        return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    async close(): Promise<void> {
        if (this.failure !== null) throw this.failure;
        if (this.closed) return;
        this.flushBatch();
        this.closed = true;
        try {
            this.controller.close();
        } catch (error) {
            throw this.fail(error, false);
        }
        this.resolveWaiters();
    }

    async abort(reason?: unknown): Promise<void> {
        if (this.closed) return;
        this.fail(
            reason ?? new MediaForgeError('Output stream was aborted', 'ABORT'),
            !this.consumerCancelled,
        );
    }

    private assertWritable(): void {
        if (this.failure !== null) throw this.failure;
        if (this.closed) throw new MediaForgeError('output stream is already closed', 'IO');
    }

    private releaseDrainsIfReady(): void {
        if (this.failure !== null) {
            this.rejectWaiters(this.failure);
        } else if (this.closed || (this.controller.desiredSize ?? 0) > 0) {
            this.resolveWaiters();
        }
    }

    private fail(reason: unknown, notifyReader: boolean): MediaForgeError {
        this.failure ??= outputError(reason, 'output stream failed');
        const failure = this.failure;
        this.rejectWaiters(failure);
        if (notifyReader && !this.closed) {
            try {
                this.controller.error(failure);
            } catch {}
        }
        return failure;
    }

    private resolveWaiters(): void {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter.resolve();
    }

    private rejectWaiters(reason: unknown): void {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter.reject(reason);
    }
}
