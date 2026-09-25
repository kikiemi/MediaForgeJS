import type { ReplayablePcmSource } from './pcm-source.js';
/** Windowed Ogg Vorbis source using the WebCodecs Xiph-extradata registration. */
export declare function createRawOggVorbisPcmSource(file: File | Blob, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
