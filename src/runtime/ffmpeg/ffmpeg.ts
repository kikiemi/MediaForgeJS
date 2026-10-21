import type { Source, Sink } from '../../core/model/types';
import {
    directoryMuxerArguments,
    withFFmpegDirectory,
    type DirectoryConfig,
    type DirectoryFiles,
    type DirectoryStat,
    type FFmpegDirectoryResult,
} from './ffmpeg-directory';
import { MediaForgeError } from '../../core/errors/errors';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import {
    FFmpegOperation,
    captureFFmpegProcess,
    runFFmpegProcess,
    formatError,
    integer,
    processOptions,
    type ProcessOptions,
} from './ffmpeg-process';

export interface FFmpegBackendOptions {
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
}

export interface FFmpegOperationOptions extends ProcessOptions {}

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
    /**
     * Final file size limit, or exact Sink delivery limit; defaults to 1 GiB. This does not cap
     * peak native disk usage.
     */
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

export interface FFmpegDirectoryOptions extends Omit<
    FFmpegConvertOptions,
    'format' | 'overwrite' | 'fragmentedMp4'
> {
    readonly format: 'hls' | 'dash';
    /**
     * Final aggregate resource bytes, including manifests and initialization; defaults to 1 GiB.
     */
    readonly maxOutputBytes?: number;
    /**
     * Target segment seconds; keyframe placement can make segments longer. Default 6, range
     * 0.1–3600.
     */
    readonly segmentDuration?: number;
    /** HLS only; defaults to mpegts. DASH always uses fragmented MP4. */
    readonly hlsSegmentType?: 'mpegts' | 'fmp4';
    /**
     * Final resource count, including manifests and initialization; default 10000, at most 100000.
     */
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

const DEFAULT_BYTES = 1024 * 1024 * 1024;
const MULTI_RESOURCE = new Set([
    'hls',
    'hds',
    'dash',
    'image2',
    'segment',
    'stream_segment',
    'ssegment',
    'webm_chunk',
    'webm_dash_manifest',
    'smoothstreaming',
    'tee',
    'fifo',
]);
const STREAMABLE = new Set([
    'matroska',
    'webm',
    'nut',
    'mpegts',
    'ogg',
    'opus',
    'mp3',
    'mp2',
    'adts',
    'flac',
    'ac3',
    'eac3',
    'dts',
    'amr',
    'au',
    'rawvideo',
    's16le',
    's16be',
    's24le',
    's24be',
    's32le',
    's32be',
    'f32le',
    'f32be',
    'f64le',
    'f64be',
    'alaw',
    'mulaw',
    'u8',
    's8',
    'image2pipe',
]);

/** The fields ffprobe reports of the input and of each stream. */
const PROBE_FORMAT_FIELDS = [
    'filename',
    'format_name',
    'format_long_name',
    'nb_streams',
    'start_time',
    'duration',
    'size',
    'bit_rate',
];
const PROBE_STREAM_FIELDS = [
    'index',
    'codec_name',
    'codec_long_name',
    'codec_type',
    'codec_tag_string',
    'profile',
    'width',
    'height',
    'pix_fmt',
    'sample_fmt',
    'sample_rate',
    'channels',
    'channel_layout',
    'time_base',
    'start_time',
    'duration',
    'bit_rate',
    'avg_frame_rate',
    'r_frame_rate',
    'nb_frames',
];
const PROBE_ENTRIES = [
    `format=${PROBE_FORMAT_FIELDS.join(',')}`,
    'format_tags',
    `stream=${PROBE_STREAM_FIELDS.join(',')}`,
    'stream_tags',
    'stream_disposition',
].join(':');

function token(value: string, name: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
        formatError(`${name} must be a host format or codec name`);
    return value;
}

function pathString(value: string, name: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
        formatError(`${name} must be a nonempty local path`);
    return value;
}

function boolean(value: boolean | undefined, name: string): boolean {
    if (value !== undefined && typeof value !== 'boolean') formatError(`${name} must be boolean`);
    return value ?? false;
}

function positive(
    value: number | undefined,
    name: string,
    max: number,
    allowZero = false,
): number | undefined {
    if (
        value !== undefined &&
        (typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value > max ||
            (allowZero ? value < 0 : value <= 0))
    ) {
        formatError(
            `${name} must be ${allowZero ? 'non-negative' : 'positive'} and at most ${max}`,
        );
    }
    return value;
}

function optionalInteger(value: number | undefined, name: string, max: number): number | undefined {
    return value === undefined ? undefined : integer(value, 0, name, 1, max);
}

function inputOptions(options: FFmpegInputOptions) {
    return {
        ...processOptions(options),
        maxInputBytes: integer(options.maxInputBytes, DEFAULT_BYTES, 'maxInputBytes'),
    };
}

function convertOptions(options: FFmpegConvertOptions, remux: boolean, directory = false) {
    const common = inputOptions(options);
    const format = token(options.format, 'format').toLowerCase();
    const suppliedStreams = options.streams;
    const suppliedOverwrite = options.overwrite;
    const suppliedFragmented = options.fragmentedMp4;

    if (directory && (suppliedOverwrite !== undefined || suppliedFragmented !== undefined))
        formatError('directory export does not accept overwrite or fragmentedMp4');
    const overwrite = boolean(suppliedOverwrite, 'overwrite');
    const fragmentedMp4 = boolean(suppliedFragmented, 'fragmentedMp4');
    const maxOutputBytes = integer(options.maxOutputBytes, DEFAULT_BYTES, 'maxOutputBytes');

    if (directory) {
        if (format !== 'hls' && format !== 'dash')
            formatError('directory format must be hls or dash');
    } else if (MULTI_RESOURCE.has(format))
        formatError('FFmpeg backend requires a single-resource output muxer');
    if (fragmentedMp4 && format !== 'mp4') formatError('fragmentedMp4 requires format mp4');

    let streams: number[] | undefined;
    if (suppliedStreams !== undefined) {
        if (!Array.isArray(suppliedStreams))
            formatError('streams must contain 1 to 1024 input indexes');
        const count = suppliedStreams.length;
        integer(count, 0, 'streams length', 1, 1024);
        streams = [];
        for (let index = 0; index < count; index++)
            streams.push(integer(suppliedStreams[index], NaN, 'stream index', 0, 2147483647));
        if (new Set(streams).size !== streams.length)
            formatError('streams must not contain duplicate indexes');
    }

    const args: string[] = [];
    if (!remux) {
        const videoCodec = options.videoCodec;
        const audioCodec = options.audioCodec;
        const subtitleCodec = options.subtitleCodec;
        const videoBitrate = optionalInteger(options.videoBitrate, 'videoBitrate', 2147483647);
        const audioBitrate = optionalInteger(options.audioBitrate, 'audioBitrate', 2147483647);
        const audioSampleRate = optionalInteger(options.audioSampleRate, 'audioSampleRate', 768000);
        const audioChannels = optionalInteger(options.audioChannels, 'audioChannels', 256);
        const videoWidth = optionalInteger(options.videoWidth, 'videoWidth', 65535);
        const videoHeight = optionalInteger(options.videoHeight, 'videoHeight', 65535);
        const videoFrameRate = positive(options.videoFrameRate, 'videoFrameRate', 1000);
        const videoPixelFormat = options.videoPixelFormat;

        if ((videoWidth === undefined) !== (videoHeight === undefined))
            formatError('videoWidth and videoHeight must be supplied together');
        if (
            (videoBitrate !== undefined ||
                videoWidth !== undefined ||
                videoFrameRate !== undefined ||
                videoPixelFormat !== undefined) &&
            (videoCodec === undefined || videoCodec === 'copy')
        )
            formatError('video settings require an explicit video encoder');
        if (
            (audioBitrate !== undefined ||
                audioSampleRate !== undefined ||
                audioChannels !== undefined) &&
            (audioCodec === undefined || audioCodec === 'copy')
        )
            formatError('audio settings require an explicit audio encoder');

        for (const [flag, value] of [
            ['-c:v', videoCodec],
            ['-c:a', audioCodec],
            ['-c:s', subtitleCodec],
            ['-pix_fmt', videoPixelFormat],
        ] as const) {
            if (value !== undefined) args.push(flag, token(value, flag));
        }
        for (const [flag, value] of [
            ['-b:v', videoBitrate],
            ['-b:a', audioBitrate],
            ['-ar', audioSampleRate],
            ['-ac', audioChannels],
            ['-r', videoFrameRate],
        ] as const) {
            if (value !== undefined) args.push(flag, String(value));
        }
        if (videoWidth !== undefined) args.push('-vf', `scale=${videoWidth}:${videoHeight}`);
    }

    const startTime = remux
        ? undefined
        : positive(options.startTime, 'startTime', Number.MAX_SAFE_INTEGER, true);
    const duration = remux
        ? undefined
        : positive(options.duration, 'duration', Number.MAX_SAFE_INTEGER);
    return {
        ...common,
        format,
        streams,
        overwrite,
        fragmentedMp4,
        maxOutputBytes,
        args,
        startTime,
        duration,
    };
}

function conversionArguments(
    inputPath: string,
    config: ReturnType<typeof convertOptions>,
): string[] {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (config.startTime !== undefined) args.push('-ss', String(config.startTime));
    args.push('-protocol_whitelist', 'file,pipe', '-i', inputPath);
    for (const stream of config.streams ?? ['all'])
        args.push('-map', stream === 'all' ? '0' : `0:${stream}`);
    args.push('-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', ...config.args);
    if (config.duration !== undefined) args.push('-t', String(config.duration));
    if (config.fragmentedMp4) args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    args.push('-f', config.format);
    return args;
}

interface Stat extends DirectoryStat {}

interface Handle {
    write(
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesWritten: number }>;
    close(): Promise<void>;
}

interface NativeFiles extends DirectoryFiles {
    stat(path: string): Promise<Stat>;
    open(path: string, flags: string): Promise<Handle>;
    mkdtemp(prefix: string): Promise<string>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
    readdir(path: string): Promise<string[]>;
    link(source: string, destination: string): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
}

interface NativePaths {
    resolve(path: string): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
}

async function nativeIO(): Promise<{
    fs: NativeFiles;
    path: NativePaths;
    tmpdir: string;
    platform: string;
}> {
    const filesName = 'node:fs/promises';
    const pathsName = 'node:path';
    const osName = 'node:os';
    const [fs, path, os] = await Promise.all([
        import(filesName),
        import(pathsName),
        import(osName),
    ]);
    const host = os as { tmpdir(): string; platform(): string };
    return {
        fs: fs as NativeFiles,
        path: path as NativePaths,
        tmpdir: host.tmpdir(),
        platform: host.platform(),
    };
}

function fileSize(stat: Stat, limit: number): number {
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new MediaForgeError(
            'FFmpeg input/output must be a regular file of a safe integer size',
            'IO',
        );
    if (stat.size > limit)
        throw new MediaForgeError('FFmpeg input/output exceeds its byte limit', 'IO');
    return stat.size;
}

function sourceSnapshot(
    input: string | Source,
): string | { size: number; read: Source['read']; receiver: Source } {
    if (typeof input === 'string') return pathString(input, 'input');
    if (!input || typeof input !== 'object')
        formatError('input must be a local filename or Source');
    const size = input.size;
    const read = input.read;
    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function')
        formatError('Source must have a valid size and read method');
    return { size, read, receiver: input };
}

function sinkSnapshot(
    output: string | Sink,
): string | { receiver: Sink; write: Sink['write']; drain: Sink['drain']; signal?: AbortSignal } {
    if (typeof output === 'string') return pathString(output, 'output');
    if (!output || typeof output !== 'object')
        formatError('output must be a local filename or Sink');
    const write = output.write;
    const drain = output.drain;
    const signal = output.signal;
    if (typeof write !== 'function' || (drain !== undefined && typeof drain !== 'function'))
        formatError('Sink must have write and an optional drain method');
    processOptions({ signal });
    return { receiver: output, write, drain, signal };
}

async function withInput<T>(
    input: ReturnType<typeof sourceSnapshot>,
    limit: number,
    operation: FFmpegOperation,
    use: (path: string, io: Awaited<ReturnType<typeof nativeIO>>) => Promise<T>,
): Promise<T> {
    operation.check();
    if (typeof input !== 'string' && input.size > limit)
        throw new MediaForgeError('Source exceeds maxInputBytes', 'IO');
    const io = await nativeIO();

    let directory: string | undefined;
    let handle: Handle | undefined;
    let failed = false;
    try {
        operation.check();
        let inputPath: string;
        if (typeof input === 'string') {
            inputPath = io.path.resolve(input);
            fileSize(await io.fs.stat(inputPath), limit);
            operation.check();
        } else {
            directory = await io.fs.mkdtemp(io.path.join(io.tmpdir, 'mediaforge-input-'));
            operation.check();
            inputPath = io.path.join(directory, 'input');
            handle = await io.fs.open(inputPath, 'wx');
            operation.check();

            for (let offset = 0; offset < input.size;) {
                const count = Math.min(262144, input.size - offset);
                const borrowed = await operation.wait(
                    input.read.call(input.receiver, offset, count),
                );
                assertSourceBytes(borrowed, count, 'FFmpeg Source');
                const bytes = new Uint8Array(borrowed);
                for (let position = 0; position < count;) {
                    const result = await handle.write(
                        bytes,
                        position,
                        count - position,
                        offset + position,
                    );
                    operation.check();
                    if (
                        !Number.isInteger(result.bytesWritten) ||
                        result.bytesWritten < 1 ||
                        result.bytesWritten > count - position
                    ) {
                        throw new MediaForgeError(
                            'FFmpeg input staging write made invalid progress',
                            'IO',
                        );
                    }
                    position += result.bytesWritten;
                }
                offset += count;
            }

            const closing = handle;
            handle = undefined;
            await closing.close();
            operation.check();
        }

        const result = await use(inputPath, io);
        return result;
    } catch (error) {
        failed = true;
        operation.fail(error);
        operation.check();
        throw error;
    } finally {
        let cleanupError: unknown;

        if (handle) {
            try {
                await handle.close();
            } catch (error) {
                cleanupError = error;
            }
        }

        if (directory) {
            try {
                await io.fs.rm(directory, { recursive: true, force: true });
            } catch (error) {
                cleanupError ??= error;
            }
        }

        if (!failed && cleanupError !== undefined) throw cleanupError;
    }
}

/**
 * Optional host FFmpeg/ffprobe backend for Node-compatible runtimes. No executable is bundled or
 * downloaded. Source inputs are staged to bounded temporary files for seeking. Source/Sink objects
 * remain borrowed. Input must be self-contained; maxInputBytes covers the supplied file, not
 * external references. Support depends on the installed binary and selected codecs/muxer. File
 * publication is atomic; cancellation after publication starts cannot undo it. Cancellation
 * terminates the direct child and its POSIX process group; detached descendants are not owned.
 */
export class FFmpegBackend {
    private readonly ffmpegPath: string;
    private readonly ffprobePath: string;
    constructor(options: FFmpegBackendOptions = {}) {
        const ffmpegPath = options.ffmpegPath;
        const ffprobePath = options.ffprobePath;
        this.ffmpegPath = pathString(ffmpegPath ?? 'ffmpeg', 'ffmpegPath');
        this.ffprobePath = pathString(ffprobePath ?? 'ffprobe', 'ffprobePath');
    }

    async capabilities(options: FFmpegOperationOptions = {}): Promise<FFmpegCapabilities> {
        const operation = new FFmpegOperation(processOptions(options));
        try {
            const version = (
                await captureFFmpegProcess(
                    this.ffmpegPath,
                    ['-version'],
                    operation,
                    4 * 1024 * 1024,
                )
            ).split(/\r?\n/, 1)[0];

            const values: string[][] = [];
            for (const kind of ['demuxers', 'muxers', 'decoders', 'encoders']) {
                const listing = await captureFFmpegProcess(
                    this.ffmpegPath,
                    ['-hide_banner', `-${kind}`],
                    operation,
                    4 * 1024 * 1024,
                );
                const names = new Set<string>();
                for (const line of listing.split(/\r?\n/)) {
                    const match = /^\s+[DVEAS.][A-Z. ]{0,5}\s+(\S+)\s+/.exec(line);
                    if (match && match[1] !== '=')
                        for (const name of match[1].split(',')) names.add(name);
                }
                values.push([...names].sort());
            }

            operation.check();
            return {
                version,
                demuxers: values[0],
                muxers: values[1],
                decoders: values[2],
                encoders: values[3],
            };
        } finally {
            operation.dispose();
        }
    }

    async probe(
        input: string | Source,
        options: FFmpegProbeOptions = {},
    ): Promise<FFmpegProbeResult> {
        const config = inputOptions(options);
        const maxProbeBytes = integer(options.maxProbeBytes, 4 * 1024 * 1024, 'maxProbeBytes', 1);
        const source = sourceSnapshot(input);
        const operation = new FFmpegOperation(config);
        try {
            const result = await withInput(source, config.maxInputBytes, operation, async path => {
                const json = await captureFFmpegProcess(
                    this.ffprobePath,
                    [
                        '-v',
                        'error',
                        '-protocol_whitelist',
                        'file,pipe',
                        '-show_entries',
                        PROBE_ENTRIES,
                        '-of',
                        'json',
                        '-i',
                        path,
                    ],
                    operation,
                    maxProbeBytes,
                );

                let value: FFmpegProbeResult;
                try {
                    value = JSON.parse(json) as FFmpegProbeResult;
                } catch {
                    throw new MediaForgeError('ffprobe returned invalid JSON', 'IO');
                }

                if (
                    !value ||
                    !Array.isArray(value.streams) ||
                    value.streams.some(stream => !stream || !Number.isSafeInteger(stream.index))
                ) {
                    throw new MediaForgeError('ffprobe returned invalid stream information', 'IO');
                }
                operation.check();
                return value;
            });
            operation.check();
            return result;
        } finally {
            operation.dispose();
        }
    }

    async convert(
        input: string | Source,
        output: string | Sink,
        options: FFmpegConvertOptions,
    ): Promise<FFmpegConvertResult> {
        return this.convertConfigured(input, output, convertOptions(options, false));
    }

    async remux(
        input: string | Source,
        output: string | Sink,
        options: FFmpegRemuxOptions,
    ): Promise<FFmpegConvertResult> {
        return this.convertConfigured(input, output, convertOptions(options, true));
    }

    /** Exports a completed local VOD package into a new directory, reserved empty while work runs.
     * Resources and references are validated before publication; manifest metadata is limited to 8
     * MiB. maxOutputBytes/maxFiles limit the accepted package, not peak native disk usage. Callers
     * must not modify the destination or its parent concurrently. Source remains borrowed. Windows
     * releases the empty reservation immediately before the final atomic rename.
     */
    async exportDirectory(
        input: string | Source,
        destinationDirectory: string,
        options: FFmpegDirectoryOptions,
    ): Promise<FFmpegDirectoryResult> {
        const config = convertOptions(options, false, true);
        const segmentDuration = positive(options.segmentDuration, 'segmentDuration', 3600) ?? 6;
        if (segmentDuration < 0.1) formatError('segmentDuration must be at least 0.1 seconds');

        const suppliedType = options.hlsSegmentType;
        if (
            suppliedType !== undefined &&
            (config.format !== 'hls' || (suppliedType !== 'mpegts' && suppliedType !== 'fmp4'))
        ) {
            formatError('hlsSegmentType requires HLS and must be mpegts or fmp4');
        }

        const directory: DirectoryConfig = {
            format: config.format as 'hls' | 'dash',
            segmentDuration,
            hlsSegmentType: suppliedType ?? 'mpegts',
            maxFiles: integer(options.maxFiles, 10000, 'maxFiles', 1, 100000),
            maxOutputBytes: config.maxOutputBytes,
        };

        const destination = pathString(destinationDirectory, 'destinationDirectory');
        const source = sourceSnapshot(input);
        const operation = new FFmpegOperation(config);
        try {
            operation.check();
            const io = await nativeIO();
            operation.check();
            return await withFFmpegDirectory(destination, io, directory, operation, async stage => {
                await withInput(source, config.maxInputBytes, operation, async inputPath => {
                    const args = [
                        ...conversionArguments(inputPath, config),
                        ...directoryMuxerArguments(directory),
                    ];
                    const executable = /[\\/]/.test(this.ffmpegPath)
                        ? io.path.resolve(this.ffmpegPath)
                        : this.ffmpegPath;
                    await runFFmpegProcess(
                        executable,
                        args,
                        operation,
                        async () => undefined,
                        stage,
                    );
                });
            });
        } finally {
            operation.dispose();
        }
    }

    private async convertConfigured(
        input: string | Source,
        output: string | Sink,
        config: ReturnType<typeof convertOptions>,
    ): Promise<FFmpegConvertResult> {
        const source = sourceSnapshot(input);
        const destination = sinkSnapshot(output);
        if (
            typeof destination !== 'string' &&
            !STREAMABLE.has(config.format) &&
            !(config.format === 'mp4' && config.fragmentedMp4)
        ) {
            formatError('Sink output needs a streamable format, such as fragmented MP4');
        }
        if (typeof destination !== 'string' && config.overwrite)
            formatError('overwrite applies only to file output');

        const operation = new FFmpegOperation(
            config,
            typeof destination === 'string' ? undefined : destination.signal,
        );
        try {
            const result = await withInput(
                source,
                config.maxInputBytes,
                operation,
                async (inputPath, io) => {
                    const args = conversionArguments(inputPath, config);
                    if (typeof destination !== 'string') {
                        let bytesWritten = 0;
                        await runFFmpegProcess(
                            this.ffmpegPath,
                            [...args, 'pipe:1'],
                            operation,
                            async bytes => {
                                if (bytes.byteLength > config.maxOutputBytes - bytesWritten)
                                    throw new MediaForgeError(
                                        'FFmpeg output exceeds maxOutputBytes',
                                        'IO',
                                    );
                                const owned = new Uint8Array(bytes);
                                destination.write.call(destination.receiver, owned);
                                operation.check();
                                bytesWritten += owned.byteLength;
                                if (destination.drain)
                                    await operation.wait(
                                        destination.drain.call(destination.receiver),
                                    );
                            },
                        );
                        operation.check();
                        return { bytesWritten };
                    }

                    const target = io.path.resolve(destination);
                    if (target === inputPath)
                        formatError('output must not overwrite the input file');
                    let existing: Stat | undefined;
                    try {
                        existing = await io.fs.stat(target);
                    } catch (error) {
                        if ((error as { code?: string })?.code !== 'ENOENT') throw error;
                    }
                    operation.check();
                    if (existing) {
                        const inputStat = await io.fs.stat(inputPath);
                        operation.check();
                        if (inputStat.dev === existing.dev && inputStat.ino === existing.ino)
                            formatError('output must not alias the input file');
                        if (!config.overwrite)
                            throw new MediaForgeError('FFmpeg output already exists', 'IO', {
                                hint: 'Set overwrite to replace it.',
                            });
                        fileSize(existing, Number.MAX_SAFE_INTEGER);
                    }

                    let directory: string | undefined;
                    let failed = false;
                    try {
                        directory = await io.fs.mkdtemp(
                            io.path.join(io.path.dirname(target), '.mediaforge-'),
                        );
                        operation.check();
                        const staged = io.path.join(directory, 'output');
                        await runFFmpegProcess(
                            this.ffmpegPath,
                            [...args, staged],
                            operation,
                            async () => undefined,
                        );

                        const entries = await io.fs.readdir(directory);
                        operation.check();
                        if (entries.length !== 1 || entries[0] !== 'output')
                            throw new MediaForgeError(
                                'FFmpeg muxer generated multiple resources',
                                'IO',
                            );
                        const bytesWritten = fileSize(
                            await io.fs.stat(staged),
                            config.maxOutputBytes,
                        );
                        operation.check();
                        if (config.overwrite) await io.fs.rename(staged, target);
                        else await io.fs.link(staged, target);
                        return { bytesWritten };
                    } catch (error) {
                        failed = true;
                        operation.fail(error);
                        operation.check();
                        throw error;
                    } finally {
                        if (directory) {
                            try {
                                await io.fs.rm(directory, { recursive: true, force: true });
                            } catch (error) {
                                if (!failed) throw error;
                            }
                        }
                    }
                },
            );
            if (typeof destination !== 'string') operation.check();
            return result;
        } finally {
            operation.dispose();
        }
    }
}
