import { MediaForgeError } from '../../core/errors/errors';
import { parseHlsPlaylist } from '../../formats/hls/playlist';
import { parseDashManifest } from '../../formats/dash/mpd';
import { iterateDashSegments } from '../../formats/dash/segments';
import type { FFmpegOperation } from './ffmpeg-process';

export interface FFmpegDirectoryFile {
    /** Relative basename within directory. */
    readonly name: string;
    readonly bytes: number;
}

export interface FFmpegDirectoryResult {
    readonly directory: string;
    readonly manifestPath: string;
    readonly files: readonly FFmpegDirectoryFile[];
    readonly bytesWritten: number;
}

export interface DirectoryConfig {
    readonly format: 'hls' | 'dash';
    readonly segmentDuration: number;
    readonly hlsSegmentType: 'mpegts' | 'fmp4';
    readonly maxFiles: number;
    readonly maxOutputBytes: number;
}

export interface DirectoryStat {
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

interface DirectoryHandle {
    read(): Promise<{ name: string } | null>;
    close(): Promise<void>;
}

export interface DirectoryFiles {
    mkdir(path: string, options: { mode: number }): Promise<unknown>;
    mkdtemp(prefix: string): Promise<string>;
    lstat(path: string): Promise<DirectoryStat>;
    opendir(path: string): Promise<DirectoryHandle>;
    readFile(path: string): Promise<Uint8Array>;
    rename(source: string, destination: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

interface DirectoryPaths {
    resolve(path: string): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function directoryError(message: string): never {
    throw new MediaForgeError(`FFmpeg directory: ${message}`, 'IO');
}

async function visitDirectory(
    path: string,
    fs: DirectoryFiles,
    visit: (name: string) => Promise<boolean>,
): Promise<void> {
    const handle = await fs.opendir(path);
    let failed = false;
    try {
        for (;;) {
            const entry = await handle.read();
            if (entry === null || !(await visit(entry.name))) break;
        }
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            await handle.close();
        } catch (error) {
            if (!failed) throw error;
        }
    }
}

async function sameEmptyReservation(
    path: string,
    identity: DirectoryStat,
    fs: DirectoryFiles,
): Promise<boolean> {
    let current: DirectoryStat;
    try {
        current = await fs.lstat(path);
    } catch (error) {
        if ((error as { code?: string })?.code === 'ENOENT') return false;
        throw error;
    }

    if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        !current.isDirectory() ||
        current.isSymbolicLink()
    )
        return false;

    let empty = true;
    await visitDirectory(path, fs, async () => {
        empty = false;
        return false;
    });
    return empty;
}

function manifestName(config: DirectoryConfig): string {
    return config.format === 'hls' ? 'index.m3u8' : 'manifest.mpd';
}

export function directoryMuxerArguments(config: DirectoryConfig): string[] {
    if (config.format === 'dash')
        return [
            '-seg_duration',
            String(config.segmentDuration),
            '-window_size',
            '0',
            '-use_template',
            '1',
            '-use_timeline',
            '1',
            '-dash_segment_type',
            'mp4',
            '-init_seg_name',
            'init-$RepresentationID$.mp4',
            '-media_seg_name',
            'segment-$RepresentationID$-$Number%06d$.m4s',
            'manifest.mpd',
        ];

    const fragmented = config.hlsSegmentType === 'fmp4';
    return [
        '-hls_time',
        String(config.segmentDuration),
        '-hls_list_size',
        '0',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_type',
        config.hlsSegmentType,
        '-start_number',
        '0',
        '-hls_segment_filename',
        `segment-%06d.${fragmented ? 'm4s' : 'ts'}`,
        ...(fragmented ? ['-hls_fmp4_init_filename', 'init.mp4'] : []),
        'index.m3u8',
    ];
}

function references(
    text: string,
    config: DirectoryConfig,
    available: ReadonlySet<string>,
    operation: FFmpegOperation,
): Set<string> {
    const used = new Set([manifestName(config)]);
    const reference = (name: string, pattern: RegExp): void => {
        if (!pattern.test(name) || !available.has(name))
            directoryError('manifest references a missing or unsupported resource');
        used.add(name);
    };

    if (config.format === 'hls') {
        const playlist = parseHlsPlaylist(text, {
            validation: 'strict',
            maxPlaylistEntries: config.maxFiles,
        });
        if (
            playlist.type !== 'media' ||
            playlist.playlistType !== 'VOD' ||
            !playlist.endList ||
            playlist.segments.length === 0
        ) {
            directoryError('expected a complete nonempty HLS VOD media playlist');
        }

        const fragmented = config.hlsSegmentType === 'fmp4';
        const media = fragmented ? /^segment-\d{6,}\.m4s$/ : /^segment-\d{6,}\.ts$/;
        for (const segment of playlist.segments) {
            operation.check();
            if (
                (segment.key && segment.key.method !== 'NONE') ||
                segment.byteRange ||
                segment.gap ||
                segment.parts?.length
            ) {
                directoryError('unsupported HLS encryption, ranges, gaps or partial segments');
            }

            reference(segment.uri, media);
            if (fragmented) {
                if (!segment.map || segment.map.byteRange || segment.map.key)
                    directoryError('invalid HLS initialization resource');
                reference(segment.map.uri, /^init\.mp4$/);
            } else if (segment.map) directoryError('unexpected HLS initialization resource');
        }
    } else {
        const manifest = parseDashManifest(text, {
            validation: 'strict',
            maxBytes: MAX_MANIFEST_BYTES,
            maxSegments: config.maxFiles,
            maxRepresentations: config.maxFiles,
            maxPlanEntries: config.maxFiles,
            maxNodes: Math.min(1000000, config.maxFiles * 5 + 1024),
        });

        let count = 0;
        for (const period of manifest.periods)
            for (const group of period.adaptationSets)
                for (const representation of group.representations) {
                    operation.check();
                    if (
                        !representation.initialization ||
                        representation.initialization.byteRange ||
                        representation.segmentInfo.type !== 'template' ||
                        representation.segmentCount < 1n
                    )
                        directoryError('unsupported or empty DASH representation');
                    reference(representation.initialization.url, /^init-\d+\.mp4$/);
                    for (const segment of iterateDashSegments(representation, {
                        maxSegments: config.maxFiles,
                    })) {
                        if (++count > config.maxFiles) directoryError('manifest exceeds maxFiles');
                        operation.check();
                        if (segment.byteRange || segment.index)
                            directoryError('unsupported DASH resource range or index');
                        reference(segment.url, /^segment-\d+-\d{6,}\.m4s$/);
                    }
                }
    }
    return used;
}

async function inventory(
    stage: string,
    fs: DirectoryFiles,
    path: DirectoryPaths,
    config: DirectoryConfig,
    operation: FFmpegOperation,
): Promise<{
    files: FFmpegDirectoryFile[];
    bytesWritten: number;
}> {
    const files: FFmpegDirectoryFile[] = [];
    const expectedManifest = manifestName(config);
    const allowed =
        config.format === 'dash'
            ? /^(?:manifest\.mpd|init-\d+\.mp4|segment-\d+-\d{6,}\.m4s)$/
            : config.hlsSegmentType === 'fmp4'
              ? /^(?:index\.m3u8|init\.mp4|segment-\d{6,}\.m4s)$/
              : /^(?:index\.m3u8|segment-\d{6,}\.ts)$/;

    let bytesWritten = 0;
    await visitDirectory(stage, fs, async name => {
        operation.check();
        if (files.length >= config.maxFiles) directoryError('output exceeds maxFiles');
        if (!allowed.test(name)) directoryError('output contains an unexpected resource name');
        const entry = await fs.lstat(path.join(stage, name));
        operation.check();
        if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !Number.isSafeInteger(entry.size) ||
            entry.size <= 0
        )
            directoryError('output resources must be nonempty regular files');

        if (entry.size > config.maxOutputBytes - bytesWritten)
            directoryError('output exceeds maxOutputBytes');
        if (name === expectedManifest && entry.size > MAX_MANIFEST_BYTES)
            directoryError('manifest exceeds the 8 MiB metadata limit');
        bytesWritten += entry.size;
        files.push({ name, bytes: entry.size });
        return true;
    });

    const available = new Set(files.map(file => file.name));
    if (!available.has(expectedManifest)) directoryError('output manifest is missing');
    const bytes = await fs.readFile(path.join(stage, expectedManifest));
    operation.check();
    if (bytes.byteLength > MAX_MANIFEST_BYTES)
        directoryError('manifest exceeds the 8 MiB metadata limit');

    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return directoryError('manifest must be UTF-8');
    }

    const used = references(text, config, available, operation);
    if (used.size !== available.size)
        directoryError('output contains resources absent from the manifest');
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    operation.check();
    return { files, bytesWritten };
}

/** Reserves a new empty destination; callers must not mutate it or its parent until completion. */
export async function withFFmpegDirectory(
    destination: string,
    io: { fs: DirectoryFiles; path: DirectoryPaths; platform: string },
    config: DirectoryConfig,
    operation: FFmpegOperation,
    generate: (stage: string) => Promise<void>,
): Promise<FFmpegDirectoryResult> {
    const { fs, path } = io;
    const target = path.resolve(destination);
    let identity: DirectoryStat | undefined;
    let stage: string | undefined;
    let committed = false;
    let failed = false;

    try {
        operation.check();
        await fs.mkdir(target, { mode: 0o700 });
        identity = await fs.lstat(target);
        operation.check();
        if (!identity.isDirectory() || identity.isSymbolicLink())
            directoryError('destination reservation changed');
        stage = await fs.mkdtemp(path.join(path.dirname(target), '.mediaforge-directory-'));
        operation.check();
        await generate(stage);
        operation.check();

        const result = await inventory(stage, fs, path, config, operation);
        if (!(await sameEmptyReservation(target, identity, fs)))
            directoryError('destination reservation changed or is no longer empty');
        operation.check();
        if (io.platform === 'win32') {
            await fs.rmdir(target);
            identity = undefined;
            operation.check();
        }

        await fs.rename(stage, target);
        committed = true;
        stage = undefined;
        return {
            directory: target,
            manifestPath: path.join(target, manifestName(config)),
            ...result,
        };
    } catch (error) {
        failed = true;
        operation.fail(error);
        operation.check();
        throw error;
    } finally {
        let cleanupError: unknown;
        if (stage) {
            try {
                await fs.rm(stage, { recursive: true, force: true });
            } catch (error) {
                cleanupError = error;
            }
        }

        if (identity && !committed) {
            try {
                if (await sameEmptyReservation(target, identity, fs)) await fs.rmdir(target);
            } catch (error) {
                cleanupError ??= error;
            }
        }

        if (!failed && cleanupError !== undefined) throw cleanupError;
    }
}
