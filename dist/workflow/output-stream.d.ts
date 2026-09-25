import type { Sink } from '../types/io.js';
import type { WorkflowStreamOptions } from './types.js';
export declare function snapshotStreamOptions(options?: WorkflowStreamOptions): Required<WorkflowStreamOptions>;
export declare function outputStream(run: (sink: Sink, signal: AbortSignal) => Promise<void>, options: Required<WorkflowStreamOptions>): ReadableStream<Uint8Array>;
