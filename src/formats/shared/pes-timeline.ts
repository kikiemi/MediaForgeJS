import { DiagnosticContext } from '../../core/errors/diagnostics';
import type { Sample, TrackInfo } from '../../core/model/track';
import { PesSampleIndex, VIDEO_SAMPLE_BYTES } from './pes-sample-index';
import { bindCompactSampleIndex } from '../../core/model/sample-index';
import type { DemuxIndexBudget } from './demux-budget';
import { decodeTime } from '../../core/model/media-time';

/** A stream's segment on the program timeline and its last unwrapped decode time. */
export interface StreamClock {
    segment: number;
    lastRaw: number | null;
}

export const SPLICE_BACKWARD_TICKS = 90000;
const SPLICE_FORWARD_TICKS = 10 * 90000;

/**
 * Segments of the program timeline. A stream whose decode time jumps back by more than a second or
 * ahead by more than ten enters the next segment; streams interleaved across a splice enter it on
 * their own jump.
 */
export class ProgramTimeline {
    segments = 1;

    constructor(private readonly diagnostics: DiagnosticContext) {}

    segment(clock: StreamClock, raw: number): number {
        if (
            clock.lastRaw !== null &&
            (raw < clock.lastRaw - SPLICE_BACKWARD_TICKS ||
                raw > clock.lastRaw + SPLICE_FORWARD_TICKS)
        ) {
            clock.segment++;
            if (clock.segment === this.segments) {
                this.segments++;
                this.diagnostics.warn({
                    code: 'TS_TIMELINE_SPLICE',
                    format: 'ts',
                    message:
                        `Timestamps jump at ${(clock.lastRaw / 90000).toFixed(3)} s; the ` +
                        `timeline continues`,
                });
            }
        }
        clock.lastRaw = raw;
        return clock.segment;
    }
}

/** Sample indices where a track enters a timeline segment, in ascending order. */
export type SegmentRuns = { start: number; segment: number }[];

export function markSegment(runs: SegmentRuns, start: number, segment: number): void {
    if (runs.length === 0 || runs[runs.length - 1]!.segment !== segment)
        runs.push({ start, segment });
}

/** The PID each track of a result was read from. */
export const trackPids = new WeakMap<TrackInfo, number>();

/** Sample tables of the tracks being indexed; the other tracks keep sample arrays. */
export const tables = new WeakMap<TrackInfo, PesSampleIndex>();

export function countOf(track: TrackInfo): number {
    return tables.get(track)?.length ?? track.samples.length;
}

export function endOf(track: TrackInfo): number {
    return tables.get(track)?.end() ?? presentationEnd(track.samples);
}

/** Visits each sample's presentation time, decode time and duration; `shift` moves its times. */
function forEachRun(
    track: TrackInfo,
    runs: SegmentRuns,
    visit: (
        time: number,
        decode: number,
        duration: number,
        segment: number,
        shift: (offset: number) => void,
    ) => void,
): void {
    const table = tables.get(track);
    runs.forEach((run, index) => {
        const end = index + 1 < runs.length ? runs[index + 1]!.start : countOf(track);
        for (let i = run.start; i < end; i++) {
            if (table) {
                visit(
                    table.timestampAt(i),
                    table.decodeTimeAt(i),
                    table.durationAt(i),
                    run.segment,
                    offset => table.shift(i, offset),
                );
                continue;
            }
            const sample = track.samples[i]!;
            visit(sample.timestamp, decodeTime(sample), sample.duration, run.segment, offset => {
                sample.timestamp += offset;
                if (sample.decodeTimestamp !== undefined) sample.decodeTimestamp += offset;
            });
        }
    });
}

/**
 * Places each timeline segment right after the latest end of any track in the segment before it, so
 * packets keep file order across splices and every track keeps its offset to the others within a
 * segment.
 */
export function joinSegments(
    tracks: readonly TrackInfo[],
    runs: Map<TrackInfo, SegmentRuns>,
    count: number,
): void {
    const first = new Array<number>(count).fill(Infinity);
    const last = new Array<number>(count).fill(-Infinity);
    for (const track of tracks)
        forEachRun(track, runs.get(track) ?? [], (time, dts, duration, segment) => {
            first[segment] = Math.min(first[segment]!, dts, time);
            last[segment] = Math.max(last[segment]!, time + duration, dts + duration);
        });
    const offsets = new Array<number>(count).fill(0);
    let end = last[0]!;
    for (let segment = 1; segment < count; segment++) {
        if (!Number.isFinite(first[segment]!)) continue;
        offsets[segment] = end - first[segment]!;
        end = last[segment]! + offsets[segment]!;
    }
    for (const track of tracks)
        forEachRun(track, runs.get(track) ?? [], (_time, _dts, _duration, segment, shift) => {
            if (offsets[segment]) shift(offsets[segment]!);
        });
}

/**
 * End of the latest presented sample; with reordered video the last picture in decode order need
 * not end last.
 */
export function presentationEnd(samples: readonly Sample[]): number {
    let end = 0;
    for (const sample of samples) end = Math.max(end, sample.timestamp + sample.duration);
    return end;
}

/**
 * Hands a track's sample table to the engine's compact index when its samples are `packetized`
 * (they leave their bytes in the input), or turns it into the sample array the object form returns.
 * Sample objects, when they are made, are charged to the budget at 256 bytes each, less the bytes
 * the table charged for them.
 */
export function settleTrack(track: TrackInfo, budget: DemuxIndexBudget, packetized: boolean): void {
    const table = tables.get(track);
    if (!table) return;
    tables.delete(track);
    table.finish();
    const objects = (): void =>
        budget.reserveBytes(
            table.length * (256 - (table.video ? VIDEO_SAMPLE_BYTES : PesSampleIndex.AUDIO_BYTES)),
            'TS sample objects',
        );
    if (packetized) return bindCompactSampleIndex(track, table, objects);
    objects();
    track.samples = Array.from({ length: table.length }, (_, index) => table.get(index));
}
