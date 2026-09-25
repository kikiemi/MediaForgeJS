import type { Source } from '../types/io.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
export { probeTsLayout } from './ts-layout.js';
/** MPEG-TS demuxer (33-bit PTS unwrap, PES-declared lengths, CC checks). */
export declare class TSDemuxer {
    private readonly limits;
    constructor(options?: DemuxBudgetOptions);
    /** Parses the container with windowed reads and returns tracks plus encoded samples; honors `signal`. */
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<MP4DemuxResult>;
    private demuxImpl;
    /** PES timestamps apply to the access unit commencing in that PES, not its leading continuation bytes. */
    private joinVideoContinuations;
    private buildH264Track;
    private buildH265Track;
    private decodeDurations;
    private appendAudioEntry;
    private resolvePrivateAudioStreamType;
    private splitAudioFrames;
    private splitAdtsFrames;
    private splitMpegAudioFrames;
    private splitAc3Frames;
}
