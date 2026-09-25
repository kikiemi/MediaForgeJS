import type { Source } from '../types/io.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
/** FLV demuxer (AVC/AAC tags, mid-stream ASC replacement detection). */
export declare class FLVDemuxer {
    private readonly limits;
    constructor(options?: DemuxBudgetOptions);
    /** Parses the container with windowed reads and returns tracks plus encoded samples; honors `signal`. */
    demux(input: File | Blob | Source, signal?: AbortSignal): Promise<MP4DemuxResult>;
    private demuxImpl;
    private parseAvcC;
    private parseSPS;
}
