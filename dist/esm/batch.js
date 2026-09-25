import { MediaForgeConverter } from './converter.js';
import { normalizeMediaForgeConfig, snapshotMediaForgeConfig } from './core/converter-config.js';
import { awaitWithAbort, linkAbortSignals } from './core/abort.js';
import { MediaForgeError } from './core/errors.js';
const OPTION_KEYS = new Set(['concurrency', 'resultOrder', 'onFileProgress', 'configure']);
export async function* convertBatch(inputs, config, options = {}) {
    const normalized = normalizeMediaForgeConfig(config);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('batch options must be an object', 'FORMAT');
    }
    for (const key of Object.keys(options)) {
        if (!OPTION_KEYS.has(key))
            throw new MediaForgeError(`Unknown batch option '${key}'`, 'FORMAT');
    }
    const concurrencyOption = options.concurrency;
    const concurrency = concurrencyOption === undefined ? 1 : concurrencyOption;
    const resultOrderOption = options.resultOrder;
    const resultOrder = resultOrderOption === undefined ? 'completion' : resultOrderOption;
    const onFileProgress = options.onFileProgress;
    const configure = options.configure;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new MediaForgeError('batch concurrency must be an integer in 1..8', 'FORMAT');
    }
    if (resultOrder !== 'completion' && resultOrder !== 'input') {
        throw new MediaForgeError('batch resultOrder must be completion or input', 'FORMAT');
    }
    for (const [key, value] of [
        ['onFileProgress', onFileProgress],
        ['configure', configure],
    ]) {
        if (value !== undefined && typeof value !== 'function') {
            throw new MediaForgeError(`${key} must be a function`, 'FORMAT');
        }
    }
    if (!inputs)
        throw new MediaForgeError('batch inputs must be iterable or async iterable', 'FORMAT');
    const stop = new AbortController();
    const linked = linkAbortSignals(normalized.signal, stop.signal);
    let iterator;
    let readNext;
    const pending = new Map();
    const completed = new Map();
    let notify;
    let nextRead;
    let index = 0;
    let nextResultIndex = 0;
    let exhausted = false;
    let sourceFailed = false;
    let sourceError;
    let failed = false;
    const checkAbort = (signal = linked.signal) => {
        if (signal.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    };
    const wake = () => {
        const resolve = notify;
        notify = undefined;
        resolve?.();
    };
    const runFile = async (input, current) => {
        let fileSignals;
        try {
            checkAbort();
            let fileConfig = normalized;
            if (configure) {
                const overrides = await awaitWithAbort(Promise.resolve(Reflect.apply(configure, options, [input, current])), linked.signal);
                checkAbort();
                if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
                    throw new MediaForgeError('configure must return a config object', 'FORMAT');
                }
                fileConfig = normalizeMediaForgeConfig({ ...normalized, ...snapshotMediaForgeConfig(overrides) });
            }
            fileSignals = linkAbortSignals(linked.signal, fileConfig.signal);
            checkAbort(fileSignals.signal);
            const converter = new MediaForgeConverter({
                ...fileConfig,
                signal: fileSignals.signal,
                onProgress: (percent, message) => {
                    checkAbort(fileSignals.signal);
                    fileConfig.onProgress?.(percent, message);
                    checkAbort(fileSignals.signal);
                    if (onFileProgress)
                        Reflect.apply(onFileProgress, options, [current, percent, message]);
                },
            });
            return { index: current, input, status: 'fulfilled', value: await converter.convert(input) };
        }
        catch (reason) {
            return { index: current, input, status: 'rejected', reason };
        }
        finally {
            fileSignals?.dispose();
        }
    };
    const requestInput = () => {
        nextRead = (async () => {
            try {
                const next = await awaitWithAbort(Promise.resolve(readNext()), linked.signal);
                if (next === null || typeof next !== 'object') {
                    throw new MediaForgeError('batch iterator must return an iterator result', 'FORMAT');
                }
                checkAbort();
                const done = next.done;
                checkAbort();
                if (done) {
                    exhausted = true;
                    return;
                }
                const input = next.value;
                checkAbort();
                const current = index++;
                pending.set(current, runFile(input, current).then(result => {
                    if (!linked.signal.aborted)
                        completed.set(current, result);
                    wake();
                }));
            }
            catch (error) {
                if (!linked.signal.aborted) {
                    sourceFailed = true;
                    sourceError = error;
                }
            }
        })().finally(() => {
            nextRead = undefined;
            wake();
        });
    };
    try {
        checkAbort();
        const asyncMethod = inputs[Symbol.asyncIterator];
        checkAbort();
        const iteratorMethod = asyncMethod ?? inputs[Symbol.iterator];
        checkAbort();
        if (typeof iteratorMethod !== 'function') {
            throw new MediaForgeError('batch inputs must be iterable or async iterable', 'FORMAT');
        }
        iterator = iteratorMethod.call(inputs);
        checkAbort();
        const next = iterator?.next;
        checkAbort();
        if (typeof next !== 'function') {
            throw new MediaForgeError('batch iterator must have a next method', 'FORMAT');
        }
        readNext = () => Reflect.apply(next, iterator, []);
        for (;;) {
            if (sourceFailed)
                throw sourceError;
            checkAbort();
            if (!exhausted && !nextRead && pending.size < concurrency)
                requestInput();
            if (sourceFailed)
                throw sourceError;
            checkAbort();
            const result = resultOrder === 'input' ? completed.get(nextResultIndex) : completed.values().next().value;
            if (result) {
                completed.delete(result.index);
                pending.delete(result.index);
                nextResultIndex++;
                yield result;
            }
            else if (exhausted && !pending.size) {
                return;
            }
            else {
                await awaitWithAbort(new Promise(resolve => {
                    notify = resolve;
                }), linked.signal);
            }
        }
    }
    catch (error) {
        failed = true;
        throw sourceFailed ? sourceError : error;
    }
    finally {
        const cancelled = linked.signal.aborted;
        stop.abort();
        await Promise.allSettled([...pending.values(), ...(nextRead ? [nextRead] : [])]);
        completed.clear();
        notify = undefined;
        linked.dispose();
        if (!exhausted && iterator) {
            try {
                const close = iterator.return;
                if (close) {
                    const closing = Promise.resolve(Reflect.apply(close, iterator, []));
                    void closing.catch(() => undefined);
                }
            }
            catch (error) {
                if (!failed && !cancelled)
                    throw error;
            }
        }
    }
}
