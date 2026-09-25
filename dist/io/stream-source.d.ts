import type { Source } from '../types/io.js';
export interface StreamSourceOptions {
    /** Random access requires retaining the entire input. No unbounded default is provided. */
    readonly retention: 'memory';
    /** Maximum retained payload bytes; excludes upstream buffers and returned read copies. */
    readonly maxBytes: number;
    /** Maximum consecutive empty chunks before rejecting a nonprogressing input; defaults to 1024. */
    readonly maxEmptyChunks?: number;
    readonly signal?: AbortSignal;
}
/** A completed stream retained in copied pages; construction consumes and owns the input reader. */
export declare class StreamSource implements Source {
    private readonly pages;
    readonly size: number;
    private constructor();
    /** Resolves only at EOF. Failure/abort cancels the reader or calls iterator.return(). */
    static from(input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: StreamSourceOptions): Promise<StreamSource>;
    read(offset: number, length: number): Promise<Uint8Array>;
}
