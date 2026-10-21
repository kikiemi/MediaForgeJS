import type { Source, Sink } from '../core/model/types';
import { IOError, MediaForgeError, throwIfAborted } from '../core/errors/errors';
import { assertAbortSignal } from '../core/io/abort';
import { registerOwnedReads, sourceReadEnd } from '../core/io/sources/source-read';
import { registerReadInto } from '../core/bytes/read-into';
import { StreamSink } from '../core/io/sinks/sinks';
import { declareCopyingSink } from '../core/io/sinks/copying-sinks';
import { declareDrainReady, drainReadiness } from '../core/io/sinks/sink-backpressure';

export interface FileSourceOptions {
    /** from() borrows the handle by default; open() always owns it. */
    readonly closeHandle?: boolean;
    readonly signal?: AbortSignal;
}

export interface FileSinkOptions {
    /** from() borrows the handle by default; open() always owns it. */
    readonly closeHandle?: boolean;
    /** Queued write bytes before drain() blocks; defaults to 1 MiB. */
    readonly highWaterMark?: number;
}

interface PositionedFileReader {
    readAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
}

interface PositionedFileWriter {
    writeAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
}

export function ownsHandle(options: FileSourceOptions | FileSinkOptions): boolean {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new IOError('Expected file options');
    const own = options.closeHandle;
    if (own !== undefined && typeof own !== 'boolean')
        throw new IOError('closeHandle must be a boolean');
    return own ?? false;
}

export function fileSourceSignal(options: FileSourceOptions): AbortSignal | undefined {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new IOError('Expected file options');
    const signal = options.signal;
    assertAbortSignal(signal);
    throwIfAborted(signal);
    return signal;
}

export function validateFileSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0)
        throw new IOError('File size must be a non-negative safe integer');
}

export function fileHighWaterMark(value: number | undefined): number {
    const result = value ?? 1024 * 1024;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new IOError('highWaterMark must be a positive safe integer');
    return result;
}

let closed: DOMException | undefined;

/** The reason a close aborts reads with, made once: making one per close costs more than it. */
const closeReason = (): DOMException =>
    (closed ??= new DOMException('This operation was aborted', 'AbortError'));

/**
 * Bounded positioned reads over a stable file; close interrupts callers and releases an owned
 * handle.
 */
export class PositionedFileSource implements Source {
    private closed = false;
    private closePromise: Promise<void> | null = null;
    private readonly controller = new AbortController();
    private readonly detach: () => void;

    constructor(
        private readonly reader: PositionedFileReader,
        readonly size: number,
        private readonly own: boolean,
        signal?: AbortSignal,
    ) {
        validateFileSize(size);
        assertAbortSignal(signal);
        throwIfAborted(signal);
        const onAbort = (): void => {
            this.close().catch(() => undefined);
        };
        this.detach = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        registerOwnedReads(this, PositionedFileSource.prototype.read);
        registerReadInto(
            this,
            PositionedFileSource.prototype.read,
            PositionedFileSource.prototype.readInto,
        );
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        if (this.closed) throw new MediaForgeError('File source is closed', 'ABORT');
        const end = sourceReadEnd(offset, length, this.size);
        if (end <= offset) return new Uint8Array(0);
        const bytes = new Uint8Array(end - offset);
        await this.readInto(offset, bytes);
        return bytes;
    }

    /** Fills `bytes` with the file from `offset`; the file must hold them all. */
    async readInto(offset: number, bytes: Uint8Array): Promise<void> {
        if (this.closed) throw new MediaForgeError('File source is closed', 'ABORT');
        if (sourceReadEnd(offset, bytes.length, this.size) - offset !== bytes.length)
            throw new IOError('File read past the end of the file');
        let position = 0;
        while (position < bytes.length) {
            const count = await this.readPart(bytes.subarray(position), offset + position);
            if (this.closed) throw new MediaForgeError('File source is closed', 'ABORT');
            if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - position) {
                throw new IOError('File read ended early or returned an invalid byte count');
            }
            position += count;
        }
    }

    private async readPart(bytes: Uint8Array, position: number): Promise<number> {
        let rejectAbort: (reason: unknown) => void = () => undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
        });

        const onAbort = (): void =>
            rejectAbort(new MediaForgeError('File source is closed', 'ABORT'));
        const signal = this.controller.signal;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();

        try {
            return await Promise.race([
                Promise.resolve().then(() => {
                    if (this.closed) throw new MediaForgeError('File source is closed', 'ABORT');
                    return this.reader.readAt(bytes, position, signal);
                }),
                aborted,
            ]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    close(): Promise<void> {
        if (!this.closePromise) {
            this.closed = true;
            this.detach();
            this.controller.abort(closeReason());
            this.closePromise = Promise.resolve().then(() =>
                this.own ? this.reader.close() : undefined,
            );
        }
        return this.closePromise;
    }
}

/** Positioned append/patch output; use drain() to bound queued bytes. */
export class PositionedFileSink implements Sink {
    private readonly sink: StreamSink;

    constructor(writer: PositionedFileWriter, own: boolean, options: FileSinkOptions = {}) {
        // write() hands the bytes to the stream sink, which copies them before it returns.
        declareCopyingSink(this);
        let closed = false;
        const controller = new AbortController();
        let released: Promise<void> | null = null;

        const release = (): Promise<void> => {
            if (!released) {
                closed = true;
                controller.abort();
                released = Promise.resolve().then(() => (own ? writer.close() : undefined));
            }
            return released;
        };

        this.sink = new StreamSink(
            {
                write: async ({ position, data }) => {
                    const bytes = new Uint8Array(data);
                    let offset = 0;
                    try {
                        while (offset < bytes.length) {
                            if (closed) throw new MediaForgeError('File sink is closed', 'ABORT');
                            const count = await writer.writeAt(
                                bytes.subarray(offset),
                                position + offset,
                                controller.signal,
                            );

                            if (closed) throw new MediaForgeError('File sink is closed', 'ABORT');
                            if (
                                !Number.isSafeInteger(count) ||
                                count <= 0 ||
                                count > bytes.length - offset
                            ) {
                                throw new IOError('File write returned an invalid byte count');
                            }

                            offset += count;
                        }
                    } catch (error) {
                        release().catch(() => undefined);
                        throw error;
                    }
                },
                close: release,
                abort: async () => {
                    release().catch(() => undefined);
                },
            },
            { highWaterMark: fileHighWaterMark(options.highWaterMark) },
        );
        const ready = drainReadiness(this.sink);
        if (ready) declareDrainReady(this, ready);
    }

    write(bytes: Uint8Array): void {
        this.sink.write(bytes);
    }
    patchAt(offset: number, bytes: Uint8Array): void {
        this.sink.patchAt(offset, bytes);
    }
    drain(): Promise<void> {
        return this.sink.drain();
    }
    close(): Promise<void> {
        return this.sink.close();
    }
    abort(reason?: unknown): Promise<void> {
        return this.sink.abort(reason);
    }
    get done(): Promise<void> {
        return this.sink.done;
    }
}
