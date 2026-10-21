import { sampleAt, sampleCount } from '../../../core/model/sample-index';
import type { TrackInfo } from '../../../core/model/track';

/**
 * Pictures read ahead of the one being timed: no picture is shown more than this many pictures from
 * its place.
 */
const REORDER_LOOKAHEAD = 32;

/** Positions at the head of a track whose leads decide how far its decode times lag. */
const REORDER_HEAD = 128;

/** The shortest duration a timed picture gets. */
const MINIMUM_DURATION = 1 / 1e6;

/** The duration of a sample stored without one when nothing near it tells one. */
const FALLBACK_DURATION = 1 / 1000;

/** The first pictures of a track that decide how it is timed (all of a shorter track). */
export const REORDER_DECIDING = REORDER_HEAD + REORDER_LOOKAHEAD + 1;

/**
 * How a track is timed: kept as stored, or reordered with decode times `shift` seconds before the
 * presentation times in rising order.
 */
export interface ReorderTiming {
    readonly reordered: boolean;
    readonly shift: number;
}

/**
 * The timing of a track decided by its first REORDER_DECIDING pictures in decode order (all of a
 * shorter track), which present at `times`.
 */
export function reorderTiming(times: readonly number[]): ReorderTiming {
    const reordered = times.some((time, index) => index > 0 && time < times[index - 1]!);
    let shift = 0;
    if (reordered) {
        const sorted = [...times].sort((a, b) => a - b);
        // Sorted times past the head's look-ahead may still give way to later pictures; a whole
        // track's are final.
        const final = times.length >= REORDER_DECIDING ? REORDER_HEAD : times.length;
        for (let index = 0; index < final; index++)
            shift = Math.max(shift, sorted[index]! - times[index]!);
    }
    return { reordered, shift };
}

/**
 * Adds to `pictures` the presentation times of the first pictures of each of `tracks` that decide
 * how it is timed, after those of the reads before; returns the fewest a track then has.
 */
export function addPictures(pictures: Map<number, number[]>, tracks: readonly TrackInfo[]): number {
    for (const track of tracks) {
        const times = pictures.get(track.id!) ?? [];
        pictures.set(track.id!, times);
        const count = Math.min(sampleCount(track), REORDER_DECIDING - times.length);
        for (let index = 0; index < count; index++) times.push(sampleAt(track, index)!.timestamp);
    }
    return Math.min(...[...pictures.values()].map(times => times.length));
}

/**
 * Decode times of Matroska video, which stores presentation times only. Pictures are taken in
 * storage (decode) order; the first REORDER_HEAD + REORDER_LOOKAHEAD + 1 (or the whole track, when
 * shorter) decide the timing. If their presentation times all rise, the track keeps them as decode
 * times. Otherwise the track is reordered: a picture's decode time is the smallest presentation
 * time of the pictures from it to REORDER_LOOKAHEAD after it that is not yet another picture's (the
 * presentation times in rising order), moved back by the largest lead among the first REORDER_HEAD
 * positions (how much the sorted time at a position leads the picture there) and never after its
 * own presentation time; its duration runs to the next picture's decode time, and the last keeps
 * its own. A track whose largest lead lies in its head, as every reordered stream of the test
 * corpus, is timed as by the largest lead of the whole track, which is what ffprobe infers.
 *
 * The rule needs nothing beyond the look-ahead, so a read of the whole file and a pass a window at
 * a time give the same times: `assign` receives a picture's decode time and duration (undefined for
 * the last) as it is timed, and `ready` takes the pictures in order once timed. A clock given the
 * `timing` of the whole track times a window of it as the whole track's read does.
 */
export class ReorderClock<T> {
    /** The first pictures, until they decide how the track is timed. */
    private head: T[] | undefined;
    private timing: ReorderTiming | undefined;
    /** Presentation times of the pictures taken and not yet timed, rising. */
    private readonly times: number[] = [];
    private readonly waiting: T[] = [];
    /** The latest timed picture, whose duration waits for the next decode time. */
    private last: { readonly item: T; readonly decode: number } | undefined;

    constructor(
        private readonly timeOf: (item: T) => number,
        private readonly assign: (item: T, decode: number, duration: number | undefined) => void,
        private readonly ready: (item: T) => void,
        timing?: ReorderTiming,
    ) {
        this.timing = timing;
        if (!timing) this.head = [];
    }

    /** Takes the next picture in decode order. */
    push(item: T): void {
        if (this.head) {
            this.head.push(item);
            if (this.head.length >= REORDER_DECIDING) this.decide();
            return;
        }
        if (!this.timing!.reordered) return this.ready(item);
        this.take(item);
        while (this.waiting.length > REORDER_LOOKAHEAD) this.timeNext();
    }

    /** Times the pictures still held, at the end of the track. */
    flush(): void {
        if (this.head) this.decide();
        while (this.waiting.length > 0) this.timeNext();
        if (this.last) {
            this.assign(this.last.item, this.last.decode, undefined);
            this.ready(this.last.item);
            this.last = undefined;
        }
    }

    /** The pictures taken and not yet ready. */
    held(): T[] {
        return [...(this.head ?? []), ...(this.last ? [this.last.item] : []), ...this.waiting];
    }

    private decide(): void {
        const head = this.head!;
        this.head = undefined;
        this.timing = reorderTiming(head.map(this.timeOf));
        if (!this.timing.reordered) {
            for (const item of head) this.ready(item);
            return;
        }
        for (const item of head) this.take(item);
        while (this.waiting.length > REORDER_LOOKAHEAD) this.timeNext();
    }

    private take(item: T): void {
        const time = this.timeOf(item);
        let at = this.times.length;
        while (at > 0 && this.times[at - 1]! > time) at--;
        this.times.splice(at, 0, time);
        this.waiting.push(item);
    }

    private timeNext(): void {
        const item = this.waiting.shift()!;
        const decode = Math.min(this.times.shift()! - this.timing!.shift, this.timeOf(item));
        if (this.last) {
            this.assign(
                this.last.item,
                this.last.decode,
                Math.max(MINIMUM_DURATION, decode - this.last.decode),
            );
            this.ready(this.last.item);
        }
        this.last = { item, decode };
    }
}

/**
 * Durations of the samples of a Matroska track stored without one, as a read of the whole track
 * fills them. A run of such samples at one timestamp shares the gap to the next timestamp of the
 * track (each then shown that much after the one before), else takes the duration of the sample
 * before it, else that of the sample after it, else FALLBACK_DURATION. Samples are taken in storage
 * order, so a read of the whole track and a pass a window at a time give the same durations:
 * `assign` sets a filled sample's timestamp and duration, and `ready` takes the samples in order
 * once their durations are final.
 */
export class DurationFiller<T> {
    /** The samples without a duration at one timestamp, waiting for the next timestamp. */
    private run: T[] = [];
    /** The duration of the sample before the run. */
    private previous = 0;

    constructor(
        private readonly timeOf: (item: T) => number,
        private readonly durationOf: (item: T) => number,
        private readonly assign: (item: T, timestamp: number, duration: number) => void,
        private readonly ready: (item: T) => void,
    ) {}

    /** Takes the next sample in storage order. */
    push(item: T): void {
        const duration = this.durationOf(item);
        const time = this.timeOf(item);
        if (this.run.length) {
            if (duration <= 0 && time === this.timeOf(this.run[0]!)) {
                this.run.push(item);
                return;
            }
            this.fill(time, duration);
        }
        if (duration > 0) {
            this.previous = duration;
            this.ready(item);
        } else this.run.push(item);
    }

    /** Fills the samples still held, at the end of the track. */
    flush(): void {
        if (this.run.length) this.fill(Number.NaN, 0);
    }

    /** The samples taken and not yet ready. */
    held(): T[] {
        return this.run;
    }

    private fill(next: number, following: number): void {
        const run = this.run;
        this.run = [];
        const start = this.timeOf(run[0]!);
        let duration = next > start ? (next - start) / run.length : 0;
        if (!(duration > 0))
            duration =
                this.previous > 0 ? this.previous : following > 0 ? following : FALLBACK_DURATION;
        for (const [position, item] of run.entries())
            this.assign(item, start + position * duration, duration);
        this.previous = duration;
        for (const item of run) this.ready(item);
    }
}
