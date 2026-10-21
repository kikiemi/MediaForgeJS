import { MediaForgeError, abortError, throwIfAborted } from '../errors/errors';

/** Whether `value` is undefined or an AbortSignal: it has `aborted` and the listener methods. */
export function isOptionalSignal(value: unknown): value is AbortSignal | undefined {
    const signal = value as AbortSignal | undefined;
    return (
        signal === undefined ||
        (!!signal &&
            typeof signal.aborted === 'boolean' &&
            typeof signal.addEventListener === 'function' &&
            typeof signal.removeEventListener === 'function')
    );
}

export function assertAbortSignal(signal: AbortSignal | undefined): void {
    if (!isOptionalSignal(signal)) throw new MediaForgeError('Expected an AbortSignal', 'INPUT');
}

/** Rejects a value that is not an AbortSignal and throws ABORT when it has fired. */
export function checkSignal(signal?: AbortSignal): void {
    assertAbortSignal(signal);
    throwIfAborted(signal);
}

/**
 * The rejections of the awaits pending on each signal, which its one abort listener runs: a pass of
 * many reads then adds no listener per read (adding and removing one costs more than the read).
 */
const waiting = new WeakMap<AbortSignal, Set<(error: MediaForgeError) => void>>();

function waitersOf(signal: AbortSignal): Set<(error: MediaForgeError) => void> {
    let waiters = waiting.get(signal);
    if (!waiters) {
        const pending = (waiters = new Set());
        waiting.set(signal, pending);
        signal.addEventListener(
            'abort',
            () => {
                for (const reject of pending) reject(abortError(signal));
                pending.clear();
            },
            { once: true },
        );
    }
    return waiters;
}

/**
 * Awaits `pending` unless `signal` fires first: a stalled operation does not hide the cancellation.
 * The abort rejects with the signal's reason when that is a library error (a timeout of the
 * library's own, say), and with ABORT otherwise.
 */
export async function awaitWithAbort<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    if (signal.aborted) {
        void Promise.resolve(pending).catch(() => undefined);
        throw abortError(signal);
    }
    const waiters = waitersOf(signal);
    return new Promise<T>((resolve, reject) => {
        waiters.add(reject);
        Promise.resolve(pending).then(
            value => {
                waiters.delete(reject);
                resolve(value);
            },
            (error: unknown) => {
                waiters.delete(reject);
                reject(error);
            },
        );
    });
}

export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    dispose(): void;
} {
    const controller = new AbortController();
    const listeners: Array<() => void> = [];
    for (const signal of signals) {
        if (!signal) continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', abort));
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const remove of listeners.splice(0)) remove();
        },
    };
}
