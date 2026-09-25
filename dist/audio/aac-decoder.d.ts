/** Decoded AAC-LC output: per-channel PCM plus the stream parameters. */
export interface AacDecodeResult {
    /** Per-channel PCM (one Float32Array per channel). */
    readonly channelData: Float32Array[];
    /** Sample rate in Hz. */
    readonly sampleRate: number;
}
/** Options for the built-in AAC-LC decoder. */
export interface AacDecodeOptions {
    /** Yield to the event loop every N frames (0 = never). */
    readonly yieldEvery?: number;
    /** Progress callback. */
    readonly onProgress?: (decodedFrames: number, totalFrames: number) => void;
    /** AbortSignal that cancels the operation. */
    readonly signal?: AbortSignal;
}
/** Self-hosted AAC-LC decoder (ISO 14496-3 LC profile incl. PCE), used where WebCodecs cannot. */
export declare class AacLcDecoder {
    private readonly srIndex;
    private readonly swbLong;
    private readonly swbShort;
    private readonly imdctLong;
    private readonly imdctShort;
    private readonly states;
    private static newChannelState;
    private readonly windowedLong;
    private readonly windowedShort;
    private noiseSeed;
    /** Sample rate in Hz. */
    readonly sampleRate: number;
    readonly channels: number;
    /** Creates a decoder; stream parameters come from configuration or the first PCE. */
    constructor(sampleRate: number, channels: number);
    /** Bits consumed by the last decodeFrame call (structure checks use it). */
    lastBitsConsumed: number;
    lastCodedBands: number;
    /** Decodes one raw AAC-LC access unit into per-channel PCM for that frame. */
    decodeFrame(accessUnit: Uint8Array): Float32Array[];
    private readProgramConfig;
    private decodeSce;
    private decodeCpe;
    private readIcsInfo;
    private bandOffsets;
    private decodeIcs;
    private decodeSpectralRun;
    private fillNoise;
    private readTns;
    private applyTns;
    private applyStereo;
    private filterbank;
}
export declare function decodeAacFrameForProbe(frame: Uint8Array, sampleRate: number, channels: number): {
    bitsConsumed: number;
    bitsAvailable: number;
    codedBands: number;
};
/** Decode a sequence of raw AAC-LC frames with one shared decoder state. */
export declare function decodeAacFrames(frames: readonly Uint8Array[], sampleRate: number, channels: number, options?: AacDecodeOptions): Promise<AacDecodeResult>;
