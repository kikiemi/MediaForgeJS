import { IOError, MediaForgeError, throwIfAborted } from '../core/errors/errors';
import { assertAbortSignal, awaitWithAbort } from '../core/io/abort';
import { StreamSource, type StreamSourceOptions } from '../core/io/sources/stream-source';
import { WritableStreamSink } from '../core/io/sinks/writable-stream-sink';
import {
    PositionedFileSource,
    PositionedFileSink,
    ownsHandle,
    validateFileSize,
    fileHighWaterMark,
    fileSourceSignal,
    type FileSourceOptions,
    type FileSinkOptions,
} from './file-io';

export interface NodeFileHandle {
    stat(): Promise<{ size: number; isFile(): boolean }>;
    read(
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
    write(
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesWritten: number }>;
    truncate(length: number): Promise<void>;
    close(): Promise<void>;
}

let fileSystem: Promise<{ open(path: string | URL, flags: string): Promise<NodeFileHandle> }>;

async function openFile(path: string | URL, flags: string): Promise<NodeFileHandle> {
    const name = 'node:fs/promises';
    return (await (fileSystem ??= import(name))).open(path, flags);
}

/** Node/Bun positioned file input. The caller must not modify the file while it is in use. */
export class FileSource extends PositionedFileSource {
    static async open(
        path: string | URL,
        options: Omit<FileSourceOptions, 'closeHandle'> = {},
    ): Promise<FileSource> {
        const signal = fileSourceSignal(options);
        return awaitWithAbort(
            openFile(path, 'r').then(handle =>
                FileSource.from(handle, { signal, closeHandle: true }),
            ),
            signal,
        );
    }

    static async from(
        handle: NodeFileHandle,
        options: FileSourceOptions = {},
    ): Promise<FileSource> {
        const own = ownsHandle(options);
        try {
            const signal = fileSourceSignal(options);
            const stat = await awaitWithAbort(handle.stat(), signal);
            if (!stat.isFile()) throw new IOError('FileSource requires a regular file');
            validateFileSize(stat.size);
            return new FileSource(
                {
                    readAt: async (bytes, position) =>
                        (await handle.read(bytes, 0, bytes.length, position)).bytesRead,
                    close: () => handle.close(),
                },
                stat.size,
                own,
                signal,
            );
        } catch (error) {
            if (own) {
                try {
                    const closing = Promise.resolve(handle.close());
                    if (error instanceof MediaForgeError && error.code === 'ABORT')
                        void closing.catch(() => undefined);
                    else await closing;
                } catch {}
            }
            throw error;
        }
    }
}

/**
 * Node/Bun positioned output. from() truncates the file and requires a handle opened without append
 * mode.
 */
export class FileSink extends PositionedFileSink {
    static async open(
        path: string | URL,
        options: Omit<FileSinkOptions, 'closeHandle'> = {},
    ): Promise<FileSink> {
        const highWaterMark = fileHighWaterMark(options.highWaterMark);
        const handle = await openFile(path, 'w+');
        return FileSink.from(handle, { highWaterMark, closeHandle: true });
    }

    static async from(handle: NodeFileHandle, options: FileSinkOptions = {}): Promise<FileSink> {
        const own = ownsHandle(options);
        try {
            const sink = new FileSink(
                {
                    writeAt: async (bytes, position) =>
                        (await handle.write(bytes, 0, bytes.length, position)).bytesWritten,
                    close: () => handle.close(),
                },
                own,
                options,
            );
            await handle.truncate(0);
            return sink;
        } catch (error) {
            if (own) {
                try {
                    await handle.close();
                } catch {}
            }
            throw error;
        }
    }
}

export interface NodeReadable extends AsyncIterable<Uint8Array> {
    destroy(error?: Error): unknown;
}

export interface NodeWritable {
    write(bytes: Uint8Array): boolean;
    end(): unknown;
    destroy(error?: Error): unknown;
}

/** Consumes a Node byte stream; abort/error destroys it. All input is retained within maxBytes. */
export async function nodeReadableSource(
    input: NodeReadable,
    options: StreamSourceOptions,
): Promise<StreamSource> {
    try {
        return await StreamSource.from(input, options);
    } catch (error) {
        try {
            input.destroy();
        } catch {}
        throw error;
    }
}

/** A file to write: its relative name and its bytes, such as a PackagedFile of packageMedia(). */
export interface PackageInputFile {
    readonly name: string;
    readonly data: Uint8Array;
}

export interface PackageDirectoryOptions {
    /** Replace existing files. Default false: an existing file fails with code IO. */
    readonly overwrite?: boolean;
    readonly signal?: AbortSignal;
}

export interface PackageDirectoryFile {
    /** Relative name within directory. */
    readonly name: string;
    readonly bytes: number;
}

export interface PackageDirectoryResult {
    readonly directory: string;
    readonly files: readonly PackageDirectoryFile[];
    readonly bytesWritten: number;
}

interface PackageFileSystem {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, data: Uint8Array, options: { flag: string }): Promise<void>;
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Writes package files under directory by their fixed relative names; a failed run leaves earlier
 * files in place.
 */
export async function writePackageToDirectory(
    files: AsyncIterable<PackageInputFile> | Iterable<PackageInputFile>,
    directory: string,
    options: PackageDirectoryOptions = {},
): Promise<PackageDirectoryResult> {
    if (!files || typeof files !== 'object')
        throw new MediaForgeError('Expected package files', 'INPUT');
    if (typeof directory !== 'string' || !directory)
        throw new MediaForgeError('Expected a directory path', 'INPUT');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected directory options', 'INPUT');

    const { overwrite = false, signal } = options;
    if (typeof overwrite !== 'boolean')
        throw new MediaForgeError('overwrite must be boolean', 'INPUT');
    assertAbortSignal(signal);

    const aborted = (): void => {
        throwIfAborted(signal);
    };
    aborted();

    const fsName = 'node:fs/promises';
    const pathName = 'node:path';
    const fs = (await import(fsName)) as PackageFileSystem;
    const path = (await import(pathName)) as {
        resolve(path: string): string;
        join(...paths: string[]): string;
    };

    const target = path.resolve(directory);
    await awaitWithAbort(fs.mkdir(target, { recursive: true }), signal);

    const written: PackageDirectoryFile[] = [];
    const names = new Set<string>();
    let bytesWritten = 0;

    for await (const file of files) {
        aborted();
        if (!file || typeof file !== 'object' || !PACKAGE_NAME.test(String(file.name)))
            throw new IOError(
                `Refusing to write package file ${JSON.stringify(String(file?.name))}`,
            );
        if (!(file.data instanceof Uint8Array))
            throw new IOError(`Package file ${file.name} has no bytes`);
        if (names.has(file.name)) throw new IOError(`Package file ${file.name} is written twice`);
        names.add(file.name);

        try {
            await awaitWithAbort(
                fs.writeFile(path.join(target, file.name), file.data, {
                    flag: overwrite ? 'w' : 'wx',
                }),
                signal,
            );
        } catch (error) {
            if ((error as { code?: string })?.code === 'EEXIST')
                throw new IOError(`Package file ${file.name} already exists`, {
                    hint: 'Pass overwrite to replace it.',
                });
            throw error;
        }

        bytesWritten += file.data.length;
        written.push({ name: file.name, bytes: file.data.length });
    }

    aborted();
    return { directory: target, files: written, bytesWritten };
}

/** Owns stream completion/cancellation; await drain() to bound queued output. */
export async function nodeWritableSink(
    input: NodeWritable,
    options: { highWaterMark?: number } = {},
): Promise<WritableStreamSink> {
    const highWaterMark = fileHighWaterMark(options.highWaterMark);
    const name = 'node:stream';
    const streams = (await import(name)) as {
        Writable: { toWeb(input: NodeWritable): WritableStream<Uint8Array> };
    };
    return new WritableStreamSink(streams.Writable.toWeb(input), { highWaterMark });
}
