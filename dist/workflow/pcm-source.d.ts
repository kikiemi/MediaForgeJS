import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { MediaFile } from '../engine/engine-core.js';
import type { ReplayablePcmSource } from '../audio/pcm-source.js';
import type { WorkflowAudioRequest } from './types.js';
export declare function preparePcmSource(file: MediaFile, track: MP4TrackInfo, request: WorkflowAudioRequest): ReplayablePcmSource;
