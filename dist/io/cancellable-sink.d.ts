import type { Sink } from '../types/io.js';
export declare function createCancellableSink(sink: Sink, signal: AbortSignal, onFailure?: (reason: unknown, aborted: boolean) => void): Sink & {
    abort(reason?: unknown): Promise<void>;
};
