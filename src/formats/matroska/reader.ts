import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { isVp8Keyframe, isVp9Keyframe } from '../../core/codec-config/video/vpx-frame';
import { DiagnosticContext, type Warn } from '../../core/errors/diagnostics';
import { demuxAssert, demuxFailure, malformedInput } from '../../core/errors/demux-guard';
import {
    DEMUX_LIMITS,
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import type {
    DemuxResult,
    Sample,
    TrackInfo,
    ProbedInput,
    ProbeTarget,
    StreamedSample,
} from '../../core/model/track';
import { MatroskaSampleIndexBuilder } from './read/sample-index';
import {
    addPictures,
    DurationFiller,
    REORDER_DECIDING,
    ReorderClock,
    reorderTiming,
    type ReorderTiming,
} from './read/reorder';
import {
    bindCompactSampleIndex,
    enableCompactSampleIndex,
    readSampleBytes,
    releaseSampleIndex,
    sampleAt,
    sampleCount,
    usesCompactSampleIndex,
} from '../../core/model/sample-index';
import type { Source } from '../../core/model/types';
import {
    BlobSource,
    BufferSource,
    RangeSource,
    UnchangingBytesSource,
} from '../../core/io/sources/sources';
import {
    ForwardWindows,
    MAX_WINDOW_BYTES,
    PlaceSearch,
    WINDOW_BYTES,
    WindowBytes,
    type TimedPlace,
    tracksOf,
    spanWindows,
    holdsAudioBefore,
    probeMiss,
} from '../shared/large-input';
import { PROBE_WINDOWS } from '../shared/probe-windows';
import { ConcatSource } from '../../core/io/sources/concat-source';
import { holdBytes, releaseBytes } from '../../core/bytes/byte-holds';
import { uncachedReads, uncachedSource, uncachedViews } from '../../core/io/sources/cached-source';
import { readerInto } from '../../core/bytes/read-into';
import { concatBytes } from '../../core/bytes/bytes';
import {
    ChunkReader,
    CHUNK_BYTES,
    WindowReader,
    type ByteReader,
} from '../../core/io/sources/chunk-reader';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import {
    ac3SpecificBox,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import {
    readProResFourCC,
    proResFrameError,
    hasProResFrameHeader,
} from '../../core/codec-config/video/prores';
import { opusPacketFrames } from '../../core/codec-config/audio/opus-packet';
import { parseFlacFrameHeader } from '../../core/codec-config/audio/flac-frame';
import { matroskaPcmCodec } from './pcm';
import { alacCookie, alacPacketFrames } from '../../core/codec-config/audio/alac-packet';
import { describePcmTrack } from '../../core/codec-config/audio/pcm-format';
import { DOLBY_VISION_CONFIG_BYTES } from '../../core/codec-config/video/dolby-vision';
import { audioHasKeyframes, mpegVideoFamily, isProResCodec } from '../../core/model/codec-strings';
import { matroskaUid } from '../metadata/matroska-values';
import { rawVideoCodecForFourcc } from '../../core/codec-config/video/raw-video';
import { vorbisPacketBlock } from '../../core/codec-config/audio/vorbis-headers';
import {
    ID,
    SEGMENT_CHILD_IDS,
    CLUSTER_CHILD_IDS,
    type Element,
    type ParsedHeader,
    newHeader,
    vintLength,
    readVint,
    readHeaderLocal,
    elements,
    clusterIds,
    readUint,
    uintOf,
    floatOf,
    asciiOf,
    MAX_METADATA_BYTES,
    utf8Of,
} from './ebml';
import {
    CODEC_MAP,
    videoCodecFromPrivate,
    SUBTITLE_CODEC_MAP,
    type WebMTrack,
    setDisplayGeometry,
    colourOf,
    DISPOSITION_FLAGS,
    MATROSKA_FIELD_ORDERS,
    COMPRESSION_ZLIB,
    COMPRESSION_HEADER_STRIP,
    type ContentCompression,
    contentCompression,
    projectionRotation,
    vorbisBlocks,
    legacyAacConfig,
} from './read/track-entry';
import { laceFrames } from './read/lacing';
import { readsPastDamage, recoverDamage, type MatroskaReadContext } from './read/read-context';
import type { MatroskaMetadata } from './read/metadata';

/** BlockAddIDType values of Dolby Vision configuration mappings: 'dvcC' and 'dvvC'. */
const DOLBY_VISION_DVCC = 0x64766343;
const DOLBY_VISION_DVVC = 0x64767643;

/** How each video track is timed (ReorderClock), by track number. */
type ReorderTimings = ReadonlyMap<number, ReorderTiming>;

/**
 * The timing of a stream's samples across its windows: `push` takes them in file order, `flush`
 * times those still held at the end, and `held` lists those waiting for later samples.
 */
interface StreamTiming {
    push(item: StreamedSample): void;
    flush(): void;
    held(): StreamedSample[];
}

const HEADER_PEEK = 24;
const SEEK_HEAD = 0x114d9b74;
const CUES = 0x1c53bb6b;

/**
 * Most bytes a probe reads at once to walk a head or tail window, which its demux then reads from
 * memory: twice the first window (4 MiB).
 */
const probeSpanBytes = (): number => 2 * PROBE_WINDOWS.first;

/** Largest Cues element a probe reads to find the clusters of the tail. */
const PROBE_MAX_CUES = 16 * 1024 * 1024;

/**
 * The head or tail a probe reads after one of `bytes`: four times as long, the last one
 * PROBE_WINDOWS.last (then none), however short the first.
 */
const nextWindow = (bytes: number): number =>
    bytes < PROBE_WINDOWS.last ? Math.min(4 * bytes, PROBE_WINDOWS.last) : Infinity;

/** Unknown-size Segment header written before the elements a probe's tail window reads. */
const UNKNOWN_SEGMENT = Uint8Array.of(
    0x18,
    0x53,
    0x80,
    0x67,
    0x01,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
);

class SoftLimitExceeded extends Error {}

// Parts of the reader that load when a file needs them.
const recovery = () => import('./read/recovery');
const metadataParts = () => import('./read/metadata');
const codecParts = () => import('./read/codec-parts');
const compressionParts = () => import('./read/compression');

const MPEG_AUDIO = new Set(['mp1', 'mp2', 'mp3']);

/** Frame sizes and durations of one block, filled block by block. */
interface LaceScratch {
    readonly sizes: Float64Array;
    readonly durations: Float64Array;
}

function laceScratch(): LaceScratch {
    return {
        sizes: new Float64Array(MAX_LACE_FRAMES),
        durations: new Float64Array(MAX_LACE_FRAMES),
    };
}
const SOFT_SAMPLE_BUDGET = 65536;
const MAX_LACE_FRAMES = 256;
const EMPTY_PAGE = new Uint8Array(0);

/**
 * Whether a ProRes frame lacks its frame header, as Matroska stores ProRes; a frame that fails both
 * readings is a DEMUX error.
 */
function proResHeaderlessFrame(packet: Uint8Array, track: WebMTrack): boolean {
    let error = proResFrameError(packet, track, true);
    if (!error) return true;
    if (hasProResFrameHeader(packet)) {
        error = proResFrameError(packet, track);
        if (!error) return false;
    }
    throw new DemuxError(error);
}

/**
 * TrackEntry fields of a track's identity: its UID, default, forced and commentary flags, name and
 * language.
 */
const TRACK_IDENTITY_IDS: ReadonlySet<number> = new Set([
    ID.TrackUID,
    ID.FlagDefault,
    ID.FlagForced,
    ID.FlagCommentary,
    ID.Name,
    ID.Language,
    ID.LanguageIETF,
]);

/**
 * CodecIDs whose codec comes from the CodecPrivate or the track's settings rather than the CodecID
 * alone.
 */
const SPECIAL_CODEC_IDS =
    /^(V_PRORES|V_MS\/VFW\/FOURCC|V_UNCOMPRESSED|A_MS\/ACM|A_AAC\/MPEG[24]\/)/;

/**
 * Whether a SeekHead body names a Tags, Chapters or Attachments element; damaged entries name
 * nothing.
 */
function seeksMetadata(buf: Uint8Array): boolean {
    try {
        for (const seek of elements(buf, 0, buf.length))
            for (const field of elements(buf, seek.dataStart, seek.dataEnd))
                if (field.id === 0x53ab) {
                    const id = readUint(buf, field.dataStart, field.dataEnd, 0);
                    if (id === ID.Tags || id === ID.Chapters || id === ID.Attachments) return true;
                }
    } catch {
        return false;
    }
    return false;
}

/**
 * The reserve of the sample array a compact index of `count` samples expands to, made outside the
 * demuxer: a closure made in one of its methods would hold it, and the bytes it read, for as long
 * as the track lives.
 */
function sampleArrayReserve(budget: DemuxIndexBudget, count: number): () => void {
    return () => budget.reserveBytes(count * 256, 'Matroska compatibility sample array');
}

/** WebM/MKV demuxer (windowed cluster reads, lacing, DiscardPadding, D_WEBVTT subtitles). */
export class WebMDemuxer {
    private isWorker = false;
    /** The input is the head of a probe: the Segment continues past its end. */
    private probeHead = false;
    /**
     * A probe's window starts at this cluster: the clusters before it are skipped, and the
     * metadata before them, which the probe's description holds, is passed over.
     */
    private probeFrom = 0;
    /**
     * The elements before the first cluster, for a window that starts after them (WindowBytes).
     */
    declare private windowHead?: ByteReader;
    /**
     * A window of a stream, whose samples alone are read: the metadata before its clusters is
     * passed over.
     */
    private samplesOnly = false;
    /**
     * The block size of the last frame of each Vorbis track, by track number, that a stream's
     * window continues from and leaves for the next window.
     */
    declare private carriedVorbis?: Map<number, number>;
    /**
     * How the video tracks of a probe's window are timed, by track number, as a read of the whole
     * input times them.
     */
    declare private timings?: ReorderTimings;
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private reader: ByteReader;
    private totalSamples = 0;
    declare private signal: AbortSignal | undefined;
    private materialize = true;
    private compact = false;
    private readonly header = newHeader();
    /** Frame sizes and durations of the block being read; a stream's windows share one pair. */
    declare private lace?: LaceScratch;

    private get laceSizes(): Float64Array {
        return (this.lace ??= laceScratch()).sizes;
    }

    private get laceDurations(): Float64Array {
        return (this.lace ??= laceScratch()).durations;
    }
    private metadataDropped = false;
    private metadataWarned = false;
    declare private diagnostics?: DiagnosticContext;
    /** Byte position of the cluster child being parsed, where damage recovery resumes scanning. */
    private clusterFailurePosition = 0;
    /**
     * Timestamp of the cluster being parsed, reused when parsing resumes after damage inside it.
     */
    private lastClusterTimestamp = 0;
    /** Recoveries the diagnostics had counted when this input started; later ones are its own. */
    private recoveriesBefore = 0;
    /** Video frames skipped after damage inside a cluster until their track's next keyframe. */
    private skippedUntilKeyframe = 0;
    /** Whether any track compresses its frames with zlib or LZO1X. */
    private frameCompression = false;
    /** Why tracks were omitted, in first-seen order; each reason warns once per demux. */
    private skippedTracks = new Set<string>();
    declare private externalFailure?: { error: unknown };
    private readonly inputUidCounts = new Map<bigint, number>();
    private sampleBudget = Number.POSITIVE_INFINITY;
    declare private readonly limits: ResolvedDemuxBudget;
    declare private indexBudget: DemuxIndexBudget;
    private readonly reserveIndexBytes = (bytes: number): void => {
        if (this.compact) this.indexBudget.reserveBytes(bytes, 'Matroska sample index');
    };
    declare private context: MatroskaReadContext;

    constructor(options: DemuxBudgetOptions = {}) {
        this.limits = resolveDemuxBudget(options);
    }

    /**
     * Parses the container with windowed reads and returns tracks plus encoded samples; honors
     * `signal`.
     */
    async demux(
        input: Blob | Source,
        signal?: AbortSignal,
        diagnostics?: DiagnosticContext,
    ): Promise<DemuxResult> {
        throwIfAborted(signal);
        if (!this.isWorker) {
            const worker = new WebMDemuxer(this.limits);
            worker.isWorker = true;
            if (usesCompactSampleIndex(this)) enableCompactSampleIndex(worker);
            return worker.demux(input, signal, diagnostics);
        }

        const source = input instanceof Blob ? new BlobSource(input) : input;
        this.reader = this.windowHead
            ? new WindowBytes(this.windowHead, source, this.probeFrom)
            : new ChunkReader(source, CHUNK_BYTES, true);
        this.signal = signal;
        this.diagnostics = diagnostics;
        this.context = {
            reader: this.reader,
            signal,
            diagnostics,
            reserveIndexBytes: this.reserveIndexBytes,
        };
        this.recoveriesBefore = diagnostics?.recoveries ?? 0;
        this.skippedTracks = new Set();
        this.compact = usesCompactSampleIndex(this);
        try {
            try {
                this.totalSamples = 0;
                this.materialize = true;
                this.sampleBudget = this.compact ? Number.POSITIVE_INFINITY : SOFT_SAMPLE_BUDGET;
                return await this.walk();
            } catch (soft) {
                if (!(soft instanceof SoftLimitExceeded)) throw soft;
            }

            this.totalSamples = 0;
            this.materialize = false;
            this.sampleBudget = Number.POSITIVE_INFINITY;
            await this.walk();
            this.totalSamples = 0;
            this.materialize = true;
            return await this.walk();
        } catch (e) {
            if (this.externalFailure && Object.is(this.externalFailure.error, e)) throw e;
            if (e instanceof MediaForgeError && e.code === 'ABORT') throw e;
            throw demuxFailure(e);
        }
    }

    /**
     * The tracks of an input from its head and its tail: the head (whole clusters) gives the tracks
     * and their first samples, the tail (from a cluster the Cues name, or one whose chain of
     * element sizes reaches the end of the input) each track's end and the metadata written after
     * the clusters. The SeekHead must place every Tags, Chapters and Attachments element before the
     * first cluster or in the tail. The tracks hold the head's samples only. Undefined when the
     * input is damaged or laid out otherwise, which then needs a full read.
     */
    async probe(
        input: Source,
        signal?: AbortSignal,
        diagnostics?: DiagnosticContext,
        target: ProbeTarget = {},
    ): Promise<ProbedInput | undefined> {
        // The first head window would reach past the middle of the input, which the head must not
        // (probeInput).
        if (input.size < 2 * PROBE_WINDOWS.first) return undefined;
        try {
            return await this.probeInput(
                input,
                signal,
                diagnostics ?? new DiagnosticContext(),
                target,
            );
        } catch (error) {
            return probeMiss(error);
        }
    }

    private async probeInput(
        input: Source,
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
        target: ProbeTarget,
    ): Promise<ProbedInput | undefined> {
        const size = input.size;
        const read = uncachedReads(input);

        // The head and tail windows are demuxed from the reads that walked them; the rest of them
        // is read past the page cache, whose aligned pages would reach beyond them.
        const direct: Source = { size, read };
        /**
         * The input from `start` to `end`, from the bytes `walk` holds up to `reach` where it still
         * holds them.
         */
        const spanSource = (
            walk: WindowReader,
            start: number,
            reach: number,
            end: number,
        ): Source => {
            const held = walk.retained(start, Math.min(end, reach) - start);
            if (!held) return new RangeSource(direct, start, end - start);
            // The demux reads views of the walked bytes, which nothing changes.
            const bytes = new UnchangingBytesSource(held);
            return start + held.length === end
                ? bytes
                : new ConcatSource([
                      bytes,
                      new RangeSource(direct, start + held.length, end - start - held.length),
                  ]);
        };

        /**
         * A read of a window, as reads of a chunk at most, made together: no single read holds
         * more. They fill one buffer where the input reads into the caller's bytes, and a Blob's
         * window is a view of what it read.
         */
        const views = uncachedViews(input);
        const into = readerInto(uncachedSource(input));
        const readSpan: Source['read'] = async (offset, length) => {
            if (length <= CHUNK_BYTES) return read(offset, length);
            if (views) return views(offset, length);
            const starts: number[] = [];
            for (let at = offset; at < offset + length; at += CHUNK_BYTES) starts.push(at);
            const part = (at: number): number => Math.min(CHUNK_BYTES, offset + length - at);
            if (!into) return concatBytes(await Promise.all(starts.map(at => read(at, part(at)))));
            const bytes = new Uint8Array(length);
            await Promise.all(
                starts.map(at => into(at, bytes.subarray(at - offset, at - offset + part(at)))),
            );
            return bytes;
        };

        const reader = new WindowReader(size, read);
        const header = async (pos: number, from: WindowReader = reader): Promise<ParsedHeader> => {
            const peek = await from.bytes(pos, HEADER_PEEK);
            const h = readHeaderLocal(peek, 0, Number.MAX_SAFE_INTEGER, peek.length, newHeader());
            return {
                id: h.id,
                dataStart: pos + h.headerLen,
                dataEnd: pos + h.dataEnd,
                unknown: h.unknown,
                headerLen: h.headerLen,
            };
        };

        const ebml = await header(0);
        if (ebml.id !== ID.EBML || ebml.unknown) return undefined;
        const segmentStart = ebml.dataEnd;
        const segment = await header(segmentStart);
        if (segment.id !== ID.Segment || (!segment.unknown && segment.dataEnd !== size))
            return undefined;

        // The segment's children up to its first cluster, and where its SeekHead places the others.
        const seeks = new Map<number, number[]>();
        let firstCluster = -1;
        let firstClusterEnd = -1;
        let timestampScaleNs = 1_000_000;
        for (let pos = segment.dataStart, count = 0; pos < size && count < 1024; count++) {
            const h = await header(pos);
            if (h.unknown || h.dataEnd > size) return undefined;
            if (h.id === ID.Cluster) {
                firstCluster = pos;
                firstClusterEnd = h.dataEnd;
                break;
            }

            if (h.id === ID.Info) {
                const buf = await input.read(h.dataStart, h.dataEnd - h.dataStart);
                for (const field of elements(buf, 0, buf.length))
                    if (field.id === ID.TimestampScale)
                        timestampScaleNs = readUint(buf, field.dataStart, field.dataEnd, 1_000_000);
            }

            if (h.id === SEEK_HEAD) {
                const buf = await input.read(h.dataStart, h.dataEnd - h.dataStart);
                for (const seek of elements(buf, 0, buf.length)) {
                    if (seek.id !== 0x4dbb) continue;
                    let id = 0;
                    let position = -1;
                    for (const field of elements(buf, seek.dataStart, seek.dataEnd)) {
                        if (field.id === 0x53ab)
                            id = readUint(buf, field.dataStart, field.dataEnd, 0);
                        else if (field.id === 0x53ac)
                            position = readUint(buf, field.dataStart, field.dataEnd, -1);
                    }

                    if (position >= 0)
                        seeks.set(id, [...(seeks.get(id) ?? []), segment.dataStart + position]);
                }
            }

            pos = h.dataEnd;
        }

        if (firstCluster < 0) return undefined;
        /** Whether whole, sized segment children run from `pos` exactly to the end of the input. */
        const reachesEnd = async (pos: number, from: WindowReader): Promise<boolean> => {
            for (let count = 0; pos < size; count++) {
                if (count >= 65536) return false;
                const h = await header(pos, from);
                if (h.unknown || h.dataEnd > size || !SEGMENT_CHILD_IDS.has(h.id)) return false;
                pos = h.dataEnd;
            }
            return pos === size;
        };

        const prefix = concatBytes([
            await input.read(0, segmentStart),
            UNKNOWN_SEGMENT,
            await input.read(segment.dataStart, firstCluster - segment.dataStart),
        ]);

        const seconds = (ticks: number): number => (ticks * timestampScaleNs) / 1e9;
        /**
         * Clusters by position with their times in seconds, from the Cues or a walk; earliest time
         * per position.
         */
        let clusters: { readonly position: number; readonly time: number }[] | undefined;
        const cuesAt = seeks.get(CUES)?.[0];
        if (cuesAt !== undefined && cuesAt < size) {
            const h = await header(cuesAt);
            if (
                h.id === CUES &&
                !h.unknown &&
                h.dataEnd <= size &&
                h.dataEnd - h.dataStart <= PROBE_MAX_CUES
            ) {
                const buf = await input.read(h.dataStart, h.dataEnd - h.dataStart);
                const times = new Map<number, number>();
                for (const point of elements(buf, 0, buf.length)) {
                    if (point.id !== 0xbb) continue;
                    let time = 0;
                    const positions: number[] = [];
                    for (const field of elements(buf, point.dataStart, point.dataEnd))
                        if (field.id === 0xb3)
                            time = readUint(buf, field.dataStart, field.dataEnd, 0);
                        else if (field.id === 0xb7)
                            for (const value of elements(buf, field.dataStart, field.dataEnd))
                                if (value.id === 0xf1)
                                    positions.push(
                                        segment.dataStart +
                                            readUint(buf, value.dataStart, value.dataEnd, 0),
                                    );

                    for (const position of positions)
                        times.set(
                            position,
                            Math.min(times.get(position) ?? Infinity, seconds(time)),
                        );
                }

                clusters = [...times]
                    .map(([position, time]) => ({ position, time }))
                    .sort((a, b) => a.position - b.position);
            }
        }
        /** The clusters placed with a time, as the windows search them, made once for each list. */
        const placesOf = (of: TimedPlace[]): { of: TimedPlace[]; search: PlaceSearch } => ({
            of,
            search: new PlaceSearch(of.filter(cluster => Number.isFinite(cluster.time))),
        });
        let placed: ReturnType<typeof placesOf> | undefined;

        /**
         * The elements before the first cluster and its header, which the windows after them read;
         * up to a megabyte stays held for the next window.
         */
        let heads: WindowReader | undefined;
        const run = async (
            source: Source,
            head: boolean,
            from = 0,
            runSignal = signal,
            timings?: ReorderTimings,
        ): Promise<DemuxResult | undefined> => {
            const demuxer = new WebMDemuxer(this.limits);
            demuxer.isWorker = true;
            demuxer.probeHead = head;
            demuxer.probeFrom = from;
            if (from > firstCluster + HEADER_PEEK)
                demuxer.windowHead = heads ??= new WindowReader(
                    firstCluster + HEADER_PEEK,
                    read,
                    Math.min(firstCluster + HEADER_PEEK, CHUNK_BYTES),
                );
            demuxer.timings = timings;
            if (usesCompactSampleIndex(this)) enableCompactSampleIndex(demuxer);
            const context = diagnostics.fresh();
            const result = await demuxer.demux(source, runSignal, context);
            return context.warnings.length ? undefined : result;
        };

        let head: DemuxResult | undefined;
        // A window alone (ProbeTarget.windowOnly), placed by the Cues, needs no tail, and a head
        // that holds the first samples of each track, from 64 KiB up to the 32 MiB of others.
        const untailed =
            target.windowOnly === true &&
            target.around !== undefined &&
            !target.range &&
            !target.stream &&
            !!clusters;
        let headEnd = firstCluster;
        for (
            let bytes = untailed ? 64 * 1024 : PROBE_WINDOWS.first;
            !head && bytes <= PROBE_WINDOWS.last;
            bytes = nextWindow(bytes)
        ) {
            // The window's clusters are walked in one read, of its bytes or of the cluster it
            // starts with when that is longer (up to probeSpanBytes()). The first window's read
            // starts at the input's start: its demux reads it.
            const first = headEnd === firstCluster;
            const start = first ? 0 : headEnd;
            const nextEnd = first
                ? firstClusterEnd
                : headEnd < size
                  ? (await header(headEnd)).dataEnd
                  : headEnd;

            const span =
                Math.max(
                    firstCluster + bytes,
                    Math.min(nextEnd, start + probeSpanBytes()),
                    start + 1,
                ) - start;

            const walk = new WindowReader(size, readSpan, Math.max(span, HEADER_PEEK));
            if (first) await walk.bytes(0, HEADER_PEEK);
            while (headEnd < size && headEnd - firstCluster < bytes) {
                const h = await header(headEnd, walk);
                if (h.id !== ID.Cluster || h.unknown || h.dataEnd > size) return undefined;
                headEnd = h.dataEnd;
            }

            if (headEnd > size / 2) return undefined;
            head = await run(
                first
                    ? spanSource(walk, 0, Math.max(span, HEADER_PEEK), headEnd)
                    : new RangeSource(direct, 0, headEnd),
                true,
            );
        }

        if (!head) return undefined;

        // Without a SeekHead, metadata could sit between any clusters: the elements after the head
        // are walked, which also places the clusters of the tail and their times.
        const walk = async (): Promise<{ position: number; time: number }[] | undefined> => {
            const walked: { position: number; time: number }[] = [];
            const metadata: number[] = [];
            for (let pos = headEnd; pos < size;) {
                if (walked.length >= 1 << 20) return undefined;
                const h = await header(pos);
                if (h.unknown || h.dataEnd > size || !SEGMENT_CHILD_IDS.has(h.id)) return undefined;
                if (h.id === ID.Cluster) {
                    const child = await header(h.dataStart);
                    const time =
                        child.id === ID.ClusterTimestamp && child.dataEnd - child.dataStart <= 8
                            ? readUint(
                                  await reader.bytes(
                                      child.dataStart,
                                      child.dataEnd - child.dataStart,
                                  ),
                                  0,
                                  child.dataEnd - child.dataStart,
                                  0,
                              )
                            : NaN;
                    walked.push({ position: pos, time: seconds(time) });
                } else if (h.id === ID.Tags || h.id === ID.Chapters || h.id === ID.Attachments)
                    metadata.push(pos);

                pos = h.dataEnd;
            }

            if (!seeks.size) seeks.set(ID.Tags, metadata);
            return walked;
        };

        if (!seeks.size) {
            clusters = await walk();
            if (!clusters) return undefined;
        }

        if (!untailed) {
            let tail: DemuxResult | undefined;
            // The tail starts at the last cluster the Cues or the walk place, at most 2 MiB from
            // the end: it holds the end of every track it has a block of. Where a track ends
            // before it, the tail starts a cluster before each fourfold distance from the end, the
            // last 32 MiB as when the tail started 2 MiB from the end. (A last cluster in the head
            // is more than 2 MiB from the end: the head ends by the middle.)
            for (
                let bytes = Math.min(PROBE_WINDOWS.first, size - (clusters?.at(-1)?.position ?? 0));
                !tail && bytes <= PROBE_WINDOWS.last;
                bytes = nextWindow(bytes)
            ) {
                const target = size - bytes;
                const placed = clusters
                    ?.map(cluster => cluster.position)
                    .filter(position => position >= headEnd && position <= target)
                    .slice(-1);

                // The tail is found, walked and demuxed from one read from where it may start to
                // the end, unless that is longer than probeSpanBytes(): then its element headers
                // are read one by one.
                const from = placed ? (placed[0] ?? size) : Math.max(headEnd, target);
                const reach = Math.max(HEADER_PEEK, size - from);
                const walk =
                    reach <= probeSpanBytes() ? new WindowReader(size, readSpan, reach) : reader;
                const candidates = placed ?? (await clusterIds(walk, from, size));
                let tailStart = -1;
                for (const candidate of candidates)
                    if (
                        (await header(candidate, walk)).id === ID.Cluster &&
                        (await reachesEnd(candidate, walk))
                    ) {
                        tailStart = candidate;
                        break;
                    }

                if (tailStart < 0) continue;
                throwIfAborted(signal);

                // Metadata the SeekHead places between the head and the tail would be missed.
                for (const id of [ID.Tags, ID.Chapters, ID.Attachments])
                    if (
                        (seeks.get(id) ?? []).some(
                            position => position >= firstCluster && position < tailStart,
                        )
                    )
                        return undefined;

                tail = await run(
                    new ConcatSource([
                        new BufferSource(prefix, { copy: false }),
                        spanSource(walk, tailStart, from + reach, size),
                    ]),
                    false,
                );
                const ends = new Map(tail ? tracksOf(tail).map(track => [track.id, track]) : []);
                if (!tracksOf(head).every(track => ends.get(track.id)?.codec === track.codec))
                    tail = undefined;
            }

            if (!tail) return undefined;
            const ends = new Map(tracksOf(tail).map(track => [track.id, track]));
            for (const track of tracksOf(head)) {
                const last = ends.get(track.id)!;
                track.duration = last.duration;
                track.title = last.title;
            }

            head.title = tail.title;
            head.tags = tail.tags;
            head.matroskaPassThrough = tail.matroskaPassThrough;
            head.matroskaUnsupportedTags = tail.matroskaUnsupportedTags;
        }
        const start = Math.min(
            ...tracksOf(head).map(track => sampleAt(track, 0)?.timestamp ?? Infinity),
        );
        const described = head;
        const streamed = (): ProbedInput => ({
            result: described,
            packets: false,
            start,
            stream: (streamSignal, warn) =>
                this.streamClusters(
                    input,
                    described,
                    firstCluster,
                    diagnostics,
                    streamSignal,
                    warn,
                ),
        });

        /** The input up to `to`, for a demux from the cluster at `from` on (run()). */
        const windowSource = (to: number): Source => new RangeSource(input, 0, to);

        // A window that times its video as a read of the whole input does times it by the first
        // pictures of each track (ReorderClock): those of the head, and where it holds fewer, of
        // the clusters after it, read once.
        /** Whether the timings take pictures past the head. */
        let pastHead = false;
        /** The timings once read; undefined in it where the clusters after the head did not say. */
        let decided: { readonly timings?: ReorderTimings } | undefined;
        const decide = async (windowSignal?: AbortSignal): Promise<ReorderTimings | undefined> => {
            if (decided) return decided.timings;
            const pictures = new Map<number, number[]>();
            let read = addPictures(pictures, described.videoTracks);
            for (let from = headEnd; read < REORDER_DECIDING;) {
                // The clusters that hold the pictures missing at the rate of those read so far,
                // and an eighth more.
                pastHead = true;
                clusters ??= await walk();
                const reach =
                    from +
                    ((from - firstCluster) * 1.125 * (REORDER_DECIDING - read)) / Math.max(1, read);
                const to =
                    clusters?.find(cluster => cluster.position > from && cluster.position >= reach)
                        ?.position ?? size;
                const result =
                    to <= size / 2 && to - firstCluster <= 4 * PROBE_WINDOWS.last
                        ? await run(windowSource(to), true, from, windowSignal)
                        : undefined;
                if (!result) {
                    decided = {};
                    return undefined;
                }
                read = addPictures(pictures, result.videoTracks);
                from = to;
            }
            decided = {
                timings: new Map([...pictures].map(([id, times]) => [id, reorderTiming(times)])),
            };
            return decided.timings;
        };

        // The head's result becomes the tracks of one file: a later window in the head demuxes
        // it again, as does one timed by pictures the head does not hold.
        let headTaken = false;
        const headResult = async (
            timings: ReorderTimings | undefined,
            windowSignal?: AbortSignal,
        ): Promise<DemuxResult | undefined> => {
            if (!headTaken && !pastHead) {
                headTaken = true;
                return described;
            }
            return run(new RangeSource(direct, 0, headEnd), true, 0, windowSignal, timings);
        };

        /** The probe of `next` from the head, the tail and the clusters read so far. */
        const probeOf = async (
            next: ProbeTarget,
            windowSignal = signal,
        ): Promise<ProbedInput | undefined> => {
            const { around, through = around, range, stream } = next;
            if (stream && around === undefined) return streamed();
            if (around === undefined && range === undefined) {
                headTaken = true;
                return {
                    result: described,
                    packets: false,
                    start,
                    window: probeOf,
                };
            }

            // The samples of a span decode from the clusters between a cluster before the keyframe
            // preceding its start and one after its end: from the Cues or the walk, windows growing
            // fourfold until the first track holds both (and, for a copy, every audio track a
            // packet before that keyframe, where a copy of the whole input starts it).
            const span = range
                ? { start: start + range.start, end: start + (range.end ?? Infinity) }
                : { start: Math.max(0, start) + around!, end: Math.max(0, start) + through! };
            const windows = spanWindows(described, span);
            const timings = windows && next.timed ? await decide(windowSignal) : undefined;
            if (!windows || (next.timed && !timings)) return stream ? streamed() : undefined;
            const { covers } = windows;
            let window = windows.inHead ? await headResult(timings, windowSignal) : undefined;
            let starts = true;
            let end = headEnd;
            clusters ??= window ? undefined : await walk();
            const timed =
                clusters && (placed?.of === clusters ? placed : (placed = placesOf(clusters)));

            // A conversion decodes from the input's start: its window starts there. Pictures that
            // could be streamed are, when their window would start there too.
            // A window around a time starts at the cluster that holds it and ends with one shown
            // over a second after it (windowCovers); a copy's starts seconds before its range.
            const fromStart = range?.fromStart === true;
            for (
                let reach = range ? 2 : 0.25;
                !window && timed?.search.length && reach <= 128;
                reach *= 4
            ) {
                const from = fromStart
                    ? firstCluster
                    : (timed.search.lastAtOrBefore(span.start - reach)?.position ?? firstCluster);
                if (stream && from === firstCluster) return streamed();
                const to =
                    timed.search.firstAfter(from, span.end + Math.max(reach, 1))?.position ?? size;
                const result = await run(windowSource(to), to < size, from, windowSignal, timings);
                const track = result && (result.videoTracks[0] ?? result.audioTracks[0]);
                if (
                    track &&
                    covers(track, from === firstCluster, to === size) &&
                    (!range || from === firstCluster || holdsAudioBefore(result, track, span.start))
                ) {
                    window = result;
                    starts = from === firstCluster;
                    end = to;
                }
            }

            if (!window) return stream ? streamed() : undefined;
            // A window describes the input as an index does: with the durations and the metadata
            // the probe read from its tail.
            const wholeTracks = new Map(tracksOf(described).map(track => [track.id, track]));
            for (const track of tracksOf(window)) {
                const whole = wholeTracks.get(track.id);
                track.duration = whole?.duration ?? track.duration;
                track.title = whole ? whole.title : track.title;
            }
            window.title = described.title;
            window.tags = described.tags;
            window.matroskaPassThrough = described.matroskaPassThrough;
            window.matroskaUnsupportedTags = described.matroskaUnsupportedTags;
            return { result: window, packets: true, start, fromStart: starts, end };
        };
        return probeOf(target);
    }

    /**
     * Every sample of the input in one pass, cluster by cluster from the first: each window of
     * whole clusters is read once and demuxed, and its samples are handed on in file order with
     * their bytes, timed across windows as a read of the whole file times them. A sample names the
     * position of its track in `head`, the probe's tracks.
     */
    private async *streamClusters(
        input: Source,
        head: DemuxResult,
        firstCluster: number,
        diagnostics: DiagnosticContext,
        signal?: AbortSignal,
        warn?: Warn,
    ): AsyncGenerator<readonly StreamedSample[]> {
        const program = tracksOf(head);
        /** The batch the tracks' timing adds timed samples to. */
        const timed: { batch: StreamedSample[] } = { batch: [] };

        // Each track is timed by the rules a read of the whole file uses, whatever its windows
        // hold: video by its reorder clock (ReorderClock), sound stored after a later sound by the
        // latest time before it, and samples stored without a duration by the samples after them
        // (DurationFiller).
        const fillers = program.map(
            () =>
                new DurationFiller<StreamedSample>(
                    item => item.sample.timestamp,
                    item => item.sample.duration,
                    (item, timestamp, duration) => {
                        const sample = item.sample as Sample;
                        sample.decodeTimestamp! += timestamp - sample.timestamp;
                        sample.timestamp = timestamp;
                        sample.duration = duration;
                    },
                    item => timed.batch.push(item),
                ),
        );
        const clocks = program.map((track, position) =>
            track.width
                ? new ReorderClock<StreamedSample>(
                      item => item.sample.timestamp,
                      (item, decode, duration) => {
                          const sample = item.sample as Sample;
                          sample.decodeTimestamp = decode;
                          sample.compositionTimeOffset = sample.timestamp - decode;
                          if (duration !== undefined) sample.duration = duration;
                      },
                      item => fillers[position]!.push(item),
                  )
                : undefined,
        );
        const latest = program.map(track =>
            head.audioTracks.includes(track) ? Number.NEGATIVE_INFINITY : undefined,
        );
        const timing: StreamTiming = {
            push: item => {
                const { track, sample } = item;
                const clock = clocks[track];
                if (clock) return clock.push(item);
                const before = latest[track];
                if (before !== undefined) {
                    latest[track] = Math.max(before, sample.timestamp);
                    if (sample.timestamp < before) {
                        (sample as Sample).decodeTimestamp = before;
                        (sample as Sample).compositionTimeOffset = sample.timestamp - before;
                    }
                }
                fillers[track]!.push(item);
            },
            flush: () => {
                for (const clock of clocks) clock?.flush();
                for (const filler of fillers) filler.flush();
            },
            held: () => [
                ...clocks.flatMap(clock => clock?.held() ?? []),
                ...fillers.flatMap(filler => filler.held()),
            ],
        };

        const windows = new ForwardWindows(input, firstCluster + HEADER_PEEK, WINDOW_BYTES);
        /**
         * Pictures a clock holds past their window keep its chunks with a hold until a batch
         * delivers them.
         */
        const carried = new Set<StreamedSample>();
        const release = (item: StreamedSample): void => {
            releaseBytes(item.sample.data);
            if (item.alphaData) releaseBytes(item.alphaData);
        };
        try {
            yield* this.streamClusterWindows(
                input,
                program,
                timing,
                timed,
                windows,
                carried,
                release,
                {
                    firstCluster,
                    diagnostics,
                    signal,
                    warn,
                },
            );
        } finally {
            for (const item of carried) release(item);
            windows.close();
        }
    }

    /** The windows of streamClusters, from the first cluster to the end of the input. */
    private async *streamClusterWindows(
        input: Source,
        program: readonly TrackInfo[],
        timing: StreamTiming,
        timed: { batch: StreamedSample[] },
        windows: ForwardWindows,
        carried: Set<StreamedSample>,
        release: (item: StreamedSample) => void,
        options: {
            readonly firstCluster: number;
            readonly diagnostics: DiagnosticContext;
            readonly signal?: AbortSignal;
            readonly warn?: Warn;
        },
    ): AsyncGenerator<readonly StreamedSample[]> {
        const { firstCluster, diagnostics, signal, warn } = options;
        const size = input.size;
        const warned = new Set<string>();
        const lace = laceScratch();
        const carriedVorbis = new Map<number, number>();
        let from = firstCluster;
        let span = WINDOW_BYTES;
        for (;;) {
            throwIfAborted(signal);
            const readEnd = Math.min(size, from + span);
            const window = await windows.window(from, readEnd, size);

            // The whole clusters of the bytes read; the window is the last once anything else
            // follows them.
            const header = newHeader();
            let to = from;
            let final = readEnd === size;
            while (to < readEnd) {
                if (to + HEADER_PEEK > readEnd && readEnd < size) break;
                const peek =
                    windows.view(to, Math.min(HEADER_PEEK, readEnd - to)) ??
                    (await window.read(to, HEADER_PEEK));
                const h = readHeaderLocal(peek, 0, Number.MAX_SAFE_INTEGER, peek.length, header);
                if (h.id !== ID.Cluster) {
                    final = true;
                    break;
                }

                demuxAssert(
                    !h.unknown,
                    'A Matroska cluster of unknown size cannot be read in windows',
                );
                if (to + h.dataEnd > readEnd) break;
                to += h.dataEnd;
            }

            if (to === from && !final) {
                span *= 2;
                if (!(span <= MAX_WINDOW_BYTES))
                    malformedInput(
                        `Matroska cluster at byte ${from} exceeds ${MAX_WINDOW_BYTES} bytes`,
                    );
                continue;
            }

            const source = final ? window : new RangeSource(window, 0, to);
            const demuxer = new WebMDemuxer(this.limits);
            demuxer.isWorker = true;
            demuxer.probeHead = !final;
            demuxer.probeFrom = from;
            demuxer.samplesOnly = true;
            demuxer.carriedVorbis = carriedVorbis;
            demuxer.lace = lace;
            enableCompactSampleIndex(demuxer);
            const context = diagnostics.fresh();
            const result = await demuxer.demux(source, signal, context);
            for (const warning of context.warnings)
                if (!warned.has(warning.code)) {
                    warned.add(warning.code);
                    warn?.(warning);
                }

            // One item per sample, in file order; `tracks` holds the window's track at each program
            // position.
            const items: {
                track: number;
                sample: Sample;
                codecConfig?: Uint8Array;
                alphaData?: Uint8Array;
            }[] = [];

            const tracks: TrackInfo[] = [];
            for (const track of tracksOf(result)) {
                const position = program.findIndex(item => item.id === track.id);
                if (position < 0) continue;
                tracks[position] = track;
                const codecConfig = track.codecConfig;
                for (let index = 0, count = sampleCount(track); index < count; index++)
                    items.push({ track: position, sample: sampleAt(track, index)!, codecConfig });
            }

            items.sort((a, b) => a.sample.offset - b.sample.offset);
            const batch: StreamedSample[] = (timed.batch = []);
            for (const item of items) {
                const sample = item.sample;
                sample.data ??=
                    windows.view(sample.offset, sample.size) ??
                    (await readSampleBytes(tracks[item.track]!, sample, source, signal));
                if (sample.alphaOffset !== undefined)
                    item.alphaData =
                        windows.view(sample.alphaOffset, sample.alphaSize!) ??
                        (await source.read(sample.alphaOffset, sample.alphaSize!));

                timing.push(item as StreamedSample);
            }

            for (const track of tracksOf(result)) releaseSampleIndex(track);
            if (final) timing.flush();
            for (const item of timing.held())
                if (!carried.has(item)) {
                    carried.add(item);
                    holdBytes(item.sample.data);
                    if (item.alphaData) holdBytes(item.alphaData);
                }

            yield batch;
            for (const item of batch) if (carried.delete(item)) release(item);
            if (final) return;
            from = to;
            span = WINDOW_BYTES;
        }
    }

    private async headerAt(pos: number, fileEnd: number): Promise<ParsedHeader> {
        const peek = await this.reader.bytes(pos, HEADER_PEEK);
        const h = readHeaderLocal(peek, 0, Number.MAX_SAFE_INTEGER, peek.length, newHeader());
        const dataStart = pos + h.headerLen;
        let dataEnd = h.unknown ? fileEnd : dataStart + (h.dataEnd - h.dataStart);
        if (dataEnd > fileEnd && this.probeHead && h.id === ID.Segment) dataEnd = fileEnd;
        if (dataEnd > fileEnd) {
            // A Segment or Cluster cut by truncation still holds complete blocks up to the end of
            // the input.
            const exceeds = `EBML element 0x${h.id.toString(16)} exceeds the file`;
            demuxAssert(h.id === ID.Segment || h.id === ID.Cluster || h.id === ID.EBML, exceeds);
            recoverDamage(
                this.diagnostics,
                'MATROSKA_TRUNCATED',
                `EBML element at byte ${pos} is cut by the end of the input`,
                pos,
                exceeds,
            );
            dataEnd = fileEnd;
        }

        return { id: h.id, dataStart, dataEnd, unknown: h.unknown, headerLen: h.headerLen };
    }

    private async walk(): Promise<DemuxResult> {
        this.indexBudget = new DemuxIndexBudget(this.limits);
        this.metadataDropped = false;
        this.frameCompression = false;
        this.skippedUntilKeyframe = 0;
        this.inputUidCounts.clear();
        const fileEnd = this.reader.size;
        let pos = 0;
        let sawEbml = false;
        let segment: ParsedHeader | null = null;
        while (pos < fileEnd) {
            const h = await this.headerAt(pos, fileEnd);
            if (h.id === ID.EBML) {
                sawEbml = true;

                // A damaged EBML header size runs past the file; the Segment that follows its
                // fields is searched.
                if (h.dataEnd === fileEnd && !h.unknown)
                    pos = await (
                        await recovery()
                    ).segmentAfterDamagedHeader(this.context, h.dataStart, fileEnd);
                else pos = h.dataEnd;
                continue;
            }
            if (h.id === ID.Segment) {
                segment = h;
                break;
            }
            demuxAssert(sawEbml, 'not an EBML/Matroska stream');
            pos = h.dataEnd;
        }
        demuxAssert(!!segment, 'no Matroska Segment found');
        let segEnd = segment.unknown ? fileEnd : segment.dataEnd;

        let timestampScaleNs = 1_000_000;
        const tracks = new Map<number, WebMTrack>();
        let title: string | undefined;
        const metadata: MatroskaMetadata = { tags: [], unsupportedTags: false };
        let metadataBytes = 0;

        pos = segment.dataStart;
        let l1Count = 0;
        let clustersSeen = 0;
        let tracksSeen = false;
        /**
         * Clusters before any Tracks element: their blocks are indexed once the tracks are known.
         */
        const earlyClusters: ParsedHeader[] = [];
        /**
         * Start of the element just skipped when its ID is no segment child: a stray byte before a
         * top-level element reads as such an element and swallows that element's header. Damage
         * found after it resynchronises from its start, as FFmpeg resynchronises from the element
         * it failed in.
         */
        let strayStart: number | undefined;
        while (pos < segEnd) {
            demuxAssert(
                ++l1Count <= DEMUX_LIMITS.maxTableEntries,
                'EBML element count exceeds limit',
            );
            throwIfAborted(this.signal);
            let h: ParsedHeader;
            const stray = strayStart;
            strayStart = undefined;
            try {
                h = await this.headerAt(pos, segEnd);
            } catch (error) {
                const { resumeAfterHeader } = await recovery();
                ({ pos, segEnd } = await resumeAfterHeader(
                    this.context,
                    error,
                    { pos, stray, clustersSeen },
                    segEnd,
                    fileEnd,
                ));
                continue;
            }
            if (segment.unknown && !SEGMENT_CHILD_IDS.has(h.id)) break;
            if (h.id === ID.Info) {
                const buf = await this.reader.bytes(h.dataStart, h.dataEnd - h.dataStart);
                for (const inf of elements(buf, 0, buf.length)) {
                    if (inf.id === ID.TimestampScale) {
                        timestampScaleNs = uintOf(buf, inf, 1_000_000);
                        demuxAssert(
                            timestampScaleNs > 0,
                            'Matroska TimestampScale must be positive',
                        );
                    } else if (inf.id === ID.Title) {
                        try {
                            title = utf8Of(buf, inf);
                        } catch (error) {
                            this.optionalMetadataError(error);
                        }
                    }
                }
                pos = h.dataEnd;
            } else if (h.id === ID.Tracks) {
                const buf = await this.reader.bytes(h.dataStart, h.dataEnd - h.dataStart);
                await this.parseTracks(buf, tracks);
                pos = h.dataEnd;
                tracksSeen = true;
                for (const early of earlyClusters.splice(0))
                    await this.parseClusterAt(early, segEnd, tracks, timestampScaleNs);
            } else if (
                h.id === SEEK_HEAD &&
                !this.samplesOnly &&
                this.probeFrom === 0 &&
                this.materialize &&
                !h.unknown &&
                h.dataEnd - h.dataStart <= 64 * 1024
            ) {
                // The metadata reader starts loading when the SeekHead names Tags, Chapters or
                // Attachments.
                const buf = await this.reader.bytes(h.dataStart, h.dataEnd - h.dataStart);
                if (seeksMetadata(buf)) metadataParts().catch(() => undefined);
                pos = h.dataEnd;
            } else if (
                (this.samplesOnly || this.probeFrom > 0) &&
                (h.id === ID.Chapters || h.id === ID.Attachments || h.id === ID.Tags)
            ) {
                pos = h.dataEnd;
            } else if (h.id === ID.Chapters || h.id === ID.Attachments || h.id === ID.Tags) {
                demuxAssert(!h.unknown, 'unknown-size Matroska metadata is not supported');
                metadataBytes += h.dataEnd - pos;
                if (metadataBytes > MAX_METADATA_BYTES) {
                    this.metadataDropped = true;
                    this.warnMetadataLoss(
                        'Matroska metadata exceeds the byte limit and was omitted',
                    );
                } else if (this.materialize) {
                    const bytes = new Uint8Array(await this.reader.bytes(pos, h.dataEnd - pos));
                    (await metadataParts()).readMetadataElement(
                        h.id,
                        bytes,
                        metadata,
                        message => this.warnMetadataLoss(message),
                        error => this.optionalMetadataError(error),
                    );
                }
                pos = h.dataEnd;
            } else if (h.id === ID.Cluster && pos < this.probeFrom) {
                pos = this.probeFrom;
            } else if (h.id === ID.Cluster) {
                clustersSeen++;
                if (!tracksSeen && readsPastDamage(this.diagnostics)) earlyClusters.push(h);
                try {
                    pos = await this.parseClusterAt(h, segEnd, tracks, timestampScaleNs);
                } catch (error) {
                    // Damage inside a sized cluster: resume at the next block whose header names a
                    // known track and fits the cluster; otherwise fall back to the next cluster.
                    const { resumeInCluster } = await recovery();
                    const clusterTs = this.lastClusterTimestamp;
                    pos = await resumeInCluster(
                        this.context,
                        error,
                        { h, failedAt: this.clusterFailurePosition, clusterTs },
                        tracks,
                        segEnd,
                        timestampScaleNs,
                        block =>
                            this.parseClusterAt(
                                { ...h, dataStart: block, headerLen: 0, id: ID.Cluster },
                                segEnd,
                                tracks,
                                timestampScaleNs,
                                clusterTs,
                            ),
                        () => this.clusterFailurePosition,
                    );
                }
            } else {
                if (h.unknown)
                    malformedInput(
                        `unknown-size EBML element 0x${h.id.toString(16)} is not supported`,
                    );
                if (!SEGMENT_CHILD_IDS.has(h.id)) strayStart = pos;
                pos = h.dataEnd;
            }
        }

        if (tracks.size === 0 && this.skippedTracks.size)
            throw new DemuxError([...this.skippedTracks][0]!);
        if (this.skippedUntilKeyframe && this.materialize)
            recoverDamage(
                this.diagnostics,
                'MATROSKA_VIDEO_KEYFRAME_WAIT',
                `Skipped ${this.skippedUntilKeyframe} video frames after damage until the next ` +
                    `keyframe`,
                0,
            );
        demuxAssert(tracks.size > 0, 'no decodable tracks');
        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        // A positive DiscardPadding before the final block (or in a window that ends before the
        // input does) trims that block alone, as FFmpeg reads files joined by its concat demuxer.
        for (const t of tracks.values())
            if (
                t.type === 2 &&
                t.positiveDiscardSeen &&
                (this.probeHead || t.positiveDiscardBlockIndex !== t.audioBlockCount - 1)
            )
                this.trimJoinedBlock(t);
        if (!this.materialize) return result;
        for (const t of tracks.values()) {
            if (t.vorbis) this.carriedVorbis?.set(t.number, t.vorbis.previous);
            if (t.uid !== undefined && this.inputUidCounts.get(t.uid) !== 1) {
                t.uid = undefined;
                this.metadataDropped = true;
                this.warnMetadataLoss('Ambiguous duplicate Matroska TrackUID was omitted');
            }
            if (t.index.length === 0) {
                // A window of a stream holds the blocks of some of its tracks: the others are not
                // empty, and the stream keeps them.
                if (this.samplesOnly) continue;
                const others = [...tracks.values()].some(
                    other => other !== t && other.index.length > 0,
                );
                const empty = `Matroska '${t.codec}' track declares no blocks`;
                demuxAssert(others, empty);
                recoverDamage(
                    this.diagnostics,
                    'MATROSKA_EMPTY_TRACK',
                    `Matroska '${t.codec}' track ${t.number} declares no blocks; the track is ` +
                        `omitted`,
                    0,
                    empty,
                );
                continue;
            }
            // A stream's windows leave timing to the stream, which sees the samples before them.
            if (!(await this.presentCodecTiming(t)) && !this.samplesOnly) {
                if (t.type === 1) t.index.reconstructVideoDecodeTimes(this.timings?.get(t.number));
                else if (t.type === 2) t.index.keepStorageOrder();
                t.index.fillDurations();
            }
            const index = t.index.finish();
            const last = index.length - 1;

            // Reordered video, or blocks read past damage, need not end last on the presentation
            // timeline.
            let trackEnd = -Infinity;
            let trackStart = Infinity;
            for (let position = 0; position <= last; position++) {
                trackEnd = Math.max(
                    trackEnd,
                    index.timestampAt(position) + index.durationAt(position),
                );
                trackStart = Math.min(trackStart, index.timestampAt(position));
            }

            // Blocks timed wholly before the segment start (negative block times) still last their
            // span.
            trackEnd = trackEnd > 0 ? trackEnd : Math.max(0, trackEnd - trackStart);

            // Sound lasts what it presents: the leading discard and the final block's padding are
            // not heard.
            if (t.type === 2)
                trackEnd = Math.max(
                    0,
                    trackEnd - (t.leadingDiscardPadNs + t.trailingDiscardPadNs) / 1e9,
                );
            const info: TrackInfo = {
                id: t.number,
                ...((this.diagnostics?.recoveries ?? 0) > this.recoveriesBefore
                    ? { incomplete: true }
                    : {}),
                matroskaTrackUid: t.uid,
                language: t.languageIetf ?? t.language,
                colour: t.colour,
                ...(t.fieldOrder ? { fieldOrder: t.fieldOrder } : {}),
                default: t.default,
                forced: t.forced,
                name: t.name,
                commentary: t.commentary,
                ...(t.dispositions ? { dispositions: t.dispositions } : {}),
                alphaMode: t.alphaMode,
                codec: t.codec,
                ...(t.codecTag ? { codecTag: t.codecTag } : {}),
                codecConfig: t.codecConfig,
                ...(t.dolbyVisionConfig ? { dolbyVisionConfig: t.dolbyVisionConfig } : {}),
                timescale: 1000,
                timestampResolutionSeconds: (timestampScaleNs * t.timestampScale) / 1e9,
                duration: trackEnd,
                width: t.width,
                height: t.height,
                displayWidth: t.displayWidth,
                displayHeight: t.displayHeight,
                pixelAspectRatioNum: t.pixelAspectRatioNum,
                pixelAspectRatioDen: t.pixelAspectRatioDen,
                ...(t.type === 1 && t.rotation ? { rotation: t.rotation } : {}),
                sampleRate: t.sampleRate || (t.type === 2 ? 8000 : 0),
                channelCount: t.ac3FrameChannels ?? t.channelCount,
                samples: this.compact
                    ? []
                    : Array.from({ length: index.length }, (_, position) => index.get(position)),
                ...(t.codec === 'opus' && t.trailingDiscardPadNs > 0
                    ? {
                          opusTrailingPaddingSamples: Math.round(
                              (t.trailingDiscardPadNs * 48000) / 1e9,
                          ),
                      }
                    : {}),
                ...(t.type === 2 &&
                t.codec !== 'opus' &&
                t.trailingDiscardPadNs > 0 &&
                t.sampleRate > 0
                    ? {
                          audioTrailingPaddingSamples: Math.round(
                              (t.trailingDiscardPadNs * t.sampleRate) / 1e9,
                          ),
                      }
                    : {}),
                ...(t.type === 2 && t.codecDelayNs > 0
                    ? { matroskaCodecDelaySeconds: t.codecDelayNs / 1e9 }
                    : {}),
                ...(t.type === 2 && t.leadingDiscardPadNs > 0
                    ? {
                          editMediaTimeSeconds: t.leadingDiscardPadNs / 1e9,
                      }
                    : {}),
            };
            if (this.compact) {
                bindCompactSampleIndex(
                    info,
                    index,
                    sampleArrayReserve(this.indexBudget, index.length),
                );
            }
            if (t.type === 1) result.videoTracks.push(info);
            else if (t.type === 2) result.audioTracks.push(info);
            else {
                result.subtitleTracks ??= [];
                result.subtitleTracks.push(info);
            }
        }
        if (
            metadata.tags.length ||
            metadata.chapters ||
            metadata.attachments ||
            title !== undefined
        )
            (await metadataParts()).settleMetadata(result, metadata, title);
        else
            for (const track of [
                ...result.videoTracks,
                ...result.audioTracks,
                ...(result.subtitleTracks ?? []),
            ])
                if (track.matroskaTrackUid !== undefined) track.title = undefined;
        if (metadata.unsupportedTags || this.metadataDropped) result.matroskaUnsupportedTags = true;
        throwIfAborted(this.signal);
        return result;
    }

    /**
     * Presentation times and frames a codec's blocks need settled once all are read: MPEG audio cut
     * at byte counts, VfW H.264 and Windows Media video in decode order, DivX packed MPEG-4. False
     * for other tracks.
     */
    private async presentCodecTiming(t: WebMTrack): Promise<boolean> {
        const unaligned = (t.mpegUnaligned ?? 0) * 4 > t.index.length;
        const mpeg4 = mpegVideoFamily(t.codec) === 'mpeg4v';
        if (!unaligned && !t.vfwAvc && !mpeg4 && !t.vfwWindowsMedia) return false;
        const parts = await codecParts();
        if (unaligned) await parts.reframeMpegAudio(this.context, t);
        if (t.vfwAvc) await parts.presentVfwAvc(this.context, t);
        else if (mpeg4 && (await parts.packedMpeg4(this.context, t)))
            await parts.unpackMpeg4(this.context, t);
        else return !!t.vfwWindowsMedia && (await parts.presentVfwWindowsMedia(this.context, t));
        return true;
    }

    private optionalMetadataError(error: unknown): void {
        if (!(error instanceof DemuxError)) throw error;
        this.metadataDropped = true;
        this.warnMetadataLoss(`Optional Matroska metadata was omitted: ${error.message}`);
    }

    private warnProjectionIgnored(): void {
        try {
            this.diagnostics?.metadata({
                code: 'MATROSKA_PROJECTION_IGNORED',
                message: 'Ignored a mirrored, 3D or non-right-angle projection',
            });
        } catch (error) {
            this.externalFailure = { error };
            throw error;
        }
    }

    private warnMetadataLoss(message: string): void {
        if (this.metadataWarned || !this.diagnostics) return;
        this.metadataWarned = true;
        try {
            this.diagnostics.metadata({ code: 'MATROSKA_METADATA_LOSS', message });
        } catch (error) {
            this.externalFailure = { error };
            throw error;
        }
        throwIfAborted(this.signal);
    }

    private skipTrack(reason: string): void {
        if (!readsPastDamage(this.diagnostics)) throw new DemuxError(reason);
        if (this.skippedTracks.has(reason)) return;
        this.skippedTracks.add(reason);
        this.diagnostics?.warn({
            code: 'MATROSKA_UNSUPPORTED_TRACK',
            format: 'matroska',
            message: `${reason}; the track is omitted`,
        });
    }

    private async parseTracks(buf: Uint8Array, tracks: Map<number, WebMTrack>): Promise<void> {
        for (const te of elements(buf, 0, buf.length)) {
            if (te.id !== ID.TrackEntry) continue;
            const t: WebMTrack = {
                number: 0,
                type: 0,
                codec: '',
                defaultDurationNs: 0,
                default: true,
                forced: false,
                width: 0,
                height: 0,
                sampleRate: 0,
                channelCount: 0,
                index: new MatroskaSampleIndexBuilder(
                    this.reader.size > 0xffffffff,
                    this.reserveIndexBytes,
                ),
                proRes: false,
                aacFrameDuration: 0,
                leadingDiscardPadNs: 0,
                trailingDiscardPadNs: 0,
                codecDelayNs: 0,
                timestampScale: 1,
                audioBlockCount: 0,
                negativeDiscardSeen: false,
                positiveDiscardSeen: false,
                positiveDiscardBlockIndex: -1,
                positiveDiscardFrame: -1,
            };

            let codecIdRaw = '';
            let bitsPerSample = 0;
            let outputSampleRate = 0;
            let colourSpace = '';
            let uidSeen = false;
            let invalidUid = false;
            let encoded = false;
            let compression: ContentCompression | undefined;
            for (const f of elements(buf, te.dataStart, te.dataEnd)) {
                if (f.id === ID.TrackNumber) t.number = uintOf(buf, f);
                else if (f.id === ID.TrackType) t.type = uintOf(buf, f);
                else if (TRACK_IDENTITY_IDS.has(f.id) || DISPOSITION_FLAGS.has(f.id)) {
                    if (this.readTrackIdentity(buf, f, t, uidSeen))
                        uidSeen ||= f.id === ID.TrackUID;
                    else if (f.id === ID.TrackUID) invalidUid = true;
                } else if (f.id === ID.CodecID) codecIdRaw = asciiOf(buf, f);
                else if (f.id === ID.CodecPrivate)
                    t.codecConfig = buf.slice(f.dataStart, f.dataEnd);
                else if (f.id === ID.BlockAdditionMapping) {
                    let type = 0;
                    let extra: Uint8Array | undefined;
                    for (const m of elements(buf, f.dataStart, f.dataEnd)) {
                        if (m.id === ID.BlockAddIDType) type = uintOf(buf, m);
                        else if (m.id === ID.BlockAddIDExtraData)
                            extra = buf.slice(m.dataStart, m.dataEnd);
                    }

                    if ((type === DOLBY_VISION_DVCC || type === DOLBY_VISION_DVVC) && extra?.length)
                        t.dolbyVisionConfig = extra.slice(0, DOLBY_VISION_CONFIG_BYTES);
                } else if (f.id === ID.CodecDelay) t.codecDelayNs = uintOf(buf, f);
                else if (f.id === ID.ContentEncodings) {
                    compression = contentCompression(buf, f);
                    encoded = compression === undefined;
                } else if (f.id === ID.TrackTimestampScale) {
                    t.timestampScale = floatOf(buf, f, 1);
                } else if (f.id === ID.DefaultDuration) t.defaultDurationNs = uintOf(buf, f);
                else if (f.id === ID.Video) colourSpace = this.readVideoSettings(buf, f, t);
                else if (f.id === ID.Audio)
                    ({ bitsPerSample, outputSampleRate } = this.readAudioSettings(buf, f, t));
            }

            if (invalidUid) t.uid = undefined;
            if (t.number <= 0) continue;
            if (encoded) {
                this.skipTrack(
                    `Matroska '${codecIdRaw}' track uses encrypted or unsupported ContentEncoding`,
                );
                continue;
            }

            if (
                compression?.algorithm === COMPRESSION_ZLIB &&
                typeof DecompressionStream !== 'function'
            ) {
                this.skipTrack(
                    `Matroska '${codecIdRaw}' track uses zlib compression, which needs ` +
                        `DecompressionStream`,
                );
                continue;
            }

            if (compression && compression.scope & 2 && t.codecConfig)
                t.codecConfig = await (
                    await compressionParts()
                ).decompress(compression, t.codecConfig, 'Matroska CodecPrivate', this.signal);

            if (!(Number.isFinite(t.timestampScale) && t.timestampScale > 0)) {
                const message = `track ${t.number} has invalid TrackTimestampScale`;
                demuxAssert(readsPastDamage(this.diagnostics), message);
                this.diagnostics?.warn({
                    code: 'MATROSKA_TRACK_TIMESTAMP_SCALE',
                    format: 'matroska',
                    message:
                        `${message} ${t.timestampScale}; block times use the segment ` +
                        `TimestampScale`,
                });
                t.timestampScale = 1;
            }

            if (t.type === 1 || t.type === 2) {
                if (SPECIAL_CODEC_IDS.test(codecIdRaw))
                    codecIdRaw = await this.readSpecialCodec(t, codecIdRaw, {
                        colourSpace,
                        outputSampleRate,
                        bitsPerSample,
                    });
                else
                    t.codec =
                        matroskaPcmCodec(codecIdRaw, bitsPerSample) ?? CODEC_MAP[codecIdRaw] ?? '';

                if (!t.codec) {
                    this.skipTrack(`Unsupported Matroska codec '${codecIdRaw}'`);
                    continue;
                }

                if (t.type === 1)
                    t.codec =
                        videoCodecFromPrivate(codecIdRaw, t.codecConfig, t.dolbyVisionConfig) ??
                        t.codec;

                if (t.codec.startsWith('pcm-')) {
                    demuxAssert(
                        t.type === 2 && !t.codecConfig?.length,
                        'Matroska PCM requires an audio track without CodecPrivate',
                    );
                    t.codecConfig = undefined;
                    t.sampleRate ||= 8000;
                    t.pcm = describePcmTrack(t);
                }

                if (t.codec === 'ulaw' || t.codec === 'alaw') t.codecConfig = undefined;
                if (t.codec === 'alac') {
                    t.codecConfig = t.codecConfig && alacCookie(t.codecConfig);
                    demuxAssert(t.codecConfig, 'Matroska ALAC requires its 24-byte magic cookie');
                }

                // Opus always decodes at 48 kHz; SamplingFrequency only records the encoder's input
                // rate.
                if (t.codec === 'opus') t.sampleRate = 48000;
                if (t.codec === 'vorbis' && t.codecConfig) {
                    t.vorbis = vorbisBlocks(t.codecConfig);
                    const previous = this.carriedVorbis?.get(t.number);
                    if (t.vorbis && previous) t.vorbis.previous = previous;
                }
                if (codecIdRaw === 'A_AAC' && t.codecConfig) {
                    const asc = parseAacAudioSpecificConfig(t.codecConfig);
                    if (asc) {
                        t.codec = `mp4a.40.${asc.audioObjectType}`;
                        if (asc.sampleRate > 0) t.sampleRate = asc.sampleRate;
                        if (asc.channelCount > 0) t.channelCount = asc.channelCount;
                        if (asc.sampleRate > 0)
                            t.aacFrameDuration = asc.samplesPerAccessUnit / asc.sampleRate;
                    }
                }

                t.proRes = isProResCodec(t.codec);
            } else if (t.type === 17) {
                const sub = SUBTITLE_CODEC_MAP[codecIdRaw];
                if (!sub) {
                    // Image subtitles (PGS, VobSub, DVB) are left out, but never without saying so.
                    this.diagnostics?.warn({
                        code: 'MATROSKA_UNSUPPORTED_TRACK',
                        format: 'matroska',
                        message:
                            `Omitted subtitle track ${t.number} in unsupported ` +
                            `'${codecIdRaw}'`,
                    });
                    continue;
                }
                t.codec = sub;
            } else {
                continue;
            }

            if (t.type === 1 && t.codec !== 'theora' && codecIdRaw === 'V_THEORA') {
                this.skipTrack('Matroska Theora track has an unusable CodecPrivate');
                continue;
            }

            if (compression && compression.scope & 1) {
                if (compression.algorithm !== COMPRESSION_HEADER_STRIP) {
                    t.frameCompression = compression;
                    this.frameCompression = true;
                } else if (compression.settings.length) t.framePrefix = compression.settings;
            }

            if (
                t.alphaMode &&
                (t.type !== 1 || (t.codec !== 'vp8' && !t.codec.startsWith('vp09')))
            ) {
                throw new DemuxError('Matroska alpha is only supported for VP8/VP9 video');
            }

            demuxAssert(tracks.size < DEMUX_LIMITS.maxTracks, 'track count exceeds limit');
            tracks.set(t.number, t);
        }
    }

    /**
     * One identity or disposition field of a TrackEntry (UID, flags, name, language) into `t`;
     * false when an optional field could not be read and was reported. `uidSeen` tells whether the
     * entry already gave a TrackUID.
     */
    private readTrackIdentity(
        buf: Uint8Array,
        f: Element,
        t: WebMTrack,
        uidSeen: boolean,
    ): boolean {
        try {
            if (f.id === ID.TrackUID) {
                const uid = matroskaUid(buf, f.dataStart, f.dataEnd);
                if (uid > 0n) this.inputUidCounts.set(uid, (this.inputUidCounts.get(uid) ?? 0) + 1);
                demuxAssert(uid > 0n && !uidSeen, 'Matroska TrackUID must be unique and positive');
                t.uid = uid;
            } else if (
                f.id === ID.FlagDefault ||
                f.id === ID.FlagForced ||
                f.id === ID.FlagCommentary
            ) {
                const flag = uintOf(buf, f, f.id === ID.FlagDefault ? 1 : 0);
                demuxAssert(flag === 0 || flag === 1, 'Matroska track disposition must be 0 or 1');
                if (f.id === ID.FlagDefault) t.default = flag === 1;
                else if (f.id === ID.FlagForced) t.forced = flag === 1;
                else t.commentary = flag === 1;
            } else if (DISPOSITION_FLAGS.has(f.id)) {
                const flag = uintOf(buf, f);
                demuxAssert(flag === 0 || flag === 1, 'Matroska track disposition must be 0 or 1');
                t.dispositions = { ...t.dispositions, [DISPOSITION_FLAGS.get(f.id)!]: flag === 1 };
            } else if (f.id === ID.Name) t.name = utf8Of(buf, f);
            else {
                demuxAssert(
                    f.dataEnd > f.dataStart && f.dataEnd - f.dataStart <= 255,
                    'Matroska track language must contain 1..255 ASCII bytes',
                );
                const language = String.fromCharCode(...buf.subarray(f.dataStart, f.dataEnd));
                demuxAssert(
                    /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|[iIxX](?:-[A-Za-z0-9]{1,8})+)$/.test(
                        language,
                    ),
                    'Matroska track language contains an invalid character',
                );
                if (f.id === ID.LanguageIETF) t.languageIetf = language;
                else t.language = language;
            }
            return true;
        } catch (error) {
            this.optionalMetadataError(error);
            return false;
        }
    }

    /** The Video element of a TrackEntry into `t`; returns its ColourSpace FourCC. */
    private readVideoSettings(buf: Uint8Array, f: Element, t: WebMTrack): string {
        let colourSpace = '';
        let displayWidth: number | undefined;
        let displayHeight: number | undefined;
        let displayUnit = 0;
        let interlaced = 0;
        let fieldOrder = 2;
        for (const v of elements(buf, f.dataStart, f.dataEnd)) {
            if (v.id === ID.PixelWidth) t.width = uintOf(buf, v);
            else if (v.id === ID.PixelHeight) t.height = uintOf(buf, v);
            else if (v.id === ID.DisplayWidth) displayWidth = uintOf(buf, v);
            else if (v.id === ID.DisplayHeight) displayHeight = uintOf(buf, v);
            else if (v.id === ID.DisplayUnit) displayUnit = uintOf(buf, v);
            else if (v.id === ID.Colour) t.colour = colourOf(buf, v);
            else if (v.id === ID.FlagInterlaced) interlaced = uintOf(buf, v);
            else if (v.id === ID.FieldOrder) fieldOrder = uintOf(buf, v, 2);
            else if (v.id === ID.Projection) {
                const rotation = projectionRotation(buf, v);
                if (rotation === null) this.warnProjectionIgnored();
                else t.rotation = rotation;
            } else if (v.id === ID.ColourSpace)
                colourSpace = String.fromCharCode(
                    ...buf.subarray(v.dataStart, Math.min(v.dataEnd, v.dataStart + 4)),
                );
            else if (v.id === ID.AlphaMode) {
                const mode = uintOf(buf, v);
                if (mode !== 0 && mode !== 1)
                    throw new DemuxError(`Matroska AlphaMode ${mode} is not supported`);
                t.alphaMode = mode === 1;
            }
        }

        setDisplayGeometry(t, displayWidth, displayHeight, displayUnit);

        // As ffmpeg reads them: FieldOrder counts only on a track flagged interlaced.
        t.fieldOrder =
            interlaced === 2
                ? 'progressive'
                : interlaced === 1
                  ? MATROSKA_FIELD_ORDERS[fieldOrder]
                  : undefined;
        return colourSpace;
    }

    /**
     * The Audio element of a TrackEntry into `t`; returns its BitDepth and OutputSamplingFrequency.
     */
    private readAudioSettings(
        buf: Uint8Array,
        f: Element,
        t: WebMTrack,
    ): { bitsPerSample: number; outputSampleRate: number } {
        let bitsPerSample = 0;
        let outputSampleRate = 0;
        t.sampleRate = 8000;
        t.channelCount = 1;
        for (const a of elements(buf, f.dataStart, f.dataEnd)) {
            if (a.id === ID.SamplingFrequency) {
                t.sampleRate = Math.round(floatOf(buf, a, 8000));
                if (!(Number.isSafeInteger(t.sampleRate) && t.sampleRate > 0)) {
                    const message = `track ${t.number || '?'} has invalid SamplingFrequency`;
                    demuxAssert(readsPastDamage(this.diagnostics), message);

                    // The rate the codec header states replaces it; Matroska's default stands
                    // otherwise.
                    this.diagnostics?.warn({
                        code: 'MATROSKA_SAMPLING_FREQUENCY',
                        format: 'matroska',
                        message: `${message}; the codec's own rate is used`,
                    });
                    t.sampleRate = 0;
                }
            } else if (a.id === ID.Channels) {
                t.channelCount = uintOf(buf, a, 1);
                if (!(t.channelCount > 0))
                    malformedInput(`track ${t.number || '?'} has invalid Channels`);
            } else if (a.id === ID.BitDepth) bitsPerSample = uintOf(buf, a);
            else if (a.id === ID.OutputSamplingFrequency)
                outputSampleRate = Math.round(floatOf(buf, a, 0));
        }

        return { bitsPerSample, outputSampleRate };
    }

    /**
     * The codec of a track whose CodecID needs its CodecPrivate or settings read: ProRes, VfW
     * video, uncompressed video, ACM audio and AAC named by its profile. Returns the CodecID the
     * track is read as from then on.
     */
    private async readSpecialCodec(
        t: WebMTrack,
        codecIdRaw: string,
        settings: {
            readonly colourSpace: string;
            readonly outputSampleRate: number;
            readonly bitsPerSample: number;
        },
    ): Promise<string> {
        if (codecIdRaw === 'V_PRORES') {
            demuxAssert(t.type === 1, 'Matroska ProRes requires a video track');
            const codec = readProResFourCC(t.codecConfig);
            demuxAssert(
                codec,
                'Matroska ProRes CodecPrivate must contain a supported four-byte FourCC',
            );
            t.codec = codec;
            t.codecConfig = undefined;
        } else if (codecIdRaw === 'V_MS/VFW/FOURCC') (await codecParts()).readVfwTrack(t);
        else if (codecIdRaw === 'V_UNCOMPRESSED') {
            demuxAssert(t.type === 1, 'Matroska V_UNCOMPRESSED requires a video track');
            const codec = rawVideoCodecForFourcc(settings.colourSpace);
            if (!codec)
                throw new DemuxError(
                    `Unsupported Matroska uncompressed ColourSpace '${settings.colourSpace}'`,
                );
            t.codec = codec;
        } else if (codecIdRaw === 'A_MS/ACM' && t.type === 2) (await codecParts()).readAcmTrack(t);
        else if (/^A_AAC\/MPEG[24]\//.test(codecIdRaw) && t.type === 2 && !t.codecConfig?.length) {
            t.codecConfig = legacyAacConfig(
                codecIdRaw,
                t.sampleRate,
                t.channelCount,
                settings.outputSampleRate,
            );
            t.codec = CODEC_MAP.A_AAC!;
            return 'A_AAC';
        } else
            t.codec =
                matroskaPcmCodec(codecIdRaw, settings.bitsPerSample) ?? CODEC_MAP[codecIdRaw] ?? '';
        return codecIdRaw;
    }

    /**
     * `resumedTimestamp` carries the cluster timestamp when parsing resumes after damage inside the
     * cluster.
     */
    private async parseClusterAt(
        h: ParsedHeader,
        parentEnd: number,
        tracks: Map<number, WebMTrack>,
        tsScaleNs: number,
        resumedTimestamp = 0,
    ): Promise<number> {
        let clusterTs = resumedTimestamp;
        let p = h.dataStart;
        const clusterEnd = h.unknown ? parentEnd : h.dataEnd;
        let childCount = 0;
        let pageStart = p;
        let page: Uint8Array = EMPTY_PAGE;
        const header = this.header;
        while (p < clusterEnd) {
            this.clusterFailurePosition = p;
            demuxAssert(
                ++childCount <= DEMUX_LIMITS.maxTableEntries,
                'EBML element count exceeds limit',
            );
            if ((childCount & 0x0fff) === 0) await Promise.resolve();
            throwIfAborted(this.signal);
            if (p >= pageStart + page.length) {
                pageStart = p;
                // A page ends where the reader's chunk does; a window's chunks count from its
                // start.
                const origin = this.windowHead ? this.probeFrom : 0;
                page = await this.reader.bytes(
                    p,
                    Math.min(clusterEnd - p, CHUNK_BYTES - ((p - origin) % CHUNK_BYTES)),
                );
            }

            let id: number;
            let dataStart: number;
            let dataEnd: number;
            let unknown: boolean;
            if (p - pageStart + Math.min(HEADER_PEEK, clusterEnd - p) <= page.length) {
                readHeaderLocal(page, p - pageStart, clusterEnd - pageStart, page.length, header);
                id = header.id;
                dataStart = header.dataStart + pageStart;
                dataEnd = header.dataEnd + pageStart;
                unknown = header.unknown;
            } else {
                const c = await this.headerAt(p, clusterEnd);
                id = c.id;
                dataStart = c.dataStart;
                dataEnd = c.dataEnd;
                unknown = c.unknown;
            }

            if (!CLUSTER_CHILD_IDS.has(id)) {
                if (!h.unknown)
                    malformedInput(`EBML element 0x${id.toString(16)} inside a sized cluster`);
                return p;
            }

            demuxAssert(!unknown, 'unknown-size cluster child is not supported');
            if (id !== ID.ClusterTimestamp && id !== ID.SimpleBlock && id !== ID.BlockGroup) {
                p = dataEnd;
                continue;
            }

            let buf: Uint8Array;
            let start: number;
            let end: number;
            let absBase: number;
            if (dataEnd <= pageStart + page.length) {
                buf = page;
                start = dataStart - pageStart;
                end = dataEnd - pageStart;
                absBase = pageStart;
            } else {
                buf = await this.reader.bytes(dataStart, dataEnd - dataStart);
                start = 0;
                end = buf.length;
                absBase = dataStart;
            }

            if (id === ID.ClusterTimestamp)
                clusterTs = this.lastClusterTimestamp = readUint(buf, start, end, 0);
            else if (id === ID.SimpleBlock) {
                const frames = this.frameCompression
                    ? await this.decompressFrames(buf, start, end, tracks)
                    : undefined;
                this.parseBlock(
                    buf,
                    start,
                    end,
                    absBase,
                    tracks,
                    clusterTs,
                    tsScaleNs,
                    null,
                    0,
                    0,
                    0,
                    0,
                    frames,
                );
            } else {
                let frames: Uint8Array[] | undefined;
                if (this.frameCompression)
                    for (const child of elements(buf, start, end))
                        if (child.id === ID.Block)
                            frames = await this.decompressFrames(
                                buf,
                                child.dataStart,
                                child.dataEnd,
                                tracks,
                            );
                this.parseBlockGroup(
                    buf,
                    start,
                    end,
                    absBase,
                    tracks,
                    clusterTs,
                    tsScaleNs,
                    frames,
                );
            }

            p = dataEnd;
        }

        return clusterEnd;
    }

    private parseBlockGroup(
        buf: Uint8Array,
        start: number,
        end: number,
        absBase: number,
        tracks: Map<number, WebMTrack>,
        clusterTs: number,
        tsScaleNs: number,
        decompressed?: readonly Uint8Array[],
    ): void {
        const header = this.header;
        let blockStart = -1;
        let blockEnd = 0;
        let hasReference = false;
        let discardPadNs = 0;
        let discardPaddingElements = 0;
        let blockDurationTicks = 0;
        let alphaStart = 0;
        let alphaSize = 0;
        let sawAdditions = false;
        let count = 0;
        for (let pos = start; pos < end;) {
            readHeaderLocal(buf, pos, end, end, header);
            const id = header.id;
            const dataStart = header.dataStart;
            const dataEnd = header.dataEnd;
            if (header.unknown)
                malformedInput(
                    `unknown-size EBML element 0x${id.toString(16)} inside a sized container`,
                );

            if (id === ID.Block) {
                blockStart = dataStart;
                blockEnd = dataEnd;
            } else if (id === ID.ReferenceBlock) hasReference = true;
            else if (id === ID.BlockDuration)
                blockDurationTicks = readUint(buf, dataStart, dataEnd, 0);
            else if (id === ID.BlockAdditions) {
                demuxAssert(!sawAdditions, 'BlockGroup contains multiple BlockAdditions elements');
                sawAdditions = true;
                let sideData = false;
                for (const more of elements(buf, dataStart, dataEnd, end)) {
                    if (more.id !== ID.BlockMore)
                        malformedInput('BlockAdditions holds an element other than BlockMore');

                    let addId = 1;
                    let payload: Element | undefined;
                    let sawId = false;
                    for (const field of elements(buf, more.dataStart, more.dataEnd, end)) {
                        if (field.id === ID.BlockAddID) {
                            demuxAssert(!sawId, 'Duplicate BlockAddID');
                            sawId = true;
                            addId = uintOf(buf, field, 1);
                        } else if (field.id === ID.BlockAdditional) {
                            demuxAssert(!payload, 'Duplicate BlockAdditional');
                            payload = field;
                        } else
                            malformedInput(
                                'BlockMore holds an element other than BlockAddID and ' +
                                    'BlockAdditional',
                            );
                    }

                    if (addId !== 1) {
                        if (!readsPastDamage(this.diagnostics))
                            throw new MediaForgeError(
                                'Matroska BlockAdditional side data other than alpha is lost',
                                'FORMAT',
                            );
                        sideData = true;
                        this.warnMetadataLoss(
                            'Matroska BlockAdditional side data other than alpha was omitted',
                        );
                        continue;
                    }

                    if (alphaSize > 0)
                        malformedInput('BlockAdditions holds two alpha BlockMore elements');
                    demuxAssert(
                        !!payload && payload.dataEnd > payload.dataStart,
                        'Empty Matroska BlockAdditional',
                    );
                    alphaStart = payload.dataStart;
                    alphaSize = payload.dataEnd - payload.dataStart;
                }

                demuxAssert(alphaSize > 0 || sideData, 'Empty Matroska BlockAdditions');
            } else if (id === ID.DiscardPadding) {
                demuxAssert(
                    ++discardPaddingElements === 1,
                    'BlockGroup contains multiple DiscardPadding elements',
                );
                const byteLength = dataEnd - dataStart;
                demuxAssert(
                    byteLength > 0 && byteLength <= 8,
                    'DiscardPadding integer has an invalid byte length',
                );
                let value = 0n;
                for (let i = dataStart; i < dataEnd; i++) {
                    value = value * 256n + BigInt(buf[i]!);
                }

                const bits = BigInt(byteLength * 8);
                if (value >= 1n << (bits - 1n)) value -= 1n << bits;
                demuxAssert(
                    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
                        value <= BigInt(Number.MAX_SAFE_INTEGER),
                    'DiscardPadding integer exceeds the safe range',
                );
                discardPadNs = Number(value);
            }

            demuxAssert(
                ++count <= DEMUX_LIMITS.maxTableEntries,
                'EBML element count exceeds limit',
            );
            pos = dataEnd;
        }

        demuxAssert(
            discardPaddingElements === 0 || blockStart >= 0,
            'BlockGroup has DiscardPadding without a Block',
        );
        demuxAssert(!sawAdditions || blockStart >= 0, 'BlockAdditions without a Block');
        if (blockStart >= 0) {
            this.parseBlock(
                buf,
                blockStart,
                blockEnd,
                absBase,
                tracks,
                clusterTs,
                tsScaleNs,
                !hasReference,
                discardPadNs,
                blockDurationTicks,
                alphaStart,
                alphaSize,
                decompressed,
            );
        }
    }

    /**
     * `buf[start, end)` is one Block body whose byte `start` sits at file offset `absBase + start`.
     */
    private parseBlock(
        buf: Uint8Array,
        start: number,
        end: number,
        absBase: number,
        tracks: Map<number, WebMTrack>,
        clusterTs: number,
        tsScaleNs: number,
        groupKey: boolean | null,
        discardPadNs: number,
        blockDurationTicks: number,
        alphaStart: number,
        alphaSize: number,
        decompressed?: readonly Uint8Array[],
    ): void {
        let pos = start;
        const trackNumber = readVint(buf, pos, end, 'unsigned');
        pos += vintLength;
        const track = tracks.get(trackNumber);
        demuxAssert(pos + 3 <= end, 'Matroska block header truncated');
        const rel = (((buf[pos]! << 8) | buf[pos + 1]!) << 16) >> 16;
        const flags = buf[pos + 2]!;
        pos += 3;
        if (!track) return;
        let isKey = groupKey ?? ((flags & 0x80) !== 0 || track.type !== 1);
        const lacing = (flags >> 1) & 0x03;
        if (alphaSize > 0 && (track.type !== 1 || track.alphaMode !== true || lacing !== 0)) {
            throw new DemuxError(
                'Matroska BlockAdditional other than VP8/VP9 alpha is not supported',
            );
        }
        const codedTsSeconds = ((clusterTs + rel * track.timestampScale) * tsScaleNs) / 1e9;
        if (!Number.isFinite(codedTsSeconds))
            malformedInput(`track ${track.number} timestamp exceeds the finite range`);

        const tsSeconds = codedTsSeconds - track.codecDelayNs / 1e9;

        const sizes = this.laceSizes;
        let count = 1;
        let framesStart = pos;
        if (lacing === 0) {
            sizes[0] = end - pos;
            pos = end;
        } else {
            ({ count, framesStart } = laceFrames(buf, pos, end, lacing, sizes));
            pos = framesStart;
            for (let i = 0; i < count; i++) pos += sizes[i]!;
        }

        // A block of several whole MPEG audio frames is read as one packet per frame, as FFmpeg's
        // parser splits it.
        if (!track.framePrefix && !decompressed && MPEG_AUDIO.has(track.codec))
            count = this.mpegAudioFrames(track, buf, framesStart, pos, count);

        // Header-stripped and decompressed frames are restored in memory; each keeps the file
        // offset of its stored bytes.
        let restored: Uint8Array | undefined;
        let storedOffsets: number[] = [];
        if (track.framePrefix || decompressed) {
            ({ restored, storedOffsets } = this.restoreFrames(
                track,
                buf,
                framesStart,
                count,
                absBase,
                decompressed,
            ));
            buf = restored;
            framesStart = 0;
        }

        // Some writers put VP8/VP9 inter frames in BlockGroups without a ReferenceBlock; the frame
        // header decides.
        if (isKey && groupKey !== null && sizes[0]! > 0) {
            const head = buf.subarray(framesStart, framesStart + Math.min(sizes[0]!, 16));
            if (track.codec === 'vp8') isKey = isVp8Keyframe(head);
            else if (track.codec.startsWith('vp09')) isKey = isVp9Keyframe(head);
        }
        track.keyedAudio ??= track.type === 2 && audioHasKeyframes(track.codec);
        if (track.keyedAudio && sizes[0]! > 0) isKey = (buf[framesStart]! & 0x80) !== 0;

        if (track.type === 2) {
            if (track.codec === 'ac-3') this.ac3Block(track, buf, framesStart, sizes[0]!);
            const blockIndex = track.audioBlockCount++;
            if (discardPadNs > 0) {
                if (!(groupKey !== null))
                    malformedInput(
                        `audio track ${track.number} has DiscardPadding outside a BlockGroup`,
                    );
                // Files joined end to end keep the padding of each: an earlier one trims its block.
                if (track.positiveDiscardSeen) this.trimJoinedBlock(track);
                track.positiveDiscardSeen = true;
                track.positiveDiscardBlockIndex = blockIndex;
                track.trailingDiscardPadNs = discardPadNs;
            } else if (discardPadNs < 0) {
                if (!(groupKey !== null))
                    malformedInput(
                        `audio track ${track.number} has DiscardPadding outside a BlockGroup`,
                    );
                if (track.negativeDiscardSeen)
                    malformedInput(
                        `audio track ${track.number} has more than one negative DiscardPadding`,
                    );
                if (!(blockIndex === 0))
                    malformedInput(
                        `audio track ${track.number} has negative DiscardPadding after its first ` +
                            `BlockGroup`,
                    );
                track.negativeDiscardSeen = true;
                track.leadingDiscardPadNs = -discardPadNs;
            }
        }

        let blockDurationNs =
            blockDurationTicks > 0
                ? blockDurationTicks * track.timestampScale * tsScaleNs
                : track.defaultDurationNs > 0
                  ? track.defaultDurationNs * count
                  : 0;
        if (!Number.isFinite(blockDurationNs))
            malformedInput(`track ${track.number} BlockDuration exceeds the finite range`);
        if (track.type === 2 && count === 1 && blockDurationTicks > 0 && discardPadNs > 0) {
            // FFmpeg states only the kept part of a final frame in BlockDuration and the rest of
            // the coded frame in DiscardPadding; within one timestamp tick of the coded frame, the
            // Block is that whole frame, so the padding is trimmed once.
            const codedNs =
                this.encodedAudioFrameDuration(track, buf, framesStart, framesStart + sizes[0]!) *
                1e9;
            if (
                codedNs > discardPadNs &&
                Math.abs(codedNs - blockDurationNs - discardPadNs) <=
                    track.timestampScale * tsScaleNs
            )
                blockDurationNs = codedNs;
        }
        if (
            discardPadNs !== 0 &&
            blockDurationNs > 0 &&
            Math.abs(discardPadNs) > blockDurationNs + 1
        ) {
            // Encoders state the whole codec padding (for MP3 the LAME padding plus decoder delay)
            // on the last block even when it exceeds that block; the trim is capped at the block
            // rather than rejected.
            if (!readsPastDamage(this.diagnostics))
                malformedInput(
                    `audio track ${track.number} DiscardPadding exceeds its Block duration`,
                );
            this.diagnostics?.warn({
                code: 'MATROSKA_DISCARD_PADDING_CLAMPED',
                format: 'matroska',
                message:
                    `Audio track ${track.number} DiscardPadding exceeds its block; trimmed it ` +
                    `all`,
            });
            discardPadNs = Math.sign(discardPadNs) * blockDurationNs;
            if (discardPadNs > 0) track.trailingDiscardPadNs = discardPadNs;
            else track.leadingDiscardPadNs = -discardPadNs;
        }
        const frameDur =
            blockDurationTicks > 0
                ? blockDurationNs / count / 1e9
                : track.defaultDurationNs > 0
                  ? track.defaultDurationNs / 1e9
                  : 0;
        const constantFrames =
            track.pcm !== undefined || track.codec === 'ulaw' || track.codec === 'alaw';
        const inferred = !(frameDur > 0) || constantFrames;
        const durations = this.laceDurations;
        if (inferred) {
            let at = framesStart;
            for (let i = 0; i < count; i++) {
                const size = sizes[i]!;
                durations[i] = this.encodedAudioFrameDuration(track, buf, at, at + size);
                at += size;
            }
        }
        this.indexBudget.reserveSamples(count, this.compact ? 0 : 256, 'Matroska sample index');
        if (this.materialize && this.totalSamples + count > this.sampleBudget) {
            throw new SoftLimitExceeded();
        }
        const vorbisLaces = track.vorbis
            ? this.vorbisLaces(track, buf, framesStart, count)
            : undefined;
        const alphaOffset = alphaSize > 0 ? absBase + alphaStart : 0;
        const tick = (track.timestampScale * tsScaleNs) / 1e9;
        const indexed = track.index.length;
        let elapsed = 0;
        let at = framesStart;
        for (let i = 0; i < count; i++) {
            const size = sizes[i]!;
            const proResHeaderless =
                track.proRes && proResHeaderlessFrame(buf.subarray(at, at + size), track);
            this.totalSamples++;
            if ((this.totalSamples & 0x0fff) === 0) throwIfAborted(this.signal);
            const duration = vorbisLaces
                ? vorbisLaces[i]!
                : constantFrames
                  ? durations[i]!
                  : frameDur > 0
                    ? frameDur
                    : durations[i]!;
            if (track.awaitKeyframe && isKey) track.awaitKeyframe = false;

            // Empty frames (VfW drop-frame placeholders among them) carry nothing to decode; FFmpeg
            // drops them too.
            if (this.materialize && ((size === 0 && alphaSize === 0) || track.awaitKeyframe)) {
                if (track.awaitKeyframe) this.skippedUntilKeyframe++;
                elapsed += duration;
            } else if (this.materialize) {
                track.index.append(
                    restored ? storedOffsets[i]! : absBase + at,
                    size,
                    tsSeconds + elapsed,
                    duration,
                    track.proRes || (i === 0 ? isKey : track.type !== 1),
                    proResHeaderless,
                    alphaOffset,
                    alphaSize,
                    restored?.slice(at, at + size),
                );

                // Laced Vorbis frames follow one another on the block's clock, which counts each
                // frame's length in whole ticks, rounded down as FFmpeg counts them.
                elapsed += vorbisLaces ? Math.floor(duration / tick + 1e-9) * tick : duration;
            }
            at += size;
        }
        if (discardPadNs > 0)
            track.positiveDiscardFrame = track.index.length > indexed ? track.index.length - 1 : -1;
    }

    /**
     * Moves the positive DiscardPadding of `track` from its end to the frame it was read with:
     * that frame presents its decoded samples but the padding.
     */
    private trimJoinedBlock(track: WebMTrack): void {
        const rate = track.codec === 'opus' ? 48000 : track.sampleRate;
        const samples = Math.round((track.trailingDiscardPadNs * rate) / 1e9);
        if (track.positiveDiscardFrame >= 0 && samples > 0)
            track.index.discard(track.positiveDiscardFrame, samples);
        track.trailingDiscardPadNs = 0;
    }

    /**
     * The frames of a block of MPEG audio: an unlaced block of whole frames of the track's layer is
     * one packet per frame. Blocks or laces that cut frames at byte counts are counted; common ones
     * make the track's frames reassembled once all are read.
     */
    private mpegAudioFrames(
        track: WebMTrack,
        buf: Uint8Array,
        start: number,
        end: number,
        count: number,
    ): number {
        const sizes = this.laceSizes;
        if (count === 1) {
            const frames = this.splitMpegAudioFrames(track.codec, buf, start, end);
            if (frames > 0) return frames;
            track.mpegUnaligned = (track.mpegUnaligned ?? 0) + 1;
            return count;
        }
        for (let i = 0, at = start; i < count; at += sizes[i]!, i++) {
            const header = parseMpegAudioHeader(buf, at);
            if (!header || header.format !== track.codec || header.frameLength !== sizes[i]) {
                track.mpegUnaligned = (track.mpegUnaligned ?? 0) + count;
                break;
            }
        }
        return count;
    }

    /**
     * The `count` frames of a block from `framesStart` with the track's stripped header restored
     * before each, or as `decompressed`, in one buffer; `storedOffsets` keeps where each frame's
     * stored bytes start in the file. The frame sizes become the restored ones.
     */
    private restoreFrames(
        track: WebMTrack,
        buf: Uint8Array,
        framesStart: number,
        count: number,
        absBase: number,
        decompressed: readonly Uint8Array[] | undefined,
    ): { restored: Uint8Array; storedOffsets: number[] } {
        const sizes = this.laceSizes;
        const prefix = track.framePrefix ?? EMPTY_PAGE;
        const storedOffsets: number[] = [];
        let total = 0;
        for (let i = 0; i < count; i++)
            total += decompressed ? decompressed[i]!.length : sizes[i]! + prefix.length;
        if (decompressed && this.materialize)
            this.indexBudget.reserveBytes(total, 'Matroska decompressed frames');
        const restored = new Uint8Array(total);
        let from = framesStart;
        let to = 0;
        for (let i = 0; i < count; i++) {
            const size = sizes[i]!;
            storedOffsets.push(absBase + from);
            if (decompressed) restored.set(decompressed[i]!, to);
            else {
                restored.set(prefix, to);
                restored.set(buf.subarray(from, from + size), to + prefix.length);
            }

            sizes[i] = decompressed ? decompressed[i]!.length : size + prefix.length;
            from += size;
            to += sizes[i]!;
        }

        return { restored, storedOffsets };
    }

    /**
     * A_AC3 has no CodecPrivate; MP4 and fragmented MP4 copies need the dac3 its first syncframe
     * describes. Streams that switch channel modes (a stereo lead-in before 5.1) are described with
     * the most channels.
     */
    private ac3Block(track: WebMTrack, buf: Uint8Array, framesStart: number, size: number): void {
        const dolby = parseDolbyFrameHeader(buf.subarray(framesStart, framesStart + size), 0);
        if (dolby?.codec !== 'ac-3') return;
        track.codecConfig ??= ac3SpecificBox(buf, framesStart);
        track.sampleRate ||= dolby.sampleRate;
        track.ac3FrameChannels = Math.max(track.ac3FrameChannels ?? 0, dolby.channels);
    }

    /**
     * Durations of the frames laced into a Vorbis block, from their block sizes as FFmpeg's parser
     * times them; undefined for a single frame or an unreadable packet. Each frame's block size
     * carries on to the next.
     */
    private vorbisLaces(
        track: WebMTrack,
        buf: Uint8Array,
        framesStart: number,
        count: number,
    ): Float64Array | undefined {
        const vorbis = track.vorbis!;
        const sizes = this.laceSizes;
        let laces = count > 1 ? new Float64Array(count) : undefined;
        for (let i = 0, at = framesStart; i < count; at += sizes[i]!, i++) {
            let block: number;
            try {
                block = vorbisPacketBlock(
                    buf.subarray(at, at + Math.min(sizes[i]!, 8)),
                    vorbis.modes,
                    vorbis.small,
                    vorbis.large,
                );
            } catch {
                laces = undefined;
                break;
            }

            if (laces) laces[i] = (vorbis.previous + block) / 4 / track.sampleRate;
            vorbis.previous = block;
        }

        return laces;
    }

    /**
     * Frames of one unlaced block of MPEG audio when it holds whole frames of the track's layer:
     * fills `laceSizes` and returns their count; -1, with the block as one frame, when frames cross
     * its ends.
     */
    private splitMpegAudioFrames(
        codec: string,
        buf: Uint8Array,
        start: number,
        end: number,
    ): number {
        const sizes = this.laceSizes;
        let count = 0;
        for (let at = start; at < end; count++) {
            const header = count < MAX_LACE_FRAMES ? parseMpegAudioHeader(buf, at) : null;
            if (!header || header.format !== codec || header.frameLength > end - at) {
                sizes[0] = end - start;
                return -1;
            }
            sizes[count] = header.frameLength;
            at += header.frameLength;
        }
        if (count < 2) sizes[0] = end - start;
        return Math.max(1, count);
    }

    /**
     * The frames of a Block body whose track compresses them with zlib or LZO1X, decompressed in
     * lacing order.
     */
    private async decompressFrames(
        buf: Uint8Array,
        start: number,
        end: number,
        tracks: Map<number, WebMTrack>,
    ): Promise<Uint8Array[] | undefined> {
        const { decompressFrames } = await compressionParts();
        return decompressFrames(buf, start, end, tracks, this.laceSizes, this.signal);
    }

    private encodedAudioFrameDuration(
        track: WebMTrack,
        buf: Uint8Array,
        start: number,
        end: number,
    ): number {
        const length = end - start;
        if (track.pcm) {
            demuxAssert(
                length > 0 && length % track.pcm.blockAlign === 0,
                'Matroska PCM blocks must contain complete channel frames',
            );
            return length / track.pcm.blockAlign / track.pcm.sampleRate;
        }

        if (track.codec === 'ulaw' || track.codec === 'alaw') {
            demuxAssert(
                length > 0 && length % track.channelCount === 0,
                'Matroska G.711 blocks must contain complete channel frames',
            );
            return length / track.channelCount / track.sampleRate;
        }

        if (track.type !== 2 || length === 0) return 0;
        if (track.codec === 'alac') {
            const cookie = track.codecConfig!;
            const frames = alacPacketFrames(
                buf.subarray(start, end),
                new DataView(cookie.buffer, cookie.byteOffset).getUint32(0),
            );
            return frames ? frames / track.sampleRate : 0;
        }

        if (track.codec === 'mp1' || track.codec === 'mp2' || track.codec === 'mp3') {
            const header = length >= 4 ? parseMpegAudioHeader(buf, start) : null;
            return header?.format === track.codec && header.frameLength === length
                ? header.samplesPerFrame / header.sampleRate
                : 0;
        }

        if (track.codec.startsWith('mp4a')) return track.aacFrameDuration;
        if (track.codec === 'opus') {
            try {
                return opusPacketFrames(buf.subarray(start, end), length) / 48000;
            } catch {
                throw new DemuxError('Malformed Matroska Opus packet duration');
            }
        }

        if (track.codec === 'ac-3') return track.sampleRate > 0 ? 1536 / track.sampleRate : 0;
        if (track.codec === 'flac') {
            const header = parseFlacFrameHeader(buf.subarray(start, end), 0);
            const rate = header?.sampleRate ?? track.sampleRate;
            return header && rate > 0 ? header.blockSize / rate : 0;
        }

        return 0;
    }
}
