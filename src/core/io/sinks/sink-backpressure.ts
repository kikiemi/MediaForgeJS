import { awaitWithAbort, isOptionalSignal } from '../abort';
import type { Sink } from '../../model/types';
import { MediaForgeError, throwIfAborted } from '../../errors/errors';

export function assertSink(sink: Sink): void {
    if (
        !sink ||
        typeof sink.write !== 'function' ||
        typeof sink.close !== 'function' ||
        ['abort', 'drain', 'patchAt'].some(key => {
            const value = sink[key as 'abort' | 'drain' | 'patchAt'];
            return value !== undefined && typeof value !== 'function';
        }) ||
        (sink.copiesWrites !== undefined && typeof sink.copiesWrites !== 'boolean') ||
        !isOptionalSignal(sink.signal)
    ) {
        throw new MediaForgeError('sink is not a valid Sink', 'INPUT', {
            hint: 'Give it write() and close(); its other methods are optional.',
        });
    }
}

const readyChecks = new WeakMap<object, () => boolean>();

/**
 * Declares that `sink.drain()` resolves at once, and does nothing else, while `ready()` is true, so
 * a loop that writes many packets may skip the call and its promises.
 */
export function declareDrainReady(sink: object, ready: () => boolean): void {
    readyChecks.set(sink, ready);
}

/** The check a sink declared with declareDrainReady, if any. */
export function drainReadiness(sink: object): (() => boolean) | undefined {
    return readyChecks.get(sink);
}

/** Wait for sink backpressure while keeping AbortSignal responsive. */
export async function drainSink(sink: Sink, signal?: AbortSignal): Promise<void> {
    const pending = sink.drain?.();
    if (pending) await awaitWithAbort(pending, signal);
    else throwIfAborted(signal);
}
