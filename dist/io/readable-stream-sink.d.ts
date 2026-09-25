import type { Sink } from '../types/io.js';
export interface ReadableStreamSinkOptions {
    /** Maximum queued output bytes before producers wait (default 1 MiB). */
    readonly highWaterMark?: number;
    /** Maximum total output bytes, including bytes already consumed; defaults to Number.MAX_SAFE_INTEGER. */
    readonly maxBytes?: number;
}
export declare class ReadableStreamSink implements Sink {
    readonly stream: ReadableStream<Uint8Array>;
    private controller;
    private readonly waiters;
    private failure;
    private readonly maxBytes;
    private writtenBytes;
    private closed;
    private consumerCancelled;
    private readonly cancellation;
    get signal(): AbortSignal;
    constructor(options?: ReadableStreamSinkOptions);
    write(data: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    private assertWritable;
    private releaseDrainsIfReady;
    private fail;
    private resolveWaiters;
    private rejectWaiters;
}
