import { MediaForgeError } from './errors.js';
export function assertAbortSignal(signal) {
    if (signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function'))
        throw new MediaForgeError('Expected an AbortSignal', 'INPUT');
}
export async function awaitWithAbort(pending, signal) {
    if (!signal)
        return pending;
    if (signal.aborted) {
        void Promise.resolve(pending).catch(() => undefined);
        throw new MediaForgeError('Aborted', 'ABORT');
    }
    let onAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(new MediaForgeError('Aborted', 'ABORT'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve(pending), aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
export function linkAbortSignals(...signals) {
    const controller = new AbortController();
    const listeners = [];
    for (const signal of signals) {
        if (!signal)
            continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', abort));
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const remove of listeners.splice(0))
                remove();
        },
    };
}
