import { awaitWithAbort } from '../../../core/io/abort';
import { DemuxError, IOError, MediaForgeError, throwIfAborted } from '../../../core/errors/errors';
import { outputByteLength } from '../../../core/bytes/output-data';

export type ByteStreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export class TruncatedByteStreamError extends DemuxError {
    constructor(readonly offset: number) {
        super(`MP4 stream ends inside a box at byte ${offset}`);
    }
}

/**
 * Owns one copied input chunk and releases its reader without waiting for uncooperative
 * cancellation.
 */
export class StreamByteReader {
    private readonly nextInput: () => PromiseLike<IteratorResult<Uint8Array>>;
    private readonly cancelInput: (reason: unknown) => unknown;
    private readonly releaseInput: () => void;
    private chunk: Uint8Array = new Uint8Array(0);
    private at = 0;
    private ended = false;
    private closed = false;
    private pulls = 0;
    private emptyChunks = 0;
    position = 0;

    constructor(
        input: ByteStreamInput,
        readonly signal: AbortSignal,
        private readonly maxChunkBytes: number,
        private readonly maxEmptyChunks: number,
    ) {
        const getReader = input && (input as ReadableStream<Uint8Array>).getReader;
        if (typeof getReader === 'function') {
            const reader = getReader.call(input) as ReadableStreamDefaultReader<Uint8Array>;
            let read: typeof reader.read | undefined;
            let cancel: typeof reader.cancel | undefined;
            let releaseLock: typeof reader.releaseLock | undefined;
            let failure: unknown;
            let failed = false;
            const captureFailure = (error: unknown): void => {
                if (!failed) {
                    failure = error;
                    failed = true;
                }
            };

            try {
                read = reader.read;
            } catch (error) {
                captureFailure(error);
            }
            try {
                cancel = reader.cancel;
            } catch (error) {
                captureFailure(error);
            }
            try {
                releaseLock = reader.releaseLock;
            } catch (error) {
                captureFailure(error);
            }

            if (
                failed ||
                typeof read !== 'function' ||
                typeof cancel !== 'function' ||
                typeof releaseLock !== 'function'
            ) {
                try {
                    if (typeof cancel === 'function')
                        void Promise.resolve(cancel.call(reader)).catch(() => undefined);
                } catch {}
                try {
                    if (typeof releaseLock === 'function') releaseLock.call(reader);
                } catch {}
                if (failed) throw failure;
                throw new IOError('MP4 input must provide a readable byte stream');
            }

            this.nextInput = () => read.call(reader) as Promise<IteratorResult<Uint8Array>>;
            this.cancelInput = reason => cancel.call(reader, reason);
            this.releaseInput = () => releaseLock.call(reader);
        } else {
            const factory = input && (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
            if (typeof factory !== 'function')
                throw new IOError('MP4 input must be a byte ReadableStream or AsyncIterable');
            const iterator = factory.call(input);
            let next: typeof iterator.next | undefined;
            let finish: typeof iterator.return;
            let failure: unknown;
            let failed = false;

            try {
                next = iterator?.next;
            } catch (error) {
                failure = error;
                failed = true;
            }
            try {
                finish = iterator?.return;
            } catch (error) {
                if (!failed) {
                    failure = error;
                    failed = true;
                }
            }

            if (
                failed ||
                typeof next !== 'function' ||
                (finish !== undefined && typeof finish !== 'function')
            ) {
                try {
                    if (typeof finish === 'function')
                        void Promise.resolve(finish.call(iterator)).catch(() => undefined);
                } catch {}
                if (failed) throw failure;
                throw new IOError('MP4 input returned an invalid async iterator');
            }

            this.nextInput = () => next.call(iterator);
            this.cancelInput = () => finish?.call(iterator);
            this.releaseInput = () => undefined;
        }
    }

    checkAbort(): void {
        throwIfAborted(this.signal);
    }

    async read(length: number, allowEnd = false): Promise<Uint8Array | undefined> {
        if (!(await this.available())) {
            if (allowEnd) return undefined;
            throw new TruncatedByteStreamError(this.position);
        }
        const data = new Uint8Array(length);
        await this.fill(data, 0, length);
        return data;
    }

    async fill(data: Uint8Array, start: number, length: number): Promise<void> {
        const end = start + length;
        while (start < end) {
            if (!(await this.available())) throw new TruncatedByteStreamError(this.position);
            const count = Math.min(end - start, this.chunk.length - this.at);
            data.set(this.chunk.subarray(this.at, this.at + count), start);
            this.consume(count);
            start += count;
        }
    }

    async toEnd(header: Uint8Array, limit: number): Promise<Uint8Array> {
        let data = new Uint8Array(Math.min(limit, Math.max(4096, header.length)));
        data.set(header);
        let length = header.length;
        while (await this.available()) {
            const count = this.chunk.length - this.at;
            if (count > limit - length)
                throw new MediaForgeError('MP4 box exceeds maxBoxBytes', 'OOM');
            if (length + count > data.length) {
                const grown = new Uint8Array(
                    Math.min(limit, Math.max(length + count, data.length * 2)),
                );
                grown.set(data.subarray(0, length));
                data = grown;
            }
            data.set(this.chunk.subarray(this.at), length);
            this.consume(count);
            length += count;
        }
        return length === data.length ? data : data.slice(0, length);
    }

    close(reason?: unknown): void {
        if (this.closed) return;
        this.closed = true;
        this.chunk = new Uint8Array(0);
        if (!this.ended) {
            try {
                void Promise.resolve(this.cancelInput(reason)).catch(() => undefined);
            } catch {}
        }
        try {
            this.releaseInput();
        } catch {}
    }

    private consume(count: number): void {
        if (!Number.isSafeInteger(this.position + count))
            throw new DemuxError('MP4 stream offset exceeds exact integer precision');
        this.at += count;
        this.position += count;
        if (this.at === this.chunk.length) {
            this.chunk = new Uint8Array(0);
            this.at = 0;
        }
    }

    private async available(): Promise<boolean> {
        this.checkAbort();
        if (this.at < this.chunk.length) return true;
        while (!this.ended) {
            if (++this.pulls % 128 === 0) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await awaitWithAbort(
                        new Promise<void>(resolve => {
                            timer = setTimeout(resolve, 0);
                        }),
                        this.signal,
                    );
                } finally {
                    clearTimeout(timer);
                }
                this.checkAbort();
            }

            const result = await awaitWithAbort(
                Promise.resolve().then(() => {
                    this.checkAbort();
                    return this.nextInput();
                }),
                this.signal,
            );
            this.checkAbort();
            if (!result || typeof result !== 'object')
                throw new IOError('MP4 input returned an invalid iterator result');
            const done = result.done;
            if (done !== undefined && typeof done !== 'boolean')
                throw new IOError('MP4 input iterator done must be boolean');
            if (done) {
                this.ended = true;
                return false;
            }

            const value = result.value;
            const count = outputByteLength(value);
            if (count > this.maxChunkBytes)
                throw new MediaForgeError('MP4 input chunk exceeds maxInputChunkBytes', 'OOM');
            if (count === 0) {
                if (++this.emptyChunks > this.maxEmptyChunks)
                    throw new IOError('MP4 input exceeds maxEmptyChunks without making progress');
                continue;
            }

            this.emptyChunks = 0;
            this.chunk = new Uint8Array(value);
            this.at = 0;
            return true;
        }
        return false;
    }
}
