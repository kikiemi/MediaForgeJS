import type { Source, MediaInput } from '../../core/model/types';
import type { DemuxResult, ProbedInput, ProbeTarget } from '../../core/model/track';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { CachedSource } from '../../core/io/sources/cached-source';
import { sourceOf } from '../../core/io/sources/sources';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import { awaitWithAbort } from '../../core/io/abort';
import { positiveLimit } from '../../core/errors/limits';
import { demuxFailure } from '../../core/errors/demux-guard';
import { resolveDemuxBudget } from '../../formats/shared/demux-budget';
import {
    detectSourceFormat,
    readerSignatures,
    type FormatSignature,
} from '../../formats/source-format';
import { createWriters, partFormats, type FormatParts } from '../../formats/shared/contract';
import type {
    OpenOptions,
    ReadOptions,
    Reader,
    ReaderCapabilities,
    ReaderPart,
} from '../../core/contracts/reader';
import { NO_PLUGINS, type FormatWriters, type MissingParts } from '../plugins/missing-parts';
import { mpegVideoFamily, isHevcCodec } from '../../core/model/codec-strings';
import { describeAacTracks, describeSyncAudioTracks } from './audio-config';
import { MediaFile, loadPacketCopy, loadStreamSchedule } from './media-file';
import { describedAs } from './window-tracks';

/** Bytes sniffers see. */
const SNIFF_BYTES = 8192;

/**
 * Default sample limit of an opened file: ten hours of 60 fps video with 48 kHz AAC. Compact
 * indexes cost tens of bytes per sample and per-object indexes are estimated at 256, so
 * maxIndexBytes remains the memory guard.
 */
const OPEN_MAX_SAMPLES = 8_000_000;

/**
 * Opens inputs with the reader parts of `formats` and writes with their writer parts. For one
 * format name the first reader listed wins, so plugin readers listed before the core's replace
 * them. Sources and sinks remain caller-owned.
 */
export class FormatRegistry {
    private readonly readers = new Map<string, ReaderPart>();
    private readonly sniffers: {
        readonly format: string;
        readonly sniff: (head: Uint8Array) => boolean;
    }[] = [];
    private readonly signatures: FormatSignature[] = [];
    readonly writers: FormatWriters;

    constructor(formats: FormatParts, missing: MissingParts = NO_PLUGINS) {
        if (!formats || !Array.isArray(formats.readers) || !Array.isArray(formats.writers))
            throw new MediaForgeError('Expected reader and writer parts', 'INPUT');
        const writers = createWriters(formats.writers, formats.segments);
        // A writer is loaded for a check or a copy of a media file's packets, which the packet copy
        // plans and runs.
        this.writers = Object.freeze({
            ...writers,
            missing,
            load: async (format: string) =>
                void (await Promise.all([writers.load(format), loadPacketCopy()])),
        });
        for (const part of formats.readers) this.addReader(part);
    }

    /** Each part's reader, loaded with the first input of its formats; a failed load is retried. */
    private readonly loaded = new WeakMap<ReaderPart, Promise<Reader>>();

    private loadReader(part: ReaderPart): Promise<Reader> {
        let loading = this.loaded.get(part);
        if (!loading) {
            loading = Promise.resolve().then(() => part.load());
            this.loaded.set(part, loading);
            loading.catch(() => this.loaded.delete(part));
        }
        return loading;
    }

    private addReader(part: ReaderPart): void {
        if (!part || typeof part !== 'object' || typeof part.load !== 'function')
            throw new MediaForgeError('A reader needs formats and load()', 'INPUT');
        const formats = partFormats(part, 'reader');
        const sniff = part.sniff;
        if (sniff !== undefined && typeof sniff !== 'function')
            throw new MediaForgeError("A reader's sniff must be a function", 'INPUT');
        for (const format of formats) if (!this.readers.has(format)) this.readers.set(format, part);
        if (part.priority !== undefined && !Number.isFinite(part.priority))
            throw new MediaForgeError("A reader's priority must be a number", 'INPUT');
        if (sniff && part.priority === undefined)
            this.sniffers.push({
                format: formats[0]!,
                sniff: Function.prototype.bind.call(sniff, part),
            });
        else this.signatures.push(...readerSignatures([part]));
    }

    /**
     * The cache a detection read a Source input through, which the open of that input that follows
     * reads on, as an open that detects reads on its own: the input's head is read once.
     */
    private readonly detected = new WeakMap<object, CachedSource>();

    /** The format open() reads `input` as, unless its options name one. */
    async detectFormat(input: Source | MediaInput, signal?: AbortSignal): Promise<string> {
        const source = sourceOf(input);
        if (typeof (input as Source).read !== 'function') return this.detect(source, signal);
        const cache = new CachedSource(source);
        const format = await this.detect(cache, signal);
        if (this.readers.has(format)) this.detected.set(input, cache);
        return format;
    }

    /**
     * The format of `source`: the first sniffer without a priority that recognises its head, else
     * the library's detection with the readers that have one in their places.
     */
    private async detect(source: Source, signal: AbortSignal | undefined): Promise<string> {
        if (this.sniffers.length) {
            const count = Math.min(source.size, SNIFF_BYTES);
            const head = await awaitWithAbort(source.read(0, count), signal);
            assertSourceBytes(head, count, 'source.read()');
            for (const { format, sniff } of this.sniffers) if (sniff(head) === true) return format;
        }
        return detectSourceFormat(source, signal, this.signatures);
    }

    /**
     * Indexes `input` with resolved open options (the API reads and checks them); `notes` are
     * warnings of the call, such as repaired options, reported with the file's own. With `probe` a
     * large input whose reader can describe it from a few reads (its head and tail) is not indexed:
     * the file describes its tracks without sample counts and reads no packets, or, with `around`,
     * holds the samples of a window from which the pictures shown from `around` through `through`
     * seconds decode.
     */
    async open(
        input: Source | MediaInput,
        options: OpenOptions = {},
        notes: readonly { readonly code: string; readonly message: string }[] = [],
        probe?: ProbeTarget,
    ): Promise<MediaFile> {
        const snapshot = options;
        const {
            format: requestedFormat,
            maxSamples: requestedSamples,
            maxIndexBytes,
            cacheBytes,
            readPageBytes,
        } = snapshot;
        // The warnings of reading the input: the call's notes first, as each read reports them.
        const reading = (options: OpenOptions): DiagnosticContext => {
            const context = new DiagnosticContext(options, 'compatible');
            for (const note of notes) context.warn({ code: note.code, message: note.message });
            return context;
        };
        const diagnostics = reading(snapshot);
        const demuxOptions: OpenOptions = {
            ...snapshot,
            validation: diagnostics.validation,
            metadataPolicy: diagnostics.metadataPolicy,
            onWarning: warning => diagnostics.warn(warning),
        };
        if (
            requestedFormat !== undefined &&
            (typeof requestedFormat !== 'string' || !requestedFormat.trim())
        ) {
            throw new MediaForgeError('format must be a nonempty string', 'INPUT');
        }
        const limit = positiveLimit(snapshot.maxPacketBytes, 64 * 1024 * 1024, 'maxPacketBytes');
        const budget = resolveDemuxBudget(
            { maxSamples: requestedSamples, maxIndexBytes },
            OPEN_MAX_SAMPLES,
        );
        const { maxSamples } = budget;
        throwIfAborted(snapshot.signal);
        let source = sourceOf(input);
        const detected = this.detected.get(input);
        this.detected.delete(input);
        const cache =
            detected && cacheBytes === undefined && readPageBytes === undefined
                ? detected
                : new CachedSource(source, { maxBytes: cacheBytes, pageBytes: readPageBytes });
        if (cacheBytes !== 0) source = cache;
        const format =
            snapshot.format?.trim().toLowerCase() ?? (await this.detect(source, snapshot.signal));
        let result: DemuxResult;
        const part = this.readers.get(format);
        if (!part) throw this.writers.missing.format(format, `No reader for '${format}'`);
        const reader = await awaitWithAbort(this.loadReader(part), snapshot.signal);
        const { handsOver, compactIndex } = capabilitiesOf(reader);
        const request: ReadOptions = {
            ...demuxOptions,
            ...budget,
            format,
            maxPacketBytes: limit,
            ...(compactIndex ? { compactIndex } : {}),
        };
        // A reader's RangeError (a read past a view, nesting past the call stack) is malformed
        // input, whichever reader parses.
        const parsed = <T>(work: Promise<T>): Promise<T> =>
            awaitWithAbort(work, snapshot.signal).catch(error => {
                throw demuxFailure(error);
            });
        const prober = probe ? reader.probe : undefined;
        const probed = prober && (await parsed(prober(source, request, probe)));
        // An input read in one pass merges its tracks by the stream schedule: it loads while the
        // file's tracks are described.
        if (probed?.stream) loadStreamSchedule().catch(() => undefined);
        const warned = diagnostics.warnings.length;
        result = probed?.result ?? (await parsed(reader.read(source, request)));

        // An input its reader could not describe from its ends (a short one, or one laid out
        // otherwise) that reads whole without damage is described the same way, without sample
        // counts; its index stays readable.
        const counted = !(
            prober &&
            probed === undefined &&
            describes(probe!) &&
            diagnostics.warnings.length === warned
        );
        throwIfAborted(snapshot.signal);

        /**
         * The file of ProbedInput.index, read as an open without a probe reads it. Made outside
         * fileOf(), whose closures share a scope that holds the probe's result.
         */
        const indexOf =
            (index: NonNullable<ProbedInput['index']>): NonNullable<MediaFile['probedIndex']> =>
            async (indexSignal, onWarning) => {
                const context = reading({ ...snapshot, onWarning });
                const file = await fileOf(
                    await index(indexSignal, context),
                    undefined,
                    context,
                    indexSignal,
                );
                file.releaseReads();
                return file;
            };

        /** The file of `read`: its tracks completed from their first samples. */
        const fileOf = async (
            read: DemuxResult,
            found: ProbedInput | undefined,
            context: DiagnosticContext,
            signal: AbortSignal | undefined,
            release?: () => void,
            opened?: DemuxResult,
        ): Promise<MediaFile> => {
            // A window's tracks are described as the open described them, the others from their
            // first samples: configurations missing from a video track's sample entry are
            // recovered from them.
            const own = opened ? describedAs(read, opened) : read;
            if (own.videoTracks.some(mayLackVideoConfig)) {
                const { recoverVideoConfigurations } = await import('./video-config');
                await recoverVideoConfigurations(own, source, context, limit, signal);
            }
            await describeSyncAudioTracks(own, source, limit, signal);
            await describeAacTracks(own, source, limit, signal);
            return new MediaFile({
                source,
                format,
                result: read,
                diagnostics: context,
                maxPacketBytes: limit,
                maxSamples,
                maxIndexBytes: budget.maxIndexBytes,
                releaseSource: release,
                writers: this.writers,
                probed: found && {
                    kind: found.packets ? 'window' : 'described',
                    start: found.start,
                    stream: found.stream,
                    fromStart: found.fromStart === true,
                    end: found.end,
                    counted: found.counted === true,
                },
                ownsSamples: handsOver,
                counted,
                windowTracks: found?.windowTracks,
                probedIndex: found?.index && indexOf(found.index),
                window:
                    found?.window &&
                    (async (target, windowSignal, onWarning) => {
                        // Its tracks are described by the open's (describedAs()).
                        const window = await found.window!(target, windowSignal);
                        return window?.packets
                            ? fileOf(
                                  window.result,
                                  window,
                                  diagnostics.fresh(onWarning),
                                  windowSignal,
                                  undefined,
                                  read,
                              )
                            : undefined;
                    }),
            });
        };
        const file = await fileOf(result, probed ?? undefined, diagnostics, snapshot.signal, () =>
            cache.clear(),
        );
        // An indexed or described file is read from wherever its next operation starts, so what its
        // scans read goes; one probed for an operation is read on by that operation.
        if (!probe || describes(probe)) file.releaseReads();
        return file;
    }
}

/**
 * The capabilities a loaded reader declares, checked: `compactIndex` counts only with `handsOver`,
 * since the file keeps a reader's compact indexes only with its samples.
 */
function capabilitiesOf(reader: Reader): Required<ReaderCapabilities> {
    if (!reader || typeof reader !== 'object' || typeof reader.read !== 'function')
        throw new MediaForgeError("A reader part's load() must resolve with a reader", 'INPUT');
    const { capabilities = {} } = reader;
    if (typeof capabilities !== 'object' || capabilities === null)
        throw new MediaForgeError("A reader's capabilities must be an object", 'INPUT');
    const { handsOver = false, compactIndex = false } = capabilities;
    if (typeof handsOver !== 'boolean' || typeof compactIndex !== 'boolean')
        throw new MediaForgeError("A reader's capabilities are true or false", 'INPUT');
    return { handsOver, compactIndex: handsOver && compactIndex };
}

/**
 * True when recoverVideoConfigurations() may derive the configuration of `track`: an AV1 track,
 * whose configuration may lack its sequence header, or an H.264, HEVC, VVC or MPEG video track
 * without a configuration.
 */
function mayLackVideoConfig(track: DemuxResult['videoTracks'][number]): boolean {
    if (track.codec.startsWith('av01')) return true;
    if (track.codecConfig?.length) return false;
    const codec = track.codec;
    return (
        codec.startsWith('avc') ||
        isHevcCodec(codec) ||
        /^(vvc1|vvi1)/i.test(codec) ||
        !!mpegVideoFamily(codec)
    );
}

/** True when a probe target asks for the tracks only: no stream, range or picture. */
function describes(target: ProbeTarget): boolean {
    return !target.stream && !target.range && target.around === undefined;
}
