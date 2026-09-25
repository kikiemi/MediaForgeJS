import { DemuxError } from '../core/errors.js';
export type ByteStreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
export declare class TruncatedByteStreamError extends DemuxError {
    readonly offset: number;
    constructor(offset: number);
}
/** Owns one copied input chunk and releases its reader without waiting for uncooperative cancellation. */
export declare class StreamByteReader {
    readonly signal: AbortSignal;
    private readonly maxChunkBytes;
    private readonly maxEmptyChunks;
    private readonly nextInput;
    private readonly cancelInput;
    private readonly releaseInput;
    private chunk;
    private at;
    private ended;
    private closed;
    private pulls;
    private emptyChunks;
    position: number;
    constructor(input: ByteStreamInput, signal: AbortSignal, maxChunkBytes: number, maxEmptyChunks: number);
    checkAbort(): void;
    read(length: number, allowEnd?: boolean): Promise<Uint8Array | undefined>;
    fill(data: Uint8Array, start: number, length: number): Promise<void>;
    toEnd(header: Uint8Array, limit: number): Promise<Uint8Array>;
    close(reason?: unknown): void;
    private consume;
    private available;
}
