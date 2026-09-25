import { type PcmFormat } from '../core/pcm-format.js';
import type { MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { ReplayablePcmSource } from './pcm-source.js';
export declare const MAX_PCM_PACKET_BYTES: number;
export declare function decodePcmPacket(bytes: Uint8Array, format: PcmFormat, signal?: AbortSignal): Iterable<Float32Array[]>;
/** Decodes contiguous PCM packets directly into bounded planar work units. */
export declare function createPcmTrackSource(track: MP4TrackInfo, readSample: (sample: MP4Sample) => Promise<Uint8Array>, signal?: AbortSignal): ReplayablePcmSource;
