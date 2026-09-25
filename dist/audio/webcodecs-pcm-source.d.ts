import type { MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { ReplayablePcmSource } from './pcm-source.js';
export type EncodedAudioSampleReader = (sample: MP4Sample, index: number) => Promise<Uint8Array>;
export declare function createWebCodecsTrackPcmSource(track: MP4TrackInfo, readSample: EncodedAudioSampleReader, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
