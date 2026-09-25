import type { Sink } from '../types/io.js';
export declare function assertSink(sink: Sink): void;
/** Wait for sink backpressure while keeping AbortSignal responsive. */
export declare function drainSink(sink: Sink, signal?: AbortSignal): Promise<void>;
