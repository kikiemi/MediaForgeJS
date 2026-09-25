import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
export declare const AUDIO_COPY_FORMATS: ReadonlySet<string>;
/** Creates an audio-only copy writer without retaining the complete output. */
export declare function createAudioCopyMuxer(format: string, track: MP4TrackInfo, sink: Sink): AudioOutputMuxer;
