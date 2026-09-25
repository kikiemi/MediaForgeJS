import type { MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { OutputMuxer } from '../types/container.js';
import type { Source } from '../types/io.js';
import type { ContainerFormat } from '../types/media.js';
export interface PipelineVideoHost {
    readonly signal?: AbortSignal;
    videoBitrateFor(): number;
    encoderFps(samples?: readonly {
        timestamp: number;
    }[]): number;
    targetVideoDimensions(width: number, height: number): {
        w: number;
        h: number;
    };
    videoPayloadForSample(track: MP4TrackInfo, sample: MP4Sample, payload: Uint8Array, previousConfigIndex: number | null): {
        data: Uint8Array;
        codecConfig: Uint8Array | undefined;
        configIndex: number;
    };
    report(percent: number, message: string): void;
    checkAbort(): void;
    yield(): Promise<void>;
}
/** WebCodecs video decode/scale/restamp/encode stage, isolated from pipeline orchestration. */
export declare class PipelineVideo {
    private readonly host;
    constructor(host: PipelineVideoHost);
    pipeVideo(sourceTrack: MP4TrackInfo, source: Source, outputCodec: string, format: ContainerFormat, muxer: OutputMuxer, requestedFps: number): Promise<void>;
}
