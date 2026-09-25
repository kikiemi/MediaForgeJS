import type { MediaWriters } from '../engine/formats.js';
import type { PipelineConfig } from './pipeline-config.js';
import type { ContainerFormat } from '../types/media.js';
import type { Sink } from '../types/io.js';
import type { AudioTrackConfig, OutputMuxer, VideoTrackConfig } from '../types/container.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
export interface PipelineMuxerHost {
    title(): string | undefined;
    videoColour(): {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    } | undefined;
    audioLanguage(): string | undefined;
    videoLanguage(): string | undefined;
    hasExternalSink(): boolean;
    estimateFps(samples: readonly {
        timestamp: number;
    }[] | undefined): number;
    estimateFpsFromDurations(samples: readonly {
        duration: number;
    }[] | undefined): number;
}
/** Builds the concrete output muxer and its track declaration. */
export declare class PipelineMuxerFactory {
    private readonly cfg;
    private readonly host;
    private readonly writers;
    constructor(cfg: PipelineConfig, host: PipelineMuxerHost, writers: MediaWriters);
    makeMuxer(fmt: ContainerFormat, sink: Sink, srcV: MP4TrackInfo | null, srcA: MP4TrackInfo | null, vCodec: string, aCodec: string, forceV?: boolean, forceA?: boolean, overW?: number, overH?: number, overSR?: number, overCh?: number, videoCopy?: boolean, audioCopy?: boolean, subtitleTracks?: MP4TrackInfo[], extraVideoTracks?: VideoTrackConfig[] | undefined, extraAudioTracks?: AudioTrackConfig[] | undefined): OutputMuxer;
}
