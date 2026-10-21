import type { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import type { EncodedPacket } from '../../core/model/media';
import { decodeTime } from '../../core/model/media-time';
import { holdBytes, releaseBytes } from '../../core/bytes/byte-holds';

/** Packets queued per lane before the slower lanes catch up. */
const LANE_LIMIT = 256;

/**
 * Orders the chunks of several producers by decode time before they reach the muxer. Each producer
 * pushes without waiting and calls `drain` in its loop, which waits while its lane runs far ahead
 * of a lane that holds nothing yet. StreamSchedule orders a file's packets as they are read
 * instead: it cannot hold back a reader, so it bounds its wait by decode time and held bytes.
 */
export class Interleaver {
    private readonly lanes: { queue: EncodedPacket[]; head: number; done: boolean }[];
    private waiters: (() => void)[] = [];
    /**
     * Queued packets holding the bytes a reader lent them (a borrowed copy's views of pooled
     * reads, rewritten once the reader moves on): whether the data (1) and the alpha bytes (2)
     * have a hold, kept until the muxer has the packet.
     */
    private readonly held = new Map<EncodedPacket, number>();

    constructor(
        count: number,
        private readonly deliver: (lane: number, chunk: EncodedPacket) => void,
        private readonly lifetime: CodecLifetime,
    ) {
        this.lanes = Array.from({ length: count }, () => ({ queue: [], head: 0, done: false }));
    }

    private size(lane: number): number {
        const entry = this.lanes[lane]!;
        return entry.queue.length - entry.head;
    }

    /** Delivers the earliest head while every lane still producing holds one. */
    private flush(): void {
        for (;;) {
            let earliest = -1;
            let time = Infinity;
            let blocked = false;
            for (let lane = 0; lane < this.lanes.length; lane++) {
                const entry = this.lanes[lane]!;
                if (entry.head === entry.queue.length) {
                    if (!entry.done) blocked = true;
                    continue;
                }
                const at = decodeTime(entry.queue[entry.head]!);
                if (at < time) {
                    time = at;
                    earliest = lane;
                }
            }

            if (blocked || earliest < 0) break;
            const entry = this.lanes[earliest]!;
            const chunk = entry.queue[entry.head]!;
            entry.queue[entry.head++] = undefined!;
            if (entry.head === entry.queue.length) entry.queue.length = entry.head = 0;
            try {
                this.deliver(earliest, chunk);
            } finally {
                this.release(chunk);
            }
        }

        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
    }

    push(lane: number, chunk: EncodedPacket): void {
        const alpha = chunk.alphaData !== undefined && holdBytes(chunk.alphaData);
        const held = (holdBytes(chunk.data) ? 1 : 0) | (alpha ? 2 : 0);
        if (held) this.held.set(chunk, held);
        this.lanes[lane]!.queue.push(chunk);
        this.flush();
    }

    private release(chunk: EncodedPacket): void {
        const held = this.held.get(chunk);
        if (held === undefined) return;
        this.held.delete(chunk);
        if (held & 1) releaseBytes(chunk.data);
        if (held & 2) releaseBytes(chunk.alphaData!);
    }

    /**
     * Waits while this lane holds more than the limit and another lane, still producing, holds
     * nothing.
     */
    async drain(lane: number): Promise<void> {
        while (
            this.size(lane) > LANE_LIMIT &&
            this.lanes.some(
                (entry, index) => index !== lane && !entry.done && this.size(index) === 0,
            )
        ) {
            await this.lifetime.waitFor(new Promise<void>(resolve => this.waiters.push(resolve)));
        }
    }

    end(lane: number): void {
        this.lanes[lane]!.done = true;
        this.flush();
    }

    /**
     * Whether the merge waits for `lane`: it still produces, holds nothing and another lane holds
     * packets it cannot deliver before this one's next.
     */
    starved(lane: number): boolean {
        const entry = this.lanes[lane]!;
        return (
            !entry.done &&
            this.size(lane) === 0 &&
            this.lanes.some((_, index) => index !== lane && this.size(index) > 0)
        );
    }

    /** Resolves once the merge next delivers or a lane next ends. */
    changed(): Promise<void> {
        return new Promise(resolve => this.waiters.push(resolve));
    }
}
