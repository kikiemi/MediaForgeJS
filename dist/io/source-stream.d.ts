import type { Source } from '../types/io.js';
export interface SourceStreamOptions {
    /** Maximum bytes requested per pull; defaults to 256 KiB. */
    readonly chunkBytes?: number;
    /** Errors the stream on abort; the caller retains ownership of the underlying Source. */
    readonly signal?: AbortSignal;
    /** Reports validated input bytes before enqueue; a returned promise delays delivery and remains cancellable. */
    readonly onProgress?: (bytesRead: number, totalBytes: number) => void | PromiseLike<void>;
}
/** Reads a stable Source on demand, one chunk at a time, with independent output bytes. */
export declare function sourceToReadableStream(source: Source, options?: SourceStreamOptions): ReadableStream<Uint8Array>;
