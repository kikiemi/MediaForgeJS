import type { MediaProgress } from '../../core/model/media';
import { linkAbortSignals } from '../../core/io/abort';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { EncodeError } from '../../core/errors/errors';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { copiesWrites } from '../../core/io/sinks/copying-sinks';
import type { Sink } from '../../core/model/types';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { attachedView } from '../../core/bytes/typed-array';

interface ReplayableAudioOptions {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly afterPcmChunk?: () => Promise<void>;
}

function pcmPlanes(value: readonly Float32Array[], channels: number): Float32Array[] {
    if (!Array.isArray(value) || value.length !== channels) {
        throw new EncodeError('PCM replay changed channel count');
    }
    const planes: Float32Array[] = [];
    try {
        for (let channel = 0; channel < channels; channel++) {
            const plane = attachedView(value[channel]!, 'Float32Array');
            if (planes.length && planes[0]!.length !== plane.length)
                throw new TypeError('uneven PCM planes');
            planes.push(plane);
        }
    } catch {
        throw new EncodeError('PCM replay must return attached, equally sized Float32Array planes');
    }
    return planes;
}

export async function runReplayableAudio<T, O extends ReplayableAudioOptions>(
    source: ReplayablePcmSource,
    sink: Sink | undefined,
    options: O,
    action: (
        source: ReplayablePcmSource,
        sink: Sink | undefined,
        options: O,
        perform: <V>(operation: () => V) => V,
    ) => Promise<T>,
): Promise<T> {
    if (sink !== undefined) assertSink(sink);
    const stop = new AbortController();
    const linked = linkAbortSignals(options.signal, sink?.signal, stop.signal);
    const lifetime = new CodecLifetime(linked.signal);
    const inputs = new Set<() => void>();

    const invoke = <V>(operation: () => V): V => {
        lifetime.check();
        try {
            return operation();
        } catch (error) {
            throw lifetime.record(error);
        }
    };
    const perform = <V>(operation: () => V): V => {
        const value = invoke(operation);
        lifetime.check();
        return value;
    };
    const waitFor = <V>(operation: () => PromiseLike<V>): Promise<V> =>
        lifetime.waitFor(invoke(operation));

    try {
        lifetime.check();
        const sampleRate = source?.sampleRate;
        const channels = source?.channels;
        const estimatedFrames = source?.estimatedFrames;
        const channelMask = source?.channelMask;
        const chunks = source?.chunks;
        if (
            !Number.isInteger(sampleRate) ||
            sampleRate <= 0 ||
            sampleRate > 0xffffffff ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 0x7fff ||
            !Number.isSafeInteger(estimatedFrames) ||
            estimatedFrames < 0 ||
            typeof chunks !== 'function'
        ) {
            throw new EncodeError(
                'PCM source needs a sample rate, channels, frame estimate and chunks()',
            );
        }

        // The speakers go along, so a WAV of a 2.1 or 4.0 source names them.
        const guardedSource: ReplayablePcmSource = {
            sampleRate,
            channels,
            estimatedFrames,
            ...(Number.isInteger(channelMask) && channelMask! > 0 && channelMask! <= 0xffffffff
                ? { channelMask }
                : {}),
            chunks: () => ({
                [Symbol.asyncIterator](): AsyncIterator<readonly Float32Array[]> {
                    const iterable = perform(() => chunks.call(source, linked.signal));
                    const getIterator = perform(() => iterable?.[Symbol.asyncIterator]);
                    if (typeof getIterator !== 'function') {
                        throw lifetime.record(
                            new EncodeError('PCM replay must provide an async iterable'),
                        );
                    }
                    const iterator = invoke(() => getIterator.call(iterable));

                    let done = false;
                    let frames = 0;
                    const close = (): void => {
                        if (done) return;
                        done = true;
                        inputs.delete(close);
                        try {
                            void Promise.resolve(iterator.return?.()).catch(() => undefined);
                        } catch {}
                    };
                    inputs.add(close);

                    const next = perform(() => iterator?.next);
                    if (typeof next !== 'function') {
                        throw lifetime.record(
                            new EncodeError('PCM replay must provide an async iterator'),
                        );
                    }

                    return {
                        async next(): Promise<IteratorResult<readonly Float32Array[]>> {
                            if (done) return { done: true, value: undefined };
                            try {
                                const result = await waitFor(() => next.call(iterator));
                                if (!result || typeof result !== 'object') {
                                    throw new EncodeError(
                                        'PCM replay returned an invalid iterator result',
                                    );
                                }
                                if (result.done) {
                                    done = true;
                                    inputs.delete(close);
                                    return { done: true, value: undefined };
                                }

                                const planes = perform(() => pcmPlanes(result.value, channels));
                                const count = planes[0]!.length;
                                if (count > Number.MAX_SAFE_INTEGER - frames) {
                                    throw new EncodeError(
                                        'PCM replay frame count exceeds the safe integer range',
                                    );
                                }
                                frames += count;
                                return { done: false, value: planes };
                            } catch (error) {
                                const failure = lifetime.record(error);
                                close();
                                throw failure;
                            }
                        },
                        async return(): Promise<IteratorResult<readonly Float32Array[]>> {
                            close();
                            return { done: true, value: undefined };
                        },
                    };
                },
            }),
        };

        let guardedSink: Sink | undefined;
        if (sink) {
            const write = sink.write;
            const close = sink.close;
            const drain = sink.drain;
            const patchAt = sink.patchAt;
            guardedSink = {
                signal: linked.signal,
                // Writes pass to the sink as they are, so it copies them as it does its own.
                ...(sink.copiesWrites === true || copiesWrites(sink) ? { copiesWrites: true } : {}),
                write: bytes => perform(() => write.call(sink, bytes)),
                close: () => waitFor(() => close.call(sink)),
                ...(drain ? { drain: () => waitFor(() => drain.call(sink)) } : {}),
                ...(patchAt
                    ? {
                          patchAt: (offset: number, bytes: Uint8Array) =>
                              perform(() => patchAt.call(sink, offset, bytes)),
                      }
                    : {}),
            };
        }

        const progress = options.onProgress;
        const afterPcmChunk = options.afterPcmChunk;
        const guardedOptions: O = {
            ...options,
            signal: linked.signal,
            onProgress: report => perform(() => progress?.(report)),
            ...(afterPcmChunk ? { afterPcmChunk: () => waitFor(() => afterPcmChunk()) } : {}),
        };

        return await waitFor(() => action(guardedSource, guardedSink, guardedOptions, perform));
    } catch (error) {
        throw lifetime.record(error);
    } finally {
        lifetime.stop();
        stop.abort();
        linked.dispose();
        for (const close of inputs) close();
    }
}
