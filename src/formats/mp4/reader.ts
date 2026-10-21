import { BlobSource } from '../../core/io/sources/sources';
import { WindowReader, type ByteReader } from '../../core/io/sources/chunk-reader';
import { uncachedReads } from '../../core/io/sources/cached-source';
import { compatibleMp4Source, walkedBoxReader } from './read/compatible-source';
import type { Source } from '../../core/model/types';
import type {
    DemuxResult,
    Mp4EditList,
    Mp4EditListEntry,
    Sample,
    TrackInfo,
} from '../../core/model/track';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { demuxAssert, demuxFailure, malformedInput } from '../../core/errors/demux-guard';
import {
    DEMUX_LIMITS,
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { awaitWithAbort } from '../../core/io/abort';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import {
    bindCompactSampleIndex,
    enableCompactSampleIndex,
    getCompactSampleIndex,
    usesCompactSampleIndex,
    type SampleIndex,
    sampleAt,
    sampleCount,
    skipLeadingSamples,
} from '../../core/model/sample-index';
import {
    createClassicSampleIndex,
    describeClassicSamples,
    type TableLayout,
} from './read/sample-index';
import {
    readMp4GaplessInfo,
    readMp4HandlerName,
    readMp4Title,
    readMp4TrackMetadata,
    userDataBoxes,
    type Mp4GaplessInfo,
    type Mp4TrackMetadata,
    type UserDataBoxes,
} from './metadata';
import { readMp4ExtendedLanguage, readMp4Tags } from './tags';
import { codecFamily } from '../../core/model/codec-strings';
import { nalLengthSize } from '../../core/codec-config/video/video-packet';
import { joinPicturelessSamples, sampleUnits } from './read/pictureless';
import { sameBytes } from '../../core/bytes/bytes';
import { decodeTime } from '../../core/model/media-time';
import type { FieldOrder, MasteringDisplay, VideoColour } from '../../core/model/media';
import { readFiel, readMdcv } from '../shared/video-colour';
import { PROBE_WINDOWS } from '../shared/probe-windows';
import {
    ascii,
    childBox,
    findBox,
    findBoxes,
    parseEsds,
    preRollGroups,
    readFullBoxVersion,
    readU16,
    readU32,
    type Box,
} from './read/boxes';
import {
    chunkAudioPacketCount,
    chunkAudioUnitSamples,
    codecConfigurations,
    sampleTableNotes,
    type Mp4ReadContext,
} from './read/descriptions';
import type {
    ChunkAudioUnit,
    FragmentState,
    SampleDescriptions,
    SampleEntry,
} from './read/read-types';
import { dataView } from '../../core/bytes/byte-fields';

/**
 * Media units presented by an edit whose end is limited to the coded media. The overshoot is
 * measured in whole movie ticks because segment_duration is exact only to one tick; less than a
 * tick is the field's own precision.
 */
function presentedMediaUnits(
    entry: Mp4EditListEntry,
    mediaTimescale: number,
    movieTimescale: number,
    codedUnits: number,
): { units: number; overshootTicks: number } {
    const scale = BigInt(movieTimescale);
    const endScaled =
        BigInt(entry.mediaTime) * scale + BigInt(entry.segmentDuration) * BigInt(mediaTimescale);
    const codedScaled = BigInt(codedUnits) * scale;
    if (endScaled <= codedScaled) {
        const units = Number(
            (2n * BigInt(entry.segmentDuration) * BigInt(mediaTimescale) + scale) / (2n * scale),
        );
        return { units: Math.min(units, codedUnits - entry.mediaTime), overshootTicks: 0 };
    }
    return {
        units: codedUnits - entry.mediaTime,
        overshootTicks: Number((endScaled - codedScaled) / BigInt(mediaTimescale)),
    };
}

/**
 * The edit list with its leading empty edits joined into one (those of no duration left out) and
 * each media edit that continues where the one before it ends (within the one movie tick a
 * segment_duration is exact to) joined to it: the same presentation as fewer entries. Editors split
 * a presentation this way; ffmpeg replays each entry, which presents the same pictures.
 */
function joinEditSegments(
    entries: readonly Mp4EditListEntry[],
    mediaTimescale: number,
    movieTimescale: number,
): Mp4EditListEntry[] {
    const joined: Mp4EditListEntry[] = [];
    for (const entry of entries) {
        // An empty edit of no duration presents nothing.
        if (entry.mediaTime === -1 && entry.segmentDuration === 0) continue;

        const last = joined[joined.length - 1];
        if (last && last.mediaTime === -1 && entry.mediaTime === -1 && joined.length === 1) {
            joined[0] = {
                mediaTime: -1,
                segmentDuration: last.segmentDuration + entry.segmentDuration,
            };
            continue;
        }

        if (last && last.mediaTime >= 0 && entry.mediaTime >= 0 && last.segmentDuration > 0) {
            // In media × movie units: where the last edit ends, and where this one starts.
            const end =
                BigInt(last.mediaTime) * BigInt(movieTimescale) +
                BigInt(last.segmentDuration) * BigInt(mediaTimescale);
            const start = BigInt(entry.mediaTime) * BigInt(movieTimescale);
            const gap = end > start ? end - start : start - end;
            if (gap < BigInt(mediaTimescale)) {
                joined[joined.length - 1] = {
                    mediaTime: last.mediaTime,
                    segmentDuration: last.segmentDuration + entry.segmentDuration,
                };
                continue;
            }
        }

        joined.push(entry);
    }
    return joined;
}

/** A track's edit list as read: see readEditList. */
interface TrackEdit {
    shiftSeconds: number;
    leadSeconds: number;
    skipSeconds: number;
    presentationDurationSeconds?: number;
    presentationDurationUnits?: number;
    editList?: Mp4EditList;
    splice?: { readonly entries: Mp4EditListEntry[]; readonly fallback: string };
}

/** What a track header states about the track's pictures (see readTrackHeader). */
interface TrackHeader {
    flags?: number;
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    matrixAspect?: number;
}

/** The fields of a sample description that its codec leaves at their defaults. */
const EMPTY_ENTRY: Omit<SampleEntry, 'codecFourCC' | 'codec'> = {
    width: 0,
    height: 0,
    sampleRate: 0,
    channelCount: 0,
    displayWidth: 0,
    displayHeight: 0,
    pixelAspectRatioNum: 1,
    pixelAspectRatioDen: 1,
    codecConfig: undefined,
    pcmFrameBytes: 0,
    chunkUnit: undefined,
    codecTag: undefined,
    dolbyVisionConfig: undefined,
    colour: undefined,
    fieldOrder: undefined,
    forced: false,
};

/**
 * Sample descriptions one track may hold; real files use one, or a few for configuration changes.
 */
const MAX_SAMPLE_DESCRIPTIONS = 256;

/**
 * Video codecs whose every picture is coded alone: JPEG, PNG, DNxHD, FFV1, ProRes (RAW too) and
 * uncompressed.
 */
const INTRA_ONLY_VIDEO = /^(mjpeg|png|dnxhd|ffv1|ap(co|cs|cn|ch|4h|4x|rn|rh))$|^raw\./;

/** Largest first sample read to tell whether an AVC/HEVC track stores samples without a picture. */
const PICTURELESS_PROBE_BYTES = 4096;

// Parts of the reader that load when a movie needs them.
const trackFixes = () => import('./read/track-fixes');
const sampleEntries = () => import('./read/sample-entries');
const movieRepair = () => import('./read/movie-repair');
const fragmentParts = () => import('./read/fragments');

export interface Mp4DemuxerOptions extends DemuxBudgetOptions {
    allowEmptyTracks?: boolean;
    /**
     * Reads the fragments from the moof at this position on, passing over those between the movie
     * box and it: a probe's window, whose fragments are timed by their tfdt.
     */
    fragmentsFrom?: number;
    /**
     * The movie box of a movie of fragments only, shared by the windows of its fragments: the
     * first that reads it keeps it here, the others take copies of its tracks.
     */
    movie?: KeptMovie;
}

/** What the first window of a movie of fragments only read of its movie box (parseTrak etc.). */
export interface KeptMovie {
    tracks?: readonly (KeptTrack | undefined)[];
    moov?: Uint8Array;
    moovEnd?: number;
    title?: string;
    tags?: DemuxResult['tags'];
    gapless?: Mp4GaplessInfo;
    /** The fragment defaults of each track (trex), by track ID. */
    trex?: FragmentState['trexDefaults'];
}

/** A parsed trak box: its track before any fragment, the list it goes to and its descriptions. */
interface KeptTrack {
    readonly track: TrackInfo;
    readonly list: 'videoTracks' | 'audioTracks' | 'subtitleTracks';
    readonly descriptions?: SampleDescriptions;
}

/**
 * A copy of a kept track, without samples, added to `result` as parseTrak adds it, its sample
 * descriptions to `descriptions`.
 */
export function keptTrackOf(
    kept: KeptTrack | undefined,
    result: DemuxResult,
    descriptions: Map<TrackInfo, SampleDescriptions>,
): TrackInfo | undefined {
    if (!kept) return undefined;
    const track: TrackInfo = { ...kept.track, samples: [] };
    (result[kept.list] ??= []).push(track);
    if (kept.descriptions) descriptions.set(track, kept.descriptions);
    return track;
}

/**
 * Codecs of the MPEG-4 and MPEG-2 AAC object type indications, whose decoder specific info is an
 * AudioSpecificConfig.
 */
const AAC_CODECS: ReadonlyMap<number, string> = new Map([
    [0x40, 'mp4a.40.2'],
    [0x66, 'mp4a.40.1'],
    [0x67, 'mp4a.40.2'],
    [0x68, 'mp4a.40.3'],
]);

/** Handler types of subtitle tracks. */
const SUBTITLE_HANDLERS = ['text', 'sbtl', 'subt', 'clcp'];

/**
 * Whether a track's sample descriptions need the readers of other codecs than AVC and AAC
 * (mp4-sample-entries): a hint to load them with the first tracks; an mp4a entry of another object
 * type loads them when it is read.
 */
function needsEntryReaders(buf: Uint8Array, dv: DataView, trak: Box): boolean {
    const mdia = childBox(buf, trak, 'mdia');
    const hdlr = mdia && childBox(buf, mdia, 'hdlr');
    if (!mdia || !hdlr || hdlr.size < 20) return false;
    const handler = ascii(buf, hdlr.offset + 16, 4);
    if (handler !== 'vide' && handler !== 'soun') return SUBTITLE_HANDLERS.includes(handler);
    const minf = childBox(buf, mdia, 'minf');
    const stbl = minf && childBox(buf, minf, 'stbl');
    const stsd = stbl && childBox(buf, stbl, 'stsd');
    if (!stsd || stsd.size < 16) return false;
    const end = stsd.offset + stsd.size;
    for (let entry = stsd.offset + 16; entry + 8 <= end;) {
        const size = readU32(dv, entry);
        const fourcc = ascii(buf, entry + 4, 4);
        if (handler === 'vide' ? fourcc !== 'avc1' && fourcc !== 'avc3' : fourcc !== 'mp4a')
            return true;
        if (size < 8) break;
        entry += size;
    }

    return false;
}

/**
 * QuickTime mdhd language codes below 0x400 are Macintosh language indices rather than packed ISO
 * 639-2 letters. The codes follow the QuickTime File Format specification; entries without a
 * three-letter code stay undefined. Packed letters are never below 0x400, so such a code in an ISO
 * file (Apple and faac M4A files write 0) is the Macintosh code too, as ffmpeg and QuickTime read
 * it; unknown is 'und' or 0x7fff, which give no language. Three letters for each code from 0 to
 * 94; 95 to 127 have none.
 */
const MACINTOSH_LANGUAGES =
    'engfrageritadutswespadanpornorhebjpnarafingreicemltturhrvchiurdhinthakorlitpolhunest' +
    'lavsmefaofasruschidutglealbroncesslkslvyidsrpmacbulukrbeluzbkazazeazearmgeomolkirtgk' +
    'tukmonmonpuskurkassndtibnepsanmarbenasmgujpanorimalkantamtelsinburkhmlaovieindtglmay' +
    'mayamhtirormsomswakinrunnyamlgepo';

/** The Macintosh language codes from 128 on, three letters each like MACINTOSH_LANGUAGES. */
const MACINTOSH_LANGUAGES_FROM_128 =
    'welbaqcatlatquegrnaymtatuigdzojavsunglgafrbreikuglaglvgletongrekalaze';

/** The ISO 639-2 code of Macintosh language `code`, when it has one. */
function macintoshLanguage(code: number): string | undefined {
    const table = code < 128 ? MACINTOSH_LANGUAGES : MACINTOSH_LANGUAGES_FROM_128;
    const at = (code < 128 ? code : code - 128) * 3;
    return table.slice(at, at + 3) || undefined;
}

/**
 * Colour and field order of a visual sample entry's boxes: colr (nclx, or QuickTime nclc without a
 * range), the HDR mdcv/clli boxes (or VP9's SmDm/CoLL) and fiel.
 */
function visualMetadata(
    buf: Uint8Array,
    dv: DataView,
    start: number,
    end: number,
): { colour: VideoColour | undefined; fieldOrder: FieldOrder | undefined } {
    let colour: VideoColour | undefined;
    const colr = findBox(buf, start, end, 'colr');
    const kind = colr && colr.size >= 18 ? ascii(buf, colr.offset + 8, 4) : '';
    if ((kind === 'nclx' && colr!.size >= 19) || kind === 'nclc')
        colour = {
            primaries: dv.getUint16(colr!.offset + 12, false),
            transfer: dv.getUint16(colr!.offset + 14, false),
            matrix: dv.getUint16(colr!.offset + 16, false),
            ...(kind === 'nclx' ? { fullRange: (buf[colr!.offset + 18]! & 0x80) !== 0 } : {}),
        };

    let mastering: MasteringDisplay | undefined;
    const mdcv = findBox(buf, start, end, 'mdcv');
    const smdm = findBox(buf, start, end, 'SmDm');
    if (mdcv && mdcv.size >= 32) mastering = readMdcv(buf, mdcv.offset + 8);
    else if (smdm && smdm.size >= 36) {
        // VP9's SmDm: R, G, B and white point in 0.16 fixed point, luminance in 24.8 and 18.14.
        const at = smdm.offset + 12;
        const pair = (index: number): [number, number] => [
            dv.getUint16(at + index * 4, false) / 65536,
            dv.getUint16(at + index * 4 + 2, false) / 65536,
        ];
        mastering = {
            red: pair(0),
            green: pair(1),
            blue: pair(2),
            whitePoint: pair(3),
            maxLuminance: readU32(dv, at + 16) / 256,
            minLuminance: readU32(dv, at + 20) / 16384,
        };
    }

    const clli = findBox(buf, start, end, 'clli');
    const coll = findBox(buf, start, end, 'CoLL');
    const light =
        clli && clli.size >= 12
            ? {
                  maxContent: dv.getUint16(clli.offset + 8, false),
                  maxAverage: dv.getUint16(clli.offset + 10, false),
              }
            : coll && coll.size >= 16
              ? {
                    maxContent: dv.getUint16(coll.offset + 12, false),
                    maxAverage: dv.getUint16(coll.offset + 14, false),
                }
              : undefined;

    if (mastering || light)
        colour = {
            ...(colour ?? { primaries: 2, transfer: 2, matrix: 2 }),
            ...(mastering ? { mastering } : {}),
            ...(light ? { contentLight: light } : {}),
        };

    const fiel = findBox(buf, start, end, 'fiel');
    const fieldOrder =
        fiel && fiel.size >= 10
            ? readFiel(buf[fiel.offset + 8]!, buf[fiel.offset + 9]!)
            : undefined;
    return { colour, fieldOrder };
}

/** The 2x2 scaling and rotating part (a, b, c, d) of a 16.16 display matrix at `offset`. */
function readMatrix(dv: DataView, offset: number): number[] {
    if (offset + 36 > dv.byteLength) return [1, 0, 0, 1];
    return [0, 4, 12, 16].map(at => dv.getInt32(offset + at, false) / 65536);
}

/**
 * The pixel aspect a track's display matrix followed by the movie's states: how much more it scales
 * x than y, or undefined when both scale alike (within 1%, as ffmpeg decides) or the matrix is
 * degenerate.
 */
function matrixPixelAspect(track: readonly number[], movie: readonly number[]): number | undefined {
    const [a, b, c, d] = track as [number, number, number, number];
    const [e, f, g, h] = movie as [number, number, number, number];
    const x = Math.hypot(a * e + b * g, c * e + d * g);
    const y = Math.hypot(a * f + b * h, c * f + d * h);
    const unit = 1 / 65536;
    if (!(x > unit && y > unit && x < 256 && y < 256) || Math.abs(x / y - 1) <= 0.01)
        return undefined;
    return x / y;
}

/**
 * The closest fraction to `value` whose terms fit 31 bits: its last continued-fraction convergent
 * that does.
 */
function nearestFraction(value: number): [number, number] {
    let [num, den, previousNum, previousDen] = [1, 0, 0, 1];
    for (let rest = value, step = 0; step < 64; step++) {
        const whole = Math.floor(rest);
        const nextNum = whole * num + previousNum;
        const nextDen = whole * den + previousDen;
        if (nextNum > 0x7fffffff || nextDen > 0x7fffffff) break;
        [previousNum, previousDen, num, den] = [num, den, nextNum, nextDen];
        if (rest - whole < 1e-9) break;
        rest = 1 / (rest - whole);
    }
    return [num, den];
}

/** Where a fragmented movie lies: its movie box, its first fragment and its fragment index. */
export interface FragmentedLayout {
    readonly moov: number;
    readonly firstFragment: number;
    readonly mfra: number;
}

/**
 * The layout of a large fragmented movie (two first probe windows, 4 MiB, or more) a probe
 * describes from a few reads: a movie box right before its first moof, and a fragment index (mfra)
 * its last box (mfro) places at the end; undefined for any other input, which is read whole.
 */
export async function fragmentedLayout(source: Source): Promise<FragmentedLayout | undefined> {
    const size = source.size;
    if (size < 2 * PROBE_WINDOWS.first) return undefined;
    const box = async (pos: number): Promise<{ type: string; size: number } | undefined> => {
        const header = await source.read(pos, Math.min(16, size - pos));
        if (header.length < 8) return undefined;
        const view = dataView(header);
        let length = view.getUint32(0, false);
        if (length === 1 && header.length >= 16)
            length = view.getUint32(8, false) * 0x100000000 + view.getUint32(12, false);
        return length >= 8 && pos + length <= size
            ? { type: ascii(header, 4, 4), size: length }
            : undefined;
    };
    for (let pos = 0, count = 0; count < 16 && pos + 8 <= size; count++) {
        const found = await box(pos);
        if (!found || found.type === 'mdat' || found.type === 'moof') return undefined;
        if (found.type === 'moov') {
            const firstFragment = pos + found.size;
            if ((await box(firstFragment))?.type !== 'moof') return undefined;
            const mfro = await source.read(size - 16, 16);
            const indexBytes = mfro.length === 16 ? readU32(dataView(mfro), 12) : 0;
            const mfra = size - indexBytes;
            return ascii(mfro, 4, 4) === 'mfro' && mfra > firstFragment && indexBytes <= 16 << 20
                ? { moov: pos, firstFragment, mfra }
                : undefined;
        }
        pos += found.size;
    }
    return undefined;
}

/** The composition offset of ctts run `run`, whose entries start at `at`. */
function compositionOffset(view: DataView, at: number, run: number, signed: boolean): number {
    return signed ? view.getInt32(at + 4 + run * 8) : view.getUint32(at + 4 + run * 8);
}

/** A scan of the composition timeline between its steps (codedEndStep). */
interface CodedEnd {
    readonly view: DataView;
    /** Where the stts entries start. */
    readonly timing: number;
    readonly runsAt: number;
    readonly runs: number;
    readonly signed: boolean;
    run: number;
    /** Samples left in the ctts run, the offset it shows, the decode time and the latest end. */
    left: number;
    shown: number;
    decoded: number;
    end: number;
}

/**
 * Scans stts entries [from, to) against the ctts runs for the latest presentation end, in media
 * units; false at a decode time past the exact integer range, which stops the scan.
 */
function codedEndStep(scan: CodedEnd, from: number, to: number): boolean {
    const { view, timing, runsAt, runs, signed } = scan;
    let inRun = scan.run;
    let left = scan.left;
    let shown = scan.shown;
    let decoded = scan.decoded;
    let latest = scan.end;
    for (let index = from; index < to; index++) {
        const at = timing + index * 8;
        let samples = view.getUint32(at);
        const delta = view.getUint32(at + 4);
        while (samples > 0) {
            while (left === 0 && inRun + 1 < runs) {
                inRun++;
                left = view.getUint32(runsAt + inRun * 8);
                shown = compositionOffset(view, runsAt, inRun, signed);
            }

            const span = left > 0 ? Math.min(samples, left) : samples;
            if (left === 0) shown = 0;
            latest = Math.max(latest, decoded + span * delta + shown);
            decoded += span * delta;
            samples -= span;
            if (left > 0) left -= span;
            if (!Number.isSafeInteger(decoded)) return false;
        }
    }
    scan.run = inRun;
    scan.left = left;
    scan.shown = shown;
    scan.decoded = decoded;
    scan.end = latest;
    return true;
}

/** Whether `size` bytes at `offset` lie in one of the media ranges, or in the input without any. */
function fitsMedia(
    ranges: readonly { readonly start: number; readonly end: number }[] | undefined,
    inputSize: number,
    offset: number,
    size: number,
): boolean {
    if (!ranges) return offset + size <= inputSize;
    let low = 0;
    let high = ranges.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (ranges[mid]!.start <= offset) low = mid + 1;
        else high = mid;
    }
    const range = ranges[low - 1];
    return !!range && offset + size <= range.end;
}

/**
 * The smallest movie box a description reads: the tables of a smaller one build in less time than
 * its description saves, and the first packet would read it again.
 */
const DESCRIBED_MOVIE_BYTES = 256 * 1024;

/**
 * The size of the movie box of an input whose top-level boxes are whole, with no movie fragment
 * among them, all within its first 16 boxes; 0 for any other. Read before the walk of every box,
 * which a damaged input makes repair and a fragmented one makes long.
 */
async function classicMovie(source: Source): Promise<number> {
    const size = source.size;
    let movie = 0;
    let pos = 0;
    for (let count = 0; count < 16 && pos + 8 <= size; count++) {
        const header = await source.read(pos, Math.min(16, size - pos));
        if (header.length < 8) return 0;
        const view = dataView(header);
        let length = view.getUint32(0, false);
        if (length === 1)
            length =
                header.length < 16
                    ? 0
                    : view.getUint32(8, false) * 0x100000000 + view.getUint32(12, false);
        else if (length === 0) length = size - pos;
        const type = ascii(header, 4, 4);
        if (length < 8 || length > size - pos || type === 'moof') return 0;
        if (type === 'moov') movie = length;
        pos += length;
    }
    return pos === size ? movie : 0;
}

/**
 * Whether a description may read a movie's tracks, by what their boxes state before any table is
 * read: no chapter track reference, one sample description and no composition shift box each.
 */
function describable(buf: Uint8Array, traks: readonly Box[]): boolean {
    const view = dataView(buf);
    for (const trak of traks) {
        const tref = childBox(buf, trak, 'tref');
        if (tref && childBox(buf, tref, 'chap')) return false;
        const mdia = childBox(buf, trak, 'mdia');
        const minf = mdia && childBox(buf, mdia, 'minf');
        const stbl = minf && childBox(buf, minf, 'stbl');
        const stsd = stbl && childBox(buf, stbl, 'stsd');
        if (stsd && (stsd.size < 16 || readU32(view, stsd.offset + 12) !== 1)) return false;
        if (stbl && childBox(buf, stbl, 'cslg')) return false;
    }
    return true;
}

/** A movie Mp4Demuxer.describe() described, and its index. */
export interface MovieDescription {
    readonly result: DemuxResult;
    readonly index: (
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
    ) => Promise<DemuxResult>;
}

/** A described track as demux() would give it, its list and where its tables lie. */
interface DescribedTrack {
    readonly list: 'videoTracks' | 'audioTracks' | 'subtitleTracks';
    readonly track: TrackInfo;
    readonly layout: TableLayout;
}

/**
 * A copy of a described track, its fields in their order, without its samples: a file may change
 * the track's fields and configurations as it describes them.
 */
function describedCopy(track: TrackInfo): TrackInfo {
    const fields = track as unknown as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(track)) copy[key] = key === 'samples' ? [] : fields[key];
    if (track.codecConfigurations)
        copy.codecConfigurations = track.codecConfigurations.map(entry => ({ ...entry }));
    return copy as unknown as TrackInfo;
}

/** MP4/MOV/M4A demuxer (windowed reads, fragmented input, sample-budget hardening). */
export class Mp4Demuxer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly allowEmptyTracks: boolean;
    declare private readonly fragmentsFrom: number | undefined;
    declare private readonly movie: Mp4DemuxerOptions['movie'];
    /** Where the movie box ends. */
    private moovEnd = 0;
    private isWorker = false;
    declare private source: Source;
    /**
     * Top-level box walks: the walk of the input that already happened, else reads that skip media
     * payloads.
     */
    declare private boxes: ByteReader;
    /** Reads of the movie box, which the page cache keeps no use for. */
    declare private uncachedRead: Source['read'];
    declare private implicitSampleInput: File | Blob | Source | 'ambiguous' | undefined;
    declare private sampleBlob: { input: Blob; source: BlobSource } | undefined;
    private movieHasMvex = false;
    private compactClassic = false;
    declare private signal: AbortSignal | undefined;
    private diagnostics = new DiagnosticContext();
    declare private externalFailure: { error: unknown } | undefined;
    private samplesRecovered = false;
    /**
     * Coded end in seconds of the chunk-layout sound track just read, or undefined for other
     * tracks.
     */
    declare private chunkAudioEnd: number | undefined;
    /**
     * The movie header's display matrix (a, b, c, d), which every track's own matrix is followed
     * by.
     */
    private movieMatrix: readonly number[] = [1, 0, 0, 1];
    declare private mediaRanges: Array<{ start: number; end: number }> | undefined;
    private trexDefaults = new Map<
        number,
        {
            descriptionIndex: number;
            duration: number;
            size: number;
            flags: number;
        }
    >();
    private fragmentNextDts = new Map<number, number>();
    /** esds MPEG audio tracks whose layer is read from the first fragment sample. */
    private layerPending = new Set<TrackInfo>();
    /** Sample descriptions of fragmented tracks, which each track fragment selects by index. */
    private readonly fragmentDescriptions = new Map<TrackInfo, SampleDescriptions>();
    declare private readonly limits: ResolvedDemuxBudget;
    declare private budget: DemuxIndexBudget;
    declare private context: Mp4ReadContext;
    /** A description's track summaries and where their tables lie (describe()). */
    declare private described: Map<SampleIndex, TableLayout> | undefined;
    declare private moovStart: number;

    constructor(options: Mp4DemuxerOptions = {}) {
        this.limits = resolveDemuxBudget(options);
        const { allowEmptyTracks } = options;
        if (allowEmptyTracks !== undefined && typeof allowEmptyTracks !== 'boolean') {
            throw new MediaForgeError('allowEmptyTracks must be a boolean', 'INPUT');
        }
        this.allowEmptyTracks = allowEmptyTracks ?? false;
        this.fragmentsFrom = options.fragmentsFrom;
        this.movie = options.movie;
    }

    /**
     * Parses the container with windowed reads and returns tracks plus encoded samples; honors
     * `signal`.
     */
    async demux(
        input: File | Blob | Source,
        signal?: AbortSignal,
        diagnostics?: DiagnosticContext,
    ): Promise<DemuxResult> {
        if (!this.isWorker) {
            const worker = new Mp4Demuxer({
                ...this.limits,
                allowEmptyTracks: this.allowEmptyTracks,
                fragmentsFrom: this.fragmentsFrom,
                movie: this.movie,
            });
            worker.isWorker = true;
            if (usesCompactSampleIndex(this)) enableCompactSampleIndex(worker);
            const result = await worker.demux(input, signal, diagnostics);
            if (this.implicitSampleInput === undefined) this.implicitSampleInput = input;
            else if (this.implicitSampleInput !== input) this.implicitSampleInput = 'ambiguous';
            return result;
        }

        try {
            this.signal = signal;
            this.diagnostics = diagnostics ?? new DiagnosticContext();
            return await this.demuxInner(input);
        } catch (e) {
            if (this.externalFailure && Object.is(this.externalFailure.error, e)) throw e;
            throw demuxFailure(e);
        }
    }

    /**
     * The tracks of a movie without fragments as demux() reads them, their tables checked but not
     * built (describeClassicSamples), and their index, built from the movie box read again.
     * Undefined where demux() could read anything else: on a warning or an error, or where it reads
     * a table otherwise than as one compact index or changes samples after the first ones.
     */
    async describe(
        input: Source,
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
    ): Promise<MovieDescription | undefined> {
        const movie = await awaitWithAbort(classicMovie(input), signal);
        if (movie < DESCRIBED_MOVIE_BYTES) return undefined;
        const worker = new Mp4Demuxer({ ...this.limits, allowEmptyTracks: this.allowEmptyTracks });
        worker.isWorker = true;
        enableCompactSampleIndex(worker);
        worker.described = new Map();
        worker.signal = signal;
        worker.diagnostics = diagnostics.fresh(() => worker.declined());
        let result: DemuxResult;
        try {
            if ((await compatibleMp4Source(input, worker.diagnostics, signal)) !== input)
                return undefined;
            result = await worker.demuxInner(input);
        } catch (error) {
            if (error instanceof MediaForgeError && error.code === 'ABORT') throw error;
            return undefined;
        }
        return worker.externalFailure ? undefined : worker.description(input, result);
    }

    /** describe()'s result: each track kept as read, to give its index to a copy of it. */
    private description(source: Source, result: DemuxResult): MovieDescription | undefined {
        const tracks: DescribedTrack[] = [];
        for (const list of ['videoTracks', 'audioTracks', 'subtitleTracks'] as const)
            for (const track of result[list] ?? []) {
                const summary = getCompactSampleIndex(track);
                const layout = summary && this.described!.get(summary);
                if (!layout) return undefined;
                const presentation = {
                    first: summary.firstPresentation,
                    last: summary.lastPresentationEnd,
                    sorted: summary.presentationSorted,
                };
                tracks.push({
                    list,
                    track: describedCopy(track),
                    layout: { ...layout, presentation },
                });
            }
        const { title, tags } = result;
        const movie = { start: this.moovStart, end: this.moovEnd };
        const ranges = this.mediaRanges;
        const limits = this.limits;
        return {
            result,
            index: async (signal, diagnostics) => {
                const length = movie.end - movie.start;
                const bytes = await awaitWithAbort(
                    uncachedReads(source)(movie.start, length),
                    signal,
                );
                if (bytes.length !== length) throw new DemuxError('The movie box was not read');
                const budget = new DemuxIndexBudget(limits);
                budget.reserveBytes(length, 'MP4 movie metadata');
                const read: DemuxResult = { videoTracks: [], audioTracks: [], title };
                if (tags) read.tags = tags;
                for (const { list, track, layout } of tracks) {
                    const copy = describedCopy(track);
                    const index = await createClassicSampleIndex({
                        ...layout,
                        bytes,
                        budget,
                        breathe: async () => {
                            await yieldEventLoop();
                            throwIfAborted(signal);
                        },
                        fitsMedia: (offset, size) => fitsMedia(ranges, source.size, offset, size),
                        ...sampleTableNotes({ recover: warning => diagnostics.recover(warning) }),
                        missing: (count, offset) =>
                            diagnostics.recover({
                                code: 'MP4_TRUNCATED_SAMPLES',
                                message: `Dropped ${count} incomplete or missing samples`,
                                format: 'mp4',
                                offset,
                            }),
                    });
                    bindCompactSampleIndex(copy, index, () =>
                        budget.reserveBytes(index.length * 256, 'MP4 compatibility sample array'),
                    );
                    (read[list] ??= []).push(copy);
                }
                return read;
            },
        };
    }

    /** Leaves a description: demux() reads the movie otherwise than a description would. */
    private declined(): never {
        const error = new DemuxError('The movie is read whole');
        this.externalFailure = { error };
        throw error;
    }

    private async demuxInner(
        input: Parameters<Mp4Demuxer['demux']>[0],
    ): ReturnType<Mp4Demuxer['demux']> {
        throwIfAborted(this.signal);
        const source = input instanceof Blob ? new BlobSource(input) : input;
        const guarded =
            (read: Source['read']): Source['read'] =>
            async (offset, length) => {
                try {
                    return await awaitWithAbort(read(offset, length), this.signal);
                } catch (error) {
                    this.externalFailure = { error };
                    throw error;
                }
            };
        this.source = {
            size: source.size,
            read: guarded((offset, length) => source.read(offset, length)),
        };
        this.uncachedRead = guarded(uncachedReads(source));
        this.boxes = walkedBoxReader(source, new WindowReader(source.size, this.uncachedRead));
        this.budget = new DemuxIndexBudget(this.limits);
        const compactClassic = (): boolean => this.compactClassic;
        const passOver = (): Mp4ReadContext['passOver'] =>
            this.fragmentsFrom === undefined
                ? undefined
                : { from: this.moovEnd, to: this.fragmentsFrom };
        this.context = {
            source: this.source,
            boxes: this.boxes,
            signal: this.signal,
            validation: this.diagnostics.validation,
            budget: this.budget,
            get compactClassic() {
                return compactClassic();
            },
            get passOver() {
                return passOver();
            },
            recover: diagnostic => this.recover(diagnostic),
            note: diagnostic => this.note(diagnostic),
            fitsMedia: (offset, size) => this.sampleFitsMedia(offset, size),
        };

        const kept = this.movie?.tracks && this.movie;
        const moovBuf = kept ? kept.moov : await this.findMoov();
        if (!moovBuf) throw new DemuxError('No moov box found');
        if (kept) this.moovEnd = kept.moovEnd!;

        const dv = dataView(moovBuf);
        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        // The movie's title, tags and gapless information read its boxes from one walk; a walk that
        // fails fails each read as it would on its own.
        let walked: UserDataBoxes | undefined;
        const movieData = (): UserDataBoxes =>
            (walked ??= userDataBoxes(moovBuf, 8, moovBuf.length));
        result.title = kept
            ? kept.title
            : this.optionalMetadata(
                  () => readMp4Title(moovBuf, 8, moovBuf.length, movieData()),
                  undefined,
              );
        const tags = kept
            ? kept.tags
            : this.optionalMetadata(
                  () => readMp4Tags(moovBuf, 8, moovBuf.length, movieData()),
                  undefined,
              );
        if (tags) result.tags = tags;
        const mvhd = findBox(moovBuf, 8, moovBuf.length, 'mvhd');
        let movieTimescale = 1000;
        if (mvhd) {
            const mvhdVer = readFullBoxVersion(moovBuf, mvhd, 108, 120);
            movieTimescale = readU32(dv, mvhd.offset + (mvhdVer === 0 ? 20 : 28));
            this.movieMatrix = readMatrix(dv, mvhd.offset + (mvhdVer === 0 ? 44 : 56));
        }
        demuxAssert(movieTimescale > 0, 'movie timescale must be greater than zero');
        const mvex = findBox(moovBuf, 8, moovBuf.length, 'mvex');
        if (mvex && this.described) this.declined();
        this.movieHasMvex = !!mvex;
        this.compactClassic = usesCompactSampleIndex(this) && !mvex;
        this.trexDefaults.clear();
        this.fragmentNextDts.clear();
        this.layerPending.clear();
        this.fragmentDescriptions.clear();
        if (mvex) {
            fragmentParts().catch(() => undefined);
            for (const trex of findBoxes(moovBuf, mvex.offset + 8, mvex.offset + mvex.size).filter(
                b => b.type === 'trex',
            )) {
                demuxAssert(trex.size >= 32, 'trex box is truncated');
                const tid = readU32(dv, trex.offset + 12);

                // A default index outside the track's descriptions is checked when a fragment
                // relies on it.
                const descriptionIndex = readU32(dv, trex.offset + 16);
                if (this.trexDefaults.has(tid))
                    malformedInput(`duplicate trex defaults for track ${tid}`);
                this.trexDefaults.set(tid, {
                    descriptionIndex,
                    duration: readU32(dv, trex.offset + 20),
                    size: readU32(dv, trex.offset + 24),
                    flags: readU32(dv, trex.offset + 28),
                });
            }
        }
        const traks = findBoxes(moovBuf, 8, moovBuf.length).filter(b => b.type === 'trak');
        if (!(traks.length <= DEMUX_LIMITS.maxTracks))
            malformedInput(
                `track count ${traks.length} exceeds the shared limit of ${DEMUX_LIMITS.maxTracks}`,
            );
        if (this.described && !describable(moovBuf, traks)) this.declined();
        if (traks.some(trak => needsEntryReaders(moovBuf, dv, trak)))
            sampleEntries().catch(() => undefined);
        this.preflightClassicSampleLedger(moovBuf, traks);
        this.mediaRanges = await this.findMediaRanges();

        const trackIdMap = new Map<number, TrackInfo>();

        // A damaged trak is skipped with a warning under compatible validation when another track
        // survives.
        const skipped: { index: number; error: DemuxError }[] = [];
        const parsed: (TrackInfo | undefined)[] = [];
        for (let index = 0; index < traks.length; index++) {
            const trak = traks[index]!;
            try {
                const track = kept
                    ? keptTrackOf(kept.tracks![index], result, this.fragmentDescriptions)
                    : await this.parseTrak(moovBuf, dv, trak, result, movieTimescale);
                parsed[index] = track;
                if (track && track.id && track.id > 0) {
                    if (trackIdMap.has(track.id))
                        malformedInput(`duplicate track identifier ${track.id}`);
                    trackIdMap.set(track.id, track);
                }
            } catch (e) {
                if (this.externalFailure && Object.is(this.externalFailure.error, e)) throw e;
                if (e instanceof MediaForgeError && (e.code === 'ABORT' || e.code === 'OOM'))
                    throw e;
                const error =
                    e instanceof DemuxError
                        ? e
                        : new DemuxError(
                              `Track parse failed: ${e instanceof Error ? e.message : String(e)}`,
                          );
                if (this.diagnostics?.validation !== 'compatible') throw error;
                skipped.push({ index, error });
            }
        }
        if (skipped.length) {
            if (!trackIdMap.size) throw skipped[0]!.error;
            for (const { index, error } of skipped)
                this.diagnostics?.warn({
                    code: 'MP4_TRACK_SKIPPED',
                    format: 'mp4',
                    message:
                        `Skipped unreadable trak ${index + 1} of ${traks.length}: ` +
                        `${error.message}`,
                });
        }
        // A movie of fragments only, parsed without a warning, keeps its tracks for the windows.
        if (
            this.movie &&
            !kept &&
            this.movieHasMvex &&
            !skipped.length &&
            !this.layerPending.size &&
            !this.diagnostics.warnings.length &&
            parsed.every(
                track => !track || (!track.samples.length && !getCompactSampleIndex(track)),
            )
        )
            Object.assign(this.movie, {
                moov: moovBuf,
                moovEnd: this.moovEnd,
                title: result.title,
                tags,
                trex: new Map(this.trexDefaults),
                tracks: parsed.map(
                    track =>
                        track && {
                            track: { ...track },
                            list: result.videoTracks.includes(track)
                                ? 'videoTracks'
                                : result.audioTracks.includes(track)
                                  ? 'audioTracks'
                                  : 'subtitleTracks',
                            descriptions: this.fragmentDescriptions.get(track),
                        },
                ),
            });

        if (this.movieHasMvex) {
            for (const [trackId, track] of trackIdMap) {
                const last = track.samples[track.samples.length - 1];
                if (!last) {
                    this.fragmentNextDts.set(trackId, 0);
                    continue;
                }
                const timescale = track.timescale || track.sampleRate || 90000;
                const rawDecode = decodeTime(last) - (track.editTimelineShiftSeconds ?? 0);
                const nextDts = Math.round((rawDecode + last.duration) * timescale);
                if (!(Number.isSafeInteger(nextDts) && nextDts >= 0))
                    malformedInput(`track ${trackId} classic-to-fragment decode time is invalid`);
                this.fragmentNextDts.set(trackId, nextDts);
            }
            const { parseFragments } = await fragmentParts();
            await parseFragments(
                this.context,
                {
                    trexDefaults: this.trexDefaults,
                    fragmentNextDts: this.fragmentNextDts,
                    fragmentDescriptions: this.fragmentDescriptions,
                    layerPending: this.layerPending,
                },
                result,
                trackIdMap,
                usesCompactSampleIndex(this),
            );
            for (const track of this.layerPending) await this.readMpegAudioLayer(track);
        }

        const chapterTracks = this.chapterTracks(moovBuf, traks, result, trackIdMap);
        if (chapterTracks.length && this.described) this.declined();
        if (chapterTracks.length)
            await (await trackFixes()).readChapterTracks(this.context, result, chapterTracks);
        const allTracks = [
            ...result.videoTracks,
            ...result.audioTracks,
            ...(result.subtitleTracks ?? []),
        ];
        demuxAssert(allTracks.length > 0, 'no decodable tracks');
        for (const t of allTracks) {
            const index = getCompactSampleIndex(t);
            if (!index) this.fillZeroDurations(t.samples);
            const length = index?.length ?? t.samples.length;
            demuxAssert(
                t.timescale === undefined || t.timescale > 0 || (t.sampleRate ?? 0) > 0,
                'timescale is zero',
            );
            if (length === 0 && this.allowEmptyTracks && (this.movieHasMvex || t.incomplete))
                continue;
            if (!(length > 0)) malformedInput(`track '${t.codec}' has no samples`);
            if (
                t.editAbsoluteMediaTimeSeconds !== undefined &&
                t.editTimelineShiftSeconds !== undefined
            ) {
                const first = index ? index.get(0) : t.samples[0]!;
                const editedFirstDecode = decodeTime(first);
                const rawFirstDecode = editedFirstDecode - t.editTimelineShiftSeconds;
                const discard = t.editAbsoluteMediaTimeSeconds - rawFirstDecode;
                if (!Number.isFinite(discard))
                    malformedInput(`track '${t.codec}' edit discard is non-finite`);

                t.editMediaTimeSeconds = Math.max(0, discard);
            }
            let firstPresentation = index?.firstPresentation ?? Number.POSITIVE_INFINITY;
            let lastPresentationEnd = index?.lastPresentationEnd ?? Number.NEGATIVE_INFINITY;
            if (!index)
                for (const sample of t.samples) {
                    firstPresentation = Math.min(firstPresentation, sample.timestamp);
                    lastPresentationEnd = Math.max(
                        lastPresentationEnd,
                        sample.timestamp + sample.duration,
                    );
                }

            // An edit list states what the track presents: its edits end the track (ISO/IEC
            // 14496-12 8.3.2, the track header duration sums them), whatever media the samples code
            // before or after the edit.
            if (t.editList && t.editPresentationDurationSeconds !== undefined)
                t.duration =
                    (t.editLeadTimeSeconds ?? 0) +
                    (t.editPresentationDurationUnits !== undefined && t.timescale
                        ? t.editPresentationDurationUnits / t.timescale
                        : t.editPresentationDurationSeconds);
            else if (Number.isFinite(firstPresentation) && Number.isFinite(lastPresentationEnd)) {
                // An edit that runs to the end of the media (a fragmented movie's) presents from
                // its start: what the samples code before it, such as an encoder's priming, is not
                // presented.
                const start = t.editList
                    ? Math.max(firstPresentation, t.editLeadTimeSeconds ?? 0)
                    : firstPresentation;
                t.duration = Math.max(t.duration, lastPresentationEnd - start);
            }
        }
        const gapless = kept
            ? kept.gapless
            : this.optionalMetadata(
                  () => readMp4GaplessInfo(moovBuf, 8, moovBuf.length, movieData()),
                  undefined,
              );
        if (this.movie?.tracks && !kept) this.movie.gapless = gapless;
        if (gapless) this.applyGaplessInfo(result.audioTracks, gapless);
        throwIfAborted(this.signal);
        return result;
    }

    /**
     * iTunes gapless trims (iTunSMPB) of the single AAC track of a movie without an edit list: the
     * encoder delay and, when the counts add up to the coded samples, the padding. The tag counts
     * core samples, so an explicitly signalled SBR rate scales them; packet times stay as coded.
     */
    private applyGaplessInfo(tracks: TrackInfo[], info: Mp4GaplessInfo): void {
        const track = tracks.length === 1 ? tracks[0]! : undefined;
        if (!track || !/^mp4a\.40\./.test(track.codec) || track.editList || !track.codecConfig)
            return;
        const config = parseAacAudioSpecificConfig(track.codecConfig);
        const count = sampleCount(track);
        if (!config || !count || info.priming <= 0) return;
        const frameLength = config.frameLengthShort ? 960 : 1024;
        const scale = config.sampleRate / config.coreSampleRate;
        const first = sampleAt(track, 0)!;

        // The tag counts every decoded frame, also where the sample table shortens the last packet.
        const coreFrames = count * frameLength;
        if (Math.abs(first.duration * track.sampleRate - frameLength * scale) > scale) {
            this.note({
                code: 'MP4_GAPLESS_IGNORED',
                format: 'mp4',
                message: 'Ignored iTunSMPB gapless data: the packets are not AAC frames',
            });
            return;
        }
        const padding =
            info.validSamples > 0 && info.priming + info.validSamples <= coreFrames
                ? coreFrames - info.priming - info.validSamples
                : info.padding;
        if (info.priming + padding >= coreFrames) {
            this.note({
                code: 'MP4_GAPLESS_IGNORED',
                format: 'mp4',
                message: 'Ignored iTunSMPB gapless data longer than the coded audio',
            });
            return;
        }

        // Without an edit list the zero edit start only stands for "no edit"; the priming states
        // the discard.
        delete track.editMediaTimeSeconds;
        track.audioPrimingSamples = Math.round(info.priming * scale);
        if (padding > 0) track.audioTrailingPaddingSamples = Math.round(padding * scale);
    }

    /**
     * End of the media's composition timeline in media units: the latest decode time plus
     * composition offset plus duration of any sample. Edit-list media times are composition times,
     * so B-frame delays count.
     */
    private async compositionEndUnits(
        buf: Uint8Array,
        dv: DataView,
        mdiaS: number,
        mdiaE: number,
    ): Promise<number | undefined> {
        const minf = findBox(buf, mdiaS, mdiaE, 'minf');
        const stbl = minf ? childBox(buf, minf, 'stbl') : undefined;
        if (!stbl) return undefined;
        const stts = childBox(buf, stbl, 'stts');
        if (!stts || stts.size < 16) return undefined;
        const count = readU32(dv, stts.offset + 12);
        if (stts.offset + 16 + count * 8 > stts.offset + stts.size) return undefined;
        const ctts = childBox(buf, stbl, 'ctts');
        let runs = 0;
        let signed = false;
        if (ctts && ctts.size >= 16) {
            runs = readU32(dv, ctts.offset + 12);
            if (ctts.offset + 16 + runs * 8 > ctts.offset + ctts.size) return undefined;

            // Legacy QuickTime stores signed version-0 offsets when an intact cslg states a
            // negative least offset.
            const cslg = buf[ctts.offset + 8] === 0 ? childBox(buf, stbl, 'cslg') : null;
            signed =
                buf[ctts.offset + 8] === 1 ||
                (cslg !== null &&
                    cslg.size >= 32 &&
                    buf[cslg.offset + 8] === 0 &&
                    dv.getInt32(cslg.offset + 16) < 0);
        }
        const runsAt = ctts ? ctts.offset + 16 : 0;
        const scan: CodedEnd = {
            view: dv,
            timing: stts.offset + 16,
            runsAt,
            runs,
            signed,
            run: 0,
            left: runs ? dv.getUint32(runsAt) : 0,
            shown: runs ? compositionOffset(dv, runsAt, 0, signed) : 0,
            decoded: 0,
            end: 0,
        };

        // Synchronous steps of 32,768 stts entries with a yield between them: V8 does not optimize
        // a loop inside an async function while it runs.
        for (let index = 0; index < count; index += 0x8000) {
            if (index > 0) await yieldEventLoop();
            if (!codedEndStep(scan, index, Math.min(count, index + 0x8000))) return undefined;
        }
        return scan.end;
    }

    private recover(diagnostic: Parameters<DiagnosticContext['recover']>[0]): void {
        try {
            this.diagnostics.recover(diagnostic);
        } catch (error) {
            this.externalFailure = { error };
            throw error;
        }
    }

    /**
     * Titles, names and roles are optional: a damaged metadata box is reported under metadataPolicy
     * and skipped.
     */
    private optionalMetadata<T>(read: () => T, fallback: T): T {
        try {
            return read();
        } catch (error) {
            if (!(error instanceof DemuxError)) throw error;
            try {
                this.diagnostics.metadata({
                    code: 'MP4_METADATA_SKIPPED',
                    format: 'mp4',
                    message: `Skipped unreadable MP4 metadata: ${error.message}`,
                });
            } catch (failure) {
                this.externalFailure = { error: failure };
                throw failure;
            }
            return fallback;
        }
    }

    /** Non-structural finding that every validation mode reports and continues past. */
    private note(diagnostic: Parameters<DiagnosticContext['warn']>[0]): void {
        try {
            this.diagnostics.warn(diagnostic);
        } catch (error) {
            this.externalFailure = { error };
            throw error;
        }
    }

    private preflightClassicSampleLedger(buf: Uint8Array, traks: Box[]): void {
        const dv = dataView(buf);
        let total = 0;
        for (let trackIndex = 0; trackIndex < traks.length; trackIndex++) {
            const trak = traks[trackIndex]!;
            const mdia = childBox(buf, trak, 'mdia');
            if (!mdia) continue;
            const minf = childBox(buf, mdia, 'minf');
            if (!minf) continue;
            const stbl = childBox(buf, minf, 'stbl');
            if (!stbl) continue;
            const stsz = childBox(buf, stbl, 'stsz');
            const stz2 = stsz ? null : childBox(buf, stbl, 'stz2');
            const sizeBox = stsz ?? stz2;
            if (!sizeBox) continue;
            if (!(sizeBox.size >= 20)) malformedInput(`${sizeBox.type} box is too short`);

            const stblS = stbl.offset + 8;
            const stblE = stbl.offset + stbl.size;
            const unitSamples = stsz ? chunkAudioUnitSamples(buf, dv, stblS, stblE) : undefined;
            const stsc = unitSamples && findBox(buf, stblS, stblE, 'stsc');
            const stco =
                unitSamples &&
                (findBox(buf, stblS, stblE, 'stco') ?? findBox(buf, stblS, stblE, 'co64'));
            const stsd = unitSamples && findBox(buf, stblS, stblE, 'stsd');
            const count =
                (stsc && stco && stsd && readU32(dv, stsz!.offset + 12) > 0
                    ? chunkAudioPacketCount(
                          dv,
                          stsc,
                          stco,
                          unitSamples!,
                          readU32(dv, stsd.offset + 12),
                          true,
                      )
                    : undefined) ?? readU32(dv, sizeBox.offset + 16);

            this.budget.checkSamples(count, `track ${trackIndex + 1}`);
            total += count;
            demuxAssert(
                Number.isSafeInteger(total),
                'classic sample count overflows a safe integer',
            );
        }

        this.budget.reserveSamples(
            total,
            this.compactClassic ? 0 : 256,
            'MP4 classic sample tables',
        );
    }

    private getTrackId(buf: Uint8Array, dv: DataView, trak: Box): number {
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;
        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        if (!tkhd) return 0;
        const ver = readFullBoxVersion(buf, tkhd, 92, 104);
        return ver === 0 ? readU32(dv, tkhd.offset + 20) : readU32(dv, tkhd.offset + 28);
    }

    private fillZeroDurations(samples: Sample[]): void {
        for (let i = 0; i < samples.length; i++) {
            const cur = samples[i]!;
            if (cur.duration > 0) continue;
            const next = samples[i + 1];
            const curDts = decodeTime(cur);
            if (next) {
                const dt = decodeTime(next) - curDts;
                if (dt > 0) {
                    cur.duration = dt;
                    continue;
                }
            }
            const prev = samples[i - 1];
            cur.duration = prev && prev.duration > 0 ? prev.duration : 1 / 1000;
        }
    }

    /**
     * Reads from the sole successfully demuxed input; pass an explicit input after reusing this
     * instance for different inputs.
     */
    async readSample(sample: Sample): Promise<Uint8Array>;
    async readSample(input: File | Blob | Source, sample: Sample): Promise<Uint8Array>;
    /** Reads one sample's bytes by its table entry with a windowed read. */
    async readSample(
        inputOrSample: File | Blob | Source | Sample,
        maybeSample?: Sample,
    ): Promise<Uint8Array> {
        let source: Source;
        let sample: Sample;

        if (maybeSample) {
            sample = maybeSample;
            const inp = inputOrSample;
            if (inp instanceof Blob) {
                source = this.blobSampleSource(inp);
            } else if ('read' in inp) {
                source = inp;
            } else {
                throw new MediaForgeError(
                    'readSample: a Sample cannot be used as the input source',
                    'INPUT',
                );
            }
        } else {
            if (inputOrSample instanceof Blob || 'read' in inputOrSample) {
                throw new MediaForgeError('readSample: sample argument is missing', 'INPUT');
            }
            sample = inputOrSample;
            const input = this.implicitSampleInput;
            if (input === undefined)
                throw new DemuxError(
                    'readSample: demux an input successfully first, or pass the input explicitly',
                );
            if (input === 'ambiguous')
                throw new DemuxError(
                    'readSample: this demuxer has read several inputs; pass the input',
                );
            source = input instanceof Blob ? this.blobSampleSource(input) : input;
        }

        return source.read(sample.offset, sample.size);
    }

    private blobSampleSource(input: Blob): BlobSource {
        if (this.sampleBlob?.input !== input)
            this.sampleBlob = { input, source: new BlobSource(input) };
        return this.sampleBlob.source;
    }

    /** A bounded top-level walk prevents recovery from treating metadata as media. */
    private async findMediaRanges(): Promise<Array<{ start: number; end: number }>> {
        const ranges: Array<{ start: number; end: number }> = [];
        const reader = this.boxes;
        const passOver = this.context.passOver;
        let pos = 0;
        for (let count = 0; pos + 8 <= this.source.size; count++) {
            if (passOver && pos >= passOver.from && pos < passOver.to) pos = passOver.to;
            demuxAssert(
                count < DEMUX_LIMITS.maxTopLevelBoxes,
                'MP4 media-range inspection exceeds the box budget',
            );
            if (count > 0 && (count & 31) === 0) await yieldEventLoop();
            throwIfAborted(this.signal);
            const header = await reader.bytes(pos, Math.min(16, this.source.size - pos));
            const view = dataView(header);
            let size = view.getUint32(0, false);
            const kind = ascii(header, 4, 4);
            const headerSize = size === 1 ? 16 : 8;
            if (size === 1) {
                if (header.length < 16 && kind === 'moof' && this.movieHasMvex) break;
                demuxAssert(header.length >= 16, 'truncated MP4 extended box header');
                size = view.getUint32(8, false) * 0x100000000 + view.getUint32(12, false);
            } else if (size === 0) size = this.source.size - pos;
            const damaged =
                kind !== 'mdat' &&
                kind !== 'moof' &&
                (size < headerSize || size > this.source.size - pos);
            if (damaged && pos > 0 && this.context.validation === 'compatible') {
                // A box header after the movie box that damage made unreadable (reported as
                // MP4_DAMAGED_BOX): the samples are read where the movie box places them, as
                // ffmpeg reads them, so the rest of the input may hold media.
                ranges.push({ start: pos, end: this.source.size });
                break;
            }
            demuxAssert(Number.isSafeInteger(size) && size >= headerSize, 'invalid MP4 box length');

            // A first box whose type bytes are media (old QuickTime movies, found by the format
            // sniffer only when its size leads to the movie box): the sample offsets count the
            // media data from the start of the input.
            const unnamed = pos === 0 && !/^[ -~]{4}$/.test(kind);
            if (unnamed)
                this.recover({
                    code: 'MP4_UNNAMED_MEDIA_BOX',
                    format: 'mp4',
                    offset: 0,
                    message: 'Read the unnamed data before the movie box as media data',
                });
            if (kind === 'mdat' || unnamed)
                ranges.push({
                    start: unnamed ? 0 : pos + headerSize,
                    end: Math.min(pos + size, this.source.size),
                });
            if (size > this.source.size - pos) {
                demuxAssert(
                    kind !== 'moof' || this.movieHasMvex,
                    'truncated moof requires fragmented movie metadata',
                );
                break;
            }
            pos += size;
        }
        return ranges;
    }

    private sampleFitsMedia(offset: number, size: number): boolean {
        return fitsMedia(this.mediaRanges, this.source.size, offset, size);
    }

    /** The text tracks another track names in its tref 'chap' box: QuickTime chapter tracks. */
    private chapterTracks(
        moov: Uint8Array,
        traks: readonly Box[],
        result: DemuxResult,
        tracks: ReadonlyMap<number, TrackInfo>,
    ): TrackInfo[] {
        const view = dataView(moov);
        const ids = new Set<number>();
        for (const trak of traks) {
            const tref = childBox(moov, trak, 'tref');
            const chap = tref && childBox(moov, tref, 'chap');
            if (chap)
                for (let at = chap.offset + 8; at + 4 <= chap.offset + chap.size; at += 4)
                    ids.add(readU32(view, at));
        }
        return (result.subtitleTracks ?? []).filter(
            track => track.id !== undefined && ids.has(track.id) && tracks.get(track.id) === track,
        );
    }

    private async findMoov(): Promise<Uint8Array | null> {
        const MOOV_CAP = 64 * 1024 * 1024;
        const fileSize = this.source.size;
        let pos = 0;
        const maxBoxes = Math.min(Math.floor(fileSize / 8) + 16, DEMUX_LIMITS.maxTopLevelBoxes);
        let boxes = 0;
        const reader = this.boxes;

        while (pos + 8 <= fileSize) {
            if (boxes > 0 && (boxes & 0x1f) === 0) await yieldEventLoop();
            throwIfAborted(this.signal);
            if (!(++boxes <= maxBoxes))
                malformedInput(`top-level box count implausible for a ${fileSize}-byte file`);
            const header = await reader.bytes(pos, Math.min(16, fileSize - pos));
            const dv = dataView(header);
            let boxSize = dv.getUint32(0, false);
            const type = ascii(header, 4, 4);

            if (boxSize === 1 && pos + 16 <= fileSize)
                boxSize = dv.getUint32(8, false) * 0x100000000 + dv.getUint32(12, false);
            if (boxSize === 0) boxSize = fileSize - pos;
            if (boxSize < 8) break;

            if (type === 'moov') {
                if (!(boxSize <= MOOV_CAP))
                    malformedInput(`moov box of ${boxSize} bytes exceeds the ${MOOV_CAP} cap`);
                if (pos + boxSize > fileSize) {
                    if (this.described) this.declined();
                    const repair = await movieRepair();

                    // A box lost inside a movie box at the end leaves it running past the end;
                    // one whose boxes reach the end as they are was cut by it.
                    const repaired =
                        this.context.validation === 'compatible'
                            ? await repair.repairedMovieBox(this.context.source, pos, boxSize)
                            : undefined;
                    if (repaired?.end === fileSize && repaired.resized) {
                        this.context.recover(repair.movieRepaired(pos));
                        return repaired.bytes;
                    }
                    return repair.truncatedMoov(this.context, pos, fileSize - pos);
                }
                this.moovStart = pos;
                this.moovEnd = pos + boxSize;
                if (usesCompactSampleIndex(this))
                    this.budget.reserveBytes(boxSize, 'MP4 movie metadata');
                const moov = await this.uncachedRead(pos, boxSize);

                // A QuickTime compressed movie box holds the movie box it stores in its cmov.
                const cmov = findBox(moov, 8, moov.length, 'cmov');
                if (!cmov) return moov;
                if (this.described) this.declined();
                return (await movieRepair()).uncompressedMoov(
                    this.context,
                    moov,
                    cmov,
                    usesCompactSampleIndex(this),
                );
            }

            pos += boxSize;
        }

        return null;
    }

    /**
     * The handler type of an hdlr box: version, reserved fields and the name are optional; only
     * the handler type decides how the track is read.
     */
    private handlerType(buf: Uint8Array, hdlr: Box): string {
        demuxAssert(hdlr.size >= 20, 'hdlr box is too short to hold a handler type');
        return ascii(buf, hdlr.offset + 16, 4);
    }

    /**
     * The handler of a track whose hdlr box is lost, from the media header its minf holds (vmhd
     * for video, smhd for sound), as ffmpeg reads such a track; only compatible reading guesses.
     */
    private inferredHandler(buf: Uint8Array, mdiaS: number, mdiaE: number, at: number): string {
        const minf = findBox(buf, mdiaS, mdiaE, 'minf');
        const header = (type: string): boolean => !!minf && !!childBox(buf, minf, type);
        const handler = header('vmhd') ? 'vide' : header('smhd') ? 'soun' : undefined;
        demuxAssert(
            !!handler && this.diagnostics.validation === 'compatible',
            'trak has no hdlr box (broken track structure)',
        );
        this.recover({
            code: 'MP4_HANDLER_INFERRED',
            format: 'mp4',
            offset: at,
            message:
                `A track has no hdlr box; its media header names it a ` +
                `${handler === 'vide' ? 'video' : 'sound'} track`,
        });
        return handler;
    }

    private async parseTrak(
        buf: Uint8Array,
        dv: DataView,
        trak: Box,
        result: DemuxResult,
        movieTimescale: number,
    ): Promise<TrackInfo | undefined> {
        throwIfAborted(this.signal);
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;

        const mdia = findBox(buf, trakS, trakE, 'mdia');
        demuxAssert(!!mdia, 'trak has no mdia box (broken track structure)');

        const mdiaS = mdia.offset + 8;
        const mdiaE = mdia.offset + mdia.size;

        const hdlr = findBox(buf, mdiaS, mdiaE, 'hdlr');
        const handlerType = hdlr
            ? this.handlerType(buf, hdlr)
            : this.inferredHandler(buf, mdiaS, mdiaE, trak.offset);
        const isVideo = handlerType === 'vide';
        const isAudio = handlerType === 'soun';
        const isSubtitle = SUBTITLE_HANDLERS.includes(handlerType);
        if (!isVideo && !isAudio && !isSubtitle) return;
        const metadata = this.optionalMetadata(
            () => readMp4TrackMetadata(buf, trakS, trakE, isSubtitle),
            {} as Mp4TrackMetadata,
        );
        const name =
            metadata.name ?? (hdlr ? readMp4HandlerName(buf, hdlr.offset, hdlr.size) : undefined);
        let forced = metadata.forced;

        const mdhd = findBox(buf, mdiaS, mdiaE, 'mdhd');
        let timescale = 90000;
        let mediaDuration = 0;
        let language: string | undefined;
        if (mdhd) {
            const ver = readFullBoxVersion(buf, mdhd, 32, 44);
            let packed = 0;
            if (ver === 0) {
                timescale = readU32(dv, mdhd.offset + 20);
                mediaDuration = readU32(dv, mdhd.offset + 24);
                if (mediaDuration === 0xffffffff) mediaDuration = 0;
                packed = dv.getUint16(mdhd.offset + 28, false);
            } else {
                timescale = readU32(dv, mdhd.offset + 28);
                const hi = readU32(dv, mdhd.offset + 32);
                const lo = readU32(dv, mdhd.offset + 36);
                mediaDuration = hi === 0xffffffff && lo === 0xffffffff ? 0 : hi * 0x100000000 + lo;
                demuxAssert(
                    Number.isSafeInteger(mediaDuration),
                    'mdhd duration exceeds JavaScript exact-integer range',
                );
                packed = dv.getUint16(mdhd.offset + 40, false);
            }
            demuxAssert(timescale > 0, 'track timescale must be greater than zero');
            const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
            if (letters.every(v => v >= 1 && v <= 26)) {
                const code = letters.map(v => String.fromCharCode(v + 0x60)).join('');
                if (code !== 'und') language = code;
            } else if (packed < 0x400) language = macintoshLanguage(packed);
        }

        // An extended language box keeps the BCP 47 tag the mdhd code abbreviates.
        const elng = findBox(buf, mdiaS, mdiaE, 'elng');
        if (elng)
            language =
                readMp4ExtendedLanguage(buf, elng.offset + 8, elng.offset + elng.size) ?? language;

        const edit = await this.readEditList(
            buf,
            dv,
            trakS,
            trakE,
            mdiaS,
            mdiaE,
            timescale,
            movieTimescale,
            isVideo,
        );
        const { editList } = edit;
        const header = this.readTrackHeader(buf, dv, trakS, trakE);

        const minf = findBox(buf, mdiaS, mdiaE, 'minf');
        if (!minf) malformedInput(`'${handlerType}' track has no minf box`);
        const stbl = childBox(buf, minf, 'stbl');
        if (!stbl) malformedInput(`'${handlerType}' track has no stbl box`);

        const stblS = stbl.offset + 8;
        const stblE = stbl.offset + stbl.size;

        const stsd = findBox(buf, stblS, stblE, 'stsd');
        if (!stsd)
            malformedInput(`'${handlerType}' track has no stsd box (broken sample description)`);
        if (!(stsd.size >= 16)) malformedInput(`'${handlerType}' track stsd box is truncated`);

        const entryCount = readU32(dv, stsd.offset + 12);
        if (!(entryCount >= 1)) malformedInput(`'${handlerType}' track stsd has no entries`);
        if (!(entryCount <= MAX_SAMPLE_DESCRIPTIONS))
            malformedInput(`'${handlerType}' track stsd has too many entries`);
        const entryRanges: { offset: number; size: number }[] = [];
        for (let index = 0, entryOffset = stsd.offset + 16; index < entryCount; index++) {
            if (!(entryOffset + 8 <= stsd.offset + stsd.size))
                malformedInput(`'${handlerType}' stsd entry is truncated`);
            const entrySize = readU32(dv, entryOffset);
            if (!(entrySize >= 8 && entryOffset + entrySize <= stsd.offset + stsd.size))
                malformedInput(`'${handlerType}' stsd entry exceeds its box`);
            entryRanges.push({ offset: entryOffset, size: entrySize });
            entryOffset += entrySize;
        }
        const parseEntry = (index: number): Promise<SampleEntry> =>
            this.parseSampleEntry(
                buf,
                dv,
                entryRanges[index]!.offset,
                entryRanges[index]!.size,
                isVideo,
                isSubtitle,
                header,
            );
        const descriptions = await this.sampleDescriptions(
            buf,
            dv,
            stblS,
            stblE,
            entryCount,
            handlerType,
            parseEntry,
            this.movieHasMvex,
        );
        const primary = descriptions.entries[0]!;
        const {
            codecFourCC,
            codec,
            width,
            height,
            sampleRate,
            channelCount,
            displayWidth,
            displayHeight,
            pixelAspectRatioNum,
            pixelAspectRatioDen,
            codecConfig,
            pcmFrameBytes,
            chunkUnit,
            codecTag,
            dolbyVisionConfig,
            fieldOrder,
            colour,
            spatial,
            spatialBoxes,
        } = primary;
        forced ||= primary.forced;

        this.samplesRecovered = false;
        this.chunkAudioEnd = undefined;
        const samples = await this.parseSamples(
            buf,
            dv,
            stblS,
            stblE,
            timescale,
            edit.shiftSeconds,
            pcmFrameBytes,
            chunkUnit,
            descriptions,
            isSubtitle,
        );
        if (!(
            samples.length > 0 ||
            this.movieHasMvex ||
            (this.allowEmptyTracks && this.samplesRecovered)
        ))
            malformedInput(`'${codec}' track has no samples and the file is not fragmented`);

        // A media header longer than the chunk-layout sound it describes: the frames end the track.
        const trackDuration = Math.min(
            timescale > 0 ? mediaDuration / timescale : 0,
            this.chunkAudioEnd ?? Infinity,
        );

        const track: TrackInfo = {
            id: this.getTrackId(buf, dv, trak),
            ...(this.samplesRecovered ? { incomplete: true } : {}),
            codec,
            ...(codecTag ? { codecTag } : {}),
            default: header.flags === undefined ? undefined : (header.flags & 1) !== 0,
            forced,
            commentary: metadata.commentary,
            name,
            title: metadata.title,
            language,
            colour,
            ...(isVideo && fieldOrder ? { fieldOrder } : {}),
            width,
            height,
            displayWidth: isVideo ? displayWidth : undefined,
            displayHeight: isVideo ? displayHeight : undefined,
            rotation: isVideo && header.rotation !== 0 ? header.rotation : undefined,
            pixelAspectRatioNum: isVideo ? pixelAspectRatioNum : undefined,
            pixelAspectRatioDen: isVideo ? pixelAspectRatioDen : undefined,
            // A sound entry above 65535 Hz (ISO PCM) leaves its rate zero for the media timescale.
            sampleRate: sampleRate || (isVideo || isSubtitle ? sampleRate : timescale),
            channelCount,
            duration: trackDuration,
            editLeadTimeSeconds: editList ? edit.leadSeconds : undefined,
            editAbsoluteMediaTimeSeconds: editList ? edit.skipSeconds : undefined,
            editTimelineShiftSeconds: editList ? edit.shiftSeconds : undefined,
            editMediaTimeSeconds: edit.skipSeconds,
            editPresentationDurationSeconds: edit.presentationDurationSeconds,
            editPresentationDurationUnits: edit.presentationDurationUnits,
            editList,
            presentationTimestampsIncludeEdits: editList !== undefined,
            samples: Array.isArray(samples) ? samples : [],
            codecConfig,
            ...(descriptions.configurations
                ? { codecConfigurations: descriptions.configurations }
                : {}),
            ...(dolbyVisionConfig ? { dolbyVisionConfig } : {}),
            ...(isVideo && spatial ? { spatial } : {}),
            ...(isVideo && spatialBoxes ? { spatialBoxes } : {}),
            timescale,
        };
        if (this.movieHasMvex) this.fragmentDescriptions.set(track, descriptions);

        if (!Array.isArray(samples)) {
            bindCompactSampleIndex(track, samples, () =>
                this.budget.reserveBytes(samples.length * 256, 'MP4 compatibility sample array'),
            );
        }
        await this.settleTrack(track, codecFourCC, isVideo, edit);

        if (isVideo) result.videoTracks.push(track);
        else if (isAudio) result.audioTracks.push(track);
        else (result.subtitleTracks ??= []).push(track);
        return track;
    }

    /**
     * A track's edit list as one sample timeline: the shift and lead of its presentation, the media
     * time it skips and its presented duration, limited to the coded media. A spliced video edit
     * list is kept as `splice`.
     */
    private async readEditList(
        buf: Uint8Array,
        dv: DataView,
        trakS: number,
        trakE: number,
        mdiaS: number,
        mdiaE: number,
        timescale: number,
        movieTimescale: number,
        isVideo: boolean,
    ): Promise<TrackEdit> {
        const edit: TrackEdit = { shiftSeconds: 0, leadSeconds: 0, skipSeconds: 0 };
        const edts = findBox(buf, trakS, trakE, 'edts');
        const elst = edts && childBox(buf, edts, 'elst');
        if (!elst) return edit;
        const elstVer = buf[elst.offset + 8];
        if (!(elstVer === 0 || elstVer === 1))
            malformedInput(`unsupported elst version ${elstVer}`);
        const declaredEntries = readU32(dv, elst.offset + 12);
        let p = elst.offset + 16;
        const entrySize = elstVer === 1 ? 20 : 12;
        const entryCount = Math.min(
            declaredEntries,
            Math.floor((elst.offset + elst.size - p) / entrySize),
        );
        if (entryCount < declaredEntries)
            this.recover({
                code: 'MP4_EDIT_LIST_COUNT',
                format: 'mp4',
                offset: elst.offset,
                message: `elst holds ${entryCount} of its ${declaredEntries} declared entries`,
            });
        let unitRate = true;
        let entries: Mp4EditListEntry[] = [];
        for (let i = 0; i < entryCount; i++) {
            let segmentDuration: number;
            let mediaTime: number;
            if (elstVer === 1) {
                segmentDuration = readU32(dv, p) * 0x100000000 + readU32(dv, p + 4);
                const hi = dv.getInt32(p + 8, false);
                const lo = readU32(dv, p + 12);
                mediaTime = hi * 0x100000000 + lo;
            } else {
                segmentDuration = readU32(dv, p);
                mediaTime = dv.getInt32(p + 4, false);
            }
            demuxAssert(
                Number.isSafeInteger(segmentDuration) && Number.isSafeInteger(mediaTime),
                'elst time exceeds JavaScript exact-integer range',
            );
            if (readU32(dv, p + (elstVer === 1 ? 16 : 8)) !== 0x00010000) unitRate = false;
            entries.push({ segmentDuration, mediaTime });
            p += entrySize;
        }

        // A presentation split into entries that continue one another is one edit.
        entries = joinEditSegments(entries, timescale, movieTimescale);
        const last = entries[entries.length - 1];

        // Players present media edits at normal speed whatever their rate (FFmpeg ignores
        // media_rate; writers put 1 instead of 0x10000, and a dwell of rate 0 still names the media
        // it starts at).
        if (!unitRate)
            this.note({
                code: 'MP4_EDIT_RATE_IGNORED',
                format: 'mp4',
                message:
                    'An edit list with a media rate other than 1.0 is presented at normal speed',
            });
        const supported =
            (entries.length === 1 ||
                (entries.length === 2 &&
                    entries[0]!.mediaTime === -1 &&
                    entries[0]!.segmentDuration > 0)) &&
            last !== undefined &&
            last.mediaTime >= 0 &&
            (last.segmentDuration > 0 || (this.movieHasMvex && last.segmentDuration === 0));
        // The coded end is worked out once for the track, whichever of its uses comes first.
        let coded: Promise<number | undefined> | undefined;
        const codedEnd = (): Promise<number | undefined> =>
            (coded ??= this.compositionEndUnits(buf, dv, mdiaS, mdiaE));
        if (!supported) {
            const end = this.movieHasMvex ? undefined : await codedEnd();
            const { simplifiedEditList } = await trackFixes();
            ({ entries, splice: edit.splice } = simplifiedEditList(this.context, entries, {
                held: entryCount,
                end,
                timescale,
                movieTimescale,
                video: isVideo,
                unitRate,
            }));
        }
        if (!entries.length) return edit;
        const mediaEntry = entries[entries.length - 1]!;
        if (entries.length === 2) {
            edit.leadSeconds = entries[0]!.segmentDuration / movieTimescale;
            edit.shiftSeconds += edit.leadSeconds;
        }
        edit.editList = {
            version: elstVer === 1 ? 1 : 0,
            movieTimescale,
            mediaTimescale: timescale,
            entries,
        };
        edit.shiftSeconds -= mediaEntry.mediaTime / timescale;
        edit.skipSeconds = mediaEntry.mediaTime / timescale;
        if (mediaEntry.segmentDuration > 0)
            edit.presentationDurationSeconds = mediaEntry.segmentDuration / movieTimescale;
        const codedUnits = this.movieHasMvex ? undefined : await codedEnd();
        if (codedUnits !== undefined && mediaEntry.mediaTime >= codedUnits) {
            this.note({
                code: 'MP4_EDIT_OUTSIDE_MEDIA',
                format: 'mp4',
                message: 'Ignored an edit list that starts past the coded media',
            });
            return {
                shiftSeconds: 0,
                leadSeconds: 0,
                skipSeconds: 0,
                ...(edit.splice ? { splice: edit.splice } : {}),
            };
        }
        if (codedUnits !== undefined && mediaEntry.segmentDuration > 0) {
            const presented = presentedMediaUnits(
                mediaEntry,
                timescale,
                movieTimescale,
                codedUnits,
            );
            if (presented.overshootTicks >= 1) {
                this.note({
                    code: 'MP4_EDIT_EXCEEDS_MEDIA',
                    format: 'mp4',
                    message: 'Cut an edit list that ends past the coded media',
                });
                edit.presentationDurationSeconds = presented.units / timescale;
            }
            edit.presentationDurationUnits = presented.units;
        }
        return edit;
    }

    /** The track header's flags, display size, rotation and the pixel aspect its matrix states. */
    private readTrackHeader(
        buf: Uint8Array,
        dv: DataView,
        trakS: number,
        trakE: number,
    ): TrackHeader {
        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        const header: TrackHeader = { displayWidth: 0, displayHeight: 0, rotation: 0 };
        if (!tkhd) return header;

        const tkhdVer = readFullBoxVersion(buf, tkhd, 92, 104);
        header.flags = readU32(dv, tkhd.offset + 8);
        const payloadStart = tkhd.offset + 12;
        const widthOff = payloadStart + (tkhdVer === 0 ? 72 : 84);
        const heightOff = payloadStart + (tkhdVer === 0 ? 76 : 88);
        if (widthOff + 4 <= tkhd.offset + tkhd.size && heightOff + 4 <= tkhd.offset + tkhd.size) {
            header.displayWidth = readU32(dv, widthOff) / 65536;
            header.displayHeight = readU32(dv, heightOff) / 65536;
        }

        const matrixOff = payloadStart + (tkhdVer === 0 ? 36 : 48);
        if (matrixOff + 36 <= tkhd.offset + tkhd.size) {
            header.matrixAspect = matrixPixelAspect(readMatrix(dv, matrixOff), this.movieMatrix);
            const a = dv.getInt32(matrixOff, false);
            const b = dv.getInt32(matrixOff + 4, false);
            const c = dv.getInt32(matrixOff + 12, false);
            const d = dv.getInt32(matrixOff + 16, false);

            const ONE = 0x10000;
            if (a === ONE && b === 0 && c === 0 && d === ONE) header.rotation = 0;
            else if (a === 0 && b === -ONE && c === ONE && d === 0) header.rotation = 90;
            else if (a === -ONE && b === 0 && c === 0 && d === -ONE) header.rotation = 180;
            else if (a === 0 && b === ONE && c === -ONE && d === 0) header.rotation = 270;
        }
        return header;
    }

    /**
     * What a track's codec and first samples settle once its samples are read: the MPEG audio
     * layer, ADTS-wrapped AAC, a decoder configuration repeated as the first sample, samples
     * without a picture, a spliced edit list, intra-only pictures before the edit, and Sorenson
     * Spark stored as H.263.
     */
    private async settleTrack(
        track: TrackInfo,
        codecFourCC: string,
        isVideo: boolean,
        edit: TrackEdit,
    ): Promise<void> {
        const { codec, codecConfig } = track;

        // ESDS object types 0x69/0x6B cover every MPEG audio layer; the first frame header names
        // the layer.
        if (
            ((codec === 'mp3' && codecFourCC === 'mp4a') || codecFourCC === '.mp2') &&
            !(await this.readMpegAudioLayer(track))
        )
            this.layerPending.add(track);
        // A description reads no samples past the first ones: a fix that needs them all, or that
        // changes them, leaves the movie to be read whole.
        const whole = (): void => {
            if (this.described) this.declined();
        };
        if (codec.startsWith('mp4a.40.') && !codecConfig && !this.movieHasMvex) {
            whole();
            await (await trackFixes()).unwrapAdtsSamples(this.context, track);
        }

        // Some writers stored the avcC record as the first sample too; it holds no picture, and
        // copies that frame NAL units could not carry it.
        if (codec.startsWith('avc') && codecConfig && sampleCount(track) > 1) {
            const first = sampleAt(track, 0)!;
            if (
                first.size === codecConfig.length &&
                sameBytes(
                    first.data ?? (await this.source.read(first.offset, first.size)),
                    codecConfig,
                )
            ) {
                const index = getCompactSampleIndex(track);
                if (index)
                    bindCompactSampleIndex(track, skipLeadingSamples(index, 1), () =>
                        this.budget.reserveBytes(
                            index.length * 256,
                            'MP4 compatibility sample array',
                        ),
                    );
                else track.samples.shift();
                this.note({
                    code: 'MP4_CONFIG_SAMPLE',
                    format: 'mp4',
                    trackId: track.id,
                    message:
                        `Dropped a first sample that repeats track ${track.id}'s ` +
                        `configuration`,
                });
            }
        }

        // A first sample that holds parameter sets or SEI alone: the writer stored units without a
        // picture as samples of their own, and its sync sample table cannot be trusted either.
        if (
            /^(avc|hev1|hvc1)/.test(codec) &&
            codecConfig &&
            sampleCount(track) > 1 &&
            !this.movieHasMvex
        ) {
            const first = sampleAt(track, 0)!;
            const lengthSize = nalLengthSize(codec, codecConfig);
            const hevc = !codec.startsWith('avc');
            if (
                first.size <= PICTURELESS_PROBE_BYTES &&
                !sampleUnits(
                    first.data ?? (await this.source.read(first.offset, first.size)),
                    lengthSize,
                    hevc,
                    true,
                ).picture
            ) {
                whole();
                const all = Array.from({ length: sampleCount(track) }, (_, index) =>
                    sampleAt(track, index)!,
                );
                const joined = await joinPicturelessSamples(
                    this.source,
                    all,
                    lengthSize,
                    hevc,
                    async () => {
                        await yieldEventLoop();
                        throwIfAborted(this.signal);
                    },
                );
                if (joined) {
                    this.budget.reserveBytes(
                        joined.samples.length * 256,
                        'MP4 joined access units',
                    );
                    track.samples = joined.samples;
                    this.recover({
                        code: 'MP4_PICTURELESS_SAMPLES',
                        format: 'mp4',
                        trackId: track.id,
                        message:
                            `Joined ${joined.joined} samples without a picture to the next ` +
                            `one`,
                    });
                }
            }
        }
        if (edit.splice) {
            whole();
            (await trackFixes()).spliceEdits(
                this.context,
                track,
                edit.splice.entries,
                edit.splice.fallback,
            );
        }

        // Every picture of an intra-only codec decodes alone, so samples that end before the edit
        // starts are never presented nor needed to decode what is: the track starts at the sample
        // the edit starts in, as ffmpeg's reader does, and each of its samples is a sync sample
        // whatever the sync sample table lists.
        if (isVideo && edit.editList && INTRA_ONLY_VIDEO.test(codec) && sampleCount(track) > 0) {
            whole();
            const count = sampleCount(track);
            let skip = 0;
            while (skip < count - 1) {
                const sample = sampleAt(track, skip)!;
                if (sample.timestamp + sample.duration > edit.leadSeconds + 1e-9) break;
                skip++;
            }
            const all = Array.from({ length: count - skip }, (_, index) =>
                sampleAt(track, index + skip)!,
            );
            if (skip || all.some(sample => !sample.isKeyframe)) {
                this.budget.reserveBytes(all.length * 256, 'MP4 intra-only samples');
                track.samples = all.map(sample =>
                    sample.isKeyframe ? sample : { ...sample, isKeyframe: true },
                );
            }
        }

        // F4V writes Sorenson Spark, the FLV variant of H.263, as 'H263'; its picture start code
        // carries version 1.
        if (codecFourCC === 'H263' && sampleCount(track) > 0) {
            const first = sampleAt(track, 0)!;
            const head =
                first.data ?? (await this.source.read(first.offset, Math.min(first.size, 3)));
            if (head.length >= 3 && head[0] === 0 && head[1] === 0 && (head[2]! & 0xfc) === 0x84)
                track.codec = 'flv1';
        }
    }

    /**
     * Reads the sample descriptions a track's samples select: those its stsc names in chunk order,
     * or for a fragmented track every entry, as fragments choose theirs. Entries that describe one
     * configuration share it; entries of one codec with different decoder configurations become
     * per-sample configurations; other mixes are unsupported.
     */
    private async sampleDescriptions(
        buf: Uint8Array,
        dv: DataView,
        stblS: number,
        stblE: number,
        entryCount: number,
        handlerType: string,
        parseEntry: (index: number) => Promise<SampleEntry>,
        fragmented: boolean,
    ): Promise<SampleDescriptions> {
        if (entryCount === 1)
            return { entries: [await parseEntry(0)], configIndex: Int32Array.of(0) };

        const stsc = findBox(buf, stblS, stblE, 'stsc');
        const selected: number[] = [];
        if (stsc && stsc.size >= 16) {
            const count = readU32(dv, stsc.offset + 12);
            demuxAssert(16 + count * 12 <= stsc.size, 'stsc table exceeds its box');
            for (let entry = 0; entry < count; entry++) {
                const index = readU32(dv, stsc.offset + 24 + entry * 12);
                if (!(index >= 1 && index <= entryCount))
                    malformedInput(`stsc selects unsupported sample_description_index ${index}`);
                if (!selected.includes(index - 1)) selected.push(index - 1);
            }
        }

        const configIndex = new Int32Array(entryCount).fill(-1);
        const entries: SampleEntry[] = [];

        const read = async (index: number, required: boolean): Promise<void> => {
            let entry: SampleEntry;
            try {
                entry = await parseEntry(index);
            } catch (error) {
                // A fragment that selects an unreadable entry is rejected when it does.
                if (required || !(error instanceof DemuxError)) throw error;
                return;
            }

            const same = entries.findIndex(
                other =>
                    other.codec === entry.codec &&
                    other.width === entry.width &&
                    other.height === entry.height &&
                    other.sampleRate === entry.sampleRate &&
                    other.channelCount === entry.channelCount &&
                    sameBytes(other.codecConfig, entry.codecConfig),
            );
            configIndex[index] = same >= 0 ? same : entries.push(entry) - 1;
        };

        for (const index of selected) await read(index, true);
        if (fragmented)
            for (let index = 0; index < entryCount; index++)
                if (!selected.includes(index))
                    await read(index, !entries.length && index === entryCount - 1);

        if (!(entries.length > 0))
            malformedInput(`'${handlerType}' track has no readable sample description`);
        if (entries.length === 1) return { entries, configIndex };

        const family = codecFamily(entries[0]!.codec);
        const compatible = entries.every(
            entry => codecFamily(entry.codec) === family && entry.codecConfig?.length,
        );
        if (entries.some(entry => entry.codecFourCC === 'encv' || entry.codecFourCC === 'enca'))
            malformedInput(
                `'${handlerType}' track mixes encrypted and clear samples, which is not supported`,
            );
        if (fragmented && !selected.length && !compatible)
            return { entries, configIndex, pending: true };
        if (!compatible)
            malformedInput(
                `'${handlerType}' track switches between codecs, which is not supported`,
            );
        return {
            entries,
            configIndex,
            configurations: codecConfigurations(entries, handlerType === 'vide'),
        };
    }

    /**
     * One sample description of a track's stsd: its codec, picture or sound shape and decoder
     * configuration.
     */
    private async parseSampleEntry(
        buf: Uint8Array,
        dv: DataView,
        entryOffset: number,
        entrySize: number,
        isVideo: boolean,
        isSubtitle: boolean,
        header: TrackHeader,
    ): Promise<SampleEntry> {
        const codecFourCC = ascii(buf, entryOffset + 4, 4);
        if (isVideo)
            return this.visualSampleEntry(buf, dv, entryOffset, entrySize, codecFourCC, header);
        if (!isSubtitle) return this.soundSampleEntry(buf, dv, entryOffset, entrySize, codecFourCC);
        const { subtitleEntry } = await sampleEntries();
        const { codec, codecConfig, forced } = subtitleEntry(
            buf,
            dv,
            entryOffset,
            entrySize,
            codecFourCC,
        );
        return { ...EMPTY_ENTRY, codecFourCC, codec, codecConfig, forced };
    }

    /** A visual sample entry: its picture, display shape and codec. */
    private async visualSampleEntry(
        buf: Uint8Array,
        dv: DataView,
        entryOffset: number,
        entrySize: number,
        codecFourCC: string,
        header: TrackHeader,
    ): Promise<SampleEntry> {
        if (!(entrySize >= 86)) malformedInput(`'${codecFourCC}' video sample entry is truncated`);
        const width = readU16(dv, entryOffset + 32);
        const height = readU16(dv, entryOffset + 34);
        let pixelAspectRatioNum = 1;
        let pixelAspectRatioDen = 1;

        const { colour, fieldOrder } = visualMetadata(
            buf,
            dv,
            entryOffset + 86,
            entryOffset + entrySize,
        );

        // A pasp with a zero spacing states no aspect, as ffmpeg reads it: the track is read as if
        // it had none.
        const paspBox = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'pasp');
        const pasp =
            paspBox &&
            paspBox.offset + 16 <= entryOffset + entrySize &&
            readU32(dv, paspBox.offset + 8) > 0 &&
            readU32(dv, paspBox.offset + 12) > 0
                ? paspBox
                : undefined;
        if (pasp) {
            pixelAspectRatioNum = readU32(dv, pasp.offset + 8);
            pixelAspectRatioDen = readU32(dv, pasp.offset + 12);
        }

        let codec: string;
        let codecConfig: Uint8Array | undefined;
        let codecTag: string | undefined;
        let dolbyVisionConfig: Uint8Array | undefined;
        if (codecFourCC === 'avc1' || codecFourCC === 'avc3') {
            const avcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'avcC');
            if (avcC) {
                codecConfig = buf.slice(avcC.offset + 8, avcC.offset + avcC.size);
                const profile = codecConfig[1] ?? 0x64;
                const compat = codecConfig[2] ?? 0x00;
                const level = codecConfig[3] ?? 0x28;
                const hex = (byte: number): string => byte.toString(16).padStart(2, '0');
                codec = `${codecFourCC}.${hex(profile)}${hex(compat)}${hex(level)}`;
            } else {
                codec = `${codecFourCC}.640028`;
            }
        } else {
            const { videoEntryCodec } = await sampleEntries();
            const entry = videoEntryCodec(
                buf,
                dv,
                entryOffset,
                entrySize,
                codecFourCC,
                pasp !== undefined,
            );
            ({ codec, codecConfig, codecTag, dolbyVisionConfig } = entry);
            if (entry.aspect) [pixelAspectRatioNum, pixelAspectRatioDen] = entry.aspect;
        }

        const {
            displayWidth: tkhdDisplayWidth,
            displayHeight: tkhdDisplayHeight,
            matrixAspect,
        } = header;
        let displayWidth = tkhdDisplayWidth > 0 ? tkhdDisplayWidth : width;
        let displayHeight = tkhdDisplayHeight > 0 ? tkhdDisplayHeight : height;
        if ((displayWidth <= 0 || displayHeight <= 0) && width > 0 && height > 0) {
            displayWidth = width;
            displayHeight = height;
        }
        if (displayWidth <= 0 && width > 0) displayWidth = width;
        if (displayHeight <= 0 && height > 0) displayHeight = height;
        if (pixelAspectRatioNum > 0 && pixelAspectRatioDen > 0 && width > 0 && height > 0) {
            const paspWidth = (width * pixelAspectRatioNum) / pixelAspectRatioDen;
            if (!(tkhdDisplayWidth > 0) && Number.isFinite(paspWidth) && paspWidth > 0) {
                displayWidth = paspWidth;
                displayHeight = height;
            }
        }

        // A display matrix that scales one axis more than the other states the pixel aspect where
        // no pasp does (as ffmpeg reads it); tkhd's size is the picture before that matrix.
        if (!pasp && matrixAspect !== undefined && width > 0 && height > 0) {
            [pixelAspectRatioNum, pixelAspectRatioDen] = nearestFraction(matrixAspect);
            displayWidth = width * matrixAspect;
            displayHeight = height;
        }

        // Spatial video: an MV-HEVC layer, Apple's video extended usage and field of view.
        const spatialEntry = ['lhvC', 'vexu', 'hfov'].some(type =>
            findBox(buf, entryOffset + 86, entryOffset + entrySize, type),
        )
            ? (await sampleEntries()).spatialVideoOf(buf, entryOffset + 86, entryOffset + entrySize)
            : undefined;
        return {
            ...(spatialEntry?.spatial ? { spatial: spatialEntry.spatial } : {}),
            ...(spatialEntry ? { spatialBoxes: spatialEntry.boxes } : {}),
            ...EMPTY_ENTRY,
            codecFourCC,
            codec,
            width,
            height,
            displayWidth,
            displayHeight,
            pixelAspectRatioNum,
            pixelAspectRatioDen,
            codecConfig,
            codecTag,
            dolbyVisionConfig,
            colour,
            fieldOrder,
        };
    }

    /** A sound sample entry: its codec, rate, channels and decoder configuration. */
    private async soundSampleEntry(
        buf: Uint8Array,
        dv: DataView,
        entryOffset: number,
        entrySize: number,
        codecFourCC: string,
    ): Promise<SampleEntry> {
        const audioVersion = readU16(dv, entryOffset + 16);
        const extStart = entryOffset + (audioVersion === 2 ? 72 : audioVersion === 1 ? 52 : 36);

        let sampleRate: number;
        let channelCount: number;
        if (audioVersion === 2 && entryOffset + 52 <= entryOffset + entrySize) {
            sampleRate = Math.round(dv.getFloat64(entryOffset + 40, false)) || 48000;
            channelCount = readU32(dv, entryOffset + 48) || 2;
        } else {
            channelCount = readU16(dv, entryOffset + 24);
            sampleRate = readU16(dv, entryOffset + 32);
        }

        if (codecFourCC === 'samr' || codecFourCC === 'sawb') {
            // AMR is mono at 8 or 16 kHz (3GPP TS 26.244); phones write a zero rate and two
            // channels.
            sampleRate = codecFourCC === 'samr' ? 8000 : 16000;
            channelCount = 1;
        }

        if (codecFourCC !== 'mp4a') {
            const { audioEntry } = await sampleEntries();
            const shape = { audioVersion, extStart, sampleRate, channelCount };
            return {
                ...EMPTY_ENTRY,
                codecFourCC,
                ...audioEntry(buf, dv, entryOffset, entrySize, codecFourCC, shape),
            };
        }

        const esds = parseEsds(buf, extStart, entryOffset + entrySize);
        const objectType = esds?.objectType ?? 0x40;
        let codec = AAC_CODECS.get(objectType);
        let codecConfig: Uint8Array | undefined;
        if (codec === undefined) {
            const { esdsAudioEntry } = await sampleEntries();
            ({ codec, codecConfig, sampleRate, channelCount } = esdsAudioEntry(
                objectType,
                esds?.specificInfo,
                sampleRate,
                channelCount,
            ));
        } else if (esds?.specificInfo) {
            codecConfig = esds.specificInfo;
            const parsedAsc = parseAacAudioSpecificConfig(esds.specificInfo);
            if (parsedAsc?.audioObjectType) codec = `mp4a.40.${parsedAsc.audioObjectType}`;
            if (parsedAsc?.sampleRate) sampleRate = parsedAsc.sampleRate;
            if (parsedAsc?.channelCount) channelCount = parsedAsc.channelCount;
        }

        return { ...EMPTY_ENTRY, codecFourCC, codec, sampleRate, channelCount, codecConfig };
    }

    /**
     * Names the MPEG audio layer from the first sample header; false while the track has no sample
     * yet.
     */
    private async readMpegAudioLayer(track: TrackInfo): Promise<boolean> {
        const first = sampleAt(track, 0);
        if (!first || first.size < 4) return false;
        const header = first.data ?? (await this.source.read(first.offset, 4));
        const layer = (header[1]! >> 1) & 3;
        if (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && layer)
            track.codec = layer === 3 ? 'mp1' : layer === 2 ? 'mp2' : 'mp3';
        return true;
    }

    private async parseSamples(
        buf: Uint8Array,
        dv: DataView,
        stblS: number,
        stblE: number,
        timescale: number,
        editShiftSeconds = 0,
        pcmFrameBytes = 0,
        chunkUnit?: ChunkAudioUnit,
        descriptions?: SampleDescriptions,
        instants = false,
    ): Promise<Sample[] | SampleIndex> {
        const switching = !!descriptions?.configurations;
        const stsz = findBox(buf, stblS, stblE, 'stsz');
        const stco = findBox(buf, stblS, stblE, 'stco') ?? findBox(buf, stblS, stblE, 'co64');
        const stts = findBox(buf, stblS, stblE, 'stts');
        const stsc = findBox(buf, stblS, stblE, 'stsc');
        const stss = findBox(buf, stblS, stblE, 'stss');
        const ctts = findBox(buf, stblS, stblE, 'ctts');
        const stz2 = findBox(buf, stblS, stblE, 'stz2');
        if ((!stsz && !stz2) || !stco || !stts || !stsc) return [];
        for (const box of [stco, stts, stsc, stss, ctts]) {
            if (box) if (!(box.size >= 16)) malformedInput(`${box.type} box is truncated`);
        }

        demuxAssert(timescale > 0, 'media timescale is zero');
        if (
            chunkUnit &&
            !switching &&
            stsz &&
            !ctts &&
            readU32(dv, stsz.offset + 12) > 0 &&
            chunkAudioUnitSamples(buf, dv, stblS, stblE) === chunkUnit.samples
        ) {
            if (this.described) this.declined();
            const { chunkAudioPackets } = await import('./read/chunk-audio');
            const packets = await chunkAudioPackets(
                this.context,
                dv,
                stsz,
                stsc,
                stco,
                chunkUnit,
                timescale,
                editShiftSeconds,
            );
            if (packets) {
                this.chunkAudioEnd = packets.end;
                if (packets.recovered) this.samplesRecovered = true;
                return packets.samples;
            }
        }
        const declaredCount = stsz ? readU32(dv, stsz.offset + 16) : readU32(dv, stz2!.offset + 16);
        this.budget.checkSamples(declaredCount, 'MP4 sample table');
        const sampleCount = declaredCount;

        if (sampleCount === 0) return [];

        if (
            this.compactClassic &&
            !switching &&
            (descriptions?.configIndex.length ?? 1) === 1 &&
            !findBox(buf, stblS, stblE, 'cslg')
        ) {
            const layout: TableLayout = {
                tables: {
                    sizes: stsz ?? stz2!,
                    chunks: stco,
                    layout: stsc,
                    timing: stts,
                    composition: ctts,
                    sync: stss,
                    partialSync: findBox(buf, stblS, stblE, 'stps'),
                    preRoll: stss && preRollGroups(buf, stblS, stblE),
                },
                timescale,
                shift: editShiftSeconds,
                mediaSpan: !this.mediaRanges
                    ? { start: 0, end: this.source.size }
                    : this.mediaRanges.length === 1
                      ? this.mediaRanges[0]
                      : undefined,
                strict: this.diagnostics.validation === 'strict',
                fileSize: this.source.size,
                pcmFrameBytes,
                instants,
            };
            const reading = {
                bytes: buf,
                budget: this.budget,
                breathe: async () => {
                    await yieldEventLoop();
                    throwIfAborted(this.signal);
                },
                fitsMedia: (offset: number, size: number) => this.sampleFitsMedia(offset, size),
                ...sampleTableNotes(this.context),
            };
            if (this.described) {
                const summary = await describeClassicSamples({ ...layout, ...reading });
                if (!summary) this.declined();
                this.described.set(summary, layout);
                return summary;
            }
            return createClassicSampleIndex({
                ...layout,
                ...reading,
                missing: (count, offset) => {
                    this.samplesRecovered = true;
                    this.recover({
                        code: 'MP4_TRUNCATED_SAMPLES',
                        message: `Dropped ${count} incomplete or missing samples`,
                        format: 'mp4',
                        offset,
                    });
                },
            });
        }
        if (this.described) this.declined();
        const { readSampleArray } = await import('./read/sample-tables');
        const read = await readSampleArray(
            this.context,
            buf,
            dv,
            { start: stblS, end: stblE },
            { stsz, stz2, stco, stts, stsc, stss, ctts },
            sampleCount,
            timescale,
            editShiftSeconds,
            pcmFrameBytes,
            descriptions,
            instants,
        );
        if (read.recovered) this.samplesRecovered = true;
        return read.samples;
    }
}
