import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
/** Streams supported PCM as WAVE while preserving existing WAVE precision and channel metadata. */
export declare function createWaveCopyMuxer(track: MP4TrackInfo, sink: Sink): AudioOutputMuxer;
