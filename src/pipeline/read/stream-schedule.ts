/**
 * Decode time a read moves past a track's last packet before that track is taken to have ended or
 * to pause.
 */
const QUIET_SECONDS = 10;

/** Bytes of packets a schedule holds back before it hands on the earliest without waiting. */
const MAX_HELD_BYTES = 64 * 1024 * 1024;

/**
 * Puts the packets of a one-pass read, which come in file order, in the order PacketSchedule merges
 * an index in: by decode time, ties to the earlier track, each track's packets in the order read.
 * The earliest packet waits while a track with none queued may still send an earlier one: until
 * that track's latest decode time reaches it, the read is QUIET_SECONDS of decode time past that
 * track's latest (it ended or pauses), MAX_HELD_BYTES are held, or the read ends. A file
 * interleaves its tracks closely, so the wait holds a few packets. Interleaver orders producers it
 * can hold back instead, so it waits on them rather than bounding the wait.
 */
export class StreamSchedule<T> {
    private readonly queues: (T | undefined)[][];
    private readonly heads: number[];
    /** Decode time of each track's latest packet; before its first, that of its first sample. */
    private readonly latest: number[];
    private frontier = Number.NEGATIVE_INFINITY;
    private bytes = 0;

    /** `first` holds each track's first decode time where known, and -Infinity where not. */
    constructor(
        first: readonly number[],
        private readonly timeOf: (item: T) => number,
        private readonly sizeOf: (item: T) => number,
    ) {
        this.queues = first.map(() => []);
        this.heads = first.map(() => 0);
        this.latest = first.slice();
    }

    /** Takes the next packet read of track `track` (its position among the scheduled tracks). */
    push(track: number, item: T): void {
        const time = this.timeOf(item);
        this.queues[track]!.push(item);
        this.latest[track] = time;
        if (time > this.frontier) this.frontier = time;
        this.bytes += this.sizeOf(item);
    }

    /**
     * The next packet in order once no track can send an earlier one; `ended` once the read is
     * over.
     */
    next(ended: boolean): T | undefined {
        let best = -1;
        let bestTime = Number.POSITIVE_INFINITY;
        for (let track = 0; track < this.queues.length; track++) {
            const queue = this.queues[track]!;
            const head = this.heads[track]!;
            if (head === queue.length) continue;
            const time = this.timeOf(queue[head]!);
            if (best < 0 || time < bestTime) {
                best = track;
                bestTime = time;
            }
        }

        if (best < 0) return undefined;
        if (!ended && this.bytes <= MAX_HELD_BYTES)
            for (let track = 0; track < this.queues.length; track++) {
                if (track === best || this.heads[track]! < this.queues[track]!.length) continue;
                const latest = this.latest[track]!;
                if (
                    (latest < bestTime || (latest === bestTime && track < best)) &&
                    this.frontier - latest <= QUIET_SECONDS
                )
                    return undefined;
            }

        const queue = this.queues[best]!;
        const head = this.heads[best]!;
        const item = queue[head]!;
        queue[head] = undefined;
        if (head + 1 === queue.length) {
            queue.length = 0;
            this.heads[best] = 0;
        } else this.heads[best] = head + 1;
        this.bytes -= this.sizeOf(item);
        return item;
    }

    /** Calls `visit` with each packet held back. */
    forEachHeld(visit: (item: T) => void): void {
        this.queues.forEach((queue, track) => {
            for (let index = this.heads[track]!; index < queue.length; index++)
                visit(queue[index]!);
        });
    }
}
