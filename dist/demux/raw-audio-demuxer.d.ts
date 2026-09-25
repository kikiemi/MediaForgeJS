import type { Source } from '../types/io.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
import { type DiagnosticOptions } from '../core/diagnostics.js';
import { DemuxError } from '../core/errors.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
export interface RawAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'aac' | 'mp1' | 'mp2' | 'mp3';
    readonly signal?: AbortSignal;
}
export declare class UnsupportedAdtsLayoutError extends DemuxError {
    constructor();
}
/** Indexes ADTS/MPEG access units without decoding or retaining their payloads. */
export declare function demuxRawAudio(source: Source, options: RawAudioDemuxOptions): Promise<MP4DemuxResult>;
