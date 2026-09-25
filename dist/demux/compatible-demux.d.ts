import type { Source } from '../types/io.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
export declare function demuxCompatible(demuxer: {
    demux(input: File | Blob | Source, signal?: AbortSignal): Promise<MP4DemuxResult>;
}, input: File | Blob | Source, signal?: AbortSignal): Promise<MP4DemuxResult>;
