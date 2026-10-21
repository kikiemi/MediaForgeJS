import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxIndexBudget } from './demux-budget';
import { DemuxError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import {
    annexBAccessUnitStarts,
    splitAnnexBNals,
    buildAvcCFromAnnexB,
} from '../../core/codec-config/video/annexb';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import {
    parseH264Sps,
    parseHevcSps,
    avcCodecStringFromSps,
} from '../../core/codec-config/video/video-sps';
import { bindPacketizedReader, type PacketizedSampleReader } from '../../core/model/sample-index';
import { PesSampleIndex, VIDEO_SAMPLE_BYTES } from './pes-sample-index';
import { sameBytes } from '../../core/bytes/bytes';
import { packetBytes } from '../../core/bytes/shared-bytes';
import { type PesEntry, MAX_PES_BYTES } from './pes-entry';
import { type SegmentRuns, markSegment, settleTrack, tables } from './pes-timeline';

/**
 * Frame durations from successive decode times; gaps above ten seconds or reversals use the median
 * step.
 */
export function decodeDurations(dts: readonly number[]): number[] {
    const deltas: number[] = [];
    for (let i = 1; i < dts.length; i++) {
        const d = (dts[i]! - dts[i - 1]!) / 90000;
        if (d > 0 && d <= 10) deltas.push(d);
    }
    const sorted = deltas.sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[sorted.length >> 1]! : 1 / 30;
    const out: number[] = new Array(dts.length);
    for (let i = 0; i < dts.length; i++) {
        const d = i + 1 < dts.length ? (dts[i + 1]! - dts[i]!) / 90000 : median;
        out[i] = d > 0 && d <= 10 ? d : median;
    }
    return out;
}

/**
 * Joins PES payloads into video access units as they arrive: a PES timestamp applies to the access
 * unit commencing in that PES, not to its leading continuation bytes. Each unit is delivered once
 * the next one starts or at finish(); its `pos`, `skip` and `clean` locate its first byte in the
 * transport stream.
 */
export class VideoUnitJoiner {
    private current: PesEntry | undefined;
    private parts: Uint8Array[] = [];
    private size = 0;
    private tail = new Uint8Array(0);
    private previous: PesEntry | undefined;

    constructor(private readonly deliver: (unit: PesEntry) => void) {}

    push(entry: PesEntry): void {
        if (entry.discontinuity) {
            this.flush();
            this.tail = new Uint8Array(0);
        }

        const tail = this.tail;
        let trailingZeros = 0;
        while (trailingZeros < 3 && tail[tail.length - 1 - trailingZeros] === 0) trailingZeros++;
        const trailingStartCode =
            tail.length >= 3 &&
            tail[tail.length - 1] === 1 &&
            tail[tail.length - 2] === 0 &&
            tail[tail.length - 3] === 0
                ? tail.length === 4 && tail[0] === 0
                    ? 4
                    : 3
                : 0;

        let leadingZeros = 0;
        while (leadingZeros < 3 && entry.data[leadingZeros] === 0) leadingZeros++;
        const carry = trailingStartCode || trailingZeros;
        const crossesBoundary =
            trailingStartCode > 0 ||
            (trailingZeros > 0 &&
                trailingZeros + leadingZeros >= 2 &&
                entry.data[leadingZeros] === 1);

        let start = 0;
        while (!crossesBoundary && start + 3 <= entry.data.length) {
            if (
                entry.data[start] === 0 &&
                entry.data[start + 1] === 0 &&
                (entry.data[start + 2] === 1 ||
                    (entry.data[start + 2] === 0 && entry.data[start + 3] === 1))
            )
                break;
            start++;
        }

        if (!crossesBoundary && start + 3 > entry.data.length) start = entry.data.length;
        if (crossesBoundary) {
            const pending = this.parts.length > 0;
            let trim = pending ? carry : 0;
            while (trim > 0 && this.parts.length > 0) {
                const part = this.parts.pop()!;
                const count = Math.min(trim, part.length);
                if (part.length > count) this.parts.push(part.subarray(0, part.length - count));
                trim -= count;
                this.size -= count;
            }

            if (pending && this.size === 0) this.current = undefined;
            this.flush();
            demuxAssert(
                entry.data.length <= MAX_PES_BYTES - carry,
                'TS video access unit exceeds the 64 MiB sanity cap',
            );

            const previous = this.previous;
            const located = !!previous && previous.data.length >= carry;
            this.current = {
                ...entry,
                pos: located ? previous.pos : entry.pos,
                skip: located ? previous.skip + previous.data.length - carry : 0,
                clean: located && previous.clean && entry.clean,
            };

            this.parts.push(tail.slice(tail.length - carry), entry.data);
            this.size = carry + entry.data.length;
        } else if (start > 0 && this.parts.length > 0) {
            demuxAssert(
                this.size <= MAX_PES_BYTES - start,
                'TS video access unit exceeds the 64 MiB sanity cap',
            );
            this.parts.push(entry.data.subarray(0, start));
            this.size += start;
            this.current!.clean &&= entry.clean;
        }
        if (!crossesBoundary && start < entry.data.length) {
            this.flush();
            const data = entry.data.subarray(start);
            this.current = { ...entry, data, skip: entry.skip + start };
            this.parts.push(data);
            this.size = data.length;
        }

        // The last four bytes so far, copied byte by byte: views of them would cost more.
        const payload = entry.data;
        const nextTail = new Uint8Array(Math.min(4, tail.length + payload.length));
        const carried = Math.max(0, nextTail.length - payload.length);
        for (let index = 0; index < nextTail.length; index++)
            nextTail[index] =
                index < carried
                    ? tail[tail.length - carried + index]!
                    : payload[payload.length - nextTail.length + index]!;
        this.tail = nextTail;

        if (entry.incomplete) {
            if (this.parts.length > 0) this.current = undefined;
            this.parts = [];
            this.size = 0;
            this.tail = new Uint8Array(0);
        }

        this.previous = entry;
    }

    finish(): void {
        this.flush();
    }

    private flush(): void {
        const unit = this.current;
        if (unit && this.parts.length > 0) {
            if (this.parts.length > 1) {
                const data = new Uint8Array(this.size);
                let offset = 0;
                for (const part of this.parts) {
                    data.set(part, offset);
                    offset += part.length;
                }
                unit.data = data;
            } else unit.data = this.parts[0]!;
            this.deliver(unit);
        }
        this.current = undefined;
        this.parts = [];
        this.size = 0;
    }
}

/**
 * True when an H.264 SEI NAL unit (header byte included) carries a recovery point message (payload
 * type 6, H.264 D.1.8): decoding may start at its picture, as broadcast streams without IDR
 * pictures are entered.
 */
function hasH264RecoveryPoint(nal: Uint8Array): boolean {
    if ((nal[0]! & 0x1f) !== 6) return false;

    // The payload sizes count RBSP bytes, so emulation prevention bytes are skipped as the messages
    // are walked.
    let at = 1;
    let zeros = 0;
    const next = (): number => {
        if (zeros >= 2 && nal[at] === 3) {
            at++;
            zeros = 0;
        }
        const value = at < nal.length ? nal[at++]! : -1;
        zeros = value === 0 ? zeros + 1 : 0;
        return value;
    };
    const varying = (): number => {
        let value = 0;
        for (let byte = next(); ; byte = next()) {
            if (byte < 0) return -1;
            value += byte;
            if (byte !== 0xff) return value;
        }
    };
    while (at < nal.length && nal[at] !== 0x80) {
        const type = varying();
        const size = varying();
        if (type < 0 || size < 0) return false;
        if (type === 6) return true;
        for (let index = 0; index < size; index++) if (next() < 0) return false;
    }
    return false;
}

/**
 * True when an H.264 slice NAL unit (header byte included) is an I or SI slice: its slice_type, the
 * second ue(v).
 */
function isH264IntraSlice(nal: Uint8Array): boolean {
    // The two ue(v) are read from the first 16 bytes in place, passing over emulation prevention
    // bytes, as from their RBSP: every slice of a stream is read, so nothing is allocated for it.
    const end = Math.min(nal.length, 16);
    let at = 1;
    let zeros = 0;
    let byte = 0;
    let left = 0;
    let value = 0;
    for (let field = 0; field < 2; field++) {
        let leading = 0;
        let remaining = -1;
        let suffix = 0;
        for (;;) {
            if (left === 0) {
                if (at < end && zeros >= 2 && nal[at] === 3) {
                    at++;
                    zeros = 0;
                }
                if (at >= end) return false;
                byte = nal[at++]!;
                zeros = byte === 0 ? zeros + 1 : 0;
                left = 8;
            }
            const bit = (byte >> --left) & 1;
            if (remaining < 0) {
                if (bit === 0) {
                    if (++leading > 31) return false;
                    continue;
                }
                remaining = leading;
                if (remaining === 0) break;
            } else {
                suffix = suffix * 2 + bit;
                if (--remaining === 0) break;
            }
        }
        value = 2 ** leading - 1 + suffix;
    }
    const type = value % 5;
    return type === 2 || type === 4;
}

/**
 * An H.264 access unit without delimiters, fillers and repeats of the stream's parameter sets;
 * `units` are the NAL units of `data` when already split.
 */
function h264Unit(
    data: Uint8Array,
    sps: Uint8Array,
    pps: Uint8Array,
    units: readonly Uint8Array[] = splitAnnexBNals(data),
): {
    nals: Uint8Array[];
    size: number;
    key: boolean;
    recovery: boolean;
    vcl: boolean;
    intra: boolean;
} {
    const nals: Uint8Array[] = [];
    let size = 0;
    let key = false;
    let recovery = false;
    let vcl = false;
    let intra = true;
    for (const nal of units) {
        const type = nal[0]! & 0x1f;
        if (type === 9 || type === 12) continue;
        if (type === 7 && sameBytes(nal, sps)) continue;
        if (type === 8 && sameBytes(nal, pps)) continue;
        if (type === 5) key = true;
        if (type === 6 && !vcl) recovery ||= hasH264RecoveryPoint(nal);
        if (type >= 1 && type <= 5) vcl = true;
        if (type >= 1 && type <= 4) intra &&= isH264IntraSlice(nal);
        nals.push(nal);
        size += 4 + nal.length;
    }

    return { nals, size, key, recovery, vcl, intra: vcl && intra };
}

/**
 * The NAL units `nals` of `data` with 4-byte lengths in place of their start codes, `size` bytes.
 * When the caller `owns` the bytes and no unit would move past its own start (the dropped
 * delimiters and parameter sets leave room for 3-byte start codes), they are written over `data`
 * itself instead of into new bytes.
 */
function lengthPrefixed(
    data: Uint8Array,
    nals: readonly Uint8Array[],
    size: number,
    owns: boolean,
): Uint8Array {
    let inPlace = owns && size <= data.length;
    for (let offset = 0, index = 0; inPlace && index < nals.length; index++) {
        const nal = nals[index]!;
        inPlace = nal.buffer === data.buffer && offset + 4 <= nal.byteOffset - data.byteOffset;
        offset += 4 + nal.length;
    }

    const out = inPlace ? data : new Uint8Array(size);
    let offset = 0;
    for (const nal of nals) {
        if (inPlace) {
            const from = nal.byteOffset - data.byteOffset;
            out.copyWithin(offset + 4, from, from + nal.length);
        } else out.set(nal, offset + 4);
        out[offset] = (nal.length >>> 24) & 0xff;
        out[offset + 1] = (nal.length >>> 16) & 0xff;
        out[offset + 2] = (nal.length >>> 8) & 0xff;
        out[offset + 3] = nal.length & 0xff;
        offset += 4 + nal.length;
    }
    return inPlace ? out.subarray(0, size) : out;
}

/** Start and end offsets of the NAL units sampleNals found last, two per unit. */
let nalBounds = new Int32Array(64);

/**
 * The NAL units of an Annex B access unit as splitAnnexBNals finds them, as offsets into nalBounds
 * rather than a view each; returns their count.
 */
function sampleNals(data: Uint8Array): number {
    let count = 0;
    let nalStart = -1;
    for (let one = data.indexOf(1, 2); ; one = data.indexOf(1, one + 1)) {
        if (one >= 0 && (data[one - 1] !== 0 || data[one - 2] !== 0 || one - 2 < nalStart))
            continue;
        if (nalStart >= 0) {
            // The unit ends at the next start code, or at the end, without its trailing zeros.
            let trimmed = one >= 0 ? one - 2 : data.length;
            while (trimmed > nalStart && data[trimmed - 1] === 0) trimmed--;
            if (trimmed > nalStart) count = addNalBounds(count, nalStart, trimmed);
        }
        if (one < 0) return count;
        nalStart = one + 1;
    }
}

/** Records the NAL unit from `start` to `end` as unit `count` of nalBounds; returns the count. */
function addNalBounds(count: number, start: number, end: number): number {
    if (2 * count + 2 > nalBounds.length) {
        const grown = new Int32Array(nalBounds.length * 2);
        grown.set(nalBounds);
        nalBounds = grown;
    }
    nalBounds[2 * count] = start;
    nalBounds[2 * count + 1] = end;
    return count + 1;
}

/** Whether `length` bytes at `at` in `data` equal `bytes`. */
function equalsAt(data: Uint8Array, at: number, length: number, bytes: Uint8Array): boolean {
    if (length !== bytes.length) return false;
    for (let index = 0; index < length; index++)
        if (data[at + index] !== bytes[index]) return false;
    return true;
}

/**
 * An H.264 sample read back from the transport packets, as the index wrote it: lengthPrefixed() of
 * the units h264Unit() keeps, written over `data` where it may. Each sample of a pass is converted,
 * so the units are offsets rather than a view each.
 */
function lengthPrefixedSample(data: Uint8Array, sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const count = sampleNals(data);
    let size = 0;
    let kept = 0;
    let inPlace = true;
    for (let index = 0; index < count; index++) {
        const start = nalBounds[2 * index]!;
        const length = nalBounds[2 * index + 1]! - start;
        const type = data[start]! & 0x1f;
        if (type === 9 || type === 12) continue;
        if (type === 7 && equalsAt(data, start, length, sps)) continue;
        if (type === 8 && equalsAt(data, start, length, pps)) continue;
        inPlace &&= size + 4 <= start;
        nalBounds[2 * kept] = start;
        nalBounds[2 * kept + 1] = start + length;
        kept++;
        size += 4 + length;
    }
    inPlace &&= size <= data.length;
    const out = inPlace ? data : packetBytes(size);
    let offset = 0;
    for (let index = 0; index < kept; index++) {
        const start = nalBounds[2 * index]!;
        const length = nalBounds[2 * index + 1]! - start;
        if (inPlace) out.copyWithin(offset + 4, start, start + length);
        else out.set(data.subarray(start, start + length), offset + 4);
        out[offset] = (length >>> 24) & 0xff;
        out[offset + 1] = (length >>> 16) & 0xff;
        out[offset + 2] = (length >>> 8) & 0xff;
        out[offset + 3] = length & 0xff;
        offset += 4 + length;
    }
    return inPlace ? out.subarray(0, size) : out;
}

/**
 * Where a demux keeps the bytes of its samples: in the samples (`held`), as transport locations to
 * gather them from again (`located`), or both, as a stream's window does: it hands its samples on
 * with their bytes and knows them by their locations.
 */
export type TsSampleKeeping = 'held' | 'located' | 'both';

/** Where a sample's bytes are read again from the transport packets, when its unit is clean. */
export function locationOf(
    unit: PesEntry,
    keeping: TsSampleKeeping,
): { pos: number; skip: number; bytes: number } | undefined {
    return keeping !== 'held' && unit.clean
        ? { pos: unit.pos, skip: unit.skip, bytes: unit.data.length }
        : undefined;
}

/** How an H.264 or H.265 track builder keeps its samples. */
export interface VideoTrackOptions {
    /** Default `held`. */
    readonly keeping?: TsSampleKeeping;
    /** Parameter sets found before the units, as a probe's head finds them for a window. */
    readonly parameterSets?: readonly Uint8Array[];
    /**
     * The units' bytes are the demuxer's own (PES payloads it assembled), so a sample may be
     * written over them.
     */
    readonly ownsUnits?: boolean;
    /**
     * H.264 only: the builder sees the whole stream, so one without IDR pictures can be entered at
     * its recovery points; a window of a stream cannot tell.
     */
    readonly recoveryKeys?: boolean;
}

/**
 * H.264 samples in access-unit order; units before the first SPS and PPS wait until both have
 * arrived.
 */
export class H264TrackBuilder {
    private sps: Uint8Array | null = null;
    private pps: Uint8Array | null = null;
    private waiting: PesEntry[] = [];
    private readonly dts: number[] = [];
    private readonly unitOf: number[] = [];
    readonly table: PesSampleIndex;
    readonly runs: SegmentRuns = [];
    units = 0;
    private readonly keeping: TsSampleKeeping;
    private readonly ownsUnits: boolean;
    private readonly recoveryKeys: boolean;
    /**
     * Whether a sample is an IDR picture, the samples that start at a recovery point SEI, and the I
     * pictures.
     */
    private idr = false;
    private readonly recoveries: number[] = [];
    private readonly intras: number[] = [];

    constructor(
        private readonly budget: DemuxIndexBudget,
        {
            keeping = 'held',
            parameterSets = [],
            ownsUnits = false,
            recoveryKeys = false,
        }: VideoTrackOptions = {},
    ) {
        this.keeping = keeping;
        this.ownsUnits = ownsUnits;
        this.recoveryKeys = recoveryKeys;
        this.table = new PesSampleIndex(true, keeping === 'both');
        for (const nal of parameterSets) {
            if ((nal[0]! & 0x1f) === 7) this.sps ??= nal;
            else if ((nal[0]! & 0x1f) === 8) this.pps ??= nal;
        }
    }

    /** The SPS and PPS the stream's samples are read with. */
    get parameterNals(): Uint8Array[] {
        return this.sps && this.pps ? [this.sps, this.pps] : [];
    }

    push(unit: PesEntry): void {
        this.units++;
        if (this.sps && this.pps) return this.add(unit, this.sps, this.pps);
        for (const nal of unit.nals ?? splitAnnexBNals(unit.data)) {
            const type = nal[0]! & 0x1f;
            if (type === 7 && !this.sps) this.sps = nal.slice();
            else if (type === 8 && !this.pps) this.pps = nal.slice();
            if (this.sps && this.pps) break;
        }
        this.waiting.push(unit);
        if (!this.sps || !this.pps) return;
        const waiting = this.waiting;
        this.waiting = [];
        for (const entry of waiting) this.add(entry, this.sps, this.pps);
    }

    private add(unit: PesEntry, sps: Uint8Array, pps: Uint8Array): void {
        const index = this.dts.length;
        this.dts.push(unit.dts);
        const { nals, size, key, recovery, vcl, intra } = h264Unit(unit.data, sps, pps, unit.nals);
        if (!vcl) return;
        this.budget.reserveSamples(1, VIDEO_SAMPLE_BYTES, 'TS video sample index');
        this.idr ||= key;
        if (recovery && !key) this.recoveries.push(this.table.length);
        if (intra && !key) this.intras.push(this.table.length);
        markSegment(this.runs, this.table.length, unit.segment);
        this.table.push(unit.pts, unit.dts, 0, size, key, locationOf(unit, this.keeping), () =>
            lengthPrefixed(unit.data, nals, size, this.ownsUnits),
        );
        this.unitOf.push(index);
    }

    /**
     * The track, or null without access units; `reader` reads its packetized samples through
     * `convert`.
     */
    finish(
        reader: (convert?: (bytes: Uint8Array) => Uint8Array) => PacketizedSampleReader,
    ): TrackInfo | null {
        if (!this.units) return null;
        const { sps, pps } = this;
        if (!sps || !pps)
            throw new DemuxError(
                'H.264 TS stream carries no SPS/PPS; it cannot be decoded or copied',
            );
        const paramBlob = new Uint8Array(4 + sps.length + 4 + pps.length);
        paramBlob[3] = 1;
        paramBlob.set(sps, 4);
        paramBlob[4 + sps.length + 3] = 1;
        paramBlob.set(pps, 4 + sps.length + 4);
        const avcC = buildAvcCFromAnnexB(paramBlob);
        if (!avcC)
            throw new DemuxError('H.264 TS stream: SPS/PPS could not be assembled into avcC');
        const dims = parseH264Sps(sps);
        if (!dims) throw new DemuxError('H.264 TS stream: SPS does not parse');
        const table = this.table;
        demuxAssert(table.length > 0, 'H.264 TS stream contains no access units');

        // A broadcast stream without IDR pictures is entered at its recovery points, as ffmpeg
        // marks them, and one without recovery points at its I pictures, where ffmpeg's decoder
        // starts presenting such a stream.
        if (this.recoveryKeys && !this.idr)
            for (const index of this.recoveries.length ? this.recoveries : this.intras)
                table.setKeyframe(index);
        const durations = decodeDurations(this.dts);
        for (let index = 0; index < table.length; index++)
            table.setDuration(index, durations[this.unitOf[index]!]!);
        const track: TrackInfo = {
            codec: avcCodecStringFromSps(sps),
            width: dims.width,
            height: dims.height,
            displayWidth: dims.displayWidth,
            displayHeight: dims.displayHeight,
            pixelAspectRatioNum: dims.pixelAspectRatioNum,
            pixelAspectRatioDen: dims.pixelAspectRatioDen,
            sampleRate: 0,
            channelCount: 0,
            duration: table.end(),
            samples: [],
            codecConfig: avcC,
        };
        tables.set(track, table);
        if (table.located)
            bindPacketizedReader(
                track,
                reader(bytes => lengthPrefixedSample(bytes, sps, pps)),
            );
        return track;
    }
}

/**
 * H.265 samples keep their Annex B units; the first VPS, SPS and PPS form the decoder
 * configuration.
 */
export class H265TrackBuilder {
    private sps: Uint8Array | null = null;
    private readonly parameterSets = new Map<number, Uint8Array>();
    private readonly dts: number[] = [];
    readonly table: PesSampleIndex;
    readonly runs: SegmentRuns = [];
    private readonly keeping: TsSampleKeeping;

    constructor(
        private readonly budget: DemuxIndexBudget,
        { keeping = 'held', parameterSets = [] }: VideoTrackOptions = {},
    ) {
        this.keeping = keeping;
        this.table = new PesSampleIndex(true, keeping === 'both');
        for (const nal of parameterSets) {
            const type = (nal[0]! >> 1) & 0x3f;
            if (type >= 32 && type <= 34 && !this.parameterSets.has(type))
                this.parameterSets.set(type, nal);
        }
        this.sps = this.parameterSets.get(33) ?? null;
    }

    get units(): number {
        return this.dts.length;
    }

    /** The VPS, SPS and PPS the stream's configuration is built from. */
    get parameterNals(): Uint8Array[] {
        return [...this.parameterSets.values()];
    }

    push(unit: PesEntry): void {
        const nals = unit.nals ?? splitAnnexBNals(unit.data);
        if (this.parameterSets.size < 3)
            for (const nal of nals) {
                const type = (nal[0]! >> 1) & 0x3f;
                if (type >= 32 && type <= 34 && !this.parameterSets.has(type))
                    this.parameterSets.set(type, nal.slice());
                if (type === 33 && !this.sps) this.sps = this.parameterSets.get(33)!;
                if (this.parameterSets.size === 3) break;
            }

        let key = false;
        for (const nal of nals) {
            const type = (nal[0]! >> 1) & 0x3f;
            if (type === 19 || type === 20 || type === 21) {
                key = true;
                break;
            }
        }

        this.budget.reserveSamples(1, VIDEO_SAMPLE_BYTES, 'TS video sample index');
        this.dts.push(unit.dts);
        markSegment(this.runs, this.table.length, unit.segment);
        this.table.push(
            unit.pts,
            unit.dts,
            0,
            unit.data.length,
            key,
            locationOf(unit, this.keeping),
            () => unit.data,
        );
    }

    finish(
        reader: (convert?: (bytes: Uint8Array) => Uint8Array) => PacketizedSampleReader,
    ): TrackInfo | null {
        const table = this.table;
        if (!table.length) return null;
        if (!this.sps) throw new DemuxError('H.265 TS stream carries no SPS; it cannot be decoded');

        const parameterBytes = new Uint8Array(
            [...this.parameterSets.values()].reduce((size, nal) => size + 4 + nal.length, 0),
        );
        let parameterOffset = 0;
        for (const nal of this.parameterSets.values()) {
            parameterBytes[parameterOffset + 3] = 1;
            parameterBytes.set(nal, parameterOffset + 4);
            parameterOffset += 4 + nal.length;
        }

        const codecConfig = buildHevcCFromAnnexB(parameterBytes) ?? undefined;
        const parsed = parseHevcSps(this.sps);
        if (!parsed) throw new DemuxError('H.265 TS stream: SPS does not parse');

        const durations = decodeDurations(this.dts);
        for (let index = 0; index < table.length; index++)
            table.setDuration(index, durations[index]!);

        const track: TrackInfo = {
            codec: parsed.codec,
            codecConfig,
            width: parsed.width,
            height: parsed.height,
            sampleRate: 0,
            channelCount: 0,
            duration: table.end(),
            samples: [],
        };
        tables.set(track, table);
        if (table.located) bindPacketizedReader(track, reader());
        return track;
    }
}

/**
 * Decode-time steps and presentation times remembered for timing the access units split from one
 * PES.
 */
const SPLIT_HISTORY = 32;

/**
 * H.264/H.265 PES packets normally hold one access unit, but broadcasters put both fields of an
 * interlaced frame in one; each access unit becomes its own sample (a unit without a slice stays
 * with the one before it), as ffmpeg's parser splits them. The PES times belong to the first unit;
 * the others divide the time to the next PES evenly, so the units of one PES are delivered once the
 * next PES arrives. A split unit keeps the location of its first byte.
 */
export class AccessUnitSplitter {
    /**
     * The stream opens its access units with delimiters, as the MPEG-TS mapping of H.264 requires.
     */
    private delimited = false;
    private group: PesEntry[] | undefined;
    private readonly steps: number[] = [];
    private readonly presented: number[] = [];
    private latest = -Infinity;

    constructor(
        private readonly hevc: boolean,
        private readonly deliver: (unit: PesEntry) => void,
    ) {}

    private isSlice(nal: Uint8Array): boolean {
        return this.hevc
            ? ((nal[0]! >> 1) & 0x3f) <= 31
            : (nal[0]! & 0x1f) >= 1 && (nal[0]! & 0x1f) <= 5;
    }

    push(entry: PesEntry): void {
        const hevc = this.hevc;
        let nals = splitAnnexBNals(entry.data);
        /** The first NAL unit when it starts within `bytes` bytes of the payload. */
        const leading = (bytes: number): Uint8Array | undefined =>
            nals[0] && nals[0].byteOffset - entry.data.byteOffset < bytes ? nals[0] : undefined;
        if (!hevc && (leading(16)?.[0]! & 0x1f) === 9) this.delimited = true;
        let starts = annexBAccessUnitStarts(entry.data, hevc ? 'hevc' : 'h264', hevc, nals);

        // In a delimited H.264 stream, slices before the first delimiter of a PES (the end of a
        // picture, or a second field in a PES of its own) continue the access unit before it. The
        // PES time belongs to the unit that starts at the delimiter; a timed PES without one keeps
        // its slices as its own unit.
        const opening = hevc || !this.delimited ? undefined : leading(64);
        const previous = this.group;
        if (
            opening &&
            this.isSlice(opening) &&
            previous &&
            !entry.discontinuity &&
            (!entry.timed || starts.length > 1)
        ) {
            const last = previous[previous.length - 1]!;
            const leadingBytes = entry.data.subarray(0, starts[1] ?? entry.data.length);
            const data = new Uint8Array(last.data.length + leadingBytes.length);
            data.set(last.data);
            data.set(leadingBytes, last.data.length);
            last.data = data;
            last.nals = undefined;
            last.clean &&= entry.clean;
            if (starts.length < 2) return;
            entry = {
                ...entry,
                data: entry.data.subarray(starts[1]),
                skip: entry.skip + starts[1]!,
            };
            const from = entry.data.byteOffset;
            nals = nals.filter(nal => nal.byteOffset >= from);
            starts = starts.slice(1).map(start => start - starts[1]!);
        }
        const base = entry.data.byteOffset;
        /** The NAL units from `start` up to `end`, relative to the payload. */
        const within = (start: number, end: number): readonly Uint8Array[] =>
            nals.filter(nal => nal.byteOffset - base >= start && nal.byteOffset - base < end);
        const bounds = starts.filter(
            (start, index) =>
                index === 0 ||
                within(start, starts[index + 1] ?? entry.data.length).some(nal =>
                    this.isSlice(nal),
                ),
        );
        const group: PesEntry[] =
            bounds.length < 2
                ? [{ ...entry, nals }]
                : bounds.map((start, index) => {
                      const from = index === 0 ? 0 : start;
                      const to = bounds[index + 1] ?? entry.data.length;
                      return {
                          ...entry,
                          data: entry.data.subarray(from, to),
                          nals: within(from, to),
                          skip: entry.skip + from,
                          ...(index > 0 ? { discontinuity: false } : {}),
                      };
                  });
        this.remember(group[0]!.pts);
        this.release(group[0]!.dts);
        this.group = group;
    }

    finish(): void {
        this.release(undefined);
    }

    private remember(pts: number): void {
        this.presented.push(pts);
        if (this.presented.length > SPLIT_HISTORY) this.presented.shift();
        this.latest = Math.max(this.latest, pts);
    }

    /** Times the held units against the next PES's decode time and delivers them. */
    private release(next: number | undefined): void {
        const group = this.group;
        if (!group) return;
        this.group = undefined;
        const first = group[0]!;
        if (next !== undefined) {
            const step = (next - first.dts) / group.length;
            if (step > 0) {
                this.steps.push(step);
                if (this.steps.length > SPLIT_HISTORY) this.steps.shift();
            }
        }

        if (group.length > 1) {
            const sorted = [...this.steps].sort((left, right) => left - right);
            const usual = sorted.length ? sorted[sorted.length >> 1]! : 1800;
            const span =
                next !== undefined && next > first.dts ? next - first.dts : usual * group.length;
            group.forEach((unit, position) => {
                if (position === 0) return;
                const offset = Math.round((span * position) / group.length);
                unit.dts = first.dts + offset;
                unit.pts = first.pts + offset;
                // A picture presented at a time another picture already holds (a unit after
                // reordered ones) follows the latest.
                if (this.presented.includes(unit.pts)) unit.pts = Math.round(this.latest + usual);
                this.remember(unit.pts);
            });
        }

        for (const unit of group) this.deliver(unit);
    }
}

/**
 * Track of H.264 or H.265 access units in Annex B form with 90 kHz timestamps, as program streams
 * carry them; its samples hold their bytes.
 */
export function annexBVideoTrack(
    codec: 'h264' | 'hevc',
    units: readonly { data: Uint8Array; pts: number; dts: number }[],
    budget: DemuxIndexBudget,
): TrackInfo {
    const builder =
        codec === 'h264'
            ? new H264TrackBuilder(budget, { recoveryKeys: true })
            : new H265TrackBuilder(budget);
    for (const unit of units)
        builder.push({ ...unit, timed: true, segment: 0, pos: 0, skip: 0, clean: false });
    const track = builder.finish(() => {
        throw new DemuxError('Program stream video samples hold their bytes');
    });
    if (!track)
        throw new DemuxError(
            `${codec === 'h264' ? 'H.264' : 'H.265'} stream contains no access units`,
        );
    settleTrack(track, budget, false);
    return track;
}
