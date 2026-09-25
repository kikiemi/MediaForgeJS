import type { PcmAudioBuffer } from '../types/media.js';
import type { MpegAudioFormat } from './mpeg-audio-types.js';
/** Configuration for MpegAudioEncoder (format, bitrate, VBR, signal, progress). */
export interface MpegAudioEncoderConfig {
    /** AbortSignal that cancels the operation. */
    readonly signal?: AbortSignal;
    /** Target audio bitrate in bps (0 = format default). */
    readonly audioBitrate?: number;
    /** Enables VBR MP3 output. */
    readonly audioVbr?: boolean;
    /** Target sample rate in Hz (0 = keep source). */
    readonly audioSampleRate?: number;
    /** Target channel count (0 = keep source). */
    readonly audioChannels?: number;
    /** Progress callback. */
    readonly onProgress?: (progress: number, message: string) => void;
}
/** Result of prepareMpegAudioBuffer: resampled PCM plus the resolved encode parameters. */
export interface PreparedMpegAudioBuffer {
    /** Prepared PCM at the resolved rate and channel count. */
    readonly audioBuffer: PcmAudioBuffer;
    /** Resolved legal bitrate in kbps. */
    readonly bitrate: number;
    /** Peak amplitude before preparation. */
    readonly sourcePeak: number;
    /** Peak amplitude after preparation. */
    readonly preparedPeak: number;
    /** Gain applied to keep peaks in range. */
    readonly appliedGain: number;
}
/** Clamp/resolve a requested bitrate to the nearest legal MPEG audio bitrate for the format. */
export declare function resolveMpegAudioBitrate(format: MpegAudioFormat, audioBitrate: number | undefined, channels: number): number;
export declare function applyMpegAudioPeakHeadroom(audioBuffer: PcmAudioBuffer, targetPeak: number): {
    readonly sourcePeak: number;
    readonly preparedPeak: number;
    readonly appliedGain: number;
    readonly audioBuffer: PcmAudioBuffer;
};
/** Resample/downmix a PCM buffer to a rate and channel count the target MPEG format accepts. */
export declare function prepareMpegAudioBuffer(audioBuffer: PcmAudioBuffer, format: MpegAudioFormat, config?: MpegAudioEncoderConfig): Promise<PreparedMpegAudioBuffer>;
/** MP3/MP2 encode orchestrator: prepares PCM, prefers the worker, falls back to cancellable on-thread encoding. */
export declare class MpegAudioEncoder {
    private readonly config;
    constructor(config?: MpegAudioEncoderConfig);
    private checkAbort;
    /** Encodes the PCM buffer to MP3/MP2 (worker when available, cancellable on-thread otherwise) and returns the file as a Blob. */
    encode(audioBuffer: PcmAudioBuffer, format: MpegAudioFormat): Promise<Blob>;
    private encodeLocal;
    private reportEncodingProgress;
    private report;
}
