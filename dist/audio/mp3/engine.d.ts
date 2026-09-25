import type { MpegAudioEncodeOptions } from '../mpeg-audio-types.js';
export declare function mp3GaplessInfoFrameSize(sampleRate: number, channels: number, requestedBitrate: number): number;
export interface Mp3LevelSummary {
    readonly sourceFrameCount: number;
    readonly peak: number;
    readonly highPassMeanSlot: Float64Array;
}
/** First, duration-independent analysis pass for replayable PCM sources. */
export declare class Mp3LevelAnalyzer {
    readonly channels: number;
    private readonly previous;
    private readonly highPassTotal;
    private sourceFrames;
    private peakValue;
    private sealed;
    constructor(channels: number);
    pushPlanar(planes: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    finish(): Mp3LevelSummary;
    private assertOpen;
    private consumeSample;
}
export interface Mp3AnalysisPlan {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sourceFrameCount: number;
    readonly totalFrames: number;
    readonly gain: number;
    readonly highPassMeanSlot: Float64Array;
    readonly mixedEpisodes: readonly Mp3MixedEpisodePlan[];
}
export interface Mp3MixedEpisodePlan {
    readonly bits: Uint8Array;
    readonly count: number;
}
/** Second replay pass: retains one mixed/not-mixed bit per switch episode. */
export declare class Mp3PlanAnalyzer {
    readonly sampleRate: number;
    readonly channels: number;
    private readonly levels;
    readonly gain: number;
    private readonly totalFrames;
    private readonly totalGranules;
    private readonly queue;
    private readonly classifier;
    private readonly episodeBits;
    private readonly episodeActive;
    private readonly episodeLow;
    private readonly episodeHigh;
    private readonly episodeLowSum;
    private readonly episodeTotalSum;
    private receivedFrames;
    private granulesProcessed;
    private granulesPlanned;
    private sealed;
    constructor(sampleRate: number, channels: number, levels: Mp3LevelSummary, gain?: number);
    get peakBufferedFrames(): number;
    pushPlanar(planes: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    finish(): Mp3AnalysisPlan;
    private assertOpen;
    private drainGranules;
    private analyzeGranule;
    private consumeGranule;
    private finishEpisode;
}
export interface StreamingMp3EncodeOptions extends MpegAudioEncodeOptions {
    readonly onBufferedFrames?: (current: number, peak: number) => void;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when encoded audio frames are delivered to an external sink. */
    readonly collectFrames?: boolean;
}
export interface StreamingMp3Output {
    readonly infoFrame: Uint8Array<ArrayBuffer>;
    readonly audioBlob: Blob;
}
export declare class StreamingMp3Encoder {
    private readonly plan;
    readonly bitrate: number;
    private readonly options;
    private readonly analysisQueue;
    private readonly encodeQueue;
    private readonly classifier;
    private readonly machine;
    private readonly plannedGranules;
    private readonly episodeActive;
    private readonly episodeMixed;
    private readonly episodeIndex;
    private readonly blockScratch;
    private readonly mixedScratch;
    private receivedFrames;
    private granulesAnalysed;
    private granulesPlanned;
    private frameIndex;
    private sealed;
    constructor(plan: Mp3AnalysisPlan, bitrate?: number, options?: StreamingMp3EncodeOptions);
    get framesReceived(): number;
    get framesProduced(): number;
    get peakBufferedFrames(): number;
    pushPlanar(planes: readonly Float32Array[]): void;
    pushInterleaved(pcm: Float32Array): void;
    finish(): Blob;
    finishOutput(): StreamingMp3Output;
    private assertOpen;
    private feedScaled;
    private analyseGranule;
    private consumeBlocks;
    private drainReadyFrames;
    private emit;
}
export declare function encodeMP3(pcm: Float32Array, sampleRate: number, channels: number, bitrate?: number, options?: MpegAudioEncodeOptions): Blob;
export declare function encodeMP3Async(pcm: Float32Array, sampleRate: number, channels: number, bitrate?: number, options?: MpegAudioEncodeOptions): Promise<Blob>;
