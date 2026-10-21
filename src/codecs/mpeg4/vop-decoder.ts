import { idct8x8 } from '../shared/idct';
import type { BitReader } from './bit-reader';
import { SPRITE_GMC, VOP_B, VOP_I, VOP_P, VOP_S } from './headers';
import { AVG, MotionCompensation, PUT, PUT_NO_RND } from './motion';
import {
    ADVANCED_INTRA_COEFFICIENTS,
    ALTERNATE_HORIZONTAL,
    B_MBTYPE,
    B_MBTYPE_BITS,
    B_MBTYPE_STUFFING,
    CBPY,
    CBPY_BITS,
    CHROMA_4MV_ROUND,
    CHROMA_DC_SCALE,
    COEFFICIENT_BITS,
    DC_SIZE_BITS,
    DC_SIZE_CHROMA,
    DC_SIZE_LUMA,
    ESCAPE,
    INTER_COEFFICIENTS,
    INTER_MCBPC,
    INTER_MCBPC_BITS,
    INTRA_COEFFICIENTS,
    INTRA_DC_THRESHOLD,
    INTRA_MCBPC,
    INTRA_MCBPC_BITS,
    LUMA_DC_SCALE,
    MCBPC_INTER_STUFFING,
    MCBPC_INTRA_STUFFING,
    MV_BITS,
    MV_CODES,
    reversibleCoefficients,
    SPRITE_TRAJECTORY,
    SPRITE_TRAJECTORY_BITS,
    type CoefficientTable,
} from './tables';
import { ZIGZAG_8X8, ALTERNATE_8X8 } from '../shared/dct-scan';
import { xvidIdct8x8 } from './xvid-idct';
import {
    blendOverlapped,
    CHROMA_QUANT,
    deblockMacroblock,
    type H263Modes,
    mbaLength,
    modifiedQuant,
    NO_H263_MODES,
} from './h263-modes';

/** Macroblock flags kept per picture; B-VOPs read them from their future reference. */
const MB_INTRA = 1;

/** not_coded macroblock of a P-VOP; co-located B-VOP macroblocks are skipped too. */
const MB_SKIPPED = 2;
const MB_INTER4V = 4;
const MB_FIELD = 8;
const MB_GMC = 16;

const MV_16X16 = 0;
const MV_8X8 = 1;
const MV_FIELD = 2;

const DC_MARKER = 0x6b001;
const MOTION_MARKER = 0x1f001;
const DQUANT = [-1, -2, 1, 2];

/**
 * Column offset of candidate C (above-right) relative to each luma block, ISO/IEC 14496-2 Figure
 * 7-30.
 */
const C_CANDIDATE_OFFSET = [2, 1, 1, -1];

/** Chroma rounding of DivX 5.03+ quarter-sample vectors, indexed by the vector's low three bits. */
const QPEL_CHROMA2_ROUND = [0, 0, 1, 1, 0, 0, 0, 1];

const B_DIRECT = 0;
const B_BACKWARD = 2;
const B_FORWARD = 3;

const PART_INTRA = 1;
const PART_SKIPPED = 2;
const PART_INTER4V = 4;
const PART_DQUANT = 8;
const PART_MCSEL = 16;
const PART_AC_PRED = 32;
const PART_DC_VLC = 64;

class DamagedData extends Error {}
const DAMAGED = new DamagedData('damaged macroblock data');

/**
 * A coefficient run past the block end, which Annex S answers by reading the block again with Table
 * I.2.
 */
const RUN_OVERFLOW = new DamagedData('coefficient run overflow');

/** Decoded picture in I420 coded size with the side information later B-VOPs need. */
export class Picture {
    readonly data: Uint8Array;
    readonly mbType: Uint8Array;
    /**
     * Motion vector per 8x8 luma block, x then y, row-major over (2 * mbWidth) x (2 * mbHeight)
     * blocks.
     */
    readonly mv: Int16Array;
    /**
     * Field motion vectors per macroblock: top x, top y, bottom x, bottom y, vertical in field
     * lines.
     */
    readonly fieldMv: Int16Array;
    /**
     * Reference field per macroblock: bit 0 for the top field prediction, bit 1 for the bottom one.
     */
    readonly fieldSelect: Uint8Array;

    constructor(frameSize: number, mbCount: number) {
        this.data = new Uint8Array(frameSize);
        this.mbType = new Uint8Array(mbCount);
        this.mv = new Int16Array(mbCount * 8);
        this.fieldMv = new Int16Array(mbCount * 4);
        this.fieldSelect = new Uint8Array(mbCount);
    }
}

/** Decoding deviations of known encoders, selected from their user data. */
export interface Workarounds {
    /** Reference edges at the visible size instead of the macroblock-aligned size. */
    readonly edgeAtVisibleSize: boolean;
    /** Intra DC predictors are not clipped to 2047. */
    readonly unclippedDc: boolean;
    readonly qpelChroma: boolean;
    readonly qpelChroma2: boolean;
    /** Averaging of early libavcodec quarter-sample filters. */
    readonly legacyQpel: boolean;
    /**
     * Field prediction chroma of some libavcodec versions reuses one Cr row for Cb at emulated
     * edges.
     */
    readonly interlacedEdge: boolean;
    /** DivX field prediction derives chroma vectors with half-sample rounding. */
    readonly fieldChromaRounding: boolean;
    /** DivX 5.00 build 413 sprite trajectory coding. */
    readonly divx500Sprite: boolean;
    readonly xvidIdct: boolean;
}

const NO_WORKAROUNDS: Workarounds = {
    edgeAtVisibleSize: false,
    unclippedDc: false,
    qpelChroma: false,
    qpelChroma2: false,
    legacyQpel: false,
    interlacedEdge: false,
    fieldChromaRounding: false,
    divx500Sprite: false,
    xvidIdct: false,
};

/** Sequence-level coding tools of the active video object layer or short header stream. */
export interface SequenceCoding {
    readonly width: number;
    readonly height: number;
    readonly shortHeader: boolean;
    readonly interlaced: boolean;
    readonly quarterSample: boolean;
    readonly mpegQuant: boolean;
    readonly intraMatrix: Uint8Array;
    readonly interMatrix: Uint8Array;
    readonly quantPrecision: number;
    readonly resyncMarkers: boolean;
    readonly dataPartitioned: boolean;
    readonly reversibleVlc: boolean;
    readonly newPred: boolean;
    readonly timeIncrementBits: number;
    readonly spriteEnable: number;
    readonly spriteWarpingPoints: number;
    readonly spriteAccuracy: number;
}

/** Per-VOP header values the macroblock layer needs. */
interface VopCoding {
    type: number;
    quant: number;
    fcode: number;
    bcode: number;
    /** vop_rounding_type: 1 selects rounding towards zero for P- and S-VOP interpolation. */
    rounding: number;
    intraDcThreshold: number;
    topFieldFirst: boolean;
    alternateScan: boolean;
    /** Sprite trajectory du, dv per warping point. */
    readonly trajectory: Int32Array;
    /**
     * Temporal distances in vop_time_increment units: anchor to anchor and past anchor to B-VOP.
     */
    ppTime: number;
    pbTime: number;
    /** Field distances for interlaced direct mode. */
    ppFieldTime: number;
    pbFieldTime: number;
    /** H.263 unrestricted motion vector mode of short header pictures. */
    longVectors: boolean;
    /** H.263 optional modes of a short header picture. */
    modes: H263Modes;
}

export function newVopCoding(): VopCoding {
    return {
        type: VOP_I,
        quant: 1,
        fcode: 1,
        bcode: 1,
        rounding: 0,
        intraDcThreshold: 0,
        topFieldFirst: true,
        alternateScan: false,
        trajectory: new Int32Array(8),
        ppTime: 0,
        pbTime: 0,
        ppFieldTime: 0,
        pbFieldTime: 0,
        longVectors: false,
        modes: NO_H263_MODES,
    };
}

function median(a: number, b: number, c: number): number {
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Integer division rounding half away from zero (the `//` operator of ISO/IEC 14496-2). */
export function roundedDivide(a: number, b: number): number {
    return Math.trunc((a >= 0 ? a + (b >> 1) : a - (b >> 1)) / b);
}

function roundedShift(a: number, shift: number): number {
    const half = 2 ** shift / 2;
    return Math.floor((a > 0 ? a + half : a + half - 1) / 2 ** shift);
}

/**
 * Macroblock layer of one video object layer (ISO/IEC 14496-2 6.2.6 to 7.8), including short header
 * pictures, error resilience tools and concealment. The owner keeps it configured and supplies
 * reference pictures.
 */
export class VopDecoder {
    width = 0;
    height = 0;
    mbWidth = 0;
    mbHeight = 0;
    mbCount = 0;
    lumaStride = 0;
    chromaStride = 0;
    chromaBase = 0;
    crBase = 0;
    frameSize = 0;

    private seq!: SequenceCoding;
    private fix: Workarounds = NO_WORKAROUNDS;
    private br!: BitReader;
    private vop!: VopCoding;
    private cur!: Picture;
    private fwd: Picture | null = null;
    private bwd: Picture | null = null;
    private bwdNotCoded = false;
    private readonly mc = new MotionCompensation();
    private idct: (block: Int32Array) => void = idct8x8;

    private readonly block = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(64));
    /** Coefficients of the B part of a PB-frame macroblock, read and discarded. */
    private readonly discarded = new Int32Array(64);
    /** CBPB of the current PB-frame macroblock. */
    private pbCbp = 0;
    /**
     * The five 8x8 predictions of an overlapped block: own vector, above, left, right and below.
     */
    private readonly overlapped = new Uint8Array(5 * 64);
    /** QP of each decoded macroblock of a deblocked picture, 0 for skipped and concealed ones. */
    private filterQuant = new Uint8Array(0);
    private qscale = 1;
    private packetStart = 0;
    private edgeWidth = 0;
    private edgeHeight = 0;

    private dc = new Int32Array(0);
    private ac = new Int16Array(0);
    private mbQuant = new Uint8Array(0);
    private blockGridWidth = 0;
    private lumaBlocks = 0;

    private partCbp = new Uint8Array(0);
    private partFlags = new Uint8Array(0);
    private partDc = new Int16Array(0);

    private intraScan = ZIGZAG_8X8;
    private leftScan = ALTERNATE_8X8;
    private topScan = ALTERNATE_HORIZONTAL;
    private interScan = ZIGZAG_8X8;

    private mvType = MV_16X16;
    private mcsel = false;
    private readonly mvF = new Int32Array(8);
    private readonly mvB = new Int32Array(8);
    /**
     * Backward vectors of the current H.263 B picture per 8x8 block, as `Picture.mv` holds its
     * forward ones.
     */
    private backwardMv = new Int16Array(0);
    private readonly fieldSelF = new Uint8Array(2);
    private readonly fieldSelB = new Uint8Array(2);
    private readonly lastMv = new Int32Array(8);
    private fieldDct = false;
    private predX = 0;
    private predY = 0;

    private spriteOffset = [0, 0, 0, 0];
    private spriteDelta = [0, 0, 0, 0];
    private spriteShift = 0;
    private spriteRealPoints = 0;
    private spriteValid = true;

    configure(seq: SequenceCoding, fix: Workarounds): void {
        this.seq = seq;
        this.fix = fix;
        this.idct = fix.xvidIdct ? xvidIdct8x8 : idct8x8;
        if (seq.width === this.width && seq.height === this.height) return;
        this.width = seq.width;
        this.height = seq.height;
        this.mbWidth = (seq.width + 15) >> 4;
        this.mbHeight = (seq.height + 15) >> 4;
        this.mbCount = this.mbWidth * this.mbHeight;
        this.lumaStride = this.mbWidth * 16;
        this.chromaStride = this.mbWidth * 8;
        this.chromaBase = this.lumaStride * this.mbHeight * 16;
        this.crBase = this.chromaBase + this.chromaStride * this.mbHeight * 8;
        this.frameSize = this.crBase + this.chromaStride * this.mbHeight * 8;
        this.blockGridWidth = this.mbWidth * 2;
        this.lumaBlocks = this.mbCount * 4;
        this.dc = new Int32Array(this.mbCount * 6);
        this.ac = new Int16Array(this.mbCount * 6 * 16);
        this.mbQuant = new Uint8Array(this.mbCount);
        this.filterQuant = new Uint8Array(this.mbCount);
        this.partCbp = new Uint8Array(this.mbCount);
        this.partFlags = new Uint8Array(this.mbCount);
        this.partDc = new Int16Array(this.mbCount * 6);
        this.backwardMv = new Int16Array(this.mbCount * 8);
    }

    newPicture(): Picture {
        return new Picture(this.frameSize, this.mbCount);
    }

    /**
     * Copies the whole reference into `target`, marking every macroblock as skipped. Without a
     * reference the picture is blank: chroma 128 and luma `blankLuma`.
     */
    concealPicture(target: Picture, reference: Picture | null, blankLuma = 128): void {
        if (reference) target.data.set(reference.data);
        else target.data.fill(blankLuma, 0, this.chromaBase).fill(128, this.chromaBase);
        target.mbType.fill(MB_SKIPPED);
        target.mv.fill(0);
    }

    /**
     * Decodes the macroblock data of one VOP into `target`. Damaged video packets are concealed
     * from `forward` (or mid-grey without one) and decoding resumes at the next resync point.
     * Returns the concealed macroblock count.
     */
    decodeVop(
        br: BitReader,
        vop: VopCoding,
        target: Picture,
        forward: Picture | null,
        backward: Picture | null,
        backwardNotCoded: boolean,
    ): number {
        this.br = br;
        this.vop = vop;
        this.cur = target;
        this.fwd = forward;
        this.bwd = backward;
        this.bwdNotCoded = backwardNotCoded;
        this.qscale = vop.quant;
        const visibleEdge = this.fix.edgeAtVisibleSize && !this.seq.shortHeader;
        this.edgeWidth = visibleEdge ? this.width : this.mbWidth * 16;
        this.edgeHeight = visibleEdge ? this.height : this.mbHeight * 16;
        if (vop.alternateScan) {
            this.intraScan = ALTERNATE_8X8;
            this.leftScan = ALTERNATE_8X8;
            this.topScan = ALTERNATE_8X8;
            this.interScan = ALTERNATE_8X8;
        } else {
            this.intraScan = ZIGZAG_8X8;
            this.leftScan = ALTERNATE_8X8;
            this.topScan = ALTERNATE_HORIZONTAL;
            this.interScan = ZIGZAG_8X8;
        }
        this.spriteValid = true;
        if (vop.type === VOP_S) this.setupSprite();
        if (!this.spriteValid) {
            this.concealRange(0, this.mbCount);
            return this.mbCount;
        }
        if (this.seq.shortHeader) return this.decodeShortHeaderPicture();
        let concealed = 0;
        let mb = 0;
        this.packetStart = 0;
        while (mb < this.mbCount) {
            const start = mb;
            const packetBit = br.pos;
            let next: number;
            try {
                next =
                    this.seq.dataPartitioned && vop.type !== VOP_B
                        ? this.decodePartitionedPacket(start)
                        : this.decodePacket(start);
            } catch (error) {
                if (!(error instanceof DamagedData)) throw error;
                for (const block of this.block) block.fill(0);
                br.pos = packetBit;
                next = this.resync(start);
                this.concealRange(start, next);
                concealed += next - start;
            }
            mb = next;
            this.packetStart = mb;
        }
        return concealed;
    }

    private setupQuant(q: number): void {
        this.qscale = q < 1 ? 1 : q > 31 ? 31 : q;
    }

    /**
     * DQUANT of a combined-mode macroblock: a 2-bit step, or under H.263 Annex T a step table or a
     * new QP.
     */
    private readDquant(): void {
        const br = this.br;
        if (!this.vop.modes.modifiedQuant) this.setupQuant(this.qscale + DQUANT[br.read(2)]);
        else if (br.read1()) this.setupQuant(modifiedQuant(this.qscale, br.read1()));
        else this.setupQuant(br.read(5));
    }

    /** QP of block `n`: chroma blocks of H.263 Annex T pictures map it through the chroma table. */
    private blockQuant(n: number): number {
        return n >= 4 && this.vop.modes.modifiedQuant ? CHROMA_QUANT[this.qscale] : this.qscale;
    }

    /**
     * Macroblocks of one video packet in combined mode; returns the first macroblock of the next
     * packet.
     */
    private decodePacket(start: number): number {
        const br = this.br;
        const vop = this.vop;
        const lastMv = this.lastMv;
        lastMv[0] = lastMv[1] = lastMv[4] = lastMv[5] = 0;
        for (let mb = start; mb < this.mbCount; mb++) {
            const mbx = mb % this.mbWidth;
            const mby = (mb - mbx) / this.mbWidth;
            if (vop.type === VOP_B) {
                if (mbx === 0) lastMv.fill(0);
                this.decodeBMacroblock(mb, mbx, mby);
            } else {
                this.decodeMacroblock(mb, mbx, mby);
            }
            if (br.pos > br.end) throw DAMAGED;
            if (mb + 1 < this.mbCount && this.seq.resyncMarkers && this.resyncAhead()) {
                const next = this.nextVideoPacket();
                if (next <= mb) throw DAMAGED;
                if (next > mb + 1) this.concealRange(mb + 1, next);
                return next;
            }
        }
        return this.mbCount;
    }

    /**
     * True when stuffing up to the next byte boundary is followed by a resync marker (ISO/IEC
     * 14496-2 6.3.5.2).
     */
    private resyncAhead(): boolean {
        const br = this.br;
        const stuffing = 8 - (br.pos & 7);
        if (br.peek(stuffing) !== (1 << (stuffing - 1)) - 1) return false;
        const saved = br.pos;
        br.pos += stuffing;
        const zeros = this.countZeros(32);
        br.pos = saved;
        return zeros >= this.resyncPrefixLength();
    }

    private countZeros(limit: number): number {
        const br = this.br;
        let zeros = 0;
        while (zeros < limit && br.pos < br.end && br.read1() === 0) zeros++;
        return zeros;
    }

    private resyncPrefixLength(): number {
        const vop = this.vop;
        if (vop.type === VOP_I) return 16;
        if (vop.type === VOP_B) return Math.max(vop.fcode, vop.bcode, 2) + 15;
        return vop.fcode + 15;
    }

    /**
     * Skips the stuffing before a resync marker and parses the video packet header that follows.
     */
    private nextVideoPacket(): number {
        this.br.pos += 8 - (this.br.pos & 7);
        return this.readVideoPacketHeader();
    }

    /**
     * Parses video_packet_header() from its byte-aligned resync_marker; returns its
     * macroblock_number.
     */
    private readVideoPacketHeader(): number {
        const br = this.br;
        const vop = this.vop;
        if (this.countZeros(32) !== this.resyncPrefixLength()) throw DAMAGED;
        const mbNumber = br.read(Math.max(1, 32 - Math.clz32(this.mbCount - 1)));
        if (mbNumber === 0 || mbNumber >= this.mbCount) throw DAMAGED;
        const quant = br.read(this.seq.quantPrecision);
        if (quant) this.qscale = quant;
        if (br.read1()) {
            while (br.read1()) if (br.pos > br.end) throw DAMAGED;
            br.skip(1 + this.seq.timeIncrementBits + 1 + 2 + 3);
            if (vop.type === VOP_S && this.seq.spriteEnable === SPRITE_GMC)
                this.skipSpriteTrajectory();
            if (vop.type !== VOP_I) br.skip(3);
            if (vop.type === VOP_B) br.skip(3);
        }
        if (this.seq.newPred) {
            const length = Math.min(this.seq.timeIncrementBits + 3, 15);
            br.skip(length);
            if (br.read1()) br.skip(length);
            br.skip(1);
        }
        if (br.pos > br.end) throw DAMAGED;
        return mbNumber;
    }

    private skipSpriteTrajectory(): void {
        const br = this.br;
        for (let i = 0; i < this.seq.spriteWarpingPoints * 2; i++) {
            const entry = SPRITE_TRAJECTORY[br.peek(SPRITE_TRAJECTORY_BITS)];
            if (!(entry & 31)) throw DAMAGED;
            br.skip((entry & 31) + (entry >> 5) + 1);
        }
    }

    /**
     * Finds the next decodable video packet after a damaged one by scanning byte-aligned positions
     * from the damaged packet's start; returns its first macroblock, or the macroblock count when
     * none remains.
     */
    private resync(start: number): number {
        const br = this.br;
        let position = ((br.pos + 7) & ~7) + 8;
        if (!this.seq.resyncMarkers) return this.mbCount;
        const data = br.data;
        while (position + 32 <= br.end) {
            const byte = position >>> 3;
            if (data[byte] === 0 && data[byte + 1] === 0) {
                br.pos = position;
                try {
                    const mb = this.readVideoPacketHeader();
                    if (mb > start) return mb;
                } catch (error) {
                    if (!(error instanceof DamagedData)) throw error;
                }
            }
            position += 8;
        }
        br.pos = br.end;
        return this.mbCount;
    }

    /**
     * Copies co-located macroblocks of the forward reference over [from, to) and marks them as
     * skipped.
     */
    private concealRange(from: number, to: number): void {
        const cur = this.cur;
        const ref = this.fwd ?? this.bwd;
        const data = cur.data;
        for (let mb = from; mb < to; mb++) {
            const mbx = mb % this.mbWidth;
            const mby = (mb - mbx) / this.mbWidth;
            cur.mbType[mb] = MB_SKIPPED;
            this.storeMacroblockMv(mbx, mby, 0, 0);
            this.storeMacroblockMv(mbx, mby, 0, 0, this.backwardMv);
            const y = mby * 16 * this.lumaStride + mbx * 16;
            const c = mby * 8 * this.chromaStride + mbx * 8;
            for (let row = 0; row < 16; row++) {
                const o = y + row * this.lumaStride;
                if (ref) data.set(ref.data.subarray(o, o + 16), o);
                else data.fill(128, o, o + 16);
            }
            for (let row = 0; row < 8; row++) {
                const u = this.chromaBase + c + row * this.chromaStride;
                const v = this.crBase + c + row * this.chromaStride;
                if (ref) {
                    data.set(ref.data.subarray(u, u + 8), u);
                    data.set(ref.data.subarray(v, v + 8), v);
                } else {
                    data.fill(128, u, u + 8);
                    data.fill(128, v, v + 8);
                }
            }
        }
    }

    private storeMacroblockMv(
        mbx: number,
        mby: number,
        x: number,
        y: number,
        mv = this.cur.mv,
    ): void {
        const top = (2 * mby * this.blockGridWidth + 2 * mbx) * 2;
        const bottom = top + this.blockGridWidth * 2;
        mv[top] = mv[top + 2] = mv[bottom] = mv[bottom + 2] = x;
        mv[top + 1] = mv[top + 3] = mv[bottom + 1] = mv[bottom + 3] = y;
    }

    /**
     * Reads one motion vector component relative to `pred`, wrapped to the f_code range (ISO/IEC
     * 14496-2 7.6.3).
     */
    private readMv(pred: number, fcode: number): number {
        const br = this.br;
        const entry = MV_CODES[br.peek(MV_BITS)];
        const length = entry & 31;
        if (!length) throw DAMAGED;
        br.skip(length);
        const code = (entry >> 5) - 32;
        if (code === 0) return pred;
        let value = code < 0 ? -code : code;
        if (fcode > 1) value = (((value - 1) << (fcode - 1)) | br.read(fcode - 1)) + 1;
        value = pred + (code < 0 ? -value : value);
        if (this.vop.longVectors) {
            if (pred < -31 && value < -63) value += 64;
            if (pred > 32 && value > 63) value -= 64;
            return value;
        }
        const shift = 27 - fcode;
        return (value << shift) >> shift;
    }

    /**
     * Median prediction for luma block `block` (0-3) from neighbours in the same video packet;
     * candidates outside the VOP or packet count as zero, and two missing candidates select the
     * remaining one (7.6.5). In H.263 a missing upper candidate leaves the left one alone, even
     * when the slice starts at the upper right. `mv` holds the vectors predicted from: the
     * picture's own, or the backward ones of an H.263 B picture.
     */
    private predictMv(mbx: number, mby: number, block: number, mv = this.cur.mv): void {
        const gw = this.blockGridWidth;
        const bx = 2 * mbx + (block & 1);
        const by = 2 * mby + (block >> 1);
        const packetStart = this.packetStart;
        const mbw = this.mbWidth;
        let valid = 0;
        let ax = 0;
        let ay = 0;
        let bxv = 0;
        let byv = 0;
        let cx = 0;
        let cy = 0;
        const aCol = bx - 1;
        if (aCol >= 0 && (by >> 1) * mbw + (aCol >> 1) >= packetStart) {
            const i = (by * gw + aCol) * 2;
            ax = mv[i];
            ay = mv[i + 1];
            valid |= 1;
        } else if (block === 2 && aCol >= 0) {
            const i = (by * gw + aCol) * 2;
            mv[i] = mv[i + 1] = 0;
        }
        if (by > 0) {
            const row = by - 1;
            if ((row >> 1) * mbw + (bx >> 1) >= packetStart) {
                const i = (row * gw + bx) * 2;
                bxv = mv[i];
                byv = mv[i + 1];
                valid |= 2;
            }
            const cCol = bx + C_CANDIDATE_OFFSET[block];
            if (cCol < gw && (row >> 1) * mbw + (cCol >> 1) >= packetStart) {
                const i = (row * gw + cCol) * 2;
                cx = mv[i];
                cy = mv[i + 1];
                valid |= 4;
            }
        }
        if (!(valid & 2) && this.seq.shortHeader) valid &= 1;
        if (valid === 7 || valid === 3 || valid === 5 || valid === 6) {
            this.predX = median(ax, bxv, cx);
            this.predY = median(ay, byv, cy);
        } else if (valid === 1) {
            this.predX = ax;
            this.predY = ay;
        } else if (valid === 2) {
            this.predX = bxv;
            this.predY = byv;
        } else if (valid === 4) {
            this.predX = cx;
            this.predY = cy;
        } else {
            this.predX = 0;
            this.predY = 0;
        }
    }

    /**
     * Reads TCOEF events (ISO/IEC 14496-2 7.4.1, Tables B-16/B-17 with three escape types, or the
     * H.263 escape for short headers) into `block` from scan index `first`. Levels are dequantized
     * with 2 * QP and (QP - 1) | 1 when `qmul` is non-zero. Returns the last scan index.
     */
    private readCoefficients(
        block: Int32Array,
        first: number,
        scan: Uint8Array,
        table: CoefficientTable,
        qmul: number,
        qadd: number,
    ): number {
        const br = this.br;
        const data = br.data;
        const lookup = table.lookup;
        const h263Escape = this.seq.shortHeader;
        let pos = br.pos;
        let i = first - 1;
        for (;;) {
            const p = pos >>> 3;
            const bits =
                ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) <<
                (pos & 7);
            let entry = lookup[bits >>> (32 - COEFFICIENT_BITS)];
            const length = entry & 31;
            let level: number;
            let run: number;
            let last: number;
            if (length !== ESCAPE) {
                if (length === 0) throw DAMAGED;
                pos += length;
                level = entry >> 12;
                run = (entry >> 6) & 63;
                last = entry & 32;
                if (qmul) level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
            } else {
                br.pos = pos + 7;
                if (h263Escape) {
                    last = br.read1();
                    run = br.read(6);
                    level = (br.read(8) << 24) >> 24;
                    if (level === -128) level = br.read(5) | (br.readSigned(6) * 32);
                    if (qmul) level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
                } else {
                    const kind = br.peek(2);
                    if (kind === 3) {
                        br.skip(2);
                        last = br.read1();
                        run = br.read(6);
                        if (!br.read1()) throw DAMAGED;
                        level = br.readSigned(12);
                        if (!br.read1()) throw DAMAGED;
                        if (qmul) {
                            level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
                            level = level < -2048 ? -2048 : level > 2047 ? 2047 : level;
                        }
                    } else {
                        br.skip(kind === 2 ? 2 : 1);
                        entry = lookup[br.peek(COEFFICIENT_BITS)];
                        const inner = entry & 31;
                        if (inner === 0 || inner === ESCAPE) throw DAMAGED;
                        br.skip(inner);
                        level = entry >> 12;
                        run = (entry >> 6) & 63;
                        last = entry & 32;
                        const row = last ? 64 : 0;
                        if (kind === 2) {
                            run += table.maxRun[row + (level < 0 ? -level : level)] + 1;
                        } else {
                            const extra = table.maxLevel[row + run];
                            level = level > 0 ? level + extra : level - extra;
                        }
                        if (qmul) level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
                    }
                }
                pos = br.pos;
            }
            i += run + 1;
            if (i > 63) throw RUN_OVERFLOW;
            block[scan[i]] = level;
            if (last) break;
        }
        br.pos = pos;
        return i;
    }

    /**
     * Reads texture coded with reversible VLCs in the forward direction (ISO/IEC 14496-2 Tables
     * B-23/B-24): the escape carries last, run and an 11-bit magnitude between marker bits and a
     * closing reversed escape.
     */
    private readReversibleCoefficients(
        block: Int32Array,
        first: number,
        scan: Uint8Array,
        intra: boolean,
        qmul: number,
        qadd: number,
    ): void {
        const br = this.br;
        const table = reversibleCoefficients()[intra ? 0 : 1];
        const lookup = table.lookup;
        let i = first - 1;
        for (;;) {
            const entry = lookup[br.peek(table.bits)];
            const length = entry & 31;
            let level: number;
            let run: number;
            let last: number;
            if (length === ESCAPE) {
                br.skip(4);
                if (!br.read1()) throw DAMAGED;
                last = br.read1();
                run = br.read(6);
                if (!br.read1()) throw DAMAGED;
                level = br.read(11);
                if (br.read(5) !== 0x10) throw DAMAGED;
                if (qmul) level = level * qmul + qadd;
                if (br.read1()) level = -level;
            } else {
                if (length === 0) throw DAMAGED;
                br.skip(length);
                level = entry >> 12;
                run = (entry >> 6) & 63;
                last = entry & 32;
                if (qmul) level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
            }
            i += run + 1;
            if (i > 63 || br.pos > br.end) throw DAMAGED;
            block[scan[i]] = level;
            if (last) return;
        }
    }

    private blockIndex(mb: number, mbx: number, mby: number, n: number): number {
        if (n < 4) return (2 * mby + (n >> 1)) * this.blockGridWidth + 2 * mbx + (n & 1);
        return this.lumaBlocks + (n - 4) * this.mbCount + mb;
    }

    /**
     * Neighbour block index for intra prediction, or -1 outside the VOP, the video packet or intra
     * macroblocks.
     */
    private intraNeighbour(
        mb: number,
        mbx: number,
        mby: number,
        n: number,
        dx: number,
        dy: number,
    ): number {
        let nmb: number;
        let index: number;
        if (n < 4) {
            const bx = 2 * mbx + (n & 1) + dx;
            const by = 2 * mby + (n >> 1) + dy;
            if (bx < 0 || by < 0) return -1;
            nmb = (by >> 1) * this.mbWidth + (bx >> 1);
            index = by * this.blockGridWidth + bx;
        } else {
            if (mbx + dx < 0 || mby + dy < 0) return -1;
            nmb = mb + dy * this.mbWidth + dx;
            index = this.lumaBlocks + (n - 4) * this.mbCount + nmb;
        }
        if (nmb < this.packetStart || !(this.cur.mbType[nmb] & MB_INTRA)) return -1;
        return index;
    }

    /**
     * Intra block `n` with DC and optional AC prediction (ISO/IEC 14496-2 7.4.3). `dcDiff` is the
     * DC differential already read from the DC VLC, or NaN when the DC is coded as the first TCOEF.
     * Leaves dequantized coefficients.
     */
    private decodeIntraBlock(
        mb: number,
        mbx: number,
        mby: number,
        n: number,
        coded: boolean,
        dcDiff: number,
        acPred: boolean,
    ): void {
        const block = this.block[n];
        const dc = this.dc;
        const scale = n < 4 ? LUMA_DC_SCALE[this.qscale] : CHROMA_DC_SCALE[this.qscale];
        const left = this.intraNeighbour(mb, mbx, mby, n, -1, 0);
        const corner = this.intraNeighbour(mb, mbx, mby, n, -1, -1);
        const top = this.intraNeighbour(mb, mbx, mby, n, 0, -1);
        const a = left < 0 ? 1024 : dc[left];
        const b = corner < 0 ? 1024 : dc[corner];
        const c = top < 0 ? 1024 : dc[top];
        const fromTop = Math.abs(a - b) < Math.abs(b - c);
        const predicted = (((fromTop ? c : a) + (scale >> 1)) / scale) | 0;
        const dcCoded = Number.isNaN(dcDiff);
        if (coded) {
            const scan = acPred ? (fromTop ? this.topScan : this.leftScan) : this.intraScan;
            if (this.seq.reversibleVlc)
                this.readReversibleCoefficients(block, dcCoded ? 0 : 1, scan, true, 0, 0);
            else this.readCoefficients(block, dcCoded ? 0 : 1, scan, INTRA_COEFFICIENTS, 0, 0);
        }
        const level = (dcCoded ? block[0] : dcDiff) + predicted;
        let stored = level * scale;
        if (stored & ~2047) stored = stored < 0 ? 0 : this.fix.unclippedDc ? stored : 2047;
        const index = this.blockIndex(mb, mbx, mby, n);
        dc[index] = stored;
        block[0] = level;
        const ac = this.ac;
        if (acPred) {
            const source = fromTop ? top : left;
            if (source >= 0) {
                const sameMacroblock = fromTop ? n === 2 || n === 3 : n === 1 || n === 3;
                const neighbourMb = sameMacroblock ? mb : fromTop ? mb - this.mbWidth : mb - 1;
                const neighbourQuant = this.mbQuant[neighbourMb];
                const rescale = !sameMacroblock && neighbourQuant !== this.qscale;
                const base = source * 16 + (fromTop ? 8 : 0);
                for (let k = 0; k < 7; k++) {
                    let value = ac[base + k];
                    if (rescale) value = roundedDivide(value * neighbourQuant, this.qscale);
                    block[fromTop ? k + 1 : (k + 1) * 8] += value;
                }
            }
        }
        const own = index * 16;
        for (let k = 0; k < 7; k++) {
            ac[own + k] = block[(k + 1) * 8];
            ac[own + 8 + k] = block[k + 1];
        }
        this.dequantizeIntra(block, scale, this.qscale);
    }

    private dequantizeIntra(block: Int32Array, dcScale: number, q: number): void {
        block[0] *= dcScale;
        if (this.seq.mpegQuant) {
            const matrix = this.seq.intraMatrix;
            for (let i = 1; i < 64; i++) {
                const v = block[i];
                if (v) block[i] = v > 0 ? (v * q * matrix[i]) >> 3 : -((-v * q * matrix[i]) >> 3);
            }
        } else {
            const qmul = q << 1;
            const qadd = (q - 1) | 1;
            for (let i = 1; i < 64; i++) {
                const v = block[i];
                if (v) block[i] = v > 0 ? v * qmul + qadd : v * qmul - qadd;
            }
        }
    }

    /**
     * Inter block `n`: TCOEF data dequantized with the H.263 or MPEG method including mismatch
     * control (7.4.4).
     */
    private decodeInterBlock(n: number): void {
        const block = this.block[n];
        const q = this.blockQuant(n);
        if (!this.seq.mpegQuant) {
            if (this.seq.reversibleVlc && this.vop.type !== VOP_B)
                this.readReversibleCoefficients(
                    block,
                    0,
                    this.interScan,
                    false,
                    q << 1,
                    (q - 1) | 1,
                );
            else this.readInterCoefficients(block, q);
            return;
        }
        if (this.seq.reversibleVlc && this.vop.type !== VOP_B)
            this.readReversibleCoefficients(block, 0, this.interScan, false, 0, 0);
        else this.readCoefficients(block, 0, this.interScan, INTER_COEFFICIENTS, 0, 0);
        const matrix = this.seq.interMatrix;
        let sum = 0;
        for (let i = 0; i < 64; i++) {
            const v = block[i];
            if (!v) continue;
            const value =
                v > 0 ? ((2 * v + 1) * matrix[i] * q) >> 4 : -(((1 - 2 * v) * matrix[i] * q) >> 4);
            block[i] = value;
            sum += value;
        }
        if ((sum & 1) === 0) block[63] ^= 1;
    }

    /**
     * H.263 inter coefficients with QP `q`. Under Annex S a run past the block end means the block
     * was coded with Table I.2, so it is read again from its start with that table.
     */
    private readInterCoefficients(block: Int32Array, q: number): void {
        const start = this.br.pos;
        try {
            this.readCoefficients(
                block,
                0,
                this.interScan,
                INTER_COEFFICIENTS,
                q << 1,
                (q - 1) | 1,
            );
        } catch (error) {
            if (error !== RUN_OVERFLOW || !this.vop.modes.alternativeInterVlc) throw error;
            this.br.pos = start;
            block.fill(0);
            this.readCoefficients(
                block,
                0,
                this.interScan,
                ADVANCED_INTRA_COEFFICIENTS,
                q << 1,
                (q - 1) | 1,
            );
        }
    }

    /** Reads the six blocks of an inter macroblock whose cbp bit 5 belongs to block 0. */
    private decodeInterBlocks(cbp: number): void {
        for (let n = 0; n < 6; n++) if (cbp & (32 >> n)) this.decodeInterBlock(n);
    }

    /**
     * MODB of a PB-frame macroblock (H.263 Annexes G and M): sets CBPB and returns how many B
     * vector pairs follow; intra macroblocks carry one more.
     */
    private readModb(intra: boolean): number {
        const br = this.br;
        this.pbCbp = 0;
        let vectors = 0;
        if (br.read1()) {
            let coded: number;
            if (this.vop.modes.pbFrames < 3) {
                coded = br.read1();
                vectors = 1;
            } else {
                let ones = 0;
                while (ones < 4 && br.read1()) ones++;
                coded = (ones + 1) & 1;
                vectors = (ones + 1) & 2 ? 1 : 0;
            }
            if (coded) this.pbCbp = br.read(6);
        }
        return intra ? vectors + 1 : vectors;
    }

    /**
     * Reads and discards the B vectors and then, after the P blocks, the B blocks of a PB-frame
     * macroblock.
     */
    private skipBVectors(pairs: number): void {
        for (let i = 0; i < pairs * 2; i++) this.readMv(0, 1);
    }

    private skipBBlocks(): void {
        for (let n = 0; n < 6; n++) {
            if (!(this.pbCbp & (32 >> n))) continue;
            this.discarded.fill(0);
            this.readInterCoefficients(this.discarded, this.qscale);
        }
    }

    private readDcDifferential(n: number): number {
        const br = this.br;
        const entry = (n < 4 ? DC_SIZE_LUMA : DC_SIZE_CHROMA)[br.peek(DC_SIZE_BITS)];
        if (!(entry & 31)) throw DAMAGED;
        br.skip(entry & 31);
        const size = entry >> 5;
        if (size === 0) return 0;
        const value = br.readDifferential(size);
        if (size > 8) br.skip(1);
        return value;
    }

    private readCbpy(inter: boolean): number {
        const br = this.br;
        const entry = CBPY[br.peek(CBPY_BITS)];
        if (!(entry & 31)) throw DAMAGED;
        br.skip(entry & 31);
        return inter ? (entry >> 5) ^ 15 : entry >> 5;
    }

    /** I-, P- or S-VOP macroblock in combined motion and texture coding (ISO/IEC 14496-2 6.2.6). */
    private decodeMacroblock(mb: number, mbx: number, mby: number): void {
        const br = this.br;
        const vop = this.vop;
        let mcbpc: number;
        if (vop.type === VOP_I) {
            do {
                const entry = INTRA_MCBPC[br.peek(INTRA_MCBPC_BITS)];
                if (!(entry & 31) || br.pos > br.end) throw DAMAGED;
                br.skip(entry & 31);
                mcbpc = entry >> 5;
            } while (mcbpc === MCBPC_INTRA_STUFFING);
            this.decodeIntraMacroblock(mb, mbx, mby, mcbpc & 3, (mcbpc & 4) !== 0);
            return;
        }
        for (;;) {
            if (br.read1()) {
                this.skipMacroblock(mb, mbx, mby);
                return;
            }
            const entry = INTER_MCBPC[br.peek(INTER_MCBPC_BITS)];
            if (!(entry & 31) || br.pos > br.end) throw DAMAGED;
            br.skip(entry & 31);
            mcbpc = entry >> 5;
            if (mcbpc !== MCBPC_INTER_STUFFING) break;
        }
        if (mcbpc & 4) {
            this.decodeIntraMacroblock(mb, mbx, mby, mcbpc & 3, (mcbpc & 8) !== 0);
            return;
        }
        const inter4v = (mcbpc & 16) !== 0;
        const modes = vop.modes;
        this.mcsel =
            !inter4v &&
            vop.type === VOP_S &&
            this.seq.spriteEnable === SPRITE_GMC &&
            br.read1() === 1;
        const bVectors = modes.pbFrames ? this.readModb(false) : 0;
        const cbp =
            (mcbpc & 3) | (this.readCbpy(!modes.alternativeInterVlc || (mcbpc & 3) !== 3) << 2);
        if (mcbpc & 8) this.readDquant();
        if (this.seq.interlaced && cbp) this.fieldDct = br.read1() === 1;
        const overlapped = modes.advancedPrediction && vop.type === VOP_P;

        // ffmpeg's decoder records a 16x16 vector only after reading ahead into the next
        // macroblock, which then sees what that preview (or nothing) left here.
        const held = overlapped && !inter4v ? this.blockVectors(mbx, mby) : undefined;
        this.readForwardMotion(
            mb,
            mbx,
            mby,
            inter4v,
            this.seq.interlaced && !inter4v && !this.mcsel && br.read1() === 1,
        );
        this.mbQuant[mb] = this.qscale;
        if (modes.pbFrames) this.skipBVectors(bVectors);
        this.decodeInterBlocks(cbp);
        if (modes.pbFrames) this.skipBBlocks();
        if (overlapped && mbx + 1 < this.mbWidth) {
            // A 16x16 vector is recorded after the preview, over whatever the preview left; four
            // vectors were recorded while read, and keep what the preview changes.
            const own = held && this.blockVectors(mbx, mby);
            if (held) this.setBlockVectors(mbx, mby, held);
            this.previewMotion(mb + 1);
            if (own) this.setBlockVectors(mbx, mby, own);
        }
        this.reconstructForward(mbx, mby);
        this.addResidual(mbx, mby, cbp);
    }

    /**
     * Decodes forward vectors of a P- or S-VOP inter macroblock and records them for prediction and
     * B-VOPs.
     */
    private readForwardMotion(
        mb: number,
        mbx: number,
        mby: number,
        inter4v: boolean,
        field: boolean,
    ): void {
        const br = this.br;
        const cur = this.cur;
        const mv = this.mvF;
        const fcode = this.vop.fcode;
        if (this.mcsel) {
            this.mvType = MV_16X16;
            mv[0] = this.averageMotion(0, mbx, mby);
            mv[1] = this.averageMotion(1, mbx, mby);
            cur.mbType[mb] = MB_GMC;
            this.storeMacroblockMv(mbx, mby, mv[0], mv[1]);
        } else if (inter4v) {
            this.mvType = MV_8X8;
            cur.mbType[mb] = MB_INTER4V;
            const grid = cur.mv;
            for (let i = 0; i < 4; i++) {
                this.predictMv(mbx, mby, i);
                this.readVector(mv, i * 2, fcode);
                const g = ((2 * mby + (i >> 1)) * this.blockGridWidth + 2 * mbx + (i & 1)) * 2;
                grid[g] = mv[i * 2];
                grid[g + 1] = mv[i * 2 + 1];
            }
        } else if (field) {
            this.mvType = MV_FIELD;
            cur.mbType[mb] = MB_FIELD;
            const select = this.fieldSelF;
            select[0] = br.read1();
            select[1] = br.read1();
            this.predictMv(mbx, mby, 0);
            for (let i = 0; i < 2; i++) {
                mv[i * 2] = this.readMv(this.predX, fcode);
                mv[i * 2 + 1] = this.readMv(Math.trunc(this.predY / 2), fcode);
            }
            const sx = mv[0] + mv[2];
            this.storeMacroblockMv(mbx, mby, (sx >> 1) | (sx & 1), mv[1] + mv[3]);
            cur.fieldMv.set(mv.subarray(0, 4), mb * 4);
            cur.fieldSelect[mb] = select[0] | (select[1] << 1);
        } else {
            this.mvType = MV_16X16;
            cur.mbType[mb] = 0;
            this.predictMv(mbx, mby, 0);
            this.readVector(mv, 0, fcode);
            this.storeMacroblockMv(mbx, mby, mv[0], mv[1]);
        }
    }

    /** One forward vector into `mv[at]`, `mv[at + 1]` from the prediction in predX and predY. */
    private readVector(mv: Int32Array, at: number, fcode: number): void {
        if (!this.vop.modes.unlimitedVectors) {
            mv[at] = this.readMv(this.predX, fcode);
            mv[at + 1] = this.readMv(this.predY, fcode);
            return;
        }
        mv[at] = this.readUnlimitedMv(this.predX);
        mv[at + 1] = this.readUnlimitedMv(this.predY);
        // A stuffing bit follows a difference of (1, 1), which would otherwise emulate a start
        // code.
        if (mv[at] - this.predX === 1 && mv[at + 1] - this.predY === 1) this.br.skip(1);
    }

    /** not_coded macroblock: zero motion copy, or global motion compensation in GMC S-VOPs. */
    private skipMacroblock(mb: number, mbx: number, mby: number): void {
        const gmc = this.vop.type === VOP_S && this.seq.spriteEnable === SPRITE_GMC;
        this.mcsel = gmc;
        this.mvType = MV_16X16;
        if (gmc) {
            this.mvF[0] = this.averageMotion(0, mbx, mby);
            this.mvF[1] = this.averageMotion(1, mbx, mby);
        } else {
            this.mvF[0] = this.mvF[1] = 0;
        }
        this.cur.mbType[mb] = gmc ? MB_GMC : MB_SKIPPED;
        this.storeMacroblockMv(mbx, mby, this.mvF[0], this.mvF[1]);
        this.mbQuant[mb] = this.qscale;
        this.reconstructForward(mbx, mby);
    }

    private decodeIntraMacroblock(
        mb: number,
        mbx: number,
        mby: number,
        cbpc: number,
        dquant: boolean,
    ): void {
        const br = this.br;
        const shortHeader = this.seq.shortHeader;
        const modes = this.vop.modes;
        const advanced = shortHeader && modes.advancedIntra;

        // INTRA_MODE of Annex I: '0' predicts the DC alone, '10' from the block above, '11' from
        // the block left.
        const acPred = (!shortHeader || advanced) && br.read1() === 1;
        const fromLeft = advanced && acPred && br.read1() === 1;
        const bVectors = modes.pbFrames && this.vop.type !== VOP_I ? this.readModb(true) : 0;
        const cbp = cbpc | (this.readCbpy(false) << 2);
        const useDcVlc = this.qscale < INTRA_DC_THRESHOLD[this.vop.intraDcThreshold];
        if (dquant) this.readDquant();
        if (this.seq.interlaced) this.fieldDct = br.read1() === 1;
        this.cur.mbType[mb] = MB_INTRA;
        this.mbQuant[mb] = this.qscale;
        this.storeMacroblockMv(mbx, mby, 0, 0);
        this.skipBVectors(bVectors);
        for (let n = 0; n < 6; n++) {
            const coded = (cbp & (32 >> n)) !== 0;
            if (advanced) this.decodeAdvancedIntraBlock(mb, mbx, mby, n, coded, acPred, fromLeft);
            else if (shortHeader) this.decodeShortHeaderIntraBlock(n, coded);
            else
                this.decodeIntraBlock(
                    mb,
                    mbx,
                    mby,
                    n,
                    coded,
                    useDcVlc ? this.readDcDifferential(n) : NaN,
                    acPred,
                );
        }
        if (bVectors) this.skipBBlocks();
        this.putIntra(mbx, mby);
    }

    /**
     * Macroblock of an H.263 B picture (Annex O) as ffmpeg decodes it: MBTYPE, then for coded
     * macroblocks CBPC and CBPY, DQUANT, and the forward or backward vectors, each predicted from
     * the vectors of that direction in the picture's earlier macroblocks (direct and intra
     * macroblocks count as zero). Direct mode scales the co-located vectors of the next picture by
     * TRB / TRD without a delta, always per 8x8 block (the chroma vector comes from their sum). B
     * pictures predict with rounding and without overlapped motion compensation.
     */
    private decodeH263BMacroblock(mb: number, mbx: number, mby: number): void {
        const br = this.br;
        const forward = this.cur.mv;
        const backward = this.backwardMv;
        this.storeMacroblockMv(mbx, mby, 0, 0);
        this.storeMacroblockMv(mbx, mby, 0, 0, backward);
        let type: number;
        do {
            const entry = B_MBTYPE[br.peek(B_MBTYPE_BITS)];
            if (!(entry & 31) || br.pos > br.end) throw DAMAGED;
            br.skip(entry & 31);
            type = entry >> 5;
        } while (type === B_MBTYPE_STUFFING);
        const coded = type > B_MBTYPE_STUFFING || type % 3 !== 0;

        // CBPC: '0', '10', '111' and '110' code 0 to 3.
        const cbpc = !coded || !br.read1() ? 0 : !br.read1() ? 1 : br.read1() ? 2 : 3;
        if (type > B_MBTYPE_STUFFING) {
            this.decodeIntraMacroblock(mb, mbx, mby, cbpc, type === B_MBTYPE_STUFFING + 2);
            return;
        }
        const cbp = coded
            ? cbpc | (this.readCbpy(!this.vop.modes.alternativeInterVlc || cbpc !== 3) << 2)
            : 0;
        if (type % 3 === 2) this.readDquant();
        this.cur.mbType[mb] = 0;
        this.mbQuant[mb] = this.qscale;
        this.mcsel = false;

        // 0 direct, 1 forward, 2 backward, 3 both.
        const prediction = (type / 3) | 0;
        if (prediction === 0) {
            this.setDirectMv(mb, 0, 0);
            this.mvType = MV_8X8;
        } else {
            this.mvType = MV_16X16;
            if (prediction & 1) {
                this.predictMv(mbx, mby, 0, forward);
                this.readVector(this.mvF, 0, 1);
                this.storeMacroblockMv(mbx, mby, this.mvF[0], this.mvF[1]);
            }
            if (prediction & 2) {
                this.predictMv(mbx, mby, 0, backward);
                this.readVector(this.mvB, 0, 1);
                this.storeMacroblockMv(mbx, mby, this.mvB[0], this.mvB[1], backward);
            }
        }
        this.decodeInterBlocks(cbp);
        if (prediction !== 2) this.motion(this.fwd!, this.mvF, this.fieldSelF, PUT, mbx, mby);
        if (prediction !== 1)
            this.motion(
                this.bwd!,
                this.mvB,
                this.fieldSelB,
                prediction === 2 ? PUT : AVG,
                mbx,
                mby,
            );
        this.addResidual(mbx, mby, cbp);
    }

    /**
     * B-VOP macroblock (ISO/IEC 14496-2 6.2.6 and 7.6.9): modb, mb_type, dbquant, vectors and
     * direct mode.
     */
    private decodeBMacroblock(mb: number, mbx: number, mby: number): void {
        const br = this.br;
        const vop = this.vop;
        const bwd = this.bwd!;
        this.mcsel = false;
        this.mvType = MV_16X16;
        if (this.bwdNotCoded || bwd.mbType[mb] & MB_SKIPPED) {
            this.mvF[0] = this.mvF[1] = 0;
            this.motion(this.fwd!, this.mvF, this.fieldSelF, PUT, mbx, mby);
            return;
        }
        let type = B_DIRECT;
        let cbp = 0;
        let delta = false;
        if (!br.read1()) {
            const modb2 = br.read1();
            let zeros = 0;
            while (zeros < 3 && br.read1() === 0) zeros++;
            if (zeros === 3 && br.read1() === 0) throw DAMAGED;
            type = zeros;
            if (!modb2) cbp = br.read(6);
            if (type !== B_DIRECT && cbp && br.read1())
                this.setupQuant(this.qscale + (br.read1() ? 2 : -2));
            let field = false;
            if (this.seq.interlaced) {
                if (cbp) this.fieldDct = br.read1() === 1;
                if (type !== B_DIRECT && br.read1()) {
                    field = true;
                    if (type !== B_BACKWARD) {
                        this.fieldSelF[0] = br.read1();
                        this.fieldSelF[1] = br.read1();
                    }
                    if (type !== B_FORWARD) {
                        this.fieldSelB[0] = br.read1();
                        this.fieldSelB[1] = br.read1();
                    }
                }
            }
            if (field) this.mvType = MV_FIELD;
            if (type !== B_DIRECT && type !== B_BACKWARD)
                this.readBVectors(this.mvF, 0, vop.fcode, field);
            if (type !== B_DIRECT && type !== B_FORWARD)
                this.readBVectors(this.mvB, 4, vop.bcode, field);
            delta = type === B_DIRECT;
        }
        if (type === B_DIRECT) {
            const dx = delta ? this.readMv(0, 1) : 0;
            const dy = delta ? this.readMv(0, 1) : 0;
            this.setDirectMv(mb, dx, dy);
        }
        this.decodeInterBlocks(cbp);
        if (type !== B_BACKWARD) this.motion(this.fwd!, this.mvF, this.fieldSelF, PUT, mbx, mby);
        if (type !== B_FORWARD)
            this.motion(bwd, this.mvB, this.fieldSelB, type === B_BACKWARD ? PUT : AVG, mbx, mby);
        this.addResidual(mbx, mby, cbp);
    }

    /**
     * Forward or backward B-VOP vectors predicted from the previous vectors of the macroblock row
     * (7.6.9).
     */
    private readBVectors(mv: Int32Array, lastBase: number, fcode: number, field: boolean): void {
        const last = this.lastMv;
        if (!field) {
            mv[0] = this.readMv(last[lastBase], fcode);
            mv[1] = this.readMv(last[lastBase + 1], fcode);
            last[lastBase] = last[lastBase + 2] = mv[0];
            last[lastBase + 1] = last[lastBase + 3] = mv[1];
            return;
        }
        for (let i = 0; i < 2; i++) {
            const x = this.readMv(last[lastBase + i * 2], fcode);
            const y = this.readMv(Math.trunc(last[lastBase + i * 2 + 1] / 2), fcode);
            mv[i * 2] = x;
            mv[i * 2 + 1] = y;
            last[lastBase + i * 2] = x;
            last[lastBase + i * 2 + 1] = y * 2;
        }
    }

    /**
     * Direct mode vectors scaled from the co-located macroblock of the future reference by TRB /
     * TRD plus the delta (ISO/IEC 14496-2 7.6.9.5), per 8x8 block, per field for field-predicted
     * co-located macroblocks.
     */
    private setDirectMv(mb: number, dx: number, dy: number): void {
        const bwd = this.bwd!;
        const vop = this.vop;
        const colocated = bwd.mbType[mb];
        const mvF = this.mvF;
        const mvB = this.mvB;
        if (colocated & MB_FIELD) {
            this.mvType = MV_FIELD;
            for (let i = 0; i < 2; i++) {
                const select = (bwd.fieldSelect[mb] >> i) & 1;
                this.fieldSelF[i] = select;
                this.fieldSelB[i] = i;
                const pp =
                    (vop.topFieldFirst
                        ? vop.ppFieldTime - select + i
                        : vop.ppFieldTime + select - i) & 0xffff;
                const pb =
                    (vop.topFieldFirst
                        ? vop.pbFieldTime - select + i
                        : vop.pbFieldTime + select - i) & 0xffff;
                const px = bwd.fieldMv[mb * 4 + i * 2];
                const py = bwd.fieldMv[mb * 4 + i * 2 + 1];
                mvF[i * 2] = Math.trunc((px * pb) / pp) + dx;
                mvF[i * 2 + 1] = Math.trunc((py * pb) / pp) + dy;
                mvB[i * 2] = dx ? mvF[i * 2] - px : Math.trunc((px * (pb - pp)) / pp);
                mvB[i * 2 + 1] = dy ? mvF[i * 2 + 1] - py : Math.trunc((py * (pb - pp)) / pp);
            }
            return;
        }
        const pp = vop.ppTime;
        const pb = vop.pbTime;
        const mbx = mb % this.mbWidth;
        const mby = (mb - mbx) / this.mbWidth;
        const blocks = colocated & MB_INTER4V ? 4 : 1;
        for (let i = 0; i < blocks; i++) {
            const g = ((2 * mby + (i >> 1)) * this.blockGridWidth + 2 * mbx + (i & 1)) * 2;
            const px = bwd.mv[g];
            const py = bwd.mv[g + 1];
            mvF[i * 2] = Math.trunc((px * pb) / pp) + dx;
            mvF[i * 2 + 1] = Math.trunc((py * pb) / pp) + dy;
            mvB[i * 2] = dx ? mvF[i * 2] - px : Math.trunc((px * (pb - pp)) / pp);
            mvB[i * 2 + 1] = dy ? mvF[i * 2 + 1] - py : Math.trunc((py * (pb - pp)) / pp);
        }
        if (blocks === 4) {
            this.mvType = MV_8X8;
            return;
        }
        for (let i = 2; i < 8; i++) {
            mvF[i] = mvF[i & 1];
            mvB[i] = mvB[i & 1];
        }
        this.mvType = this.seq.quarterSample ? MV_8X8 : MV_16X16;
    }

    /**
     * One video packet with data partitioning (ISO/IEC 14496-2 6.2.6.1): headers and DC or motion
     * data up to the DC or motion marker, then cbpy/ac_pred/dquant, then texture. Returns the first
     * macroblock of the next packet.
     */
    private decodePartitionedPacket(start: number): number {
        const br = this.br;
        const vop = this.vop;
        const cur = this.cur;
        const flags = this.partFlags;
        const intraVop = vop.type === VOP_I;
        const gmc = vop.type === VOP_S && this.seq.spriteEnable === SPRITE_GMC;
        const threshold = INTRA_DC_THRESHOLD[vop.intraDcThreshold];
        const packetQuant = this.qscale;
        let end = start;
        for (;;) {
            if (intraVop ? br.peek(19) === DC_MARKER : br.peek(17) === MOTION_MARKER) break;
            if (end >= this.mbCount || br.pos > br.end) throw DAMAGED;
            const mb = end;
            const mbx = mb % this.mbWidth;
            const mby = (mb - mbx) / this.mbWidth;
            if (intraVop) {
                const entry = INTRA_MCBPC[br.peek(INTRA_MCBPC_BITS)];
                if (!(entry & 31)) throw DAMAGED;
                br.skip(entry & 31);
                const mcbpc = entry >> 5;
                if (mcbpc === MCBPC_INTRA_STUFFING) continue;
                let f = PART_INTRA;
                if (this.qscale < threshold) f |= PART_DC_VLC;
                if (mcbpc & 4) this.setupQuant(this.qscale + DQUANT[br.read(2)]);
                this.partCbp[mb] = mcbpc & 3;
                cur.mbType[mb] = MB_INTRA;
                this.mbQuant[mb] = this.qscale;
                this.storeMacroblockMv(mbx, mby, 0, 0);
                if (f & PART_DC_VLC)
                    for (let n = 0; n < 6; n++)
                        this.partDc[mb * 6 + n] = this.readDcDifferential(n);
                flags[mb] = f;
                end++;
                continue;
            }
            if (br.read1()) {
                flags[mb] = PART_SKIPPED | (gmc ? PART_MCSEL : 0);
                const x = gmc ? this.averageMotion(0, mbx, mby) : 0;
                const y = gmc ? this.averageMotion(1, mbx, mby) : 0;
                cur.mbType[mb] = gmc ? MB_GMC : MB_SKIPPED;
                this.storeMacroblockMv(mbx, mby, x, y);
                end++;
                continue;
            }
            const entry = INTER_MCBPC[br.peek(INTER_MCBPC_BITS)];
            if (!(entry & 31)) throw DAMAGED;
            br.skip(entry & 31);
            const mcbpc = entry >> 5;
            if (mcbpc === MCBPC_INTER_STUFFING) continue;
            this.partCbp[mb] = mcbpc & 3;
            let f = mcbpc & 8 ? PART_DQUANT : 0;
            if (mcbpc & 4) {
                flags[mb] = f | PART_INTRA;
                cur.mbType[mb] = MB_INTRA;
                this.storeMacroblockMv(mbx, mby, 0, 0);
                end++;
                continue;
            }
            const inter4v = (mcbpc & 16) !== 0;
            this.mcsel = !inter4v && gmc && br.read1() === 1;
            if (this.mcsel) f |= PART_MCSEL;
            if (inter4v) f |= PART_INTER4V;
            this.readForwardMotion(mb, mbx, mby, inter4v, false);
            flags[mb] = f;
            end++;
        }
        if (end === start) throw DAMAGED;
        br.skip(intraVop ? 19 : 17);
        this.qscale = packetQuant;
        for (let mb = start; mb < end; mb++) {
            const f = flags[mb];
            if (intraVop) {
                if (br.read1()) flags[mb] |= PART_AC_PRED;
                this.partCbp[mb] |= this.readCbpy(false) << 2;
                continue;
            }
            if (f & PART_SKIPPED) {
                this.mbQuant[mb] = this.qscale;
                continue;
            }
            if (f & PART_INTRA) {
                if (br.read1()) flags[mb] |= PART_AC_PRED;
                this.partCbp[mb] |= this.readCbpy(false) << 2;
                if (this.qscale < threshold) flags[mb] |= PART_DC_VLC;
                if (f & PART_DQUANT) this.setupQuant(this.qscale + DQUANT[br.read(2)]);
                this.mbQuant[mb] = this.qscale;
                if (flags[mb] & PART_DC_VLC)
                    for (let n = 0; n < 6; n++)
                        this.partDc[mb * 6 + n] = this.readDcDifferential(n);
                continue;
            }
            this.partCbp[mb] |= this.readCbpy(true) << 2;
            if (f & PART_DQUANT) this.setupQuant(this.qscale + DQUANT[br.read(2)]);
            this.mbQuant[mb] = this.qscale;
        }
        if (br.pos > br.end) throw DAMAGED;
        for (let mb = start; mb < end; mb++) {
            const mbx = mb % this.mbWidth;
            const mby = (mb - mbx) / this.mbWidth;
            const f = flags[mb];
            const cbp = this.partCbp[mb];
            this.qscale = this.mbQuant[mb];
            if (f & PART_INTRA) {
                for (let n = 0; n < 6; n++) {
                    const dcDiff = f & PART_DC_VLC ? this.partDc[mb * 6 + n] : NaN;
                    this.decodeIntraBlock(
                        mb,
                        mbx,
                        mby,
                        n,
                        (cbp & (32 >> n)) !== 0,
                        dcDiff,
                        (f & PART_AC_PRED) !== 0,
                    );
                }
                this.putIntra(mbx, mby);
                continue;
            }
            this.mcsel = (f & PART_MCSEL) !== 0;
            this.loadForwardMotion(mbx, mby, (f & PART_INTER4V) !== 0);
            if (!(f & PART_SKIPPED)) this.decodeInterBlocks(cbp);
            this.reconstructForward(mbx, mby);
            if (!(f & PART_SKIPPED)) this.addResidual(mbx, mby, cbp);
        }
        if (br.pos > br.end) throw DAMAGED;
        if (end < this.mbCount && this.resyncAhead()) {
            const next = this.nextVideoPacket();
            if (next < end) throw DAMAGED;
            if (next > end) this.concealRange(end, next);
            return next;
        }
        return end;
    }

    /** Restores the forward vectors of a partitioned macroblock from the picture's vector grid. */
    private loadForwardMotion(mbx: number, mby: number, inter4v: boolean): void {
        const grid = this.cur.mv;
        const mv = this.mvF;
        for (let i = 0; i < 4; i++) {
            const g = ((2 * mby + (i >> 1)) * this.blockGridWidth + 2 * mbx + (i & 1)) * 2;
            mv[i * 2] = grid[g];
            mv[i * 2 + 1] = grid[g + 1];
        }
        this.mvType = inter4v ? MV_8X8 : MV_16X16;
    }

    /**
     * Intra block of a short header picture: 8-bit DC with dc_scaler 8 and H.263 AC levels (6.2.7).
     */
    private decodeShortHeaderIntraBlock(n: number, coded: boolean): void {
        const block = this.block[n];
        let level = this.br.read(8);
        if (level === 255) level = 128;
        block[0] = level;
        if (coded) this.readCoefficients(block, 1, ZIGZAG_8X8, INTER_COEFFICIENTS, 0, 0);
        this.dequantizeIntra(block, 8, this.blockQuant(n));
    }

    /**
     * Intra block in H.263 Annex I advanced INTRA coding: every coefficient from Table I.2 in the
     * scan of its prediction, the DC predicted from the left and upper blocks (or the one AC
     * prediction uses) and reconstructed odd, the AC levels of the predicting block's first column
     * or row added, then 2 * QP without a rounding offset.
     */
    private decodeAdvancedIntraBlock(
        mb: number,
        mbx: number,
        mby: number,
        n: number,
        coded: boolean,
        acPred: boolean,
        fromLeft: boolean,
    ): void {
        const block = this.block[n];
        const scan = acPred ? (fromLeft ? this.leftScan : this.topScan) : ZIGZAG_8X8;
        if (coded) this.readCoefficients(block, 0, scan, ADVANCED_INTRA_COEFFICIENTS, 0, 0);
        const left = this.intraNeighbour(mb, mbx, mby, n, -1, 0);
        const top = this.intraNeighbour(mb, mbx, mby, n, 0, -1);
        const dc = this.dc;
        const ac = this.ac;
        let predicted = 1024;
        if (acPred) {
            const source = fromLeft ? left : top;
            if (source >= 0) {
                const base = source * 16 + (fromLeft ? 0 : 8);
                for (let k = 0; k < 7; k++) block[fromLeft ? (k + 1) * 8 : k + 1] += ac[base + k];
                predicted = dc[source];
            }
        } else if (left >= 0 && top >= 0) predicted = (dc[left] + dc[top]) >> 1;
        else if (left >= 0) predicted = dc[left];
        else if (top >= 0) predicted = dc[top];
        const q = this.blockQuant(n);
        let value = block[0] * 2 * q + predicted;
        value = value < 0 ? 0 : value | 1;
        const index = this.blockIndex(mb, mbx, mby, n);
        dc[index] = value;
        const own = index * 16;
        for (let k = 0; k < 7; k++) {
            ac[own + k] = block[(k + 1) * 8];
            ac[own + 8 + k] = block[k + 1];
        }
        block[0] = value;
        const qmul = q << 1;
        for (let i = 1; i < 64; i++) if (block[i]) block[i] *= qmul;
    }

    /**
     * One vector component of H.263 Annex D in a PLUSPTYPE picture: a reversible code for the
     * difference.
     */
    private readUnlimitedMv(pred: number): number {
        const br = this.br;
        if (br.read1()) return pred;
        let code = 2 + br.read1();
        while (br.read1()) {
            code = (code << 1) + br.read1();
            if (code >= 32768 || br.pos > br.end) throw DAMAGED;
        }
        return code & 1 ? pred - (code >> 1) : pred + (code >> 1);
    }

    /**
     * Macroblocks of a short header picture in groups of blocks (ISO/IEC 14496-2 6.2.7): a GOB
     * header starts a new prediction segment; a damaged segment is concealed up to the next GOB
     * header found after its start.
     */
    private decodeShortHeaderPicture(): number {
        const br = this.br;
        const modes = this.vop.modes;
        const rowsPerGob = this.height <= 400 ? 1 : this.height <= 800 ? 2 : 4;
        const mbsPerGob = modes.slices ? 1 : rowsPerGob * this.mbWidth;
        let concealed = 0;
        let mb = 0;
        if (modes.deblocking) this.filterQuant.fill(0);
        if (modes.advancedPrediction) {
            // Overlapped motion compensation reads neighbours not yet decoded: as in ffmpeg, whose
            // tables start zeroed each picture, they read as zero vectors of inter macroblocks.
            this.cur.mv.fill(0);
            this.cur.mbType.fill(0);
        }
        if (modes.slices) {
            // The first slice's address follows the picture header between two marker bits (Annex
            // K.2).
            const first = br.read1() ? br.read(mbaLength(this.mbCount)) : -1;
            mb = br.read1() && first >= 0 && first < this.mbCount ? first : this.mbCount;
            this.concealRange(0, mb);
            concealed = mb;
        }
        this.packetStart = mb;
        while (mb < this.mbCount) {
            const start = mb;
            const segmentBit = br.pos;
            try {
                mb = this.decodeGobSegment(start, mbsPerGob);
            } catch (error) {
                if (!(error instanceof DamagedData)) throw error;
                for (const block of this.block) block.fill(0);
                let next = this.mbCount;
                const data = br.data;
                for (
                    let position = ((segmentBit + 7) & ~7) + 8;
                    position + 32 <= br.end;
                    position += 8
                ) {
                    if (data[position >>> 3] !== 0 || data[(position >>> 3) + 1] !== 0) continue;
                    br.pos = position;
                    if (!this.gobHeaderAhead()) continue;
                    try {
                        const candidate = this.readGobHeader(mbsPerGob);
                        if (candidate > start) {
                            next = candidate;
                            break;
                        }
                    } catch (inner) {
                        if (!(inner instanceof DamagedData)) throw inner;
                    }
                }
                this.concealRange(start, next);
                concealed += next - start;
                mb = next;
            }
            this.packetStart = mb;
        }
        return concealed;
    }

    /**
     * Decodes macroblocks from `start` until the next GOB header; returns the macroblock that
     * header starts.
     */
    private decodeGobSegment(start: number, mbsPerGob: number): number {
        const br = this.br;
        const deblocking = this.vop.modes.deblocking;
        for (let mb = start; mb < this.mbCount;) {
            const mbx = mb % this.mbWidth;
            const mby = (mb - mbx) / this.mbWidth;
            if (this.vop.type === VOP_B) this.decodeH263BMacroblock(mb, mbx, mby);
            else this.decodeMacroblock(mb, mbx, mby);
            if (br.pos > br.end) throw DAMAGED;
            if (deblocking) this.deblock(mb, mbx, mby);
            mb++;
            if (mb < this.mbCount && mb % mbsPerGob === 0 && this.gobHeaderAhead()) {
                const next = this.readGobHeader(mbsPerGob);
                if (next < mb) throw DAMAGED;
                if (next > mb) this.concealRange(mb, next);
                return next;
            }
        }
        return this.mbCount;
    }

    /** True at a gob_resync_marker, optionally preceded by zero stuffing to the byte boundary. */
    private gobHeaderAhead(): boolean {
        const br = this.br;
        if (br.peek(17) === 1) return true;
        const stuffing = (8 - (br.pos & 7)) & 7;
        if (stuffing && br.peek(stuffing) === 0) {
            br.skip(stuffing);
            if (br.peek(17) === 1) return true;
            br.pos -= stuffing;
        }
        return false;
    }

    /** Annex J filtering of a macroblock just reconstructed. */
    private deblock(mb: number, mbx: number, mby: number): void {
        this.filterQuant[mb] = this.cur.mbType[mb] & MB_SKIPPED ? 0 : this.mbQuant[mb];
        const chroma = this.vop.modes.modifiedQuant ? CHROMA_QUANT : undefined;
        deblockMacroblock(this, this.cur.data, this.filterQuant, mbx, mby, chroma);
    }

    /**
     * Reads gob_resync_marker, gob_number, gob_frame_id and quant_scale, or an Annex K slice header
     * with its macroblock address; returns the first macroblock it starts.
     */
    private readGobHeader(mbsPerGob: number): number {
        const br = this.br;
        br.skip(17);
        if (this.vop.modes.slices) {
            if (!br.read1()) throw DAMAGED;
            const address = br.read(mbaLength(this.mbCount));
            if (this.mbCount > 1583 && !br.read1()) throw DAMAGED;
            const sliceQuant = br.read(5);
            if (!br.read1() || !sliceQuant || address >= this.mbCount) throw DAMAGED;
            br.skip(2);
            this.qscale = sliceQuant;
            return address;
        }
        const number = br.read(5);
        br.skip(2);
        const quant = br.read(5);
        if (quant === 0 || number === 0 || number * mbsPerGob >= this.mbCount) throw DAMAGED;
        this.qscale = quant;
        return number * mbsPerGob;
    }

    private putIntra(mbx: number, mby: number): void {
        for (let n = 0; n < 6; n++) this.writeBlock(n, mbx, mby, false);
    }

    private addResidual(mbx: number, mby: number, cbp: number): void {
        for (let n = 0; n < 6; n++) if (cbp & (32 >> n)) this.writeBlock(n, mbx, mby, true);
    }

    /**
     * Inverse transform of block `n` put into or added to the current picture, with field DCT line
     * order.
     */
    private writeBlock(n: number, mbx: number, mby: number, add: boolean): void {
        const block = this.block[n];
        this.idct(block);
        const data = this.cur.data;
        let offset: number;
        let stride: number;
        if (n < 4) {
            const field = this.fieldDct && this.seq.interlaced;
            stride = field ? this.lumaStride * 2 : this.lumaStride;
            const row = mby * 16 + (field ? n >> 1 : (n >> 1) * 8);
            offset = row * this.lumaStride + mbx * 16 + (n & 1) * 8;
        } else {
            stride = this.chromaStride;
            offset =
                (n === 4 ? this.chromaBase : this.crBase) + mby * 8 * this.chromaStride + mbx * 8;
        }
        for (let y = 0; y < 8; y++) {
            const o = offset + y * stride;
            const k = y * 8;
            for (let x = 0; x < 8; x++) {
                const v = add ? data[o + x] + block[k + x] : block[k + x];
                data[o + x] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
        }
        block.fill(0);
    }

    /** Forward prediction of a P- or S-VOP macroblock with the VOP's rounding type. */
    private reconstructForward(mbx: number, mby: number): void {
        const ref = this.fwd;
        if (!ref) return;
        const mode = this.vop.rounding ? PUT_NO_RND : PUT;
        if (this.vop.modes.advancedPrediction && this.vop.type === VOP_P)
            this.overlappedMotion(ref, mode, mbx, mby);
        else this.motion(ref, this.mvF, this.fieldSelF, mode, mbx, mby);
    }

    /**
     * A copy of the vectors of a macroblock's four luma blocks: the top pair's x and y, then the
     * bottom pair's.
     */
    private blockVectors(mbx: number, mby: number): Int16Array {
        const at = (2 * mby * this.blockGridWidth + 2 * mbx) * 2;
        const below = at + this.blockGridWidth * 2;
        const vectors = new Int16Array(8);
        vectors.set(this.cur.mv.subarray(at, at + 4));
        vectors.set(this.cur.mv.subarray(below, below + 4), 4);
        return vectors;
    }

    private setBlockVectors(mbx: number, mby: number, vectors: Int16Array): void {
        const at = (2 * mby * this.blockGridWidth + 2 * mbx) * 2;
        this.cur.mv.set(vectors.subarray(0, 4), at);
        this.cur.mv.set(vectors.subarray(4), at + this.blockGridWidth * 2);
    }

    /**
     * Reads ahead the type and vectors of the next macroblock, which overlapped motion compensation
     * of this one needs, as ffmpeg's decoder does (only after a coded inter macroblock); the read
     * position then goes back.
     */
    private previewMotion(next: number): void {
        const br = this.br;
        const cur = this.cur;
        const position = br.pos;
        const mbx = next % this.mbWidth;
        const mby = (next - mbx) / this.mbWidth;
        try {
            let mcbpc: number;
            for (;;) {
                if (br.read1()) {
                    cur.mbType[next] = MB_SKIPPED;
                    this.storeMacroblockMv(mbx, mby, 0, 0);
                    return;
                }
                const entry = INTER_MCBPC[br.peek(INTER_MCBPC_BITS)];

                // An invalid code (the start code of the next slice) reads as an intra macroblock,
                // as in ffmpeg.
                mcbpc = entry & 31 ? entry >> 5 : 4;
                br.skip(entry & 31);
                if (mcbpc !== MCBPC_INTER_STUFFING) break;
            }
            if (mcbpc & 4) {
                cur.mbType[next] = MB_INTRA;
                return;
            }
            this.readCbpy(true);
            if (mcbpc & 8) br.skip(this.vop.modes.modifiedQuant ? (br.read1() ? 1 : 5) : 2);
            const mv = this.mvB;

            // ffmpeg predicts the previewed vectors with the slice state of this macroblock: one
            // row below a slice's first macroblock, the next still counts as on the slice's first
            // row, where the left neighbour (and the row above) is outside the slice.
            const firstRow = next === this.packetStart + this.mbWidth;
            const predict = (block: number): void => {
                if (!firstRow || block === 3) this.predictMv(mbx, mby, block);
                else if (block === 0) this.predX = this.predY = 0;
                else if (block === 1) {
                    this.predX = mv[0];
                    this.predY = mv[1];
                } else {
                    // ffmpeg also clears the left neighbour's lower right vector, which that
                    // macroblock then keeps.
                    if (mbx > 0)
                        cur.mv.fill(
                            0,
                            ((2 * mby + 1) * this.blockGridWidth + 2 * mbx - 1) * 2,
                            ((2 * mby + 1) * this.blockGridWidth + 2 * mbx) * 2,
                        );
                    this.predX = median(0, mv[0], mv[2]);
                    this.predY = median(0, mv[1], mv[3]);
                }
            };
            if (mcbpc & 16) {
                cur.mbType[next] = MB_INTER4V;
                for (let i = 0; i < 4; i++) {
                    predict(i);
                    this.readVector(mv, i * 2, 1);
                    const g = ((2 * mby + (i >> 1)) * this.blockGridWidth + 2 * mbx + (i & 1)) * 2;
                    cur.mv[g] = mv[i * 2];
                    cur.mv[g + 1] = mv[i * 2 + 1];
                }
            } else {
                cur.mbType[next] = 0;
                predict(0);
                this.readVector(mv, 0, 1);
                this.storeMacroblockMv(mbx, mby, mv[0], mv[1]);
            }
        } catch (error) {
            if (!(error instanceof DamagedData)) throw error;
        } finally {
            br.pos = position;
        }
    }

    /**
     * Annex F overlapped motion compensation of a P picture macroblock, as ffmpeg's decoder applies
     * it: each 8x8 luma block blends the predictions of its own vector and those of the blocks
     * above, left, right and below (its macroblock's own where a neighbour is outside the picture
     * or intra), and chroma follows the four vectors.
     */
    private overlappedMotion(ref: Picture, mode: number, mbx: number, mby: number): void {
        const cur = this.cur;
        const grid = cur.mv;
        const width = this.blockGridWidth;
        const mb = mby * this.mbWidth + mbx;
        const above = mby > 0 && !(cur.mbType[mb - this.mbWidth] & MB_INTRA);
        const left = mbx > 0 && !(cur.mbType[mb - 1] & MB_INTRA);
        const right = mbx + 1 < this.mbWidth && !(cur.mbType[mb + 1] & MB_INTRA);
        const predictions = this.overlapped;
        const at = (x: number, y: number): number => ((2 * mby + y) * width + 2 * mbx + x) * 2;
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < 4; i++) {
            const x = i & 1;
            const y = i >> 1;
            const own = at(x, y);
            const sources = [
                own,
                y || !above ? at(x, 0) : at(x, -1),
                x || !left ? at(0, y) : at(-1, y),
                !x || !right ? at(1, y) : at(2, y),
                at(x, 1),
            ];
            const px = mbx * 16 + x * 8;
            const py = mby * 16 + y * 8;
            for (let k = 0; k < 5; k++) {
                const source = sources[k]!;
                if (k && grid[source] === grid[own] && grid[source + 1] === grid[own + 1])
                    predictions.copyWithin(k * 64, 0, 64);
                else
                    this.halfSampleBlock(
                        ref,
                        predictions,
                        k * 64,
                        8,
                        px,
                        py,
                        grid[source],
                        grid[source + 1],
                        mode,
                    );
            }
            blendOverlapped(predictions, cur.data, py * this.lumaStride + px, this.lumaStride);
            sumX += grid[own];
            sumY += grid[own + 1];
        }
        this.chromaFourVectors(ref, sumX, sumY, mode, mbx, mby);
    }

    /**
     * The 8x8 half-sample prediction of the luma block at (`px`, `py`) with vector (`mx`, `my`)
     * into `out`.
     */
    private halfSampleBlock(
        ref: Picture,
        out: Uint8Array,
        outAt: number,
        outStride: number,
        px: number,
        py: number,
        mx: number,
        my: number,
        mode: number,
    ): void {
        let sx = px + (mx >> 1);
        let sy = py + (my >> 1);
        let fx = mx & 1;
        let fy = my & 1;
        sx = sx < -16 ? -16 : sx > this.width ? this.width : sx;
        if (sx === this.width) fx = 0;
        sy = sy < -16 ? -16 : sy > this.height ? this.height : sy;
        if (sy === this.height) fy = 0;
        const mc = this.mc;
        mc.fetch(ref.data, 0, this.lumaStride, this.edgeWidth, this.edgeHeight, sx, sy, 9, 9, 1);
        mc.halfSample(
            out,
            outAt,
            outStride,
            mc.src,
            mc.srcOff,
            mc.srcStride,
            8,
            8,
            fx | (fy << 1),
            mode,
        );
    }

    /** Motion compensation of the current macroblock from `ref` with vectors `mv` (7.6.2). */
    private motion(
        ref: Picture,
        mv: Int32Array,
        fieldSelect: Uint8Array,
        mode: number,
        mbx: number,
        mby: number,
    ): void {
        if (this.mcsel) {
            this.globalMotion(ref, mbx, mby);
            return;
        }
        if (this.mvType === MV_8X8) {
            this.blockMotion(ref, mv, mode, mbx, mby);
            return;
        }
        if (this.mvType === MV_FIELD) {
            for (let field = 0; field < 2; field++) {
                if (this.seq.quarterSample)
                    this.quarterMotion(
                        ref,
                        mv[field * 2],
                        mv[field * 2 + 1],
                        mode,
                        mbx,
                        mby,
                        field,
                        fieldSelect[field],
                    );
                else
                    this.halfMotion(
                        ref,
                        mv[field * 2],
                        mv[field * 2 + 1],
                        mode,
                        mbx,
                        mby,
                        field,
                        fieldSelect[field],
                    );
            }
            return;
        }
        if (this.seq.quarterSample) this.quarterMotion(ref, mv[0], mv[1], mode, mbx, mby, -1, 0);
        else this.halfMotion(ref, mv[0], mv[1], mode, mbx, mby, -1, 0);
    }

    /**
     * Chroma prediction of one 8 x `rows` block per chroma plane from integer position (x, y) in
     * frame or field `select` lines. `lumaEmulated` reproduces the interlaced edge defect of some
     * libavcodec encoders.
     */
    private chromaMotion(
        ref: Picture,
        x: number,
        y: number,
        dxy: number,
        rows: number,
        mode: number,
        mbx: number,
        mby: number,
        field: number,
        select: number,
        lumaEmulated: boolean,
    ): void {
        const mc = this.mc;
        const cs = this.chromaStride;
        const ew = this.edgeWidth >> 1;
        const eh = this.edgeHeight >> 1;
        const step = field < 0 ? 1 : 2;
        const top = field < 0 ? y : 2 * y + select;
        const patch = lumaEmulated && field >= 0 && select === 1 && this.fix.interlacedEdge;
        for (let plane = 0; plane < 2; plane++) {
            const base = plane ? this.crBase : this.chromaBase;
            mc.fetch(ref.data, base, cs, ew, eh, x, top, 9, rows + 1, step, patch && plane === 0);
            if (patch && plane === 0)
                mc.copyRow(rows, ref.data, this.crBase, cs, ew, eh, x, 2 * y, 9);
            const dst = base + (mby * 8 + (field < 0 ? 0 : field)) * cs + mbx * 8;
            mc.halfSample(
                this.cur.data,
                dst,
                cs * step,
                mc.src,
                mc.srcOff,
                mc.srcStride,
                8,
                rows,
                dxy,
                mode,
            );
        }
    }

    /**
     * Half-sample frame (field < 0) or field prediction of the whole macroblock width (7.6.2.1).
     */
    private halfMotion(
        ref: Picture,
        mx: number,
        my: number,
        mode: number,
        mbx: number,
        mby: number,
        field: number,
        select: number,
    ): void {
        const mc = this.mc;
        const ls = this.lumaStride;
        const dxy = ((my & 1) << 1) | (mx & 1);
        const sx = mbx * 16 + (mx >> 1);
        const rows = field < 0 ? 16 : 8;
        const sy = (field < 0 ? mby * 16 : mby * 8) + (my >> 1);
        const step = field < 0 ? 1 : 2;
        mc.fetch(
            ref.data,
            0,
            ls,
            this.edgeWidth,
            this.edgeHeight,
            sx,
            field < 0 ? sy : 2 * sy + select,
            17,
            rows + 1,
            step,
        );
        const dst = (mby * 16 + (field < 0 ? 0 : field)) * ls + mbx * 16;
        mc.halfSample(
            this.cur.data,
            dst,
            ls * step,
            mc.src,
            mc.srcOff,
            mc.srcStride,
            16,
            rows,
            dxy,
            mode,
        );
        let cx: number;
        let cy: number;
        let cdxy: number;
        if (field >= 0 && this.fix.fieldChromaRounding) {
            const hx = (mx >> 1) | (mx & 1);
            const hy = my >> 1;
            cdxy = ((hy & 1) << 1) | (hx & 1);
            cx = mbx * 8 + (hx >> 1);
            cy = mby * 4 + (hy >> 1);
        } else {
            cdxy = dxy | (my & 2) | ((mx & 2) >> 1);
            cx = sx >> 1;
            cy = sy >> 1;
        }
        const vEdge = field < 0 ? this.edgeHeight : this.edgeHeight >> 1;
        const emulated =
            sx < 0 ||
            sx >= Math.max(this.edgeWidth - (mx & 1) - 15, 0) ||
            sy < 0 ||
            sy >= Math.max(vEdge - (my & 1) - rows + 1, 0);
        this.chromaMotion(ref, cx, cy, cdxy, rows >> 1, mode, mbx, mby, field, select, emulated);
    }

    /** Quarter-sample frame (field < 0) or field prediction of the macroblock (7.6.2.2). */
    private quarterMotion(
        ref: Picture,
        mx: number,
        my: number,
        mode: number,
        mbx: number,
        mby: number,
        field: number,
        select: number,
    ): void {
        const mc = this.mc;
        const ls = this.lumaStride;
        const legacy = this.fix.legacyQpel;
        const sx = mbx * 16 + (mx >> 2);
        const rows = field < 0 ? 16 : 8;
        const sy = (field < 0 ? mby * 16 : mby * 8) + (my >> 2);
        const step = field < 0 ? 1 : 2;
        mc.fetch(
            ref.data,
            0,
            ls,
            this.edgeWidth,
            this.edgeHeight,
            sx,
            field < 0 ? sy : 2 * sy + select,
            17,
            rows + 1,
            step,
        );
        const dst = (mby * 16 + (field < 0 ? 0 : field)) * ls + mbx * 16;
        const data = this.cur.data;
        if (field < 0) {
            mc.quarterSample(
                data,
                dst,
                ls,
                mc.src,
                mc.srcOff,
                mc.srcStride,
                16,
                mx & 3,
                my & 3,
                mode,
                legacy,
            );
        } else {
            const src = mc.src;
            const srcOff = mc.srcOff;
            const srcStride = mc.srcStride;
            mc.quarterSample(
                data,
                dst,
                ls * 2,
                src,
                srcOff,
                srcStride,
                8,
                mx & 3,
                my & 3,
                mode,
                legacy,
            );
            mc.quarterSample(
                data,
                dst + 8,
                ls * 2,
                src,
                srcOff + 8,
                srcStride,
                8,
                mx & 3,
                my & 3,
                mode,
                legacy,
            );
        }
        let hx: number;
        let hy: number;
        if (field >= 0) {
            hx = Math.trunc(mx / 2);
            hy = my >> 1;
        } else if (this.fix.qpelChroma2) {
            hx = (mx >> 1) + QPEL_CHROMA2_ROUND[mx & 7];
            hy = (my >> 1) + QPEL_CHROMA2_ROUND[my & 7];
        } else if (this.fix.qpelChroma) {
            hx = (mx >> 1) | (mx & 1);
            hy = (my >> 1) | (my & 1);
        } else {
            hx = Math.trunc(mx / 2);
            hy = Math.trunc(my / 2);
        }
        hx = (hx >> 1) | (hx & 1);
        hy = (hy >> 1) | (hy & 1);
        const cdxy = (hx & 1) | ((hy & 1) << 1);
        const cx = mbx * 8 + (hx >> 1);
        const cy = (field < 0 ? mby * 8 : mby * 4) + (hy >> 1);
        const vEdge = field < 0 ? this.edgeHeight : this.edgeHeight >> 1;
        const emulated =
            sx < 0 ||
            sx >= Math.max(this.edgeWidth - (mx & 3) - 15, 0) ||
            sy < 0 ||
            sy >= Math.max(vEdge - (my & 3) - rows + 1, 0);
        this.chromaMotion(ref, cx, cy, cdxy, rows >> 1, mode, mbx, mby, field, select, emulated);
    }

    /**
     * Four 8x8 luma vectors and one chroma vector from their sum (inter4v and direct mode,
     * 7.6.2.3).
     */
    private blockMotion(
        ref: Picture,
        mv: Int32Array,
        mode: number,
        mbx: number,
        mby: number,
    ): void {
        const mc = this.mc;
        const ls = this.lumaStride;
        const data = this.cur.data;
        const quarter = this.seq.quarterSample;
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < 4; i++) {
            const mx = mv[i * 2];
            const my = mv[i * 2 + 1];
            const shift = quarter ? 2 : 1;
            let sx = mbx * 16 + (i & 1) * 8 + (mx >> shift);
            let sy = mby * 16 + (i >> 1) * 8 + (my >> shift);
            let fx = quarter ? mx & 3 : mx & 1;
            let fy = quarter ? my & 3 : my & 1;
            sx = sx < -16 ? -16 : sx > this.width ? this.width : sx;
            if (sx === this.width) fx = 0;
            sy = sy < -16 ? -16 : sy > this.height ? this.height : sy;
            if (sy === this.height) fy = 0;
            const dst = (mby * 16 + (i >> 1) * 8) * ls + mbx * 16 + (i & 1) * 8;
            if (quarter) {
                mc.fetch(ref.data, 0, ls, this.edgeWidth, this.edgeHeight, sx, sy, 9, 9, 1);
                mc.quarterSample(
                    data,
                    dst,
                    ls,
                    mc.src,
                    mc.srcOff,
                    mc.srcStride,
                    8,
                    fx,
                    fy,
                    mode,
                    this.fix.legacyQpel,
                );
                sumX += Math.trunc(mx / 2);
                sumY += Math.trunc(my / 2);
            } else {
                this.halfSampleBlock(
                    ref,
                    data,
                    dst,
                    ls,
                    mbx * 16 + (i & 1) * 8,
                    mby * 16 + (i >> 1) * 8,
                    mx,
                    my,
                    mode,
                );
                sumX += mx;
                sumY += my;
            }
        }
        this.chromaFourVectors(ref, sumX, sumY, mode, mbx, mby);
    }

    /**
     * Chroma of a macroblock predicted with four vectors whose components sum to (`sumX`, `sumY`).
     */
    private chromaFourVectors(
        ref: Picture,
        sumX: number,
        sumY: number,
        mode: number,
        mbx: number,
        mby: number,
    ): void {
        let cx = CHROMA_4MV_ROUND[sumX & 15] + (sumX >> 3);
        let cy = CHROMA_4MV_ROUND[sumY & 15] + (sumY >> 3);
        let dxy = ((cy & 1) << 1) | (cx & 1);
        cx >>= 1;
        cy >>= 1;
        const halfWidth = this.width >> 1;
        const halfHeight = this.height >> 1;
        let sx = mbx * 8 + cx;
        let sy = mby * 8 + cy;
        sx = sx < -8 ? -8 : sx > halfWidth ? halfWidth : sx;
        if (sx === halfWidth) dxy &= 2;
        sy = sy < -8 ? -8 : sy > halfHeight ? halfHeight : sy;
        if (sy === halfHeight) dxy &= 1;
        this.chromaMotion(ref, sx, sy, dxy, 8, mode, mbx, mby, -1, 0, false);
    }

    /**
     * Derives the warping of GMC S-VOPs from the sprite trajectory (ISO/IEC 14496-2 7.8.4 to
     * 7.8.6), reduced to a translation when possible. Marks the VOP undecodable when the
     * fixed-point parameters overflow.
     */
    private setupSprite(): void {
        const seq = this.seq;
        const d = this.vop.trajectory;
        const points = seq.spriteWarpingPoints;
        const accuracy = seq.spriteAccuracy;
        const a = 2 << accuracy;
        const rho = 3 - accuracy;
        const r = 16 / a;
        const w = this.width;
        const h = this.height;
        let alpha = 1;
        let beta = 0;
        while (1 << alpha < w) alpha++;
        while (1 << beta < h) beta++;
        const w2 = 2 ** alpha;
        const h2 = 2 ** beta;
        for (let i = points * 2; i < 8; i++) d[i] = 0;
        const refX = [0, w, 0, w];
        const refY = [0, 0, h, h];
        const spriteX = [0, 0, 0];
        const spriteY = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const dx = d[0] + (i ? d[i * 2] : 0);
            const dy = d[1] + (i ? d[i * 2 + 1] : 0);
            if (this.fix.divx500Sprite) {
                spriteX[i] = a * refX[i] + dx;
                spriteY[i] = a * refY[i] + dy;
            } else {
                spriteX[i] = (a >> 1) * (2 * refX[i] + dx);
                spriteY[i] = (a >> 1) * (2 * refY[i] + dy);
            }
        }
        const virtual00 =
            16 * (refX[0] + w2) +
            roundedDivide(
                (w - w2) * (r * spriteX[0] - 16 * refX[0]) + w2 * (r * spriteX[1] - 16 * refX[1]),
                w,
            );
        const virtual01 =
            16 * refY[0] +
            roundedDivide(
                (w - w2) * (r * spriteY[0] - 16 * refY[0]) + w2 * (r * spriteY[1] - 16 * refY[1]),
                w,
            );
        const virtual10 =
            16 * refX[0] +
            roundedDivide(
                (h - h2) * (r * spriteX[0] - 16 * refX[0]) + h2 * (r * spriteX[2] - 16 * refX[2]),
                h,
            );
        const virtual11 =
            16 * (refY[0] + h2) +
            roundedDivide(
                (h - h2) * (r * spriteY[0] - 16 * refY[0]) + h2 * (r * spriteY[2] - 16 * refY[2]),
                h,
            );
        let offset = [0, 0, 0, 0];
        let delta = [a, 0, 0, a];
        let shift0 = 0;
        let shift1 = 0;
        if (points === 1) {
            offset = [
                spriteX[0] - a * refX[0],
                spriteY[0] - a * refY[0],
                ((spriteX[0] >> 1) | (spriteX[0] & 1)) - a * (refX[0] / 2),
                ((spriteY[0] >> 1) | (spriteY[0] & 1)) - a * (refY[0] / 2),
            ];
        } else if (points === 2) {
            const s = 2 ** (alpha + rho);
            offset = [
                spriteX[0] * s +
                    (-r * spriteX[0] + virtual00) * -refX[0] +
                    (r * spriteY[0] - virtual01) * -refY[0] +
                    2 ** (alpha + rho - 1),
                spriteY[0] * s +
                    (-r * spriteY[0] + virtual01) * -refX[0] +
                    (-r * spriteX[0] + virtual00) * -refY[0] +
                    2 ** (alpha + rho - 1),
                (-r * spriteX[0] + virtual00) * (-2 * refX[0] + 1) +
                    (r * spriteY[0] - virtual01) * (-2 * refY[0] + 1) +
                    2 * w2 * r * spriteX[0] -
                    16 * w2 +
                    2 ** (alpha + rho + 1),
                (-r * spriteY[0] + virtual01) * (-2 * refX[0] + 1) +
                    (-r * spriteX[0] + virtual00) * (-2 * refY[0] + 1) +
                    2 * w2 * r * spriteY[0] -
                    16 * w2 +
                    2 ** (alpha + rho + 1),
            ];
            delta = [
                -r * spriteX[0] + virtual00,
                r * spriteY[0] - virtual01,
                -r * spriteY[0] + virtual01,
                -r * spriteX[0] + virtual00,
            ];
            shift0 = alpha + rho;
            shift1 = alpha + rho + 2;
        } else if (points === 3) {
            const minAb = Math.min(alpha, beta);
            const w3 = w2 / 2 ** minAb;
            const h3 = h2 / 2 ** minAb;
            const s = alpha + beta + rho - minAb;
            offset = [
                spriteX[0] * 2 ** s +
                    (-r * spriteX[0] + virtual00) * h3 * -refX[0] +
                    (-r * spriteX[0] + virtual10) * w3 * -refY[0] +
                    2 ** (s - 1),
                spriteY[0] * 2 ** s +
                    (-r * spriteY[0] + virtual01) * h3 * -refX[0] +
                    (-r * spriteY[0] + virtual11) * w3 * -refY[0] +
                    2 ** (s - 1),
                (-r * spriteX[0] + virtual00) * h3 * (-2 * refX[0] + 1) +
                    (-r * spriteX[0] + virtual10) * w3 * (-2 * refY[0] + 1) +
                    2 * w2 * h3 * r * spriteX[0] -
                    16 * w2 * h3 +
                    2 ** (s + 1),
                (-r * spriteY[0] + virtual01) * h3 * (-2 * refX[0] + 1) +
                    (-r * spriteY[0] + virtual11) * w3 * (-2 * refY[0] + 1) +
                    2 * w2 * h3 * r * spriteY[0] -
                    16 * w2 * h3 +
                    2 ** (s + 1),
            ];
            delta = [
                (-r * spriteX[0] + virtual00) * h3,
                (-r * spriteX[0] + virtual10) * w3,
                (-r * spriteY[0] + virtual01) * h3,
                (-r * spriteY[0] + virtual11) * w3,
            ];
            shift0 = s;
            shift1 = s + 2;
        }
        const scale0 = 2 ** shift0;
        if (
            delta[0] === a * scale0 &&
            delta[1] === 0 &&
            delta[2] === 0 &&
            delta[3] === a * scale0
        ) {
            this.spriteOffset = [
                Math.floor(offset[0] / scale0),
                Math.floor(offset[1] / scale0),
                Math.floor(offset[2] / 2 ** shift1),
                Math.floor(offset[3] / 2 ** shift1),
            ];
            this.spriteDelta = [a, 0, 0, a];
            this.spriteShift = 0;
            this.spriteRealPoints = 1;
            return;
        }
        const shiftY = 16 - shift0;
        const shiftC = 16 - shift1;
        const limit = 2 ** 31 - 1;
        for (let i = 0; i < 2; i++) {
            if (
                shiftC < 0 ||
                shiftY < 0 ||
                Math.abs(offset[i]) >= Math.floor(limit / 2 ** shiftY) ||
                Math.abs(offset[2 + i]) >= Math.floor(limit / 2 ** shiftC) ||
                Math.abs(delta[i]) >= Math.floor(limit / 2 ** shiftY) ||
                Math.abs(delta[2 + i]) >= Math.floor(limit / 2 ** shiftY)
            ) {
                this.spriteValid = false;
                return;
            }
        }
        for (let i = 0; i < 2; i++) {
            offset[i] *= 2 ** shiftY;
            offset[2 + i] *= 2 ** shiftC;
        }
        for (let i = 0; i < 4; i++) delta[i] *= 2 ** shiftY;
        for (let i = 0; i < 2; i++) {
            const dx = delta[i * 2];
            const dy = delta[i * 2 + 1];
            const sd0 = dx - a * 65536;
            const sd1 = dy - a * 65536;
            const o = offset[i];
            if (
                Math.abs(o + dx * (w + 16)) >= limit ||
                Math.abs(o + dy * (h + 16)) >= limit ||
                Math.abs(o + dx * (w + 16) + dy * (h + 16)) >= limit ||
                Math.abs(dx * (w + 16)) >= limit ||
                Math.abs(dy * (h + 16)) >= limit ||
                Math.abs(sd0) >= limit ||
                Math.abs(sd1) >= limit ||
                Math.abs(o + sd0 * (w + 16)) >= limit ||
                Math.abs(o + sd1 * (h + 16)) >= limit ||
                Math.abs(o + sd0 * (w + 16) + sd1 * (h + 16)) >= limit
            ) {
                this.spriteValid = false;
                return;
            }
        }
        this.spriteOffset = offset;
        this.spriteDelta = delta;
        this.spriteShift = 16;
        this.spriteRealPoints = points;
    }

    /**
     * Average luma vector of a GMC macroblock used for vector prediction (ISO/IEC 14496-2 7.8.7.3).
     */
    private averageMotion(component: number, mbx: number, mby: number): number {
        const accuracy = this.seq.spriteAccuracy;
        const quarter = this.seq.quarterSample ? 1 : 0;
        const range = 1 << (this.vop.fcode + 4);
        let sum: number;
        if (this.spriteRealPoints === 1) {
            const offset = this.spriteOffset[component];
            if (this.fix.divx500Sprite && accuracy >= quarter)
                sum = Math.trunc(offset / 2 ** (accuracy - quarter));
            else sum = roundedShift(offset * 2 ** quarter, accuracy);
        } else {
            const shift = this.spriteShift;
            let dx = this.spriteDelta[component * 2];
            let dy = this.spriteDelta[component * 2 + 1];
            if (component) dy -= 2 ** (shift + accuracy + 1);
            else dx -= 2 ** (shift + accuracy + 1);
            const base = this.spriteOffset[component] + dx * mbx * 16 + dy * mby * 16;
            sum = 0;
            for (let y = 0; y < 16; y++) {
                let v = base + dy * y;
                for (let x = 0; x < 16; x++) {
                    sum += v >> shift;
                    v += dx;
                }
            }
            sum = roundedShift(sum, accuracy + 8 - quarter);
        }
        return sum < -range ? -range : sum >= range ? range - 1 : sum;
    }

    /** Global motion compensated prediction of the macroblock (ISO/IEC 14496-2 7.8.7). */
    private globalMotion(ref: Picture, mbx: number, mby: number): void {
        const mc = this.mc;
        const data = this.cur.data;
        const ls = this.lumaStride;
        const cs = this.chromaStride;
        const noRound = this.vop.rounding;
        const accuracy = this.seq.spriteAccuracy;
        const lumaDst = mby * 16 * ls + mbx * 16;
        const chromaDst = mby * 8 * cs + mbx * 8;
        if (this.spriteRealPoints === 1) {
            for (let plane = 0; plane < 3; plane++) {
                const size = plane ? 8 : 16;
                const width = plane ? this.width >> 1 : this.width;
                const height = plane ? this.height >> 1 : this.height;
                let mx = this.spriteOffset[plane ? 2 : 0];
                let my = this.spriteOffset[plane ? 3 : 1];
                let sx = (plane ? mbx * 8 : mbx * 16) + (mx >> (accuracy + 1));
                let sy = (plane ? mby * 8 : mby * 16) + (my >> (accuracy + 1));
                mx *= 1 << (3 - accuracy);
                my *= 1 << (3 - accuracy);
                sx = sx < -size ? -size : sx > width ? width : sx;
                if (sx === width) mx = 0;
                sy = sy < -size ? -size : sy > height ? height : sy;
                if (sy === height) my = 0;
                const base = plane === 0 ? 0 : plane === 1 ? this.chromaBase : this.crBase;
                const stride = plane ? cs : ls;
                const ew = plane ? this.edgeWidth >> 1 : this.edgeWidth;
                const eh = plane ? this.edgeHeight >> 1 : this.edgeHeight;
                mc.fetch(ref.data, base, stride, ew, eh, sx, sy, size + 1, size + 1, 1);
                const dst = base + (plane ? chromaDst : lumaDst);
                for (let half = 0; half < size; half += 8) {
                    MotionCompensation.gmcOnePoint(
                        data,
                        dst + half,
                        stride,
                        mc.src,
                        mc.srcOff + half,
                        mc.srcStride,
                        size,
                        mx & 15,
                        my & 15,
                        128 - noRound,
                    );
                }
            }
            return;
        }
        const [ox0, oy0, ox1, oy1] = this.spriteOffset;
        const [dxx, dxy, dyx, dyy] = this.spriteDelta;
        const shift = accuracy + 1;
        const rounder = (1 << (2 * accuracy + 1)) - noRound;
        const ox = ox0 + dxx * mbx * 16 + dxy * mby * 16;
        const oy = oy0 + dyx * mbx * 16 + dyy * mby * 16;
        for (let half = 0; half < 2; half++) {
            MotionCompensation.gmcAffine(
                data,
                lumaDst + half * 8,
                ls,
                ref.data,
                0,
                ls,
                16,
                ox + dxx * 8 * half,
                oy + dyx * 8 * half,
                dxx,
                dxy,
                dyx,
                dyy,
                shift,
                rounder,
                this.edgeWidth,
                this.edgeHeight,
            );
        }
        const cox = ox1 + dxx * mbx * 8 + dxy * mby * 8;
        const coy = oy1 + dyx * mbx * 8 + dyy * mby * 8;
        for (let plane = 1; plane < 3; plane++) {
            const base = plane === 1 ? this.chromaBase : this.crBase;
            MotionCompensation.gmcAffine(
                data,
                base + chromaDst,
                cs,
                ref.data,
                base,
                cs,
                8,
                cox,
                coy,
                dxx,
                dxy,
                dyx,
                dyy,
                shift,
                rounder,
                (this.edgeWidth + 1) >> 1,
                (this.edgeHeight + 1) >> 1,
            );
        }
    }
}
