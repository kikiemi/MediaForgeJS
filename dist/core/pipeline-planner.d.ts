import type { PipelineConfig } from './pipeline-config.js';
import type { MP4CodecConfiguration, MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { ContainerFormat } from '../types/media.js';
/** Codec, geometry and timeline planning shared by Pipeline branches. */
export declare class PipelinePlanner {
    private readonly cfg;
    constructor(cfg: PipelineConfig);
    videoBitrateFor(): number;
    audioBitrateFor(): number;
    resolveRunCodecs(format: ContainerFormat, video: MP4TrackInfo | null, audio: MP4TrackInfo | null): {
        video: string;
        audio: string;
    };
    /** Output audio parameters shared by the encoders and the muxer header. */
    targetAudioParams(srcRate: number, srcChannels: number, outCodec: string): {
        rate: number;
        channels: number;
    };
    hasDynamicCodecConfiguration(track: MP4TrackInfo): boolean;
    sourceAudioShape(track: MP4TrackInfo): {
        rate: number;
        channels: number;
    };
    configurationForSample(track: MP4TrackInfo, sample: MP4Sample): MP4CodecConfiguration | undefined;
    videoPayloadForSample(track: MP4TrackInfo, sample: MP4Sample, payload: Uint8Array, previousConfigIndex: number | null): {
        data: Uint8Array;
        codecConfig: Uint8Array | undefined;
        configIndex: number;
    };
    /** Median frame interval of the first samples, as frames per second. */
    estimateFps(samples: readonly {
        timestamp: number;
    }[] | undefined): number;
    encoderFps(samples?: readonly {
        timestamp: number;
    }[]): number;
    estimateFpsFromDurations(samples: readonly {
        duration: number;
    }[] | undefined): number;
    targetVideoDimensions(srcW: number, srcH: number): {
        w: number;
        h: number;
    };
}
