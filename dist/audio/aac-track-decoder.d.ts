import type { PcmAudioBuffer } from '../types/media.js';
import type { MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import { type ReplayablePcmSource } from './pcm-source.js';
export interface ConfiguredAacDecodeOptions {
    targetSampleRate?: number;
    targetChannels?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}
export interface StreamedConfiguredAacResult {
    readonly sampleRate: number;
    readonly channels: number;
    readonly frames: number;
    readonly startOffset: number;
}
export interface ConfiguredAacPcmSource extends ReplayablePcmSource {
    readonly startOffset: number;
}
export declare function createConfiguredAacTrackPcmSource(track: MP4TrackInfo, readSample: (sample: MP4Sample, index: number, signal?: AbortSignal) => Promise<Uint8Array>, options?: ConfiguredAacDecodeOptions): ConfiguredAacPcmSource;
export declare function streamConfiguredAacTrack(track: MP4TrackInfo, readSample: (sample: MP4Sample, index: number, signal?: AbortSignal) => Promise<Uint8Array>, consume: (planes: readonly Float32Array[]) => void, options?: ConfiguredAacDecodeOptions): Promise<StreamedConfiguredAacResult>;
export declare function decodeConfiguredAacTrack(track: MP4TrackInfo, readSample: (sample: MP4Sample, index: number, signal?: AbortSignal) => Promise<Uint8Array>, options?: ConfiguredAacDecodeOptions): Promise<PcmAudioBuffer>;
