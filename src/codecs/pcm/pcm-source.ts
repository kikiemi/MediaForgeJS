import { throwIfAborted } from '../../core/errors/errors';
import type { PcmStreamWindow } from './streaming-pcm';
import { StreamingPcmTransformer } from './streaming-pcm';

/** A source that can be decoded again for multi-pass, bounded-memory codecs. */
export interface ReplayablePcmSource {
    readonly sampleRate: number;
    readonly channels: number;
    readonly estimatedFrames: number;
    /** WAVE speaker mask of the planes; omitted means the default layout for the channel count. */
    readonly channelMask?: number;
    chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]>;
}

/**
 * Adds channel mapping, resampling and presentation trimming to a source. Without resampling, a
 * source that starts at a later packet (declarePcmStarts) starts at the packet the head ends in,
 * so the frames the head drops are not decoded; the result starts there too.
 */
export function normalizePcmSource(
    source: ReplayablePcmSource,
    targetSampleRate: number,
    targetChannels: number,
    window: PcmStreamWindow = {},
): ReplayablePcmSource {
    const head = Math.max(0, Math.round(window.head ?? 0));
    const valid = Math.max(0, Math.round(window.valid ?? 0));
    const start = source.sampleRate === targetSampleRate ? starts.get(source) : undefined;
    const near = head > 0 ? start?.(head) : undefined;
    const normalized = near
        ? mappedSource(near.source, targetSampleRate, targetChannels, {
              head: head - near.from,
              valid,
          })
        : mappedSource(source, targetSampleRate, targetChannels, window);
    // Frame f of the result is frame f + head of the source.
    if (start)
        declarePcmStarts(normalized, frame => {
            const later = start(frame + head);
            const from = later ? later.from - head : 0;
            if (!later || from <= 0 || (valid > 0 && from >= valid)) return undefined;
            return {
                from,
                source: mappedSource(later.source, targetSampleRate, targetChannels, {
                    valid: valid > 0 ? valid - from : 0,
                }),
            };
        });
    return normalized;
}

function mappedSource(
    source: ReplayablePcmSource,
    targetSampleRate: number,
    targetChannels: number,
    window: PcmStreamWindow,
): ReplayablePcmSource {
    const convertedFrames = Math.ceil(
        (source.estimatedFrames * targetSampleRate) / source.sampleRate,
    );
    const head = Math.max(0, Math.round(window.head ?? 0));
    const valid = Math.max(0, Math.round(window.valid ?? 0));
    const estimatedFrames =
        valid > 0
            ? Math.min(valid, Math.max(0, convertedFrames - head))
            : Math.max(0, convertedFrames - head);

    const channelMask = targetChannels === source.channels ? source.channelMask : undefined;
    const normalized: ReplayablePcmSource = {
        sampleRate: targetSampleRate,
        channels: targetChannels,
        estimatedFrames,
        ...(channelMask !== undefined ? { channelMask } : {}),
        async *chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]> {
            throwIfAborted(signal);
            const pending: Array<readonly Float32Array[]> = [];
            const transformer = new StreamingPcmTransformer(
                source.sampleRate,
                source.channels,
                targetSampleRate,
                targetChannels,
                channels => pending.push(channels),
                window,
                source.channelMask,
            );
            let iterator: AsyncIterator<readonly Float32Array[]> | undefined;
            let inputDone = false;

            // One abort listener serves every read: it rejects the read being awaited, if any.
            let rejectRead: ((reason: unknown) => void) | undefined;
            const onAbort = (): void => rejectRead?.(signal!.reason);
            signal?.addEventListener('abort', onAbort);
            try {
                const iterable = source.chunks(signal);
                throwIfAborted(signal);
                iterator = iterable[Symbol.asyncIterator]();
                throwIfAborted(signal);
                const next = iterator.next;
                while (true) {
                    throwIfAborted(signal);
                    const reading = Promise.resolve(next.call(iterator));
                    let result: IteratorResult<readonly Float32Array[]>;
                    if (signal) {
                        try {
                            result = await new Promise<IteratorResult<readonly Float32Array[]>>(
                                (resolve, reject) => {
                                    rejectRead = reject;
                                    reading.then(resolve, reject);
                                    if (signal.aborted) reject(signal.reason);
                                },
                            );
                        } finally {
                            rejectRead = undefined;
                        }
                    } else {
                        result = await reading;
                    }
                    throwIfAborted(signal);
                    const done = result.done;
                    throwIfAborted(signal);
                    if (done) {
                        inputDone = true;
                        break;
                    }
                    const chunk = result.value;
                    throwIfAborted(signal);
                    transformer.push(chunk);
                    while (pending.length > 0) {
                        throwIfAborted(signal);
                        yield pending.shift()!;
                        throwIfAborted(signal);
                    }

                    // A bounded window stops reading its source once it is filled.
                    if (transformer.complete) return;
                }
                throwIfAborted(signal);
                transformer.flush();
                while (pending.length > 0) {
                    throwIfAborted(signal);
                    yield pending.shift()!;
                    throwIfAborted(signal);
                }
            } finally {
                signal?.removeEventListener('abort', onAbort);
                pending.length = 0;
                if (iterator && !inputDone) {
                    try {
                        void Promise.resolve(iterator.return?.()).catch(() => undefined);
                    } catch {}
                }
            }
        },
    };
    return normalized;
}

/**
 * A source from a later frame of another: its first frame is frame `from` of that source, and the
 * frames after it are that source's.
 */
export interface PcmSourceStart {
    readonly source: ReplayablePcmSource;
    readonly from: number;
}

/** How each source starts near a frame, for sources that can (declarePcmStarts). */
const starts = new WeakMap<ReplayablePcmSource, (frame: number) => PcmSourceStart | undefined>();

/**
 * Declares that `source` can start near a frame without producing the frames before it: `start`
 * returns a source from a frame after 0 and at or before `frame`, or undefined. Returns `source`.
 */
export function declarePcmStarts<T extends ReplayablePcmSource>(
    source: T,
    start: (frame: number) => PcmSourceStart | undefined,
): T {
    starts.set(source, start);
    return source;
}

/** A source from a frame after 0 and at or before `frame` of `source`, where it declared one. */
export function pcmSourceFrom(
    source: ReplayablePcmSource,
    frame: number,
): PcmSourceStart | undefined {
    return starts.get(source)?.(frame);
}

/**
 * Declares that `source` starts at each of its `count` packets: packet `index` holds
 * `frames(index)` frames, and `from(index, frame)` is the source from that packet, which starts at
 * frame `frame`, or undefined. Returns `source`.
 */
export function declarePacketStarts<T extends ReplayablePcmSource>(
    source: T,
    count: number,
    frames: (index: number) => number,
    from: (index: number, frame: number) => ReplayablePcmSource | undefined,
): T {
    let ends: Float64Array | undefined;
    return declarePcmStarts(source, frame => {
        if (!ends) {
            ends = new Float64Array(count);
            for (let index = 0, end = 0; index < count; index++) ends[index] = end += frames(index);
        }
        // The packet a frame is in is the first that ends after it.
        let low = 0;
        let high = count - 1;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (ends[middle]! <= frame) low = middle + 1;
            else high = middle;
        }
        const at = low && ends[low - 1]!;
        const started = at > 0 ? from(low, at) : undefined;
        return started && { from: at, source: started };
    });
}
