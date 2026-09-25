export interface DecodedMpegAudio {
    readonly channelData: Float32Array[];
    readonly sampleRate: number;
}
export interface MpegLayer12FrameShape {
    readonly layer: 1 | 2;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameBytes: number;
    readonly samplesPerFrame: number;
}
export declare function parseMpegLayer12FrameShape(data: Uint8Array, offset?: number): MpegLayer12FrameShape | null;
export declare function skipId3v2(data: Uint8Array, off: number): number;
/** Known metadata at the end of an otherwise complete MPEG audio stream. */
export declare function isMpegAudioTrailer(data: Uint8Array, offset: number): boolean;
/** Stateful Layer I/II decoder that emits one bounded PCM frame per call. */
export declare class StreamingMpegLayer12Decoder {
    private state;
    private rate;
    private channelCount;
    private layer;
    get sampleRate(): number;
    get channels(): number;
    pushFrame(data: Uint8Array): readonly Float32Array[];
}
export declare function decodeMpegLayer12(data: Uint8Array): DecodedMpegAudio | null;
