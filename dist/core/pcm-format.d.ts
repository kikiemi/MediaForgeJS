import { type WavePcmCodec } from './wave-format.js';
export type PcmCodec = WavePcmCodec | 'pcm-s8' | 'pcm-s16be' | 'pcm-s24be' | 'pcm-s32be' | 'pcm-f32be' | 'pcm-f64be';
export type PcmCopyContainer = 'wav' | 'aiff' | 'au' | 'caf';
export interface PcmFormat {
    readonly codec: PcmCodec;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly validBitsPerSample: number;
    readonly blockAlign: number;
    readonly float: boolean;
    readonly signed: boolean;
    readonly littleEndian: boolean;
    readonly channelMask?: number;
    readonly waveConfig?: Uint8Array;
}
interface PcmTrackShape {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly codecConfig?: Uint8Array;
}
/** Explicit PCM codec IDs describe stored bytes; historical pcm remains configured PCM16LE. */
export declare function describePcmTrack(track: PcmTrackShape): PcmFormat;
/** Builds a seek-free prefix and a byte-representation target without changing sample precision. */
export declare function createPcmCopyHeader(container: PcmCopyContainer, format: PcmFormat, dataBytes: number): {
    header: Uint8Array;
    target: PcmFormat;
    padding: 0 | 1;
};
/** Copies sample bits, swapping byte order or the 8-bit sign bias without numerical conversion. */
export declare function convertPcmByteOrder(data: Uint8Array, source: PcmFormat, target: PcmFormat): Uint8Array;
export {};
