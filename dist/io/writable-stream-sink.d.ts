import type { Sink } from '../types/io.js';
/** Non-seekable WritableStream output; callers await drain() for backpressure. */
export declare class WritableStreamSink implements Sink {
    private readonly sink;
    constructor(stream: WritableStream<Uint8Array>, options?: {
        highWaterMark?: number;
    });
    write(data: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    get done(): Promise<void>;
}
