import type { Source } from '../../core/model/types';
import { BlobSource, BufferSource, RangeSource } from '../../core/io/sources/sources';
import {
    ForwardWindows,
    MAX_WINDOW_BYTES,
    WINDOW_BYTES,
    WindowBytes,
    spanWindows,
    probeMiss,
} from '../shared/large-input';
import { PROBE_WINDOWS } from '../shared/probe-windows';
import { ConcatSource } from '../../core/io/sources/concat-source';
import {
    CHUNK_BYTES,
    ChunkReader,
    WindowReader,
    type ByteReader,
} from '../../core/io/sources/chunk-reader';
import { uncachedReads } from '../../core/io/sources/cached-source';
import { demuxAssert, malformedInput } from '../../core/errors/demux-guard';
import {
    DEMUX_LIMITS,
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import { DiagnosticContext, type Warn } from '../../core/errors/diagnostics';
import type {
    Sample,
    DemuxResult,
    TrackInfo,
    ProbedInput,
    ProbeTarget,
    StreamedSample,
} from '../../core/model/track';
import { splitAnnexBNals } from '../../core/codec-config/video/annexb';
import { LatmReader, loasFrameLength } from './latm';
import { probeTsLayout } from './layout';
import { continuedAudioTime, readPesTimestamp } from '../shared/pes-timestamp';
import {
    ac3SpecificBox,
    dolbyAccessUnitChannels,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import { parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { parseTrueHdAccessUnit } from '../../core/codec-config/audio/truehd-header';
import type { MpegVideoSyntax } from '../../core/codec-config/video/mpeg-video';
import {
    bindPacketizedReader,
    enableCompactSampleIndex,
    readSampleBytes,
    releaseSampleIndex,
    sampleAt,
    sampleCount,
    usesCompactSampleIndex,
} from '../../core/model/sample-index';
import { PesSampleIndex } from '../shared/pes-sample-index';
import {
    MpegVideoAccessUnits,
    buildMpegVideoTrack,
    type MpegVideoFrame,
} from '../shared/mpeg-video-stream';
import { av1CodecString, Av1StreamState } from '../../core/codec-config/video/av1-config';
import {
    isVc1IntraFrame,
    parseVc1SequenceHeader,
    vc1HeadersOf,
} from '../../core/codec-config/video/vc1';
import {
    buildVvcCFromAnnexB,
    isVvcRandomAccessNal,
    parseVvcSps,
    vvcCodecString,
    vvcNalType,
    VVC_NAL,
} from '../../core/codec-config/video/vvc';
import { concatBytes } from '../../core/bytes/bytes';
import { narrowToPosition } from '../shared/position-search';
import {
    TS_PACKET,
    STREAM_TYPE_AV1,
    registrationOf,
    describesNoContent,
    AUDIO_HEADER_BYTES,
    STREAM_TYPE_LATM,
    OPUS_STREAM,
    audioFrameLength,
    audioFrameStart,
    sniffAudioStreamType,
    isLoasPayload,
    declaredAudioStreamType,
    DTS_CANDIDATE_TYPES,
    UNSUPPORTED_STREAMS,
    opusChannels,
    orphanStreamsSection,
} from './stream-types';
import { PesPacketReader } from './pes';
import { type PesEntry } from '../shared/pes-entry';
import {
    type StreamClock,
    SPLICE_BACKWARD_TICKS,
    ProgramTimeline,
    type SegmentRuns,
    markSegment,
    trackPids,
    tables,
    countOf,
    endOf,
    joinSegments,
    presentationEnd,
    settleTrack,
} from '../shared/pes-timeline';
import { PsiSectionReader, validatePsiSection, sectionCrc, checkPmtDescriptors } from './psi';
import {
    decodeDurations,
    VideoUnitJoiner,
    type TsSampleKeeping,
    locationOf,
    type VideoTrackOptions,
    H264TrackBuilder,
    H265TrackBuilder,
    AccessUnitSplitter,
} from '../shared/pes-video-tracks';
import { TsSampleReader } from './sample-reader';
import { type SplitAudio, pushFrame, splitAudioFrames, splitDtsFrames } from './audio-frames';
import { decodeTime } from '../../core/model/media-time';

/**
 * Whole packets from `pos` up to the end of the reader chunk, so the window is a view rather than a
 * copy.
 */
function windowLength(pos: number, size: number, stride: number, origin = 0): number {
    const chunkEnd = Math.min(
        size,
        origin + (Math.floor((pos - origin) / CHUNK_BYTES) + 1) * CHUNK_BYTES,
    );
    const whole = Math.floor((chunkEnd - pos) / stride) * stride;
    return whole >= stride ? whole : Math.min(stride, size - pos);
}

/** Next offset at or after `from` where two consecutive transport packets start with sync bytes. */
async function findTsSync(
    reader: ByteReader,
    from: number,
    size: number,
    stride: number,
    payOff: number,
): Promise<number> {
    for (let base = from; base + stride <= size;) {
        const bytes = await reader.bytes(base, Math.min(size - base, stride * 1024));
        const limit = bytes.length - stride - payOff - 1;
        for (let index = 0; index <= limit; index++) {
            if (bytes[index + payOff] === 0x47 && bytes[index + payOff + stride] === 0x47)
                return base + index;
        }
        if (bytes.length < stride * 2) break;
        base += Math.max(1, limit + 1);
    }
    return -1;
}

interface AudioCarry {
    readonly bytes: Uint8Array;
    readonly pos: number;
    readonly skip: number;
    readonly clean: boolean;
}

interface TsAudioStream {
    readonly track: TrackInfo;
    readonly reader: PesPacketReader;
    readonly sniffed: boolean;
    /** AC-3 compatibility frames interleaved with Blu-ray TrueHD on the same PID. */
    core?: TrackInfo;
    /** Samples per TrueHD access unit, known from the last major sync. */
    unitSamples: number;
}

/** Streams one PMT declares, with a reader per supported elementary stream. */
interface TsProgramStreams {
    videoPid: number;
    videoStreamType: number;
    readonly audioStreams: Map<number, TsAudioStream>;
    /** Declared streams of codecs this demuxer does not read. */
    readonly unsupported: string[];
    /** CRC of the PMT section the streams come from. */
    crc?: number;
}

/** A program the PAT lists: its number, its PMT PID and the reader of its PMT sections. */
interface TsProgram {
    readonly number: number;
    readonly pid: number;
    readonly reader: PsiSectionReader;
}

/** What the program tables at the start of the input tell: the programs and their streams. */
interface TsProgramTables {
    readonly patSeen: boolean;
    readonly programs: TsProgram[];
    /** The streams of each program's PMT; null for one that failed, undefined for one unread. */
    readonly candidates: (TsProgramStreams | null | undefined)[];
}

/** Whether a program holds a stream to read. */
function usableProgram(
    candidate: TsProgramStreams | null | undefined,
): candidate is TsProgramStreams {
    return !!candidate && (candidate.videoPid >= 0 || candidate.audioStreams.size > 0);
}

/** The input one demux reads, with its packet layout, and the window of it read last. */
interface TsTransport {
    readonly reader: ByteReader;
    readonly size: number;
    /** Bytes per packet: 188, or 192 and 204 with a timecode before or parity after it. */
    readonly stride: number;
    /** Where the transport packet starts in a stride. */
    readonly payOff: number;
    /** Where the first packet starts. */
    readonly syncOff: number;
    /** Bytes past the last whole packet. */
    readonly tailRemainder: number;
    readonly diagnostics: DiagnosticContext;
    readonly lenient: boolean;
    readonly budget: DemuxIndexBudget;
    readonly timeline: ProgramTimeline;
    readonly window: TsWindow;
    readonly checkAbort: () => void;
    /** The bytes read last, from windowStart: packets inside them need no read of their own. */
    bytes: Uint8Array;
    windowStart: number;
}

/** The PES reader of the video PID and the builders it feeds H.264 and H.265 units to. */
interface TsVideoPipeline {
    readonly streamed: H264TrackBuilder | H265TrackBuilder | undefined;
    readonly splitter: AccessUnitSplitter | undefined;
    readonly joiner: VideoUnitJoiner | undefined;
    readonly reader: PesPacketReader;
}

/** A window of the input that a probe reads in place of the whole input. */
interface TsWindow {
    /** The head of the input: the stream continues past the window's end. */
    readonly head?: boolean;
    /** Where the packets are read from, after the program tables at the start of the input. */
    readonly from?: number;
    /** The program tables at the start of the input, for a window from `from` (WindowBytes). */
    readonly tables?: ByteReader;
    /**
     * Whole transport packets of the program tables the run read before it knew the streams, when
     * collected.
     */
    readonly psi?: Uint8Array[];
    /** Video parameter sets: found in the head, given to a window that starts between them. */
    parameterSets?: readonly Uint8Array[];
    /** A window of a stream: a track may hold no sample in it. */
    readonly stream?: boolean;
    /** The audio clocks of the PIDs a stream delivered frames of before this window, by PID. */
    readonly audioClocks?: ReadonlyMap<number, AudioClock>;
    /** Set by a head window: where the PES and audio frames still incomplete at its end start. */
    resume?: number;
    /** Where a stream's window assembles its PES, valid while the window's samples are. */
    readonly allocate?: (length: number) => Uint8Array;
}

/**
 * Where an audio PID's frames stand when a stream's window starts reading it: the time a frame was
 * delivered at, by the transport location of its first byte (the PES position and the bytes of that
 * PES before it), and where the latest delivered frame ends.
 */
interface AudioClock {
    at(pos: number, skip: number): number | undefined;
    readonly end: number;
}

/** Whether the transport location (`pos`, `skip`) comes after (`otherPos`, `otherSkip`). */
function locatedAfter(pos: number, skip: number, otherPos: number, otherSkip: number): boolean {
    return pos > otherPos || (pos === otherPos && skip > otherSkip);
}

/** The audio frames of one track a window read, in rising transport location, with their times. */
class AudioFrameTimes {
    private readonly positions: number[] = [];
    private readonly skips: number[] = [];
    private readonly times: number[] = [];

    add(pos: number, skip: number, time: number): void {
        this.positions.push(pos);
        this.skips.push(skip);
        this.times.push(time);
    }

    /** The time of the frame at (`pos`, `skip`), if the window read one there. */
    at(pos: number, skip: number): number | undefined {
        let low = 0;
        let high = this.positions.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (locatedAfter(pos, skip, this.positions[middle]!, this.skips[middle]!))
                low = middle + 1;
            else high = middle;
        }
        return this.positions[low] === pos && this.skips[low] === skip
            ? this.times[low]
            : undefined;
    }
}

/**
 * The head window ends before every stream has samples (or the video its parameter sets): a larger
 * one is read.
 */
class ProbeWindowShort extends Error {}

/**
 * Positions between the head and the tail whose decode times must rise for the probe's span to
 * hold.
 */
const PROBE_CHECKS = 16;

/**
 * The decode time (else presentation time) of the first PES of `pid` that starts in [from, end),
 * raw 90 kHz ticks.
 */
async function firstPesTime(
    source: Source,
    from: number,
    end: number,
    stride: number,
    payOff: number,
    pid: number,
): Promise<number | undefined> {
    // Up to 2048 packets are searched: the first 64, which most often hold one, then the rest.
    for (let first = 0, count = 64; first < 2048; first += count, count = 2048 - first) {
        const at = from + first * stride;
        const bytes = await source.read(at, Math.max(0, Math.min(end - at, count * stride)));
        for (let next = 0; next + stride <= bytes.length; next += stride) {
            const packet = bytes.subarray(next + payOff, next + payOff + TS_PACKET);
            if (packet[0] !== 0x47) return undefined;
            if ((((packet[1]! & 0x1f) << 8) | packet[2]!) !== pid || (packet[1]! & 0x40) === 0)
                continue;
            const control = (packet[3]! >> 4) & 3;
            const offset = (control & 2) !== 0 ? 5 + packet[4]! : 4;
            const pes = packet.subarray(offset);
            if (
                (control & 1) === 0 ||
                pes.length < 19 ||
                pes[0] !== 0 ||
                pes[1] !== 0 ||
                pes[2] !== 1
            )
                return undefined;
            const flags = pes[7]! >> 6;
            if (flags < 2) return undefined;
            return (
                (flags === 3 ? readPesTimestamp(pes, 14, 1) : readPesTimestamp(pes, 9, 2)) ??
                undefined
            );
        }
        if (bytes.length < count * stride) return undefined;
    }
    return undefined;
}

/** Reports damage or an omission read past, as a recovery or as a warning only. */
function tsNote(
    diagnostics: DiagnosticContext,
    kind: 'recover' | 'warn',
    code: string,
    message: string,
): void {
    diagnostics[kind]({ code, format: 'ts', message });
}

/** Warnings of a stream's window that only say a track has no sample in it. */
const WINDOW_ONLY_WARNINGS = new Set(['TS_EMPTY_STREAM', 'TS_AUDIO_UNFRAMED']);

/**
 * The samples of the video access units `pes` on the timeline `shiftTicks` starts, each a keyframe
 * as `keyframe` tells (asked in order).
 */
function pesSamples(
    pes: readonly PesEntry[],
    shiftTicks: number,
    budget: DemuxIndexBudget,
    keyframe: (entry: PesEntry) => boolean,
    annexB = false,
): Sample[] {
    const durations = decodeDurations(pes.map(entry => entry.dts));
    return pes.map((entry, index) => {
        const isKeyframe = keyframe(entry);
        budget.reserveSamples(1, 256, 'TS video sample index');
        const decodeTimestamp = (entry.dts - shiftTicks) / 90000;
        const timestamp = (entry.pts - shiftTicks) / 90000;
        return {
            offset: 0,
            size: entry.data.length,
            timestamp,
            duration: durations[index]!,
            isKeyframe,
            decodeTimestamp,
            compositionTimeOffset: timestamp - decodeTimestamp,
            data: entry.data,
            ...(annexB ? { nalUnitFormat: 'annexb' as const } : {}),
        };
    });
}

/** Earliest first presentation time of the tracks, in seconds. */
function programStart(result: DemuxResult): number {
    return Math.min(
        ...[...result.videoTracks, ...result.audioTracks].map(
            track => sampleAt(track, 0)?.timestamp ?? Infinity,
        ),
    );
}

/** MPEG-TS demuxer (33-bit PTS unwrap, PES-declared lengths, CC checks). */
export class TsDemuxer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly limits: ResolvedDemuxBudget;
    private runs = new Map<TrackInfo, SegmentRuns>();
    /**
     * Where the program of the last demux ends: the latest end of a track, in seconds on the
     * input's clock.
     */
    private programEnd = 0;
    /** Where the scan of the program tables stopped. */
    private tablesEnd = 0;
    /**
     * Bytes of an audio frame that continues in the next PES, per track, with the location of their
     * first byte.
     */
    private audioCarry = new Map<TrackInfo, AudioCarry>();
    /**
     * Samples keep transport locations instead of their bytes (requested with the engine's compact
     * indexes).
     */
    private packetized = false;
    /** How the samples of the demux in progress keep their bytes. */
    private keeping: TsSampleKeeping = 'held';
    /** Where the PES readers assemble PES: a stream's window arena, else new bytes. */
    declare private allocate?: (length: number) => Uint8Array;
    /** StreamMuxConfig state of each LATM track. */
    private latm = new Map<TrackInfo, LatmReader>();
    /** Audio tracks ended at a configuration change under compatible validation. */
    private ended = new Set<TrackInfo>();
    /** Audio tracks whose carried bytes begin a frame the stream has not completed yet. */
    private openFrames = new Set<TrackInfo>();
    /** Bytes of each audio track's last frame, which packetized samples do not hold. */
    private lastAudioFrame = new Map<TrackInfo, Uint8Array>();
    /**
     * Audio tracks whose frames so far came without a PES time: the first timed frame places them
     * before it.
     */
    private untimedAudio = new Set<TrackInfo>();
    /** Audio tracks a stream's window continues: the clock its earlier windows left. */
    private carriedClocks = new Map<TrackInfo, AudioClock>();

    constructor(options: DemuxBudgetOptions = {}) {
        this.limits = resolveDemuxBudget(options, 2_000_000);
    }

    /**
     * Parses the container with windowed reads and returns tracks plus encoded samples; honors
     * `signal`.
     */
    async demux(
        input: File | Blob | Source,
        signal?: AbortSignal,
        diagnostics = new DiagnosticContext(),
    ): Promise<DemuxResult> {
        return this.demuxImpl(input, signal, diagnostics);
    }

    /**
     * The tracks and duration of an input from its head and tail: the head gives the tracks and
     * their first times, the tail the end of the program, and decode times read at evenly spaced
     * positions between them must rise without a splice or a clock wrap. The tracks hold the head's
     * samples only. Undefined when the input is damaged, spliced or otherwise needs a full read,
     * which then gives the same tracks.
     */
    async probe(
        source: Source,
        signal?: AbortSignal,
        diagnostics = new DiagnosticContext(),
        target: ProbeTarget = {},
    ): Promise<ProbedInput | undefined> {
        const size = source.size;
        const layout = probeTsLayout(await source.read(0, Math.min(size, 2048)));
        if (!layout) return undefined;
        const { stride, off } = layout;
        const payOff = stride === 192 ? 4 : 0;
        const aligned = (position: number): number =>
            off + Math.floor((position - off) / stride) * stride;

        // When the first head and tail windows meet, the probe would read the whole input: a full
        // read reads it once.
        if (aligned(size - PROBE_WINDOWS.first) <= aligned(Math.min(PROBE_WINDOWS.first, size / 4)))
            return undefined;
        const run = async (
            input: Source,
            window: TsWindow,
            runSignal = signal,
        ): Promise<{
            result: DemuxResult;
            diagnostics: DiagnosticContext;
            end: number;
            tables: number;
        }> => {
            const demuxer = new TsDemuxer(this.limits);
            if (this.packetized || usesCompactSampleIndex(this)) enableCompactSampleIndex(demuxer);
            const context = diagnostics.fresh();
            const result = await demuxer.demuxImpl(input, runSignal, context, window);
            return {
                result,
                diagnostics: context,
                end: demuxer.programEnd,
                tables: demuxer.tablesEnd,
            };
        };
        try {
            let head: Awaited<ReturnType<typeof run>> | undefined;
            let headWindow: TsWindow = { head: true };
            let headEnd = 0;
            for (
                let bytes = PROBE_WINDOWS.first;
                !head && bytes <= PROBE_WINDOWS.last;
                bytes *= 4
            ) {
                headEnd = aligned(Math.min(bytes, size / 4));
                headWindow = { head: true, psi: [] };
                try {
                    head = await run(new RangeSource(source, 0, headEnd), headWindow);
                } catch (error) {
                    if (!(error instanceof ProbeWindowShort)) throw error;
                }
            }
            if (!head || head.diagnostics.warnings.length || !headWindow.psi?.length)
                return undefined;
            const program = [...head.result.videoTracks, ...head.result.audioTracks];
            const pid = (program[0] && trackPids.get(program[0])) ?? -1;
            if (pid < 0) return undefined;
            // A window alone (ProbeTarget.windowOnly) needs no tail: its decode time bounds the
            // search.
            const untailed =
                target.windowOnly === true && target.around !== undefined && !target.range;
            let tail: Awaited<ReturnType<typeof run>> | undefined;
            let tailStart = Math.max(headEnd, aligned(size - PROBE_WINDOWS.first));
            for (
                let bytes = PROBE_WINDOWS.first;
                !untailed && bytes <= PROBE_WINDOWS.last;
                bytes *= 4
            ) {
                tailStart = Math.max(headEnd, aligned(size - bytes));
                const psi = new BufferSource(concatBytes(headWindow.psi), { copy: false });
                tail = await run(new ConcatSource([psi, new RangeSource(source, tailStart)]), {
                    parameterSets: headWindow.parameterSets,
                }).catch(probeMiss);
                const tracks = tail && [...tail.result.videoTracks, ...tail.result.audioTracks];
                if (
                    tail &&
                    !tail.diagnostics.warnings.length &&
                    tracks!.length === program.length &&
                    tracks!.every((track, index) => track.codec === program[index]!.codec)
                )
                    break;
                tail = undefined;
            }
            if (!tail && !untailed) return undefined;

            // Decode times between the head and the tail rise without a splice or a wrap of the
            // 33-bit clock.
            const timeAt = (position: number): Promise<number | undefined> =>
                firstPesTime(source, position, size, stride, payOff, pid);
            const first = await timeAt(off);
            if (first === undefined) return undefined;
            const checks = [{ position: off, time: first }];
            for (let check = 1; check <= PROBE_CHECKS + 1; check++) {
                const position =
                    check > PROBE_CHECKS
                        ? tailStart
                        : aligned(headEnd + ((tailStart - headEnd) * check) / (PROBE_CHECKS + 1));
                const time = await timeAt(position);
                throwIfAborted(signal);
                if (time === undefined || time < checks.at(-1)!.time - SPLICE_BACKWARD_TICKS)
                    return undefined;
                checks.push({ position, time });
            }

            // The duration a full read gives: the latest end of a track in the tail less the
            // earliest start in the head.
            const span = { start: programStart(head.result) };
            const ends = tail?.end ?? Infinity;
            if (
                !Number.isFinite(span.start) ||
                (tail && !Number.isFinite(ends)) ||
                ends < span.start
            )
                return undefined;
            const duration = Math.max(0, ends - span.start);

            // A stream the input ends inside a frame of was cut, as a full read reports; the tail
            // tells.
            const ended = tail
                ? [...tail.result.videoTracks, ...tail.result.audioTracks].map(
                      track => track.incomplete === true,
                  )
                : [];
            const settle = (tracks: readonly TrackInfo[]): void =>
                tracks.forEach((track, index) => {
                    if (!tail) return;
                    track.duration = duration;
                    if (ended[index]) track.incomplete = true;
                });
            settle(program);
            const streamed = (): ProbedInput => ({
                result: head.result,
                packets: false,
                start: span.start,
                stream: (streamSignal, warn) =>
                    this.streamSamples(
                        source,
                        program,
                        headWindow,
                        { stride, off },
                        diagnostics,
                        streamSignal,
                        warn,
                    ),
            });
            // The head's result becomes the tracks of one file: a later window in the head demuxes
            // it again.
            let headTaken = false;
            const headResult = async (windowSignal?: AbortSignal): Promise<DemuxResult> => {
                if (!headTaken) {
                    headTaken = true;
                    return head!.result;
                }
                return (
                    await run(new RangeSource(source, 0, headEnd), { head: true }, windowSignal)
                ).result;
            };

            // The windows read the program tables at the start of the input from what the head
            // read of them, held, and nothing else before their packets.
            const tablesEnd = Math.min(size, Math.max(head.tables, 2048));
            let heldTables: WindowReader | undefined;
            const tables = (from: number): ByteReader | undefined =>
                from <= tablesEnd
                    ? undefined
                    : (heldTables ??= new WindowReader(
                          tablesEnd,
                          uncachedReads(source),
                          tablesEnd,
                      ));
            // Whether each video track of the head holds a keyframe.
            const keyed = head.result.videoTracks.every(track => {
                for (let index = 0, count = sampleCount(track); index < count; index++)
                    if (sampleAt(track, index)!.isKeyframe) return true;
                return false;
            });
            /** The probe of `next` from the head, the tail and the checks read so far. */
            const probeOf = async (
                next: ProbeTarget,
                windowSignal = signal,
            ): Promise<ProbedInput | undefined> => {
                const { around, through = around, range, stream } = next;
                if (!stream && around === undefined && range === undefined) {
                    headTaken = true;
                    return {
                        result: head!.result,
                        packets: false,
                        start: span.start,
                        window: probeOf,
                    };
                }
                // Video whose head holds no keyframe may have no IDR picture at all: a read of the
                // whole stream then enters it at its recovery points, which no window or pass can
                // tell (H264TrackBuilder).
                if (!keyed) return undefined;
                if (stream && around === undefined) return streamed();
                const window = await this.probeWindow(
                    source,
                    head!.result,
                    headWindow,
                    checks,
                    // A picture after the end of the program is its last.
                    range
                        ? {
                              start: span.start + range.start,
                              end: span.start + (range.end ?? Infinity),
                          }
                        : {
                              start: Math.min(span.start + around!, ends),
                              end: span.start + through!,
                          },
                    range === undefined ? 'around' : range.fromStart ? 'start' : 'copy',
                    {
                        aligned,
                        timeAt,
                        run: (input, window) => run(input, window, windowSignal),
                        tailStart,
                        headResult: () => headResult(windowSignal),
                        tables,
                    },
                    stream === true,
                );
                if (window === 'stream') return streamed();
                if (!window) return stream ? streamed() : undefined;
                settle([...window.result.videoTracks, ...window.result.audioTracks]);
                return {
                    result: window.result,
                    packets: true,
                    start: span.start,
                    fromStart: window.fromStart,
                    end: window.end ?? headEnd,
                };
            };
            return await probeOf(target);
        } catch (error) {
            return probeMiss(error);
        }
    }

    /**
     * The samples of `span` (packet-layer seconds): the head when it holds them, else whole
     * transport packets from before the keyframe preceding the start to after the end, placed by
     * searching the decode times of the first track's PID between the probe's checks. Windows grow
     * fourfold until that track has a keyframe at or before the start (or the window starts the
     * input) and a sample after the end (or the window ends the input); undefined when they never
     * do. The window of a copy starts at the start of the input when the program has audio, and
     * that of a conversion (`start`) always does; `fromStart` tells whether the window starts the
     * input.
     */
    private async probeWindow(
        source: Source,
        head: DemuxResult,
        headWindow: TsWindow,
        checks: { readonly position: number; readonly time: number }[],
        span: { readonly start: number; readonly end: number },
        reads: 'around' | 'copy' | 'start',
        probe: {
            readonly aligned: (position: number) => number;
            readonly timeAt: (position: number) => Promise<number | undefined>;
            readonly run: (
                input: Source,
                window: TsWindow,
            ) => Promise<{ result: DemuxResult; diagnostics: DiagnosticContext }>;
            readonly tailStart: number;
            /** The head's samples, for a window inside it. */
            readonly headResult: () => Promise<DemuxResult>;
            /** The program tables for a window from `from`, where it starts after them. */
            readonly tables: (from: number) => ByteReader | undefined;
        },
        streams = false,
    ): Promise<
        | { readonly result: DemuxResult; readonly fromStart: boolean; readonly end?: number }
        | 'stream'
        | undefined
    > {
        const windows = spanWindows(head, span);
        if (!windows) return undefined;
        if (windows.inHead) return { result: await probe.headResult(), fromStart: true };
        const { covers } = windows;
        const size = source.size;
        /**
         * The aligned position whose first PES of the video decodes at or before `ticks`, searched
         * in [low, high); the decode times it reads join the checks, for the windows after it.
         */
        const positionOf = async (ticks: number): Promise<number> => {
            let index = checks.findIndex(check => check.time > ticks);
            if (index === 0) return checks[0]!.position;
            if (index < 0) index = checks.length;
            const below = checks[index - 1]!;
            const above = checks[index];
            // Each probe reads where the decode times known on each side place `ticks`
            // (narrowToPosition: PES times are whole ticks, so a time before the next whole one is
            // at or before `ticks`).
            const found = await narrowToPosition(
                {
                    from: below.position,
                    to: above?.position ?? size,
                    fromPosition: below.time,
                    toPosition: above?.time ?? below.time,
                },
                Math.floor(ticks) + 1,
                256 * 1024,
                Infinity,
                async at => {
                    const position = probe.aligned(at);
                    const time = await probe.timeAt(position);
                    if (time === undefined) return undefined;
                    const before = checks[index - 1]!;
                    if (
                        position > before.position &&
                        time >= before.time &&
                        time <= (checks[index]?.time ?? Infinity)
                    ) {
                        checks.splice(index, 0, { position, time });
                        if (time <= ticks) index++;
                    }
                    return { offset: position, position: time };
                },
                (first, second) => first.position <= second.position,
            );
            return found?.from ?? below.position;
        };

        // An audio frame's time continues the frames before it while its PES time falls inside the
        // previous frame, so a read of the whole input times it from every PES since the start:
        // audio is read from there.
        const fromStart = reads === 'start' || (reads === 'copy' && head.audioTracks.length > 0);
        // A window around a time reads from a second before it to a second after it.
        const around = reads === 'around';
        for (let seconds = around ? 1 : 2; seconds <= 128; seconds *= 4) {
            const from = fromStart
                ? checks[0]!.position
                : await positionOf((span.start - seconds) * 90000);
            if (streams && from === checks[0]!.position) return 'stream';
            // The window ends past where the search places the PES that decodes the seconds after
            // the span (to 256 KiB): half a megabyte around a time, a megabyte for a copy.
            const to = Number.isFinite(span.end)
                ? Math.min(
                      size,
                      probe.aligned(
                          (await positionOf((span.end + seconds) * 90000)) +
                              (around ? 512 * 1024 : CHUNK_BYTES),
                      ),
                  )
                : size;
            const end = to >= probe.tailStart ? size : to;
            const window = await probe
                .run(new RangeSource(source, 0, end), {
                    head: end < size,
                    from,
                    parameterSets: headWindow.parameterSets,
                    tables: probe.tables(from),
                })
                .catch(error => (error instanceof ProbeWindowShort ? undefined : probeMiss(error)));
            if (!window || window.diagnostics.warnings.length) continue;
            const track = window.result.videoTracks[0] ?? window.result.audioTracks[0];
            const starts = from === checks[0]!.position;
            if (track && covers(track, starts, end === size))
                return { result: window.result, fromStart: starts, end };
        }
        return undefined;
    }

    /**
     * Every sample of the program in one pass, window after window from the start of the input.
     * Each window is read once and demuxed; the next starts where samples were left incomplete (a
     * PES still gathering, an audio frame carried into the next PES) or at the last sample of a
     * track, which waits for the sample that gives its duration. Samples delivered by an earlier
     * window are skipped by decode time. A sample names the position of its track in `program`, the
     * probe's tracks.
     */
    private async *streamSamples(
        source: Source,
        program: readonly TrackInfo[],
        headWindow: TsWindow,
        layout: { readonly stride: number; readonly off: number },
        diagnostics: DiagnosticContext,
        signal?: AbortSignal,
        warn?: Warn,
    ): AsyncGenerator<readonly StreamedSample[]> {
        const size = source.size;
        const aligned = (position: number): number =>
            layout.off + Math.floor((position - layout.off) / layout.stride) * layout.stride;
        const keyOf = (tracks: readonly TrackInfo[], track: TrackInfo): string => {
            const pid = trackPids.get(track);
            return `${pid}:${tracks.filter(other => trackPids.get(other) === pid).indexOf(track)}`;
        };
        const keys = program.map(track => keyOf(program, track));
        const windows = new ForwardWindows(source, CHUNK_BYTES, WINDOW_BYTES);
        try {
            /** The decode time of each track's latest delivered sample. */
            const delivered = program.map(() => Number.NEGATIVE_INFINITY);
            /** The transport location of each audio track's latest delivered frame. */
            const deliveredAt = program.map(() => ({ pos: -1, skip: -1 }));
            /** The audio frames the latest window read, whose times a frame read again keeps. */
            let frameTimes = program.map(() => new AudioFrameTimes());
            /** Where the latest delivered frame of each audio track ends. */
            const clocks: (number | undefined)[] = program.map(() => undefined);
            const warned = new Set<string>();
            let from = layout.off;
            let span = WINDOW_BYTES;
            for (;;) {
                throwIfAborted(signal);
                const final = from + span >= size;
                const end = final ? size : aligned(from + span);
                const audioClocks = new Map<number, AudioClock>();
                program.forEach((track, position) => {
                    const pid = trackPids.get(track);
                    const end = clocks[position];
                    const times = frameTimes[position]!;
                    if (pid !== undefined && end !== undefined && !track.width)
                        audioClocks.set(pid, { at: (pos, skip) => times.at(pos, skip), end });
                });
                const window: TsWindow = {
                    head: !final,
                    from,
                    parameterSets: headWindow.parameterSets,
                    stream: true,
                    audioClocks,
                    allocate: length => windows.arena.allocate(length),
                };
                const input = await windows.window(from, end);
                const demuxer = new TsDemuxer(this.limits);
                enableCompactSampleIndex(demuxer);
                const context = diagnostics.fresh();
                const result = await demuxer.demuxImpl(input, signal, context, window);
                for (const warning of context.warnings)
                    if (!WINDOW_ONLY_WARNINGS.has(warning.code) && !warned.has(warning.code)) {
                        warned.add(warning.code);
                        warn?.(warning);
                    }
                const tracks = [...result.videoTracks, ...result.audioTracks];

                // One item per sample to deliver; `windowTracks` holds the window's track at each
                // program position.
                const items: { track: number; sample: Sample; codecConfig?: Uint8Array }[] = [];
                const windowTracks: TrackInfo[] = [];
                frameTimes = program.map(() => new AudioFrameTimes());
                let resume = window.resume ?? Infinity;
                for (const track of tracks) {
                    const position = keys.indexOf(keyOf(tracks, track));
                    if (position < 0) continue;
                    windowTracks[position] = track;
                    const codecConfig = track.codecConfig;
                    const times = frameTimes[position]!;
                    const last = deliveredAt[position]!;
                    for (let index = 0, count = sampleCount(track); index < count; index++) {
                        const sample = sampleAt(track, index)!;
                        if (!final && index === count - 1) {
                            resume = Math.min(
                                resume,
                                sample.packetSkip === undefined ? from : sample.offset,
                            );
                            break;
                        }

                        // Audio frames are known by their transport location: the window continues
                        // their clock, so a frame read again has the time it was delivered at.
                        const located = !track.width && sample.packetSkip !== undefined;
                        if (located) times.add(sample.offset, sample.packetSkip!, sample.timestamp);
                        if (
                            located
                                ? locatedAfter(
                                      sample.offset,
                                      sample.packetSkip!,
                                      last.pos,
                                      last.skip,
                                  )
                                : decodeTime(sample) > delivered[position]!
                        )
                            items.push({ track: position, sample, codecConfig });
                    }
                }
                items.sort((a, b) => decodeTime(a.sample) - decodeTime(b.sample));
                for (const item of items) {
                    const { track: position, sample } = item;
                    const track = windowTracks[position]!;
                    sample.data ??= await readSampleBytes(track, sample, input, signal);
                    delivered[position] = decodeTime(sample);
                    if (!track.width) {
                        clocks[position] = sample.timestamp + sample.duration;
                        if (sample.packetSkip !== undefined) {
                            deliveredAt[position]!.pos = sample.offset;
                            deliveredAt[position]!.skip = sample.packetSkip;
                        }
                    }
                }
                const batch = items as StreamedSample[];
                for (const track of tracks) releaseSampleIndex(track);
                yield batch;
                if (final) return;
                const next = aligned(Number.isFinite(resume) ? resume : end);
                if (next > from) {
                    from = next;
                    span = WINDOW_BYTES;
                } else if ((span *= 2) > MAX_WINDOW_BYTES)
                    throw new DemuxError(
                        `MPEG-TS stream completes no sample within ${MAX_WINDOW_BYTES} bytes of ` +
                            `byte ${from}`,
                    );
            }
        } finally {
            windows.close();
        }
    }

    private async demuxImpl(
        input: File | Blob | Source,
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
        window: TsWindow = {},
    ): Promise<DemuxResult> {
        const budget = new DemuxIndexBudget(this.limits);
        this.packetized = usesCompactSampleIndex(this);
        this.keeping = window.stream ? 'both' : this.packetized ? 'located' : 'held';
        this.allocate = window.allocate;
        const checkAbort = (): void => {
            throwIfAborted(signal);
        };
        checkAbort();
        const ts = await this.openTransport(input, diagnostics, window, budget, checkAbort);
        const psi = await this.scanProgramTables(ts);
        const chosen = await this.chooseProgram(ts, psi);
        const video = this.videoPipeline(ts, chosen);
        const program = psi.programs[psi.candidates.indexOf(chosen)];
        const lateStreams = await this.walkPackets(ts, chosen, program, video.reader);
        await this.endReaders(ts, chosen, video);
        checkAbort();
        const { videoStreamType, audioStreams } = chosen;
        const mpegSyntax: MpegVideoSyntax | null =
            videoStreamType === 0x10
                ? 'mpeg4'
                : videoStreamType === 0x01 || videoStreamType === 0x02
                  ? 'mpeg12'
                  : null;
        const videoPes =
            mpegSyntax || video.streamed
                ? []
                : videoStreamType === STREAM_TYPE_AV1
                  ? video.reader.entries.filter(entry => entry.data.length > 0)
                  : this.joinVideoContinuations(video.reader.entries);
        const mpegFrames = mpegSyntax
            ? this.splitMpegVideo(mpegSyntax, video.reader.entries, diagnostics)
            : [];
        const videoUnits = videoPes.length + mpegFrames.length + (video.streamed?.units ?? 0);

        if (
            window.head &&
            !window.stream &&
            ((chosen.videoPid >= 0 && videoUnits === 0) ||
                [...audioStreams.values()].some(stream => countOf(stream.track) === 0))
        )
            throw new ProbeWindowShort();
        if (
            window.stream &&
            videoUnits === 0 &&
            [...audioStreams.values()].every(
                stream => countOf(stream.track) === 0 && !stream.core?.samples.length,
            )
        )
            return { videoTracks: [], audioTracks: [] };
        this.omitEmptyStreams(ts, chosen, lateStreams, videoUnits);

        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        const videoTrack =
            mpegSyntax && mpegFrames.length > 0
                ? this.mpegVideoTrack(ts, chosen, mpegSyntax, mpegFrames)
                : video.streamed || videoPes.length > 0
                  ? this.codedVideoTrack(ts, chosen, video.streamed, videoPes)
                  : undefined;
        if (videoTrack) result.videoTracks.push(videoTrack);
        if (window.head && video.streamed) window.parameterSets = video.streamed.parameterNals;
        for (const track of result.videoTracks) trackPids.set(track, chosen.videoPid);
        if (video.reader.cut) for (const track of result.videoTracks) track.incomplete = true;
        for (const [pid, stream] of audioStreams) {
            // A stream ending inside a frame was cut.
            if (!window.head && (stream.reader.cut || this.openFrames.has(stream.track))) {
                stream.track.incomplete = true;
                if (stream.core) stream.core.incomplete = true;
            }
            trackPids.set(stream.track, pid);
            if (countOf(stream.track)) result.audioTracks.push(stream.track);
            if (stream.core?.samples.length) result.audioTracks.push(stream.core);
            if (tables.get(stream.track)?.located)
                bindPacketizedReader(stream.track, new TsSampleReader(pid, ts.stride, ts.payOff));
        }
        this.finishProgram(ts, result);
        return result;
    }

    /**
     * The packet layout of the input (sync offset, stride, a truncated tail) and the state one
     * demux reads it with.
     */
    private async openTransport(
        input: File | Blob | Source,
        diagnostics: DiagnosticContext,
        window: TsWindow,
        budget: DemuxIndexBudget,
        checkAbort: () => void,
    ): Promise<TsTransport> {
        const source = input instanceof Blob ? new BlobSource(input) : input;
        const reader = window.tables
            ? new WindowBytes(window.tables, source, window.from!)
            : new ChunkReader(source, CHUNK_BYTES, true);
        const size = reader.size;

        const headBytes = await reader.bytes(0, Math.min(size, 2048));
        const layout = probeTsLayout(headBytes);
        if (!layout) {
            throw new DemuxError('No MPEG-TS sync byte in the first 1 KiB');
        }
        const stride = layout.stride;
        const syncOff = layout.off;
        const tailRemainder = (size - syncOff) % stride;
        if (tailRemainder !== 0) {
            diagnostics.recover({
                code: 'TS_TRUNCATED_PACKET',
                format: 'ts',
                offset: size - tailRemainder,
                message: `Ignored ${tailRemainder} bytes after the last whole TS packet`,
            });
        }
        const timeline = new ProgramTimeline(diagnostics);
        this.runs = new Map();
        this.audioCarry = new Map();
        this.latm = new Map();
        this.ended = new Set();
        this.openFrames = new Set();
        this.lastAudioFrame = new Map();
        this.untimedAudio = new Set();
        this.carriedClocks = new Map();
        return {
            reader,
            size,
            stride,
            payOff: stride === 192 ? 4 : 0,
            syncOff,
            tailRemainder,
            diagnostics,
            lenient: diagnostics.validation === 'compatible',
            budget,
            timeline,
            window,
            checkAbort,
            bytes: new Uint8Array(0),
            windowStart: 0,
        };
    }

    /**
     * The programs of the PAT and the streams of their PMTs, read until the first program's PMT is
     * usable or every PMT was read.
     */
    private async scanProgramTables(ts: TsTransport): Promise<TsProgramTables> {
        const { reader, size, stride, payOff, diagnostics, lenient, window } = ts;
        let patSeen = false;
        const programs: TsProgram[] = [];
        const candidates: (TsProgramStreams | null | undefined)[] = [];
        const patReader = new PsiSectionReader();
        let scanned = 0;
        let pos = ts.syncOff;
        for (; pos + stride <= size; pos += stride) {
            if ((scanned & 0x0fff) === 0) {
                await yieldEventLoop();
                ts.checkAbort();
            }
            scanned++;

            // The first listed program is read as soon as its PMT is usable; the others only stand
            // in for it.
            if (
                usableProgram(candidates[0]) ||
                (programs.length > 0 &&
                    candidates.filter(c => c !== undefined).length === programs.length)
            )
                break;
            if (pos + stride > ts.windowStart + ts.bytes.length) {
                ts.windowStart = pos;
                ts.bytes = await reader.bytes(pos, windowLength(pos, size, stride));
            }
            const bytes = ts.bytes;
            const windowStart = ts.windowStart;
            const pkt = bytes.subarray(
                pos - windowStart + payOff,
                pos - windowStart + payOff + TS_PACKET,
            );
            if (pkt[0] !== 0x47) continue;

            const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
            if (window.psi && (pid === 0 || programs.some(item => item.pid === pid)))
                window.psi.push(bytes.slice(pos - windowStart, pos - windowStart + stride));
            if (pid === 0 && !patSeen) {
                for (const sect of patReader.readSections(pkt, diagnostics)) {
                    if (sect.length < 12 || sect[0] !== 0 || !(sect[5]! & 1)) continue;
                    if (!this.validSection(sect, lenient, diagnostics)) continue;
                    const end = sect.length - 4;
                    demuxAssert((end - 8) % 4 === 0, 'TS PAT program loop is truncated');
                    for (let off = 8; off < end; off += 4) {
                        const program = (sect[off]! << 8) | sect[off + 1]!;
                        const programPid = ((sect[off + 2]! & 0x1f) << 8) | sect[off + 3]!;
                        if (program === 0 || programs.some(item => item.pid === programPid))
                            continue;
                        programs.push({
                            number: program,
                            pid: programPid,
                            reader: new PsiSectionReader(),
                        });
                    }
                    patSeen = programs.length > 0;
                }
                continue;
            }
            const index = programs.findIndex(item => item.pid === pid);
            if (index < 0 || candidates[index] !== undefined) continue;
            for (const sect of programs[index]!.reader.readSections(pkt, diagnostics)) {
                if (
                    sect.length < 16 ||
                    sect[0] !== 2 ||
                    !(sect[5]! & 1) ||
                    ((sect[3]! << 8) | sect[4]!) !== programs[index]!.number
                )
                    continue;
                try {
                    if (!this.validSection(sect, lenient, diagnostics)) continue;
                    const streams = this.parsePmtStreams(sect, diagnostics, ts.budget, ts.timeline);
                    streams.crc = sectionCrc(sect);
                    candidates[index] = streams;
                } catch (error) {
                    if (index === 0 || !(error instanceof DemuxError)) throw error;
                    candidates[index] = null;
                }
                break;
            }
        }
        this.tablesEnd = pos;
        return { patSeen, programs, candidates };
    }

    /**
     * The program read: the first usable one of the PAT, else streams found from their PES
     * packets (compatible validation), with the warnings of streams and programs passed over.
     */
    private async chooseProgram(
        ts: TsTransport,
        { patSeen, programs, candidates }: TsProgramTables,
    ): Promise<TsProgramStreams> {
        const { diagnostics } = ts;
        let chosen = candidates.find(usableProgram) ?? candidates.find(candidate => !!candidate);
        if (!chosen && ts.lenient) {
            // Without a PAT or a PMT, streams are found from their PES headers and payloads, as
            // ffmpeg does.
            const section = await orphanStreamsSection(
                ts.reader,
                ts.syncOff,
                ts.size,
                ts.stride,
                ts.payOff,
                ts.checkAbort,
            );
            if (section) {
                chosen = this.parsePmtStreams(section, diagnostics, ts.budget, ts.timeline);
                diagnostics.recover({
                    code: 'TS_PSI_MISSING',
                    format: 'ts',
                    message: patSeen
                        ? 'MPEG-TS PMT is missing; streams were found from their packets'
                        : 'MPEG-TS has no PAT; streams were found from their packets',
                });
            }
        }

        if (!patSeen && !chosen) throw new DemuxError('MPEG-TS contains no PAT');
        if (!chosen) throw new DemuxError('MPEG-TS PAT points to a PMT that never appears');
        const { videoPid, audioStreams } = chosen;
        for (const [pid, stream] of audioStreams) {
            const clock = ts.window.audioClocks?.get(pid);
            if (clock) this.carriedClocks.set(stream.track, clock);
        }

        if (videoPid < 0 && audioStreams.size === 0) {
            throw new DemuxError(
                chosen.unsupported.length
                    ? `MPEG-TS holds no supported video or audio stream; unsupported ` +
                          `${chosen.unsupported.join('; ')}`
                    : 'MPEG-TS PMT declares no supported video or audio stream',
            );
        }

        for (const message of chosen.unsupported)
            tsNote(
                diagnostics,
                'warn',
                'TS_UNSUPPORTED_STREAM',
                `Skipped MPEG-TS ${message}: its codec is not supported`,
            );

        if (chosen !== candidates[0] && candidates.includes(chosen))
            tsNote(
                diagnostics,
                'warn',
                'TS_PROGRAM_SELECTED',
                `Read program ${programs[candidates.indexOf(chosen)]!.number}: the first has no ` +
                    `usable PMT`,
            );

        return chosen;
    }

    /**
     * The reader of the video PID and what it feeds: H.264 and H.265 units are indexed as they
     * arrive; packetized samples leave their bytes in the input.
     */
    private videoPipeline(ts: TsTransport, chosen: TsProgramStreams): TsVideoPipeline {
        const { window, budget } = ts;
        const { videoPid, videoStreamType, audioStreams } = chosen;
        const video: VideoTrackOptions = {
            keeping: this.keeping,
            parameterSets: window.parameterSets,
            ownsUnits: true,
        };

        const streamed =
            videoStreamType === 0x1b
                ? new H264TrackBuilder(budget, {
                      ...video,
                      recoveryKeys:
                          window.head === undefined && window.from === undefined && !window.stream,
                  })
                : videoStreamType === 0x24
                  ? new H265TrackBuilder(budget, video)
                  : undefined;

        const splitter =
            streamed &&
            new AccessUnitSplitter(videoStreamType === 0x24, unit => streamed.push(unit));
        const joiner = splitter && new VideoUnitJoiner(unit => splitter.push(unit));
        const reader = new PesPacketReader(
            true,
            ts.diagnostics,
            budget,
            ts.timeline,
            joiner && (entry => joiner.push(entry)),
        );

        if (this.allocate) reader.allocate = this.allocate;
        demuxAssert(!audioStreams.has(videoPid), 'TS PMT assigns the same PID to video and audio');
        demuxAssert(
            audioStreams.size + (videoPid >= 0 ? 1 : 0) <= DEMUX_LIMITS.maxTracks,
            'TS PMT exceeds the track limit',
        );
        return { streamed, splitter, joiner, reader };
    }

    /**
     * Reads every packet of the chosen streams from the start of the window, resynchronising after
     * damage. A PMT update can add audio streams (a broadcast switching programme); they become
     * further tracks from the update on, as in ffmpeg, and are returned. The video PID stays the
     * first one.
     */
    private async walkPackets(
        ts: TsTransport,
        chosen: TsProgramStreams,
        program: TsProgram | undefined,
        videoReader: PesPacketReader,
    ): Promise<Set<number>> {
        const { reader, size, stride, payOff, diagnostics, lenient } = ts;
        const { videoPid, audioStreams } = chosen;
        const pmtReader = new PsiSectionReader();
        const lateStreams = new Set<number>();
        let pmtCrc = chosen.crc;
        const updatePmt = (packet: Uint8Array): void => {
            for (const sect of pmtReader.readSections(packet, diagnostics)) {
                if (
                    sect.length < 16 ||
                    sect[0] !== 2 ||
                    !(sect[5]! & 1) ||
                    ((sect[3]! << 8) | sect[4]!) !== program!.number ||
                    sectionCrc(sect) === pmtCrc ||
                    !this.validSection(sect, lenient, diagnostics)
                )
                    continue;

                pmtCrc = sectionCrc(sect);
                let update: TsProgramStreams;
                try {
                    update = this.parsePmtStreams(sect, diagnostics, ts.budget, ts.timeline);
                } catch (error) {
                    if (!lenient || !(error instanceof DemuxError)) throw error;
                    continue;
                }

                const added: number[] = [];
                for (const [pid, stream] of update.audioStreams) {
                    if (pid === videoPid || audioStreams.has(pid)) continue;
                    if (audioStreams.size + (videoPid >= 0 ? 1 : 0) >= DEMUX_LIMITS.maxTracks)
                        break;
                    audioStreams.set(pid, stream);
                    lateStreams.add(pid);
                    added.push(pid);
                }

                if (added.length)
                    tsNote(
                        diagnostics,
                        'warn',
                        'TS_PMT_UPDATED',
                        `A PMT update adds audio PID ${added.join(', ')}; read as ` +
                            `further tracks`,
                    );
            }
        };
        let walked = 0;
        for (let pos = ts.window.from ?? ts.syncOff; pos + stride <= size; pos += stride) {
            if ((walked & 0x0fff) === 0) {
                await yieldEventLoop();
                ts.checkAbort();
            }
            walked++;
            if (pos < ts.windowStart || pos + stride > ts.windowStart + ts.bytes.length) {
                ts.windowStart = pos;
                ts.bytes = await reader.bytes(
                    pos,
                    windowLength(pos, size, stride, ts.window.tables ? ts.window.from : 0),
                );
            }
            const bytes = ts.bytes;
            const at = pos - ts.windowStart + payOff;
            if (bytes[at] !== 0x47) {
                demuxAssert(lenient, 'TS packet sync byte is invalid');

                // Damaged bytes: resume at the next position where two consecutive packets carry
                // sync bytes.
                const next = await findTsSync(reader, pos + 1, size, stride, payOff);
                diagnostics.warn({
                    code: 'TS_RESYNCHRONIZED',
                    format: 'ts',
                    offset: pos,
                    message:
                        next >= 0
                            ? `Skipped ${next - pos} bytes without TS sync; resumed at byte ${next}`
                            : `Ignored ${size - pos} bytes without TS sync at byte ${pos}`,
                });
                videoReader.markDamaged();
                for (const stream of audioStreams.values()) stream.reader.markDamaged();
                if (next < 0) break;
                pos = next - stride;
                continue;
            }
            const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!;
            if (pid === videoPid) videoReader.read(bytes, at, pos);
            else if (program && pid === program.pid) updatePmt(bytes.subarray(at, at + TS_PACKET));
            else audioStreams.get(pid)?.reader.read(bytes, at, pos);
        }
        return lateStreams;
    }

    /**
     * Completes the PES readers at the end of the input. A partial transport packet cannot
     * establish a complete final access unit: only the affected pending PES is discarded, and an
     * unknown tail header discards both. The head of a probe ends inside the stream: the PES still
     * pending there are left unread, and where they start is where the next window resumes.
     */
    private async endReaders(
        ts: TsTransport,
        chosen: TsProgramStreams,
        video: TsVideoPipeline,
    ): Promise<void> {
        const { window, tailRemainder, payOff } = ts;
        const { videoPid, audioStreams } = chosen;
        const videoReader = video.reader;
        let truncatedPid = -1;
        let tailStartsPes = false;
        if (window.head) {
            videoReader.end();
            video.joiner?.finish();
            video.splitter?.finish();
            window.resume = Math.min(
                videoReader.pendingStart ?? Infinity,
                ...[...audioStreams.values()].map(stream => stream.reader.pendingStart ?? Infinity),
                ...[...this.audioCarry.values()].map(carry => carry.pos),
            );
            return;
        }

        if (tailRemainder >= payOff + 4) {
            const tail = await ts.reader.bytes(ts.size - tailRemainder + payOff, 4);
            if (tail[0] === 0x47) {
                truncatedPid = ((tail[1]! & 31) << 8) | tail[2]!;
                tailStartsPes = (tail[1]! & 0x40) !== 0;
            }
        }

        videoReader.flush(
            tailRemainder > 0 && !tailStartsPes && (truncatedPid < 0 || truncatedPid === videoPid),
            true,
        );
        videoReader.end();
        video.joiner?.finish();
        video.splitter?.finish();
        for (const [pid, stream] of audioStreams)
            stream.reader.flush(
                tailRemainder > 0 && !tailStartsPes && (truncatedPid < 0 || truncatedPid === pid),
                true,
            );
    }

    /**
     * Leaves out the declared streams no packet of was read, with a warning where compatible
     * validation keeps the others; audio streams a PMT update added, and private streams sniffed as
     * audio, are left out silently.
     */
    private omitEmptyStreams(
        ts: TsTransport,
        chosen: TsProgramStreams,
        lateStreams: ReadonlySet<number>,
        videoUnits: number,
    ): void {
        const { diagnostics, lenient } = ts;
        const { videoPid, audioStreams } = chosen;
        const unidentified: number[] = [];
        for (const [pid, stream] of audioStreams) {
            if (countOf(stream.track) > 0 || (stream.core?.samples.length ?? 0) > 0) continue;
            if (lateStreams.has(pid)) {
                audioStreams.delete(pid);
                continue;
            }

            if (stream.sniffed) {
                unidentified.push(pid);
                audioStreams.delete(pid);
                continue;
            }

            demuxAssert(
                lenient && (videoUnits > 0 || audioStreams.size > 1),
                'PMT declares an audio stream but no audio packets were found',
            );
            diagnostics.warn({
                code: stream.reader.pesSeen ? 'TS_AUDIO_UNFRAMED' : 'TS_EMPTY_STREAM',
                format: 'ts',
                message: stream.reader.pesSeen
                    ? `Omitted audio PID ${pid}: it holds no confirmed frame`
                    : `Omitted audio PID ${pid}: the input holds none of its packets`,
            });
            audioStreams.delete(pid);
        }

        if (videoPid >= 0 && videoUnits === 0) {
            demuxAssert(
                lenient && audioStreams.size > 0,
                'PMT declares a video stream but no video packets were found',
            );
            tsNote(
                diagnostics,
                'warn',
                'TS_EMPTY_STREAM',
                `Omitted video PID ${videoPid}: the input holds none of its packets`,
            );
        }

        demuxAssert(
            videoUnits > 0 || audioStreams.size > 0,
            unidentified.length
                ? `MPEG-TS PID ${unidentified.join(', ')} has unknown audio framing`
                : 'MPEG-TS holds no packets of its declared streams',
        );
    }

    /**
     * The track of MPEG-1/2 or MPEG-4 Part 2 video frames; frames straddle PES packets, so their
     * segments follow their own decode times. Undefined when the stream is unusable and audio
     * stands without it.
     */
    private mpegVideoTrack(
        ts: TsTransport,
        chosen: TsProgramStreams,
        syntax: MpegVideoSyntax,
        frames: MpegVideoFrame[],
    ): TrackInfo | undefined {
        const track = buildMpegVideoTrack(
            syntax,
            frames,
            ts.budget,
            'TS MPEG video stream',
            message => {
                if (!chosen.audioStreams.size) throw new DemuxError(message);
                tsNote(
                    ts.diagnostics,
                    'recover',
                    'TS_VIDEO_UNUSABLE',
                    `${message}; the stream is omitted`,
                );
            },
        );

        if (!track) return undefined;
        const clock: StreamClock = { segment: 0, lastRaw: null };
        const runs: SegmentRuns = [];
        track.samples.forEach((sample, index) =>
            markSegment(
                runs,
                index,
                ts.timeline.segment(clock, Math.round(decodeTime(sample) * 90000)),
            ),
        );
        this.runs.set(track, runs);
        return track;
    }

    /**
     * The track of H.264 and H.265 units indexed as they arrived, or of VVC, AV1 or VC-1 PES
     * packets. Video without its parameter sets (a capture started after them) cannot be decoded
     * or copied; the audio beside it still can, and the video is then left out.
     */
    private codedVideoTrack(
        ts: TsTransport,
        chosen: TsProgramStreams,
        streamed: TsVideoPipeline['streamed'],
        videoPes: PesEntry[],
    ): TrackInfo | undefined {
        const { videoPid, videoStreamType } = chosen;
        const shiftTicks = 0;
        try {
            if (streamed) {
                const track = streamed.finish(
                    (convert?: (bytes: Uint8Array) => Uint8Array) =>
                        new TsSampleReader(videoPid, ts.stride, ts.payOff, convert),
                );
                if (track) this.runs.set(track, streamed.runs);
                return track ?? undefined;
            }
            return videoStreamType === 0x33
                ? this.buildVvcTrack(videoPes, shiftTicks, ts.budget)
                : videoStreamType === STREAM_TYPE_AV1
                  ? this.buildAv1Track(videoPes, shiftTicks, ts.budget, ts.diagnostics)
                  : this.buildVc1Track(videoPes, shiftTicks, ts.budget);
        } catch (error) {
            if (ts.window.head && error instanceof DemuxError) throw new ProbeWindowShort();
            if (!(error instanceof DemuxError) || !chosen.audioStreams.size) throw error;
            tsNote(
                ts.diagnostics,
                'recover',
                'TS_VIDEO_UNUSABLE',
                `${error.message}; the stream is omitted`,
            );
            return undefined;
        }
    }

    /**
     * Joins the timeline segments of the tracks and gives every track the duration of the
     * program, which lasts until the latest presented sample ends (reordered pictures can end
     * after the last one).
     */
    private finishProgram(ts: TsTransport, result: DemuxResult): void {
        const tracks = [...result.videoTracks, ...result.audioTracks];
        if (ts.timeline.segments > 1) {
            joinSegments(tracks, this.runs, ts.timeline.segments);
            for (const track of tracks) if (countOf(track)) track.duration = endOf(track);
        }
        this.runs = new Map();
        const firstTime = (track: TrackInfo): number => {
            const table = tables.get(track);
            return table
                ? table.length
                    ? table.timestampAt(0)
                    : Infinity
                : (track.samples[0]?.timestamp ?? Infinity);
        };
        const start = Math.min(...tracks.map(firstTime));
        this.programEnd = Math.max(...tracks.map(t => Math.max(t.duration, endOf(t))));
        const totalDuration = Math.max(
            0,
            ...tracks.map(
                t => Math.max(t.duration, endOf(t)) - (Number.isFinite(start) ? start : 0),
            ),
        );
        for (const t of tracks) t.duration = totalDuration;

        for (const track of tracks) settleTrack(track, ts.budget, this.packetized);
    }

    /**
     * MPEG-1/2 and MPEG-4 Part 2 PES payloads carry arbitrary slices of the stream; frames are
     * split by start codes.
     */
    private splitMpegVideo(
        syntax: MpegVideoSyntax,
        entries: PesEntry[],
        diagnostics: DiagnosticContext,
    ): MpegVideoFrame[] {
        const units = new MpegVideoAccessUnits(syntax, message =>
            diagnostics.recover({ code: 'TS_VIDEO_FRAME_DAMAGED', format: 'ts', message }),
        );
        for (const entry of entries)
            units.push({
                data: entry.data,
                pts: entry.timed ? entry.pts : undefined,
                dts: entry.timed ? entry.dts : undefined,
                discontinuity: entry.discontinuity,
                incomplete: entry.incomplete,
            });
        units.end();
        entries.length = 0;
        return units.frames;
    }

    /**
     * PES timestamps apply to the access unit commencing in that PES, not its leading continuation
     * bytes.
     */
    private joinVideoContinuations(entries: PesEntry[]): PesEntry[] {
        const joined: PesEntry[] = [];
        const joiner = new VideoUnitJoiner(unit => joined.push(unit));
        for (const entry of entries) joiner.push(entry);
        joiner.finish();
        return joined;
    }

    private segmentRuns(track: TrackInfo): SegmentRuns {
        let runs = this.runs.get(track);
        if (!runs) this.runs.set(track, (runs = []));
        return runs;
    }

    private buildVvcTrack(
        pes: PesEntry[],
        shiftTicks: number,
        budget: DemuxIndexBudget,
    ): TrackInfo {
        const parameterSets = new Map<number, Uint8Array>();
        let sps: Uint8Array | null = null;
        for (const entry of pes) {
            for (const nal of splitAnnexBNals(entry.data)) {
                const type = vvcNalType(nal);
                if (type >= VVC_NAL.VPS && type <= VVC_NAL.PPS && !parameterSets.has(type))
                    parameterSets.set(type, nal);
                if (type === VVC_NAL.SPS && !sps) sps = nal;
            }
            if (parameterSets.size === 3) break;
        }

        if (!sps) throw new DemuxError('H.266 TS stream carries no SPS; it cannot be decoded');
        const parsed = parseVvcSps(sps);
        if (!parsed) throw new DemuxError('H.266 TS stream: SPS does not parse');

        const parameterBytes = new Uint8Array(
            [...parameterSets.values()].reduce((size, nal) => size + 4 + nal.length, 0),
        );
        let parameterOffset = 0;
        for (const nal of parameterSets.values()) {
            parameterBytes[parameterOffset + 3] = 1;
            parameterBytes.set(nal, parameterOffset + 4);
            parameterOffset += 4 + nal.length;
        }

        const codecConfig = buildVvcCFromAnnexB(parameterBytes) ?? undefined;
        const samples = pesSamples(
            pes,
            shiftTicks,
            budget,
            entry => splitAnnexBNals(entry.data).some(nal => isVvcRandomAccessNal(vvcNalType(nal))),
            true,
        );
        return {
            codec: vvcCodecString('vvi1', codecConfig),
            codecConfig,
            width: parsed.width,
            height: parsed.height,
            sampleRate: 0,
            channelCount: 0,
            duration: presentationEnd(samples),
            samples,
        };
    }

    private buildAv1Track(
        pes: PesEntry[],
        shiftTicks: number,
        budget: DemuxIndexBudget,
        diagnostics: DiagnosticContext,
    ): TrackInfo {
        const state = new Av1StreamState();
        const samples = pesSamples(
            pes,
            shiftTicks,
            budget,
            entry => state.inspect(entry.data).keyframe,
        );
        const { codecConfig, colour } = state.configuration(
            diagnostics,
            'ts',
            'AV1 TS stream carries no sequence header; it cannot be configured for decoding',
        );

        const sequence = state.sequenceHeader;
        return {
            codec: (codecConfig && av1CodecString(codecConfig)) ?? 'av01',
            codecConfig,
            colour,
            width: sequence?.width ?? 0,
            height: sequence?.height ?? 0,
            sampleRate: 0,
            channelCount: 0,
            duration: presentationEnd(samples),
            samples,
        };
    }

    private buildVc1Track(
        pes: PesEntry[],
        shiftTicks: number,
        budget: DemuxIndexBudget,
    ): TrackInfo {
        let codecConfig: Uint8Array | undefined;
        for (const entry of pes) {
            codecConfig = vc1HeadersOf(entry.data);
            if (codecConfig) break;
        }

        if (!codecConfig)
            throw new DemuxError('VC-1 TS stream carries no sequence header; it cannot be decoded');
        const sequence = parseVc1SequenceHeader(codecConfig.subarray(4));
        if (!sequence)
            throw new DemuxError('VC-1 TS stream: the sequence header is not advanced profile');

        const samples = pesSamples(pes, shiftTicks, budget, entry =>
            isVc1IntraFrame(entry.data, sequence.interlace),
        );
        return {
            codec: 'vc1',
            codecConfig,
            width: sequence.width,
            height: sequence.height,
            sampleRate: 0,
            channelCount: 0,
            duration: presentationEnd(samples),
            samples,
        };
    }

    /**
     * Strict validation expects every audio PES to hold whole frames. Compatible validation joins
     * frames split across PES packets and skips bytes up to the next frame header; the PES
     * timestamp belongs to the first frame that starts in that PES, and a PES without one continues
     * the running time.
     */
    private appendAudioEntry(
        track: TrackInfo,
        entry: PesEntry,
        streamType: number,
        budget: DemuxIndexBudget,
        diagnostics: DiagnosticContext,
    ): void {
        if (this.ended.has(track)) return;
        let table = tables.get(track);
        if (!table) tables.set(track, (table = new PesSampleIndex(false, this.keeping === 'both')));
        const lenient = diagnostics.validation === 'compatible';
        const carried = lenient && !entry.discontinuity ? this.audioCarry.get(track) : undefined;
        const carry = carried?.bytes;
        let data = entry.data;
        if (carry?.length) {
            data = new Uint8Array(carry.length + entry.data.length);
            data.set(carry);
            data.set(entry.data, carry.length);
        }
        const origin: PesEntry =
            carry?.length && carried
                ? {
                      ...entry,
                      data,
                      pos: carried.pos,
                      skip: carried.skip,
                      clean: carried.clean && entry.clean,
                  }
                : entry;
        const pesStart = carry?.length ?? 0;
        const frames: { start: number; data: Uint8Array; duration: number }[] = [];
        const take = (from: number, partial: boolean): number => {
            const lastBytes = frames[frames.length - 1]?.data ?? this.lastAudioFrame.get(track);
            const lastDts = streamType === 0x82 && lastBytes ? parseDtsFrame(lastBytes, 0) : null;
            const parsed: SplitAudio =
                streamType === STREAM_TYPE_LATM
                    ? this.splitLatmFrames(
                          this.latmReader(track),
                          data.subarray(from),
                          budget,
                          partial,
                      )
                    : streamType === 0x82
                      ? splitDtsFrames(
                            data.subarray(from),
                            budget,
                            partial,
                            !!lastDts &&
                                lastDts.coreBytes > 0 &&
                                lastDts.frameBytes === lastDts.coreBytes,
                        )
                      : splitAudioFrames(
                            streamType,
                            data.subarray(from),
                            budget,
                            partial,
                            track.channelCount || 2,
                        );
            const pending = frames[frames.length - 1];
            if (parsed.continuation && (pending || table.length) && lastBytes) {
                const unit = new Uint8Array(lastBytes.length + parsed.continuation.length);
                unit.set(lastBytes);
                unit.set(parsed.continuation, lastBytes.length);
                this.lastAudioFrame.set(track, unit);

                // A joined unit holds its bytes; its parts need not be adjacent in the input.
                if (pending) pending.data = unit;
                else table.hold(table.length - 1, unit);
                if (streamType === 0x82) track.codec = parseDtsFrame(unit, 0)?.codec ?? track.codec;
                else {
                    if (parsed.codec === 'ec-3') track.codec = 'ec-3';
                    track.channelCount = Math.max(
                        track.channelCount,
                        dolbyAccessUnitChannels(unit),
                    );
                }
            }
            if (!parsed.frames.length) return from + (parsed.consumed ?? 0);

            // Dolby and DTS frames signal their own channel mode; dependent substreams make a
            // stream E-AC-3 and extension substreams make DTS core frames part of a DTS-HD stream.
            const dolby = streamType === 0x81 || streamType === 0x87;
            const selfDescribing = dolby || streamType === 0x82;
            const unchanged =
                (table.length === 0 && frames.length === 0) ||
                ((track.codec === parsed.codec || selfDescribing) &&
                    track.sampleRate === parsed.sampleRate &&
                    (track.channelCount === parsed.channelCount || selfDescribing));
            if (!unchanged) {
                demuxAssert(lenient, 'TS audio configuration changes between PES packets');

                // One track has one decoder configuration; frames after the change cannot be
                // decoded with it.
                tsNote(
                    diagnostics,
                    'recover',
                    'TS_AUDIO_CONFIG_CHANGED',
                    'TS audio changes its format; the track ends there',
                );
                this.ended.add(track);
                return -1;
            }
            if (
                !(dolby && track.codec === 'ec-3') &&
                !(streamType === 0x82 && parsed.codec === 'dtsc' && track.codec)
            )
                track.codec = parsed.codec;
            track.sampleRate = parsed.sampleRate;
            track.channelCount = selfDescribing
                ? Math.max(track.channelCount, parsed.channelCount)
                : parsed.channelCount;
            if (dolby)
                track.codecConfig =
                    track.codec === 'ac-3'
                        ? (track.codecConfig ?? ac3SpecificBox(parsed.frames[0]!.data, 0))
                        : undefined;
            else track.codecConfig ??= parsed.codecConfig;
            let cursor = from;
            for (const frame of parsed.frames) {
                frames.push({ start: cursor, data: frame.data, duration: frame.duration });
                cursor =
                    frame.end !== undefined
                        ? from + frame.end
                        : frame.data.byteOffset + frame.data.length - data.byteOffset;
            }
            return parsed.consumed !== undefined ? from + parsed.consumed : cursor;
        };
        if (!lenient) take(0, entry.incomplete === true);
        else {
            let cursor = 0;
            let skipped = 0;
            let lost = false;
            while (cursor < data.length) {
                const next = audioFrameStart(streamType, data, cursor);
                const kept =
                    next < data.length ? next : Math.max(cursor, data.length - AUDIO_HEADER_BYTES);
                if (kept > cursor) {
                    skipped += kept - cursor;
                    lost ||= table.length > 0 || frames.length > 0;
                }
                cursor = kept;
                if (next >= data.length) break;
                const end = take(next, true);
                if (end < 0) {
                    cursor = data.length;
                    break;
                }
                if (end === next) break;
                cursor = end;
            }
            this.audioCarry.set(track, {
                bytes: entry.incomplete ? new Uint8Array(0) : data.slice(cursor),
                pos: origin.pos,
                skip: origin.skip + cursor,
                clean: origin.clean,
            });
            if (
                !entry.incomplete &&
                audioFrameLength(streamType, data, cursor) > data.length - cursor
            )
                this.openFrames.add(track);
            else this.openFrames.delete(track);
            if (skipped)
                tsNote(
                    diagnostics,
                    'warn',
                    'TS_AUDIO_RESYNCHRONIZED',
                    `Skipped ${skipped} audio bytes without a frame header`,
                );
            if (lost) track.incomplete = true;
        }
        if (!frames.length) return;

        // A stream's window continues the clock of the frames delivered before it, as a whole read
        // does.
        const clock = table.length > 0 ? undefined : this.carriedClocks.get(track);
        const previous = table.length > 0 || clock !== undefined;
        let timestamp =
            table.length > 0
                ? table.timestampAt(table.length - 1) + table.durationAt(table.length - 1)
                : clock
                  ? (clock.at(
                        origin.pos,
                        origin.skip + frames[0]!.data.byteOffset - data.byteOffset,
                    ) ?? clock.end)
                  : entry.pts / 90000;

        // The first frames of a track can start in the carried bytes of an earlier PES: they
        // precede the frame the PES time belongs to.
        const firstStamped = frames.findIndex(frame => frame.start >= pesStart);
        if (!previous && entry.timed && firstStamped > 0)
            for (let index = 0; index < firstStamped; index++) timestamp -= frames[index]!.duration;
        let stamped = !(entry.timed || !previous);
        if (!previous && !entry.timed) this.untimedAudio.add(track);
        markSegment(this.segmentRuns(track), table.length, entry.segment);
        for (const frame of frames) {
            if (!stamped && frame.start >= pesStart) {
                const clock = timestamp;
                timestamp = continuedAudioTime(
                    previous || frame !== frames[0] ? timestamp : undefined,
                    entry.pts / 90000,
                    frame.duration,
                );
                stamped = true;

                // Frames read before the track's first PES time (a capture that starts inside an
                // untimed PES) precede this frame on its clock, not the start of the timeline.
                if (entry.timed && this.untimedAudio.delete(track))
                    for (let index = 0; index < table.length; index++)
                        table.shift(index, timestamp - clock);
            }
            table.push(
                timestamp,
                0,
                frame.duration,
                frame.data.length,
                true,
                locationOf(
                    {
                        ...origin,
                        skip: origin.skip + frame.data.byteOffset - data.byteOffset,
                        data: frame.data,
                    },
                    frame.data.buffer === data.buffer ? this.keeping : 'held',
                ),
                () => frame.data,
            );
            timestamp += frame.duration;
        }
        this.lastAudioFrame.set(track, frames[frames.length - 1]!.data);
        track.duration = timestamp;
    }

    private latmReader(track: TrackInfo): LatmReader {
        let reader = this.latm.get(track);
        if (!reader) this.latm.set(track, (reader = new LatmReader()));
        return reader;
    }

    /**
     * LOAS AudioSyncStream frames of an AAC LATM stream as raw access units. Frames before the
     * first StreamMuxConfig are consumed without output; `end` and `consumed` locate the frames,
     * whose payloads are copies.
     */
    private splitLatmFrames(
        reader: LatmReader,
        data: Uint8Array,
        budget: DemuxIndexBudget,
        partial: boolean,
    ): SplitAudio {
        const frames: SplitAudio['frames'] = [];
        let offset = 0;
        let config = reader.config;

        // Frames before the first StreamMuxConfig reuse the configuration that preceded the cut;
        // they are read with the first one that arrives in the same payload.
        const unconfigured: { start: number; end: number }[] = [];
        while (offset < data.length) {
            const length = loasFrameLength(data, offset);
            if (partial && (length === 0 || length > data.length - offset)) break;
            if (!(length > 0))
                malformedInput(`TS LOAS sync word at PES offset ${offset} is invalid`);
            if (!(length <= data.length - offset))
                malformedInput(`TS LOAS frame at PES offset ${offset} is truncated`);
            const units = reader.read(data.subarray(offset, offset + length));
            if (!units.length) {
                if (!reader.config) unconfigured.push({ start: offset, end: offset + length });
                offset += length;
                continue;
            }
            if (unconfigured.length) {
                for (const frame of unconfigured) {
                    const earlier = reader.read(data.subarray(frame.start, frame.end));
                    for (const unit of earlier) {
                        pushFrame(budget, frames, {
                            data: unit,
                            duration:
                                reader.config!.samplesPerAccessUnit / reader.config!.sampleRate,
                            end: frame.end,
                        });
                    }
                }
                unconfigured.length = 0;
            }
            const current = reader.config!;

            // Under compatible validation a new configuration starts the next split, where the
            // track compares it.
            if (
                config &&
                frames.length &&
                (current.sampleRate !== config.sampleRate ||
                    current.channelCount !== config.channelCount ||
                    current.audioObjectType !== config.audioObjectType)
            ) {
                demuxAssert(partial, 'TS LATM configuration changes inside a PES');
                break;
            }
            config = current;
            offset += length;
            for (const unit of units) {
                pushFrame(budget, frames, {
                    data: unit,
                    duration: config.samplesPerAccessUnit / config.sampleRate,
                    end: offset,
                });
            }
        }
        return {
            codec: config ? `mp4a.40.${config.audioObjectType}` : '',
            sampleRate: config?.sampleRate ?? 0,
            channelCount: config?.channelCount ?? 0,
            codecConfig: config?.config,
            consumed: offset,
            frames,
        };
    }

    private parsePmtStreams(
        sect: Uint8Array,
        diagnostics: DiagnosticContext,
        budget: DemuxIndexBudget,
        timeline: ProgramTimeline,
    ): TsProgramStreams {
        const audioStreams: TsProgramStreams['audioStreams'] = new Map();
        const streams: TsProgramStreams = {
            videoPid: -1,
            videoStreamType: 0,
            audioStreams,
            unsupported: [],
        };
        demuxAssert(
            sect.length >= 16 && sect[6] === 0 && sect[7] === 0,
            'TS PMT section header is malformed',
        );
        const progInfoLen = ((sect[10]! & 0x0f) << 8) | sect[11]!;
        let off = 12 + progInfoLen;
        checkPmtDescriptors(sect, 12, off, diagnostics);
        const hdmv = registrationOf(sect.subarray(12, off)) === 'HDMV';
        const endOff = sect.length - 4;
        while (off < endOff) {
            demuxAssert(off + 5 <= endOff, 'TS PMT elementary stream header is truncated');
            const sType = sect[off];
            const sPid = ((sect[off + 1]! & 0x1f) << 8) | sect[off + 2]!;
            const esInfoLen = ((sect[off + 3]! & 0x0f) << 8) | sect[off + 4]!;
            checkPmtDescriptors(sect, off + 5, off + 5 + esInfoLen, diagnostics);
            const descriptors = sect.subarray(off + 5, off + 5 + esInfoLen);
            const privateAudioType =
                sType === 0x06 ? this.resolvePrivateAudioStreamType(descriptors) : 0;
            const privateVideo = sType === 0x06 && registrationOf(descriptors) === 'AV01';
            const declaredAudio = declaredAudioStreamType(sType!, hdmv);

            // Private PES streams without content descriptors (m2ts AAC, some MP3 muxers) and the
            // user-private DTS types outside Blu-ray are identified by the framing of their first
            // payload, as ffmpeg does; sniffed streams use type 0 and are dropped when no payload
            // confirms audio.
            const sniffPrivate =
                (sType === 0x06 && privateAudioType === 0 && describesNoContent(descriptors)) ||
                (declaredAudio === 0 && DTS_CANDIDATE_TYPES.has(sType!)) ||
                (sType === 0x83 && !hdmv);
            const unsupportedName = UNSUPPORTED_STREAMS.get(sType!);
            if (unsupportedName)
                streams.unsupported.push(
                    `${unsupportedName} (stream type 0x${sType!.toString(16)}) on PID ${sPid}`,
                );

            if (
                (sType === 0x1b ||
                    sType === 0x24 ||
                    sType === 0x33 ||
                    sType === 0xea ||
                    sType === 0x01 ||
                    sType === 0x02 ||
                    sType === 0x10 ||
                    privateVideo) &&
                streams.videoPid < 0
            ) {
                streams.videoPid = sPid;
                streams.videoStreamType = privateVideo ? STREAM_TYPE_AV1 : sType!;
            } else if (declaredAudio !== 0 || privateAudioType !== 0 || sniffPrivate) {
                demuxAssert(!audioStreams.has(sPid), 'TS PMT repeats an audio PID');
                demuxAssert(
                    audioStreams.size + (streams.videoPid >= 0 ? 1 : 0) < DEMUX_LIMITS.maxTracks,
                    'TS PMT exceeds the track limit',
                );
                let language: string | undefined;
                let supplementary: string | undefined;
                const languageAt = (at: number): string | undefined => {
                    const code = String.fromCharCode(
                        descriptors[at]!,
                        descriptors[at + 1]!,
                        descriptors[at + 2]!,
                    );
                    return /^[a-z]{3}$/i.test(code) ? code.toLowerCase() : undefined;
                };
                for (let d = 0; d + 2 <= descriptors.length; d += 2 + descriptors[d + 1]!) {
                    const length = descriptors[d + 1]!;
                    if (descriptors[d] === 10 && length >= 4 && language === undefined)
                        language = languageAt(d + 2) ?? '';
                    // A DVB supplementary audio descriptor (audio description, clean audio) names
                    // the language of the audience, which ffmpeg reports over the ISO 639
                    // descriptor's.
                    else if (descriptors[d] === 0x7f && length >= 5 && descriptors[d + 2] === 6)
                        if (descriptors[d + 3]! & 1) supplementary = languageAt(d + 4);
                }
                language = supplementary ?? (language || undefined);
                const track: TrackInfo = {
                    codec: '',
                    width: 0,
                    height: 0,
                    sampleRate: 0,
                    channelCount: 0,
                    samples: [],
                    duration: 0,
                    language,
                };
                let type =
                    sniffPrivate && declaredAudio === 0 ? 0 : privateAudioType || declaredAudio;
                if (type === OPUS_STREAM) track.channelCount = opusChannels(descriptors);
                const stream: TsAudioStream = {
                    track,
                    sniffed: sniffPrivate,
                    unitSamples: 0,
                    reader: new PesPacketReader(false, diagnostics, budget, timeline, entry => {
                        if (type === 0) {
                            type = sniffAudioStreamType(entry.data);
                            if (type === 0) return;
                        }
                        // Some DVB muxers declare LATM AAC as ADTS (0x0f); the payload framing
                        // decides, as in ffmpeg.
                        if (type === 0x0f && !countOf(track) && isLoasPayload(entry.data))
                            type = STREAM_TYPE_LATM;
                        if (type === 0x83) this.appendTrueHdEntry(stream, entry, budget);
                        else this.appendAudioEntry(track, entry, type, budget, diagnostics);
                    }),
                };
                if (this.allocate) stream.reader.allocate = this.allocate;
                audioStreams.set(sPid, stream);
            }
            off += 5 + esInfoLen;
        }
        return streams;
    }

    /**
     * PSI tables repeat; a damaged copy is skipped under compatible validation until an intact one
     * arrives.
     */
    private validSection(
        section: Uint8Array,
        lenient: boolean,
        diagnostics: DiagnosticContext,
    ): boolean {
        try {
            validatePsiSection(section);
            return true;
        } catch (error) {
            if (!lenient || !(error instanceof DemuxError)) throw error;
            tsNote(
                diagnostics,
                'warn',
                'TS_PSI_DAMAGED',
                'Ignored a damaged PSI section; waiting for its next repetition',
            );
            return false;
        }
    }

    private resolvePrivateAudioStreamType(descriptors: Uint8Array): number {
        let offset = 0;
        while (offset + 2 <= descriptors.length) {
            const tag = descriptors[offset]!;
            const length = descriptors[offset + 1]!;
            const end = offset + 2 + length;
            if (end > descriptors.length) break;
            if (tag === 0x6a) return 0x81;
            if (tag === 0x7a) return 0x87;

            // DVB DTS descriptor, and the DTS-HD extension descriptor.
            if (tag === 0x7b || (tag === 0x7f && length >= 1 && descriptors[offset + 2] === 0x0e))
                return 0x82;
            if (tag === 0x05 && length >= 4) {
                const registration = String.fromCharCode(
                    descriptors[offset + 2]!,
                    descriptors[offset + 3]!,
                    descriptors[offset + 4]!,
                    descriptors[offset + 5]!,
                );
                if (registration === 'AC-3') return 0x81;
                if (registration === 'EAC3') return 0x87;
                if (registration === 'DTS1' || registration === 'DTS2' || registration === 'DTS3')
                    return 0x82;
                if (registration === 'Opus') return OPUS_STREAM;
            }
            offset = end;
        }
        return 0;
    }

    /**
     * Blu-ray TrueHD PES packets interleave TrueHD access units with an AC-3 compatibility stream;
     * each is indexed as its own track. TrueHD units before the first major sync cannot start
     * decoding and are dropped.
     */
    private appendTrueHdEntry(
        stream: TsAudioStream,
        entry: PesEntry,
        budget: DemuxIndexBudget,
    ): void {
        const { track } = stream;
        const core = (stream.core ??= { ...track, samples: [] });
        const data = entry.data;

        const endOf = (target: TrackInfo): number | undefined => {
            const last = target.samples[target.samples.length - 1];
            return last && last.timestamp + last.duration;
        };

        let truehdTime = entry.timed ? entry.pts / 90000 : (endOf(track) ?? entry.pts / 90000);
        let ac3Time = entry.timed ? entry.pts / 90000 : (endOf(core) ?? entry.pts / 90000);

        markSegment(this.segmentRuns(track), track.samples.length, entry.segment);
        markSegment(this.segmentRuns(core), core.samples.length, entry.segment);

        for (let offset = 0; offset < data.length;) {
            const dolby = parseDolbyFrameHeader(data, offset);
            if (dolby?.codec === 'ac-3' && dolby.frameBytes <= data.length - offset) {
                core.codec = 'ac-3';
                core.sampleRate = dolby.sampleRate;
                core.channelCount = dolby.channels;
                budget.reserveSamples(1, 256, 'TS audio sample index');
                core.samples.push({
                    offset: 0,
                    size: dolby.frameBytes,
                    timestamp: ac3Time,
                    duration: dolby.samples / dolby.sampleRate,
                    isKeyframe: true,
                    data: data.subarray(offset, offset + dolby.frameBytes),
                });
                ac3Time += dolby.samples / dolby.sampleRate;
                core.duration = ac3Time;
                offset += dolby.frameBytes;
                continue;
            }

            const unit = parseTrueHdAccessUnit(data, offset);
            if (!unit || unit.bytes > data.length - offset) {
                if (!(entry.incomplete === true || (!track.samples.length && !core.samples.length)))
                    malformedInput(`TS TrueHD access unit at PES offset ${offset} is invalid`);
                break;
            }

            if (unit.format) {
                track.codec = 'mlpa';
                track.sampleRate = unit.format.sampleRate;
                track.channelCount = unit.format.channels;
                track.timescale = unit.format.sampleRate;
                stream.unitSamples = unit.format.samples;
            }

            const samples = stream.unitSamples;
            if (samples) {
                budget.reserveSamples(1, 256, 'TS audio sample index');
                track.samples.push({
                    offset: 0,
                    size: unit.bytes,
                    timestamp: truehdTime,
                    duration: samples / track.sampleRate,
                    isKeyframe: unit.format !== undefined,
                    data: data.subarray(offset, offset + unit.bytes),
                });
                truehdTime += samples / track.sampleRate;
                track.duration = truehdTime;
            }

            offset += unit.bytes;
        }
    }
}
