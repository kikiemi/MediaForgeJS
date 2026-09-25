import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { AudioTrackConfig, VideoTrackConfig } from '../types/container.js';
import type { ContainerFormat } from '../types/media.js';
export declare function copyEngineVideoTrack(track: MP4TrackInfo, source: string, target: string): VideoTrackConfig;
export declare function copyEngineAudioTrack(track: MP4TrackInfo, source: string, target: ContainerFormat): AudioTrackConfig;
