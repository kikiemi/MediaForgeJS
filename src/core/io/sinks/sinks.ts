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
import { declareDrainReady } from './sink-backpressure';
import {
    typedArrayBuffer as buffer,
    typedArrayOffset as byteOffset,
} from '../../bytes/typed-array';

export interface PositionedWriter {
    write(data: { type: 'write'; position: number; data: ArrayBuffer }): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
}

export interface MemorySinkOptions {
    /** Maximum stored output bytes; defaults to Number.MAX_SAFE_INTEGER. */
    maxBytes?: number;
    /**
     * Moves every this many written bytes out of ArrayBuffers into an internal Blob, which the host
     * may keep outside the JavaScript heap (browsers page large Blobs to disk). toUint8Array() is
     * unavailable once bytes have moved.
     */
    blobPartBytes?: number;
}

/**
 * Blob results keep at most this many output bytes in ArrayBuffers before moving them into the
 * Blob.
 */
export const BLOB_PART_BYTES = 64 * 1024 * 1024;

/** Buffers writes in memory; close() leaves the buffer readable and writable. */
export class MemorySink implements Sink {
    private chunks: ArrayBuffer[] = [];
    private ends: number[] = [];
    private length = 0;
    private slab: Uint8Array | null = null;
    private slabUsed = 0;
    private readonly maxBytes: number;
    private readonly blobPartBytes: number;
    /** Bytes before the retained chunks, already moved into `folded`. */
    private foldedBytes = 0;
    private folded: Blob | null = null;

    constructor(options: MemorySinkOptions = {}) {
        declareCopyingSink(this);
        let maxBytes: number | undefined;
        let blobPartBytes: number | undefined;
        try {
            if (!options || typeof options !== 'object') throw new Error();
            maxBytes = options.maxBytes;
            blobPartBytes = options.blobPartBytes;
        } catch {
            throw new MediaForgeError('expected MemorySink options', 'INPUT');
        }
        this.maxBytes = outputByteLimit(maxBytes);
        if (
            blobPartBytes !== undefined &&
            (!Number.isSafeInteger(blobPartBytes) || blobPartBytes < 1)
        )
            throw new MediaForgeError('blobPartBytes must be a positive safe integer', 'INPUT');
        this.blobPartBytes = blobPartBytes ?? Number.MAX_SAFE_INTEGER;
    }

    /** The retained chunks as views of their written bytes. */
    private views(): Uint8Array<ArrayBuffer>[] {
        return this.chunks.map(
            (chunk, index) =>
                new Uint8Array(
                    chunk,
                    0,
                    this.ends[index]! - (index > 0 ? this.ends[index - 1]! : this.foldedBytes),
                ),
        );
    }

    /** Moves the retained chunks into the Blob once they reach blobPartBytes. */
    private fold(): void {
        if (this.length - this.foldedBytes < this.blobPartBytes || typeof Blob !== 'function')
            return;
        try {
            this.folded = new Blob(this.folded ? [this.folded, ...this.views()] : this.views());
        } catch {
            throw new MediaForgeError('could not move output bytes into a Blob', 'OOM');
        }
        this.chunks = [];
        this.ends = [];
        this.slab = null;
        this.slabUsed = 0;
        this.foldedBytes = this.length;
    }

    /**
     * Small writes fill 4 KiB to 64 KiB slabs in place; a write that does not fit opens a new slab
     * sized for it. Handed-off writes of at least 16 KiB are kept as they are.
     */
    write(data: Uint8Array): void {
        const count = outputByteLength(data);
        if (count === 0) return;
        if (!Number.isSafeInteger(this.length + count))
            throw new MediaForgeError('output is too large', 'IO');
        if (count > this.maxBytes - this.length)
            throw new MediaForgeError('output exceeds maxBytes', 'OOM');

        const adopted = count >= 16 * 1024 ? adoptOutputBuffer(data) : undefined;
        if (adopted) {
            this.chunks.push(adopted);
            this.length += count;
            this.ends.push(this.length);
            this.slab = null;
            this.slabUsed = 0;
            this.fold();
            return;
        }

        const slab = this.slab;
        if (slab && count <= slab.byteLength - this.slabUsed) {
            slab.set(data, this.slabUsed);
            this.slabUsed += count;
            this.length += count;
            this.ends[this.ends.length - 1] = this.length;
            return;
        }

        const appended = slab ? slab.byteLength - this.slabUsed : 0;
        const remaining = count - appended;
        const sourceBuffer: ArrayBufferLike = buffer.call(data);
        const sourceStart: number = byteOffset.call(data);

        let next: Uint8Array<ArrayBuffer>;
        try {
            const slabBytes = Math.min(64 * 1024, Math.max(4096, this.length));
            const capacity = Math.min(
                this.maxBytes - this.length - appended,
                Math.max(remaining, slabBytes),
            );
            next = new Uint8Array(capacity);
            next.set(new Uint8Array(sourceBuffer, sourceStart + appended, remaining));
            if (appended > 0)
                slab!.set(new Uint8Array(sourceBuffer, sourceStart, appended), this.slabUsed);
        } catch {
            throw new MediaForgeError('could not allocate output bytes', 'OOM');
        }

        if (appended > 0) {
            this.length += appended;
            this.ends[this.ends.length - 1] = this.length;
        }

        this.chunks.push(next.buffer);
        this.slab = next;
        this.slabUsed = remaining;
        this.length += remaining;
        this.ends.push(this.length);
        this.fold();
    }

    get size(): number {
        return this.length;
    }

    async close(): Promise<void> {}

    patchAt(offset: number, data: Uint8Array): void {
        const count = outputByteLength(data);
        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > this.length ||
            count > this.length - offset
        ) {
            throw new MediaForgeError('patchAt range exceeds the bytes written', 'IO');
        }

        if (count === 0) return;
        const sourceBuffer: ArrayBufferLike = buffer.call(data);
        const sourceStart: number = byteOffset.call(data);

        if (offset < this.foldedBytes) {
            const within = Math.min(count, this.foldedBytes - offset);
            const folded = this.folded!;
            this.folded = new Blob([
                folded.slice(0, offset),
                copyOutputBytes(new Uint8Array(sourceBuffer, sourceStart, within)),
                folded.slice(offset + within),
            ]);
            if (within === count) return;
            this.patchAt(
                offset + within,
                new Uint8Array(sourceBuffer, sourceStart + within, count - within),
            );
            return;
        }

        let low = 0;
        let high = this.ends.length;
        while (low < high) {
            const mid = low + Math.floor((high - low) / 2);
            if (this.ends[mid]! <= offset) low = mid + 1;
            else high = mid;
        }

        let chunkStart = low === 0 ? this.foldedBytes : this.ends[low - 1]!;
        let sourceOffset = 0;
        for (let index = low; sourceOffset < count; index++) {
            const chunk = this.chunks[index]!;
            const inChunk = offset + sourceOffset - chunkStart;
            const size = Math.min(this.ends[index]! - chunkStart - inChunk, count - sourceOffset);
            new Uint8Array(chunk, inChunk, size).set(
                new Uint8Array(sourceBuffer, sourceStart + sourceOffset, size),
            );
            sourceOffset += size;
            chunkStart = this.ends[index]!;
        }
    }

    toBlob(mimeType: string): Blob {
        return new Blob(this.folded ? [this.folded, ...this.views()] : this.views(), {
            type: mimeType,
        });
    }

    toUint8Array(): Uint8Array<ArrayBuffer> {
        if (this.folded)
            throw new MediaForgeError('MemorySink output has moved into a Blob', 'IO', {
                hint: 'Read it with toBlob().',
            });
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (let index = 0; index < this.chunks.length; index++) {
            out.set(new Uint8Array(this.chunks[index]!, 0, this.ends[index]! - offset), offset);
            offset = this.ends[index]!;
        }
        return out;
    }
}

export class StreamSink implements Sink {
    private readonly writer: PositionedWriter;
    private readonly writeOutput: PositionedWriter['write'];
    private readonly closeOutput: PositionedWriter['close'];
    private readonly abortOutput: PositionedWriter['abort'];
    private pending: Promise<void> = Promise.resolve();
    private queuedBytes = 0;
    private readonly highWaterMark: number;
    private drainWaiters: Array<() => void> = [];
    private readonly failureWaiters = new Set<(error: MediaForgeError) => void>();
    private abortPromise: Promise<void> | null = null;
    private closePromise: Promise<void> | null = null;
    private closed = false;
    private appendPos = 0;
    private failure: MediaForgeError | null = null;
    private batch: Uint8Array<ArrayBuffer> | null = null;
    private batchUsed = 0;
    private batchPosition = 0;
    private static readonly BATCH_BYTES = 64 * 1024;

    constructor(writer: PositionedWriter, options?: { highWaterMark?: number }) {
        declareCopyingSink(this);
        // With a write in flight, drain() below the high-water mark neither waits nor flushes.
        declareDrainReady(
            this,
            () =>
                this.failure === null &&
                this.queuedBytes > 0 &&
                this.queuedBytes < this.highWaterMark,
        );
        try {
            this.writeOutput = writer.write;
            this.closeOutput = writer.close;
            this.abortOutput = writer.abort;
            if (
                typeof this.writeOutput !== 'function' ||
                typeof this.closeOutput !== 'function' ||
                (this.abortOutput !== undefined && typeof this.abortOutput !== 'function')
            )
                throw new Error();
        } catch {
            throw new MediaForgeError('writer must provide write() and close()', 'INPUT');
        }

        this.writer = writer;
        const highWaterMark = options?.highWaterMark ?? 8 * 1024 * 1024;
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'INPUT');
        }
        this.highWaterMark = highWaterMark;
    }

    private assertHealthy(): void {
        if (this.failure) throw this.failure;
    }

    private assertWritable(): void {
        this.assertHealthy();
        if (this.closePromise) throw new MediaForgeError('output sink is closing or closed', 'IO');
    }

    private fail(reason: unknown): MediaForgeError {
        if (!this.failure) this.failure = outputError(reason);
        for (const reject of this.failureWaiters) reject(this.failure);
        this.failureWaiters.clear();
        this.wakeDrainWaiters();
        return this.failure;
    }

    private async waitFor(pending: PromiseLike<void>): Promise<void> {
        let rejectWait: (error: MediaForgeError) => void = () => undefined;
        const failed = new Promise<never>((_resolve, reject) => {
            rejectWait = reject;
            if (this.failure) reject(this.failure);
            else this.failureWaiters.add(reject);
        });
        try {
            await Promise.race([Promise.resolve(pending), failed]);
            this.assertHealthy();
        } catch (error) {
            throw this.fail(error);
        } finally {
            this.failureWaiters.delete(rejectWait);
        }
    }

    /**
     * Queues a byte snapshot; callers await drain() to apply backpressure. Consecutive appends
     * below 64 KiB are coalesced into writes of up to 64 KiB while an earlier write is in flight:
     * an append that overflows the batch completes it, and the full batch is queued; a partial
     * batch is queued once the writer is idle (on drain() or when the earlier writes finish), and
     * patchAt(), done and close() queue it first.
     */
    write(data: Uint8Array): void {
        this.assertWritable();
        const count = outputByteLength(data);
        if (count === 0) return;
        if (!Number.isSafeInteger(this.appendPos + count))
            throw new MediaForgeError('output is too large', 'IO');

        const position = this.appendPos;
        this.appendPos += count;
        if (count >= StreamSink.BATCH_BYTES) {
            this.flushBatch();
            this.enqueueWrite(position, adoptOutputBuffer(data) ?? copyOutputBytes(data).buffer);
            return;
        }

        let rest = data;
        let filled = 0;
        const batch = this.batch;
        if (batch && count > batch.byteLength - this.batchUsed) {
            filled = batch.byteLength - this.batchUsed;
            const bytes = new Uint8Array(buffer.call(data), byteOffset.call(data), count);
            batch.set(bytes.subarray(0, filled), this.batchUsed);
            this.batchUsed += filled;
            this.flushBatch();
            rest = bytes.subarray(filled);
        }
        if (!this.batch) {
            try {
                this.batch = new Uint8Array(StreamSink.BATCH_BYTES);
            } catch {
                throw new MediaForgeError('could not allocate output bytes', 'OOM');
            }
        }

        if (this.batchUsed === 0) this.batchPosition = position + filled;
        this.batch.set(rest, this.batchUsed);
        this.batchUsed += count - filled;
    }

    /** Queues the batch: a full one as it is, with a new one for the next appends, else a copy. */
    private flushBatch(): void {
        if (!this.batch || this.batchUsed === 0) return;
        let chunk: ArrayBuffer;
        if (this.batchUsed === this.batch.byteLength) {
            chunk = this.batch.buffer;
            this.batch = null;
        } else chunk = this.batch.buffer.slice(0, this.batchUsed);
        this.batchUsed = 0;
        this.enqueueWrite(this.batchPosition, chunk);
    }

    patchAt(offset: number, data: Uint8Array): void {
        this.assertWritable();
        const count = outputByteLength(data);
        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > this.appendPos ||
            count > this.appendPos - offset
        ) {
            throw new MediaForgeError('patchAt range exceeds the bytes written', 'IO');
        }
        if (count === 0) return;
        this.flushBatch();
        this.enqueueWrite(offset, copyOutputBytes(data).buffer);
    }

    abort(reason?: unknown): Promise<void> {
        if (this.closed) return Promise.resolve();
        this.fail(reason ?? new MediaForgeError('Output sink was aborted', 'ABORT'));
        if (!this.abortPromise) {
            let resolveAbort: () => void = () => undefined;
            this.abortPromise = new Promise<void>(resolve => {
                resolveAbort = resolve;
            });
            try {
                Promise.resolve(this.abortOutput?.call(this.writer, reason)).then(
                    resolveAbort,
                    resolveAbort,
                );
            } catch {
                resolveAbort();
            }
        }
        return this.abortPromise;
    }

    drain(): Promise<void> {
        try {
            this.assertHealthy();
            if (this.queuedBytes === 0) this.flushBatch();
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.queuedBytes < this.highWaterMark) return Promise.resolve();
        return new Promise<void>(resolve => this.drainWaiters.push(resolve)).then(() =>
            this.assertHealthy(),
        );
    }

    close(): Promise<void> {
        if (!this.closePromise) {
            if (!this.failure) this.flushBatch();
            this.closePromise = this.waitFor(this.pending).then(async () => {
                this.assertHealthy();
                try {
                    await this.waitFor(this.closeOutput.call(this.writer));
                } catch (error) {
                    throw this.fail(error);
                }
                this.closed = true;
            });
        }
        return this.closePromise;
    }

    get done(): Promise<void> {
        if (!this.failure) this.flushBatch();
        return this.waitFor(this.pending);
    }

    private enqueueWrite(position: number, chunk: ArrayBuffer): void {
        this.queuedBytes += chunk.byteLength;
        this.pending = this.pending.then(async () => {
            try {
                if (!this.failure)
                    await this.waitFor(
                        this.writeOutput.call(this.writer, {
                            type: 'write',
                            position,
                            data: chunk,
                        }),
                    );
            } catch (error) {
                this.fail(error);
            } finally {
                this.queuedBytes -= chunk.byteLength;
                if (this.queuedBytes === 0 && !this.failure && !this.closePromise)
                    this.flushBatch();
                if (this.failure || this.queuedBytes < this.highWaterMark) this.wakeDrainWaiters();
            }
        });
    }

    private wakeDrainWaiters(): void {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters) waiter();
    }

    /** Opens a save-file picker and returns a StreamSink over the chosen file (browser only). */
    static async fromPicker(suggestedName: string): Promise<StreamSink> {
        const host = globalThis as {
            showSaveFilePicker?: (opts: Record<string, unknown>) => Promise<FileSystemFileHandle>;
        };
        if (typeof host.showSaveFilePicker !== 'function') {
            throw new MediaForgeError('This host has no save-file picker', 'IO', {
                hint: 'Download a Blob, or write to a WritableStream.',
            });
        }
        const handle = await host.showSaveFilePicker({ suggestedName });
        const writable = await handle.createWritable();
        return new StreamSink(writable);
    }

    /** Creates (truncating) an OPFS file and returns a StreamSink over it. */
    static async fromOPFS(name: string): Promise<StreamSink> {
        if (
            typeof navigator === 'undefined' ||
            typeof navigator.storage?.getDirectory !== 'function'
        ) {
            throw new MediaForgeError('This host has no OPFS', 'IO', {
                hint: 'Download a Blob, or write to a WritableStream.',
            });
        }
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        return new StreamSink(writable);
    }
}
