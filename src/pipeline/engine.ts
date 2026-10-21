import type { TimelineEnvironment } from './transcode/timeline';
import { MissingParts, type PluginCatalog } from './plugins/missing-parts';
import type { Source, Sink, MediaInput } from '../core/model/types';
import { BLOB_MAX_BYTES } from './media-types';
import { loadPacketCopy, providePacketCopy, type MediaFile } from './read/media-file';
import { FormatRegistry } from './read/format-registry';
import { loadFormatWriter } from './plugins/missing-parts';
import type { ProbeTarget } from '../core/model/track';
import type { OpenOptions } from '../core/contracts/reader';
import type { VideoCodecProvider } from '../core/contracts/encoder';
import { CORE_FORMATS } from '../formats/core-formats';
import { checkSignal } from '../core/io/abort';
import { DiagnosticContext, type MediaDiagnostic, type Warn } from '../core/errors/diagnostics';
import { MediaForgeError } from '../core/errors/errors';
import { assertSink } from '../core/io/sinks/sink-backpressure';
import { mediaFileState } from './read/file-state';
import type { FrameExtraction, ThumbnailExtraction } from './frames/frame-extract';
import type { PackageProgress, PackageSummary, PackagedFile } from './package/types';
import type { PluginSet } from './plugins/plugin';
import type { BuiltinVideoCodec, BuiltinAudioDecoder } from '../core/contracts/decoder';
import { coreVideoDecoders } from './codecs/core-codecs';
import type { StageDefinition } from '../core/contracts/stage';
import type { ContainerAudioEncoder } from './codecs/container-audio';
import { mimeTypeOf } from '../formats/shared/mime-types';
import type {
    BlobOptions,
    ConversionRunner,
    CopyRequest,
    OperationRequest,
    PackageRequest,
} from './types';
import type { MediaProgress } from '../core/model/media';
import type { CodecPreference, ConvertSupport, Frame, MediaPlan } from './api-types';
import type { EngineWork } from './engine-work';
import type { RemuxSupport } from './media-types';
import { copyPlan, selectedTracks } from './plan/media-plan';

// Files read through the engine are checked and written by the copy side, which loads with the
// first writer an operation needs.
providePacketCopy(() => import('./copy/packet-copy'));

/** The module of the engine's writing, decoding and packaging code. */
type EngineWorkModule = typeof import('./engine-work');

/** The code that decodes pictures for frames() and thumbnail(), without the conversion runner. */
const loadPictures = () => import('./frames/frames');

/**
 * The core containers and codecs plus the parts of `plugins`, and every operation on an opened
 * input: open() indexes an input into a MediaFile; probe(), check(), write() and toBlob() copy or
 * convert it; frames() and thumbnail() decode its pictures; package() cuts it for HLS and DASH. The
 * code of the operations other than open(), frames() and thumbnail() loads with prepare(), which
 * the asynchronous operations call themselves; probe(), plan(), `runner` and `containerAudio` need
 * it done first. frames() and thumbnail() load only the code that decodes pictures. Edits of
 * several inputs (editing/) run on the timeline this engine provides.
 */
export class Engine {
    /** The readers and writers of the composition. */
    readonly formats: FormatRegistry;
    readonly codecPreference: CodecPreference;
    /** The plugins' video codecs, whose names targets may use. */
    readonly videoCodecs: readonly VideoCodecProvider[];
    /** The plugins' processing stages, which targets name. */
    readonly stages: readonly StageDefinition[];
    /** The software video decoders: the core's and the plugins'. */
    readonly videoDecoders: readonly BuiltinVideoCodec[];
    /** The plugins' software audio decoders, besides the core's. */
    readonly audioDecoders: readonly BuiltinAudioDecoder[];
    readonly #plugins: PluginSet;
    readonly #missing: MissingParts;
    #module?: EngineWorkModule;
    #work?: EngineWork;
    #loading?: Promise<void>;

    /**
     * `catalog` describes the plugins known by name, so a missing part names the one to include.
     */
    constructor(
        plugins: PluginSet,
        catalog: PluginCatalog = [],
        codecPreference: CodecPreference = 'webcodecs',
    ) {
        this.#missing = new MissingParts(catalog);
        this.#plugins = plugins;
        this.codecPreference = codecPreference;
        this.videoCodecs = plugins.videoCodecs;
        this.stages = plugins.stages;
        this.videoDecoders = Object.freeze([...coreVideoDecoders, ...plugins.videoDecoders]);
        this.audioDecoders = plugins.audioDecoders;
        this.formats = new FormatRegistry(
            {
                readers: [...plugins.readers, ...CORE_FORMATS.readers],
                writers: [...plugins.writers, ...CORE_FORMATS.writers],
                segments: CORE_FORMATS.segments,
            },
            this.#missing,
        );
    }

    /**
     * Loads the code of the operations other than open(), with the packet copy that plans what they
     * keep of the input; calls share one load, and a failed load is retried.
     */
    prepare(): Promise<void> {
        this.#loading ??= Promise.all([import('./engine-work'), loadPacketCopy()]).then(
            ([module]) => this.#adopt(module),
            error => {
                this.#loading = undefined;
                throw error;
            },
        );
        return this.#loading;
    }

    /** Sets the operations up from their module. */
    #adopt(module: EngineWorkModule): void {
        if (this.#work) return;
        this.#work = module.createEngineWork(
            this.#plugins,
            this.#missing,
            this.formats.writers,
            this.videoDecoders,
            this.codecPreference,
        );
        this.#module = module;
    }

    #prepared(): { readonly module: EngineWorkModule; readonly work: EngineWork } {
        if (!this.#module || !this.#work)
            throw new MediaForgeError(
                'Engine operations were used before prepare() finished',
                'INPUT',
            );
        return { module: this.#module, work: this.#work };
    }

    async #ready(): Promise<{ readonly module: EngineWorkModule; readonly work: EngineWork }> {
        await this.prepare();
        return this.#prepared();
    }

    /** The library's FLAC, MP2 and MP3 encoders for container tracks; needs prepare(). */
    get containerAudio(): ContainerAudioEncoder {
        return this.#prepared().work.containerAudio;
    }

    /** What plans and runs a conversion; needs prepare(). */
    get runner(): ConversionRunner {
        return this.#prepared().work.runner;
    }

    /**
     * Indexes `input` with resolved open options; `notes` are warnings of the call, such as
     * repaired options, reported with the file's own. Close the file when done; the input stays the
     * caller's.
     */
    open(
        input: Source | MediaInput,
        options: OpenOptions = {},
        notes: readonly { readonly code: string; readonly message: string }[] = [],
        probe?: ProbeTarget,
    ): Promise<MediaFile> {
        return this.formats.open(input, options, notes, probe);
    }

    /**
     * Loads the writer of `format` before a check or write needs it; a format without one fails
     * with PLUGIN when a plugin adds it, else FORMAT.
     */
    loadWriter(format: string): Promise<void> {
        return loadFormatWriter(this.formats.writers, format);
    }

    /**
     * The metadata a picture of the first video track in `format` leaves behind, as warnings; under
     * metadataPolicy 'error' the loss fails with FORMAT before anything is decoded.
     */
    async pictureMetadataLoss(
        file: MediaFile,
        format: string,
    ): Promise<readonly MediaDiagnostic[]> {
        const { filePlanner } = await loadPacketCopy();
        const state = mediaFileState(file);
        const track = state.tracks.find(entry => entry.type === 'video');
        const context = diagnosticsOf(file);
        if (track) filePlanner(state).checkTrackMetadata([track], format, context);
        // Frame extraction reports the alpha it does not decode.
        return context.warnings.filter(warning => warning.code !== 'ALPHA_DROPPED');
    }

    /**
     * What `request` does with `file`, from known configuration, or why it cannot run; reads no
     * packets.
     */
    probe(file: MediaFile, request: OperationRequest): ConvertSupport {
        let diagnostics: DiagnosticContext | undefined;
        try {
            diagnostics = diagnosticsOf(file);
            return this.planned(file, request, diagnostics);
        } catch (error) {
            return failure(error, diagnostics);
        }
    }

    /** The plan of `request` from known configuration; a request that cannot run throws why. */
    plan(file: MediaFile, request: OperationRequest): MediaPlan {
        const support = this.planned(file, request, diagnosticsOf(file));
        if (!support.supported)
            throw new MediaForgeError(support.reason, support.code, {
                hint: support.hint,
                plugin: support.plugin,
            });
        return support.plan;
    }

    private planned(
        file: MediaFile,
        request: OperationRequest,
        diagnostics: DiagnosticContext,
    ): ConvertSupport {
        if (request.operation === 'remux')
            return copySupport(
                file,
                request,
                file.checkRemux({ ...request, onProgress: undefined }),
                diagnostics,
            );
        const { module, work } = this.#prepared();
        const plan =
            request.operation === 'convert'
                ? work.runner.probe(
                      file,
                      { ...this.preferred(request), onProgress: undefined },
                      diagnostics,
                  )
                : module.audioPlan(
                      file,
                      { ...request, onProgress: undefined },
                      diagnostics,
                      work.audio,
                      work.audioDecoder,
                      this.codecPreference,
                  ).plan;
        return { supported: true, plan, warnings: diagnostics.warnings };
    }

    private preferred<R extends OperationRequest & { readonly codecPreference?: CodecPreference }>(
        request: R,
    ): R {
        return { ...request, codecPreference: request.codecPreference ?? this.codecPreference };
    }

    /**
     * Runs the complete operation against a discard sink without invoking the request's callbacks.
     */
    async check(
        file: MediaFile,
        request: OperationRequest,
        options: BlobOptions = {},
    ): Promise<ConvertSupport> {
        let diagnostics: DiagnosticContext | undefined;
        try {
            const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
            diagnostics = diagnosticsOf(file);
            if (request.operation === 'remux') {
                const result = await file.validateRemux(
                    { ...request, onProgress: undefined },
                    { maxBytes },
                );
                return copySupport(file, request, result, diagnostics);
            }
            const { createValidationSink } = await loadPacketCopy();
            return await this.execute(
                file,
                createValidationSink(maxBytes),
                { ...request, onProgress: undefined },
                diagnostics,
                true,
            );
        } catch (error) {
            return failure(error, diagnostics);
        }
    }

    /**
     * Writes the output of `request` into `sink`, closed on success; a failure calls the sink's
     * optional abort().
     */
    async write(
        file: MediaFile,
        sink: Sink,
        request: OperationRequest,
        options: BlobOptions = {},
    ): Promise<void> {
        assertSink(sink);
        const { withOutputLimit } = await loadPacketCopy();
        await this.execute(
            file,
            withOutputLimit(sink, options.maxBytes ?? Number.MAX_SAFE_INTEGER),
            request,
        );
    }

    /** The output of `request` in memory. */
    async toBlob(
        file: MediaFile,
        request: OperationRequest,
        options: BlobOptions = {},
    ): Promise<Blob> {
        const { MemorySink, BLOB_PART_BYTES } = await loadPacketCopy();
        const sink = new MemorySink({
            maxBytes: options.maxBytes ?? BLOB_MAX_BYTES,
            blobPartBytes: BLOB_PART_BYTES,
        });
        await this.execute(file, sink, request);
        return sink.toBlob(mimeTypeOf(request.format));
    }

    private async execute(
        file: MediaFile,
        sink: Sink,
        request: OperationRequest,
        diagnostics = diagnosticsOf(file),
        silent = false,
    ): Promise<ConvertSupport> {
        checkSignal(sink.signal);
        if (request.operation !== 'audio') await file.loadWriter(request.format);
        const state = mediaFileState(file);
        if (request.operation === 'remux') {
            if (!silent)
                for (const warning of diagnostics.warnings) state.diagnostics.warn(warning);
            const total = file.packetTotal(
                Array.isArray(request.trackIds) ? request.trackIds : undefined,
            );
            const onProgress = request.onProgress;
            await file.remux(sink, {
                ...request,
                onProgress: onProgress
                    ? progress =>
                          onProgress({
                              ...progress,
                              fraction: Math.min(1, progress.packets / Math.max(1, total)),
                          })
                    : undefined,
            });
            return { supported: true, plan: copyPlanOf(file, request), warnings: [] };
        }

        const { module, work } = await this.#ready();
        checkSignal(sink.signal);
        let deliver: Warn | undefined;
        const audio =
            request.operation === 'audio'
                ? module.audioPlan(
                      file,
                      request,
                      diagnostics,
                      work.audio,
                      work.audioDecoder,
                      this.codecPreference,
                      warning => (deliver ? deliver(warning) : diagnostics.warn(warning)),
                  )
                : undefined;

        const convert = request.operation === 'convert' ? this.preferred(request) : undefined;
        const plan = audio?.plan ?? work.runner.probe(file, convert!, diagnostics);
        return module.executeWithSink(
            sink,
            [state.signal, request.signal],
            async (output, signal, invoke) => {
                if (!silent)
                    for (const warning of diagnostics.warnings)
                        invoke(() => state.diagnostics.warn(warning));
                deliver = warning => {
                    diagnostics.warn(warning);
                    if (!silent) invoke(() => state.diagnostics.warn(warning));
                };
                const onProgress =
                    !silent && request.onProgress
                        ? (progress: MediaProgress) => invoke(() => request.onProgress!(progress))
                        : undefined;
                if (audio)
                    await work.audio.encode(audio.source, output, {
                        ...audio.config,
                        signal,
                        onProgress,
                        onWarning: deliver,
                    });
                else {
                    let delivering = false;
                    const active = new DiagnosticContext({
                        validation: diagnostics.validation,
                        metadataPolicy: diagnostics.metadataPolicy,
                        onWarning: warning => {
                            if (!delivering) return;
                            diagnostics.warn(warning);
                            if (!silent) invoke(() => state.diagnostics.warn(warning));
                        },
                    });
                    for (const warning of diagnostics.warnings) active.warn(warning);
                    delivering = true;
                    await work.runner.write(
                        file,
                        output,
                        { ...convert!, signal, onProgress },
                        active,
                    );
                }
                return { supported: true, plan, warnings: diagnostics.warnings } as const;
            },
        );
    }

    /**
     * Yields the HLS/DASH VOD files in order: init and media segments, then playlists and
     * manifests.
     */
    async *package(
        file: MediaFile,
        request: PackageRequest,
    ): AsyncGenerator<PackagedFile, PackageSummary> {
        const progress = request.onProgress;
        const options = {
            targetDuration: request.targetDuration,
            trackIds: request.trackIds,
            maxSegments: request.maxSegments,
            maxTotalBytes: request.maxTotalBytes,
            maxBufferedBytes: request.maxBufferedBytes,
            maxBufferedSamples: request.maxBufferedSamples,
            signal: request.signal,
            onProgress: progress
                ? (value: PackageProgress) =>
                      progress({
                          fraction: value.fraction,
                          packets: value.packets,
                          packetBytes: value.packetBytes,
                          segments: value.segments,
                          outputBytes: value.bytes,
                      })
                : undefined,
        };

        if (request.format === 'hls') {
            await file.loadWriter(request.container === 'ts' ? 'ts' : 'fmp4');
            const { packageHls } = await import('./package/hls');
            return yield* packageHls(file, {
                ...options,
                container: request.container,
                demuxed: request.demuxed,
                encryption: request.encryption,
                programDateTime: request.programDateTime,
            });
        }
        await file.loadWriter('fmp4');
        const { packageDash } = await import('./package/dash');
        return yield* packageDash(file, {
            ...options,
            hlsPlaylists: request.format === 'hls+dash',
        });
    }

    /** Collects the whole package in memory, keyed by file name. */
    async packageToMap(
        file: MediaFile,
        request: PackageRequest,
    ): Promise<Map<string, PackagedFile>> {
        const { module } = await this.#ready();
        return module.collectPackage(this.package(file, module.collectedPackageRequest(request)));
    }

    /**
     * Decodes pictures of a video track as RGBA, in presentation order or in the order of `times`,
     * or as VideoFrame objects with `format: 'videoframe'`. The host decoder is used where it
     * exists, then the software decoders.
     */
    frames(
        file: MediaFile,
        extraction: FrameExtraction & { readonly videoFrame: true },
    ): AsyncGenerator<VideoFrame>;
    frames(file: MediaFile, extraction?: FrameExtraction): AsyncGenerator<Frame>;
    async *frames(
        file: MediaFile,
        extraction: FrameExtraction = {},
    ): AsyncGenerator<Frame | VideoFrame> {
        const pictures = await loadPictures();
        yield* pictures.fileFrames(
            file,
            extraction,
            pictures.frameDecoders(
                file,
                this.videoDecoders,
                this.codecPreference,
                this.videoCodecs,
            ),
        );
    }

    /** One picture as a PNG, JPEG or WebP Blob; JPEG and WebP need OffscreenCanvas. */
    async thumbnail(file: MediaFile, thumbnail: ThumbnailExtraction): Promise<Blob> {
        const pictures = await loadPictures();
        return pictures.fileThumbnail(
            file,
            thumbnail,
            pictures.frameDecoders(
                file,
                this.videoDecoders,
                this.codecPreference,
                this.videoCodecs,
            ),
        );
    }

    /**
     * What the timeline runs with (codecs, encoders, writers and preferences), for the subsystems
     * built on it.
     */
    async timelineEnvironment(): Promise<TimelineEnvironment> {
        return (await this.#ready()).work.environment;
    }
}

/** A fresh diagnostics context under the file's validation and metadata policy. */
function diagnosticsOf(file: MediaFile): DiagnosticContext {
    return mediaFileState(file).diagnostics.fresh();
}

/** The plan of copying the tracks `request` selects. */
function copyPlanOf(file: MediaFile, request: CopyRequest): MediaPlan {
    return copyPlan(request.format, selectedTracks(file.tracks, request.trackIds), request);
}

/** The answer of a packet copy: its plan, or why the tracks cannot be copied into the format. */
function copySupport(
    file: MediaFile,
    request: CopyRequest,
    result: RemuxSupport,
    diagnostics: DiagnosticContext,
): ConvertSupport {
    const warnings = [...diagnostics.warnings, ...result.warnings];
    // The plan lists the tracks the copy writes: a range leaves out those it misses.
    const written = result.supported ? (result.trackIds ?? request.trackIds) : undefined;
    return result.supported
        ? { supported: true, plan: copyPlanOf(file, { ...request, trackIds: written }), warnings }
        : { supported: false, code: result.code, reason: result.reason, warnings };
}

/** The unsupported answer for a library error; other errors are thrown. */
function failure(error: unknown, diagnostics?: DiagnosticContext): ConvertSupport {
    if (!(error instanceof MediaForgeError)) throw error;
    return {
        supported: false,
        code: error.code,
        reason: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.plugin ? { plugin: error.plugin } : {}),
        warnings: diagnostics?.warnings ?? [],
    };
}
