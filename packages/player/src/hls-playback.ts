import { MediaForgeError } from 'mediaforgejs/plugins';
import type { HlsVariant } from 'mediaforgejs/streaming';
import type { HlsPartData } from './hls-client.js';
import {
    type HlsPlaybackTracks,
    hlsPlaybackBytes,
    hlsPlaybackTiming,
    hlsPlaybackTracks,
} from './hls-playback-mp4.js';
import { changesCodecs, codecsType, invalidArgument, unsupported } from './support.js';

const activeMedia = new WeakSet<HTMLMediaElement>();

export interface HlsPlaybackOptions {
    /**
     * MSE audio/mp4 or video/mp4 MIME type, including codecs. Otherwise inferred from
     * variant.codecs.
     */
    mimeType?: string;
    /** Calls media.play() once after the first media append; default true. */
    autoplay?: boolean;
    /**
     * Seconds buffered before pulling another unit; default 30. One unit may exceed this target.
     */
    bufferAhead?: number;
    /**
     * Seconds of played media retained, rounded back to a known random-access boundary; default 30.
     */
    bufferBehind?: number;
    /**
     * Source-open and individual append/remove deadline in milliseconds; default 30000. Pauses have
     * no deadline.
     */
    operationTimeoutMs?: number;
    signal?: AbortSignal;
}

/** One stream of fMP4 units with its own SourceBuffer, such as the video or the audio of DASH. */
export interface PlaybackStream {
    readonly units: AsyncIterable<HlsPartData>;
    /** MSE MIME type with codecs; omitted infers it from the units' variant codecs. */
    readonly mimeType?: string;
    /**
     * What the stream holds when its sound or picture is elsewhere (an HLS audio rendition): the
     * inferred type then takes only the variant's codecs of this kind.
     */
    readonly kind?: 'video' | 'audio';
}

/** What a playback tells its caller as it goes. */
export interface PlaybackHooks {
    /**
     * The seconds the first stream's units of a discontinuity sequence move by on the media
     * element's timeline, each time they change: subtitles move by the same.
     */
    readonly offset?: (discontinuity: number, seconds: number) => void;
    /**
     * The first stream's units come from `variant` from `start` seconds of the element's timeline
     * on: once for its first unit, then at each switch.
     */
    readonly variant?: (variant: HlsVariant, start: number) => void;
}

/** Refuses an invalid option, media element or unit of the caller's streams. */
function invalid(message: string): never {
    return invalidArgument(`HLS playback: ${message}`);
}

const EXPLICIT_MIME = /^(?:audio|video)\/mp4\s*;\s*codecs\s*=\s*"[^"\r\n]+"\s*$/i;

/** An MSE type compared as MSE reads it: the same codecs in any order and case are one type. */
function typeKey(mime: string | undefined): string | undefined {
    const parsed = mime?.match(/^([^;]+);\s*codecs\s*=\s*"([^"]*)"\s*$/i);
    if (!parsed) return mime?.toLowerCase();
    const codecs = parsed[2]!.split(',').map(codec => codec.trim().toLowerCase());
    return `${parsed[1]!.trim().toLowerCase()}; codecs="${codecs.sort().join(',')}"`;
}

/**
 * The MSE type of a unit: the stream's own, else the one of its variant's CODECS (those of the
 * stream's kind, for a variant whose sound is in a rendition of its own), so a unit of a variant of
 * other codecs brings its own.
 */
function mimeType(
    value: string | undefined,
    unit: HlsPartData,
    kind: PlaybackStream['kind'],
): string {
    if (value !== undefined) return value;
    const type = codecsType(unit.variant?.codecs, kind, !!unit.variant?.resolution);
    if (type) return type;
    // The sound of a rendition has no mimeType of its own to pass instead.
    if (kind === 'audio')
        unsupported('HLS playback: the variant names no codec of its audio rendition');
    if (kind === 'video') invalid('the variant names no video codec; pass mimeType');
    return invalid('mimeType with codecs is required when variant.codecs is unavailable');
}

/** The playback settings, checked, with their defaults. */
function playbackSettings(options: HlsPlaybackOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    const {
        autoplay = true,
        bufferAhead = 30,
        bufferBehind = 30,
        operationTimeoutMs = 30000,
    } = options;

    const signal = options.signal;
    if (typeof autoplay !== 'boolean') invalid('autoplay must be a boolean');
    if (typeof bufferAhead !== 'number' || !Number.isFinite(bufferAhead) || bufferAhead <= 0)
        invalid('bufferAhead must be positive seconds');
    if (typeof bufferBehind !== 'number' || !Number.isFinite(bufferBehind) || bufferBehind < 0)
        invalid('bufferBehind must be non-negative seconds');
    if (
        typeof operationTimeoutMs !== 'number' ||
        !Number.isFinite(operationTimeoutMs) ||
        operationTimeoutMs <= 0 ||
        operationTimeoutMs > 0x7fffffff
    ) {
        invalid('operationTimeoutMs must be positive and at most 2147483647 milliseconds');
    }

    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.aborted !== 'boolean')
    )
        invalid('signal must be an AbortSignal');

    return { autoplay, bufferAhead, bufferBehind, operationTimeoutMs, signal };
}

/** Checks the media element a playback attaches to. */
function checkMedia(media: HTMLMediaElement): void {
    if (
        !media ||
        [
            'play',
            'load',
            'getAttribute',
            'removeAttribute',
            'addEventListener',
            'removeEventListener',
        ].some(name => typeof (media as unknown as Record<string, unknown>)[name] !== 'function')
    )
        invalid('an HTMLMediaElement is required');
    if (media.srcObject != null) invalid('clear media.srcObject before attaching HLS playback');
}

/**
 * Plays complete fMP4 units in order, borrowing each unit until its append completes. Supports one
 * audio and/or video track, complete moof/mdat units, and no edits except a single zero-offset
 * rate-one edit. Preserves A/V presentation offsets and seeks forward across buffered gaps.
 * Pause/resume uses the media element. Resolves after actual ended; completion, failure, or abort
 * closes the iterator and releases the owned MSE attachment.
 */
export async function playHls(
    media: HTMLMediaElement,
    units: AsyncIterable<HlsPartData>,
    options: HlsPlaybackOptions = {},
): Promise<void> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    return playStreams(media, [{ units, mimeType: options.mimeType }], options);
}

/** One stream of a playback: its iterator, its SourceBuffer and where its timeline stands. */
interface Feed {
    readonly explicitMime: string | undefined;
    readonly kind: PlaybackStream['kind'];
    iterator?: AsyncIterator<HlsPartData>;
    iteratorDone: boolean;
    sourceBuffer?: SourceBuffer;
    tracks?: HlsPlaybackTracks;
    previousDiscontinuity?: number;
    previousMap?: string;
    previousVariant?: string;
    currentMime?: string;
    timelineEnd: number;
    timestampOffset: number;
    randomAccess: number[];
}

/** A unit checked and ready to append. */
interface PreparedUnit {
    readonly init?: Uint8Array<ArrayBuffer>;
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly timing: ReturnType<typeof hlsPlaybackTiming>;
    readonly mime: string;
    readonly mapKey?: string;
    readonly discontinuity: number;
    readonly variant?: HlsVariant;
}

/**
 * Checks one unit of a feed: its timing, its initialization data (the feed's tracks change with
 * it) and the MSE type it plays as.
 */
function prepareUnit(feed: Feed, unit: HlsPartData): PreparedUnit {
    if (!unit || (unit.type !== 'part' && unit.type !== 'segment'))
        invalid('invalid HLS media unit');
    const entry = unit.type === 'part' ? unit.part : unit.segment;
    const discontinuity =
        unit.type === 'part' ? unit.discontinuitySequence : unit.segment.discontinuitySequence;
    if (
        !entry ||
        !Number.isFinite(entry.duration) ||
        entry.duration <= 0 ||
        !Number.isSafeInteger(discontinuity) ||
        discontinuity < 0
    ) {
        invalid('media unit has an invalid duration or discontinuity sequence');
    }

    const map = entry.map;
    const mapKey = map
        ? `${map.uri}\n${map.byteRange?.offset ?? ''}\n${map.byteRange?.length ?? ''}`
        : undefined;
    const init = unit.initData === undefined ? undefined : hlsPlaybackBytes(unit.initData);
    if (init) feed.tracks = hlsPlaybackTracks(init);
    if (!feed.tracks || (mapKey !== feed.previousMap && !init))
        invalid('fMP4 playback needs the initData of each EXT-X-MAP');
    const bytes = hlsPlaybackBytes(unit.data);
    const timing = hlsPlaybackTiming(bytes, feed.tracks);
    const mime = mimeType(feed.explicitMime, unit, feed.kind);
    if (!MediaSource.isTypeSupported(mime))
        unsupported(`HLS playback: unsupported MSE MIME type: ${mime}`);
    return { init, bytes, timing, mime, mapKey, discontinuity, variant: unit.variant };
}

/**
 * Plays several streams of fMP4 units in one media element, each in its own SourceBuffer of one
 * MediaSource (a DASH video and audio adaptation set, say); the playback ends when every stream
 * has ended. Each stream follows the rules of playHls.
 */
export async function playStreams(
    media: HTMLMediaElement,
    streams: readonly PlaybackStream[],
    options: HlsPlaybackOptions = {},
    hooks: PlaybackHooks = {},
): Promise<void> {
    const { autoplay, bufferAhead, bufferBehind, operationTimeoutMs, signal } =
        playbackSettings(options);
    if (!Array.isArray(streams) || !streams.length) invalid('playback needs a stream');
    for (const stream of streams) {
        const explicit = stream?.mimeType;
        if (
            explicit !== undefined &&
            (typeof explicit !== 'string' || !EXPLICIT_MIME.test(explicit))
        )
            invalid('mimeType must be audio/mp4 or video/mp4 with codecs');
    }
    checkMedia(media);
    if (typeof globalThis.MediaSource !== 'function')
        unsupported('HLS playback: MediaSource is unavailable in this environment');

    let failed = false;
    let failure: unknown;
    const feeds: Feed[] = streams.map(stream => ({
        explicitMime: stream.mimeType,
        kind: stream.kind,
        iteratorDone: false,
        timelineEnd: 0,
        timestampOffset: 0,
        randomAccess: [],
    }));
    let mse: MediaSource | undefined;
    let objectUrl: string | undefined;
    let attached = false;
    let ended = false;
    let eos = false;
    let waitingForData = false;
    let started = false;
    const listeners = new Set<() => void>();
    const waiting = new Set<(error: unknown) => void>();
    const record = (error: unknown): unknown => {
        if (!failed) {
            failed = true;
            failure = error;
            for (const reject of waiting) reject(error);
            waiting.clear();
        }
        return failure;
    };
    const check = (): void => {
        if (!failed && signal?.aborted)
            record(new MediaForgeError('HLS playback aborted', 'ABORT'));
        if (failed) throw failure;
    };
    const listen = (target: EventTarget, event: string, callback: () => void): (() => void) => {
        target.addEventListener(event, callback);
        const remove = (): void => {
            target.removeEventListener(event, callback);
            listeners.delete(remove);
        };
        listeners.add(remove);
        return remove;
    };
    const wait = async <T>(pending: PromiseLike<T>): Promise<T> => {
        let rejectWait: (error: unknown) => void = () => undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
            rejectWait = reject;
            if (failed) reject(failure);
            else waiting.add(reject);
        });
        try {
            const result = await Promise.race([pending, stopped]);
            check();
            return result;
        } catch (error) {
            throw record(error);
        } finally {
            waiting.delete(rejectWait);
        }
    };
    const event = async (
        target: EventTarget,
        names: string[],
        action?: () => void,
        timeout = false,
    ): Promise<void> => {
        check();
        let removers: Array<() => void> = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = new Promise<void>((resolve, reject) => {
            removers = names.map(name => listen(target, name, resolve));
            if (timeout)
                timer = setTimeout(
                    () => reject(new MediaForgeError('HLS playback MSE operation timed out', 'IO')),
                    operationTimeoutMs,
                );
        });
        try {
            action?.();
            await wait(pending);
        } finally {
            for (const remove of removers) remove();
            if (timer !== undefined) clearTimeout(timer);
        }
    };
    const ownAttachment = (): boolean =>
        attached && media.srcObject == null && media.getAttribute('src') === objectUrl;
    const skipGap = (): void => {
        if (failed || !ownAttachment() || media.paused || !feeds[0]!.sourceBuffer) return;
        const ranges = media.buffered;
        const time = media.currentTime;
        const tolerance = waitingForData ? 0.05 : 0.001;
        for (let index = 0; index < ranges.length; index++) {
            const start = ranges.start(index);
            if (start > time + 0.001) {
                if (index === 0 || time >= ranges.end(index - 1) - tolerance)
                    media.currentTime = start;
                return;
            }
            if (time < ranges.end(index) - tolerance) return;
        }
    };
    const safeSkipGap = (): void => {
        try {
            skipGap();
        } catch (error) {
            record(error);
        }
    };

    /** The next unit of a feed's stream. */
    const pull = async (feed: Feed): Promise<IteratorResult<HlsPartData>> => {
        check();
        const result = await wait(feed.iterator!.next());
        if (!result || typeof result !== 'object') invalid('invalid async iterator result');
        if (result.done) feed.iteratorDone = true;
        return result;
    };

    /** Attaches the MediaSource to the element, the first time a unit is ready. */
    const attach = async (): Promise<MediaSource> => {
        const source = new MediaSource();
        listen(media, 'error', () =>
            record(media.error ?? new MediaForgeError('HLS media element failed', 'DECODE')),
        );
        listen(media, 'ended', () => {
            if (eos) ended = true;
        });
        listen(source, 'sourceclose', () =>
            record(new MediaForgeError('HLS MediaSource was detached', 'ABORT')),
        );
        listen(media, 'waiting', () => {
            waitingForData = true;
            safeSkipGap();
        });
        listen(media, 'playing', () => {
            waitingForData = false;
        });
        for (const name of ['timeupdate', 'play', 'seeking', 'progress'])
            listen(media, name, safeSkipGap);
        objectUrl = URL.createObjectURL(source);
        await event(
            source,
            ['sourceopen'],
            () => {
                attached = true;
                media.src = objectUrl!;
            },
            true,
        );
        check();
        return source;
    };

    /** A SourceBuffer of the MediaSource for `mime`. */
    const addBuffer = (mime: string): SourceBuffer => {
        const sourceBuffer = mse!.addSourceBuffer(mime);
        sourceBuffer.mode = 'segments';
        listen(sourceBuffer, 'error', () =>
            record(new MediaForgeError('HLS SourceBuffer append failed', 'DECODE')),
        );
        listen(sourceBuffer, 'abort', () =>
            record(new MediaForgeError('HLS SourceBuffer operation aborted', 'ABORT')),
        );
        return sourceBuffer;
    };

    /**
     * Feeds one stream to its end from `prepared`, its first unit, already checked: each unit is
     * appended after the initialization data it needs, and the next is pulled once the buffer
     * ahead of the playhead runs below `bufferAhead`.
     */
    const run = async (feed: Feed, prepared: PreparedUnit): Promise<void> => {
        const sourceBuffer = feed.sourceBuffer!;
        const trim = async (retain: number): Promise<boolean> => {
            check();
            const currentTime = media.currentTime;
            const ranges = sourceBuffer.buffered;
            const start = ranges.length ? ranges.start(0) : Infinity;
            feed.randomAccess = feed.randomAccess.filter(time => time >= start);
            const target = currentTime - retain;
            let end = 0;
            for (const time of feed.randomAccess)
                if (time <= target && time < currentTime) end = Math.max(end, time);
            if (!ranges.length || end <= start || end >= currentTime) return false;
            await event(sourceBuffer, ['updateend'], () => sourceBuffer.remove(0, end), true);
            feed.randomAccess = feed.randomAccess.filter(time => time >= end);
            return true;
        };

        const append = async (data: Uint8Array<ArrayBuffer>): Promise<void> => {
            try {
                await event(
                    sourceBuffer,
                    ['updateend'],
                    () => sourceBuffer.appendBuffer(data),
                    true,
                );
            } catch (error) {
                // A synchronous quota refusal accepts no bytes, so one eviction/retry is safe.
                if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError')
                    throw error;
                if (!(await trim(0))) throw error;
                await event(
                    sourceBuffer,
                    ['updateend'],
                    () => sourceBuffer.appendBuffer(data),
                    true,
                );
            }
        };

        const ahead = (): number => {
            const ranges = sourceBuffer.buffered;
            let seconds = 0;
            for (let index = 0; index < ranges.length; index++)
                seconds += Math.max(
                    0,
                    ranges.end(index) - Math.max(media.currentTime, ranges.start(index)),
                );

            return seconds;
        };

        let unit: PreparedUnit | undefined = prepared;
        while (unit) {
            check();
            const { init, bytes, timing, mime, mapKey, discontinuity, variant } = unit;
            // The new type goes to the SourceBuffer before the init segment of its codecs.
            if (typeKey(mime) !== typeKey(feed.currentMime)) {
                if (!init) invalid('codec changes require new initData');
                if (!changesCodecs(sourceBuffer))
                    unsupported(
                        'HLS playback: this browser cannot change HLS codecs during playback',
                    );
                sourceBuffer.changeType(mime);
                feed.currentMime = mime;
            }

            if (
                feed.previousDiscontinuity === undefined ||
                discontinuity !== feed.previousDiscontinuity
            ) {
                feed.timestampOffset = feed.timelineEnd - timing.start || 0;
                sourceBuffer.timestampOffset = feed.timestampOffset;
                if (feed === feeds[0]) hooks.offset?.(discontinuity, feed.timestampOffset);
            }
            if (feed === feeds[0] && variant && variant.uri !== feed.previousVariant) {
                feed.previousVariant = variant.uri;
                hooks.variant?.(variant, timing.start + feed.timestampOffset);
            }

            await trim(bufferBehind);
            if (init) await append(init);
            await append(bytes);
            const offset = feed.timestampOffset;
            feed.timelineEnd = Math.max(feed.timelineEnd, timing.end + offset);
            feed.randomAccess.push(...timing.randomAccess.map(time => time + offset));
            feed.previousDiscontinuity = discontinuity;
            feed.previousMap = mapKey;
            safeSkipGap();
            if (!started) {
                started = true;
                if (autoplay) {
                    const playing = media.play();
                    void Promise.resolve(playing).catch(record);
                }
            }

            check();
            while (ahead() >= bufferAhead) {
                await event(media, ['timeupdate', 'seeking', 'play', 'progress']);
                await trim(bufferBehind);
            }

            const result = await pull(feed);
            unit = result.done ? undefined : prepareUnit(feed, result.value);
        }
    };

    if (activeMedia.has(media))
        throw new MediaForgeError('HLS playback already owns this media element', 'INPUT');
    activeMedia.add(media);
    try {
        check();
        if (signal)
            listen(signal, 'abort', () =>
                record(new MediaForgeError('HLS playback aborted', 'ABORT')),
            );
        for (const [index, feed] of feeds.entries()) {
            const units = streams[index]!.units;
            const getIterator = units?.[Symbol.asyncIterator];
            if (typeof getIterator !== 'function') invalid('units must be an async iterable');
            feed.iterator = getIterator.call(units);
            if (typeof feed.iterator?.next !== 'function')
                invalid('units must provide an async iterator');
        }

        // Every stream's first unit decides its SourceBuffer, and the MediaSource gets all of them
        // before the first append.
        const firsts: PreparedUnit[] = [];
        for (const feed of feeds) {
            const first = await pull(feed);
            if (first.done) invalid('the stream contains no media units');
            firsts.push(prepareUnit(feed, first.value));
        }
        mse = await attach();

        // The streams share one timeline, which starts at the earliest of their first units.
        const base = Math.min(...firsts.map(first => first.timing.start));
        for (const [index, feed] of feeds.entries()) {
            feed.sourceBuffer = addBuffer(firsts[index]!.mime);
            feed.currentMime = firsts[index]!.mime;
            feed.timelineEnd = firsts[index]!.timing.start - base;
        }
        await Promise.all(feeds.map((feed, index) => run(feed, firsts[index]!)));
        check();
        eos = true;
        mse!.endOfStream();
        if (!ended && !media.ended) await event(media, ['ended']);
        check();
    } catch (error) {
        throw record(error);
    } finally {
        for (const remove of [...listeners]) {
            try {
                remove();
            } catch {}
        }
        for (const feed of feeds) {
            if (feed.iterator && !feed.iteratorDone) {
                feed.iteratorDone = true;
                try {
                    void Promise.resolve(feed.iterator.return?.()).catch(() => undefined);
                } catch {}
            }
            const sourceBuffer = feed.sourceBuffer;
            if (sourceBuffer && mse?.readyState === 'open' && sourceBuffer.updating) {
                try {
                    sourceBuffer.abort();
                } catch {}
            }
            if (sourceBuffer && mse && mse.readyState !== 'closed') {
                try {
                    mse.removeSourceBuffer(sourceBuffer);
                } catch {}
            }
        }
        try {
            if (ownAttachment()) {
                try {
                    media.removeAttribute('src');
                } catch {}
                try {
                    media.load();
                } catch {}
            }
        } catch {}
        if (objectUrl) {
            try {
                URL.revokeObjectURL(objectUrl);
            } catch {}
        }
        activeMedia.delete(media);
    }
}
