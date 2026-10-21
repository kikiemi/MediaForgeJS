import { loadFormatWriter, type FormatWriters } from '../plugins/missing-parts';
import type {
    TrimPlan,
    FilePacket,
    RemuxOptions,
    RemuxSupport,
    PacketRoute,
    PacketRouteOptions,
    SharedReadOptions,
    SharedTrackRead,
    CueWindow,
} from '../media-types';
import type { PacketOptions, SegmentOptions, MediaSegment } from '../packet-types';
import { copiedAudioTrackConfig } from './copied-track';
import { copySink } from './copy-sink';
import type { IndexedTrack, PacketSchedule } from '../read/indexed-tracks';
import type { Sink } from '../../core/model/types';
import type { ContainerFormat, MediaTags } from '../../core/model/media';
import { BLOB_PART_BYTES, MemorySink } from '../../core/io/sinks/sinks';
import {
    createValidationSink,
    PatchRecorder,
    replayPatches,
} from '../../core/io/sinks/validation-sink';
import {
    forgetUnchangingBytes,
    handOffOutput,
    markUnchangingBytes,
} from '../../core/bytes/output-data';
import { assertSink, drainReadiness, drainSink } from '../../core/io/sinks/sink-backpressure';
import { awaitWithAbort, linkAbortSignals } from '../../core/io/abort';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { MP4_FAMILY } from '../../formats/shared/capabilities';
import { lowerBound, shiftPacket } from '../read/packet-index';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import type { CmafTrack } from '../../formats/mp4/write/cmaf-boxes';
import {
    CmafTiming,
    cmafClockDiagnostic,
    cmafDecodeTimeDiagnostic,
    cmafEditTicks,
    commonTick,
    FMP4_TIMING,
    fragmentedStart,
} from './cmaf-timing';
import { decodeTime, secondsToTicks } from '../../core/model/media-time';
import { yieldEventLoop } from '../../core/io/event-loop';
import { copyStart, timedTextConverter, type RemuxPlanner } from './remux-plan';
import { clipCue, planTrim, presentationEnd, reportTrimCuts, type SampleFinder } from './trim-plan';
import { mimeTypeOf } from '../../formats/shared/mime-types';
import { snapshotRemux } from './copy-options';

/** Limits of validateRemux(): the bytes the validation sink takes. */
export interface RemuxValidationOptions {
    readonly maxBytes?: number;
}

/** What the writing half of a MediaFile reads of it: its tracks, packets, planner and limits. */
interface WrittenFile {
    /** The file's sample search, which trims use. */
    readonly finder: SampleFinder;
    readonly format: string;
    /** Aborted once the file closes. */
    readonly signal: AbortSignal;
    readonly diagnostics: DiagnosticContext;
    readonly writers: FormatWriters;
    readonly planner: RemuxPlanner;
    readonly tags: MediaTags | undefined;
    readonly timelineStart: number;
    readonly streamed: boolean;
    selected(ids?: readonly number[]): IndexedTrack[];
    /**
     * The packets of the selected tracks in decode order, borrowed or copied, within a trim when
     * there is one.
     */
    packets(options: PacketOptions, borrowed: boolean, trim?: TrimPlan): AsyncGenerator<FilePacket>;
    /** The packets of a one-pass read, a batch at a time (MediaFile.streamed). */
    streamedPackets(
        trackIds: readonly number[] | undefined,
        borrowed: boolean,
        signal?: AbortSignal,
    ): AsyncGenerator<FilePacket[]>;
    schedule(options: PacketOptions, trim?: TrimPlan): PacketSchedule;
    loadPacket(
        track: IndexedTrack,
        index: number,
        signal: AbortSignal,
        borrowed: boolean,
    ): FilePacket | Promise<FilePacket>;
}

/**
 * Segments, checks and copies of a media file's tracks into a container, fragmented MP4 or an audio
 * file: the writing half of MediaFile, which delegates to it.
 */
export class MediaFileWriter {
    constructor(private readonly file: WrittenFile) {}

    /** The segments of the tracks `options` (checked by MediaFile.segments()) select. */
    async *iterateSegments(
        options: SegmentOptions,
        onProgress?: RemuxOptions['onProgress'],
        diagnostics = this.file.diagnostics,
        trim?: TrimPlan,
        videoRotation?: number,
        /**
         * A file output starts at zero; segments keep a positive input clock such as MPEG-TS
         * carries.
         */
        rebase = false,
    ): AsyncGenerator<MediaSegment> {
        const { trackIds, targetDuration, requireKeyframe = false, signal } = options;
        const tracks = this.file
            .selected(trackIds?.slice())
            .filter(track => !trim || trim.cuts.has(track.description.id));
        this.file.planner.checkCopy(tracks);
        const target = targetDuration ?? 2;
        if (!Number.isFinite(target) || target <= 0)
            throw new MediaForgeError('targetDuration must be positive', 'INPUT');
        if (typeof requireKeyframe !== 'boolean')
            throw new MediaForgeError('requireKeyframe must be boolean', 'INPUT');
        await this.file.writers.load('fmp4');
        const { writer, configs, byteLimit, sampleLimit } = this.file.planner.prepareSegments(
            tracks,
            options,
            diagnostics,
            videoRotation,
            trim ? 'range' : 'file',
        );
        // A file starts at zero; segments keep the input's clock unless it runs below zero. A
        // range's packets arrive moved by its origin.
        const start = fragmentedStart(
            tracks,
            configs,
            trim && (track => trim.cuts.get(track.description.id)!.decodeStart - trim.origin),
        );
        let origin = rebase ? start : Math.min(0, start);
        if (!Number.isFinite(origin)) origin = 0;
        else if (rebase) origin = commonTick(origin, configs);
        const adapters = new Map(
            tracks.map((track, index) => [
                track.description.id,
                new CmafTiming(configs[index]!, {
                    format: this.file.format,
                    timestampResolution:
                        track.info.timestampResolutionSeconds ??
                        1 / (track.info.timescale ?? configs[index]!.timescale),
                    origin,
                    onAligned: () =>
                        diagnostics.recover(cmafClockDiagnostic(track.description, 'fmp4')),
                    amend: (trackId, duration) => writer.amendLastSampleDuration(trackId, duration),
                    onRepaired: () =>
                        diagnostics.recover(cmafDecodeTimeDiagnostic(track.description, 'fmp4')),
                    editTicks: cmafEditTicks(configs[index]!),
                    convert: timedTextConverter(track.info.codec, configs[index]!.codec),
                    shownAtEdit: editStartSample(track, configs[index]!, origin, trim),
                }),
            ]),
        );
        const main = tracks.find(track => track.type === 'video')?.description.id;
        throwIfAborted(signal);
        throwIfAborted(this.file.signal);
        yield {
            kind: 'init',
            data: writer.createInitSegment(),
            tracks: configs.map(track => ({ ...track, codecConfig: track.codecConfig?.slice() })),
        };
        let segmentStart: number | undefined;
        let packets = 0;
        let packetBytes = 0;
        try {
            for await (const packet of this.file.packets(
                { trackIds: tracks.map(track => track.description.id), signal },
                true,
                trim,
            )) {
                const prepared = adapters.get(packet.trackId)!.prepare(packet);
                const time = prepared.time;
                if (prepared.sample.data.length > byteLimit)
                    throw new MediaForgeError('Single packet exceeds maxBufferedBytes', 'OOM');
                const capacity =
                    writer.bufferedSamples >= sampleLimit ||
                    writer.bufferedBytes + prepared.sample.data.length > byteLimit;
                if (
                    writer.bufferedSamples &&
                    (capacity ||
                        prepared.discontinuity ||
                        (segmentStart !== undefined &&
                            time - segmentStart >= target &&
                            (main === undefined || (packet.trackId === main && packet.isKeyframe))))
                ) {
                    yield { kind: 'media', ...writer.flush({ requireKeyframe }) };
                    segmentStart = undefined;
                }
                throwIfAborted(signal);
                throwIfAborted(this.file.signal);
                segmentStart ??= time;

                // Borrowed input bytes, or bytes the adapter made from them: the writer may keep
                // them uncopied.
                markUnchangingBytes(prepared.sample.data);
                writer.addSample(prepared.sample);
                packets++;
                packetBytes += packet.data.length;
                onProgress?.({ packets, packetBytes });
                throwIfAborted(signal);
                throwIfAborted(this.file.signal);
            }
        } finally {
            forgetUnchangingBytes();
        }
        throwIfAborted(signal);
        throwIfAborted(this.file.signal);
        if (writer.bufferedSamples) yield { kind: 'media', ...writer.flush({ requireKeyframe }) };
        throwIfAborted(signal);
        throwIfAborted(this.file.signal);
    }

    /**
     * The copy range of a remux, reported once the container is known; undefined without start and
     * end.
     */
    private trimPlan(
        tracks: readonly IndexedTrack[],
        options: RemuxOptions,
        diagnostics: DiagnosticContext,
    ): TrimPlan | undefined {
        if (options.start === undefined && options.end === undefined) return undefined;
        const base = this.file.timelineStart;
        const range = {
            start: base + (options.start ?? 0),
            end: options.end === undefined ? undefined : base + options.end,
        };
        const plan = planTrim(this.file.finder, tracks, range, options.format);
        reportTrimCuts(plan, tracks, options.format, diagnostics, base);
        return plan;
    }

    /**
     * The format a copy of `selected` writes, checked against them: the requested one, or
     * fragmented MP4 for an MP4, M4A or M4V copy of a track only fragments carry.
     */
    private copyFormat(
        selected: readonly IndexedTrack[],
        options: RemuxOptions,
    ): RemuxOptions['format'] {
        const format = this.file.planner.resolveRemuxFormat(selected, options);
        this.file.planner.checkCopy(selected, format);
        return format;
    }

    /**
     * The writer of a copy of `selected` into `options.format` (copyFormat()), the one choice
     * checkRemux() and executeRemux() make, with the range and the tracks it writes: the audio file
     * writer of one audio track, the fragmented MP4 segment writer, or a container writer. Reports
     * the range's cuts and what the output cannot keep of the tracks.
     */
    private copyWriter(
        selected: readonly IndexedTrack[],
        options: RemuxOptions,
        diagnostics: DiagnosticContext,
    ): {
        readonly trim?: TrimPlan;
        readonly tracks: readonly IndexedTrack[];
        readonly writer: 'audio' | 'fragmented' | 'container';
    } {
        const trim = this.trimPlan(selected, options, diagnostics);
        const tracks = trimmedTracks(selected, trim);
        if (options.format === 'fmp4') return { trim, tracks, writer: 'fragmented' };
        this.file.planner.checkTrackMetadata(tracks, options.format, diagnostics);
        if (!this.file.writers.audio.has(options.format))
            return { trim, tracks, writer: 'container' };
        if (tracks.length !== 1 || tracks[0]!.type !== 'audio')
            throw new MediaForgeError(
                'Audio-only output requires exactly one audio track',
                'FORMAT',
            );
        if (sampleCount(tracks[0]!.info) === 0)
            throw new MediaForgeError(
                'Audio-only copy requires samples in the audio track',
                'FORMAT',
            );
        return { trim, tracks, writer: 'audio' };
    }

    /**
     * Checks track/configuration compatibility without source reads, output writes or warning
     * callbacks; packet validity is checked during remux.
     */
    checkRemux(options: RemuxOptions): RemuxSupport {
        const diagnostics = this.file.diagnostics.fresh();
        try {
            options = snapshotRemux(options);
            throwIfAborted(this.file.signal);
            throwIfAborted(options.signal);

            const selected = this.file.selected(options.trackIds);
            options = { ...options, format: this.copyFormat(selected, options) };
            const { format } = options;
            const { trim, tracks, writer } = this.copyWriter(selected, options, diagnostics);
            const sink: Sink = { write() {}, patchAt() {}, async close() {} };
            let layout: 'standard' | 'fragmented' | 'audio' =
                writer === 'audio' ? 'audio' : 'fragmented';
            if (writer === 'fragmented')
                this.file.planner.prepareSegments(
                    tracks,
                    options,
                    diagnostics,
                    undefined,
                    trim ? 'range' : 'file',
                );
            else if (writer === 'audio')
                this.file.writers.audio.get(format)!(
                    format,
                    tracks[0]!.info,
                    sink,
                    () => copiedAudioTrackConfig(tracks[0]!.info, format as ContainerFormat),
                    this.file.tags,
                );
            else
                layout = this.file.planner.prepareContainer(
                    tracks,
                    sink,
                    options,
                    diagnostics,
                    undefined,
                    trim,
                ).layout;

            return {
                supported: true,
                outputFormat: format,
                layout,
                trackIds: tracks.map(track => track.description.id),
                warnings: diagnostics.warnings,
            };
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
            return {
                supported: false,
                code: error.code,
                reason: error.message,
                warnings: diagnostics.warnings,
            };
        }
    }

    async validateRemux(
        options: RemuxOptions,
        validation: RemuxValidationOptions = {},
    ): Promise<RemuxSupport> {
        const diagnostics = this.file.diagnostics.fresh();
        try {
            if (!validation || typeof validation !== 'object' || Array.isArray(validation))
                throw new MediaForgeError('Expected validation options', 'INPUT');
            const sink = createValidationSink(validation.maxBytes);
            const snapshot = snapshotRemux(options);
            const result = await this.executeRemux(
                sink,
                { ...snapshot, onProgress: undefined },
                diagnostics,
            );
            return { supported: true, ...result, warnings: diagnostics.warnings };
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
            return {
                supported: false,
                code: error.code,
                reason: error.message,
                warnings: diagnostics.warnings,
            };
        }
    }

    async remux(sink: Sink, options: RemuxOptions): Promise<void> {
        assertSink(sink);
        await this.executeRemux(sink, snapshotRemux(options), this.file.diagnostics);
    }

    /**
     * Loads the writer of `format`, which checkRemux() and the writing methods need, and the
     * fragmented MP4 writer when an MP4-family copy of these tracks falls back to it
     * (resolveRemuxFormat), so the check and the copy agree.
     */
    async loadWriter(format: string): Promise<void> {
        await loadFormatWriter(this.file.writers, format);
        if (!['mp4', 'm4a', 'm4v'].includes(format)) return;
        let resolved: string;
        try {
            resolved = this.file.planner.resolveRemuxFormat(this.file.selected(), {
                format: format as RemuxOptions['format'],
            });
        } catch {
            return;
        }
        if (resolved !== format) await this.file.writers.load(resolved);
    }

    async executeRemux(
        sink: Sink,
        options: RemuxOptions,
        diagnostics: DiagnosticContext,
        videoRotation?: number,
    ): Promise<Pick<Extract<RemuxSupport, { supported: true }>, 'outputFormat' | 'layout'>> {
        // Copied packets may view reused buffers, which the writers pass on to the sink.
        sink = copySink(sink);
        await this.file.writers.load(options.format);
        const selected = this.file.selected(options.trackIds);
        options = { ...options, format: this.copyFormat(selected, options) };
        const linked = linkAbortSignals(this.file.signal, options.signal, sink.signal);
        try {
            throwIfAborted(linked.signal);
            const { trim, tracks, writer } = this.copyWriter(selected, options, diagnostics);
            if (writer === 'audio') {
                const track = tracks[0]!;
                const muxer = this.file.writers.audio.get(options.format)!(
                    options.format,
                    track.info,
                    sink,
                    // A trimmed MPEG audio copy states no gapless window: its own would need the
                    // cut's priming.
                    trim && ['mp1', 'mp2', 'mp3'].includes(options.format)
                        ? undefined
                        : () =>
                              copiedAudioTrackConfig(track.info, options.format as ContainerFormat),
                    this.file.tags,
                );

                // Ogg Vorbis states its presented samples in the final granule; a trimmed copy
                // presents fewer.
                if (trim && track.info.codec === 'vorbis' && muxer.setValidSamples) {
                    const rate = track.info.sampleRate;
                    const end = Math.min(
                        trim.end ?? Infinity,
                        presentationEnd(track) -
                            (track.info.audioTrailingPaddingSamples ?? 0) / rate,
                    );
                    muxer.setValidSamples(Math.max(0, Math.round((end - trim.origin) * rate)));
                }
                await this.routePackets({
                    trackIds: [track.description.id],
                    trim,
                    signal: linked.signal,
                    sink,
                    route: packet => muxer.addAudioChunk(packet),
                    onProgress: options.onProgress,
                });
                await awaitWithAbort(muxer.finalize(), linked.signal);
                return { outputFormat: options.format, layout: 'audio' };
            }
            if (writer === 'fragmented') {
                for await (const segment of this.iterateSegments(
                    { ...options, signal: linked.signal },
                    options.onProgress,
                    diagnostics,
                    trim,
                    videoRotation,
                    true,
                )) {
                    sink.write(handOffOutput(segment.data));
                    await drainSink(sink, linked.signal);
                }
                throwIfAborted(linked.signal);
                await awaitWithAbort(sink.close(), linked.signal);
                return { outputFormat: options.format, layout: 'fragmented' };
            }
            const copy = async (
                target: Sink,
                context: DiagnosticContext,
                onProgress: RemuxOptions['onProgress'],
            ): Promise<'standard' | 'fragmented'> => {
                const { muxer, routes, layout } = this.file.planner.prepareContainer(
                    tracks,
                    target,
                    options,
                    context,
                    videoRotation,
                    trim,
                );

                await this.routePackets({
                    trackIds: tracks.map(track => track.description.id),
                    trim,
                    offset: trim
                        ? undefined
                        : -copyStart(options.format, tracks, layout === 'fragmented'),
                    signal: linked.signal,
                    sink: target,
                    route: packet => routes.get(packet.trackId)!(packet),
                    onProgress,
                });
                await awaitWithAbort(muxer.finalize(), linked.signal);
                return layout;
            };
            if (sink.patchAt || !MP4_FAMILY.has(options.format))
                return {
                    outputFormat: options.format,
                    layout: await copy(sink, diagnostics, options.onProgress),
                };

            // A streamed input is read once: without patching, its MP4 copy is written as
            // fragments.
            if (this.file.streamed) {
                diagnostics.warn({
                    code: 'MP4_FRAGMENTED',
                    format: options.format,
                    message:
                        `${options.format} is written fragmented: the destination cannot be ` +
                        `patched`,
                });
                return this.executeRemux(
                    sink,
                    { ...options, format: 'fmp4' },
                    diagnostics,
                    videoRotation,
                );
            }

            // A forward-only sink would make the MP4 writer hold every payload for its header; a
            // measuring pass records the header patches instead, and the second pass writes them
            // into the stream as it goes.
            const report = options.onProgress;
            let measured = { packets: 0, packetBytes: 0 };
            const recorder = new PatchRecorder();
            await copy(recorder, diagnostics.fresh(), progress => {
                measured = progress;
                report?.({
                    packets: Math.floor(progress.packets / 2),
                    packetBytes: Math.floor(progress.packetBytes / 2),
                });
            });
            const layout = await copy(
                replayPatches(sink, recorder),
                diagnostics,
                report &&
                    (progress =>
                        report({
                            packets: Math.floor((measured.packets + progress.packets) / 2),
                            packetBytes: Math.floor(
                                (measured.packetBytes + progress.packetBytes) / 2,
                            ),
                        })),
            );
            return { outputFormat: options.format, layout };
        } catch (error) {
            try {
                Promise.resolve(sink.abort?.(error)).catch(() => undefined);
            } catch {}
            throw error;
        } finally {
            linked.dispose();
        }
    }

    /**
     * Hands the borrowed packets of a copy to a writer that copies or writes them before returning:
     * a streamed input's in one pass through it, any other's as a shared read of the copy alone.
     */
    async routePackets(options: PacketRouteOptions): Promise<void> {
        if (!this.file.streamed || options.trim)
            return this.sharePackets({ ...options, routes: [options], reads: [] });
        const deliver = this.deliverer(options);
        try {
            for await (const batch of this.file.streamedPackets(
                options.trackIds,
                true,
                options.signal,
            ))
                for (const packet of batch) {
                    const waiting = deliver(options, packet);
                    if (waiting) await waiting;
                }
        } finally {
            forgetUnchangingBytes();
        }
        throwIfAborted(options.signal);
    }

    /**
     * Routes a borrowed packet of a copy, its bytes marked unchanging, onto the output timeline. A
     * promise when the sink, or every 2048 packets the event loop, is waited for before its
     * progress is told: the event loop when the sink has no drain() of its own or its drain() would
     * resolve at once.
     */
    private deliverer({
        signal,
        sink,
        onProgress,
    }: Pick<SharedReadOptions, 'signal' | 'sink' | 'onProgress'>) {
        const drainReady = sink && drainReadiness(sink);
        let packets = 0;
        let packetBytes = 0;
        return (route: PacketRoute, packet: FilePacket): Promise<void> | undefined => {
            const shift = (route.offset ?? 0) - (route.trim?.origin ?? 0);
            markUnchangingBytes(packet.data);
            route.route(shift ? shiftPacket(packet, shift) : packet);
            packets++;
            packetBytes += packet.data.length;
            const progress = onProgress && { packets, packetBytes };
            const waiting =
                sink?.drain && !drainReady?.()
                    ? drainSink(sink, signal)
                    : (packets & 2047) === 0
                      ? awaitWithAbort(yieldEventLoop(), signal)
                      : undefined;
            if (!waiting) return void (progress && onProgress(progress));
            return progress ? waiting.then(() => onProgress(progress)) : waiting;
        };
    }

    /**
     * One read of the input for copies and readers (SharedReadOptions). Each copy follows the
     * schedule of its tracks within its trim and each reader the samples it names; packet by packet
     * the pass reads the earliest in decode time of their next ones, the earlier listed first on a
     * tie (copies before readers), so every packet is read once, in file order while they keep
     * pace. Retained bytes are read without a promise per packet.
     */
    async sharePackets(options: SharedReadOptions): Promise<void> {
        const { routes, reads, signal, ready, routed } = options;
        const deliver = this.deliverer(options);
        interface Copy {
            readonly route: PacketRoute;
            readonly schedule: PacketSchedule;
            /** The next sample, undefined once the copy has none left. */
            track?: IndexedTrack;
            index: number;
            cueWindow?: CueWindow;
            /** Its decode time; a copy alone (routePackets()) looks up none. */
            time: number;
        }
        const copies: Copy[] = [];
        const tracks = new Map<number, IndexedTrack>();
        const timeAt = (track: IndexedTrack, index: number): number =>
            track.sampleIndex?.decodeTimeAt(index) ?? decodeTime(track.info.samples[index]!);
        const advance = (copy: Copy): void => {
            const step = copy.schedule.next();
            copy.track = step?.track;
            copy.index = step?.index ?? 0;
            copy.cueWindow = step?.cueWindow;
            copy.time = step && ready ? timeAt(step.track, step.index) : 0;
            if (!step) routed?.(copy.route);
        };
        try {
            for (;;) {
                throwIfAborted(signal);
                while (copies.length < routes.length) {
                    const route = routes[copies.length]!;
                    const schedule = this.file.schedule(
                        { trackIds: route.trackIds, signal },
                        route.trim,
                    );
                    copies.push({ route, schedule, index: 0, time: 0 });
                    advance(copies.at(-1)!);
                }
                const pace = ready?.();
                if (pace) {
                    await pace;
                    continue;
                }

                let chosen: Copy | SharedTrackRead | undefined;
                let track: IndexedTrack | undefined;
                let index = 0;
                let time = Infinity;
                for (const copy of copies)
                    if (copy.track && copy.time < time) {
                        chosen = copy;
                        track = copy.track;
                        index = copy.index;
                        time = copy.time;
                    }
                for (const read of reads) {
                    const sample = read.next();
                    if (sample === undefined) continue;
                    let at = tracks.get(read.trackId);
                    if (!at)
                        tracks.set(read.trackId, (at = this.file.selected([read.trackId])[0]!));
                    const when = timeAt(at, sample);
                    if (when < time) {
                        chosen = read;
                        track = at;
                        index = sample;
                        time = when;
                    }
                }
                if (!chosen) break;

                const loaded = this.file.loadPacket(track!, index, signal, true);
                const packet = loaded instanceof Promise ? await loaded : loaded;
                if ('take' in chosen) {
                    chosen.take(packet);
                    continue;
                }
                const copy: Copy = chosen;
                const shown = copy.cueWindow ? clipCue(packet, copy.cueWindow) : packet;
                const waiting = shown && deliver(copy.route, shown);
                if (waiting) await waiting;
                advance(copy);
            }
        } finally {
            forgetUnchangingBytes();
        }
        throwIfAborted(signal);
    }

    async toBlob(options: RemuxOptions & { readonly maxBytes?: number }): Promise<Blob> {
        const sink = new MemorySink({
            maxBytes: options.maxBytes ?? 256 * 1024 * 1024,
            blobPartBytes: BLOB_PART_BYTES,
        });
        const snapshot = snapshotRemux(options);
        await this.remux(sink, snapshot);
        return sink.toBlob(mimeTypeOf(snapshot.format));
    }
}

/**
 * The picture the fragmented MP4 edit of a video track starts inside, which CmafTiming then
 * presents from the edit's start as the MP4 writer does (presentedFromEdit): of its packets as
 * CmafTiming times them (from the cut of `trim`, moved by its origin), the latest presented at or
 * before the edit's media time, when that is before it. A picture decoded after that time is
 * presented after it.
 */
function editStartSample(
    track: IndexedTrack,
    config: CmafTrack,
    origin: number,
    trim: TrimPlan | undefined,
): number | undefined {
    if (track.type !== 'video' || !config.edit) return undefined;
    const { info, order } = track;
    const edit = config.edit.mediaTime;
    const scale = config.timescale;
    const count = sampleCount(info);
    const sampleOf = (position: number) => sampleAt(info, order?.[position] ?? position)!;
    const cut = trim?.cuts.get(track.description.id)?.decodeStart;
    let covering = -Infinity;
    let shown: number | undefined;
    for (
        let position =
            cut === undefined ? 0 : lowerBound(count, cut, at => decodeTime(sampleOf(at)));
        position < count;
        position++
    ) {
        const sample = trim ? shiftPacket(sampleOf(position), -trim.origin) : sampleOf(position);
        const dts =
            secondsToTicks(decodeTime(sample), scale, FMP4_TIMING) -
            secondsToTicks(origin, scale, FMP4_TIMING) +
            edit;
        if (dts > edit) break;
        const time =
            dts +
            secondsToTicks(
                sample.compositionTimeOffset ?? sample.timestamp - decodeTime(sample),
                scale,
                FMP4_TIMING,
            );
        if (time <= edit && time > covering) {
            covering = time;
            shown = order?.[position] ?? position;
        }
    }
    return covering === edit ? undefined : shown;
}

/** The tracks a trim writes: those with packets inside the range. */
function trimmedTracks(
    tracks: readonly IndexedTrack[],
    trim: TrimPlan | undefined,
): readonly IndexedTrack[] {
    return trim ? tracks.filter(track => trim.cuts.has(track.description.id)) : tracks;
}
