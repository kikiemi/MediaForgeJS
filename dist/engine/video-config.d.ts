import type { Source } from '../types/io.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
import { DiagnosticContext } from '../core/diagnostics.js';
export declare function recoverVideoConfigurations(result: MP4DemuxResult, source: Source, diagnostics: DiagnosticContext, maxPacketBytes: number, signal?: AbortSignal): Promise<void>;
