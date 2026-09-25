import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { checkSignal } from './requests.js';
export async function executeWithSink(sink, signals, run) {
    const linked = linkAbortSignals(...signals, sink.signal);
    let failure;
    const invoke = (action) => {
        checkSignal(linked.signal);
        try {
            return action();
        }
        catch (reason) {
            failure ??= { reason };
            throw reason;
        }
    };
    const wait = (action) => awaitWithAbort(Promise.resolve(invoke(action)).catch(reason => {
        if (!linked.signal.aborted)
            failure ??= { reason };
        throw reason;
    }), linked.signal);
    const guarded = {
        signal: linked.signal,
        write: bytes => invoke(() => sink.write(bytes)),
        close: () => wait(() => sink.close()),
        ...(sink.patchAt
            ? { patchAt: (offset, bytes) => invoke(() => sink.patchAt(offset, bytes)) }
            : {}),
        ...(sink.drain ? { drain: () => wait(() => sink.drain()) } : {}),
    };
    try {
        const result = await wait(() => run(guarded, linked.signal, invoke));
        checkSignal(linked.signal);
        return result;
    }
    catch (error) {
        const reason = failure
            ? failure.reason
            : linked.signal.aborted
                ? new MediaForgeError('Aborted', 'ABORT')
                : error;
        try {
            void Promise.resolve(sink.abort?.(reason)).catch(() => undefined);
        }
        catch { }
        throw reason;
    }
    finally {
        linked.dispose();
    }
}
