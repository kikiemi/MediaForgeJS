import type { Source } from '../../model/types';
import { yieldEventLoop } from '../event-loop';
import { IOError, MediaForgeError, abortError, throwIfAborted } from '../../errors/errors';
import { isOptionalSignal } from '../abort';
import { outputByteLength } from '../../bytes/output-data';
import { registerOwnedReads, sourceReadEnd } from './source-read';
import {
    typedArrayBuffer as buffer,
    typedArrayOffset as byteOffset,
} from '../../bytes/typed-array';

export interface StreamSourceOptions {
    /** Random access requires retaining the entire input. No unbounded default is provided. */
    readonly retention: 'memory';
    /** Maximum retained payload bytes; excludes upstream buffers and returned read copies. */
    readonly maxBytes: number;
    /**
     * Maximum consecutive empty chunks before rejecting a nonprogressing input; defaults to 1024.
     */
    readonly maxEmptyChunks?: number;
    readonly signal?: AbortSignal;
}

const PAGE_SIZE = 64 * 1024;

async function nextChunk(
    next: () => PromiseLike<IteratorResult<Uint8Array>>,
    signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
    if (!signal) return next();
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });

    const onAbort = (): void => rejectAbort(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
        return await Promise.race([
            Promise.resolve().then(() => {
                throwIfAborted(signal);
                return next();
            }),
            aborted,
        ]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/** A completed stream retained in copied pages; construction consumes and owns the input reader. */
export class StreamSource implements Source {
    private constructor(
        private readonly pages: readonly Uint8Array[],
        readonly size: number,
    ) {
        registerOwnedReads(this, StreamSource.prototype.read);
    }

    /** Resolves only at EOF. Failure/abort cancels the reader or calls iterator.return(). */
    static async from(
        input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
        options: StreamSourceOptions,
    ): Promise<StreamSource> {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('StreamSource requires explicit retention options', 'INPUT');
        const { retention, maxBytes, maxEmptyChunks: emptyLimit, signal } = options;
        if (retention !== 'memory' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new IOError("StreamSource needs retention: 'memory' and maxBytes", {
                hint: 'Pass maxBytes as a non-negative safe integer.',
            });
        }
        if (!isOptionalSignal(signal))
            throw new MediaForgeError('StreamSource requires a valid AbortSignal', 'INPUT');
        throwIfAborted(signal);

        const maxEmptyChunks = emptyLimit === undefined ? 1024 : emptyLimit;
        if (!Number.isSafeInteger(maxEmptyChunks) || maxEmptyChunks < 0) {
            throw new MediaForgeError(
                'maxEmptyChunks must be a non-negative safe integer',
                'INPUT',
            );
        }

        let cancel: (reason: unknown) => unknown = () => undefined;
        let release: () => void = () => undefined;
        try {
            let next: () => PromiseLike<IteratorResult<Uint8Array>>;
            const getReader = input && (input as ReadableStream<Uint8Array>).getReader;
            if (typeof getReader === 'function') {
                const reader = getReader.call(input) as ReadableStreamDefaultReader<Uint8Array>;
                cancel = reason => reader.cancel(reason);
                release = () => reader.releaseLock();
                const read = reader.read;
                if (typeof read !== 'function')
                    throw new IOError('Stream reader must provide read()');
                next = () => read.call(reader) as Promise<IteratorResult<Uint8Array>>;
            } else {
                const iterate = input && (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
                if (typeof iterate !== 'function')
                    throw new IOError(
                        'StreamSource requires a byte ReadableStream or AsyncIterable',
                    );
                const iterator = iterate.call(input);
                cancel = () => iterator.return?.();
                const pull = iterator.next;
                if (typeof pull !== 'function')
                    throw new IOError('Stream iterator must provide next()');
                next = () => pull.call(iterator);
            }

            const pages: Uint8Array[] = [];
            let page: Uint8Array | null = null;
            let used = 0;
            let size = 0;
            let emptyChunks = 0;
            let pulls = 0;
            let copied = 0;
            const now = (): number =>
                typeof performance === 'undefined' ? Date.now() : performance.now();
            let lastYield = now();

            while (true) {
                const result = await nextChunk(next, signal);
                throwIfAborted(signal);
                if (!result || typeof result !== 'object')
                    throw new IOError('Stream iterator must return a result object');
                const done = result.done;
                throwIfAborted(signal);
                if (done) {
                    if (page && used < page.length) pages[pages.length - 1] = page.slice(0, used);
                    return new StreamSource(pages, size);
                }

                const value = result.value;
                throwIfAborted(signal);
                const count = outputByteLength(value);
                if (count > maxBytes - size)
                    throw new MediaForgeError('Stream input exceeds maxBytes', 'OOM');

                if (count === 0) {
                    if (emptyChunks >= maxEmptyChunks)
                        throw new IOError(
                            'Stream input made no byte progress within maxEmptyChunks',
                        );
                    emptyChunks++;
                } else {
                    emptyChunks = 0;
                    if (!page || used === page.length) {
                        page = new Uint8Array(Math.min(PAGE_SIZE, maxBytes - size));
                        pages.push(page);
                        used = 0;
                    }
                    if (count <= page.length - used) {
                        if (count === 1) page[used] = value[0]!;
                        else page.set(value, used);
                        used += count;
                    } else {
                        const inputBuffer: ArrayBufferLike = buffer.call(value);
                        const inputOffset: number = byteOffset.call(value);
                        for (let position = 0; position < count;) {
                            if (used === page.length) {
                                page = new Uint8Array(
                                    Math.min(PAGE_SIZE, maxBytes - size - position),
                                );
                                pages.push(page);
                                used = 0;
                            }
                            const length = Math.min(count - position, page.length - used);
                            page.set(
                                new Uint8Array(inputBuffer, inputOffset + position, length),
                                used,
                            );
                            position += length;
                            used += length;
                        }
                    }
                    size += count;
                    copied += count;
                }

                const emptyCheckpoint = emptyChunks > 0 && emptyChunks % 64 === 0;
                if (++pulls >= 256 || copied >= 4 * 1024 * 1024 || emptyCheckpoint) {
                    pulls = 0;
                    copied = 0;
                    if (emptyCheckpoint || now() - lastYield >= 8) {
                        await yieldEventLoop();
                        throwIfAborted(signal);
                        lastYield = now();
                    }
                }
            }
        } catch (error) {
            try {
                Promise.resolve(cancel(error)).catch(() => undefined);
            } catch {}
            throw error;
        } finally {
            try {
                release();
            } catch {}
        }
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const end = sourceReadEnd(offset, length, this.size);
        if (end <= offset) return new Uint8Array(0);
        const result = new Uint8Array(end - offset);
        let position = offset;
        while (position < end) {
            const index = Math.floor(position / PAGE_SIZE);
            const within = position - index * PAGE_SIZE;
            const count = Math.min(end - position, this.pages[index]!.length - within);
            result.set(this.pages[index]!.subarray(within, within + count), position - offset);
            position += count;
        }
        return result;
    }
}
