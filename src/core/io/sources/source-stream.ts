import type { Source } from '../../model/types';
import { MediaForgeError, abortError } from '../../errors/errors';
import { assertSourceBytes } from './source-read';

export interface SourceStreamOptions {
    /** Maximum bytes requested per pull; defaults to 256 KiB. */
    readonly chunkBytes?: number;
    /** Errors the stream on abort; the caller retains ownership of the underlying Source. */
    readonly signal?: AbortSignal;
    /**
     * Reports validated input bytes before enqueue; a returned promise delays delivery and remains
     * cancellable.
     */
    readonly onProgress?: (bytesRead: number, totalBytes: number) => void | PromiseLike<void>;
}

const OPTION_KEYS = new Set(['chunkBytes', 'signal', 'onProgress']);

/** Reads a stable Source on demand, one chunk at a time, with independent output bytes. */
export function sourceToReadableStream(
    source: Source,
    options: SourceStreamOptions = {},
): ReadableStream<Uint8Array> {
    let size: number;
    let read: Source['read'];
    let chunkBytes: number | undefined;
    let signal: AbortSignal | undefined;
    let onProgress: SourceStreamOptions['onProgress'];
    let addAbort: AbortSignal['addEventListener'] | undefined;
    let removeAbort: AbortSignal['removeEventListener'] | undefined;

    try {
        size = source.size;
        read = source.read;
        if (
            !options ||
            typeof options !== 'object' ||
            Array.isArray(options) ||
            Object.keys(options).some(key => !OPTION_KEYS.has(key))
        )
            throw new Error();

        chunkBytes = options.chunkBytes;
        signal = options.signal;
        onProgress = options.onProgress;
        if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error();
        if (signal !== undefined) {
            addAbort = signal?.addEventListener;
            removeAbort = signal?.removeEventListener;
            if (
                !signal ||
                typeof signal.aborted !== 'boolean' ||
                typeof addAbort !== 'function' ||
                typeof removeAbort !== 'function'
            )
                throw new Error();
        }
    } catch {
        throw new MediaForgeError(
            'Source stream requires a readable Source and valid options',
            'INPUT',
        );
    }

    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
        throw new MediaForgeError(
            'Source stream requires a non-negative safe size and read method',
            'INPUT',
        );
    }

    if (chunkBytes === undefined) chunkBytes = 256 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
        throw new MediaForgeError(
            'Source stream chunkBytes must be a positive safe integer',
            'INPUT',
        );
    }

    const chunkSize = chunkBytes;
    let position = 0;
    let stopped = false;
    let listening = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let releasePull: (() => void) | undefined;

    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (listening) {
            listening = false;
            try {
                removeAbort!.call(signal, 'abort', onAbort);
            } catch {}
        }
        const release = releasePull;
        releasePull = undefined;
        release?.();
    };

    const fail = (reason: unknown): void => {
        if (stopped) return;
        stop();
        controller.error(reason);
    };

    const onAbort = (): void => fail(abortError(signal!));

    return new ReadableStream<Uint8Array>(
        {
            start(current): void {
                controller = current;
                if (signal?.aborted) {
                    onAbort();
                    return;
                }

                if (size === 0) {
                    stop();
                    controller.close();
                    return;
                }

                if (signal) {
                    listening = true;
                    try {
                        addAbort!.call(signal, 'abort', onAbort, { once: true });
                        if (signal.aborted) onAbort();
                    } catch (error) {
                        fail(error);
                    }
                }
            },
            async pull(): Promise<void> {
                if (stopped) return;
                const count = Math.min(chunkSize, size - position);

                let release: () => void = () => undefined;
                const ended = new Promise<undefined>(resolve => {
                    release = () => resolve(undefined);
                });
                releasePull = release;

                try {
                    let pending: Promise<Uint8Array>;
                    try {
                        pending = read.call(source, position, count);
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    const result = await Promise.race([
                        Promise.resolve(pending).then(
                            bytes => ({ bytes }),
                            error => {
                                fail(error);
                                return undefined;
                            },
                        ),
                        ended,
                    ]);

                    if (stopped || !result) return;
                    assertSourceBytes(result.bytes, count, 'Source stream');
                    let output: Uint8Array;
                    try {
                        output = new Uint8Array(result.bytes);
                    } catch {
                        throw new MediaForgeError(
                            'Source stream could not copy the input chunk',
                            'OOM',
                        );
                    }

                    if (stopped) return;
                    if (onProgress) {
                        const notified = onProgress.call(options, position + count, size);
                        if (notified !== undefined) {
                            await Promise.race([
                                Promise.resolve(notified).then(undefined, error => {
                                    fail(error);
                                }),
                                ended,
                            ]);
                        }
                        if (stopped) return;
                    }

                    position += count;
                    controller.enqueue(output);
                    if (position === size) {
                        stop();
                        controller.close();
                    }
                } catch (error) {
                    fail(error);
                } finally {
                    if (releasePull === release) releasePull = undefined;
                }
            },
            cancel(): void {
                stop();
            },
        },
        { highWaterMark: 0 },
    );
}
