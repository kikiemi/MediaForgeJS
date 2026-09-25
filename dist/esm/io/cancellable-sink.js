import { awaitWithAbort } from '../core/abort.js';
export function createCancellableSink(sink, signal, onFailure) {
    const write = sink.write;
    const close = sink.close;
    const abort = sink.abort;
    const patchAt = sink.patchAt;
    const drain = sink.drain;
    let pendingClose;
    let pendingAbort;
    const invoke = (operation) => {
        try {
            return operation();
        }
        catch (reason) {
            onFailure?.(reason, signal.aborted);
            throw reason;
        }
    };
    const observe = (operation) => {
        return Promise.resolve(invoke(operation)).catch(reason => {
            onFailure?.(reason, signal.aborted);
            throw reason;
        });
    };
    const closeOnce = (reportFailure = true) => {
        pendingClose ??= Promise.resolve().then(() => reportFailure ? observe(() => close.call(sink)) : close.call(sink));
        return pendingClose;
    };
    return {
        signal: sink.signal,
        write: data => invoke(() => write.call(sink, data)),
        close: async () => {
            signal.throwIfAborted();
            await awaitWithAbort(closeOnce(), signal);
        },
        abort: reason => {
            pendingAbort ??= Promise.resolve().then(() => (abort ? abort.call(sink, reason) : closeOnce(false)));
            return awaitWithAbort(pendingAbort, signal);
        },
        ...(patchAt
            ? { patchAt: (offset, data) => invoke(() => patchAt.call(sink, offset, data)) }
            : {}),
        ...(drain ? { drain: () => observe(() => drain.call(sink)) } : {}),
    };
}
