import type { Source, Sink } from '../types/io.js';
import { type FFmpegDirectoryResult } from './ffmpeg-directory.js';
export type { FFmpegDirectoryFile, FFmpegDirectoryResult } from './ffmpeg-directory.js';
import { type ProcessOptions } from './ffmpeg-process.js';
export interface FFmpegBackendOptions {
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
}
export interface FFmpegOperationOptions extends ProcessOptions {
}
export interface FFmpegInputOptions extends FFmpegOperationOptions {
    /** Maximum input file or staged Source bytes; defaults to 1 GiB. */
    readonly maxInputBytes?: number;
}
export interface FFmpegProbeOptions extends FFmpegInputOptions {
    /** Maximum ffprobe JSON bytes; defaults to 4 MiB. */
    readonly maxProbeBytes?: number;
}
export interface FFmpegRemuxOptions extends FFmpegInputOptions {
    /** Host muxer name. Multi-resource muxers are not supported. */
    readonly format: string;
    /** Input stream indexes, in output order; defaults to all streams. */
    readonly streams?: readonly number[];
    /** Replace a destination file only after successful conversion; defaults to false. */
    readonly overwrite?: boolean;
    /** Enable fragmented MP4; required for MP4 Sink output. */
    readonly fragmentedMp4?: boolean;
    /** Final file size limit, or exact Sink delivery limit; defaults to 1 GiB. This does not cap peak native disk usage. */
    readonly maxOutputBytes?: number;
}
export interface FFmpegConvertOptions extends FFmpegRemuxOptions {
    /** Host encoder names, or 'copy'. Unspecified codecs are copied. */
    readonly videoCodec?: string;
    readonly audioCodec?: string;
    readonly subtitleCodec?: string;
    /** Bits per second. */
    readonly videoBitrate?: number;
    readonly audioBitrate?: number;
    readonly audioSampleRate?: number;
    readonly audioChannels?: number;
    /** Both dimensions are required for scaling. */
    readonly videoWidth?: number;
    readonly videoHeight?: number;
    readonly videoFrameRate?: number;
    readonly videoPixelFormat?: string;
    /** Input seek offset and output duration, in seconds. */
    readonly startTime?: number;
    readonly duration?: number;
}
export interface FFmpegDirectoryOptions extends Omit<FFmpegConvertOptions, 'format' | 'overwrite' | 'fragmentedMp4'> {
    readonly format: 'hls' | 'dash';
    /** Final aggregate resource bytes, including manifests and initialization; defaults to 1 GiB. */
    readonly maxOutputBytes?: number;
    /** Target segment seconds; keyframe placement can make segments longer. Default 6, range 0.1–3600. */
    readonly segmentDuration?: number;
    /** HLS only; defaults to mpegts. DASH always uses fragmented MP4. */
    readonly hlsSegmentType?: 'mpegts' | 'fmp4';
    /** Final resource count, including manifests and initialization; default 10000, at most 100000. */
    readonly maxFiles?: number;
}
export interface FFmpegCapabilities {
    readonly version: string;
    readonly demuxers: readonly string[];
    readonly muxers: readonly string[];
    readonly decoders: readonly string[];
    readonly encoders: readonly string[];
}
/** ffprobe fields retain their native names and units; unavailable fields are omitted. */
export interface FFmpegStreamInfo {
    readonly index: number;
    readonly codec_name?: string;
    readonly codec_long_name?: string;
    readonly codec_type?: string;
    readonly codec_tag_string?: string;
    readonly profile?: string;
    readonly width?: number;
    readonly height?: number;
    readonly pix_fmt?: string;
    readonly sample_fmt?: string;
    readonly sample_rate?: string;
    readonly channels?: number;
    readonly channel_layout?: string;
    readonly time_base?: string;
    readonly start_time?: string;
    readonly duration?: string;
    readonly bit_rate?: string;
    readonly avg_frame_rate?: string;
    readonly r_frame_rate?: string;
    readonly nb_frames?: string;
    readonly tags?: Record<string, string>;
    readonly disposition?: Record<string, number>;
}
export interface FFmpegFormatInfo {
    readonly filename?: string;
    readonly format_name?: string;
    readonly format_long_name?: string;
    readonly nb_streams?: number;
    readonly start_time?: string;
    readonly duration?: string;
    readonly size?: string;
    readonly bit_rate?: string;
    readonly tags?: Record<string, string>;
}
export interface FFmpegProbeResult {
    readonly streams: readonly FFmpegStreamInfo[];
    readonly format?: FFmpegFormatInfo;
}
export interface FFmpegConvertResult {
    readonly bytesWritten: number;
}
/** Optional host FFmpeg/ffprobe backend for Node-compatible runtimes. No executable is bundled or downloaded.
 * Source inputs are staged to bounded temporary files for seeking. Source/Sink objects remain borrowed.
 * Input must be self-contained; maxInputBytes covers the supplied file, not external references.
 * Support depends on the installed binary and selected codecs/muxer.
 * File publication is atomic; cancellation after publication starts cannot undo it.
 * Cancellation terminates the direct child and its POSIX process group; detached descendants are not owned.
 */
export declare class FFmpegBackend {
    private readonly ffmpegPath;
    private readonly ffprobePath;
    constructor(options?: FFmpegBackendOptions);
    capabilities(options?: FFmpegOperationOptions): Promise<FFmpegCapabilities>;
    probe(input: string | Source, options?: FFmpegProbeOptions): Promise<FFmpegProbeResult>;
    convert(input: string | Source, output: string | Sink, options: FFmpegConvertOptions): Promise<FFmpegConvertResult>;
    remux(input: string | Source, output: string | Sink, options: FFmpegRemuxOptions): Promise<FFmpegConvertResult>;
    /** Exports a completed local VOD package into a new directory, reserved empty while work runs.
     * Resources and references are validated before publication; manifest metadata is limited to 8 MiB.
     * maxOutputBytes/maxFiles limit the accepted package, not peak native disk usage.
     * Callers must not modify the destination or its parent concurrently. Source remains borrowed.
     * Windows releases the empty reservation immediately before the final atomic rename.
     */
    exportDirectory(input: string | Source, destinationDirectory: string, options: FFmpegDirectoryOptions): Promise<FFmpegDirectoryResult>;
    private convertConfigured;
}
