import type { PcmAudioBuffer } from '../types/media.js';
export interface BufferedAacResult {
    frames: Uint8Array[];
    asc: Uint8Array;
    sampleRate: number;
    channels: number;
}
export declare function tryEncodeBufferedAac(buffer: PcmAudioBuffer, bitrate: number, codec: string, signal?: AbortSignal): Promise<BufferedAacResult | null>;
