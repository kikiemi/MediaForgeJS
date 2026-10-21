import type { BitReader } from './bit-reader';
import {
    DEFAULT_4X4_INTER,
    DEFAULT_4X4_INTRA,
    DEFAULT_8X8_INTER,
    DEFAULT_8X8_INTRA,
    SLICE_B,
    SLICE_I,
    SLICE_P,
    SLICE_SI,
    SLICE_SP,
} from './tables';

export const NAL_SLICE = 1;
export const NAL_DPA = 2;
export const NAL_IDR = 5;
export const NAL_SEI = 6;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
export const NAL_END_SEQUENCE = 10;
export const NAL_AUX_SLICE = 19;

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const MAX_MB_DIMENSION = 1024;

interface VuiInfo {
    readonly sarNum: number;
    readonly sarDen: number;
    readonly colourPrimaries: number;
    readonly transferCharacteristics: number;
    readonly matrixCoefficients: number;
    readonly fullRange: boolean;
    /** From bitstream_restriction(); -1 when absent. */
    readonly numReorderFrames: number;
    readonly maxDecFrameBuffering: number;
}

export interface Sps {
    readonly id: number;
    readonly profileIdc: number;
    /**
     * constraint_set1_flag: the stream obeys the Main profile constraints (no slice groups, A.2.2).
     */
    readonly constraintSet1: boolean;
    readonly constraintSet3: boolean;
    readonly levelIdc: number;
    readonly chromaFormatIdc: number;
    readonly bitDepthLuma: number;
    readonly bitDepthChroma: number;
    readonly transformBypass: boolean;
    /**
     * Scaling lists in coded order, or null for Flat_16; 4x4 intra Y, Cb, Cr, inter Y, Cb, Cr, then
     * 8x8 intra Y, inter Y.
     */
    readonly scalingLists: (Uint8Array | null)[] | null;
    readonly log2MaxFrameNum: number;
    readonly pocType: number;
    readonly log2MaxPocLsb: number;
    readonly deltaPicOrderAlwaysZero: boolean;
    readonly offsetForNonRefPic: number;
    readonly offsetForTopToBottomField: number;
    readonly offsetForRefFrame: Int32Array;
    readonly numRefFrames: number;
    readonly gapsInFrameNumAllowed: boolean;
    readonly mbWidth: number;
    /** Frame height in macroblocks. */
    readonly mbHeight: number;
    readonly frameMbsOnly: boolean;
    readonly mbaff: boolean;
    readonly direct8x8Inference: boolean;
    /** Cropping in luma samples of the frame. */
    readonly cropLeft: number;
    readonly cropRight: number;
    readonly cropTop: number;
    readonly cropBottom: number;
    readonly vui: VuiInfo | null;
}

export interface Pps {
    readonly id: number;
    readonly spsId: number;
    readonly cabac: boolean;
    readonly bottomFieldPicOrderPresent: boolean;
    readonly numSliceGroups: number;
    readonly numRefIdxActive: readonly [number, number];
    readonly weightedPred: boolean;
    readonly weightedBipredIdc: number;
    readonly picInitQp: number;
    readonly picInitQs: number;
    readonly chromaQpOffset: readonly [number, number];
    readonly deblockingFilterControlPresent: boolean;
    readonly constrainedIntraPred: boolean;
    readonly redundantPicCntPresent: boolean;
    readonly transform8x8Mode: boolean;
    /**
     * Picture-level scaling lists (same layout as the SPS), null entries fall back; null when not
     * present.
     */
    readonly scalingLists: (Uint8Array | null)[] | null;
}

/**
 * ref_pic_list_modification operation: idc 0/1 with abs_diff_pic_num_minus1, 2 with
 * long_term_pic_num.
 */
export interface RefListModification {
    readonly idc: number;
    readonly value: number;
}

export interface Mmco {
    readonly op: number;
    readonly differenceOfPicNums: number;
    readonly longTermPicNum: number;
    readonly longTermFrameIdx: number;
    readonly maxLongTermFrameIdxPlus1: number;
}

interface PredWeights {
    readonly lumaLog2Denom: number;
    readonly chromaLog2Denom: number;
    /** Per list: [refIdx * 6 + component * 2] weight, + 1 offset; component 0 luma, 1 Cb, 2 Cr. */
    readonly table: readonly [Int16Array, Int16Array];
    /** Per list, bit refIdx: explicit luma weight present; and chroma present in `chromaFlags`. */
    readonly lumaFlags: Uint8Array;
    readonly chromaFlags: Uint8Array;
}

export interface SliceHeader {
    readonly nalType: number;
    readonly nalRefIdc: number;
    readonly firstMb: number;
    readonly sliceType: number;
    readonly ppsId: number;
    readonly colourPlane: number;
    readonly frameNum: number;
    readonly fieldPic: boolean;
    readonly bottomField: boolean;
    readonly idrPicId: number;
    readonly pocLsb: number;
    readonly deltaPocBottom: number;
    readonly deltaPoc0: number;
    readonly deltaPoc1: number;
    readonly redundantPicCnt: number;
    readonly directSpatialMvPred: boolean;
    readonly numRefIdxActive: readonly [number, number];
    readonly refListModifications: readonly [
        readonly RefListModification[],
        readonly RefListModification[],
    ];
    readonly weights: PredWeights | null;
    readonly noOutputOfPriorPics: boolean;
    readonly longTermReference: boolean;
    readonly adaptiveMarking: boolean;
    readonly mmcos: readonly Mmco[];
    readonly cabacInitIdc: number;
    readonly sliceQpDelta: number;
    readonly spForSwitch: boolean;
    readonly sliceQsDelta: number;
    readonly disableDeblockingFilterIdc: number;
    /** FilterOffsetA and FilterOffsetB (already doubled). */
    readonly alphaOffset: number;
    readonly betaOffset: number;
    /** Bit position of the first slice_data() bit within the RBSP. */
    readonly dataBitOffset: number;
}

interface RecoveryPoint {
    readonly recoveryFrameCnt: number;
    readonly exactMatch: boolean;
    readonly brokenLink: boolean;
}

function readScalingList(br: BitReader, size: number, fallback: Uint8Array): Uint8Array | null {
    const list = new Uint8Array(size);
    let last = 8;
    let next = 8;
    for (let i = 0; i < size; i++) {
        if (next !== 0) {
            const delta = br.se();
            next = (last + delta + 256) & 255;
            if (i === 0 && next === 0) return fallback;
        }
        list[i] = next === 0 ? last : next;
        last = list[i];
    }
    return list;
}

/**
 * Parses the scaling lists of an SPS or PPS; `count` is 8 (or 12 for 4:4:4), entries not present
 * stay null.
 */
function readScalingLists(br: BitReader, count: number): (Uint8Array | null)[] {
    const lists: (Uint8Array | null)[] = [];
    for (let i = 0; i < count; i++) {
        if (!br.read1()) {
            lists.push(null);
            continue;
        }
        lists.push(readScalingList(br, i < 6 ? 16 : 64, defaultScalingList(i)));
    }
    return lists;
}

/**
 * Resolves the scaling lists for a picture (7.4.2.1.1.1 fall-back rule A for the SPS, rule B for
 * the PPS), returning the eight lists in coded order or null for Flat_16 everywhere.
 */
export function resolveScalingLists(sps: Sps, pps: Pps): Uint8Array[] | null {
    if (!sps.scalingLists && !pps.scalingLists) return null;
    const seq: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) {
        const present = sps.scalingLists?.[i];
        if (!sps.scalingLists) seq.push(FLAT_LISTS[i < 6 ? 0 : 1]);
        else if (present) seq.push(present);
        else seq.push(i === 0 || i === 3 || i >= 6 ? defaultScalingList(i) : seq[i - 1]);
    }
    if (!pps.scalingLists) return seq;
    const ruleA = !sps.scalingLists;
    const out: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) {
        const present = pps.scalingLists[i];
        if (present) out.push(present);
        else if (i === 0 || i === 3 || i >= 6) out.push(ruleA ? defaultScalingList(i) : seq[i]);
        else out.push(out[i - 1]);
    }
    return out;
}

const FLAT_LISTS = [new Uint8Array(16).fill(16), new Uint8Array(64).fill(16)];

function defaultScalingList(index: number): Uint8Array {
    if (index < 6) return index < 3 ? DEFAULT_4X4_INTRA : DEFAULT_4X4_INTER;
    return index & 1 ? DEFAULT_8X8_INTER : DEFAULT_8X8_INTRA;
}

function readHrd(br: BitReader): void {
    const count = br.ue() + 1;
    br.skip(8);
    for (let i = 0; i < count && i <= 32; i++) {
        br.ue();
        br.ue();
        br.skip(1);
    }
    br.skip(20);
}

function readVui(br: BitReader): VuiInfo {
    let sarNum = 1;
    let sarDen = 1;
    if (br.read1()) {
        const idc = br.read(8);
        if (idc === 255) {
            sarNum = br.read(16);
            sarDen = br.read(16);
        } else if (idc >= 1 && idc <= 16) [sarNum, sarDen] = SAR_TABLE[idc - 1];
        if (!sarNum || !sarDen) sarNum = sarDen = 1;
    }

    if (br.read1()) br.skip(1);
    let colourPrimaries = 2;
    let transferCharacteristics = 2;
    let matrixCoefficients = 2;
    let fullRange = false;
    if (br.read1()) {
        br.skip(3);
        fullRange = br.read1() === 1;
        if (br.read1()) {
            colourPrimaries = br.read(8);
            transferCharacteristics = br.read(8);
            matrixCoefficients = br.read(8);
        }
    }

    if (br.read1()) {
        br.ue();
        br.ue();
    }

    if (br.read1()) {
        br.skip(32);
        br.skip(32);
        br.skip(1);
    }

    const nalHrd = br.read1();
    if (nalHrd) readHrd(br);
    const vclHrd = br.read1();
    if (vclHrd) readHrd(br);
    if (nalHrd || vclHrd) br.skip(1);
    br.skip(1);
    let numReorderFrames = -1;
    let maxDecFrameBuffering = -1;
    if (br.read1()) {
        br.skip(1);
        br.ue();
        br.ue();
        br.ue();
        br.ue();
        numReorderFrames = br.ue();
        maxDecFrameBuffering = br.ue();
        if (numReorderFrames > 16 || maxDecFrameBuffering > 16 || br.pos > br.end + 1) {
            numReorderFrames = -1;
            maxDecFrameBuffering = -1;
        }
    }

    return {
        sarNum,
        sarDen,
        colourPrimaries,
        transferCharacteristics,
        matrixCoefficients,
        fullRange,
        numReorderFrames,
        maxDecFrameBuffering,
    };
}

const SAR_TABLE: readonly (readonly [number, number])[] = [
    [1, 1],
    [12, 11],
    [10, 11],
    [16, 11],
    [40, 33],
    [24, 11],
    [20, 11],
    [32, 11],
    [80, 33],
    [18, 11],
    [15, 11],
    [64, 33],
    [160, 99],
    [4, 3],
    [3, 2],
    [2, 1],
];

/**
 * Parses seq_parameter_set_data (7.3.2.1.1); returns a reason when it is damaged or unsupported.
 */
export function parseSps(br: BitReader): Sps | string {
    const profileIdc = br.read(8);
    const constraints = br.read(8);
    const levelIdc = br.read(8);
    const id = br.ue();
    if (id > 31) return 'seq_parameter_set_id out of range';
    let chromaFormatIdc = 1;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    let transformBypass = false;
    let scalingLists: (Uint8Array | null)[] | null = null;
    if (HIGH_PROFILES.has(profileIdc)) {
        chromaFormatIdc = br.ue();
        if (chromaFormatIdc > 3) return 'chroma_format_idc out of range';
        if (chromaFormatIdc === 3 && br.read1()) return 'separate colour planes are not supported';
        bitDepthLuma = br.ue() + 8;
        bitDepthChroma = br.ue() + 8;
        if (bitDepthLuma > 14 || bitDepthChroma > 14) return 'bit depth out of range';
        transformBypass = br.read1() === 1;
        if (br.read1()) scalingLists = readScalingLists(br, chromaFormatIdc === 3 ? 12 : 8);
    }

    const log2MaxFrameNum = br.ue() + 4;
    if (log2MaxFrameNum > 16) return 'log2_max_frame_num out of range';
    const pocType = br.ue();
    let log2MaxPocLsb = 0;
    let deltaPicOrderAlwaysZero = false;
    let offsetForNonRefPic = 0;
    let offsetForTopToBottomField = 0;
    let offsetForRefFrame = new Int32Array(0);
    if (pocType === 0) {
        log2MaxPocLsb = br.ue() + 4;
        if (log2MaxPocLsb > 16) return 'log2_max_pic_order_cnt_lsb out of range';
    } else if (pocType === 1) {
        deltaPicOrderAlwaysZero = br.read1() === 1;
        offsetForNonRefPic = br.se();
        offsetForTopToBottomField = br.se();
        const cycle = br.ue();
        if (cycle > 255) return 'num_ref_frames_in_pic_order_cnt_cycle out of range';
        offsetForRefFrame = new Int32Array(cycle);
        for (let i = 0; i < cycle; i++) offsetForRefFrame[i] = br.se();
    } else if (pocType > 2) return 'pic_order_cnt_type out of range';

    const numRefFrames = br.ue();
    if (numRefFrames > 16) return 'max_num_ref_frames out of range';
    const gapsInFrameNumAllowed = br.read1() === 1;
    const mbWidth = br.ue() + 1;
    const mapHeight = br.ue() + 1;
    const frameMbsOnly = br.read1() === 1;
    const mbHeight = mapHeight * (frameMbsOnly ? 1 : 2);
    if (mbWidth > MAX_MB_DIMENSION || mbHeight > MAX_MB_DIMENSION)
        return 'picture size exceeds 16384 samples';
    const mbaff = !frameMbsOnly && br.read1() === 1;
    const direct8x8Inference = br.read1() === 1;
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (br.read1()) {
        const subWidth = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
        const subHeight = chromaFormatIdc === 1 ? 2 : 1;
        const unitX = chromaFormatIdc === 0 ? 1 : subWidth;
        const unitY = (chromaFormatIdc === 0 ? 1 : subHeight) * (frameMbsOnly ? 1 : 2);
        cropLeft = br.ue() * unitX;
        cropRight = br.ue() * unitX;
        cropTop = br.ue() * unitY;
        cropBottom = br.ue() * unitY;
        if (cropLeft + cropRight >= mbWidth * 16 || cropTop + cropBottom >= mbHeight * 16) {
            cropLeft = cropRight = cropTop = cropBottom = 0;
        }
    }

    const vui = br.read1() ? readVui(br) : null;
    if (br.pos > br.end + 8) return 'truncated sequence parameter set';
    return {
        id,
        profileIdc,
        constraintSet1: (constraints & 0x40) !== 0,
        constraintSet3: (constraints & 0x10) !== 0,
        levelIdc,
        chromaFormatIdc,
        bitDepthLuma,
        bitDepthChroma,
        transformBypass,
        scalingLists,
        log2MaxFrameNum,
        pocType,
        log2MaxPocLsb,
        deltaPicOrderAlwaysZero,
        offsetForNonRefPic,
        offsetForTopToBottomField,
        offsetForRefFrame,
        numRefFrames,
        gapsInFrameNumAllowed,
        mbWidth,
        mbHeight,
        frameMbsOnly,
        mbaff,
        direct8x8Inference,
        cropLeft,
        cropRight,
        cropTop,
        cropBottom,
        vui,
    };
}

/**
 * Parses pic_parameter_set_rbsp (7.3.2.2); `chromaFormatOf` gives the chroma format of the
 * referenced SPS when known.
 */
export function parsePps(br: BitReader, chromaFormatOf: (spsId: number) => number): Pps | string {
    const id = br.ue();
    if (id > 255) return 'pic_parameter_set_id out of range';
    const spsId = br.ue();
    if (spsId > 31) return 'seq_parameter_set_id out of range';
    const cabac = br.read1() === 1;
    const bottomFieldPicOrderPresent = br.read1() === 1;
    const numSliceGroups = br.ue() + 1;
    if (numSliceGroups > 1) {
        const mapType = br.ue();
        if (mapType === 0) for (let i = 0; i < numSliceGroups; i++) br.ue();
        else if (mapType === 2)
            for (let i = 0; i < numSliceGroups - 1; i++) {
                br.ue();
                br.ue();
            }
        else if (mapType >= 3 && mapType <= 5) {
            br.skip(1);
            br.ue();
        } else if (mapType === 6) {
            const count = br.ue() + 1;
            const bits = Math.ceil(Math.log2(numSliceGroups));
            for (let i = 0; i < count && i < 1 << 20; i++) br.skip(bits);
        }
    }

    const l0 = br.ue() + 1;
    const l1 = br.ue() + 1;
    if (l0 > 32 || l1 > 32) return 'num_ref_idx_active out of range';
    const weightedPred = br.read1() === 1;
    const weightedBipredIdc = br.read(2);
    if (weightedBipredIdc > 2) return 'weighted_bipred_idc out of range';
    const picInitQp = 26 + br.se();
    const picInitQs = 26 + br.se();
    const chromaQpOffset0 = br.se();
    const deblockingFilterControlPresent = br.read1() === 1;
    const constrainedIntraPred = br.read1() === 1;
    const redundantPicCntPresent = br.read1() === 1;
    let transform8x8Mode = false;
    let scalingLists: (Uint8Array | null)[] | null = null;
    let chromaQpOffset1 = chromaQpOffset0;
    if (br.moreRbspData()) {
        transform8x8Mode = br.read1() === 1;
        if (br.read1())
            scalingLists = readScalingLists(
                br,
                6 + (transform8x8Mode ? (chromaFormatOf(spsId) === 3 ? 6 : 2) : 0),
            );
        chromaQpOffset1 = br.se();
    }

    if (
        chromaQpOffset0 < -12 ||
        chromaQpOffset0 > 12 ||
        chromaQpOffset1 < -12 ||
        chromaQpOffset1 > 12
    )
        return 'chroma_qp_index_offset out of range';
    if (br.pos > br.end + 8) return 'truncated picture parameter set';
    return {
        id,
        spsId,
        cabac,
        bottomFieldPicOrderPresent,
        numSliceGroups,
        numRefIdxActive: [l0, l1],
        weightedPred,
        weightedBipredIdc,
        picInitQp,
        picInitQs,
        chromaQpOffset: [chromaQpOffset0, chromaQpOffset1],
        deblockingFilterControlPresent,
        constrainedIntraPred,
        redundantPicCntPresent,
        transform8x8Mode,
        scalingLists,
    };
}

function readRefListModifications(br: BitReader): RefListModification[] | string {
    const ops: RefListModification[] = [];
    if (!br.read1()) return ops;
    for (let count = 0; ; count++) {
        const idc = br.ue();
        if (idc === 3) break;
        if (idc > 3 || count > 64) return 'damaged ref_pic_list_modification';
        ops.push({ idc, value: br.ue() });
    }
    return ops;
}

function readPredWeights(
    br: BitReader,
    chroma: boolean,
    lists: number,
    active: readonly [number, number],
): PredWeights | string {
    const lumaLog2Denom = br.ue();
    const chromaLog2Denom = chroma ? br.ue() : 0;
    if (lumaLog2Denom > 7 || chromaLog2Denom > 7) return 'luma_log2_weight_denom out of range';
    const table: [Int16Array, Int16Array] = [new Int16Array(32 * 6), new Int16Array(32 * 6)];
    const lumaFlags = new Uint8Array(2 * 32);
    const chromaFlags = new Uint8Array(2 * 32);
    for (let list = 0; list < lists; list++) {
        const t = table[list];
        for (let i = 0; i < active[list]; i++) {
            const base = i * 6;
            t[base] = 1 << lumaLog2Denom;
            if (br.read1()) {
                lumaFlags[list * 32 + i] = 1;
                t[base] = br.se();
                t[base + 1] = br.se();
                if (t[base] < -128 || t[base] > 127 || t[base + 1] < -128 || t[base + 1] > 127)
                    return 'luma weight out of range';
            }

            t[base + 2] = t[base + 4] = 1 << chromaLog2Denom;
            if (chroma && br.read1()) {
                chromaFlags[list * 32 + i] = 1;
                for (let c = 0; c < 2; c++) {
                    t[base + 2 + c * 2] = br.se();
                    t[base + 3 + c * 2] = br.se();
                    if (
                        t[base + 2 + c * 2] < -128 ||
                        t[base + 2 + c * 2] > 127 ||
                        t[base + 3 + c * 2] < -128 ||
                        t[base + 3 + c * 2] > 127
                    )
                        return 'chroma weight out of range';
                }
            }
        }
    }

    return { lumaLog2Denom, chromaLog2Denom, table, lumaFlags, chromaFlags };
}

/**
 * Parses slice_header() (7.3.3) up to the start of slice_data(). `pps` and `sps` are the parameter
 * sets the caller looked up from pic_parameter_set_id, which the caller reads first with
 * `peekSliceIds`.
 */
export function parseSliceHeader(
    br: BitReader,
    nalType: number,
    nalRefIdc: number,
    sps: Sps,
    pps: Pps,
): SliceHeader | string {
    const firstMb = br.ue();
    const sliceTypeRaw = br.ue();
    if (sliceTypeRaw > 9) return 'slice_type out of range';
    const sliceType = sliceTypeRaw % 5;
    const ppsId = br.ue();
    const colourPlane = 0;
    const frameNum = br.read(sps.log2MaxFrameNum);
    let fieldPic = false;
    let bottomField = false;
    if (!sps.frameMbsOnly) {
        fieldPic = br.read1() === 1;
        if (fieldPic) bottomField = br.read1() === 1;
    }

    const idr = nalType === NAL_IDR;
    const idrPicId = idr ? br.ue() : 0;
    if (idr && idrPicId > 65535) return 'idr_pic_id out of range';
    let pocLsb = 0;
    let deltaPocBottom = 0;
    let deltaPoc0 = 0;
    let deltaPoc1 = 0;
    if (sps.pocType === 0) {
        pocLsb = br.read(sps.log2MaxPocLsb);
        if (pps.bottomFieldPicOrderPresent && !fieldPic) deltaPocBottom = br.se();
    } else if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
        deltaPoc0 = br.se();
        if (pps.bottomFieldPicOrderPresent && !fieldPic) deltaPoc1 = br.se();
    }

    const redundantPicCnt = pps.redundantPicCntPresent ? br.ue() : 0;
    const directSpatialMvPred = sliceType === SLICE_B ? br.read1() === 1 : false;
    let numRefIdxActive: [number, number] = [pps.numRefIdxActive[0], pps.numRefIdxActive[1]];
    if (sliceType === SLICE_P || sliceType === SLICE_SP || sliceType === SLICE_B) {
        if (br.read1()) {
            numRefIdxActive = [
                br.ue() + 1,
                sliceType === SLICE_B ? br.ue() + 1 : pps.numRefIdxActive[1],
            ];
        }
        const limit = fieldPic ? 32 : 16;
        if (numRefIdxActive[0] > limit || numRefIdxActive[1] > limit)
            return 'num_ref_idx_active out of range';
    }

    if (sliceType !== SLICE_B) numRefIdxActive = [numRefIdxActive[0], 0];
    if (sliceType === SLICE_I || sliceType === SLICE_SI) numRefIdxActive = [0, 0];
    let mod0: RefListModification[] = [];
    let mod1: RefListModification[] = [];
    if (sliceType !== SLICE_I && sliceType !== SLICE_SI) {
        const list0 = readRefListModifications(br);
        if (typeof list0 === 'string') return list0;
        mod0 = list0;
        if (sliceType === SLICE_B) {
            const list1 = readRefListModifications(br);
            if (typeof list1 === 'string') return list1;
            mod1 = list1;
        }
    }

    let weights: PredWeights | null = null;
    if (
        (pps.weightedPred && (sliceType === SLICE_P || sliceType === SLICE_SP)) ||
        (pps.weightedBipredIdc === 1 && sliceType === SLICE_B)
    ) {
        const parsed = readPredWeights(
            br,
            sps.chromaFormatIdc !== 0,
            sliceType === SLICE_B ? 2 : 1,
            numRefIdxActive,
        );
        if (typeof parsed === 'string') return parsed;
        weights = parsed;
    }

    let noOutputOfPriorPics = false;
    let longTermReference = false;
    let adaptiveMarking = false;
    const mmcos: Mmco[] = [];
    if (nalRefIdc) {
        if (idr) {
            noOutputOfPriorPics = br.read1() === 1;
            longTermReference = br.read1() === 1;
        } else if (br.read1()) {
            adaptiveMarking = true;
            for (let count = 0; ; count++) {
                const op = br.ue();
                if (op === 0) break;
                if (op > 6 || count > 66) return 'damaged dec_ref_pic_marking';
                const differenceOfPicNums = op === 1 || op === 3 ? br.ue() + 1 : 0;
                const longTermPicNum = op === 2 ? br.ue() : 0;
                const longTermFrameIdx = op === 3 || op === 6 ? br.ue() : 0;
                const maxLongTermFrameIdxPlus1 = op === 4 ? br.ue() : 0;
                mmcos.push({
                    op,
                    differenceOfPicNums,
                    longTermPicNum,
                    longTermFrameIdx,
                    maxLongTermFrameIdxPlus1,
                });
            }
        }
    }

    let cabacInitIdc = 0;
    if (pps.cabac && sliceType !== SLICE_I && sliceType !== SLICE_SI) {
        cabacInitIdc = br.ue();
        if (cabacInitIdc > 2) return 'cabac_init_idc out of range';
    }

    const sliceQpDelta = br.se();
    const qp = pps.picInitQp + sliceQpDelta;
    if (qp < -(6 * (sps.bitDepthLuma - 8)) || qp > 51) return 'slice_qp_delta out of range';
    let spForSwitch = false;
    let sliceQsDelta = 0;
    if (sliceType === SLICE_SP || sliceType === SLICE_SI) {
        if (sliceType === SLICE_SP) spForSwitch = br.read1() === 1;
        sliceQsDelta = br.se();
    }

    let disableDeblockingFilterIdc = 0;
    let alphaOffset = 0;
    let betaOffset = 0;
    if (pps.deblockingFilterControlPresent) {
        disableDeblockingFilterIdc = br.ue();
        if (disableDeblockingFilterIdc > 2) return 'disable_deblocking_filter_idc out of range';
        if (disableDeblockingFilterIdc !== 1) {
            alphaOffset = br.se() * 2;
            betaOffset = br.se() * 2;
            if (alphaOffset < -12 || alphaOffset > 12 || betaOffset < -12 || betaOffset > 12)
                return 'deblocking offsets out of range';
        }
    }

    if (pps.numSliceGroups > 1) return 'slice groups are not supported';
    if (br.pos > br.end) return 'truncated slice header';
    return {
        nalType,
        nalRefIdc,
        firstMb,
        sliceType,
        ppsId,
        colourPlane,
        frameNum,
        fieldPic,
        bottomField,
        idrPicId,
        pocLsb,
        deltaPocBottom,
        deltaPoc0,
        deltaPoc1,
        redundantPicCnt,
        directSpatialMvPred,
        numRefIdxActive,
        refListModifications: [mod0, mod1],
        weights,
        noOutputOfPriorPics,
        longTermReference,
        adaptiveMarking,
        mmcos,
        cabacInitIdc,
        sliceQpDelta,
        spForSwitch,
        sliceQsDelta,
        disableDeblockingFilterIdc,
        alphaOffset,
        betaOffset,
        dataBitOffset: br.pos,
    };
}

/** Reads first_mb_in_slice, slice_type and pic_parameter_set_id without consuming them. */
export function peekSliceIds(br: BitReader): { firstMb: number; sliceType: number; ppsId: number } {
    const pos = br.pos;
    const firstMb = br.ue();
    const sliceType = br.ue();
    const ppsId = br.ue();
    br.pos = pos;
    return { firstMb, sliceType, ppsId };
}

/** Parses sei_rbsp() (7.3.2.3) for a recovery point message; other payloads are skipped. */
export function parseSei(br: BitReader): RecoveryPoint | null {
    let recovery: RecoveryPoint | null = null;
    while (br.moreRbspData() && br.bitsLeft() >= 16) {
        let type = 0;
        let byte = br.read(8);
        while (byte === 255 && br.bitsLeft() > 0) {
            type += 255;
            byte = br.read(8);
        }

        type += byte;
        let size = 0;
        byte = br.read(8);
        while (byte === 255 && br.bitsLeft() > 0) {
            size += 255;
            byte = br.read(8);
        }

        size += byte;
        if (size * 8 > br.bitsLeft() + 7) break;
        const next = br.pos + size * 8;
        if (type === 6) {
            const recoveryFrameCnt = br.ue();
            const exactMatch = br.read1() === 1;
            const brokenLink = br.read1() === 1;
            if (recoveryFrameCnt <= 65535) recovery = { recoveryFrameCnt, exactMatch, brokenLink };
        }

        br.pos = next;
    }
    return recovery;
}

export function isIntraSlice(sliceType: number): boolean {
    return sliceType === SLICE_I || sliceType === SLICE_SI;
}
