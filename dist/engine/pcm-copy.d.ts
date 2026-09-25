import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
import { type PcmCopyContainer } from '../core/pcm-format.js';
/** Streams complete PCM frames with a precomputed header and lossless sign/endian conversion. */
export declare function createPcmCopyMuxer(container: PcmCopyContainer, track: MP4TrackInfo, sink: Sink): AudioOutputMuxer;
