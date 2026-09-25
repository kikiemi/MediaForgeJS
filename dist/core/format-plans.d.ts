import type { ContainerFormat } from '../types/media.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
export declare const IMAGE_FORMATS: Set<ContainerFormat>;
export declare const PCM_AUDIO_FORMATS: Set<ContainerFormat>;
export declare const AUDIO_ONLY: Set<ContainerFormat>;
export declare const AUDIO_INPUT: Set<ContainerFormat>;
export declare function assertAudioEncodeRequest(codec: string): void;
export declare const mp4FamilyAudioOk: (codec: string) => boolean;
export declare const VIDEO_CONTAINERS: Set<ContainerFormat>;
export type NativeDemuxer = {
    demux(input: File | Blob, signal?: AbortSignal): Promise<MP4DemuxResult>;
};
type ContainerCodecPlan = {
    readonly defaultVideo?: string;
    readonly defaultAudio?: string;
    readonly video?: readonly string[];
    readonly audio?: readonly string[];
};
export declare const CONTAINER_CODEC_PLANS: Partial<Record<ContainerFormat, ContainerCodecPlan>>;
export declare function resolveSupportedCodec(requestedCodec: string | undefined, supportedCodecs: readonly string[] | undefined, fallbackCodec: string | undefined, label: string): string | null | undefined;
export {};
