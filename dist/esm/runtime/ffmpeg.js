import { directoryMuxerArguments, withFFmpegDirectory, } from './ffmpeg-directory.js';
import { MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from '../io/source-read.js';
import { FFmpegOperation, captureFFmpegProcess, runFFmpegProcess, formatError, integer, processOptions, } from './ffmpeg-process.js';
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
const PROBE_ENTRIES = 'format=filename,format_name,format_long_name,nb_streams,start_time,duration,size,bit_rate:format_tags:' +
    'stream=index,codec_name,codec_long_name,codec_type,codec_tag_string,profile,width,height,pix_fmt,sample_fmt,sample_rate,channels,channel_layout,time_base,start_time,duration,bit_rate,avg_frame_rate,r_frame_rate,nb_frames:stream_tags:stream_disposition';
function token(value, name) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
        formatError(`${name} must be a host format or codec name`);
    return value;
}
function pathString(value, name) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
        formatError(`${name} must be a nonempty local path`);
    return value;
}
function boolean(value, name) {
    if (value !== undefined && typeof value !== 'boolean')
        formatError(`${name} must be boolean`);
    return value ?? false;
}
function positive(value, name, max, allowZero = false) {
    if (value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value > max || (allowZero ? value < 0 : value <= 0))) {
        formatError(`${name} must be ${allowZero ? 'non-negative' : 'positive'} and at most ${max}`);
    }
    return value;
}
function optionalInteger(value, name, max) {
    return value === undefined ? undefined : integer(value, 0, name, 1, max);
}
function inputOptions(options) {
    return {
        ...processOptions(options),
        maxInputBytes: integer(options.maxInputBytes, DEFAULT_BYTES, 'maxInputBytes'),
    };
}
function convertOptions(options, remux, directory = false) {
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
    }
    else if (MULTI_RESOURCE.has(format))
        formatError('FFmpeg backend requires a single-resource output muxer');
    if (fragmentedMp4 && format !== 'mp4')
        formatError('fragmentedMp4 requires format mp4');
    let streams;
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
    const args = [];
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
        if ((videoBitrate !== undefined ||
            videoWidth !== undefined ||
            videoFrameRate !== undefined ||
            videoPixelFormat !== undefined) &&
            (videoCodec === undefined || videoCodec === 'copy'))
            formatError('video settings require an explicit video encoder');
        if ((audioBitrate !== undefined || audioSampleRate !== undefined || audioChannels !== undefined) &&
            (audioCodec === undefined || audioCodec === 'copy'))
            formatError('audio settings require an explicit audio encoder');
        for (const [flag, value] of [
            ['-c:v', videoCodec],
            ['-c:a', audioCodec],
            ['-c:s', subtitleCodec],
            ['-pix_fmt', videoPixelFormat],
        ]) {
            if (value !== undefined)
                args.push(flag, token(value, flag));
        }
        for (const [flag, value] of [
            ['-b:v', videoBitrate],
            ['-b:a', audioBitrate],
            ['-ar', audioSampleRate],
            ['-ac', audioChannels],
            ['-r', videoFrameRate],
        ]) {
            if (value !== undefined)
                args.push(flag, String(value));
        }
        if (videoWidth !== undefined)
            args.push('-vf', `scale=${videoWidth}:${videoHeight}`);
    }
    const startTime = remux ? undefined : positive(options.startTime, 'startTime', Number.MAX_SAFE_INTEGER, true);
    const duration = remux ? undefined : positive(options.duration, 'duration', Number.MAX_SAFE_INTEGER);
    return { ...common, format, streams, overwrite, fragmentedMp4, maxOutputBytes, args, startTime, duration };
}
function conversionArguments(inputPath, config) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (config.startTime !== undefined)
        args.push('-ss', String(config.startTime));
    args.push('-protocol_whitelist', 'file,pipe', '-i', inputPath);
    for (const stream of config.streams ?? ['all'])
        args.push('-map', stream === 'all' ? '0' : `0:${stream}`);
    args.push('-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', ...config.args);
    if (config.duration !== undefined)
        args.push('-t', String(config.duration));
    if (config.fragmentedMp4)
        args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    args.push('-f', config.format);
    return args;
}
async function nativeIO() {
    const filesName = 'node:fs/promises';
    const pathsName = 'node:path';
    const osName = 'node:os';
    const [fs, path, os] = await Promise.all([import(filesName), import(pathsName), import(osName)]);
    const host = os;
    return { fs: fs, path: path, tmpdir: host.tmpdir(), platform: host.platform() };
}
function fileSize(stat, limit) {
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new MediaForgeError('FFmpeg input/output must be a regular file of a safe integer size', 'IO');
    if (stat.size > limit)
        throw new MediaForgeError('FFmpeg input/output exceeds its byte limit', 'IO');
    return stat.size;
}
function sourceSnapshot(input) {
    if (typeof input === 'string')
        return pathString(input, 'input');
    if (!input || typeof input !== 'object')
        formatError('input must be a local filename or Source');
    const size = input.size;
    const read = input.read;
    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function')
        formatError('Source must have a valid size and read method');
    return { size, read, receiver: input };
}
function sinkSnapshot(output) {
    if (typeof output === 'string')
        return pathString(output, 'output');
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
async function withInput(input, limit, operation, use) {
    operation.check();
    if (typeof input !== 'string' && input.size > limit)
        throw new MediaForgeError('Source exceeds maxInputBytes', 'IO');
    const io = await nativeIO();
    let directory;
    let handle;
    let failed = false;
    try {
        operation.check();
        let inputPath;
        if (typeof input === 'string') {
            inputPath = io.path.resolve(input);
            fileSize(await io.fs.stat(inputPath), limit);
            operation.check();
        }
        else {
            directory = await io.fs.mkdtemp(io.path.join(io.tmpdir, 'mediaforge-input-'));
            operation.check();
            inputPath = io.path.join(directory, 'input');
            handle = await io.fs.open(inputPath, 'wx');
            operation.check();
            for (let offset = 0; offset < input.size;) {
                const count = Math.min(262144, input.size - offset);
                const borrowed = await operation.wait(input.read.call(input.receiver, offset, count));
                assertSourceBytes(borrowed, count, 'FFmpeg Source');
                const bytes = new Uint8Array(borrowed);
                for (let position = 0; position < count;) {
                    const result = await handle.write(bytes, position, count - position, offset + position);
                    operation.check();
                    if (!Number.isInteger(result.bytesWritten) ||
                        result.bytesWritten < 1 ||
                        result.bytesWritten > count - position) {
                        throw new MediaForgeError('FFmpeg input staging write made invalid progress', 'IO');
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
    }
    catch (error) {
        failed = true;
        operation.fail(error);
        operation.check();
        throw error;
    }
    finally {
        let cleanupError;
        if (handle) {
            try {
                await handle.close();
            }
            catch (error) {
                cleanupError = error;
            }
        }
        if (directory) {
            try {
                await io.fs.rm(directory, { recursive: true, force: true });
            }
            catch (error) {
                cleanupError ??= error;
            }
        }
        if (!failed && cleanupError !== undefined)
            throw cleanupError;
    }
}
export class FFmpegBackend {
    ffmpegPath;
    ffprobePath;
    constructor(options = {}) {
        const ffmpegPath = options.ffmpegPath;
        const ffprobePath = options.ffprobePath;
        this.ffmpegPath = pathString(ffmpegPath ?? 'ffmpeg', 'ffmpegPath');
        this.ffprobePath = pathString(ffprobePath ?? 'ffprobe', 'ffprobePath');
    }
    async capabilities(options = {}) {
        const operation = new FFmpegOperation(processOptions(options));
        try {
            const version = (await captureFFmpegProcess(this.ffmpegPath, ['-version'], operation, 4 * 1024 * 1024)).split(/\r?\n/, 1)[0];
            const values = [];
            for (const kind of ['demuxers', 'muxers', 'decoders', 'encoders']) {
                const listing = await captureFFmpegProcess(this.ffmpegPath, ['-hide_banner', `-${kind}`], operation, 4 * 1024 * 1024);
                const names = new Set();
                for (const line of listing.split(/\r?\n/)) {
                    const match = /^\s+[DVEAS.][A-Z. ]{0,5}\s+(\S+)\s+/.exec(line);
                    if (match && match[1] !== '=')
                        for (const name of match[1].split(','))
                            names.add(name);
                }
                values.push([...names].sort());
            }
            operation.check();
            return { version, demuxers: values[0], muxers: values[1], decoders: values[2], encoders: values[3] };
        }
        finally {
            operation.dispose();
        }
    }
    async probe(input, options = {}) {
        const config = inputOptions(options);
        const maxProbeBytes = integer(options.maxProbeBytes, 4 * 1024 * 1024, 'maxProbeBytes', 1);
        const source = sourceSnapshot(input);
        const operation = new FFmpegOperation(config);
        try {
            const result = await withInput(source, config.maxInputBytes, operation, async (path) => {
                const json = await captureFFmpegProcess(this.ffprobePath, [
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
                ], operation, maxProbeBytes);
                let value;
                try {
                    value = JSON.parse(json);
                }
                catch {
                    throw new MediaForgeError('ffprobe returned invalid JSON', 'IO');
                }
                if (!value ||
                    !Array.isArray(value.streams) ||
                    value.streams.some(stream => !stream || !Number.isSafeInteger(stream.index))) {
                    throw new MediaForgeError('ffprobe returned invalid stream information', 'IO');
                }
                operation.check();
                return value;
            });
            operation.check();
            return result;
        }
        finally {
            operation.dispose();
        }
    }
    async convert(input, output, options) {
        return this.convertConfigured(input, output, convertOptions(options, false));
    }
    async remux(input, output, options) {
        return this.convertConfigured(input, output, convertOptions(options, true));
    }
    async exportDirectory(input, destinationDirectory, options) {
        const config = convertOptions(options, false, true);
        const segmentDuration = positive(options.segmentDuration, 'segmentDuration', 3600) ?? 6;
        if (segmentDuration < 0.1)
            formatError('segmentDuration must be at least 0.1 seconds');
        const suppliedType = options.hlsSegmentType;
        if (suppliedType !== undefined &&
            (config.format !== 'hls' || (suppliedType !== 'mpegts' && suppliedType !== 'fmp4'))) {
            formatError('hlsSegmentType requires HLS and must be mpegts or fmp4');
        }
        const directory = {
            format: config.format,
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
            return await withFFmpegDirectory(destination, io, directory, operation, async (stage) => {
                await withInput(source, config.maxInputBytes, operation, async (inputPath) => {
                    const args = [...conversionArguments(inputPath, config), ...directoryMuxerArguments(directory)];
                    const executable = /[\\/]/.test(this.ffmpegPath)
                        ? io.path.resolve(this.ffmpegPath)
                        : this.ffmpegPath;
                    await runFFmpegProcess(executable, args, operation, async () => undefined, stage);
                });
            });
        }
        finally {
            operation.dispose();
        }
    }
    async convertConfigured(input, output, config) {
        const source = sourceSnapshot(input);
        const destination = sinkSnapshot(output);
        if (typeof destination !== 'string' &&
            !STREAMABLE.has(config.format) &&
            !(config.format === 'mp4' && config.fragmentedMp4)) {
            formatError('Sink output requires a supported streamable muxer (MP4 requires fragmentedMp4)');
        }
        if (typeof destination !== 'string' && config.overwrite)
            formatError('overwrite applies only to file output');
        const operation = new FFmpegOperation(config, typeof destination === 'string' ? undefined : destination.signal);
        try {
            const result = await withInput(source, config.maxInputBytes, operation, async (inputPath, io) => {
                const args = conversionArguments(inputPath, config);
                if (typeof destination !== 'string') {
                    let bytesWritten = 0;
                    await runFFmpegProcess(this.ffmpegPath, [...args, 'pipe:1'], operation, async (bytes) => {
                        if (bytes.byteLength > config.maxOutputBytes - bytesWritten)
                            throw new MediaForgeError('FFmpeg output exceeds maxOutputBytes', 'IO');
                        const owned = new Uint8Array(bytes);
                        destination.write.call(destination.receiver, owned);
                        operation.check();
                        bytesWritten += owned.byteLength;
                        if (destination.drain)
                            await operation.wait(destination.drain.call(destination.receiver));
                    });
                    operation.check();
                    return { bytesWritten };
                }
                const target = io.path.resolve(destination);
                if (target === inputPath)
                    formatError('output must not overwrite the input file');
                let existing;
                try {
                    existing = await io.fs.stat(target);
                }
                catch (error) {
                    if (error?.code !== 'ENOENT')
                        throw error;
                }
                operation.check();
                if (existing) {
                    const inputStat = await io.fs.stat(inputPath);
                    operation.check();
                    if (inputStat.dev === existing.dev && inputStat.ino === existing.ino)
                        formatError('output must not alias the input file');
                    if (!config.overwrite)
                        throw new MediaForgeError('FFmpeg output already exists; set overwrite to replace it', 'IO');
                    fileSize(existing, Number.MAX_SAFE_INTEGER);
                }
                let directory;
                let failed = false;
                try {
                    directory = await io.fs.mkdtemp(io.path.join(io.path.dirname(target), '.mediaforge-'));
                    operation.check();
                    const staged = io.path.join(directory, 'output');
                    await runFFmpegProcess(this.ffmpegPath, [...args, staged], operation, async () => undefined);
                    const entries = await io.fs.readdir(directory);
                    operation.check();
                    if (entries.length !== 1 || entries[0] !== 'output')
                        throw new MediaForgeError('FFmpeg muxer generated multiple resources', 'IO');
                    const bytesWritten = fileSize(await io.fs.stat(staged), config.maxOutputBytes);
                    operation.check();
                    if (config.overwrite)
                        await io.fs.rename(staged, target);
                    else
                        await io.fs.link(staged, target);
                    return { bytesWritten };
                }
                catch (error) {
                    failed = true;
                    operation.fail(error);
                    operation.check();
                    throw error;
                }
                finally {
                    if (directory) {
                        try {
                            await io.fs.rm(directory, { recursive: true, force: true });
                        }
                        catch (error) {
                            if (!failed)
                                throw error;
                        }
                    }
                }
            });
            if (typeof destination !== 'string')
                operation.check();
            return result;
        }
        finally {
            operation.dispose();
        }
    }
}
