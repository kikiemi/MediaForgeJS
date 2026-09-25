import { StreamingPcmTransformer } from './streaming-pcm.js';
export function normalizePcmSource(source, targetSampleRate, targetChannels, window = {}) {
    const convertedFrames = Math.ceil((source.estimatedFrames * targetSampleRate) / source.sampleRate);
    const head = Math.max(0, Math.round(window.head ?? 0));
    const valid = Math.max(0, Math.round(window.valid ?? 0));
    const estimatedFrames = valid > 0 ? Math.min(valid, Math.max(0, convertedFrames - head)) : Math.max(0, convertedFrames - head);
    return {
        sampleRate: targetSampleRate,
        channels: targetChannels,
        estimatedFrames,
        async *chunks(signal) {
            signal?.throwIfAborted();
            const pending = [];
            const transformer = new StreamingPcmTransformer(source.sampleRate, source.channels, targetSampleRate, targetChannels, channels => pending.push(channels), window);
            let iterator;
            let inputDone = false;
            try {
                const iterable = source.chunks(signal);
                signal?.throwIfAborted();
                iterator = iterable[Symbol.asyncIterator]();
                signal?.throwIfAborted();
                const next = iterator.next;
                while (true) {
                    signal?.throwIfAborted();
                    const reading = Promise.resolve(next.call(iterator));
                    let result;
                    if (signal) {
                        let onAbort = () => undefined;
                        const aborted = new Promise((_resolve, reject) => {
                            onAbort = () => reject(signal.reason);
                            signal.addEventListener('abort', onAbort, { once: true });
                            if (signal.aborted)
                                onAbort();
                        });
                        try {
                            result = await Promise.race([reading, aborted]);
                        }
                        finally {
                            signal.removeEventListener('abort', onAbort);
                        }
                    }
                    else {
                        result = await reading;
                    }
                    signal?.throwIfAborted();
                    const done = result.done;
                    signal?.throwIfAborted();
                    if (done) {
                        inputDone = true;
                        break;
                    }
                    const chunk = result.value;
                    signal?.throwIfAborted();
                    transformer.push(chunk);
                    while (pending.length > 0) {
                        signal?.throwIfAborted();
                        yield pending.shift();
                        signal?.throwIfAborted();
                    }
                }
                signal?.throwIfAborted();
                transformer.flush();
                while (pending.length > 0) {
                    signal?.throwIfAborted();
                    yield pending.shift();
                    signal?.throwIfAborted();
                }
            }
            finally {
                pending.length = 0;
                if (iterator && !inputDone) {
                    try {
                        void Promise.resolve(iterator.return?.()).catch(() => undefined);
                    }
                    catch { }
                }
            }
        },
    };
}
