import type { Sink } from '../core/model/types';
import { awaitWithAbort, linkAbortSignals, checkSignal } from '../core/io/abort';
import { abortError } from '../core/errors/errors';

export async function executeWithSink<T>(
    sink: Sink,
    signals: readonly (AbortSignal | undefined)[],
    run: (sink: Sink, signal: AbortSignal, invoke: <R>(action: () => R) => R) => Promise<T>,
): Promise<T> {
    const linked = linkAbortSignals(...signals, sink.signal);
    let failure: { reason: unknown } | undefined;
    const invoke = <R>(action: () => R): R => {
        checkSignal(linked.signal);
        try {
            return action();
        } catch (reason) {
            failure ??= { reason };
            throw reason;
        }
    };

    const wait = <R>(action: () => PromiseLike<R>): Promise<R> =>
        awaitWithAbort(
            Promise.resolve(invoke(action)).catch(reason => {
                if (!linked.signal.aborted) failure ??= { reason };
                throw reason;
            }),
            linked.signal,
        );

    const guarded: Sink = {
        signal: linked.signal,
        write: bytes => invoke(() => sink.write(bytes)),
        close: () => wait(() => sink.close()),
        ...(sink.patchAt
            ? {
                  patchAt: (offset: number, bytes: Uint8Array) =>
                      invoke(() => sink.patchAt!(offset, bytes)),
              }
            : {}),
        ...(sink.drain ? { drain: () => wait(() => sink.drain!()) } : {}),
    };

    try {
        const result = await wait(() => run(guarded, linked.signal, invoke));
        checkSignal(linked.signal);
        return result;
    } catch (error) {
        const reason = failure
            ? failure.reason
            : linked.signal.aborted
              ? abortError(linked.signal)
              : error;
        try {
            void Promise.resolve(sink.abort?.(reason)).catch(() => undefined);
        } catch {}
        throw reason;
    } finally {
        linked.dispose();
    }
}
