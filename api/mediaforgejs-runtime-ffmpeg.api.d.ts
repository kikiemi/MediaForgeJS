// The public API of 'mediaforgejs/runtime/ffmpeg', from its built declarations (npm run api:report).

export declare class FFmpegBackend {
    constructor(options?: FFmpegBackendOptions);
    capabilities(options?: FFmpegOperationOptions): Promise<FFmpegCapabilities>;
    probe(input: string | Source, options?: FFmpegProbeOptions): Promise<FFmpegProbeResult>;
    convert(input: string | Source, output: string | Sink, options: FFmpegConvertOptions): Promise<FFmpegConvertResult>;
    remux(input: string | Source, output: string | Sink, options: FFmpegRemuxOptions): Promise<FFmpegConvertResult>;
    exportDirectory(input: string | Source, destinationDirectory: string, options: FFmpegDirectoryOptions): Promise<FFmpegDirectoryResult>;
}

export interface FFmpegBackendOptions {
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
}

export interface FFmpegCapabilities {
    readonly version: string;
    readonly demuxers: readonly string[];
    readonly muxers: readonly string[];
    readonly decoders: readonly string[];
    readonly encoders: readonly string[];
}

export interface FFmpegConvertOptions extends FFmpegRemuxOptions {
    readonly videoCodec?: string;
    readonly audioCodec?: string;
    readonly subtitleCodec?: string;
    readonly videoBitrate?: number;
    readonly audioBitrate?: number;
    readonly audioSampleRate?: number;
    readonly audioChannels?: number;
    readonly videoWidth?: number;
    readonly videoHeight?: number;
    readonly videoFrameRate?: number;
    readonly videoPixelFormat?: string;
    readonly startTime?: number;
    readonly duration?: number;
}

export interface FFmpegConvertResult {
    readonly bytesWritten: number;
}

export interface FFmpegDirectoryFile {
    readonly name: string;
    readonly bytes: number;
}

export interface FFmpegDirectoryOptions extends Omit<FFmpegConvertOptions, 'format' | 'overwrite' | 'fragmentedMp4'> {
    readonly format: 'hls' | 'dash';
    readonly maxOutputBytes?: number;
    readonly segmentDuration?: number;
    readonly hlsSegmentType?: 'mpegts' | 'fmp4';
    readonly maxFiles?: number;
}

export interface FFmpegDirectoryResult {
    readonly directory: string;
    readonly manifestPath: string;
    readonly files: readonly FFmpegDirectoryFile[];
    readonly bytesWritten: number;
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

export interface FFmpegInputOptions extends FFmpegOperationOptions {
    readonly maxInputBytes?: number;
}

export interface FFmpegOperationOptions extends ProcessOptions {
}

export interface FFmpegProbeOptions extends FFmpegInputOptions {
    readonly maxProbeBytes?: number;
}

export interface FFmpegProbeResult {
    readonly streams: readonly FFmpegStreamInfo[];
    readonly format?: FFmpegFormatInfo;
}

export interface FFmpegRemuxOptions extends FFmpegInputOptions {
    readonly format: string;
    readonly streams?: readonly number[];
    readonly overwrite?: boolean;
    readonly fragmentedMp4?: boolean;
    readonly maxOutputBytes?: number;
}

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

// Types the exports reach without exporting them.

declare interface ProcessOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

declare interface Sink {
    readonly signal?: AbortSignal;
    write(data: Uint8Array): void;
    readonly copiesWrites?: boolean;
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
}

declare interface Source {
    read(offset: number, length: number): Promise<Uint8Array>;
    readonly size: number;
}
