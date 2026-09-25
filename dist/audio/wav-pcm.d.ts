import type { PcmAudioBuffer } from '../types/media.js';
export declare function decodeWavToAudioBuffer(bytes: Uint8Array, signal?: AbortSignal): Promise<PcmAudioBuffer>;
