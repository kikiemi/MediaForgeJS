import type { MpegAudioEncodeOptions } from './mpeg-audio-types.js';
export declare function legalMp2Bitrates(channels: number): readonly number[];
export interface StreamingMp2EncodeOptions extends MpegAudioEncodeOptions {
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when frames are handed directly to an external sink. */
    readonly collectOutput?: boolean;
}
/** Incremental Layer II encoder retaining one partial 1,152-frame PCM block. */
export declare class StreamingMp2Encoder {
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitrate: number;
    private readonly options;
    private readonly queue;
    private readonly core;
    private readonly sink;
    private readonly expectedCodecFrames;
    private inputFrames;
    private encodedFrames;
    private sealed;
    constructor(sampleRate: number, channels: number, bitrate?: number, options?: StreamingMp2EncodeOptions);
    get framesReceived(): number;
    get framesProduced(): number;
    get peakBufferedFrames(): number;
    pushPlanar(planes: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    finish(): Blob;
    private assertOpen;
    private drain;
    private emit;
}
/** Synchronous MP2 encode - the 1.0.0 public API, unchanged. */
export declare function encodeMP2(pcm: Float32Array, sampleRate: number, channels: number, bitrate?: number, options?: MpegAudioEncodeOptions): Blob;
/** Cancellable MP2 encode: yields between frame batches and honors options.signal. */
export declare function encodeMP2Async(pcm: Float32Array, sampleRate: number, channels: number, bitrate?: number, options?: MpegAudioEncodeOptions): Promise<Blob>;
