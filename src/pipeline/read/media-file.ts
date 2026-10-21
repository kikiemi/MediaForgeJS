import { type FormatWriters } from '../plugins/missing-parts';
import type {
    TrimPlan,
    SampleSearchOptions,
    FilePacket,
    RemuxOptions,
    RemuxSupport,
} from '../media-types';
import type { CountedTrack, MediaTrack } from '../../core/model/media';
import type {
    PacketSearchOptions,
    MediaPacket,
    PacketOptions,
    SegmentOptions,
    MediaSegment,
} from '../packet-types';
import { snapshotTags } from './track-snapshot';
import { PacketSchedule, indexTracks, type IndexedTrack, type SampleOrder } from './indexed-tracks';
import type { MediaFileWriter, RemuxValidationOptions } from '../copy/media-file-writer';
import type * as PacketCopyModule from '../copy/packet-copy';
import { snapshotSegments } from './segment-options';
import type { Source, Sink } from '../../core/model/types';
import type { MatroskaPassThrough, MediaTags } from '../../core/model/media';
import type {
    DemuxResult,
    Sample,
    ProbedInput,
    ProbeTarget,
    TrackInfo,
} from '../../core/model/track';
import {
    borrowedReads,
    cachedBorrower,
    lendBorrow,
    type BorrowedReads,
} from '../../core/io/sources/cached-source';
import { holdBytes, releaseBytes } from '../../core/bytes/byte-holds';
import { copiedBytes } from '../../core/bytes/shared-bytes';
import { assertSourceBytes, releaseReads } from '../../core/io/sources/source-read';
import {
    copyOutputBytes,
    forgetUnchangingBytes,
    markUnchangingBytes,
} from '../../core/bytes/output-data';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { awaitWithAbort, linkAbortSignals } from '../../core/io/abort';
import { DiagnosticContext, type MediaDiagnostic } from '../../core/errors/diagnostics';
import { withTrackJson } from '../../formats/metadata/track-json';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { holdsAnnexB, normalizeVideoPacket } from '../../core/codec-config/video/video-packet';
import { unwrapAes3 } from '../../core/codec-config/audio/aes3';
import { lowerBound, shiftPacket } from './packet-index';
import {
    getCompactSampleIndex,
    sampleAt,
    type PacketizedSampleReader,
} from '../../core/model/sample-index';
import { bindMediaFileState, forgetMediaFileState, type MediaFileState } from './file-state';
import { leadingTime } from './track-start';
import { mediaTag, withChapterEnds } from '../../core/model/media-tags';
import { decodeTime } from '../../core/model/media-time';
import { checkPacketBytes } from '../../formats/shared/demux-budget';

let closed: DOMException | undefined;

/** The reason a close aborts operations with, made once: one per close costs more than it. */
const closeReason = (): DOMException =>
    (closed ??= new DOMException('This operation was aborted', 'AbortError'));

let streamSchedule: Promise<typeof import('./stream-schedule')> | undefined;

/** The stream schedule, loaded once; a failed load is tried again. */
export function loadStreamSchedule(): Promise<typeof import('./stream-schedule')> {
    return (streamSchedule ??= import('./stream-schedule').catch(error => {
        streamSchedule = undefined;
        throw error;
    }));
}

type PacketCopy = typeof PacketCopyModule;
let packetCopy: PacketCopy | undefined;
let packetCopyLoading: Promise<PacketCopy> | undefined;
let packetCopySource: (() => Promise<PacketCopy>) | undefined;

/**
 * Where the write side of media files (pipeline/copy) loads from. Reading does not depend on
 * copying: the engine, which composes both, provides it before a file is checked or written.
 */
export function providePacketCopy(load: () => Promise<PacketCopy>): void {
    packetCopySource ??= load;
}

/** Loads the write side of media files, which loads with the first writer a check or copy needs. */
export function loadPacketCopy(): Promise<PacketCopy> {
    const load =
        packetCopySource ??
        (() => Promise.reject(new MediaForgeError('No write side is provided', 'FORMAT')));
    return (packetCopyLoading ??= load().then(
        loaded => (packetCopy = loaded),
        error => {
            packetCopyLoading = undefined;
            throw error;
        },
    ));
}

/**
 * Takes the write side of media files from a module that loaded it statically (api/operations),
 * so that the engine finds it there rather than requesting it again.
 */
export function packetCopyLoaded(loaded: PacketCopy): void {
    packetCopy ??= loaded;
    packetCopyLoading ??= Promise.resolve(loaded);
}

/** The write side of media files; FORMAT until a writer has loaded it. */
function loadedPacketCopy(): PacketCopy {
    if (!packetCopy)
        throw new MediaForgeError('The packet copy is not loaded; load the writer first', 'FORMAT');
    return packetCopy;
}

/**
 * Packets of a pass in file order smaller than this are read through retained spans (half the span
 * read ahead).
 */
const SPANNED_PACKET_BYTES = 512 * 1024;

const closedSource: Source = Object.freeze({
    size: 0,
    async read(): Promise<Uint8Array> {
        throw new MediaForgeError('Media file is closed', 'ABORT');
    },
});

/** A sample of a track, by its index. */
interface SampleRef {
    readonly track: IndexedTrack;
    readonly index: number;
    readonly sample: Sample;
}

/** What findSample() searches of a track: its samples, and the orders it keeps for the search. */
type SearchedTrack = Pick<
    IndexedTrack,
    | 'info'
    | 'sampleIndex'
    | 'presentationSorted'
    | 'allKeyframes'
    | 'presentationOrder'
    | 'keyframeOrder'
> & { readonly description: Pick<CountedTrack, 'sampleCount'> };

/**
 * How a packet holds its bytes. `borrowed` bytes view retained bytes until the next packet is asked
 * for (copies hand them straight to a writer). `owned` bytes are the packet's to keep, but may
 * share a buffer with other packets (packetBytes): the library's decoders and readers take these.
 * `exclusive` bytes fill a buffer of their own, so the holder may keep, change or transfer it:
 * every packet user code receives (Media.packets(), readPacket()) holds its bytes so.
 */
export type PacketKeep = 'borrowed' | 'owned' | 'exclusive';

/** Whether `bytes` fill an ArrayBuffer of their own, which can be transferred. */
function fillsBuffer(bytes: Uint8Array): boolean {
    return (
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength &&
        bytes.buffer instanceof ArrayBuffer
    );
}

/**
 * The bytes a packet held as `keep` takes: `owned` bytes (read for this packet, nothing else views
 * them) go out as they are where `keep` allows it, others as a copy.
 */
function keptBytes(bytes: Uint8Array, owned: boolean, keep: PacketKeep): Uint8Array {
    if (keep === 'borrowed' || (owned && (keep === 'owned' || fillsBuffer(bytes)))) return bytes;
    if (keep === 'owned') return copiedBytes(bytes);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
}

/**
 * A sample's bytes and whether each may go out as they are: read for this packet, or borrowed by a
 * copy that hands them straight to a writer. Other bytes (retained pages, inline sample data) go
 * out as copies.
 */
interface SampleBytes {
    readonly data: Uint8Array;
    readonly alphaData?: Uint8Array;
    readonly dataOwned: boolean;
    readonly alphaOwned: boolean;
    /**
     * The configuration of the window of a stream the sample was read in, which the packet
     * carries instead of its track's (StreamedSample.codecConfig).
     */
    readonly codecConfig?: Uint8Array;
}

/**
 * The tracks come from a probe: their sample tables hold the probed reads only, which describe the
 * tracks or are a window of packets to read; `stream` reads every packet in one pass, and `start`
 * is where the whole input starts.
 */
interface ProbedFile {
    readonly kind: 'described' | 'window';
    readonly start?: number;
    readonly stream?: ProbedInput['stream'];
    /** A window holds every packet from the input's start on. */
    readonly fromStart?: boolean;
    /** Where a window ends in the input: its passes read no further. */
    readonly end?: number;
    /** The tracks hold their whole sample counts (ProbedInput.counted). */
    readonly counted?: boolean;
}

/**
 * What a MediaFile is made of: an indexed (or probed) input and how its packets are read and
 * written.
 */
interface MediaFileInit {
    readonly source: Source;
    readonly format: string;
    readonly result: DemuxResult;
    readonly diagnostics: DiagnosticContext;
    readonly maxPacketBytes: number;
    readonly maxSamples: number;
    readonly maxIndexBytes?: number;
    /** Drops what the source retains (its page cache) once the file closes. */
    readonly releaseSource?: () => void;
    readonly writers: FormatWriters;
    readonly probed?: ProbedFile;
    /**
     * Whether the tracks report their packet counts: false for an input described the way a probe
     * describes it, though read whole (the reader could not describe it from its ends).
     */
    readonly counted?: boolean;
    /**
     * The reader handed `result` over (its capabilities' handsOver): its tracks' samples, compact
     * indexes and packet readers are the file's to keep.
     */
    readonly ownsSamples?: boolean;
    /**
     * The file of a window of the input (ProbedInput.window), read with what the probe of this file
     * read; undefined where no window holds the target.
     */
    readonly window?: (
        target: ProbeTarget,
        signal?: AbortSignal,
        onWarning?: (warning: MediaDiagnostic) => void,
    ) => Promise<MediaFile | undefined>;
    /** The tracks of the window around a time its reader parses without a file of it. */
    readonly windowTracks?: ProbedInput['windowTracks'];
    /**
     * The index of the whole input from what the probe of this file read (ProbedInput.index), its
     * warnings to `onWarning`.
     */
    readonly probedIndex?: (
        signal: AbortSignal | undefined,
        onWarning: (warning: MediaDiagnostic) => void,
    ) => Promise<MediaFile>;
}

export class MediaFile {
    readonly format: string;
    readonly title?: string;
    /** The input's tags, chapters and pictures, its title among them. */
    private tags?: MediaTags;
    private readonly indexed: IndexedTrack[];
    private readonly descriptions: readonly CountedTrack[];
    private readonly byId = new Map<number, IndexedTrack>();
    private readonly lifetime = new AbortController();
    private matroskaPassThrough?: MatroskaPassThrough;
    private readonly matroskaUnsupportedTags: boolean;
    private retainedIndexBytes = 0;
    /** What other pipeline modules and the copy planner read of the file. */
    private state: MediaFileState;

    private source: Source;
    private readonly diagnostics: DiagnosticContext;
    private readonly maxPacketBytes: number;
    private releaseSource: (() => void) | undefined;
    private readonly writers: FormatWriters;
    private readonly maxIndexBytes: number;
    private readonly probed?: ProbedFile;
    private readonly counted: boolean;
    /**
     * The file of the samples a target reads (ProbeTarget), from what the probe of this file read
     * (its head, tail and where the clusters or the decode times lie); undefined where no window
     * holds the target. Absent where its reader keeps no such reads.
     */
    readonly window?: MediaFileInit['window'];
    private readonly windowTracks?: MediaFileInit['windowTracks'];
    /** The index from what the probe of this file read; absent where the input is read again. */
    readonly probedIndex?: MediaFileInit['probedIndex'];
    private readonly maxSamples: number;
    /** The writing half: segments, checks and copies of the tracks, made with the first writer. */
    private writing?: MediaFileWriter;

    constructor(init: MediaFileInit) {
        const { source, format, result, diagnostics, writers, maxSamples, maxPacketBytes } = init;
        const { maxIndexBytes = Infinity, ownsSamples = false } = init;
        this.source = source;
        this.diagnostics = diagnostics;
        this.maxPacketBytes = maxPacketBytes;
        this.maxSamples = maxSamples;
        this.releaseSource = init.releaseSource;
        this.writers = writers;
        this.maxIndexBytes = maxIndexBytes;
        this.probed = init.probed;
        this.counted = init.counted !== false && (!init.probed || init.probed.counted === true);
        this.window = init.window;
        this.windowTracks = init.windowTracks;
        this.probedIndex = init.probedIndex;
        this.format = format;
        if (result.title !== undefined && typeof result.title !== 'string')
            throw new DemuxError('Media title must be a string');
        this.title = result.title ?? result.matroskaPassThrough?.title;
        this.tags = snapshotTags(result.tags, this.title);

        // A Matroska title tag replaces the segment title, as ffmpeg reads the file and as other
        // containers write it.
        this.title = mediaTag(this.tags, 'title') ?? this.title;
        const { matroskaPassThrough, matroskaUnsupportedTags } = result;
        this.matroskaUnsupportedTags = matroskaUnsupportedTags === true;
        if (matroskaPassThrough) {
            const { title, tags, chapters, attachments } = matroskaPassThrough;
            if (title !== undefined && typeof title !== 'string')
                throw new DemuxError('Matroska title must be a string');
            this.matroskaPassThrough = {
                title,
                tags: tags ? copyOutputBytes(tags) : undefined,
                chapters: chapters ? copyOutputBytes(chapters) : undefined,
                attachments: attachments ? copyOutputBytes(attachments) : undefined,
            };
        }
        const { tracks: list, indexBytes } = indexTracks(result, {
            source,
            maxSamples,
            maxPacketBytes,
            maxIndexBytes,
            ownsSamples,
        });
        for (const track of list) this.byId.set(track.description.id, track);
        this.indexed = list;
        this.descriptions = list.map(track => track.description);
        this.retainedIndexBytes = indexBytes;

        // Chapters that state only their start end at the next one, the last at the end of the
        // longest track.
        this.tags = withChapterEnds(
            this.tags,
            Math.max(0, ...list.map(track => track.info.duration || 0)),
        );
        this.state = {
            source: this.source,
            format,
            writers,
            title: this.title,
            tags: this.tags,
            matroskaPassThrough: this.matroskaPassThrough,
            matroskaUnsupportedTags: this.matroskaUnsupportedTags,
            tracks: this.indexed,
            signal: this.lifetime.signal,
            diagnostics,
            missing: writers.missing,
            planner: () => loadedPacketCopy().filePlanner(this.state),
            remux: async (sink, options, context, videoRotation) => {
                assertSink(sink);
                await (
                    await this.loadedWriting()
                ).executeRemux(
                    sink,
                    loadedPacketCopy().snapshotRemux(options),
                    context,
                    videoRotation,
                );
            },
            share: async options => (await this.loadedWriting()).sharePackets(options),
            borrowedPackets: options => this.borrowedPackets(options),
        };
        bindMediaFileState(this, this.state);
    }

    /** The writing half, which reads the file through closures; the packet copy is loaded. */
    private writer(): MediaFileWriter {
        if (this.writing) return this.writing;
        const file = this;
        this.writing = new (loadedPacketCopy().MediaFileWriter)({
            finder: this,
            format: this.format,
            signal: this.lifetime.signal,
            diagnostics: this.diagnostics,
            writers: this.writers,
            // A closed file's planner keeps no title or tags.
            get planner() {
                return file.state.planner();
            },
            get tags() {
                return file.tags;
            },
            get timelineStart() {
                return file.timelineStart;
            },
            get streamed() {
                return file.streamed;
            },
            selected: ids => this.selected(ids),
            packets: (options, borrowed, trim) =>
                this.iteratePackets(options, borrowed ? 'borrowed' : 'owned', trim),
            streamedPackets: (trackIds, borrowed, signal) =>
                this.streamedPackets(trackIds, borrowed ? 'borrowed' : 'owned', signal),
            schedule: (options, trim) => this.packetSchedule(options, trim),
            loadPacket: (track, index, signal, borrowed) =>
                this.loadPacket(track, index, signal, borrowed ? 'borrowed' : 'owned'),
        });
        return this.writing;
    }

    private async loadedWriting(): Promise<MediaFileWriter> {
        await loadPacketCopy();
        return this.writer();
    }

    /**
     * Packet-layer seconds where the input starts: the earliest presentation time of all its
     * tracks, never negative. MPEG-TS and program streams carry their clock here (often 1.4 s or
     * more); start and end of requests count from it.
     */
    get timelineStart(): number {
        return Math.max(0, this.probed?.start ?? leadingTime(this.indexed, false));
    }

    /**
     * True when the tracks come from a probe that reads every packet in one pass: a copy streams
     * through the input.
     */
    get streamed(): boolean {
        return this.probed?.stream !== undefined;
    }

    /**
     * True when the tracks come from a probe that describes the input with less work than its
     * index, rather than from an index of all of it.
     */
    get probedInput(): boolean {
        return this.probed !== undefined;
    }

    /**
     * True when the tracks hold every packet from the input's start on: an index, or a window that
     * starts there.
     */
    get fromStart(): boolean {
        return this.probed === undefined || this.probed.fromStart === true;
    }

    /**
     * Packets a copy of the tracks writes: their counts, or for a streamed input their durations
     * over the mean packet duration of the probe's samples.
     */
    packetTotal(trackIds?: readonly number[]): number {
        let total = 0;
        for (const track of this.selected(trackIds)) {
            const count = track.description.sampleCount;
            if (!this.streamed) total += count;
            else {
                let span = 0;
                for (let index = 0; index < count; index++)
                    span += sampleAt(track.info, index)!.duration;
                total += span > 0 ? Math.round((track.info.duration * count) / span) : count;
            }
        }
        return total;
    }

    /** The tracks as inspect() reports them: counted where the read counted their packets. */
    get tracks(): readonly MediaTrack[] {
        return this.trackDescriptions(this.counted);
    }

    /** Seconds from the input's start to the end of its longest track. */
    get duration(): number {
        return Math.max(0, ...this.descriptions.map(track => track.duration || 0));
    }

    /** The tracks as a Media describes them: never with their packet counts. */
    get uncountedTracks(): readonly MediaTrack[] {
        return this.trackDescriptions(false);
    }

    private trackDescriptions(counted: boolean): readonly MediaTrack[] {
        return this.descriptions.map(description => {
            // Left out as a key, not deleted: the object keeps its shape.
            const { sampleCount, ...uncounted } = description;
            const fields = counted ? description : uncounted;
            const track = { ...fields, codecConfig: description.codecConfig?.slice() };
            return Object.freeze(withTrackJson(track));
        });
    }

    get warnings(): readonly MediaDiagnostic[] {
        return this.diagnostics.warnings;
    }

    /**
     * Drops the bytes held from the reads so far: the source's windows and pages and the spans of
     * the last pass in file order. A file kept open between operations then holds its index, and
     * each operation reads again what it needs.
     */
    releaseReads(): void {
        this.loader = undefined;
        this.spannedSource = undefined;
        releaseReads(this.source);
    }

    /** Fires when the file closes. */
    get closing(): AbortSignal {
        return this.lifetime.signal;
    }

    /** Cancels pending reads/iterators; does not close the borrowed Source. */
    close(): void {
        if (this.lifetime.signal.aborted) return;
        this.lifetime.abort(closeReason());
        forgetMediaFileState(this);
        const release = this.releaseSource;
        this.releaseSource = undefined;
        this.source = closedSource;
        this.indexed.length = 0;
        this.byId.clear();
        this.matroskaPassThrough = undefined;

        // A closed file plans and copies nothing: its state keeps no input, title or tags.
        this.state = {
            ...this.state,
            source: closedSource,
            title: undefined,
            tags: undefined,
            matroskaPassThrough: undefined,
        };
        this.retainedIndexBytes = 0;
        release?.();
    }

    /** The indexed track `id`, whose packets are read by index. */
    private track(id: number): IndexedTrack {
        this.assertIndexed();
        return this.described(id);
    }

    private described(id: number): IndexedTrack {
        throwIfAborted(this.lifetime.signal);
        const track = this.byId.get(id);
        if (!track) throw new MediaForgeError(`Unknown track ${id}`, 'INPUT');
        return track;
    }

    private allocateSampleOrder(length: number): Uint32Array {
        const bytes = length * 4;
        if (bytes > this.maxIndexBytes - this.retainedIndexBytes)
            throw new MediaForgeError('Sample order exceeds maxIndexBytes', 'OOM');
        const order = new Uint32Array(length);
        this.retainedIndexBytes += bytes;
        return order;
    }

    /**
     * A probed file describes its tracks but has no packet index; a streamed one reads its packets
     * in one pass.
     */
    private assertIndexed(): void {
        if (this.probed?.kind === 'described')
            throw new MediaForgeError('A probed input has no packet index', 'INPUT', {
                hint: 'Open it to read packets.',
            });
    }

    private selected(ids?: readonly number[]): IndexedTrack[] {
        throwIfAborted(this.lifetime.signal);
        if (ids === undefined) return [...this.indexed];
        if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
            throw new MediaForgeError('trackIds must contain unique existing track IDs', 'INPUT');
        }
        return ids.map(id => this.described(id));
    }

    /**
     * The search of packetAt() checked, each option read once: an unknown track, a time that is not
     * finite or an option of another type fails with INPUT.
     */
    packetSearch(
        trackId: number,
        time: number,
        options: PacketSearchOptions = {},
    ): Required<SampleSearchOptions> & PacketSearchOptions {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected packet search options', 'INPUT');
        const { keyframe = false, mode = 'before', signal } = options;
        if (
            !Number.isFinite(time) ||
            typeof keyframe !== 'boolean' ||
            (mode !== 'before' && mode !== 'after')
        ) {
            throw new MediaForgeError('Invalid packet search', 'INPUT');
        }
        this.described(trackId);
        return { keyframe, mode, signal };
    }

    /** Finds a presentation-time sample, optionally the preceding random-access sample. */
    findSample(
        trackId: number,
        time: number,
        options: SampleSearchOptions = {},
    ): number | undefined {
        const { keyframe, mode } = this.packetSearch(trackId, time, options);
        return this.searchSample(this.track(trackId), time, keyframe, mode, length =>
            this.allocateSampleOrder(length),
        );
    }

    /**
     * The sample of `track` findSample() finds: the one shown at `time`, else the last shown before
     * it or, with mode 'after', the first after it, among the keyframes with `keyframe`. Orders the
     * search needs are kept on the track, in arrays from `allocate`.
     */
    private searchSample(
        track: SearchedTrack,
        time: number,
        keyframe: boolean,
        mode: 'before' | 'after',
        allocate: (length: number) => Uint32Array,
    ): number | undefined {
        const length = track.description.sampleCount;
        const timestampAt = (index: number): number =>
            track.sampleIndex?.timestampAt(index) ?? track.info.samples[index]!.timestamp;
        const keyframeAt = (index: number): boolean =>
            track.sampleIndex?.isKeyframeAt(index) ?? track.info.samples[index]!.isKeyframe;

        let order: SampleOrder | undefined;
        if (!track.presentationSorted || (keyframe && !track.allKeyframes)) {
            const key = keyframe && !track.allKeyframes ? 'keyframeOrder' : 'presentationOrder';
            if (!track[key]) {
                const indices = allocate(length);
                let count = 0;
                for (let index = 0; index < length; index++) {
                    if (!keyframe || keyframeAt(index)) indices[count++] = index;
                }
                const selected = indices.subarray(0, count);
                if (!track.presentationSorted)
                    selected.sort((a, b) => timestampAt(a) - timestampAt(b) || a - b);
                track[key] = selected;
            }
            order = track[key];
        }

        const orderedLength = order?.length ?? length;
        const index = lowerBound(orderedLength, time, position =>
            timestampAt(order?.[position] ?? position),
        );
        const after = index < orderedLength ? (order?.[index] ?? index) : undefined;
        if (mode === 'after') return after;
        return after !== undefined && timestampAt(after) === time
            ? after
            : index > 0
              ? (order?.[index - 1] ?? index - 1)
              : undefined;
    }

    /**
     * The packet shown at `time` seconds, or the keyframe before or after it (findSample()), with
     * bytes of its own as packets leave the library; undefined where there is none.
     */
    async packetAt(
        trackId: number,
        time: number,
        options?: PacketSearchOptions,
    ): Promise<MediaPacket | undefined> {
        const search = this.packetSearch(trackId, time, options);
        const index = this.findSample(trackId, time, search);
        return index === undefined
            ? undefined
            : this.readPacket(trackId, index, search.signal, 'exclusive');
    }

    /**
     * packetAt() from the window around `target` whose tracks the reader parses without a file of
     * the window (ProbedInput.windowTracks): the packet findSample() finds in the window's track,
     * read and made as this file's packets are, which is the one the window's file gives. Null
     * where the window holds none; undefined where the window's file decides, also where it would
     * fail the checks it makes of its tracks.
     */
    async windowPacketAt(
        trackId: number,
        time: number,
        target: ProbeTarget,
        options?: PacketSearchOptions,
    ): Promise<MediaPacket | null | undefined> {
        const { keyframe, mode, signal } = this.packetSearch(trackId, time, options);
        if (!this.windowTracks) return undefined;
        const linked = linkAbortSignals(this.lifetime.signal, signal);
        try {
            const window = await this.windowTracks(target, linked.signal);
            if (!window) return undefined;
            let samples = 0;
            let bytes = 0;
            let found: TrackInfo | undefined;
            for (const track of [
                ...window.videoTracks,
                ...window.audioTracks,
                ...(window.subtitleTracks ?? []),
            ]) {
                const index = getCompactSampleIndex(track);
                if (!index) continue;
                samples += index.length;
                bytes += index.byteLength + (index.decodeSorted ? 0 : index.length * 4);
                if (index.maxSampleSize > this.maxPacketBytes) return undefined;
                if (track.id === trackId) found = track;
            }
            if (samples > this.maxSamples || bytes > this.maxIndexBytes) return undefined;
            const index = found && getCompactSampleIndex(found);
            if (!index) return null;
            // The file of the window would allocate its sample orders against its index bytes.
            if (index.length * 4 > this.maxIndexBytes - bytes) return undefined;
            const position = this.searchSample(
                {
                    description: { sampleCount: index.length },
                    info: found!,
                    sampleIndex: index,
                    presentationSorted: index.presentationSorted,
                    allKeyframes: index.allKeyframes,
                },
                time,
                keyframe,
                mode,
                length => new Uint32Array(length),
            );
            if (position === undefined) return null;
            throwIfAborted(linked.signal);
            const ref = {
                track: this.described(trackId),
                index: position,
                sample: index.get(position),
            };
            return await this.loadSample(ref, linked.signal, 'exclusive', false);
        } finally {
            linked.dispose();
        }
    }

    /** One packet, its bytes held as `keep` (the library's readers take them `owned`). */
    async readPacket(
        trackId: number,
        sampleIndex: number,
        signal?: AbortSignal,
        keep: 'owned' | 'exclusive' = 'owned',
    ): Promise<FilePacket> {
        const track = this.track(trackId);
        if (
            !Number.isSafeInteger(sampleIndex) ||
            sampleIndex < 0 ||
            sampleIndex >= track.description.sampleCount
        ) {
            throw new MediaForgeError('Sample index is out of range', 'INPUT');
        }
        const linked = linkAbortSignals(this.lifetime.signal, signal);
        try {
            throwIfAborted(linked.signal);
            return await this.loadPacket(track, sampleIndex, linked.signal, keep);
        } finally {
            linked.dispose();
        }
    }

    /**
     * Resolves synchronously when every byte is already retained. Owned packets are independent
     * copies; borrowed packets alias retained cache pages and shared codec configuration, so they
     * are read-only.
     */
    private borrower?: (offset: number, length: number) => Uint8Array | undefined;

    /** Reads for borrowed packets: views of the spans of a pass in file order, read ahead. */
    private loader?: BorrowedReads;

    /**
     * The loader as a Source, for packetized readers: they gather a sample from views of the pass's
     * spans (they only scan what they read) instead of a read of their own per sample.
     */
    private spannedSource?: Source;

    /** The pass's reads as a Source that also lends their borrow, as a cache's would be. */
    private spanned(reads: BorrowedReads): Source {
        if (!this.spannedSource) {
            const source: Source = {
                size: this.source.size,
                read: (offset, length) => reads.read(offset, length),
            };
            lendBorrow(source, (offset, length) => reads.borrow(offset, length));
            this.spannedSource = source;
        }
        return this.spannedSource;
    }

    /**
     * Borrows retained source bytes through one closure per file instead of a registry lookup per
     * packet.
     */
    private borrowSource(offset: number, length: number): Uint8Array | undefined {
        if (this.loader) return this.loader.borrow(offset, length);
        this.borrower ??= cachedBorrower(this.source) ?? (() => undefined);
        return this.borrower(offset, length);
    }

    /**
     * `inOrder`: the packet is one of a pass in file order, whose reads go ahead of it (see
     * readPacketFromSource).
     */
    private loadPacket(
        track: IndexedTrack,
        index: number,
        signal: AbortSignal,
        keep: PacketKeep,
        inOrder = keep === 'borrowed',
    ): FilePacket | Promise<FilePacket> {
        const sample = track.sampleIndex?.get(index) ?? track.info.samples[index]!;
        return this.loadSample({ track, index, sample }, signal, keep, inOrder);
    }

    /** The packet of the sample `ref` names, as loadPacket() makes it. */
    private loadSample(
        ref: SampleRef,
        signal: AbortSignal,
        keep: PacketKeep,
        inOrder: boolean,
    ): FilePacket | Promise<FilePacket> {
        const borrowed = keep === 'borrowed';
        const { track, sample } = ref;
        checkPacketBytes(sample.size + (sample.alphaSize ?? 0), this.maxPacketBytes);
        const packetized = sample.packetSkip === undefined ? undefined : track.packetized;
        if (packetized?.readLent && !sample.data && sample.alphaOffset === undefined) {
            // Gathered from bytes the pass or the cache already holds, without a promise, into
            // bytes of the packet's own, as readPacketFromSource gathers them.
            const read = this.passReads(sample, borrowed, inOrder);
            const data = packetized.readLent(this.packetSource(packetized, read), sample);
            if (data)
                return this.packetFrom(
                    ref,
                    { data, dataOwned: true, alphaOwned: borrowed || read === undefined },
                    keep,
                );
        }
        const data =
            sample.data ?? (packetized ? undefined : this.borrowSource(sample.offset, sample.size));
        const alphaData =
            sample.alphaOffset === undefined
                ? undefined
                : this.borrowSource(sample.alphaOffset, sample.alphaSize!);
        if (data && (alphaData || sample.alphaOffset === undefined))
            return this.packetFrom(
                ref,
                { data, alphaData, dataOwned: borrowed, alphaOwned: borrowed },
                keep,
            );
        return this.readPacketFromSource(ref, { data, alphaData }, signal, keep, inOrder);
    }

    /**
     * The pass a sample is read through (see readPacketFromSource), or undefined when it is read
     * from the source alone.
     */
    private passReads(
        sample: Sample,
        borrowed: boolean,
        inOrder: boolean,
    ): BorrowedReads | undefined {
        const spanned =
            borrowed || (inOrder && sample.size + (sample.alphaSize ?? 0) < SPANNED_PACKET_BYTES);
        return spanned ? (this.loader ??= borrowedReads(this.source, this.probed?.end)) : undefined;
    }

    /** The source `packetized` gathers a sample from: the pass's spans when it only scans them. */
    private packetSource(packetized: PacketizedSampleReader, read?: BorrowedReads): Source {
        return read && packetized.scansReads ? this.spanned(read) : this.source;
    }

    /**
     * Reads the bytes of a sample the retained pages do not hold; `retained` are those they do. A
     * pass in file order reads through retained spans with read-ahead, so the source is read while
     * packets are used and an owned packet is the one copy out of the span; packets of half a span
     * or more are read alone.
     */
    private async readPacketFromSource(
        ref: SampleRef,
        retained: { readonly data?: Uint8Array; readonly alphaData?: Uint8Array },
        signal: AbortSignal,
        keep: PacketKeep,
        inOrder: boolean,
    ): Promise<FilePacket> {
        const { sample } = ref;
        const borrowed = keep === 'borrowed';
        const packetized = sample.packetSkip === undefined ? undefined : ref.track.packetized;
        const read = this.passReads(sample, borrowed, inOrder);
        const spanned = read !== undefined;
        let data = retained.data;
        if (!data) {
            data = await awaitWithAbort(
                packetized
                    ? packetized.read(this.packetSource(packetized, read), sample, signal)
                    : read
                      ? read.read(sample.offset, sample.size)
                      : this.source.read(sample.offset, sample.size),
                signal,
            );
            assertSourceBytes(data, sample.size, 'MediaFile packet');
            throwIfAborted(signal);
        }

        let alphaData = retained.alphaData;
        if (!alphaData && sample.alphaOffset !== undefined) {
            // Borrowed data stays as it is while the alpha bytes are read.
            const held = holdBytes(data);
            try {
                alphaData = await awaitWithAbort(
                    read
                        ? read.read(sample.alphaOffset, sample.alphaSize!)
                        : this.source.read(sample.alphaOffset, sample.alphaSize!),
                    signal,
                );
            } finally {
                if (held) releaseBytes(data);
            }
            assertSourceBytes(alphaData, sample.alphaSize!, 'MediaFile alpha packet');
            throwIfAborted(signal);
        }

        return this.packetFrom(
            ref,
            {
                data,
                alphaData,
                dataOwned: borrowed || (!retained.data && (packetized !== undefined || !spanned)),
                alphaOwned: borrowed || (!retained.alphaData && !spanned),
            },
            keep,
        );
    }

    /**
     * The packet of a sample's bytes, which it holds as `keep`: the one place the bytes of every
     * packet are copied, or not, before they go out.
     */
    private packetFrom(
        { track, index, sample }: SampleRef,
        bytes: SampleBytes,
        keep: PacketKeep,
    ): FilePacket {
        let { data } = bytes;
        const trackConfig =
            sample.codecConfigIndex === undefined
                ? track.info.codecConfig
                : track.info.codecConfigurations?.[sample.codecConfigIndex]?.codecConfig;
        const config = bytes.codecConfig ?? trackConfig;
        const annexB =
            sample.nalUnitFormat === 'annexb' ||
            (sample.nalUnitFormat === undefined &&
                track.type === 'video' &&
                holdsAnnexB(data, track.info.codec, trackConfig));

        if (annexB || sample.proResHeaderless) {
            data = normalizeVideoPacket(
                data,
                track.info.codec,
                trackConfig,
                annexB ? 'annexb' : undefined,
                sample.proResHeaderless,
            );
            checkPacketBytes(
                data.length + (bytes.alphaData?.length ?? 0),
                this.maxPacketBytes,
                'Packet after video normalization',
            );
        } else if (sample.aes3) data = unwrapAes3(data, sample.aes3);

        // A normalized or unwrapped packet is a new array of its own.
        data = keptBytes(data, bytes.dataOwned || data !== bytes.data, keep);
        const alphaData = bytes.alphaData && keptBytes(bytes.alphaData, bytes.alphaOwned, keep);

        // Packets that leave the library share the input's one copy of each configuration,
        // whichever read gave them, and carry no place in the sample table; the library's own may
        // carry the track's configuration.
        if (keep === 'exclusive')
            return {
                trackId: track.description.id,
                data,
                alphaData,
                timestamp: sample.timestamp,
                duration: sample.duration,
                isKeyframe: sample.isKeyframe,
                trackType: track.type,
                decodeTimestamp: sample.decodeTimestamp,
                compositionTimeOffset: sample.compositionTimeOffset,
                leadingDiscard: sample.leadingDiscard,
                trailingDiscard: sample.trailingDiscard,
                decodeOnly: sample.decodeOnly,
                codecConfig: config && this.configCopy(config),
            } as FilePacket;
        return {
            trackId: track.description.id,
            sampleIndex: index,
            data,
            alphaData,
            timestamp: sample.timestamp,
            duration: sample.duration,
            isKeyframe: sample.isKeyframe,
            trackType: track.type,
            decodeTimestamp: sample.decodeTimestamp,
            compositionTimeOffset: sample.compositionTimeOffset,
            leadingDiscard: sample.leadingDiscard,
            trailingDiscard: sample.trailingDiscard,
            decodeOnly: sample.decodeOnly,
            codecConfig:
                bytes.dataOwned && bytes.alphaOwned ? config : config && this.configCopy(config),
        };
    }

    /**
     * The packets' copy of a codec configuration: one per configuration, so a packet does not copy
     * it again.
     */
    private readonly configCopies = new WeakMap<Uint8Array, Uint8Array>();

    private configCopy(config: Uint8Array): Uint8Array {
        let copy = this.configCopies.get(config);
        if (!copy) this.configCopies.set(config, (copy = config.slice()));
        return copy;
    }

    /**
     * The packets of the selected tracks, their bytes held as `keep` (see readPacket): `exclusive`
     * ones leave the library.
     */
    packets(options?: PacketOptions, keep?: 'owned'): AsyncGenerator<FilePacket>;
    packets(
        options: PacketOptions | undefined,
        keep: 'exclusive',
        ended?: () => void,
    ): AsyncGenerator<MediaPacket>;
    /** `ended` runs once the packets end: the last read, a failure, or the iteration stopped. */
    packets(
        options: PacketOptions = {},
        keep: 'owned' | 'exclusive' = 'owned',
        ended?: () => void,
    ): AsyncGenerator<FilePacket> {
        const request = this.packetRequest(options);
        // A streamed input reads all the packets of its tracks in one pass.
        if (!this.streamed || !this.passServes(request)) this.assertIndexed();
        return this.iteratePackets(request, keep, undefined, ended);
    }

    /**
     * Whether one pass through the input in file order serves the packets() of `request`: all the
     * packets of its tracks, without a range or keyframes only. A streamed file gives no others;
     * they come from the index.
     */
    passServes({ start, end, keyframesOnly }: PacketOptions): boolean {
        return start === undefined && end === undefined && !keyframesOnly;
    }

    /** `options` checked as packets() checks them, with the ids of the tracks they select. */
    packetRequest(options: PacketOptions = {}): PacketOptions {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected packet options', 'INPUT');
        const { trackIds, start, end, keyframesOnly, signal } = options;
        const selected = this.selected(trackIds).map(track => track.description.id);
        return { trackIds: selected, start, end, keyframesOnly, signal };
    }

    private async *borrowedPackets(options: PacketOptions): AsyncGenerator<FilePacket> {
        try {
            for await (const packet of this.iteratePackets(options, 'borrowed')) {
                markUnchangingBytes(packet.data);
                yield packet;
            }
        } finally {
            forgetUnchangingBytes();
        }
    }

    /**
     * Decode-order merge of the selected tracks; returns each next sample without reading it. With
     * a trim, every track starts at its cut and tracks without a cut are left out.
     */
    private packetSchedule(options: PacketOptions, trim?: TrimPlan): PacketSchedule {
        throwIfAborted(options.signal);
        throwIfAborted(this.lifetime.signal);
        const { start = -Infinity, end = trim?.end ?? Infinity, keyframesOnly = false } = options;
        if (
            (options.start !== undefined && !Number.isFinite(start)) ||
            (options.end !== undefined && !Number.isFinite(end)) ||
            end < start ||
            typeof keyframesOnly !== 'boolean'
        )
            throw new MediaForgeError('Invalid packet range', 'INPUT');

        const selected = this.selected(options.trackIds).filter(
            track => !trim || trim.cuts.has(track.description.id),
        );
        const tracks = selected.map(track => {
            let order = track.order;
            if (keyframesOnly && !track.allKeyframes) {
                if (!track.decodeKeyframeOrder) {
                    const indices = this.allocateSampleOrder(track.description.sampleCount);
                    let count = 0;
                    for (let position = 0; position < track.description.sampleCount; position++) {
                        const index = order?.[position] ?? position;
                        if (
                            track.sampleIndex?.isKeyframeAt(index) ??
                            track.info.samples[index]!.isKeyframe
                        )
                            indices[count++] = index;
                    }
                    track.decodeKeyframeOrder = indices.subarray(0, count);
                }
                order = track.decodeKeyframeOrder;
            }
            return {
                track,
                order,
                length: order?.length ?? track.description.sampleCount,
                start: trim?.cuts.get(track.description.id)?.decodeStart,
                end: trim?.cuts.get(track.description.id)?.decodeEnd,
                shownFrom: trim?.cuts.get(track.description.id)?.shownFrom,
                cueWindow: trim?.cuts.get(track.description.id)?.cueWindow,
            };
        });
        return new PacketSchedule(tracks, start, end);
    }

    private async *iteratePackets(
        options: PacketOptions,
        keep: PacketKeep,
        trim?: TrimPlan,
        ended?: () => void,
    ): AsyncGenerator<FilePacket> {
        const linked = linkAbortSignals(this.lifetime.signal, options.signal);
        try {
            if (this.streamed && !trim) {
                // An abort stops the packets of a pass as those of the index: at the next packet,
                // not past the batch it was read in.
                const batches = this.streamedPackets(options.trackIds, keep, options.signal);
                for await (const batch of batches)
                    for (const packet of batch) {
                        throwIfAborted(linked.signal);
                        yield packet;
                    }
            } else {
                const borrowed = keep === 'borrowed';
                const schedule = this.packetSchedule(options, trim);
                for (let step = schedule.next(); step; step = schedule.next()) {
                    throwIfAborted(linked.signal);
                    const { cueWindow } = step;
                    const loaded = this.loadPacket(
                        step.track,
                        step.index,
                        linked.signal,
                        keep,
                        true,
                    );
                    const packet = loaded instanceof Promise ? await loaded : loaded;
                    const shown =
                        trim && cueWindow ? loadedPacketCopy().clipCue(packet, cueWindow) : packet;
                    if (!shown) continue;

                    // A borrowed packet's bytes stay as they are until the next packet is asked
                    // for.
                    const held = borrowed && holdBytes(packet.data);
                    const heldAlpha =
                        borrowed && packet.alphaData !== undefined && holdBytes(packet.alphaData);
                    try {
                        yield trim ? shiftPacket(shown, -trim.origin) : shown;
                    } finally {
                        if (held) releaseBytes(packet.data);
                        if (heldAlpha) releaseBytes(packet.alphaData!);
                    }
                }
            }
            throwIfAborted(linked.signal);
        } finally {
            linked.dispose();
            ended?.();
        }
    }

    /**
     * The packets of the selected tracks in one pass through the input, each sample once, numbered
     * per track in the order read, a window of the input at a time, and put in the order a read of
     * the index merges them in (StreamSchedule). `borrowed` packets view the stream's buffers,
     * valid until the next batch is asked for (holdBytes keeps them); others are copies.
     */
    private async *streamedPackets(
        trackIds: readonly number[] | undefined,
        keep: PacketKeep,
        signal?: AbortSignal,
    ): AsyncGenerator<FilePacket[]> {
        const borrowed = keep === 'borrowed';
        const selected = this.selected(trackIds);
        const positions = new Map(selected.map((track, position) => [track, position]));
        const { StreamSchedule } = await loadStreamSchedule();
        const schedule = new StreamSchedule<FilePacket>(
            selected.map(track => {
                const first = sampleAt(track.info, track.order?.[0] ?? 0);
                return first ? decodeTime(first) : Number.NEGATIVE_INFINITY;
            }),
            packet => decodeTime(packet),
            packet => packet.data.length,
        );

        /**
         * Borrowed packets the schedule holds past the batch they were read in keep their bytes
         * with holds: whether the data (1) and the alpha bytes (2) have one.
         */
        const carried = new Map<FilePacket, number>();
        const carry = (packet: FilePacket): void => {
            if (carried.has(packet)) return;
            const alpha = packet.alphaData !== undefined && holdBytes(packet.alphaData);
            carried.set(packet, (holdBytes(packet.data) ? 1 : 0) | (alpha ? 2 : 0));
        };
        const release = (packet: FilePacket): void => {
            const held = carried.get(packet);
            if (held === undefined) return;
            carried.delete(packet);
            if (held & 1) releaseBytes(packet.data);
            if (held & 2) releaseBytes(packet.alphaData!);
        };

        const linked = linkAbortSignals(this.lifetime.signal, signal);
        const read = new Map<IndexedTrack, number>();
        const warn = (warning: Omit<MediaDiagnostic, 'severity'>): void =>
            this.diagnostics.warn(warning);
        try {
            for await (const batch of this.probed!.stream!(linked.signal, warn)) {
                throwIfAborted(linked.signal);
                for (const streamed of batch) {
                    const track = this.indexed[streamed.track];
                    const position = track && positions.get(track);
                    if (position === undefined) continue;
                    const sampleIndex = read.get(track!) ?? 0;
                    read.set(track!, sampleIndex + 1);
                    checkPacketBytes(
                        streamed.sample.size + (streamed.alphaData?.length ?? 0),
                        this.maxPacketBytes,
                    );
                    schedule.push(
                        position,
                        this.packetFrom(
                            { track: track!, index: sampleIndex, sample: streamed.sample },
                            {
                                data: streamed.sample.data,
                                alphaData: streamed.alphaData,
                                dataOwned: borrowed,
                                alphaOwned: borrowed,
                                codecConfig: streamed.codecConfig,
                            },
                            keep,
                        ),
                    );
                }

                const ready: FilePacket[] = [];
                for (let packet = schedule.next(false); packet; packet = schedule.next(false))
                    ready.push(packet);
                if (borrowed) schedule.forEachHeld(carry);
                yield ready;
                for (const packet of ready) release(packet);
            }

            throwIfAborted(linked.signal);
            const rest: FilePacket[] = [];
            for (let packet = schedule.next(true); packet; packet = schedule.next(true))
                rest.push(packet);
            yield rest;
        } finally {
            for (const packet of [...carried.keys()]) release(packet);
            linked.dispose();
        }
    }

    segments(options: SegmentOptions = {}): AsyncGenerator<MediaSegment> {
        const snapshot = snapshotSegments(options);
        const trackIds = this.selected(snapshot.trackIds).map(track => track.description.id);
        return this.copiedSegments({ ...snapshot, trackIds });
    }

    private async *copiedSegments(options: SegmentOptions): AsyncGenerator<MediaSegment> {
        yield* (await this.loadedWriting()).iterateSegments(options);
    }

    /**
     * Checks track/configuration compatibility without source reads, output writes or warning
     * callbacks; packet validity is checked during remux.
     */
    checkRemux(options: RemuxOptions): RemuxSupport {
        try {
            return this.writer().checkRemux(options);
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
            return { supported: false, code: error.code, reason: error.message, warnings: [] };
        }
    }

    async validateRemux(
        options: RemuxOptions,
        validation: RemuxValidationOptions = {},
    ): Promise<RemuxSupport> {
        return (await this.loadedWriting()).validateRemux(options, validation);
    }

    async remux(sink: Sink, options: RemuxOptions): Promise<void> {
        assertSink(sink);
        return (await this.loadedWriting()).remux(sink, options);
    }

    /**
     * Loads the writer of `format`, which checkRemux() and the writing methods need, and the
     * fragmented MP4 writer when an MP4-family copy of these tracks falls back to it
     * (resolveRemuxFormat), so the check and the copy agree.
     */
    async loadWriter(format: string): Promise<void> {
        return (await this.loadedWriting()).loadWriter(format);
    }

    async toBlob(options: RemuxOptions & { readonly maxBytes?: number }): Promise<Blob> {
        return (await this.loadedWriting()).toBlob(options);
    }
}
