import { type MediaForgeJSConfig } from './core/converter-config.js';
import type { MediaInput } from './types/media.js';
export type { MediaInput } from './types/media.js';
export type BatchConversionResult = {
    index: number;
    input: MediaInput;
} & ({
    status: 'fulfilled';
    value: Blob;
} | {
    status: 'rejected';
    reason: unknown;
});
export interface BatchConversionOptions {
    /** Maximum simultaneous conversions, including completed results awaiting consumption (1..8, default 1). */
    concurrency?: number;
    /** Yield in completion order (default) or input order, including failed files. */
    resultOrder?: 'completion' | 'input';
    onFileProgress?: (index: number, percent: number, message: string) => void;
    /** Per-file overrides; a thrown/rejected error rejects only that file. */
    configure?: (input: MediaInput, index: number) => Partial<MediaForgeJSConfig> | PromiseLike<Partial<MediaForgeJSConfig>>;
}
/** Yields completed files; breaking cancels work and requests input cleanup without awaiting it. */
export declare function convertBatch(inputs: Iterable<MediaInput> | AsyncIterable<MediaInput>, config: MediaForgeJSConfig, options?: BatchConversionOptions): AsyncGenerator<BatchConversionResult>;
