import { IOError, MediaForgeError } from '../core/errors.js';
import { outputByteLength } from './output-data.js';
import { sourceReadEnd } from './source-read.js';
const PAGE_SIZE = 64 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
async function nextChunk(next, signal) {
    if (!signal)
        return next();
    let rejectAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new MediaForgeError('Stream input was aborted', 'ABORT'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    try {
        return await Promise.race([
            Promise.resolve().then(() => {
                if (signal.aborted)
                    throw new MediaForgeError('Stream input was aborted', 'ABORT');
                return next();
            }),
            aborted,
        ]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
export class StreamSource {
    pages;
    size;
    constructor(pages, size) {
        this.pages = pages;
        this.size = size;
    }
    static async from(input, options) {
        if (!options || typeof options !== 'object')
            throw new IOError('StreamSource requires explicit retention options');
        const { retention, maxBytes, maxEmptyChunks: emptyLimit, signal } = options;
        if (retention !== 'memory' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new IOError('StreamSource requires retention: memory and a non-negative safe maxBytes');
        }
        if (signal !== undefined &&
            (!signal ||
                typeof signal.aborted !== 'boolean' ||
                typeof signal.addEventListener !== 'function' ||
                typeof signal.removeEventListener !== 'function')) {
            throw new IOError('StreamSource requires a valid AbortSignal');
        }
        if (signal?.aborted)
            throw new MediaForgeError('Stream input was aborted', 'ABORT');
        const maxEmptyChunks = emptyLimit === undefined ? 1024 : emptyLimit;
        if (!Number.isSafeInteger(maxEmptyChunks) || maxEmptyChunks < 0) {
            throw new IOError('maxEmptyChunks must be a non-negative safe integer');
        }
        let cancel = () => undefined;
        let release = () => undefined;
        try {
            let next;
            const getReader = input && input.getReader;
            if (typeof getReader === 'function') {
                const reader = getReader.call(input);
                cancel = reason => reader.cancel(reason);
                release = () => reader.releaseLock();
                const read = reader.read;
                if (typeof read !== 'function')
                    throw new IOError('Stream reader must provide read()');
                next = () => read.call(reader);
            }
            else {
                const iterate = input && input[Symbol.asyncIterator];
                if (typeof iterate !== 'function')
                    throw new IOError('StreamSource requires a byte ReadableStream or AsyncIterable');
                const iterator = iterate.call(input);
                cancel = () => iterator.return?.();
                const pull = iterator.next;
                if (typeof pull !== 'function')
                    throw new IOError('Stream iterator must provide next()');
                next = () => pull.call(iterator);
            }
            const pages = [];
            let page = null;
            let used = 0;
            let size = 0;
            let emptyChunks = 0;
            let pulls = 0;
            let copied = 0;
            const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
            let lastYield = now();
            while (true) {
                const result = await nextChunk(next, signal);
                if (signal?.aborted)
                    throw new MediaForgeError('Stream input was aborted', 'ABORT');
                if (!result || typeof result !== 'object')
                    throw new IOError('Stream iterator must return a result object');
                const done = result.done;
                if (signal?.aborted)
                    throw new MediaForgeError('Stream input was aborted', 'ABORT');
                if (done) {
                    if (page && used < page.length)
                        pages[pages.length - 1] = page.slice(0, used);
                    return new StreamSource(pages, size);
                }
                const value = result.value;
                if (signal?.aborted)
                    throw new MediaForgeError('Stream input was aborted', 'ABORT');
                const count = outputByteLength(value);
                if (count > maxBytes - size)
                    throw new MediaForgeError('Stream input exceeds maxBytes', 'OOM');
                if (count === 0) {
                    if (emptyChunks >= maxEmptyChunks)
                        throw new IOError('Stream input made no byte progress within maxEmptyChunks');
                    emptyChunks++;
                }
                else {
                    emptyChunks = 0;
                    if (!page || used === page.length) {
                        page = new Uint8Array(Math.min(PAGE_SIZE, maxBytes - size));
                        pages.push(page);
                        used = 0;
                    }
                    if (count <= page.length - used) {
                        if (count === 1)
                            page[used] = value[0];
                        else
                            page.set(value, used);
                        used += count;
                    }
                    else {
                        const inputBuffer = buffer.call(value);
                        const inputOffset = byteOffset.call(value);
                        for (let position = 0; position < count;) {
                            if (used === page.length) {
                                page = new Uint8Array(Math.min(PAGE_SIZE, maxBytes - size - position));
                                pages.push(page);
                                used = 0;
                            }
                            const length = Math.min(count - position, page.length - used);
                            page.set(new Uint8Array(inputBuffer, inputOffset + position, length), used);
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
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (signal?.aborted)
                            throw new MediaForgeError('Stream input was aborted', 'ABORT');
                        lastYield = now();
                    }
                }
            }
        }
        catch (error) {
            try {
                Promise.resolve(cancel(error)).catch(() => undefined);
            }
            catch { }
            throw error;
        }
        finally {
            try {
                release();
            }
            catch { }
        }
    }
    async read(offset, length) {
        const end = sourceReadEnd(offset, length, this.size);
        if (end <= offset)
            return new Uint8Array(0);
        const result = new Uint8Array(end - offset);
        let position = offset;
        while (position < end) {
            const index = Math.floor(position / PAGE_SIZE);
            const within = position - index * PAGE_SIZE;
            const count = Math.min(end - position, this.pages[index].length - within);
            result.set(this.pages[index].subarray(within, within + count), position - offset);
            position += count;
        }
        return result;
    }
}
