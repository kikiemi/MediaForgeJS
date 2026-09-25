import type { DiagnosticContext } from '../core/diagnostics.js';
import type { DemuxBudgetOptions } from '../core/demux-guard.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
import type { Source } from '../types/io.js';
/** WebM/MKV demuxer (windowed cluster reads, lacing, DiscardPadding, D_WEBVTT subtitles). */
export declare class WebMDemuxer {
    private isWorker;
    private reader;
    private totalSamples;
    private signal;
    private materialize;
    private metadataDropped;
    private metadataWarned;
    private diagnostics?;
    private externalFailure?;
    private readonly inputUidCounts;
    private sampleBudget;
    private readonly limits;
    private indexBudget;
    constructor(options?: DemuxBudgetOptions);
    /** Parses the container with windowed reads and returns tracks plus encoded samples; honors `signal`. */
    demux(input: Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<MP4DemuxResult>;
    private headerAt;
    private walk;
    private optionalMetadataError;
    private warnMetadataLoss;
    private parseTracks;
    private parseClusterAt;
    private parseBlock;
    private encodedAudioFrameDuration;
    private reconstructVideoDts;
    private fillDurations;
}
