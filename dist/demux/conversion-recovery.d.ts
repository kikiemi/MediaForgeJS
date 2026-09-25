import type { Source } from '../types/io.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
import type { DiagnosticContext } from '../core/diagnostics.js';
/** Reconciles recovered media windows and missing video configuration for conversion. */
export declare function recoverConversionDemux(result: MP4DemuxResult, source: Source, diagnostics: DiagnosticContext, signal?: AbortSignal): Promise<void>;
