import type { MP4Sample, MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { ReplayablePcmSource } from './pcm-source.js';
/** Replayable built-in MPEG Layer I/II packet decoder. */
export declare function createMpegTrackPcmSource(track: MP4TrackInfo, readSample: (sample: MP4Sample, index: number) => Promise<Uint8Array>, signal?: AbortSignal): ReplayablePcmSource;
