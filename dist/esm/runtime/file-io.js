import { IOError, MediaForgeError } from '../core/errors.js';
import { assertAbortSignal } from '../core/abort.js';
import { sourceReadEnd } from '../io/source-read.js';
import { StreamSink } from '../io/sinks.js';
export function ownsHandle(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new IOError('Expected file options');
    const own = options.closeHandle;
    if (own !== undefined && typeof own !== 'boolean')
        throw new IOError('closeHandle must be a boolean');
    return own ?? false;
}
export function fileSourceSignal(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new IOError('Expected file options');
    const signal = options.signal;
    assertAbortSignal(signal);
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
    return signal;
}
export function validateFileSize(size) {
    if (!Number.isSafeInteger(size) || size < 0)
        throw new IOError('File size must be a non-negative safe integer');
}
export function fileHighWaterMark(value) {
    const result = value ?? 1024 * 1024;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new IOError('highWaterMark must be a positive safe integer');
    return result;
}
export class PositionedFileSource {
    reader;
    size;
    own;
    closed = false;
    closePromise = null;
    controller = new AbortController();
    detach;
    constructor(reader, size, own, signal) {
        this.reader = reader;
        this.size = size;
        this.own = own;
        validateFileSize(size);
        assertAbortSignal(signal);
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        const onAbort = () => {
            this.close().catch(() => undefined);
        };
        this.detach = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    }
    async read(offset, length) {
        if (this.closed)
            throw new MediaForgeError('File source is closed', 'ABORT');
        const end = sourceReadEnd(offset, length, this.size);
        if (end <= offset)
            return new Uint8Array(0);
        const bytes = new Uint8Array(end - offset);
        let position = 0;
        while (position < bytes.length) {
            const count = await this.readPart(bytes.subarray(position), offset + position);
            if (this.closed)
                throw new MediaForgeError('File source is closed', 'ABORT');
            if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - position) {
                throw new IOError('File read ended early or returned an invalid byte count');
            }
            position += count;
        }
        return bytes;
    }
    async readPart(bytes, position) {
        let rejectAbort = () => undefined;
        const aborted = new Promise((_resolve, reject) => {
            rejectAbort = reject;
        });
        const onAbort = () => rejectAbort(new MediaForgeError('File source is closed', 'ABORT'));
        const signal = this.controller.signal;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
        try {
            return await Promise.race([
                Promise.resolve().then(() => {
                    if (this.closed)
                        throw new MediaForgeError('File source is closed', 'ABORT');
                    return this.reader.readAt(bytes, position, signal);
                }),
                aborted,
            ]);
        }
        finally {
            signal.removeEventListener('abort', onAbort);
        }
    }
    close() {
        if (!this.closePromise) {
            this.closed = true;
            this.detach();
            this.controller.abort();
            this.closePromise = Promise.resolve().then(() => (this.own ? this.reader.close() : undefined));
        }
        return this.closePromise;
    }
}
export class PositionedFileSink {
    sink;
    constructor(writer, own, options = {}) {
        let closed = false;
        const controller = new AbortController();
        let released = null;
        const release = () => {
            if (!released) {
                closed = true;
                controller.abort();
                released = Promise.resolve().then(() => (own ? writer.close() : undefined));
            }
            return released;
        };
        this.sink = new StreamSink({
            write: async ({ position, data }) => {
                const bytes = new Uint8Array(data);
                let offset = 0;
                try {
                    while (offset < bytes.length) {
                        if (closed)
                            throw new MediaForgeError('File sink is closed', 'ABORT');
                        const count = await writer.writeAt(bytes.subarray(offset), position + offset, controller.signal);
                        if (closed)
                            throw new MediaForgeError('File sink is closed', 'ABORT');
                        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
                            throw new IOError('File write returned an invalid byte count');
                        }
                        offset += count;
                    }
                }
                catch (error) {
                    release().catch(() => undefined);
                    throw error;
                }
            },
            close: release,
            abort: async () => {
                release().catch(() => undefined);
            },
        }, { highWaterMark: fileHighWaterMark(options.highWaterMark) });
    }
    write(bytes) {
        this.sink.write(bytes);
    }
    patchAt(offset, bytes) {
        this.sink.patchAt(offset, bytes);
    }
    drain() {
        return this.sink.drain();
    }
    close() {
        return this.sink.close();
    }
    abort(reason) {
        return this.sink.abort(reason);
    }
    get done() {
        return this.sink.done;
    }
}
