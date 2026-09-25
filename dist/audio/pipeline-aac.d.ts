import type { Source } from '../types/io.js';
import type { PcmAudioBuffer } from '../types/media.js';
import type { OutputMuxer } from '../types/container.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
export interface PipelineAacHost {
    readonly signal?: AbortSignal;
    audioBitrateFor(): number;
    targetAudioParams(sourceRate: number, sourceChannels: number, codec: string): {
        rate: number;
        channels: number;
    };
    hasDynamicCodecConfiguration(track: MP4TrackInfo): boolean;
    sourceAudioShape(track: MP4TrackInfo): {
        rate: number;
        channels: number;
    };
    sourceAudioWindow(track: MP4TrackInfo, rate: number): {
        head: number;
        valid: number;
        startOffset: number;
    };
    report(percent: number, message: string): void;
    checkAbort(): void;
    yield(): Promise<void>;
}
/** Incremental AAC-LC encoder wired directly to a container muxer. */
export declare class SelfHostedAacMuxBridge {
    readonly sampleRate: number;
    readonly channels: number;
    private readonly muxer;
    private readonly encoder;
    private readonly declaredValidSamples;
    private sealed;
    constructor(sampleRate: number, channels: number, bitrateKbps: number, muxer: OutputMuxer, startOffsetSeconds: number, expectedInputFrames?: number);
    get framesProduced(): number;
    get peakBufferedFrames(): number;
    push(planes: readonly Float32Array[]): void;
    finish(validSamples: number): void;
}
/** AAC-specific pipeline branch, including configuration-epoch handling. */
export declare class PipelineAac {
    private readonly host;
    constructor(host: PipelineAacHost);
    private pumpStaticAac;
    private tryNativeEncode;
    private tryPipeStaticNative;
    private pumpConfiguredAac;
    tryPipeConfiguredNative(src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer, target: {
        rate: number;
        channels: number;
    }, parentLifetime?: CodecLifetime): Promise<boolean>;
    pipeConfiguredSelfHosted(src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer, lifetime?: CodecLifetime): Promise<void>;
    pipeConfiguredPcm(src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer, lifetime?: CodecLifetime): Promise<void>;
    pipeAudioSelfHosted(src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer, lifetime?: CodecLifetime): Promise<void>;
    encodeSelfHosted(resampled: PcmAudioBuffer, muxer: OutputMuxer, startOffsetSeconds?: number, requestedCodec?: string, lifetime?: CodecLifetime): Promise<void>;
}
