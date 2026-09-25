export interface PcmStreamWindow {
    /** Target-rate frames discarded before the first emitted frame. */
    readonly head?: number;
    /** Maximum target-rate frames emitted. Zero/undefined means unbounded. */
    readonly valid?: number;
}
export type PlanarPcmConsumer = (channels: readonly Float32Array[]) => void;
/** Stateful, duration-independent PCM mapping and resampling. */
export declare class StreamingPcmTransformer {
    readonly sourceSampleRate: number;
    readonly sourceChannels: number;
    readonly targetSampleRate: number;
    readonly targetChannels: number;
    private readonly consume;
    private readonly resampler;
    private readonly head;
    private readonly validEnd;
    private producedFrames;
    private emittedFrames;
    private sealed;
    private peakWorkFramesValue;
    constructor(sourceSampleRate: number, sourceChannels: number, targetSampleRate: number, targetChannels: number, consume: PlanarPcmConsumer, window?: PcmStreamWindow);
    get framesEmitted(): number;
    get peakWorkFrames(): number;
    push(channels: readonly Float32Array[]): void;
    flush(): void;
    private emit;
}
/** A FIFO interleaved PCM queue whose retained size is observable in tests. */
export declare class InterleavedPcmQueue {
    readonly channels: number;
    private chunks;
    private headIndex;
    private bufferedSamples;
    private peakBufferedFramesValue;
    constructor(channels: number);
    get bufferedFrames(): number;
    get peakBufferedFrames(): number;
    pushPlanar(planes: readonly Float32Array[], gain?: number): void;
    pushInterleaved(data: Float32Array): void;
    /** Copies without consuming. Missing tail samples are zero-filled. */
    copyFrames(startFrame: number, frameCount: number): Float32Array;
    takeFrames(frameCount: number, pad?: boolean): Float32Array;
    discardFrames(frameCount: number): void;
}
