import type { Source } from '../types/io.js';
import type { MP4DemuxResult } from './mp4-demuxer.js';
import { DiagnosticContext, type DiagnosticOptions } from '../core/diagnostics.js';
import { DemuxIndexBudget, type DemuxBudgetOptions } from '../core/demux-guard.js';
export interface StandaloneAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'wav' | 'aiff' | 'aif' | 'aifc' | 'au' | 'caf' | 'flac' | 'ogg' | 'opus';
    readonly signal?: AbortSignal;
    /** One packet's byte budget; defaults to 16 MiB, maximum 64 MiB. */
    readonly maxPacketBytes?: number;
}
export interface AudioIndexContext {
    readonly size: number;
    readonly budget: DemuxIndexBudget;
    readonly maxPacketBytes: number;
    readonly diagnostics: DiagnosticContext;
    read(offset: number, length: number): Promise<Uint8Array>;
    checkpoint(): Promise<void>;
}
/** Indexes supported PCM containers, native FLAC, and single-stream Ogg Opus/Vorbis audio. */
export declare function demuxStandaloneAudio(source: Source, options: StandaloneAudioDemuxOptions): Promise<MP4DemuxResult>;
