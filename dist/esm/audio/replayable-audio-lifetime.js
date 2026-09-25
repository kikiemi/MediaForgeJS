import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { EncodeError } from '../core/errors.js';
import { assertSink } from '../io/sink-backpressure.js';
const typedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayValues = typedArrayPrototype.values;
function pcmPlanes(value, channels) {
    if (!Array.isArray(value) || value.length !== channels) {
        throw new EncodeError('PCM replay changed channel count');
    }
    const planes = [];
    try {
        for (let channel = 0; channel < channels; channel++) {
            const plane = value[channel];
            if (typedArrayTag.call(plane) !== 'Float32Array')
                throw new TypeError('not Float32 PCM');
            typedArrayValues.call(plane);
            const frames = typedArrayLength.call(plane);
            if (planes.length && planes[0].length !== frames)
                throw new TypeError('uneven PCM planes');
            planes.push(new Float32Array(typedArrayBuffer.call(plane), typedArrayOffset.call(plane), frames));
        }
    }
    catch {
        throw new EncodeError('PCM replay must return attached, equally sized Float32Array planes');
    }
    return planes;
}
export async function runReplayableAudio(source, sink, options, action) {
    if (sink !== undefined)
        assertSink(sink);
    const stop = new AbortController();
    const linked = linkAbortSignals(options.signal, sink?.signal, stop.signal);
    const lifetime = new CodecLifetime(linked.signal);
    const inputs = new Set();
    const invoke = (operation) => {
        lifetime.check();
        try {
            return operation();
        }
        catch (error) {
            throw lifetime.record(error);
        }
    };
    const perform = (operation) => {
        const value = invoke(operation);
        lifetime.check();
        return value;
    };
    const waitFor = (operation) => lifetime.waitFor(invoke(operation));
    try {
        lifetime.check();
        const sampleRate = source?.sampleRate;
        const channels = source?.channels;
        const estimatedFrames = source?.estimatedFrames;
        const chunks = source?.chunks;
        if (!Number.isInteger(sampleRate) ||
            sampleRate <= 0 ||
            sampleRate > 0xffffffff ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 0x7fff ||
            !Number.isSafeInteger(estimatedFrames) ||
            estimatedFrames < 0 ||
            typeof chunks !== 'function') {
            throw new EncodeError('PCM source requires valid sample rate, channels, frame estimate and chunks()');
        }
        const guardedSource = {
            sampleRate,
            channels,
            estimatedFrames,
            chunks: () => ({
                [Symbol.asyncIterator]() {
                    const iterable = perform(() => chunks.call(source, linked.signal));
                    const getIterator = perform(() => iterable?.[Symbol.asyncIterator]);
                    if (typeof getIterator !== 'function') {
                        throw lifetime.record(new EncodeError('PCM replay must provide an async iterable'));
                    }
                    const iterator = invoke(() => getIterator.call(iterable));
                    let done = false;
                    let frames = 0;
                    const close = () => {
                        if (done)
                            return;
                        done = true;
                        inputs.delete(close);
                        try {
                            void Promise.resolve(iterator.return?.()).catch(() => undefined);
                        }
                        catch { }
                    };
                    inputs.add(close);
                    const next = perform(() => iterator?.next);
                    if (typeof next !== 'function') {
                        throw lifetime.record(new EncodeError('PCM replay must provide an async iterator'));
                    }
                    return {
                        async next() {
                            if (done)
                                return { done: true, value: undefined };
                            try {
                                const result = await waitFor(() => next.call(iterator));
                                if (!result || typeof result !== 'object') {
                                    throw new EncodeError('PCM replay returned an invalid iterator result');
                                }
                                if (result.done) {
                                    done = true;
                                    inputs.delete(close);
                                    return { done: true, value: undefined };
                                }
                                const planes = perform(() => pcmPlanes(result.value, channels));
                                const count = planes[0].length;
                                if (count > Number.MAX_SAFE_INTEGER - frames) {
                                    throw new EncodeError('PCM replay frame count exceeds the safe integer range');
                                }
                                frames += count;
                                return { done: false, value: planes };
                            }
                            catch (error) {
                                const failure = lifetime.record(error);
                                close();
                                throw failure;
                            }
                        },
                        async return() {
                            close();
                            return { done: true, value: undefined };
                        },
                    };
                },
            }),
        };
        let guardedSink;
        if (sink) {
            const write = sink.write;
            const close = sink.close;
            const drain = sink.drain;
            const patchAt = sink.patchAt;
            guardedSink = {
                signal: linked.signal,
                write: bytes => perform(() => write.call(sink, bytes)),
                close: () => waitFor(() => close.call(sink)),
                ...(drain ? { drain: () => waitFor(() => drain.call(sink)) } : {}),
                ...(patchAt
                    ? {
                        patchAt: (offset, bytes) => perform(() => patchAt.call(sink, offset, bytes)),
                    }
                    : {}),
            };
        }
        const progress = options.onProgress;
        const afterPcmChunk = options.afterPcmChunk;
        const guardedOptions = {
            ...options,
            signal: linked.signal,
            onProgress: (fraction, message) => perform(() => progress?.(fraction, message)),
            ...(afterPcmChunk ? { afterPcmChunk: () => waitFor(() => afterPcmChunk()) } : {}),
        };
        return await waitFor(() => action(guardedSource, guardedSink, guardedOptions, perform));
    }
    catch (error) {
        throw lifetime.record(error);
    }
    finally {
        lifetime.stop();
        stop.abort();
        linked.dispose();
        for (const close of inputs)
            close();
    }
}
