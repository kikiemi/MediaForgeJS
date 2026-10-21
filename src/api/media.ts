import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { MediaForgeError } from '../core/errors/errors';
import { handles, readings } from './handles';
import type { MediaTrack } from '../core/model/media';
import type {
    MediaPacket,
    MediaSegment,
    PacketOptions,
    PacketSearchOptions,
    SegmentOptions,
} from '../pipeline/packet-types';
import type { Frame } from '../pipeline/api-types';
import { FRAME_KEYS, THUMBNAIL_KEYS } from './options/request-keys';
import type { HintContext } from './hints';
import type { MediaContext, MediaReading, MediaReads } from './media-reads';
import type { Describe } from './operations';
import { TARGET_KEYS, readOptions } from './options/options';
import { loadOnce } from './load-hints';
import type {
    ConvertSupport,
    FrameOptions,
    MediaResult,
    PackageResult,
    PackageTargetFormat,
    SinkResult,
    TargetFormat,
    TargetOptions,
    ThumbnailOptions,
} from './types';

type Operations = typeof import('./operations');
type PictureOperations = typeof import('./picture-operations');

/** The conversion API, which convert(), check() and packageMedia() run. */
const operations = (): Promise<Operations> => import('./operations');

/** What thumbnail() and frames() run, without the conversion API. */
const pictureOperations = (): Promise<PictureOperations> => import('./picture-operations');

/** The packet reads of a Media, which open() starts loading with the engine. */
const mediaReads = loadOnce(() => import('./media-reads'));

/**
 * The target of `to` and `options` as a plain snapshot, each setting read once: a format name with
 * options, or one options object holding `to`; omitted keeps the input's container.
 */
function targetOf(
    to: TargetFormat | TargetOptions | undefined,
    options?: TargetOptions,
): TargetOptions {
    if (typeof to === 'string') {
        const target = readOptions(options, TARGET_KEYS, [], 'target options');
        target.to = to;
        return target as TargetOptions;
    }
    if (to !== undefined && options !== undefined)
        throw new MediaForgeError(
            'Pass the target format as a string, or one options object',
            'INPUT',
            {
                hint: "Call convert('mp4', options) or convert({ to: 'mp4' }).",
            },
        );
    return readOptions(to, TARGET_KEYS, [], 'target options') as TargetOptions;
}

/**
 * An open input: its tracks, its packets by time, and every operation on it. open() reads what
 * inspect() reads (the headers, an MP4 movie box, the head and tail of a large MPEG-TS, Matroska,
 * Ogg, MP3 or FLAC input); each operation then reads what it needs, an index of the whole input
 * only where it needs one, which the Media keeps for the operations after it. Operations run one
 * at a time; close() releases what was read and cancels a running operation (the input itself
 * stays yours). The conversion code loads with the first operation.
 *
 * @example
 * ```ts
 * const media = await open(file);
 * try {
 *     const first = await media.convert({ end: 60 });
 *     const second = await media.convert({ start: 60 });
 *     const trackIds = [media.tracks[0].id];
 *     for await (const packet of media.packets({ trackIds })) inspectPacket(packet);
 * } finally {
 *     media.close();
 * }
 * ```
 */
export class Media {
    static {
        handles.openedMedia = (context, collected, reads) => new Media(context, collected, reads);
    }

    /** The opened input, whose track descriptions stay readable after close(). */
    readonly #reading: MediaReading;
    readonly #collected: { current?: MediaDiagnostic[] };
    #busy = false;

    /** Media objects come from open(). */
    private constructor(
        context: MediaContext,
        collected: { current?: MediaDiagnostic[] },
        reads: MediaReads,
    ) {
        this.#reading = { ...reads, context };
        readings.set(this, this.#reading);
        this.#collected = collected;
    }

    /** Detected container format, such as 'mp4' or 'mkv'. */
    get format(): string {
        return this.#reading.context.file.format;
    }

    get title(): string | undefined {
        return this.#reading.context.file.title;
    }

    /**
     * Tracks with `id`, `type`, `codec`, `duration` in seconds and, where known, size, rate and
     * language; inspect() with `sampleCounts: true` counts their packets.
     */
    get tracks(): readonly MediaTrack[] {
        return this.#reading.context.file.uncountedTracks;
    }

    /** Warnings of reading the input so far, such as recovered damage. */
    get warnings(): readonly MediaDiagnostic[] {
        return (this.#reading.reports ?? this.#reading.context.file).warnings;
    }

    /** Seconds from the input's start to the end of its longest track. */
    get duration(): number {
        return this.#reading.context.file.duration;
    }

    /**
     * Encoded packets of the selected tracks in decode order, interleaved by time; `start` and
     * `end` select decode times in seconds. Each packet's `data` (and `alphaData`) fills an
     * ArrayBuffer of its own: keep it, change it or transfer it. An input open() described from a
     * few reads (a large MPEG-TS, Matroska, Ogg, MP3 or FLAC) reads its index first, once, but for
     * one its reader streams (Matroska, MPEG-TS, FLAC), which a request without a range or
     * keyframesOnly reads in one pass, as its index gives the packets.
     */
    packets(options?: PacketOptions): AsyncGenerator<MediaPacket> {
        const reading = this.#reading;
        // The options are checked by the call.
        const request = reading.context.file.packetRequest(options);
        const media = this;
        return (async function* () {
            try {
                yield* await (await mediaReads()).readPackets(reading, request);
            } finally {
                media.#releaseReads();
            }
        })();
    }

    /**
     * The packet presented at `time` seconds (presentation time, as packet.timestamp; packets()
     * ranges by decode time) or the keyframe before or after it, with bytes of its own as those
     * of packets(); undefined where there is none.
     */
    async packetAt(
        trackId: number,
        time: number,
        options?: PacketSearchOptions,
    ): Promise<MediaPacket | undefined> {
        const opened = this.#reading.context.file;
        if (!opened.probedInput) return opened.packetAt(trackId, time, options);
        return (await mediaReads()).packetAt(this.#reading, trackId, time, options);
    }

    /** Keyframe-aligned fragmented MP4 segments, for live packaging. */
    segments(options?: SegmentOptions): AsyncGenerator<MediaSegment> {
        const reading = this.#reading;
        return this.#iterate(async function* () {
            yield* (await mediaReads()).segments(reading, options);
        });
    }

    /** Claims the Media for one operation; another operation fails with INPUT until release. */
    #claim(): void {
        if (this.#busy)
            throw new MediaForgeError('This Media already has an operation in progress', 'INPUT');
        this.#busy = true;
    }

    /** Keeps the Media busy while `iterator` runs: from the call until the iteration ends. */
    #iterate<T, R>(start: () => AsyncGenerator<T, R>): AsyncGenerator<T, R> {
        this.#claim();
        let iterator: AsyncGenerator<T, R>;
        try {
            iterator = start();
        } finally {
            this.#busy = false;
        }
        const media = this;
        return (async function* () {
            media.#claim();
            try {
                return yield* iterator;
            } finally {
                media.#busy = false;
                media.#releaseReads();
            }
        })();
    }

    /**
     * Runs one operation of the module `load` loads: the Media is busy from the call (so options
     * read while it starts cannot start another), `read` snapshots the settings before anything
     * loads, the operation's warnings are collected for its result, and a failure gets the hint for
     * the context the operation describes.
     */
    async #operation<M extends Operations | PictureOperations, S, T>(
        load: () => Promise<M>,
        read: () => S,
        work: (
            operations: M,
            settings: S,
            warnings: MediaDiagnostic[],
            describe: Describe,
        ) => Promise<T>,
    ): Promise<T> {
        this.#claim();
        const warnings: MediaDiagnostic[] = [];
        let context: HintContext = {};
        this.#collected.current = warnings;
        try {
            const settings = read();
            const loaded = await load();
            try {
                return await work(loaded, settings, warnings, value => {
                    context = value;
                });
            } catch (error) {
                throw loaded.withHint(error, context);
            }
        } finally {
            if (this.#collected.current === warnings) this.#collected.current = undefined;
            this.#busy = false;
            this.#releaseReads();
        }
    }

    /**
     * Drops what the last operation or pass read ahead: the Media stays open between them, holding
     * its index, and the next one reads again what it needs.
     */
    #releaseReads(): void {
        this.#reading.context.file.releaseReads();
        this.#reading.indexed?.releaseReads();
    }

    /**
     * Produces `to`: a container copies the tracks it carries and re-encodes the rest, an audio
     * format extracts one audio track, an image format takes a picture (or a gif/apng animation)
     * from the video. `to` omitted keeps the input's container, as when trimming with `start` and
     * `end`. With `sink` the output is written there instead of a Blob.
     */
    convert(
        to: TargetFormat,
        options: TargetOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    convert(to: TargetFormat, options?: TargetOptions): Promise<MediaResult>;
    convert(
        options: TargetOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    convert(options?: TargetOptions): Promise<MediaResult>;
    convert(
        to?: TargetFormat | TargetOptions,
        options?: TargetOptions,
    ): Promise<MediaResult | SinkResult> {
        return this.#operation(
            operations,
            () => targetOf(to, options),
            (loaded, target, warnings, describe) =>
                loaded.convert(this.#reading, target, warnings, describe),
        );
    }

    /**
     * Whether `to` can be produced, and how (`plan`), without writing output or calling the
     * target's callbacks; unsupported results carry the code, reason and hint convert() would fail
     * with.
     */
    async check(
        to?: TargetFormat | TargetOptions,
        options?: TargetOptions,
    ): Promise<ConvertSupport> {
        let warnings: readonly MediaDiagnostic[] = [];
        try {
            return await this.#operation(
                operations,
                () => targetOf(to, options),
                (loaded, target, collected, describe) => {
                    warnings = collected;
                    return loaded.check(this.#reading, target, collected, describe);
                },
            );
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
            return {
                supported: false,
                code: error.code,
                reason: error.message,
                ...(error.hint ? { hint: error.hint } : {}),
                warnings,
            };
        }
    }

    /**
     * Cuts the input into keyframe-aligned segments with HLS playlists, a DASH manifest or both.
     * Tracks are copied, so they must use codecs fragmented MP4 (or MPEG-TS with `container: 'ts'`)
     * carries.
     */
    packageMedia(
        to?: PackageTargetFormat | TargetOptions,
        options?: TargetOptions,
    ): Promise<PackageResult> {
        return this.#operation(
            operations,
            () => targetOf(to, options),
            (loaded, target, warnings, describe) =>
                loaded.packageMedia(this.#reading, target, warnings, describe),
        );
    }

    /**
     * Decodes the pictures of a video track: every picture, one per `every` seconds, or the one
     * shown at each of `times`. By default each is straight RGBA
     * (`{ data, width, height, timestamp }` in seconds, yours to keep); with `format: 'videoframe'`
     * each is a WebCodecs VideoFrame (timestamp in microseconds) that you must close().
     */
    frames(options: FrameOptions & { readonly format: 'videoframe' }): AsyncGenerator<VideoFrame>;
    frames(options?: FrameOptions): AsyncGenerator<Frame>;
    frames(options: FrameOptions = {}): AsyncGenerator<Frame | VideoFrame> {
        const reading = this.#reading;
        return this.#iterate(async function* () {
            const settings = readOptions(
                options,
                [...FRAME_KEYS, 'onProgress'],
                [],
                'frame options',
            ) as FrameOptions;
            yield* (await pictureOperations()).frames(reading, settings);
        });
    }

    /**
     * One picture as an image file: PNG (default) works everywhere, JPEG and WebP need
     * OffscreenCanvas.
     */
    thumbnail(options?: ThumbnailOptions): Promise<MediaResult> {
        return this.#operation(
            pictureOperations,
            () => readOptions(options, THUMBNAIL_KEYS, [], 'thumbnail options') as ThumbnailOptions,
            (loaded, settings, warnings, describe) =>
                loaded.thumbnail(this.#reading, settings, warnings, describe),
        );
    }

    /**
     * Releases what was read, the index among it, and cancels a running operation; the input stays
     * open.
     */
    close(): void {
        this.#reading.context.file.close();
    }
}
