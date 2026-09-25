import type { Sink } from '../types/io.js';
export interface PositionedWriter {
    write(data: {
        type: 'write';
        position: number;
        data: ArrayBuffer;
    }): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
}
export interface MemorySinkOptions {
    /** Maximum stored output bytes; defaults to Number.MAX_SAFE_INTEGER. */
    maxBytes?: number;
}
/** Buffers writes in memory; close() leaves the buffer readable and writable. */
export declare class MemorySink implements Sink {
    private chunks;
    private ends;
    private length;
    private readonly maxBytes;
    constructor(options?: MemorySinkOptions);
    write(data: Uint8Array): void;
    get size(): number;
    close(): Promise<void>;
    patchAt(offset: number, data: Uint8Array): void;
    toBlob(mimeType: string): Blob;
    toUint8Array(): Uint8Array;
}
export declare class StreamSink implements Sink {
    private readonly writer;
    private readonly writeOutput;
    private readonly closeOutput;
    private readonly abortOutput;
    private pending;
    private queuedBytes;
    private readonly highWaterMark;
    private drainWaiters;
    private readonly failureWaiters;
    private abortPromise;
    private closePromise;
    private closed;
    private appendPos;
    private failure;
    constructor(writer: PositionedWriter, options?: {
        highWaterMark?: number;
    });
    private assertHealthy;
    private assertWritable;
    private fail;
    private waitFor;
    /** Queues a byte snapshot; callers await drain() to apply backpressure. */
    write(data: Uint8Array): void;
    patchAt(offset: number, data: Uint8Array): void;
    abort(reason?: unknown): Promise<void>;
    drain(): Promise<void>;
    close(): Promise<void>;
    get done(): Promise<void>;
    private enqueueWrite;
    private wakeDrainWaiters;
    /** Opens a save-file picker and returns a StreamSink over the chosen file (browser only). */
    static fromPicker(suggestedName: string): Promise<StreamSink>;
    /** Creates (truncating) an OPFS file and returns a StreamSink over it. */
    static fromOPFS(name: string): Promise<StreamSink>;
}
