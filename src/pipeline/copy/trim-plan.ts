import type {
    CueWindow,
    TrimCut,
    TrimOptions,
    TrimPlan,
    TrimRange,
    SampleSearchOptions,
    RemuxTrack,
} from '../media-types';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import { MP4_FAMILY, isIsoOutput } from '../../formats/shared/capabilities';
import { MediaForgeError } from '../../core/errors/errors';
import { getCompactSampleIndex, sampleAt, sampleCount } from '../../core/model/sample-index';
import { decodeTime } from '../../core/model/media-time';
import { lowerBound } from '../read/packet-index';
import { audioHasKeyframes } from '../../core/model/codec-strings';

/**
 * Presentation seconds of the packet-layer timeline; `end` is exclusive and omitted means the
 * input's end.
 */
/** Finds the sample shown at a time: MediaFile.findSample(). */
export type SampleFinder = {
    findSample(trackId: number, time: number, options?: SampleSearchOptions): number | undefined;
    /** Packet-layer seconds where the input starts, which messages count from. */
    readonly timelineStart?: number;
};

/** True when the container writes an edit list, so a copy presents the exact in-point. */
export function keepsExactTrim(format: string): boolean {
    return MP4_FAMILY.has(format);
}

/** Presentation end of the last packet, in packet-layer seconds. */
export function presentationEnd(track: RemuxTrack): number {
    const index = getCompactSampleIndex(track.info);
    if (index) return index.lastPresentationEnd;
    let end = -Infinity;
    for (let position = 0, count = sampleCount(track.info); position < count; position++) {
        const sample = sampleAt(track.info, position)!;
        end = Math.max(end, sample.timestamp + sample.duration);
    }
    return end;
}

/**
 * Cues a subtitle track may hold on screen together, which a trim looks back over for those shown
 * at its start.
 */
const OVERLAPPING_CUES = 32;

/**
 * Where a copy of the selected tracks into `format` starts and ends. Video starts at the keyframe
 * at or before `start`; audio at the packet at or before `start` when the container keeps the exact
 * in-point, otherwise at the packet at or before the earliest video keyframe so both tracks begin
 * together; audio with keyframes (xHE-AAC) starts at the keyframe at or before that point.
 * Subtitle cues are clipped to the window the copy shows (CueWindow): a cue on screen when the copy
 * starts is shown from there, and one still on screen at the end stops there. A track that ends
 * before `start` copies nothing (`ended`); a range none of the tracks reaches fails with INPUT.
 */
export function planTrim(
    file: SampleFinder,
    tracks: readonly RemuxTrack[],
    range: TrimRange,
    format: string,
    options: TrimOptions = {},
): TrimPlan {
    const { audioAfter = false, audioEnd } = options;
    const cuts = new Map<number, TrimCut>();
    const ended = new Map<number, number>();

    // Messages state seconds from the input's start, as the request does.
    const base = file.timelineStart ?? 0;
    const seconds = (time: number | undefined): string =>
        time === undefined ? 'the end' : `${Math.round((time - base) * 1000) / 1000} s`;
    let firstDecode = Infinity;
    let end = -Infinity;
    let audioStart = range.start;
    const cut = (track: RemuxTrack, start: number): void => {
        const id = track.description.id;
        const picture = track.type === 'video';
        const keyframe = picture || keyed(track);
        const trackEnd = presentationEnd(track);
        if (cueWindow) {
            // The earliest of the cues before the window that are still on screen when it opens,
            // else the first cue in it; the copy starts there and clipCue shows the earlier ones
            // from the window start.
            let first = file.findSample(id, start, { mode: 'after' });
            const last = file.findSample(id, start, { mode: 'before' });
            for (let at = last ?? -1; at >= 0 && at > (last ?? 0) - OVERLAPPING_CUES; at--) {
                const cue = sampleAt(track.info, at)!;
                if (cue.timestamp + cue.duration > start) first = at;
            }
            const cue = first === undefined ? undefined : sampleAt(track.info, first)!;
            if (!cue || cue.timestamp >= cueWindow.to) return;
            end = Math.max(end, trackEnd);
            const decodeStart = decodeTime(cue);
            cuts.set(id, { decodeStart, time: Math.max(cue.timestamp, start), cueWindow });
            return;
        }

        const index =
            (audioAfter && !picture
                ? undefined
                : file.findSample(id, start, { keyframe, mode: 'before' })) ??
            file.findSample(id, start, { keyframe, mode: 'after' });
        const sample = index === undefined ? undefined : sampleAt(track.info, index);
        if (!Number.isFinite(trackEnd))
            throw new MediaForgeError(`Track ${id} holds no complete samples to copy`, 'FORMAT');
        // A track that ends before its own start (sound may start at the pictures' keyframe, before
        // the range) copies nothing, as one that starts after the range.
        if (trackEnd <= start) {
            ended.set(id, trackEnd);
            return;
        }
        if (!sample) {
            const unit = keyframe ? 'keyframe' : 'packet';
            throw new MediaForgeError(
                `track ${id} has no ${unit} to start a copy at ${seconds(range.start)} from`,
                'INPUT',
            );
        }

        end = Math.max(end, trackEnd);
        if (range.end !== undefined && sample.timestamp >= range.end) return;
        const decodeStart = decodeTime(sample);
        const decodeEnd = picture ? pictureDecodeEnd(track, decodeStart, range.end) : audioEnd;
        cuts.set(id, {
            decodeStart,
            time: sample.timestamp,
            ...(decodeEnd === undefined ? {} : { decodeEnd }),
            ...(picture && !isIsoOutput(format) ? { shownFrom: sample.timestamp } : {}),
        });
        firstDecode = Math.min(firstDecode, decodeStart);
        if (picture && !keepsExactTrim(format)) audioStart = Math.min(audioStart, sample.timestamp);
    };
    let cueWindow: CueWindow | undefined;
    for (const track of tracks) if (track.type === 'video') cut(track, range.start);
    for (const track of tracks) if (track.type === 'audio') cut(track, audioStart);

    // The copy is shown from its first presented picture or sound, or from the start an edit list
    // presents.
    const shown = [...cuts.values()].map(cut => cut.time);
    const from = keepsExactTrim(format) || !shown.length ? range.start : Math.min(...shown);
    cueWindow = { from, to: range.end ?? Infinity };
    for (const track of tracks) if (track.type === 'subtitle') cut(track, from);
    if (!cuts.size) {
        const [id] = [...ended.keys()];
        throw new MediaForgeError(
            id === undefined
                ? `${seconds(range.start)} to ${seconds(range.end)} selects no packets`
                : `start ${seconds(range.start)} is past the end of track ${id}`,
            'INPUT',
        );
    }
    const stop = range.end === undefined ? end : Math.min(range.end, end);

    // The output's zero. ISO output counts from the first decode time and presents the in-point
    // through its edit list; every other container presents the first copied packet at zero, the
    // decode times of reordered pictures before it written as the container allows (copyLeadIn).
    let origin = Number.isFinite(firstDecode) ? firstDecode : from;
    if (!isIsoOutput(format)) {
        const presented = tracks.filter(
            track => track.type !== 'subtitle' && cuts.has(track.description.id),
        );
        if (presented.length)
            origin = Math.min(...presented.map(track => cuts.get(track.description.id)!.time));
    }
    return {
        start: range.start,
        end: range.end,
        origin,
        cuts,
        ended,
        duration: Math.max(0, stop - range.start),
    };
}

/** True for a track whose copies start at a keyframe: video, and audio with keyframes. */
function keyed(track: RemuxTrack): boolean {
    return track.type === 'video' || audioHasKeyframes(track.info.codec);
}

/**
 * Where a copy of reordered pictures stops in decode order: after the last packet shown before
 * `end`. The packets that decode before `end` but follow it (the keyframe at `end`, a picture after
 * it) are shown only past the range, and no picture shown inside it references them. Undefined when
 * the copy may run up to `end` as it is.
 */
function pictureDecodeEnd(
    track: RemuxTrack,
    decodeStart: number,
    end: number | undefined,
): number | undefined {
    if (end === undefined) return undefined;
    const sampleOf = (position: number) =>
        sampleAt(track.info, track.order?.[position] ?? position)!;
    const past = lowerBound(sampleCount(track.info), end, position =>
        decodeTime(sampleOf(position)),
    );
    let last = past - 1;
    while (last >= 0 && sampleOf(last).timestamp >= end && decodeTime(sampleOf(last)) > decodeStart)
        last--;
    if (last + 1 >= past) return undefined;
    const stop = decodeTime(sampleOf(last + 1));
    // Packets sharing a decode time cannot be told apart by the schedule: the copy then keeps them
    // all.
    return last >= 0 && stop > decodeTime(sampleOf(last)) ? stop : undefined;
}

/**
 * The packets a trim copies from `track`: those from its cut on in decode order that decode before
 * `end`. Their presentation end may lie past `end` when frames are reordered; `decode` is the last
 * decode time written.
 */
export function copiedEnd(
    track: RemuxTrack,
    cut: TrimCut,
    end: number | undefined,
): { readonly presented: number; readonly decode: number } {
    let presented = cut.time;
    let decode = cut.decodeStart;
    for (let position = 0, count = sampleCount(track.info); position < count; position++) {
        const sample = sampleAt(track.info, track.order?.[position] ?? position)!;
        const decodeAt = decodeTime(sample);
        if (decodeAt < cut.decodeStart) continue;
        if (end !== undefined && decodeAt >= end) break;
        presented = Math.max(presented, sample.timestamp + sample.duration);
        decode = Math.max(decode, decodeAt);
    }
    return { presented: Math.min(presented, cut.cueWindow?.to ?? Infinity), decode };
}

/**
 * A cue of a trimmed subtitle track clipped to its window: shown no earlier than the window start
 * and no later than its end. Undefined when none of it is shown; a cue without a duration keeps its
 * start.
 */
export function clipCue<
    T extends {
        readonly timestamp: number;
        readonly decodeTimestamp?: number;
        readonly duration: number;
    },
>(cue: T, window: CueWindow): T | undefined {
    const start = Math.max(cue.timestamp, window.from);
    const end = Math.min(cue.timestamp + cue.duration, window.to);
    if (start === cue.timestamp && end === cue.timestamp + cue.duration) return cue;
    if (!(end > start)) return undefined;
    const decode = cue.decodeTimestamp === undefined ? {} : { decodeTimestamp: start };
    return { ...cue, timestamp: start, duration: end - start, ...decode };
}

/**
 * Reports the tracks a copy leaves out of its range, and the keyframe and packet boundaries it
 * starts at when they differ from the requested start. Strict validation refuses a track that ends
 * before the range.
 */
export function reportTrimCuts(
    plan: TrimPlan,
    tracks: readonly RemuxTrack[],
    format: string,
    diagnostics: DiagnosticContext,
    base = 0,
): void {
    const exact = keepsExactTrim(format);
    const requested = Math.round((plan.start - base) * 1000) / 1000;
    for (const track of tracks) {
        const id = track.description.id;
        const cut = plan.cuts.get(id);
        const ended = plan.ended.get(id);
        if (ended !== undefined && diagnostics.validation === 'strict')
            throw new MediaForgeError(
                `start ${requested} s is past the end of track ${id}`,
                'INPUT',
            );
        if (!cut) {
            diagnostics.warn({
                code: 'TARGET_TRACKS_DROPPED',
                trackId: id,
                format,
                message:
                    ended === undefined
                        ? `${track.type} track ${id} has no packets in the range`
                        : `${track.type} track ${id} ends at ` +
                          `${Math.round((ended - base) * 1000) / 1000} s, before the range`,
            });
            continue;
        }

        // Subtitle cues are shown with the pictures and sound they accompany.
        if (Math.abs(cut.time - plan.start) < 1e-6 || track.type === 'subtitle') continue;
        const where = keyed(track) ? 'the keyframe' : 'the packet';
        const at = (cut.time - base).toFixed(3);
        diagnostics.warn({
            code: 'TRIM_SNAPPED',
            trackId: track.description.id,
            format,
            message: exact
                ? `${track.type} copy starts at ${where} at ${at} s; playback at ${requested} s`
                : `${track.type} copy and playback start at ${where} at ${at} s, ` +
                  `not ${requested} s`,
        });
    }
}
