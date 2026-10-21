import { IOError, MediaForgeError } from '../core/errors/errors';
import { awaitWithAbort } from '../core/io/abort';
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

export interface DenoFileHandle {
    stat(): Promise<{ size: number; isFile: boolean }>;
    seek(offset: number, whence: number): Promise<number>;
    read(bytes: Uint8Array): Promise<number | null>;
    write(bytes: Uint8Array): Promise<number>;
    truncate(length: number): Promise<void>;
    close(): void;
}

async function openFile(path: string | URL, write: boolean): Promise<DenoFileHandle> {
    const host = globalThis as unknown as {
        Deno?: {
            open(path: string | URL, options: Record<string, boolean>): Promise<DenoFileHandle>;
        };
    };
    if (!host.Deno) throw new IOError('Deno filesystem APIs are unavailable');
    return host.Deno.open(
        path,
        write ? { read: true, write: true, create: true, truncate: true } : { read: true },
    );
}

/** Deno file reads serialize seek/read pairs; do not share the handle with another reader. */
export class FileSource extends PositionedFileSource {
    static async open(
        path: string | URL,
        options: Omit<FileSourceOptions, 'closeHandle'> = {},
    ): Promise<FileSource> {
        const signal = fileSourceSignal(options);
        return awaitWithAbort(
            openFile(path, false).then(handle =>
                FileSource.from(handle, { signal, closeHandle: true }),
            ),
            signal,
        );
    }

    static async from(
        handle: DenoFileHandle,
        options: FileSourceOptions = {},
    ): Promise<FileSource> {
        const own = ownsHandle(options);
        try {
            const signal = fileSourceSignal(options);
            const stat = await awaitWithAbort(handle.stat(), signal);
            if (!stat.isFile) throw new IOError('FileSource requires a regular file');
            validateFileSize(stat.size);
            let pending = Promise.resolve();
            return new FileSource(
                {
                    readAt: (bytes, position, readSignal) => {
                        const read = pending.then(async () => {
                            if (readSignal.aborted)
                                throw new MediaForgeError('File source is closed', 'ABORT');
                            await handle.seek(position, 0);
                            if (readSignal.aborted)
                                throw new MediaForgeError('File source is closed', 'ABORT');
                            return (await handle.read(bytes)) ?? 0;
                        });
                        pending = read.then(
                            () => undefined,
                            () => undefined,
                        );
                        return read;
                    },
                    close: async () => {
                        handle.close();
                    },
                },
                stat.size,
                own,
                signal,
            );
        } catch (error) {
            if (own) {
                try {
                    handle.close();
                } catch {}
            }
            throw error;
        }
    }
}

/**
 * from() truncates and borrows a Deno file; writes are serialized with positioned seek/write pairs.
 */
export class FileSink extends PositionedFileSink {
    static async open(
        path: string | URL,
        options: Omit<FileSinkOptions, 'closeHandle'> = {},
    ): Promise<FileSink> {
        const highWaterMark = fileHighWaterMark(options.highWaterMark);
        const handle = await openFile(path, true);
        return FileSink.from(handle, { highWaterMark, closeHandle: true });
    }

    static async from(handle: DenoFileHandle, options: FileSinkOptions = {}): Promise<FileSink> {
        const own = ownsHandle(options);
        try {
            const sink = new FileSink(
                {
                    writeAt: async (bytes, position, signal) => {
                        if (signal.aborted)
                            throw new MediaForgeError('File sink is closed', 'ABORT');
                        await handle.seek(position, 0);
                        if (signal.aborted)
                            throw new MediaForgeError('File sink is closed', 'ABORT');
                        return handle.write(bytes);
                    },
                    close: async () => {
                        handle.close();
                    },
                },
                own,
                options,
            );
            await handle.truncate(0);
            return sink;
        } catch (error) {
            if (own) {
                try {
                    handle.close();
                } catch {}
            }
            throw error;
        }
    }
}
