import type { PipelineConfig } from './pipeline-config.js';
import type { ContainerFormat } from '../types/media.js';
import type { OutputMuxer } from '../types/container.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
/** Copy-plan eligibility and timestamp policy for Pipeline remux branches. */
export declare class PipelineRemuxPlanner {
    private readonly cfg;
    constructor(cfg: PipelineConfig);
    private hasDynamicCodecConfiguration;
    canDirectRemuxVideo(inputFmt: ContainerFormat, outputFmt: ContainerFormat, track: MP4TrackInfo, outputCodec: string): boolean;
    canDirectRemuxAudio(inputFmt: ContainerFormat, outputFmt: ContainerFormat, track: MP4TrackInfo, outputCodec: string): boolean;
    private sameCodecFamily;
    directAudioStartIndex(src: MP4TrackInfo, fmt: ContainerFormat): number;
    wireAudioPadding(src: MP4TrackInfo, muxer: OutputMuxer, fmt: ContainerFormat): void;
    private codecSatisfiesRequest;
}
