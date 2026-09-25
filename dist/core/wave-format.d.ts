export type WavePcmCodec = 'pcm' | 'pcm-u8' | 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le' | 'pcm-f64le';
export interface WaveFormat {
    readonly codec: WavePcmCodec;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly validBitsPerSample: number;
    readonly blockAlign: number;
    readonly float: boolean;
    readonly channelMask?: number;
    readonly codecConfig: Uint8Array;
}
export declare const MAX_WAVE_FORMAT_BYTES = 65553;
/** Reads a WAVE fmt payload; extensible precision and speaker assignments remain in codecConfig. */
export declare function parseWaveFormat(input: Uint8Array): WaveFormat;
/** Builds a complete RIFF/RF64 prefix; callers append dataBytes and one zero pad byte if odd. */
export declare function createWaveCopyHeader(config: Uint8Array, dataBytes: number): Uint8Array;
