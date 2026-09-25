export interface AacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
}
export interface AacEncodeResult {
    readonly frames: Uint8Array[];
    readonly audioSpecificConfig: Uint8Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samplesPerFrame: number;
}
export interface AacEncodeAsyncOptions extends AacEncodeOptions {
    readonly signal?: AbortSignal;
    readonly yieldEvery?: number;
}
export interface StreamingAacEncodeOptions extends AacEncodeOptions {
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    readonly collectFrames?: boolean;
}
/** Incremental AAC-LC encoder retaining at most one partial 1,024-frame block. */
export declare class StreamingAacLcEncoder {
    readonly sampleRate: number;
    readonly channels: number;
    private readonly options;
    private readonly queue;
    private readonly core;
    private readonly collected;
    private readonly expectedEncodedFrames;
    private inputFrames;
    private encodedFrames;
    private sealed;
    constructor(sampleRate: number, channels: number, bitrateKbps: number, options?: StreamingAacEncodeOptions);
    get framesReceived(): number;
    get framesProduced(): number;
    get peakBufferedFrames(): number;
    get audioSpecificConfig(): Uint8Array;
    pushPlanar(channels: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    finish(): AacEncodeResult;
    private assertOpen;
    private drainCompleteFrames;
    private emit;
}
export declare function encodeAacLcAsync(pcm: Float32Array, sampleRate: number, channels: number, bitrateKbps: number, options?: AacEncodeAsyncOptions): Promise<AacEncodeResult>;
/** Self-hosted AAC-LC encoder (long windows, two-loop quantization); see encodeAacLcAsync for the cancellable form. */
export declare function encodeAacLc(pcm: Float32Array, sampleRate: number, channels: number, bitrateKbps: number, options?: AacEncodeOptions): AacEncodeResult;
/** Wrap raw AAC frames in ADTS headers (MPEG-4, no CRC). */
export declare function wrapAdts(result: AacEncodeResult): Uint8Array<ArrayBuffer>;
