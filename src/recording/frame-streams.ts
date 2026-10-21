import { MediaForgeError } from '../core/errors/errors';

/**
 * Frames or audio blocks as an async or sync iterable, or a ReadableStream such as
 * MediaStreamTrackProcessor's.
 */
export type FrameStream<T> = AsyncIterable<T> | Iterable<T> | ReadableStream<T>;

/** A block of audio as float planes, with its timestamp in microseconds. */
export interface PcmBlock {
    readonly planes: readonly Float32Array[];
    readonly sampleRate: number;
    readonly timestamp: number;
}

/** A pull-based reader over a frame stream that can be stopped while a read is pending. */
export interface Pull<T> {
    next(): Promise<T | undefined>;
    stop(): Promise<void>;
}

/** Closes a frame or other closable value, ignoring a close that throws. */
export function closeQuietly(value: { close?(): void } | undefined): void {
    try {
        value?.close?.();
    } catch {}
}

/**
 * A pull reader over a stream or iterable. After stop(), an item that a pending read still delivers
 * is closed, and the source is cancelled or returned without waiting for a producer that never
 * yields again.
 */
export function frameReader<T>(source: FrameStream<T>): Pull<T> {
    let read: () => Promise<T | undefined>;
    let release: () => Promise<unknown>;
    if (typeof (source as ReadableStream<T>).getReader === 'function') {
        const stream = (source as ReadableStream<T>).getReader();
        read = async () => {
            const step = await stream.read();
            return step.done ? undefined : step.value;
        };
        release = () => stream.cancel();
    } else {
        const iterable = source as AsyncIterable<T> & Iterable<T>;
        const iterator =
            typeof iterable[Symbol.asyncIterator] === 'function'
                ? iterable[Symbol.asyncIterator]()
                : typeof iterable[Symbol.iterator] === 'function'
                  ? iterable[Symbol.iterator]()
                  : undefined;
        if (!iterator)
            throw new MediaForgeError(
                'Expected frames as an iterable or a ReadableStream',
                'INPUT',
                {
                    hint: 'Pass an array, generator or ReadableStream of frames.',
                },
            );
        read = async () => {
            const step = await iterator.next();
            return step.done ? undefined : step.value;
        };
        release = async () => iterator.return?.();
    }

    let pending: Promise<T | undefined> | undefined;
    let stopped = false;
    return {
        next() {
            if (stopped) return Promise.resolve(undefined);
            const current = read();
            pending = current;
            return current.then(
                value => {
                    if (pending === current) pending = undefined;
                    if (!stopped) return value;
                    closeQuietly(value as { close?(): void } | undefined);
                    return undefined;
                },
                error => {
                    if (pending === current) pending = undefined;
                    throw error;
                },
            );
        },
        async stop() {
            if (stopped) return;
            stopped = true;
            const settled = pending;
            const returned = Promise.resolve()
                .then(release)
                .catch(() => undefined);
            if (!settled) await returned;
        },
    };
}
