export interface FlacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
    readonly signal?: AbortSignal;
}
export interface StreamingFlacEncodeOptions extends FlacEncodeOptions {
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when encoded frames are delivered directly to an external sink. */
    readonly collectFrames?: boolean;
}
/** Incremental FLAC encoder; decoded PCM retention is bounded to one codec block. */
export declare class StreamingFlacEncoder {
    readonly sampleRate: number;
    readonly channels: number;
    private readonly options;
    private readonly queue;
    private readonly core;
    private readonly md5;
    private readonly md5Scratch;
    private readonly encodedFrames;
    private readonly expectedCodecFrames;
    private totalInputFrames;
    private frameIndex;
    private minFrameSize;
    private maxFrameSize;
    private sealed;
    constructor(sampleRate: number, channels: number, options?: StreamingFlacEncodeOptions);
    get framesReceived(): number;
    get framesProduced(): number;
    get peakBufferedFrames(): number;
    pushPlanar(planes: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    /** Reserves the complete call atomically before any MD5/frame work starts. */
    private reserveInputFrames;
    private consumeInterleaved;
    private updateMd5Block;
    finish(): Uint8Array<ArrayBuffer>;
    finishBlob(): Blob;
    /** Finalizes statistics/MD5 and returns the 42-byte fLaC+STREAMINFO header. */
    finishHeader(): Uint8Array<ArrayBuffer>;
    private finishParts;
    private assertOpen;
    private emit;
    private buildHeader;
}
/** Synchronous FLAC encode - the 1.0.0 public API, unchanged. */
export declare function encodeFlac(pcm: Float32Array, sampleRate: number, channels: number, options?: FlacEncodeOptions): Uint8Array<ArrayBuffer>;
/** Cancellable FLAC encode: yields between frames and honors options.signal. */
export declare function encodeFlacAsync(pcm: Float32Array, sampleRate: number, channels: number, options?: FlacEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;
