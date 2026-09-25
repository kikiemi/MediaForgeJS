import type { Source } from '../types/io.js';
import type { PcmAudioBuffer } from '../types/media.js';
import type { OutputMuxer } from '../types/container.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
export interface PipelineAudioHost {
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
export declare class PipelineAudio {
    private readonly host;
    private readonly cfg;
    private readonly aac;
    constructor(host: PipelineAudioHost);
    private audioBitrateFor;
    private targetAudioParams;
    private hasDynamicCodecConfiguration;
    private sourceAudioShape;
    private sourceAudioWindow;
    private checkAbort;
    private yield;
    pipeAudio(src: MP4TrackInfo, source: Source, outCodec: string, muxer: OutputMuxer): Promise<void>;
    encodeAudioBuffer(audioBuf: PcmAudioBuffer, codec: string, muxer: OutputMuxer, startOffsetSeconds?: number): Promise<void>;
}
