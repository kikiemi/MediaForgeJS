import type { EncodeParts } from './encode';
import type { Source, MediaInput } from '../core/model/types';
import type { ContainerFormat } from '../core/model/media';
import type { CodecPreference, Frame } from '../pipeline/api-types';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { MediaForgeError, throwIfAborted } from '../core/errors/errors';
import {
    OptionNormalizer,
    resolveOptionPolicy,
    type OptionPolicy,
} from '../core/errors/option-policy';
import {
    codecPreferenceOf,
    COMMON_KEYS,
    OPEN_KEYS,
    TARGET_KEYS,
    readCommon,
    readOptions,
    warningOf,
} from './options/options';
import type { PluginSet } from '../pipeline/plugins/plugin';
import type { MediaForgePlugin } from '../core/contracts/plugin';
import { checkPlugins, type CheckedPlugins } from '../pipeline/plugins/plugin-check';
import { selectPlugins } from './options/plugin-selection';
import type { Engine } from '../pipeline/engine';
import type { ProbeTarget } from '../core/model/track';
import type { EditProject } from '../editing/project';
import { FRAME_KEYS, PLAY_KEYS, THUMBNAIL_KEYS } from './options/request-keys';
import type { Media } from './media';
import { handles, mediaContext } from './handles';
import { loadOnce, prefetchReaderFor, prefetchWriterFor } from './load-hints';
import { releaseBlobHead } from '../core/io/sources/blob-head';
import type { Session } from './media-reads';
import type { ForgeContext } from './operations';
import type { CapabilityOptions, MediaCapabilities } from './capability-types';
import type {
    EncodeFramesOptions,
    EncodeSources,
    MediaRecording,
    RecordStreamOptions,
} from './encode-options';
import type { FrameStream } from '../recording/frame-streams';
import type { Playback, Player, PlayOptions } from './play';
import type {
    CommonOptions,
    ConvertOptions,
    ConvertSupport,
    FrameOptions,
    MediaForgeOptions,
    MediaInfo,
    MediaResult,
    OpenOptions,
    PackageResult,
    PackageTargetFormat,
    SinkResult,
    TargetFormat,
    TargetOptions,
    ThumbnailOptions,
} from './types';

/** Input to read: a File, Blob, ArrayBuffer, typed array or Source. */
export type Input = Source | MediaInput;

/** Options of open(): how to read the input, with the common options of the call. */
export interface OpenCallOptions extends OpenOptions, CommonOptions {}

/** Options of inspect(): cancellation with the common options of the call. */
export interface InspectOptions extends CommonOptions {
    readonly signal?: AbortSignal;
    /**
     * Counts every packet so each track reports `sampleCount`; default false, which lets an
     * MPEG-TS, Matroska, WebM or Ogg input of any size be described from its head and tail, and an
     * MP3 or FLAC of 4 MiB or more from its header and last frames, without `sampleCount`.
     */
    readonly sampleCounts?: boolean;
}

/** Options of thumbnail() with the common options of the call. */
export interface ThumbnailCallOptions extends ThumbnailOptions, CommonOptions {}

/** Options of frames() with the common options of the call. */
export interface FrameCallOptions extends FrameOptions, CommonOptions {}

/**
 * The format argument and the options object of a call that takes `(to, options)` or `(options)`.
 */
function targetArguments(
    to: unknown,
    options: unknown,
): { readonly format?: string; readonly options: unknown } {
    if (typeof to === 'string') return { format: to, options };
    if (to !== undefined && options !== undefined)
        throw new MediaForgeError(
            'Pass the target format as a string, or one options object',
            'INPUT',
            {
                hint: "Call convert(file, 'mp4', options) or convert(file, { to: 'mp4' }).",
            },
        );
    return { options: to };
}

/** The target settings of a call as a plain snapshot, without its common options. */
function targetSnapshot(to: unknown, options: unknown): TargetOptions {
    const args = targetArguments(to, options);
    const target = readOptions(args.options, TARGET_KEYS, COMMON_KEYS, 'target options');
    if (args.format !== undefined) target.to = args.format;
    return target as TargetOptions;
}

/**
 * The conversion code, loaded with the first operation that needs it; started early so it loads
 * with the engine.
 */
const operations = loadOnce(() => import('./operations'));

/** What thumbnail() and frames() run, without the conversion code; started early likewise. */
const pictureOperations = loadOnce(() => import('./picture-operations'));

/** The URL of a stream to play, absolute: a relative one is resolved against the page. */
function streamUrl(source: unknown): string {
    const text = source instanceof URL ? source.href : source;
    try {
        if (typeof text === 'string' && text.trim())
            return new URL(text, globalThis.document?.baseURI).href;
    } catch {}
    throw new MediaForgeError('play() takes the URL of an HLS playlist or a DASH MPD', 'INPUT', {
        hint: 'Pass an absolute URL, or in a page one relative to it.',
    });
}

/** Checks the media element a stream plays in. */
function checkMedia(media: unknown): void {
    if (!media || typeof (media as HTMLMediaElement).play !== 'function')
        throw new MediaForgeError('A player takes the media element to play in', 'INPUT', {
            hint: 'Pass a <video> or <audio> element.',
        });
}

const loadOpenOptions = loadOnce(() => import('./options/open-options'));
const loadImageInspect = loadOnce(() => import('../pipeline/frames/image-inspect'));

/** Adds the hint to a failure of reading the input; the hint texts load only then. */
async function hinted(error: unknown): Promise<unknown> {
    try {
        return (await import('./hints')).withHint(error, {});
    } catch {
        return error;
    }
}

/**
 * Shared defaults for the operations: plugins, warning listener, option policy, codec preference
 * and input-reading options. Every function of the package is the method of a default MediaForge,
 * and every call may override the defaults. From 'mediaforgejs' the default plugins are all of the
 * library's; from 'mediaforgejs/lite' none.
 *
 * @example
 * ```ts
 * const forge = new MediaForge({
 *     plugins: { exclude: ['h264'] },
 *     onWarning: warning => console.warn(warning.message),
 * });
 * const info = await forge.inspect(file);
 * const { blob } = await forge.convert(file, 'mp4', { video: { width: 1280, codec: 'auto' } });
 * ```
 */
export class MediaForge {
    static {
        handles.engineOf = forge => (forge as MediaForge).#engine();
    }

    /**
     * The plugins of an instance whose options name none; set by the entry the class is imported
     * from.
     */
    static readonly defaultPlugins: readonly MediaForgePlugin[] = [];

    readonly #defaults: CommonOptions;
    readonly #checked: CheckedPlugins;
    #composed?: Promise<PluginSet>;
    readonly #policy: OptionPolicy;
    readonly #codecPreference?: CodecPreference;
    readonly #reading: OpenOptions;
    #loaded?: Promise<Engine>;

    constructor(options: MediaForgeOptions = {}) {
        const defaults = readCommon(options);
        this.#defaults = defaults;
        const normalizer = new OptionNormalizer(
            resolveOptionPolicy(defaults.optionPolicy),
            'options',
        );
        if (
            defaults.optionPolicy !== undefined &&
            defaults.optionPolicy !== 'lenient' &&
            defaults.optionPolicy !== 'strict'
        )
            normalizer.ignore(
                'optionPolicy',
                defaults.optionPolicy,
                "must be 'lenient' or 'strict'; lenient applies",
            );
        this.#policy = normalizer.policy;
        this.#codecPreference = codecPreferenceOf(normalizer, defaults.codecPreference);
        this.#reading = readOptions(defaults.open, OPEN_KEYS, [], 'open options') as OpenOptions;

        const base = (new.target as typeof MediaForge).defaultPlugins;
        this.#checked = checkPlugins(
            selectPlugins(defaults.plugins, base, name =>
                normalizer.ignore('plugins.exclude', name, 'names no plugin of this entry'),
            ),
        );
        for (const finding of normalizer.findings) this.#warn(warningOf(finding));
    }

    /** Names of the plugins in use. */
    get plugins(): readonly string[] {
        return this.#checked.names;
    }

    #warn(warning: MediaDiagnostic): void {
        this.#defaults.onWarning?.(warning);
    }

    /**
     * The parts of the plugins of this instance in the forms the engine runs, gathered with its
     * first operation; the plugins were checked when it was made.
     */
    #parts(): Promise<PluginSet> {
        this.#composed ??= import('../pipeline/plugins/plugin').then(
            ({ composePlugins }) => composePlugins(this.#checked.plugins),
            error => {
                this.#composed = undefined;
                throw error;
            },
        );
        return this.#composed;
    }

    /** The readers, codecs and writers, loaded with the first operation that reads media. */
    #engine(): Promise<Engine> {
        this.#loaded ??= Promise.all([
            import('../pipeline/engine'),
            import('../plugins/catalog'),
            this.#parts(),
        ]).then(
            ([{ Engine }, { PLUGIN_CATALOG }, plugins]) =>
                new Engine(plugins, PLUGIN_CATALOG, this.#codecPreference),
            error => {
                this.#loaded = undefined;
                throw error;
            },
        );
        return this.#loaded;
    }

    /** The encoder code and what an encode uses of the plugins of this instance. */
    async #encoding(): Promise<[typeof import('./encode'), EncodeParts]> {
        const [module, { PLUGIN_CATALOG }, { stages, audioEncoders }] = await Promise.all([
            import('./encode'),
            import('../plugins/catalog'),
            this.#parts(),
        ]);
        return [module, { stages, audioEncoders, catalog: PLUGIN_CATALOG }];
    }

    /** What the operations of this instance use from it. */
    async #context(): Promise<ForgeContext> {
        const { videoCodecs, stages } = await this.#parts();
        return {
            policy: this.#policy,
            videoCodecs,
            stages,
            warn: warning => this.#warn(warning),
            engine: () => this.#engine(),
            openOptions: signal => this.#openOptions(signal),
        };
    }

    /**
     * This instance, or one with the call's common options over its defaults; each option is read
     * once.
     */
    #with(options: unknown): MediaForge {
        const common = readCommon(options);
        if (!Object.keys(common).length) return this;
        const Forge = this.constructor as new (options: MediaForgeOptions) => MediaForge;
        return new Forge({ ...this.#defaults, ...common });
    }

    #openOptions(signal: AbortSignal | undefined, reading: OpenOptions = {}): OpenOptions {
        const merged: Record<string, unknown> = { ...this.#reading };
        for (const [key, value] of Object.entries(reading))
            if (value !== undefined) merged[key] = value;
        if (signal !== undefined) merged.signal = signal;
        merged.validation ??= this.#policy === 'strict' ? 'strict' : undefined;
        return merged as OpenOptions;
    }

    /**
     * Opens `input` with a warning listener that also feeds the running operation's result, as
     * `reading` says (the probe the operation's code gives, read-probes, is awaited with the
     * engine).
     */
    async #open(
        input: Input,
        options: OpenOptions,
        reading?: ProbeTarget | Promise<ProbeTarget | undefined>,
    ): Promise<Media> {
        this.#prefetchEngine(input);
        const collected: { current?: MediaDiagnostic[] } = {};
        const listener = options.onWarning;
        const report = (warning: MediaDiagnostic): void => {
            if (listener) listener(warning);
            else this.#warn(warning);
        };
        const warn = (warning: MediaDiagnostic): void => {
            collected.current?.push(warning);
            report(warning);
        };

        try {
            const [engine, { resolveOpenOptions }, probe] = await Promise.all([
                this.#engine(),
                loadOpenOptions(),
                reading,
            ]);
            const session: Session = {
                edit: (project, target) => this.edit(project, target),
                optionPolicy: this.#policy,
                codecPreference: this.#codecPreference,
                warn,
            };
            const { snapshot, findings } = resolveOpenOptions({ ...options, onWarning: warn });
            const file = await engine.open(input, snapshot, findings, probe);
            return handles.openedMedia({ engine, file, session, input }, collected, {
                probe,
                // Opening the input again reports its warnings as an open does, outside the
                // running operation's result.
                reopen: (again, signal, reported) =>
                    engine.open(
                        input,
                        {
                            ...snapshot,
                            signal,
                            onWarning: warning => {
                                if (!reported(warning)) report(warning);
                            },
                        },
                        findings,
                        again,
                    ),
            }) as Media;
        } catch (error) {
            throw await hinted(error);
        } finally {
            releaseBlobHead(input);
        }
    }

    /**
     * Runs `work` on the opened input and closes it. Its result gets the warnings of reading the
     * input it lacks: those of the open came before the operation collected its own.
     */
    async #using<T extends { readonly warnings: readonly MediaDiagnostic[] }>(
        input: Input,
        signal: AbortSignal | undefined,
        work: (media: Media) => Promise<T>,
        probe?: ProbeTarget | Promise<ProbeTarget | undefined>,
        format?: string,
    ): Promise<T> {
        const named = this.#reading.format;
        const media = await this.#open(
            input,
            this.#openOptions(signal, { format: named ?? format }),
            probe,
        );
        try {
            const result = await work(media);
            const read = media.warnings.filter(warning => !result.warnings.includes(warning));
            return { ...result, warnings: Object.freeze([...read, ...result.warnings]) };
        } finally {
            media.close();
        }
    }

    /**
     * The format and tracks of a media file, or the picture of an image file, without decoding
     * anything. Tracks carry `id`, `type`, `codec`, `duration` in seconds and, where known, size,
     * rate, channels, language and rotation. MPEG-TS, Matroska, WebM and Ogg inputs, whose packets
     * only a read of the whole input counts, are described from their head and tail at any size,
     * and MP3 and FLAC inputs of 4 MiB or more from their header and last frames, without
     * `sampleCount`, unless `sampleCounts` is true; an MP4 with a movie box of 256 KiB or more
     * from that box, its sample tables checked but not built. A damaged input is read whole and
     * reports it.
     */
    async inspect(input: Input, options?: InspectOptions): Promise<MediaInfo> {
        const forge = this.#with(options);
        const read = (await loadOpenOptions()).readInspectOptions(options, forge.#policy);
        const { warnings } = read;
        for (const warning of warnings) forge.#warn(warning);
        const { signal, sampleCounts } = read.settings as InspectOptions;

        const { format, image } = await forge.#detect(input, signal);
        if (image)
            try {
                const { inspectImageInput } = await loadImageInspect();
                const info = await inspectImageInput(input, image, signal);
                return { ...info, warnings: [...warnings, ...info.warnings] };
            } catch (error) {
                throw await hinted(error);
            }

        return forge.#using(
            input,
            signal,
            async media => ({
                format: media.format,
                title: media.title,
                tracks: mediaContext(media).file.tracks,
                warnings,
            }),
            sampleCounts ? undefined : {},
            format,
        );
    }

    /**
     * Opens the input for several operations and for its packets, reading what inspect() reads;
     * each operation reads what it needs. Close the Media when done.
     */
    async open(input: Input, options?: OpenCallOptions): Promise<Media> {
        const forge = this.#with(options);
        const reading = readOptions(options, OPEN_KEYS, COMMON_KEYS, 'open options') as OpenOptions;
        return forge.#open(input, forge.#openOptions(undefined, reading), {});
    }

    /**
     * Converts an input into `to` and returns the file with the plan of what was copied and what
     * was encoded. A container copies every track it carries and re-encodes the rest; an audio
     * format extracts one audio track; an image format draws a still or takes a picture from video.
     * Without `to` the input's container is kept, as when trimming with `start` and `end`;
     * `audio: { mute: true }` leaves the sound out.
     *
     * @example
     * ```ts
     * const { blob, filename, plan } = await convert(file, 'mp4', {
     *     video: { width: 1280, codec: 'auto' },
     *     audio: { bitrate: '128k' },
     *     onProgress: ({ fraction, stage }) => console.log(stage, Math.round(fraction * 100)),
     * });
     * ```
     */
    convert(
        input: Input,
        to: TargetFormat,
        options: ConvertOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    convert(input: Input, to: TargetFormat, options?: ConvertOptions): Promise<MediaResult>;
    convert(
        input: Input,
        options: ConvertOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    convert(input: Input, options?: ConvertOptions): Promise<MediaResult>;
    async convert(
        input: Input,
        to?: TargetFormat | ConvertOptions,
        options?: ConvertOptions,
    ): Promise<MediaResult | SinkResult> {
        const forge = this.#with(targetArguments(to, options).options);
        const target = targetSnapshot(to, options);
        const loading = operations();
        prefetchWriterFor(target.to);
        const { format, image } = await forge.#detect(input, target.signal);
        if (target.to !== undefined && image)
            return (await loading).convertImage(await forge.#context(), input, target);

        // The input is opened as a copy of it reads it (Media.convert() chooses).
        return forge.#using(
            input,
            target.signal,
            media => media.convert(target),
            loading.then(loaded => loaded.convertProbe(target)),
            format,
        );
    }

    /**
     * The format of `input`, detected once for a call as open() detects it: `image` for an image,
     * which its converter reads whole, else the format the input then opens as (#using). Cancelled
     * calls stop before reading the input.
     */
    async #detect(
        input: Input,
        signal: AbortSignal | undefined,
    ): Promise<{ format?: string; image?: ContainerFormat }> {
        for (const pending of [signal, this.#reading.signal]) throwIfAborted(pending);
        this.#prefetchEngine(input);
        let format: string | undefined;
        let image: ContainerFormat | undefined;
        try {
            const [engine, { imageFormatOf }] = await Promise.all([
                this.#engine(),
                loadImageInspect(),
            ]);
            try {
                format = await engine.formats.detectFormat(input, signal);
            } catch (error) {
                // A format the call names is read as that format, as open() would.
                if (this.#reading.format === undefined) throw error;
            }
            image = format === undefined ? undefined : imageFormatOf(format);
        } catch (error) {
            releaseBlobHead(input);
            throw await hinted(error);
        }
        // An image is read whole by its converter: only a media input keeps its head for the open
        // that follows.
        if (image) releaseBlobHead(input);
        return { format, image };
    }

    /**
     * Starts loading the engine and the reader `input` most likely needs while it is checked for an
     * image; opening it waits for the same loads.
     */
    #prefetchEngine(input: Input): void {
        this.#engine().catch(() => undefined);
        prefetchReaderFor(input);
    }

    /**
     * Whether `to` can be produced from the input, and how (`plan`), without writing output;
     * unsupported results carry the `code`, `reason` and `hint` convert() would fail with.
     */
    async check(
        input: Input,
        to?: TargetFormat | ConvertOptions,
        options?: ConvertOptions,
    ): Promise<ConvertSupport> {
        const unsupported = async (error: unknown): Promise<ConvertSupport> => {
            if (!(error instanceof MediaForgeError)) throw error;
            await hinted(error);
            return {
                supported: false,
                code: error.code,
                reason: error.message,
                ...(error.hint ? { hint: error.hint } : {}),
                warnings: [],
            };
        };

        try {
            const forge = this.#with(targetArguments(to, options).options);
            const target = targetSnapshot(to, options);
            const loading = operations();
            const { format, image } = await forge.#detect(input, target.signal);
            if (target.to !== undefined && image)
                return (await loading).checkImage(await forge.#context(), target);
            return await forge.#using(
                input,
                target.signal,
                media => media.check(target),
                undefined,
                format,
            );
        } catch (error) {
            return await unsupported(error);
        }
    }

    /**
     * One picture of a video as an image file: PNG (default), JPEG or WebP, at `time` seconds
     * (default 0).
     */
    async thumbnail(input: Input, options: ThumbnailCallOptions = {}): Promise<MediaResult> {
        const forge = this.#with(options);
        const settings = readOptions(
            options,
            THUMBNAIL_KEYS,
            COMMON_KEYS,
            'thumbnail options',
        ) as ThumbnailOptions;
        return forge.#using(
            input,
            settings.signal,
            media => media.thumbnail(settings),
            pictureOperations().then(loaded => loaded.thumbnailProbe(settings)),
        );
    }

    /**
     * Decodes the pictures of a video track: every picture, one per `every` seconds, or the one
     * shown at each of `times`, as RGBA or, with `format: 'videoframe'`, as VideoFrame objects you
     * must close(). The input stays open until the loop ends; break out of it to stop early.
     */
    frames(
        input: Input,
        options: FrameCallOptions & { readonly format: 'videoframe' },
    ): AsyncGenerator<VideoFrame>;
    frames(input: Input, options?: FrameCallOptions): AsyncGenerator<Frame>;
    async *frames(
        input: Input,
        options: FrameCallOptions = {},
    ): AsyncGenerator<Frame | VideoFrame> {
        const forge = this.#with(options);
        const settings = readOptions(
            options,
            [...FRAME_KEYS, 'onProgress'],
            COMMON_KEYS,
            'frame options',
        ) as FrameOptions;
        const media = await forge.#open(
            input,
            forge.#openOptions(settings.signal),
            pictureOperations().then(loaded => loaded.framesProbe(settings)),
        );
        try {
            yield* media.frames(settings) as AsyncGenerator<Frame | VideoFrame>;
        } finally {
            media.close();
        }
    }

    /**
     * Cuts the input into keyframe-aligned segments with HLS playlists, a DASH manifest or both.
     * Tracks are copied, so they must use codecs fragmented MP4 (or MPEG-TS with `container: 'ts'`)
     * carries.
     */
    async packageMedia(
        input: Input,
        to?: PackageTargetFormat | ConvertOptions,
        options?: ConvertOptions,
    ): Promise<PackageResult> {
        const forge = this.#with(targetArguments(to, options).options);
        const target = targetSnapshot(to, options);
        // The packaging code loads while the input opens. An MPEG-TS or Matroska input is described
        // from its head and tail and packaged in one pass through it where its head times every
        // track (Media.packageMedia() chooses).
        void operations();
        return forge.#using(input, target.signal, media => media.packageMedia(target), {
            stream: true,
        });
    }

    /**
     * Produces one file from a timeline: clips in order, extra audio mixed under them and overlays
     * drawn on top. Packets are copied when every clip shares the codec and cuts fall on keyframes;
     * otherwise the video is re-encoded (EDIT_REENCODED says why) and the audio is mixed and
     * encoded once.
     */
    edit(
        project: EditProject,
        to: TargetFormat,
        options: ConvertOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    edit(project: EditProject, to: TargetFormat, options?: ConvertOptions): Promise<MediaResult>;
    edit(
        project: EditProject,
        options: ConvertOptions & { readonly sink: NonNullable<TargetOptions['sink']> },
    ): Promise<SinkResult>;
    edit(project: EditProject, options: ConvertOptions): Promise<MediaResult>;
    async edit(
        project: EditProject,
        to: TargetFormat | ConvertOptions,
        options?: ConvertOptions,
    ): Promise<MediaResult | SinkResult> {
        const forge = this.#with(targetArguments(to, options).options);
        const target = targetSnapshot(to, options);
        return (await operations()).edit(await forge.#context(), project, target);
    }

    /**
     * Encodes pictures and sound you produce into a file: VideoFrames from a canvas, a decoder or a
     * camera, and AudioData. Each VideoFrame and AudioData is closed once encoded.
     */
    encodeFrames(
        sources: FrameStream<VideoFrame> | EncodeSources,
        options: EncodeFramesOptions = {},
    ): Promise<MediaResult> {
        const settings = this.#encodeOptions(options);
        return this.#encoding().then(([module, parts]) =>
            module.encodeFrames(sources, settings, parts),
        );
    }

    /**
     * Records a MediaStream (camera, microphone, screen, canvas) into a file with WebCodecs.
     * Reading starts once the encoder code has loaded.
     */
    recordStream(stream: MediaStream, options: RecordStreamOptions = {}): MediaRecording {
        if (!stream || typeof stream.getVideoTracks !== 'function')
            throw new MediaForgeError('Expected a MediaStream', 'INPUT', {
                hint: 'Pass a stream from getUserMedia() or canvas.captureStream().',
            });
        const settings = this.#encodeOptions(options);
        if (
            !stream.getVideoTracks().length &&
            (settings.audio === false || !stream.getAudioTracks().length)
        )
            throw new MediaForgeError('The stream has no video or audio track', 'INPUT', {
                hint: 'Ask getUserMedia() for video or audio.',
            });
        const recording = this.#encoding().then(([module, parts]) =>
            module.recordStream(stream, settings, parts),
        );
        const result = recording.then(started => started.result);
        result.catch(() => undefined);
        return { result, stop: () => recording.then(started => started.stop()) };
    }

    /**
     * Plays an HLS playlist or a DASH MPD in a media element through Media Source Extensions, with
     * the player plugin of mediaforgejs-player (`plugins: { add: [player] }`; its code loads with
     * the first stream). The protocol is read from the URL, else from the start of the manifest,
     * unless `protocol` names it. Without the player plugin it fails with PLUGIN.
     */
    play(source: string | URL, media: HTMLMediaElement, options: PlayOptions = {}): Playback {
        return this.createPlayer(media, options).load(source);
    }

    /**
     * A player bound to `media`, which plays one stream at a time: each load() stops the stream
     * before it, and its options apply over the player's.
     */
    createPlayer(media: HTMLMediaElement, options: PlayOptions = {}): Player {
        checkMedia(media);
        const forge = this.#with(options);
        // The player's code reads the settings and reports their unknown keys as it loads.
        const read = (value: unknown) => readOptions(value, PLAY_KEYS, COMMON_KEYS, 'play options');
        const defaults = read(options);
        let current: { finished: Promise<void>; stop: AbortController } | undefined;
        const player: Player = {
            load: (source, overrides = {}) => {
                const url = streamUrl(source);
                const settings = { ...defaults, ...read(overrides) } as PlayOptions;
                const before = current?.finished.catch(() => undefined);
                player.stop();
                const stop = new AbortController();
                const finished = Promise.all([
                    import('./play'),
                    import('../plugins/catalog'),
                    forge.#parts(),
                    before,
                ]).then(([module, { PLUGIN_CATALOG }, { players }]) =>
                    module.runPlayback(url, media, settings, {
                        players,
                        catalog: PLUGIN_CATALOG,
                        stopped: stop.signal,
                        policy: forge.#policy,
                        warn: warning => forge.#warn(warning),
                    }),
                );
                finished.catch(() => undefined);
                current = { finished, stop };
                return { finished, stop: () => stop.abort() };
            },
            stop: () => current?.stop.abort(),
        };
        return player;
    }

    #encodeOptions<T extends EncodeFramesOptions>(options: T): T {
        const common = readCommon(options);
        return {
            ...options,
            onWarning: common.onWarning ?? this.#defaults.onWarning,
            optionPolicy: common.optionPolicy ?? this.#defaults.optionPolicy,
            codecPreference: common.codecPreference ?? this.#codecPreference,
        };
    }

    /**
     * Formats, codecs and host features this build and host offer: the containers read and written,
     * the codecs the library and the host WebCodecs decode and encode (at the size, rate and
     * container of `options`), and the plugins in use.
     */
    async capabilities(
        options: CapabilityOptions & CommonOptions = {},
    ): Promise<MediaCapabilities> {
        const forge = this.#with(options);
        const settings = readOptions(options, [], COMMON_KEYS) as CapabilityOptions;
        const { probeCapabilities } = await import('./capabilities');
        return probeCapabilities(await forge.#parts(), settings);
    }
}

/** The methods of a MediaForge the package exports as functions. */
const FUNCTIONS = [
    'inspect',
    'open',
    'convert',
    'check',
    'thumbnail',
    'frames',
    'packageMedia',
    'edit',
    'encodeFrames',
    'recordStream',
    'play',
    'createPlayer',
    'capabilities',
] as const;

/** The package's functions: the methods of `forge`, which holds the defaults. */
export function functionsOf(forge: MediaForge): {
    readonly [Name in (typeof FUNCTIONS)[number]]: MediaForge[Name];
} {
    return Object.fromEntries(FUNCTIONS.map(name => [name, forge[name].bind(forge)])) as ReturnType<
        typeof functionsOf
    >;
}
