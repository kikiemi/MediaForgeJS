import type { Sink } from '../types/io.js';
import type { ReplayablePcmSource } from './pcm-source.js';
import type { StreamingAacLcEncoder } from './aac-encoder.js';
import type { StreamingFlacEncoder } from './flac-encoder.js';
import type { StreamingMp2Encoder } from './mp2-encoder.js';
import type { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize } from './mp3/engine.js';
export type StreamingSelfHostedAudioFormat = 'aac' | 'flac' | 'mp2' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf';
/** Encoding passes and retained PCM work-unit sizes. */
export interface StreamingAudioDiagnostics {
    readonly format: StreamingSelfHostedAudioFormat;
    readonly passes: number;
    readonly inputFrames: number;
    readonly encodedFrames: number;
    /** Largest decoded PCM work unit retained by this layer, in frames. */
    readonly peakPcmFrames: number;
    /** Duration-growing analysis state. Zero for one-pass codecs. */
    readonly planningBytes: number;
}
export interface StreamingAudioEncodeOptions {
    readonly bitrateKbps?: number;
    readonly vbr?: boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (fraction: number, message: string) => void;
    /** Internal/output integration hook for sink backpressure. */
    readonly afterPcmChunk?: () => Promise<void>;
}
export interface StreamingAacResult {
    readonly audioSpecificConfig: Uint8Array;
    readonly inputFrames: number;
    readonly encodedFrames: number;
    readonly peakPcmFrames: number;
}
export interface StreamingAudioCodecs {
    readonly aac?: typeof StreamingAacLcEncoder;
    readonly flac?: typeof StreamingFlacEncoder;
    readonly mp2?: typeof StreamingMp2Encoder;
    readonly mp3?: {
        readonly Mp3LevelAnalyzer: typeof Mp3LevelAnalyzer;
        readonly Mp3PlanAnalyzer: typeof Mp3PlanAnalyzer;
        readonly StreamingMp3Encoder: typeof StreamingMp3Encoder;
        readonly mp3GaplessInfoFrameSize: typeof mp3GaplessInfoFrameSize;
    };
}
/** Builds replayable encoding operations without importing unselected codec implementations. */
export declare function createStreamingAudioOutput(codecs?: StreamingAudioCodecs): {
    streamReplayableAac: (source: ReplayablePcmSource, onFrame: (frame: Uint8Array, frameIndex: number) => void, options?: StreamingAudioEncodeOptions) => Promise<StreamingAacResult>;
    encodeReplayablePcm: (source: ReplayablePcmSource, format: StreamingSelfHostedAudioFormat, options?: StreamingAudioEncodeOptions) => Promise<{
        blob: Blob;
        diagnostics: StreamingAudioDiagnostics;
    }>;
    encodeReplayablePcmToSink: (source: ReplayablePcmSource, format: StreamingSelfHostedAudioFormat, sink: Sink, options?: StreamingAudioEncodeOptions) => Promise<StreamingAudioDiagnostics>;
};
