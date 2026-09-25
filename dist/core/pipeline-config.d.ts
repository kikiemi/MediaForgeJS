import type { OutputContainerFormat } from '../types/media.js';
import type { MetadataPolicy } from './diagnostics.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
export interface PipelineConfig {
    /** Optional metadata loss warns by default; error rejects known losses before output. */
    metadataPolicy?: MetadataPolicy;
    /** Colour description copied at construction; omitted = carry the source value. */
    videoColour?: {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    };
    /** Explicit audio language tag; omitted = carry the source value. */
    audioLanguage?: string;
    /** Explicit video language tag; omitted = carry the source value. */
    videoLanguage?: string;
    /** Verbatim udta payload copied at construction and appended to MP4 moov. */
    moovUserData?: Uint8Array;
    /** Explicit source audio track selection. */
    audioTrackIndex?: number;
    /** True when videoCodec came from the caller (explicit values veto copy plans). */
    videoCodecUserSet?: boolean;
    /** True when audioCodec came from the caller (explicit values veto copy plans). */
    audioCodecUserSet?: boolean;
    /** The exact codec string the caller asked for, kept for satisfies-checks. */
    videoCodecRequested?: string;
    /** The exact codec string the caller asked for, kept for satisfies-checks. */
    audioCodecRequested?: string;
    /** Reuse of an analysis-time demux result (avoids parsing broken inputs twice). */
    preDemuxed?: MP4DemuxResult;
    /** The analysis-time demux failure to re-throw instead of parsing again. */
    preDemuxedError?: unknown;
    /** Permits the media-element fallback when the native pipeline cannot run. */
    allowDomFallback?: boolean;
    /** Target container format. */
    outputFormat: OutputContainerFormat;
    /** Resolved video codec; empty keeps a target-compatible source codec, otherwise uses the plan default. */
    videoCodec: string;
    /** Resolved audio codec; empty keeps a target-compatible source codec, otherwise uses the plan default. */
    audioCodec: string;
    /** Target width in pixels; 0 = keep the source value. */
    width: number;
    /** Target height in pixels; 0 = keep the source value. */
    height: number;
    /** Target frame rate; 0 = keep the source value. */
    fps: number;
    /** Target video bitrate in bps; 0 = format default. */
    videoBitrate: number;
    /** Target audio bitrate in bps; 0 = format default. */
    audioBitrate: number;
    /** Target sample rate in Hz; 0 = keep the source value. */
    audioSampleRate: number;
    /** Target channel count; 0 = keep the source value. */
    audioChannels: number;
    /** AbortSignal that cancels the run. */
    signal?: AbortSignal;
    /** (percent, message) called as the run advances. */
    onProgress?: (pct: number, msg: string) => void;
}
export declare function normalizePipelineConfig(input: PipelineConfig): PipelineConfig;
