import type { ReplayablePcmSource } from './pcm-source.js';
/** Raw-FLAC replayable source backed by windowed frame reads and WebCodecs. */
export declare function createRawFlacPcmSource(file: File | Blob, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
