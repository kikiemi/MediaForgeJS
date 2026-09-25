import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { Source } from '../types/io.js';
import type { OutputMuxer } from '../types/container.js';
import type { PipelineAudioHost } from './pipeline-audio.js';
export declare function pipePcmTrack(host: PipelineAudioHost, track: MP4TrackInfo, source: Source, codec: string, muxer: OutputMuxer): Promise<void>;
