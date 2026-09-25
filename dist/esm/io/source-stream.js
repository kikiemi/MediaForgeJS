import { IOError, MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from './source-read.js';
const OPTION_KEYS = new Set(['chunkBytes', 'signal', 'onProgress']);
export function sourceToReadableStream(source, options = {}) {
    let size;
    let read;
    let chunkBytes;
    let signal;
    let onProgress;
    let addAbort;
    let removeAbort;
    try {
        size = source.size;
        read = source.read;
        if (!options ||
            typeof options !== 'object' ||
            Array.isArray(options) ||
            Object.keys(options).some(key => !OPTION_KEYS.has(key)))
            throw new Error();
        chunkBytes = options.chunkBytes;
        signal = options.signal;
        onProgress = options.onProgress;
        if (onProgress !== undefined && typeof onProgress !== 'function')
            throw new Error();
        if (signal !== undefined) {
            addAbort = signal?.addEventListener;
            removeAbort = signal?.removeEventListener;
            if (!signal ||
                typeof signal.aborted !== 'boolean' ||
                typeof addAbort !== 'function' ||
                typeof removeAbort !== 'function')
                throw new Error();
        }
    }
    catch {
        throw new IOError('Source stream requires a readable Source and valid options');
    }
    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
        throw new IOError('Source stream requires a non-negative safe size and read method');
    }
    if (chunkBytes === undefined)
        chunkBytes = 256 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
        throw new IOError('Source stream chunkBytes must be a positive safe integer');
    }
    const chunkSize = chunkBytes;
    let position = 0;
    let stopped = false;
    let listening = false;
    let controller;
    let releasePull;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        if (listening) {
            listening = false;
            try {
                removeAbort.call(signal, 'abort', onAbort);
            }
            catch { }
        }
        const release = releasePull;
        releasePull = undefined;
        release?.();
    };
    const fail = (reason) => {
        if (stopped)
            return;
        stop();
        controller.error(reason);
    };
    const onAbort = () => fail(new MediaForgeError('Source stream was aborted', 'ABORT'));
    return new ReadableStream({
        start(current) {
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
                    addAbort.call(signal, 'abort', onAbort, { once: true });
                    if (signal.aborted)
                        onAbort();
                }
                catch (error) {
                    fail(error);
                }
            }
        },
        async pull() {
            if (stopped)
                return;
            const count = Math.min(chunkSize, size - position);
            let release = () => undefined;
            const ended = new Promise(resolve => {
                release = () => resolve(undefined);
            });
            releasePull = release;
            try {
                let pending;
                try {
                    pending = read.call(source, position, count);
                }
                catch (error) {
                    fail(error);
                    return;
                }
                const result = await Promise.race([
                    Promise.resolve(pending).then(bytes => ({ bytes }), error => {
                        fail(error);
                        return undefined;
                    }),
                    ended,
                ]);
                if (stopped || !result)
                    return;
                assertSourceBytes(result.bytes, count, 'Source stream');
                let output;
                try {
                    output = new Uint8Array(result.bytes);
                }
                catch {
                    throw new MediaForgeError('Source stream could not copy the input chunk', 'OOM');
                }
                if (stopped)
                    return;
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
                    if (stopped)
                        return;
                }
                position += count;
                controller.enqueue(output);
                if (position === size) {
                    stop();
                    controller.close();
                }
            }
            catch (error) {
                fail(error);
            }
            finally {
                if (releasePull === release)
                    releasePull = undefined;
            }
        },
        cancel() {
            stop();
        },
    }, { highWaterMark: 0 });
}
