import type { Source } from '../types/io.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
import { DiagnosticContext, type DiagnosticOptions } from '../core/diagnostics.js';
export interface AVIDemuxerOptions extends DemuxBudgetOptions, DiagnosticOptions {
    /** Recover complete packets from a physically truncated tail; strict validation still rejects truncation. */
    readonly aviRecovery?: 'complete-packets';
}
/** AVI demuxer (bounded RIFF/AVIX traversal, stream time bases). */
export declare class AVIDemuxer {
    private readonly limits;
    private readonly recoverPackets;
    private readonly diagnosticOptions;
    constructor(options?: AVIDemuxerOptions);
    /** Parses the container with windowed reads and returns tracks plus encoded samples; honors `signal`. */
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<MP4DemuxResult>;
    private demuxImpl;
    private fourcc;
    private parseHdrl;
    private parseStrl;
    private mapVideoCodec;
    private mapAudioFormat;
}
