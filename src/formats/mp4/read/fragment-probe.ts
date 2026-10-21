import type { DemuxResult, ProbedInput, ProbeTarget, TrackInfo } from '../../../core/model/track';
import type { Source } from '../../../core/model/types';
import type { DiagnosticContext } from '../../../core/errors/diagnostics';
import { DemuxIndexBudget, resolveDemuxBudget } from '../../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../../core/contracts/reader';
import { MediaForgeError, throwIfAborted } from '../../../core/errors/errors';
import { RangeSource } from '../../../core/io/sources/sources';
import { uncachedReads } from '../../../core/io/sources/cached-source';
import {
    enableCompactSampleIndex,
    getCompactSampleIndex,
    sampleAt,
    sampleCount,
} from '../../../core/model/sample-index';
import { decodeTime } from '../../../core/model/media-time';
import { dataView } from '../../../core/bytes/byte-fields';
import {
    PlaceSearch,
    WindowBytes,
    holdsAudioBefore,
    probeMiss,
    spanWindows,
    tracksOf,
} from '../../shared/large-input';
import { PROBE_WINDOWS } from '../../shared/probe-windows';
import { WindowReader } from '../../../core/io/sources/chunk-reader';
import { Mp4Demuxer, keptTrackOf, type FragmentedLayout, type KeptMovie } from '../reader';
import { readMp4GaplessInfo } from '../metadata';
import { ascii, findBoxes, readU32 } from './boxes';
import type { Mp4ReadContext } from './descriptions';
import type { SampleDescriptions } from './read-types';

/**
 * The head and the tail start at a fragment this many bytes from the input's start and end, and
 * grow fourfold to PROBE_WINDOWS.last (32 KiB times a power of 4 reaches 32 MiB).
 */
const FIRST_FRAGMENT_BYTES = 32 * 1024;

/** Samples inspected for the earliest presentation time, as an opened file's timeline does. */
const LEADING_SAMPLES = 32;

/**
 * Bytes read at a box of a window that no read holds yet: a moof of a few seconds and the header
 * of the media data after it, as one read.
 */
const MOOF_READ_BYTES = 16 * 1024;

/**
 * The sync sample times and moof positions of each track the fragment index (tfra) lists, in its
 * media time units, by track ID; undefined where the index cannot be read.
 */
function fragmentIndex(
    bytes: Uint8Array,
): Map<number, { readonly time: number; readonly position: number }[]> | undefined {
    const view = dataView(bytes);
    if (bytes.length < 8 || ascii(bytes, 4, 4) !== 'mfra') return undefined;
    const tracks = new Map<number, { time: number; position: number }[]>();
    for (const box of findBoxes(bytes, 8, Math.min(bytes.length, readU32(view, 0)), true)) {
        if (box.type !== 'tfra' || box.size < 24) continue;
        const version = bytes[box.offset + 8]!;
        const trackId = readU32(view, box.offset + 12);
        const lengths = readU32(view, box.offset + 16);
        const count = readU32(view, box.offset + 20);
        const numbers = ((lengths >> 4) & 3) + 1 + ((lengths >> 2) & 3) + 1 + (lengths & 3) + 1;
        // Version 1 states times and positions in 64 bits.
        const wide = version === 1 ? 8 : 4;
        const field = (at: number): number =>
            wide === 8
                ? readU32(view, at) * 0x100000000 + readU32(view, at + 4)
                : readU32(view, at);
        const entry = 2 * wide + numbers;
        if (box.offset + 24 + count * entry > box.offset + box.size) return undefined;
        const entries: { time: number; position: number }[] = [];
        for (let index = 0, at = box.offset + 24; index < count; index++, at += entry) {
            const time = field(at);
            const position = field(at + wide);
            if (!Number.isSafeInteger(time) || !Number.isSafeInteger(position)) return undefined;
            entries.push({ time, position });
        }
        tracks.set(trackId, entries);
    }
    return tracks.size ? tracks : undefined;
}

/**
 * The earliest presentation time among the first `count` samples of `track` (all by default), and
 * their latest presentation end.
 */
function presentedSpan(track: TrackInfo, count = Infinity): { first: number; end: number } {
    // A compact index keeps them for all of its samples.
    const index = getCompactSampleIndex(track);
    if (index && count >= index.length)
        return { first: index.firstPresentation, end: index.lastPresentationEnd };
    let first = Infinity;
    let end = -Infinity;
    for (let index = 0, last = Math.min(sampleCount(track), count); index < last; index++) {
        const sample = sampleAt(track, index)!;
        first = Math.min(first, sample.timestamp);
        end = Math.max(end, sample.timestamp + sample.duration);
    }
    return { first, end };
}

/**
 * A large fragmented movie described from its movie box, its fragment index (mfra), the fragments
 * at its start (the head) and those at its end (the tail), as a read of every fragment describes
 * it: each track's duration runs from the head's earliest presentation to the tail's latest end,
 * or as its edit list states. A window around a time, or a range, is the fragments the index
 * places around it, timed by their own decode times (tfdt). Undefined where the movie holds what
 * only a read of every fragment tells (gapless data counted over its samples), its fragments are
 * not listed, or a read of the head, the tail or a window warns.
 */
export async function probeFragmentedMp4(
    source: Source,
    layout: FragmentedLayout,
    options: { readonly limits: DemuxBudgetOptions; readonly compact: boolean },
    signal: AbortSignal | undefined,
    diagnostics: DiagnosticContext,
    target: ProbeTarget,
): Promise<ProbedInput | undefined> {
    const size = source.size;
    const read = uncachedReads(source);
    const moov = await read(layout.moov, layout.firstFragment - layout.moov);
    if (readMp4GaplessInfo(moov, 8, moov.length)) return undefined;
    const index = fragmentIndex(await read(layout.mfra, size - layout.mfra));
    if (!index) return undefined;

    /**
     * The boxes before the first fragment (the movie box), held for the windows, which read them
     * and their own fragments only (WindowBytes).
     */
    let heads: WindowReader | undefined;
    /**
     * The input up to `end` for a read of its fragments from `from` on: the movie box from what
     * is held, then zeros up to `from` (the read passes over them; only the reads of whole box
     * headers reach into them), then the fragments in chunks counted from `from`. Reads of the
     * fragments are views of those chunks, the others copies.
     */
    const windowInput = (from: number, end: number): Source => {
        const held = (heads ??= new WindowReader(layout.firstFragment, read, layout.firstFragment));
        const fragments = new WindowBytes(held, new RangeSource(source, 0, end), from);
        return {
            size: end,
            read: async (at, length) => {
                // The fragments are only read: those of one chunk are a view of it.
                if (at >= from) return fragments.bytes(at, length);
                const out = new Uint8Array(Math.max(0, Math.min(length, end - at)));
                const headBytes = Math.max(0, Math.min(out.length, layout.firstFragment - at));
                if (headBytes) out.set(await held.bytes(at, headBytes));
                const skip = Math.max(0, from - at);
                if (skip < out.length)
                    out.set(await fragments.bytes(at + skip, out.length - skip), skip);
                return out;
            },
        };
    };
    /** The tracks as the first read of fragments from `from` parsed them, for the others. */
    const movie: KeptMovie = {};
    /** The input up to `end`, read from the start or, with `from`, its fragments from there on. */
    const run = async (
        end: number,
        from?: number,
        runSignal = signal,
    ): Promise<DemuxResult | undefined> => {
        const demuxer = new Mp4Demuxer({
            ...options.limits,
            allowEmptyTracks: true,
            fragmentsFrom: from,
            movie: from === undefined ? undefined : movie,
        });
        if (options.compact) enableCompactSampleIndex(demuxer);
        const context = diagnostics.fresh();
        const input: Source =
            from === undefined ? new RangeSource(source, 0, end) : windowInput(from, end);
        try {
            const result = await demuxer.demux(input, runSignal, context);
            return context.warnings.length ? undefined : result;
        } catch (error) {
            return probeMiss(error);
        }
    };
    const positions = [...new Set([...index.values()].flat().map(entry => entry.position))]
        .filter(position => position >= layout.firstFragment && position < layout.mfra)
        .sort((a, b) => a - b);
    if (positions[0] !== layout.firstFragment) return undefined;
    /** Whether every track of `result` holds a sample. */
    const filled = (result: DemuxResult | undefined): result is DemuxResult =>
        !!result && tracksOf(result).every(track => sampleCount(track) > 0);

    // The head: the first fragments, from 32 KiB until every track holds a sample.
    let head: DemuxResult | undefined;
    let headEnd = layout.firstFragment;
    for (let bytes = FIRST_FRAGMENT_BYTES; !head && bytes <= PROBE_WINDOWS.last; bytes *= 4) {
        headEnd = positions.find(position => position - layout.firstFragment >= bytes) ?? size;
        if (headEnd > size / 2) return undefined;
        const result = await run(headEnd);
        if (filled(result)) head = result;
    }
    if (!head) return undefined;
    const tracks = tracksOf(head);

    // The tail, the last fragments: each track's latest end. A window alone needs none.
    if (!target.windowOnly || target.around === undefined) {
        let tail: DemuxResult | undefined;
        for (let bytes = FIRST_FRAGMENT_BYTES; !tail && bytes <= PROBE_WINDOWS.last; bytes *= 4) {
            const from = positions.filter(position => position <= layout.mfra - bytes).at(-1);
            if (from === undefined || from < headEnd) return undefined;
            const result = await run(size, from);
            if (filled(result)) tail = result;
        }
        if (!tail) return undefined;
        const ends = new Map(tracksOf(tail).map(track => [track.id, presentedSpan(track).end]));
        for (const track of tracks) {
            const end = ends.get(track.id);
            if (end === undefined) return undefined;
            if (track.editList && track.editPresentationDurationSeconds !== undefined) continue;
            track.duration = Math.max(track.duration, end - presentedSpan(track).first);
        }
    }
    const start = Math.min(...tracks.map(track => presentedSpan(track, LEADING_SAMPLES).first));
    const described = head;

    // The fragments by the index of the first track, in seconds of its presentation.
    const leading = described.videoTracks[0] ?? described.audioTracks[0];
    const listed = leading?.id !== undefined ? index.get(leading.id) : undefined;
    if (!leading || !listed?.length) return undefined;
    const timescale = leading.timescale || leading.sampleRate || 90000;
    const fragments = new PlaceSearch(
        listed
            .map(entry => ({
                position: entry.position,
                time: entry.time / timescale + (leading.editTimelineShiftSeconds ?? 0),
            }))
            .sort((a, b) => a.position - b.position),
    );

    /**
     * The tracks of the fragments from `from` to `to`, parsed as a window's demux parses them
     * (parseFragments) but from their moof boxes alone, read with the box header after each, into
     * copies of the tracks the movie box keeps: undefined where that demux would warn or fail, or
     * where it reads more than the fragments (a track of chapters), and the window's demux decides.
     */
    const parsedWindow = async (
        kept: KeptMovie,
        from: number,
        to: number,
        windowSignal?: AbortSignal,
    ): Promise<DemuxResult | undefined> => {
        if (!options.compact || !kept.tracks || !kept.trex) return undefined;
        const held: { readonly at: number; readonly bytes: Uint8Array }[] = [];
        const bytesAt = (at: number, length: number): Uint8Array | undefined => {
            for (const span of held)
                if (at >= span.at && at + length <= span.at + span.bytes.length)
                    return span.bytes.subarray(at - span.at, at - span.at + length);
            return undefined;
        };
        const hold = async (at: number, length: number): Promise<void> => {
            held.push({ at, bytes: await read(at, Math.min(length, to - at)) });
        };
        const media: { readonly start: number; readonly end: number }[] = [];
        for (let pos = from; pos + 8 <= to;) {
            throwIfAborted(windowSignal);
            if (!bytesAt(pos, Math.min(16, to - pos))) await hold(pos, MOOF_READ_BYTES);
            const header = bytesAt(pos, Math.min(16, to - pos))!;
            let size = readU32(dataView(header), 0);
            const type = ascii(header, 4, 4);
            const headerSize = size === 1 ? 16 : 8;
            if (size === 1) {
                if (header.length < 16) return undefined;
                size = readU32(dataView(header), 8) * 0x100000000 + readU32(dataView(header), 12);
            } else if (size === 0) size = to - pos;
            if (!(Number.isSafeInteger(size) && size >= headerSize && size <= to - pos))
                return undefined;
            if (type === 'moof') {
                if (size > 1024 * 1024) return undefined;
                if (!bytesAt(pos, Math.min(size + 16, to - pos))) await hold(pos, size + 16);
            } else if (type === 'mdat') media.push({ start: pos + headerSize, end: pos + size });
            pos += size;
        }

        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        const descriptions = new Map<TrackInfo, SampleDescriptions>();
        const trackIdMap = new Map<number, TrackInfo>();
        for (const keptTrack of kept.tracks) {
            if (keptTrack?.list === 'subtitleTracks') return undefined;
            const track = keptTrackOf(keptTrack, result, descriptions);
            if (track?.id && track.id > 0) trackIdMap.set(track.id, track);
        }
        let damaged = false;
        const context: Mp4ReadContext = {
            source: { size: to, read },
            boxes: {
                size: to,
                bytes: async (at, length) => bytesAt(at, length) ?? (await read(at, length)),
            },
            signal: windowSignal,
            validation: diagnostics.validation,
            budget: new DemuxIndexBudget(resolveDemuxBudget(options.limits)),
            compactClassic: false,
            recover: () => void (damaged = true),
            note: () => void (damaged = true),
            // As a demux finds its samples in the media data: in the mdat box placed last before
            // their first byte.
            fitsMedia: (offset, size) => {
                let range: (typeof media)[number] | undefined;
                for (const item of media) if (item.start <= offset) range = item;
                return !!range && offset + size <= range.end;
            },
            passOver: { from: 0, to: from },
        };
        const { parseFragments } = await import('./fragments');
        try {
            await parseFragments(
                context,
                {
                    trexDefaults: kept.trex,
                    fragmentNextDts: new Map([...trackIdMap.keys()].map(id => [id, 0])),
                    fragmentDescriptions: descriptions,
                    layerPending: new Set(),
                },
                result,
                trackIdMap,
                true,
            );
        } catch (error) {
            if (error instanceof MediaForgeError && error.code === 'ABORT') throw error;
            return undefined;
        }
        if (damaged) return undefined;
        for (const track of tracksOf(result)) {
            const index = getCompactSampleIndex(track);
            if (!index) {
                if (sampleCount(track)) return undefined;
                continue;
            }
            // The edit a demux places by the window's first sample.
            if (
                track.editAbsoluteMediaTimeSeconds !== undefined &&
                track.editTimelineShiftSeconds !== undefined &&
                !Number.isFinite(
                    track.editAbsoluteMediaTimeSeconds -
                        (decodeTime(index.get(0)) - track.editTimelineShiftSeconds),
                )
            )
                return undefined;
        }
        return result;
    };

    /** Windows around a time, as probeOf places them, parsed by parsedWindow. */
    const windowTracks = async (
        next: ProbeTarget,
        windowSignal = signal,
    ): Promise<DemuxResult | undefined> => {
        const { around, through = around, range, stream } = next;
        if (around === undefined || range || stream) return undefined;
        const span = { start: Math.max(0, start) + around, end: Math.max(0, start) + through! };
        const windows = spanWindows(described, span);
        if (!windows) return undefined;
        for (let reach = 0.25; reach <= 128; reach *= 4) {
            const from =
                fragments.lastAtOrBefore(span.start - reach)?.position ?? layout.firstFragment;
            const to =
                fragments.firstAfter(from, span.end + Math.max(reach, 1))?.position ?? layout.mfra;
            const window = await parsedWindow(movie, from, to, windowSignal);
            if (!window) return undefined;
            const track = window.videoTracks[0] ?? window.audioTracks[0];
            if (track && windows.covers(track, from === layout.firstFragment, to === layout.mfra))
                return window;
        }
        return undefined;
    };

    const probeOf = async (
        next: ProbeTarget,
        windowSignal = signal,
    ): Promise<ProbedInput | undefined> => {
        const { around, through = around, range, stream } = next;
        if (stream) return undefined;
        if (around === undefined && range === undefined)
            return { result: described, packets: false, start, window: probeOf, windowTracks };

        // The fragments from one placed before the span's start to one placed after its end,
        // growing fourfold until the first track holds the span (spanWindows), and for a copy
        // every audio track a packet before the keyframe it starts at.
        const span = range
            ? { start: start + range.start, end: start + (range.end ?? Infinity) }
            : { start: Math.max(0, start) + around!, end: Math.max(0, start) + through! };
        const windows = spanWindows(described, span);
        if (!windows) return undefined;
        const fromStart = range?.fromStart === true;
        for (let reach = range ? 2 : 0.25; reach <= 128; reach *= 4) {
            const from = fromStart
                ? layout.firstFragment
                : (fragments.lastAtOrBefore(span.start - reach)?.position ?? layout.firstFragment);
            const to =
                fragments.firstAfter(from, span.end + Math.max(reach, 1))?.position ?? layout.mfra;
            const window = await run(
                to,
                from === layout.firstFragment ? undefined : from,
                windowSignal,
            );
            const track = window && (window.videoTracks[0] ?? window.audioTracks[0]);
            const starts = from === layout.firstFragment;
            if (
                !track ||
                !windows.covers(track, starts, to === layout.mfra) ||
                (range && !starts && !holdsAudioBefore(window, track, span.start))
            )
                continue;

            // A window describes the input as the head and the tail do.
            const whole = new Map(tracks.map(item => [item.id, item]));
            for (const item of tracksOf(window)) {
                const first = whole.get(item.id);
                if (!first) continue;
                item.duration = first.duration;
                if (first.editMediaTimeSeconds === undefined) delete item.editMediaTimeSeconds;
                else item.editMediaTimeSeconds = first.editMediaTimeSeconds;
            }
            return { result: window, packets: true, start, fromStart: starts, end: to };
        }
        return undefined;
    };
    return probeOf(target);
}
