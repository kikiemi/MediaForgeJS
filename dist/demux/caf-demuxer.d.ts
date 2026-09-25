import type { MP4TrackInfo } from './mp4-demuxer.js';
import type { AudioIndexContext } from './standalone-audio-demuxer.js';
/** Indexes packed, full-width mono/stereo CAF LPCM with known or terminal unknown data size. */
export declare function indexCaf(context: AudioIndexContext): Promise<MP4TrackInfo>;
