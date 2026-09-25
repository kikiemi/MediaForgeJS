import { awaitWithAbort } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
export function assertSink(sink) {
    if (!sink ||
        typeof sink.write !== 'function' ||
        typeof sink.close !== 'function' ||
        ['abort', 'drain', 'patchAt'].some(key => {
            const value = sink[key];
            return value !== undefined && typeof value !== 'function';
        }) ||
        (sink.signal !== undefined &&
            (!sink.signal ||
                typeof sink.signal.aborted !== 'boolean' ||
                typeof sink.signal.addEventListener !== 'function' ||
                typeof sink.signal.removeEventListener !== 'function'))) {
        throw new MediaForgeError('sink must provide write() and close(), with valid optional drain(), abort(), patchAt() and signal', 'IO');
    }
}
export async function drainSink(sink, signal) {
    const pending = sink.drain?.();
    if (pending)
        await awaitWithAbort(pending, signal);
    else
        signal?.throwIfAborted();
}
