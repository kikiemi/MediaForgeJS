import type { Source } from '../../core/model/types';
import { cachedBorrower } from '../../core/io/sources/cached-source';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import type { Sample } from '../../core/model/track';
import { awaitWithAbort } from '../../core/io/abort';
import { type PacketizedSampleReader } from '../../core/model/sample-index';
import { TS_PACKET } from './stream-types';
import { packetBytes } from '../../core/bytes/shared-bytes';

/**
 * Where a read of one PES stopped: the transport packet it ended in and the reader state before
 * that packet.
 */
interface TsReadPoint {
    readonly pes: number;
    readonly packet: number;
    /** Elementary-stream bytes of the PES before the packet's payload. */
    readonly before: number;
    readonly lastCc: number;
    readonly headerSeen: number;
    readonly headerLength: number;
}

/** A read of one sample: the bytes it gathers into and where it is in the input and the PES. */
interface Gathering {
    readonly out: Uint8Array;
    readonly wanted: number;
    /** Where the next window starts, and its length before the end of the input. */
    pos: number;
    span: number;
    skip: number;
    filled: number;
    lastCc: number;
    first: boolean;
    headerSeen: number;
    headerLength: number;
    stopPacket: number;
    stopBefore: number;
    stopCc: number;
    stopSeen: number;
    stopLength: number;
}

/**
 * Reads packetized samples back from the transport packets of one PID: from the PES that starts at
 * the sample's offset, it skips `packetSkip` elementary-stream bytes and gathers `packetBytes` (or
 * `size`) more, passing over PES headers, repeated packets and other PIDs as the demuxer did. A
 * later sample of the PES the previous read stopped in resumes at the packet it stopped in, so
 * reading the frames of a long audio PES in order stays linear.
 */
export class TsSampleReader implements PacketizedSampleReader {
    readonly scansReads = true;
    private resume: TsReadPoint | undefined;

    constructor(
        private readonly pid: number,
        private readonly stride: number,
        private readonly payOff: number,
        private readonly convert?: (bytes: Uint8Array) => Uint8Array,
    ) {}

    readLent(source: Source, sample: Sample): Uint8Array | undefined {
        const borrow = cachedBorrower(source);
        if (!borrow) return undefined;
        const state = this.start(sample);
        while (state.filled < state.out.length) {
            const window = borrow(state.pos, this.windowBytes(source, state));
            if (!window) return undefined;
            this.gather(state, window);
        }
        return this.finish(state, sample);
    }

    async read(source: Source, sample: Sample, signal?: AbortSignal): Promise<Uint8Array> {
        const borrow = cachedBorrower(source);
        const state = this.start(sample);
        while (state.filled < state.out.length) {
            const windowBytes = this.windowBytes(source, state);

            // The window is only scanned here, so a view of a cached page serves as well as a copy.
            const window =
                borrow?.(state.pos, windowBytes) ??
                (await awaitWithAbort(source.read(state.pos, windowBytes), signal));
            throwIfAborted(signal);
            this.gather(state, window);
        }
        return this.finish(state, sample);
    }

    /** A read of `sample` from its PES, or from where the previous read stopped in it. */
    private start(sample: Sample): Gathering {
        const length = sample.packetBytes ?? sample.size;
        const wanted = sample.packetSkip ?? 0;
        const state: Gathering = {
            out: packetBytes(length),
            wanted,
            pos: sample.offset,
            span: 0,
            skip: wanted,
            filled: 0,
            lastCc: -1,
            first: true,
            headerSeen: 0,
            headerLength: 0,
            stopPacket: -1,
            stopBefore: 0,
            stopCc: -1,
            stopSeen: 0,
            stopLength: 0,
        };
        const resume = this.resume;
        if (resume && resume.pes === sample.offset && resume.before <= wanted) {
            state.pos = resume.packet;
            state.skip -= resume.before;
            state.lastCc = resume.lastCc;
            state.headerSeen = resume.headerSeen;
            state.headerLength = resume.headerLength;
            state.first = false;
        }
        state.span = (Math.ceil((state.skip + length) / 150) + 8) * this.stride;
        return state;
    }

    /** The length of the next window, whole transport packets up to the end of the input. */
    private windowBytes(source: Source, state: Gathering): number {
        const { stride } = this;
        const available = Math.floor((source.size - state.pos) / stride) * stride;
        if (available < stride)
            throw new DemuxError('MPEG-TS sample extends past the end of the input');
        return Math.min(available, state.span);
    }

    /** Remembers where the read stopped and returns the sample's bytes. */
    private finish(state: Gathering, sample: Sample): Uint8Array {
        if (state.stopPacket >= 0)
            this.resume = {
                pes: sample.offset,
                packet: state.stopPacket,
                before: state.stopBefore,
                lastCc: state.stopCc,
                headerSeen: state.stopSeen,
                headerLength: state.stopLength,
            };
        const bytes = this.convert ? this.convert(state.out) : state.out;
        if (bytes.length !== sample.size)
            throw new DemuxError('MPEG-TS sample no longer matches its index');
        return bytes;
    }

    /**
     * Gathers the sample's bytes from the transport packets of `window`, which starts at the read's
     * position, and moves the read past them. It runs outside the async read(), whose loops V8
     * optimizes less while they run.
     */
    private gather(state: Gathering, window: Uint8Array): void {
        const { stride, payOff, pid } = this;
        const { out, wanted, pos } = state;
        const length = out.length;
        let { skip, filled, lastCc, first, headerSeen, headerLength } = state;
        for (let at = 0; at + stride <= window.length && filled < length; at += stride) {
            const p = at + payOff;
            if (window[p] !== 0x47)
                throw new DemuxError('MPEG-TS sample lost transport sync on reread');
            if ((((window[p + 1]! & 0x1f) << 8) | window[p + 2]!) !== pid) continue;
            state.stopPacket = pos + at;
            state.stopBefore = wanted - skip + filled;
            state.stopCc = lastCc;
            state.stopSeen = headerSeen;
            state.stopLength = headerLength;
            const control = (window[p + 3]! >> 4) & 3;
            const offset = (control & 2) !== 0 ? 5 + window[p + 4]! : 4;
            if ((control & 2) !== 0 && window[p + 4]! > 0 && (window[p + 5]! & 0x80) !== 0)
                lastCc = -1;
            if ((control & 1) === 0) continue;
            const cc = window[p + 3]! & 15;
            if (cc === lastCc) continue;
            lastCc = cc;
            if (offset >= TS_PACKET) continue;
            if ((window[p + 1]! & 0x40) !== 0) {
                headerSeen = 0;
                headerLength = 9;
            } else if (first) throw new DemuxError('MPEG-TS sample does not start at a PES');
            first = false;
            let index = p + offset;
            const end = p + TS_PACKET;
            while (headerSeen < headerLength && index < end) {
                if (headerSeen === 8) headerLength = 9 + window[index]!;
                headerSeen++;
                index++;
            }
            const skipped = Math.min(skip, end - index);
            skip -= skipped;
            index += skipped;
            const count = Math.min(end - index, length - filled);
            if (count > 0) {
                out.set(window.subarray(index, index + count), filled);
                filled += count;
            }
        }
        state.skip = skip;
        state.filled = filled;
        state.lastCc = lastCc;
        state.first = first;
        state.headerSeen = headerSeen;
        state.headerLength = headerLength;
        state.pos = pos + window.length - (window.length % stride);
        state.span *= 2;
    }
}
