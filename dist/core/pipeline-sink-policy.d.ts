import type { PipelineConfig } from './pipeline-config.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
import type { Sink } from '../types/io.js';
/** Reject sink routes that would otherwise require hidden whole-output buffering. */
export declare function assertSinkContainerSupport(cfg: PipelineConfig, sink: Sink): void;
/** Reject track layouts that the progressive mux path cannot preserve exactly. */
export declare function assertSinkTrackSupport(result: MP4DemuxResult): void;
