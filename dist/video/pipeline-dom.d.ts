import type { PipelineConfig } from '../core/pipeline-config.js';
import type { OutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
import type { ContainerFormat, PcmAudioBuffer } from '../types/media.js';
export interface PipelineDomHost {
    encoderFps(): number;
    targetVideoDimensions(width: number, height: number): {
        w: number;
        h: number;
    };
    targetAudioParams(rate: number, channels: number, codec: string): {
        rate: number;
        channels: number;
    };
    videoBitrateFor(): number;
    makeMuxer(format: ContainerFormat, sink: Sink, videoCodec: string, audioCodec: string, hasVideo: boolean, hasAudio: boolean, width: number, height: number, sampleRate: number, channels: number): OutputMuxer;
    encodeAudioBuffer(audio: PcmAudioBuffer, codec: string, muxer: OutputMuxer): Promise<void>;
    report(percent: number, message: string): void;
    checkAbort(): void;
    yield(): Promise<void>;
}
/** Media-element fallback kept separate from the native pipeline coordinator. */
export declare class PipelineDom {
    private readonly config;
    private readonly host;
    constructor(config: PipelineConfig, host: PipelineDomHost);
    run(input: File | Blob, format: ContainerFormat): Promise<Blob>;
    private encodeVideo;
}
