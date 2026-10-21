import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxIndexBudget } from '../shared/demux-budget';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { readPesTimestamp, unwrapTimestamp } from '../shared/pes-timestamp';
import { TS_PACKET } from './stream-types';
import { type StreamClock, ProgramTimeline } from '../shared/pes-timeline';
import { packetBytes } from '../../core/bytes/shared-bytes';
import { type PesEntry, MAX_PES_BYTES } from '../shared/pes-entry';

const MAX_PES_HEADER_BYTES = 264;

/**
 * Gathers the PES packets of one PID from its transport packets and hands each on once it is whole.
 */
export class PesPacketReader {
    /**
     * Payload bytes of the pending PES in arrival order, as ranges of the packets that carried them
     * (never rewritten): part i is `partLengths[i]` bytes at `partStarts[i]` of `partBytes[i]`. The
     * PES is copied out of them once, when it completes; numbers rather than views keep a packet
     * from allocating.
     */
    private readonly partBytes: Uint8Array[] = [];
    private readonly partStarts: number[] = [];
    private readonly partLengths: number[] = [];
    private size = 0;
    private started = false;
    private lastCc = -1;
    /**
     * The payload of the latest packet, at `lastAt` in `lastBytes`, which a repeated packet must
     * equal.
     */
    private lastBytes: Uint8Array | null = null;
    private lastAt = 0;
    private lastLength = 0;
    private lastPayloadStart = false;
    /** Where completed PES are assembled. */
    allocate: (length: number) => Uint8Array = packetBytes;
    private previousDecodeTime: number | null = null;
    private readonly clock: StreamClock = { segment: 0, lastRaw: null };
    private discontinuity = false;
    /**
     * The pending audio PES was cut by the end of the input; its complete frames are still
     * delivered.
     */
    private incompleteTail = false;
    /**
     * The input ends inside this stream's last PES, so part of its final access unit is missing.
     */
    cut = false;
    /** A PES of this stream started, so an empty track lacks frames rather than packets. */
    pesSeen = false;
    private flaggedReported = false;
    private prefixReported = false;
    private pendingPos = 0;
    private pendingClean = true;
    private held: PesEntry | undefined;
    readonly entries: PesEntry[] = [];

    constructor(
        private readonly video: boolean,
        private readonly diagnostics: DiagnosticContext,
        private readonly budget: DemuxIndexBudget,
        private readonly timeline: ProgramTimeline,
        private readonly onEntry?: (entry: PesEntry) => void,
    ) {}

    /** Reports a damaged PES read past, as a recovery or as a warning only. */
    private note(kind: 'recover' | 'warn', code: string, message: string): void {
        this.diagnostics[kind]({ code, format: 'ts', message });
    }

    /** Position of the transport packet that starts the PES still being gathered, if one is. */
    get pendingStart(): number | undefined {
        return this.started ? this.pendingPos : undefined;
    }

    /**
     * Bytes around the pending PES were skipped while resynchronizing; it cannot be read again
     * packet by packet.
     */
    markDamaged(): void {
        this.pendingClean = false;
    }

    /**
     * Reads the transport packet whose sync byte is at `at` in `bytes`, which hold all of it and
     * are never rewritten; `pos` is its stride position in the input, recorded for PES starts.
     */
    read(bytes: Uint8Array, at: number, pos: number): void {
        const control = (bytes[at + 3]! >> 4) & 3;
        const offset = (control & 2) !== 0 ? 5 + bytes[at + 4]! : 4;
        const damage =
            (bytes[at + 1]! & 0x80) !== 0
                ? 'has its transport error indicator set'
                : (bytes[at + 3]! & 0xc0) !== 0
                  ? 'is scrambled'
                  : control === 0
                    ? 'has no adaptation or payload control'
                    : offset > TS_PACKET
                      ? 'has an adaptation field longer than the packet'
                      : undefined;

        // Receivers flag packets whose errors they could not correct; under compatible validation a
        // flagged packet with an otherwise usable header keeps its payload, as ffmpeg does, and the
        // decoder conceals what is wrong.
        const flaggedOnly =
            damage !== undefined &&
            damage.startsWith('has its transport') &&
            this.diagnostics.validation === 'compatible' &&
            (bytes[at + 3]! & 0xc0) === 0 &&
            control !== 0 &&
            offset <= TS_PACKET;
        if (flaggedOnly && !this.flaggedReported) {
            this.flaggedReported = true;
            this.note(
                'warn',
                'TS_PES_TRANSPORT_ERROR',
                'TS packets are flagged with transport errors; kept as received',
            );
        }
        if (damage !== undefined && !flaggedOnly) {
            // A damaged header cannot be trusted for its payload; strict validation rejects it
            // through recover().
            this.note(
                'recover',
                damage.startsWith('has its transport')
                    ? 'TS_PES_TRANSPORT_ERROR'
                    : 'TS_PES_DAMAGED',
                `TS PES packet ${damage}; discarded the damaged PES`,
            );
            this.discardPending((bytes[at + 3]! & 15) !== this.lastCc);
            this.lastCc = -1;
            this.lastBytes = null;
            return;
        }
        const hasAdaptation = (control & 2) !== 0;
        if (hasAdaptation && bytes[at + 4]! > 0 && (bytes[at + 5]! & 0x80) !== 0) {
            this.lastCc = -1;
            this.lastBytes = null;
        }
        if ((control & 1) === 0) return;
        if (offset === TS_PACKET) {
            this.note(
                'recover',
                'TS_EMPTY_PAYLOAD',
                'Ignored a TS packet whose declared payload is empty',
            );
        }
        const payloadAt = at + offset;
        const length = TS_PACKET - offset;
        const start = (bytes[at + 1]! & 0x40) !== 0;
        const cc = bytes[at + 3]! & 15;
        if (cc === this.lastCc) {
            if (
                start !== this.lastPayloadStart ||
                this.lastBytes === null ||
                !rangesEqual(bytes, payloadAt, this.lastBytes, this.lastAt, length, this.lastLength)
            ) {
                this.note(
                    'recover',
                    'TS_PES_CONTINUITY',
                    'Discarded a PES whose continuity counter repeats with new data',
                );
                this.discardPending();
                this.keepPayload(bytes, payloadAt, length, start);
            }
            return;
        }
        if (this.lastCc >= 0 && cc !== ((this.lastCc + 1) & 15)) {
            this.note(
                'recover',
                'TS_PES_CONTINUITY',
                'Discarded a PES whose continuity counter jumps',
            );
            this.discardPending(true);
        }
        this.lastCc = cc;
        this.keepPayload(bytes, payloadAt, length, start);
        if (length === 0) return;
        if (start) {
            this.flush();
            this.started = true;
            this.pesSeen = true;
            this.pendingPos = pos;
            this.pendingClean = true;
        }
        if (!this.started) return;
        demuxAssert(
            this.size <= MAX_PES_BYTES + MAX_PES_HEADER_BYTES - length,
            'TS PES payload exceeds the 64 MiB sanity cap',
        );
        this.partBytes.push(bytes);
        this.partStarts.push(payloadAt);
        this.partLengths.push(length);
        this.size += length;
    }

    /**
     * The first `count` bytes of the pending PES (all of them by default), copied out of its parts.
     */
    private gathered(count = this.size): Uint8Array {
        const bytes = count < this.size ? new Uint8Array(count) : this.allocate(this.size);
        let at = 0;
        for (let index = 0; index < this.partBytes.length && at < bytes.length; index++) {
            const start = this.partStarts[index]!;
            const take = Math.min(this.partLengths[index]!, bytes.length - at);
            bytes.set(this.partBytes[index]!.subarray(start, start + take), at);
            at += take;
        }
        return bytes;
    }

    /** Ends the pending PES. */
    private clearPending(): void {
        this.partBytes.length = 0;
        this.partStarts.length = 0;
        this.partLengths.length = 0;
        this.size = 0;
        this.started = false;
    }

    /** Remembers the latest payload by reference: the bytes holding it are never rewritten. */
    private keepPayload(bytes: Uint8Array, at: number, length: number, start: boolean): void {
        this.lastBytes = bytes;
        this.lastAt = at;
        this.lastLength = length;
        this.lastPayloadStart = start;
    }

    private discardPending(preserveCompleteAudio = false): void {
        if (preserveCompleteAudio && !this.video && this.started && this.size >= 9) {
            const header = this.gathered(6);
            const declaredLength = (header[4]! << 8) | header[5]!;
            if (declaredLength > 0 && declaredLength + 6 === this.size) {
                this.flush();
                this.discontinuity = true;
                return;
            }
        }
        const last = this.onEntry ? this.held : this.entries[this.entries.length - 1];
        if (this.video && !this.discontinuity && last) {
            const prefix = this.gathered(MAX_PES_HEADER_BYTES + 4);
            const header = 9 + (prefix[8] ?? 0);
            const startsNal =
                prefix[0] === 0 &&
                prefix[1] === 0 &&
                prefix[2] === 1 &&
                prefix[header] === 0 &&
                prefix[header + 1] === 0 &&
                (prefix[header + 2] === 1 ||
                    (prefix[header + 2] === 0 && prefix[header + 3] === 1));

            // A lost continuation also invalidates the preceding unfinished access unit.
            if (!startsNal) last.incomplete = true;
        }
        this.clearPending();
        this.discontinuity = true;
    }

    private malformedPes(message: string): void {
        this.note('recover', 'TS_MALFORMED_PES', `${message}; discarded the damaged PES`);
        this.discardPending();
    }

    /**
     * `endOfInput` marks the final flush, where a short audio PES is a cut tail rather than
     * corruption.
     */
    flush(discardIncomplete = false, endOfInput = false): void {
        if (!this.started) return;
        if (discardIncomplete) {
            // A cut video access unit cannot be completed; cut audio PES still hold whole frames
            // before the cut.
            this.note(
                'recover',
                'TS_TRUNCATED_PES',
                this.video
                    ? 'Discarded the last PES, cut by the end of the input'
                    : 'Last audio PES is cut by the end of the input; keeping its whole frames',
            );
            this.cut = true;
            if (this.video) {
                this.discardPending();
                return;
            }
            this.incompleteTail = true;
        }
        const bytes = this.gathered();
        if (bytes.length < 9 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1) {
            return this.malformedPes('TS PES header is truncated or has an invalid start code');
        }
        if ((bytes[6]! & 0xc0) !== 0x80)
            return this.malformedPes('TS PES header has invalid syntax flags');
        const headerLength = 9 + bytes[8]!;
        const declaredLength = (bytes[4]! << 8) | bytes[5]!;
        if (headerLength > bytes.length)
            return this.malformedPes('TS PES optional header is truncated');
        if (declaredLength !== 0 && declaredLength < headerLength - 6) {
            return this.malformedPes('TS PES length is shorter than its optional header');
        }

        // A PES cut by the end of the input legitimately holds fewer bytes than it declares.
        const short =
            bytes.length - 6 < declaredLength &&
            (this.incompleteTail ||
                (endOfInput && !this.video && this.diagnostics.validation === 'compatible'));
        if (declaredLength !== 0 && declaredLength !== bytes.length - 6 && !short) {
            const message =
                `TS PES declares ${declaredLength - headerLength + 6} ES bytes ` +
                `but ${bytes.length - headerLength} arrived`;

            // The next PES start ends this one; with no transport packet lost in between, a wrong
            // length field (as muxers write for video PES over 64 KiB) does not make the payload
            // damaged.
            if (this.diagnostics.validation !== 'compatible') return this.malformedPes(message);
            this.note('warn', 'TS_PES_LENGTH', `${message}; the payload is kept`);
        }
        if (short) this.cut = true;
        if (short && !this.incompleteTail) {
            this.note(
                'warn',
                'TS_TRUNCATED_PES',
                'Last audio PES is shorter than declared; keeping its whole frames',
            );
            this.incompleteTail = true;
        }
        demuxAssert(
            bytes.length - headerLength <= MAX_PES_BYTES,
            'TS PES payload exceeds the 64 MiB sanity cap',
        );
        const flags = bytes[7]! >> 6;
        if (flags === 1) return this.malformedPes('TS PES timestamp flags are invalid');
        if (bytes[8]! < (flags === 3 ? 10 : flags === 2 ? 5 : 0)) {
            return this.malformedPes('TS PES optional header is shorter than its timestamp fields');
        }
        if (headerLength === bytes.length) {
            this.note(
                'recover',
                'TS_EMPTY_PES',
                'Ignored PES packet containing no elementary stream payload',
            );
            this.clearPending();
            return;
        }
        let pts = 0;
        let dts = 0;
        let segment = this.clock.segment;
        if (flags >= 2) {
            let rawPts = readPesTimestamp(bytes, 9, flags);
            let rawDts = flags === 3 ? readPesTimestamp(bytes, 14, 1) : rawPts;
            if (
                (rawPts === null || rawDts === null) &&
                this.diagnostics.validation === 'compatible'
            ) {
                // Some muxers write the wrong 4-bit prefix; the marker bits still frame a readable
                // timestamp.
                rawPts = readPesTimestamp(bytes, 9, bytes[9]! >> 4);
                rawDts = flags === 3 ? readPesTimestamp(bytes, 14, bytes[14]! >> 4) : rawPts;
                if (rawPts !== null && rawDts !== null && !this.prefixReported) {
                    this.prefixReported = true;
                    this.note(
                        'warn',
                        'TS_PES_TIMESTAMP_PREFIX',
                        'TS PES timestamps have a wrong prefix; read them anyway',
                    );
                }
            }
            if (rawPts === null || rawDts === null) {
                return this.malformedPes('TS PES timestamp has invalid prefix or marker bits');
            }
            dts = unwrapTimestamp(this.video ? rawDts : rawPts, this.previousDecodeTime);
            this.previousDecodeTime = dts;
            pts = this.video ? unwrapTimestamp(rawPts, dts) : dts;
            segment = this.timeline.segment(this.clock, dts);
        }
        this.clearPending();
        const entry: PesEntry = {
            pts,
            dts,
            timed: flags >= 2,
            data: bytes.subarray(headerLength),
            segment,
            discontinuity: this.discontinuity,
            ...(this.incompleteTail ? { incomplete: true } : {}),
            pos: this.pendingPos,
            skip: 0,
            clean: this.pendingClean,
        };
        this.incompleteTail = false;
        if (this.onEntry && this.video) {
            this.end();
            this.held = entry;
        } else if (this.onEntry) this.onEntry(entry);
        else {
            this.budget.reserveBytes(256, 'TS PES index');
            this.entries.push(entry);
        }
        this.discontinuity = false;
    }

    /**
     * Delivers the video PES held back until the next one shows whether a lost continuation cut it
     * short.
     */
    end(): void {
        const held = this.held;
        this.held = undefined;
        if (held) this.onEntry!(held);
    }
}

/** Whether `length` bytes at `at` in `a` equal `otherLength` bytes at `otherAt` in `b`. */
function rangesEqual(
    a: Uint8Array,
    at: number,
    b: Uint8Array,
    otherAt: number,
    length: number,
    otherLength: number,
): boolean {
    if (length !== otherLength) return false;
    for (let index = 0; index < length; index++)
        if (a[at + index] !== b[otherAt + index]) return false;
    return true;
}
