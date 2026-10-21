import { awaitWithAbort } from '../../core/io/abort';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { decodeTime } from '../../core/model/media-time';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import type { Sink } from '../../core/model/types';
import type { Interleaver } from '../copy/interleave';
import type { FilePacket, PacketRoute, RemuxTrack, SharedTrackRead } from '../media-types';
import { mediaFileState } from '../read/file-state';
import type { MediaFile } from '../read/media-file';
import { lowerBound } from '../read/packet-index';
import type { TrackPacketRead } from './pcm-source';

/** Packets a reader has read ahead of what its lane asked, after which the read waits for it. */
const READ_AHEAD = 16;
/**
 * Packets or bytes a reader that falls behind holds at most: the read goes on for the other lanes
 * without it, and reads its packets again once it catches up.
 */
const HELD_PACKETS = 1024;
const HELD_BYTES = 32 * 1024 * 1024;

const packetBytes = (packet: FilePacket): number =>
    packet.data.length + (packet.alphaData?.length ?? 0);

/**
 * The packets of one track a lane takes from its clip's read, by position in an order of the
 * track's samples (decode order, or the samples' own) before `stop`. The read hands it the
 * position after the packets it holds; a lane that asks for an earlier position, or for one
 * further ahead than the read reads ahead, starts the reader there again. Declared before the
 * lanes start, it holds copies back until its lane first asks.
 */
export class TrackReader implements SharedTrackRead {
    private readonly queue: (FilePacket | undefined)[] = [];
    private head = 0;
    private bytes = 0;
    /** The position of the packet at the head of the queue, or of the next one read. */
    private first = 0;
    /** Whether the read hands the reader packets: from its lane's first ask until it closes. */
    private open = false;
    /** Declared, its lane has not asked yet. */
    private declared = true;
    private waiter: (() => void) | undefined;
    private waiting = false;
    readonly trackId: number;
    stop: number;

    constructor(
        private readonly read: ClipRead,
        track: RemuxTrack,
        private readonly order: RemuxTrack['order'],
    ) {
        this.trackId = track.description.id;
        this.stop = sampleCount(track.info);
    }

    private get held(): number {
        return this.queue.length - this.head;
    }

    /** The sample the read hands over next; undefined while the reader takes none. */
    next(): number | undefined {
        const position = this.first + this.held;
        if (
            !this.open ||
            position >= this.stop ||
            this.held >= HELD_PACKETS ||
            this.bytes >= HELD_BYTES
        )
            return undefined;
        return this.order?.[position] ?? position;
    }

    /** Whether the read should go on for this reader. */
    get hungry(): boolean {
        return (this.waiting || this.held < READ_AHEAD) && this.next() !== undefined;
    }

    /** Whether the reader takes packets, now, once it catches up or once its lane asks. */
    get taking(): boolean {
        return this.declared || (this.open && this.first + this.held < this.stop);
    }

    /**
     * The packet of next(), borrowed, kept as a copy unless the reader started elsewhere. A view
     * would have to last until the lane's decoder lets go of the packet, which is after the lane
     * asks again (the WebCodecs video decoder keeps each packet until its picture is out, to submit
     * it again after a reset), while the pass refills its 1 MiB spans of a file or bytes input once
     * it is three spans further on and their holds are released.
     */
    take(packet: FilePacket): void {
        if (packet.sampleIndex !== this.next()) return;
        const { data, alphaData } = packet;
        this.queue.push({
            ...packet,
            data: data.slice(),
            ...(alphaData && { alphaData: alphaData.slice() }),
        });
        this.bytes += packetBytes(packet);
        this.wake();
    }

    /** The packet at `position`; undefined at or past the reader's stop. */
    async at(position: number, signal?: AbortSignal): Promise<FilePacket | undefined> {
        for (;;) {
            this.read.check();
            while (this.held && this.first < position) this.drop();
            if (this.held && this.first === position) {
                const packet = this.queue[this.head]!;
                this.drop();
                return packet;
            }
            if (position >= this.stop) return undefined;
            if (!this.open || position < this.first || position > this.first + READ_AHEAD) {
                this.close();
                this.first = position;
                this.open = true;
            }
            this.waiting = true;
            this.read.start();
            this.read.changed();
            try {
                await awaitWithAbort(new Promise<void>(resolve => (this.waiter = resolve)), signal);
            } finally {
                this.waiting = false;
            }
        }
    }

    /** The lane is done with the track for now: the read hands it nothing more. */
    close(): void {
        this.open = this.declared = false;
        this.queue.length = this.head = this.bytes = 0;
        this.read.changed();
    }

    private drop(): void {
        this.bytes -= packetBytes(this.queue[this.head]!);
        this.queue[this.head++] = undefined;
        this.first++;
        if (this.head === this.queue.length) this.queue.length = this.head = 0;
        this.read.changed();
    }

    wake(): void {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }
}

/** A copy routed by a clip's read, into a lane of the interleaver when it has one. */
interface ClipRoute extends PacketRoute {
    readonly lane?: number;
    routed: boolean;
    readonly settle: (error?: unknown) => void;
}

/**
 * How a conversion reads a clip's input: every lane that reads the clip, the copies it routes and
 * the tracks it decodes, takes its packets from one pass in decode order (MediaFileState.share),
 * so the input is read once however many lanes read it; a lane alone is the pass of one. The pass
 * goes on while a reader wants packets, the merge waits for a copy's lane, or no reader takes
 * packets, and otherwise waits for them.
 */
export class ClipRead {
    private routes: ClipRoute[] = [];
    private readonly reads: TrackReader[] = [];
    private readonly readers = new Map<number, TrackReader>();
    private readonly controller = new AbortController();
    private reading = false;
    private failure: unknown;
    private waiter: (() => void) | undefined;
    /** Whether the pass waits for the merge of the lanes to change. */
    private watching = false;

    constructor(
        private readonly file: MediaFile,
        private readonly sink?: Sink,
        private readonly interleaver?: Interleaver,
    ) {}

    /**
     * Routes a copy of the clip's tracks, into `lane` of the interleaver when given; resolves once
     * its last packet is routed.
     */
    route(route: PacketRoute, lane?: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.routes.push({
                ...route,
                lane,
                routed: false,
                settle(error) {
                    this.routed = true;
                    if (error === undefined) resolve();
                    else reject(error);
                },
            });
            this.start();
            this.changed();
        });
    }

    /**
     * Declares the reader of `track`, in decode order for packets() or by sample index for
     * reader(), before the lanes start: a copy waits for it rather than reading ahead alone.
     */
    expect(track: RemuxTrack, decodeOrder: boolean): TrackReader {
        const id = track.description.id;
        let reader = this.readers.get(id);
        if (!reader) {
            reader = new TrackReader(this, track, decodeOrder ? track.order : undefined);
            this.readers.set(id, reader);
            this.reads.push(reader);
        }
        return reader;
    }

    /**
     * The packets of `track` a lane decodes: in decode order from the first whose decode time is
     * at or after `start` to before `end`, as packets() of the file yields them.
     */
    async *packets(
        track: RemuxTrack,
        start: number,
        end: number,
        signal: AbortSignal,
    ): AsyncGenerator<FilePacket> {
        const { info, order } = track;
        const count = sampleCount(info);
        const timeAt = (position: number): number =>
            decodeTime(sampleAt(info, order?.[position] ?? position)!);
        const reader = this.expect(track, true);
        reader.stop = lowerBound(count, end, timeAt);
        try {
            for (let position = lowerBound(count, start, timeAt); ; position++) {
                const packet = await reader.at(position, signal);
                if (!packet) return;
                yield packet;
            }
        } finally {
            reader.close();
        }
    }

    /** Reads packets of `track` by sample index, as readPacket() of the file does. */
    reader(track: RemuxTrack): TrackPacketRead {
        const reader = this.expect(track, false);
        return async (index, signal) => {
            const packet = await reader.at(index, signal);
            if (!packet) throw new MediaForgeError('Sample index is out of range', 'INPUT');
            return packet;
        };
    }

    /** The lane that decoded `track` is done: its reader takes nothing more. */
    done(track: RemuxTrack): void {
        this.readers.get(track.description.id)?.close();
    }

    /** Starts the pass once a lane first asks for packets. */
    start(): void {
        if (this.reading || this.controller.signal.aborted) return;
        if (this.failure !== undefined) return this.end(this.failure);
        this.reading = true;
        mediaFileState(this.file)
            .share({
                // A pass ends only once nothing is left to read: one started again routes no copy
                // twice.
                routes: (this.routes = this.routes.filter(route => !route.routed)),
                reads: this.reads,
                signal: this.controller.signal,
                sink: this.sink,
                ready: () => this.ready(),
                routed: route => (route as ClipRoute).settle(),
            })
            .then(
                () => this.end(),
                error => this.end(error),
            );
    }

    /** Tells the pass a lane asked for packets, took some, joined or left. */
    changed(): void {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }

    /** Throws the pass's failure, or that it was closed, to a lane that reads from it. */
    check(): void {
        if (this.failure !== undefined) throw this.failure;
        throwIfAborted(this.controller.signal);
    }

    /** Ends the pass: what no lane took is not read. */
    close(): void {
        this.controller.abort();
        this.changed();
        for (const reader of this.reads) reader.wake();
    }

    /** Whether the pass goes on now, or what it waits for. */
    private ready(): Promise<void> | undefined {
        let taking = false;
        for (const reader of this.reads) {
            if (reader.hungry) return undefined;
            taking ||= reader.taking;
        }
        // A copy is routed as fast as the sink takes it unless a reader sets the pace; the merge
        // of the lanes may wait for its packets, which come only from this pass.
        for (const route of this.routes)
            if (
                !route.routed &&
                (!taking || (route.lane !== undefined && this.interleaver!.starved(route.lane)))
            )
                return undefined;
        if (this.interleaver && !this.watching) {
            this.watching = true;
            void this.interleaver.changed().then(() => {
                this.watching = false;
                this.changed();
            });
        }
        return new Promise<void>(resolve => (this.waiter = resolve));
    }

    private end(error?: unknown): void {
        this.reading = false;
        // Closed by the conversion, which needs nothing more of it, the pass did not fail.
        const closed = this.controller.signal.aborted;
        if (!closed) this.failure = error;
        if (closed || error !== undefined)
            for (const route of this.routes)
                if (!route.routed) route.settle(closed ? undefined : error);
        for (const reader of this.reads) reader.wake();
    }
}
