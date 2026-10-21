import type { RangeDecoder } from './range-decoder';
import {
    INT32_MAX,
    addSat32,
    clz32,
    div32,
    div32VarQ,
    inverse32VarQ,
    limit,
    log2lin,
    lshiftSat32,
    mulRoundShift64,
    rand,
    rshiftRound,
    sat16,
    smlabb,
    smlawb,
    smmul,
    smulbb,
    smulwb,
    smulww,
    sqrtApprox,
    subSat32,
} from './silk-math';
import { SilkResampler } from './silk-resampler';
import * as T from './silk-tables';

const MAX_FRAME_LENGTH = 320;
const MAX_SUB_FRAME_LENGTH = 80;
const MAX_LPC_ORDER = 16;
const LTP_ORDER = 5;
const MAX_NB_SUBFR = 4;
const SHELL_CODEC_FRAME_LENGTH = 16;
const MAX_NB_SHELL_BLOCKS = 20;
const SILK_MAX_PULSES = 16;
const N_RATE_LEVELS = 10;
const NLSF_QUANT_MAX_AMPLITUDE = 4;
const NLSF_QUANT_LEVEL_ADJ_Q10 = 102;
const QUANT_LEVEL_ADJUST_Q10 = 80;
const LTP_MEM_LENGTH_MS = 20;
const BWE_AFTER_LOSS_Q16 = 63570;
const MIN_DELTA_GAIN_QUANT = -4;
const MAX_DELTA_GAIN_QUANT = 36;
const N_LEVELS_QGAIN = 64;
const GAIN_OFFSET = 2090;
const GAIN_INV_SCALE_Q16 = 1907825;
const STEREO_INTERP_LEN_MS = 8;
const CNG_BUF_MASK_MAX = 255;
const CNG_GAIN_SMTH_Q16 = 4634;
const CNG_NLSF_SMTH_Q16 = 16348;
const BWE_COEF_Q16 = 64881;
const V_PITCH_GAIN_START_MIN_Q14 = 11469;
const V_PITCH_GAIN_START_MAX_Q14 = 15565;
const MAX_PITCH_LAG_MS = 18;
const RAND_BUF_SIZE = 128;
const RAND_BUF_MASK = RAND_BUF_SIZE - 1;
const LOG2_INV_LPC_GAIN_HIGH_THRES = 3;
const LOG2_INV_LPC_GAIN_LOW_THRES = 8;
const PITCH_DRIFT_FAC_Q16 = 655;
const HARM_ATT_Q15 = [32440, 31130];
const PLC_RAND_ATTENUATE_V_Q15 = [31130, 26214];
const PLC_RAND_ATTENUATE_UV_Q15 = [32440, 29491];
const MAX_LPC_STABILIZE_ITERATIONS = 16;
const LPC_A_LIMIT_Q24 = 16773022;
const LPC_MIN_INV_GAIN_Q30 = 107374;
const QUANTIZATION_OFFSETS_Q10 = [
    [100, 240],
    [32, 100],
];
const NLSF2A_ORDERING16 = [0, 15, 8, 7, 4, 11, 12, 3, 2, 13, 10, 5, 6, 9, 14, 1];
const NLSF2A_ORDERING10 = [0, 9, 6, 3, 4, 5, 8, 1, 2, 7];
const PE_MIN_LAG_MS = 2;
const PE_MAX_LAG_MS = 18;

const TYPE_NO_VOICE_ACTIVITY = 0;
const TYPE_VOICED = 2;
const CODE_INDEPENDENTLY = 0;
const CODE_INDEPENDENTLY_NO_LTP_SCALING = 1;
const CODE_CONDITIONALLY = 2;

/** lostFlag values of the reference decoder. */
export const FLAG_DECODE_NORMAL = 0;
export const FLAG_PACKET_LOST = 1;
const FLAG_DECODE_LBRR = 2;

interface NlsfCodebook {
    readonly nVectors: number;
    readonly order: number;
    readonly quantStepSizeQ16: number;
    readonly cb1Q8: Uint8Array;
    readonly cb1WghtQ9: Int16Array;
    readonly cb1Icdf: Uint8Array;
    readonly predQ8: Uint8Array;
    readonly ecSel: Uint8Array;
    readonly ecIcdf: Uint8Array;
    readonly deltaMinQ15: Int16Array;
}

const NLSF_CB_NB_MB: NlsfCodebook = {
    nVectors: 32,
    order: 10,
    quantStepSizeQ16: 11796,
    cb1Q8: T.NLSF_CB1_NB_MB_Q8,
    cb1WghtQ9: T.NLSF_CB1_NB_MB_WGHT_Q9,
    cb1Icdf: T.NLSF_CB1_ICDF_NB_MB,
    predQ8: T.NLSF_PRED_NB_MB_Q8,
    ecSel: T.NLSF_CB2_SELECT_NB_MB,
    ecIcdf: T.NLSF_CB2_ICDF_NB_MB,
    deltaMinQ15: T.NLSF_DELTA_MIN_NB_MB_Q15,
};

const NLSF_CB_WB: NlsfCodebook = {
    nVectors: 32,
    order: 16,
    quantStepSizeQ16: 9830,
    cb1Q8: T.NLSF_CB1_WB_Q8,
    cb1WghtQ9: T.NLSF_CB1_WB_WGHT_Q9,
    cb1Icdf: T.NLSF_CB1_ICDF_WB,
    predQ8: T.NLSF_PRED_WB_Q8,
    ecSel: T.NLSF_CB2_SELECT_WB,
    ecIcdf: T.NLSF_CB2_ICDF_WB,
    deltaMinQ15: T.NLSF_DELTA_MIN_WB_Q15,
};

const LTP_GAIN_ICDF = [T.SILK_LTP_GAIN_ICDF_0, T.SILK_LTP_GAIN_ICDF_1, T.SILK_LTP_GAIN_ICDF_2];
const LTP_VQ_Q7 = [T.SILK_LTP_GAIN_VQ_0, T.SILK_LTP_GAIN_VQ_1, T.SILK_LTP_GAIN_VQ_2];
const LBRR_FLAGS_ICDF = [T.SILK_LBRR_FLAGS_2_ICDF, T.SILK_LBRR_FLAGS_3_ICDF];
const SHELL_TABLES = [
    T.SILK_SHELL_CODE_TABLE0,
    T.SILK_SHELL_CODE_TABLE1,
    T.SILK_SHELL_CODE_TABLE2,
    T.SILK_SHELL_CODE_TABLE3,
];

function bwexpander(ar: Int16Array, d: number, chirpQ16: number): void {
    const chirpMinusOneQ16 = chirpQ16 - 65536;
    for (let i = 0; i < d - 1; i++) {
        ar[i] = rshiftRound(Math.imul(chirpQ16, ar[i]!), 16);
        chirpQ16 = (chirpQ16 + rshiftRound(Math.imul(chirpQ16, chirpMinusOneQ16), 16)) | 0;
    }
    ar[d - 1] = rshiftRound(Math.imul(chirpQ16, ar[d - 1]!), 16);
}

function bwexpander32(ar: Int32Array, d: number, chirpQ16: number): void {
    const chirpMinusOneQ16 = chirpQ16 - 65536;
    for (let i = 0; i < d - 1; i++) {
        ar[i] = smulww(chirpQ16, ar[i]!);
        chirpQ16 = (chirpQ16 + rshiftRound(Math.imul(chirpQ16, chirpMinusOneQ16), 16)) | 0;
    }
    ar[d - 1] = smulww(chirpQ16, ar[d - 1]!);
}

const lpcScratchQA = new Int32Array(MAX_LPC_ORDER);

/**
 * Inverse prediction gain in Q30 of A_Q12, or 0 for an unstable filter
 * (silk_LPC_inverse_pred_gain).
 */
function lpcInversePredGain(aQ12: Int16Array, order: number): number {
    const A = lpcScratchQA;
    let dcResponse = 0;
    for (let k = 0; k < order; k++) {
        dcResponse += aQ12[k]!;
        A[k] = aQ12[k]! << 12;
    }
    if (dcResponse >= 4096) return 0;
    let invGainQ30 = 1 << 30;
    for (let k = order - 1; k > 0; k--) {
        if (A[k]! > LPC_A_LIMIT_Q24 || A[k]! < -LPC_A_LIMIT_Q24) return 0;
        const rcQ31 = -(A[k]! << 7) | 0;
        const rcMult1Q30 = ((1 << 30) - smmul(rcQ31, rcQ31)) | 0;
        invGainQ30 = smmul(invGainQ30, rcMult1Q30) << 2;
        if (invGainQ30 < LPC_MIN_INV_GAIN_Q30) return 0;
        const mult2Q = 32 - clz32(Math.abs(rcMult1Q30));
        const rcMult2 = inverse32VarQ(rcMult1Q30, mult2Q + 30);
        for (let n = 0; n < (k + 1) >> 1; n++) {
            const tmp1 = A[n]!;
            const tmp2 = A[k - n - 1]!;
            let tmp64 = mulRoundShift64(
                subSat32(tmp1, mulRoundShift64(tmp2, rcQ31, 31) | 0),
                rcMult2,
                mult2Q,
            );
            if (tmp64 > INT32_MAX || tmp64 < -0x80000000) return 0;
            A[n] = tmp64;
            tmp64 = mulRoundShift64(
                subSat32(tmp2, mulRoundShift64(tmp1, rcQ31, 31) | 0),
                rcMult2,
                mult2Q,
            );
            if (tmp64 > INT32_MAX || tmp64 < -0x80000000) return 0;
            A[k - n - 1] = tmp64;
        }
    }
    if (A[0]! > LPC_A_LIMIT_Q24 || A[0]! < -LPC_A_LIMIT_Q24) return 0;
    const rcQ31 = -(A[0]! << 7) | 0;
    const rcMult1Q30 = ((1 << 30) - smmul(rcQ31, rcQ31)) | 0;
    invGainQ30 = smmul(invGainQ30, rcMult1Q30) << 2;
    if (invGainQ30 < LPC_MIN_INV_GAIN_Q30) return 0;
    return invGainQ30;
}

function lpcFit(aQOut: Int16Array, aQIn: Int32Array, qOut: number, qIn: number, d: number): void {
    let i: number;
    let idx = 0;
    for (i = 0; i < 10; i++) {
        let maxabs = 0;
        for (let k = 0; k < d; k++) {
            const absval = Math.abs(aQIn[k]!);
            if (absval > maxabs) {
                maxabs = absval;
                idx = k;
            }
        }
        maxabs = rshiftRound(maxabs, qIn - qOut);
        if (maxabs > 32767) {
            maxabs = Math.min(maxabs, 163838);
            const chirpQ16 = 65470 - div32((maxabs - 32767) << 14, Math.imul(maxabs, idx + 1) >> 2);
            bwexpander32(aQIn, d, chirpQ16);
        } else break;
    }
    if (i === 10) {
        for (let k = 0; k < d; k++) {
            aQOut[k] = sat16(rshiftRound(aQIn[k]!, qIn - qOut));
            aQIn[k] = aQOut[k]! << (qIn - qOut);
        }
    } else {
        for (let k = 0; k < d; k++) aQOut[k] = rshiftRound(aQIn[k]!, qIn - qOut);
    }
}

const nlsf2aCos = new Int32Array(MAX_LPC_ORDER);
const nlsf2aP = new Int32Array(MAX_LPC_ORDER / 2 + 1);
const nlsf2aQ = new Int32Array(MAX_LPC_ORDER / 2 + 1);
const nlsf2aA32 = new Int32Array(MAX_LPC_ORDER);

function nlsf2aFindPoly(out: Int32Array, cLSF: Int32Array, offset: number, dd: number): void {
    out[0] = 1 << 16;
    out[1] = -cLSF[offset]!;
    for (let k = 1; k < dd; k++) {
        const ftmp = cLSF[offset + 2 * k]!;
        out[k + 1] = ((out[k - 1]! << 1) - (mulRoundShift64(ftmp, out[k]!, 16) | 0)) | 0;
        for (let n = k; n > 1; n--)
            out[n] = (out[n]! + out[n - 2]! - (mulRoundShift64(ftmp, out[n - 1]!, 16) | 0)) | 0;
        out[1] = (out[1]! - ftmp) | 0;
    }
}

/** NLSF (Q15) to LPC coefficients (Q12), silk_NLSF2A. */
function nlsf2a(aQ12: Int16Array, nlsf: Int16Array, d: number): void {
    const ordering = d === 16 ? NLSF2A_ORDERING16 : NLSF2A_ORDERING10;
    for (let k = 0; k < d; k++) {
        const fInt = nlsf[k]! >> 8;
        const fFrac = nlsf[k]! - (fInt << 8);
        const cosVal = T.SILK_LSF_COS_TAB_Q12[fInt]!;
        const delta = T.SILK_LSF_COS_TAB_Q12[fInt + 1]! - cosVal;
        nlsf2aCos[ordering[k]!] = rshiftRound((cosVal << 8) + Math.imul(delta, fFrac), 4);
    }
    const dd = d >> 1;
    nlsf2aFindPoly(nlsf2aP, nlsf2aCos, 0, dd);
    nlsf2aFindPoly(nlsf2aQ, nlsf2aCos, 1, dd);
    for (let k = 0; k < dd; k++) {
        const pTmp = (nlsf2aP[k + 1]! + nlsf2aP[k]!) | 0;
        const qTmp = (nlsf2aQ[k + 1]! - nlsf2aQ[k]!) | 0;
        nlsf2aA32[k] = (-qTmp - pTmp) | 0;
        nlsf2aA32[d - k - 1] = (qTmp - pTmp) | 0;
    }
    lpcFit(aQ12, nlsf2aA32, 12, 17, d);
    for (let i = 0; lpcInversePredGain(aQ12, d) === 0 && i < MAX_LPC_STABILIZE_ITERATIONS; i++) {
        bwexpander32(nlsf2aA32, d, 65536 - (2 << i));
        for (let k = 0; k < d; k++) aQ12[k] = rshiftRound(nlsf2aA32[k]!, 5);
    }
}

function nlsfStabilize(nlsf: Int16Array, deltaMin: Int16Array, L: number): void {
    let loops: number;
    for (loops = 0; loops < 20; loops++) {
        let minDiff = nlsf[0]! - deltaMin[0]!;
        let I = 0;
        for (let i = 1; i <= L - 1; i++) {
            const diff = nlsf[i]! - (nlsf[i - 1]! + deltaMin[i]!);
            if (diff < minDiff) {
                minDiff = diff;
                I = i;
            }
        }
        const diff = (1 << 15) - (nlsf[L - 1]! + deltaMin[L]!);
        if (diff < minDiff) {
            minDiff = diff;
            I = L;
        }
        if (minDiff >= 0) return;
        if (I === 0) nlsf[0] = deltaMin[0]!;
        else if (I === L) nlsf[L - 1] = (1 << 15) - deltaMin[L]!;
        else {
            let minCenter = 0;
            for (let k = 0; k < I; k++) minCenter += deltaMin[k]!;
            minCenter += deltaMin[I]! >> 1;
            let maxCenter = 1 << 15;
            for (let k = L; k > I; k--) maxCenter -= deltaMin[k]!;
            maxCenter -= deltaMin[I]! >> 1;
            const center = limit(rshiftRound(nlsf[I - 1]! + nlsf[I]!, 1), minCenter, maxCenter);
            nlsf[I - 1] = center - (deltaMin[I]! >> 1);
            nlsf[I] = nlsf[I - 1]! + deltaMin[I]!;
        }
    }
    if (loops === 20) {
        for (let i = 1; i < L; i++) {
            const value = nlsf[i]!;
            let j: number;
            for (j = i - 1; j >= 0 && value < nlsf[j]!; j--) nlsf[j + 1] = nlsf[j]!;
            nlsf[j + 1] = value;
        }
        nlsf[0] = Math.max(nlsf[0]!, deltaMin[0]!);
        for (let i = 1; i < L; i++)
            nlsf[i] = Math.max(nlsf[i]!, sat16(nlsf[i - 1]! + deltaMin[i]!));
        nlsf[L - 1] = Math.min(nlsf[L - 1]!, (1 << 15) - deltaMin[L]!);
        for (let i = L - 2; i >= 0; i--)
            nlsf[i] = Math.min(nlsf[i]!, nlsf[i + 1]! - deltaMin[i + 1]!);
    }
}

function lpcAnalysisFilter(
    out: Int16Array,
    outOffset: number,
    input: Int16Array,
    inOffset: number,
    B: Int16Array,
    len: number,
    d: number,
): void {
    for (let ix = d; ix < len; ix++) {
        const at = inOffset + ix - 1;
        let out32Q12 = smulbb(input[at]!, B[0]!);
        out32Q12 = smlabb(out32Q12, input[at - 1]!, B[1]!);
        out32Q12 = smlabb(out32Q12, input[at - 2]!, B[2]!);
        out32Q12 = smlabb(out32Q12, input[at - 3]!, B[3]!);
        out32Q12 = smlabb(out32Q12, input[at - 4]!, B[4]!);
        out32Q12 = smlabb(out32Q12, input[at - 5]!, B[5]!);
        for (let j = 6; j < d; j += 2) {
            out32Q12 = smlabb(out32Q12, input[at - j]!, B[j]!);
            out32Q12 = smlabb(out32Q12, input[at - j - 1]!, B[j + 1]!);
        }
        out32Q12 = ((input[at + 1]! << 12) - out32Q12) | 0;
        out[outOffset + ix] = sat16(rshiftRound(out32Q12, 12));
    }
    out.fill(0, outOffset, outOffset + d);
}

/** Energy and its right shift of x[offset, offset + len), silk_sum_sqr_shift. */
function sumSqrShift(x: Int16Array, offset: number, len: number): [number, number] {
    let shft = 31 - clz32(len);
    let nrg = len;
    let i: number;
    for (i = 0; i < len - 1; i += 2) {
        let tmp = Math.imul(x[offset + i]!, x[offset + i]!);
        tmp = (tmp + Math.imul(x[offset + i + 1]!, x[offset + i + 1]!)) | 0;
        nrg = (nrg + (tmp >>> shft)) | 0;
    }
    if (i < len) nrg = (nrg + (Math.imul(x[offset + i]!, x[offset + i]!) >>> shft)) | 0;
    shft = Math.max(0, shft + 3 - clz32(nrg));
    nrg = 0;
    for (i = 0; i < len - 1; i += 2) {
        let tmp = Math.imul(x[offset + i]!, x[offset + i]!);
        tmp = (tmp + Math.imul(x[offset + i + 1]!, x[offset + i + 1]!)) | 0;
        nrg = (nrg + (tmp >>> shft)) | 0;
    }
    if (i < len) nrg = (nrg + (Math.imul(x[offset + i]!, x[offset + i]!) >>> shft)) | 0;
    return [nrg, shft];
}

/** One SILK channel: the state of silk_decoder_state plus its scratch buffers. */
class SilkChannel {
    prevGainQ16 = 65536;
    readonly excQ14 = new Int32Array(MAX_FRAME_LENGTH);
    readonly sLPCQ14Buf = new Int32Array(MAX_LPC_ORDER);
    readonly outBuf = new Int16Array(MAX_FRAME_LENGTH + 2 * MAX_SUB_FRAME_LENGTH);
    lagPrev = 0;
    lastGainIndex = 0;
    fsKHz = 0;
    nbSubfr = 0;
    frameLength = 0;
    subfrLength = 0;
    ltpMemLength = 0;
    lpcOrder = 0;
    readonly prevNLSFQ15 = new Int16Array(MAX_LPC_ORDER);
    firstFrameAfterReset = 1;
    pitchLagLowBitsIcdf: Uint8Array = T.SILK_UNIFORM4_ICDF;
    pitchContourIcdf: Uint8Array = T.SILK_PITCH_CONTOUR_NB_ICDF;
    nFramesDecoded = 0;
    nFramesPerPacket = 0;
    ecPrevSignalType = 0;
    ecPrevLagIndex = 0;
    readonly vadFlags = new Int32Array(3);
    lbrrFlag = 0;
    readonly lbrrFlags = new Int32Array(3);
    readonly resampler = new SilkResampler();
    nlsfCB: NlsfCodebook = NLSF_CB_NB_MB;
    lossCnt = 0;
    prevSignalType = 0;

    readonly gainsIndices = new Int8Array(MAX_NB_SUBFR);
    readonly ltpIndex = new Int8Array(MAX_NB_SUBFR);
    readonly nlsfIndices = new Int8Array(MAX_LPC_ORDER + 1);
    lagIndex = 0;
    contourIndex = 0;
    signalType = 0;
    quantOffsetType = 0;
    nlsfInterpCoefQ2 = 0;
    perIndex = 0;
    ltpScaleIndex = 0;
    seed = 0;

    readonly cngExcBufQ14 = new Int32Array(MAX_FRAME_LENGTH);
    readonly cngSmthNLSFQ15 = new Int16Array(MAX_LPC_ORDER);
    readonly cngSynthState = new Int32Array(MAX_LPC_ORDER);
    cngSmthGainQ16 = 0;
    cngRandSeed = 0;
    cngFsKHz = 0;

    plcPitchLQ8 = 0;
    readonly plcLTPCoefQ14 = new Int16Array(LTP_ORDER);
    readonly plcPrevLPCQ12 = new Int16Array(MAX_LPC_ORDER);
    plcLastFrameLost = 0;
    plcRandSeed = 0;
    plcRandScaleQ14 = 0;
    plcConcEnergy = 0;
    plcConcEnergyShift = 0;
    plcPrevLTPScaleQ14 = 0;
    readonly plcPrevGainQ16 = new Int32Array(2);
    plcFsKHz = 0;
    plcNbSubfr = 0;
    plcSubfrLength = 0;

    readonly pitchL = new Int32Array(MAX_NB_SUBFR);
    readonly gainsQ16 = new Int32Array(MAX_NB_SUBFR);
    readonly predCoefQ12 = [new Int16Array(MAX_LPC_ORDER), new Int16Array(MAX_LPC_ORDER)];
    readonly ltpCoefQ14 = new Int16Array(LTP_ORDER * MAX_NB_SUBFR);
    ltpScaleQ14 = 0;

    readonly pulses = new Int16Array(MAX_FRAME_LENGTH);
    private readonly sumPulses = new Int32Array(MAX_NB_SHELL_BLOCKS);
    private readonly nLshifts = new Int32Array(MAX_NB_SHELL_BLOCKS);
    private readonly signIcdf = new Uint8Array(2);
    private readonly sLTP = new Int16Array(MAX_FRAME_LENGTH);
    private readonly sLTPQ15 = new Int32Array(2 * MAX_FRAME_LENGTH);
    private readonly resQ14 = new Int32Array(MAX_SUB_FRAME_LENGTH);
    private readonly sLPCQ14 = new Int32Array(MAX_SUB_FRAME_LENGTH + MAX_LPC_ORDER);
    private readonly nlsfQ15 = new Int16Array(MAX_LPC_ORDER);
    private readonly nlsf0Q15 = new Int16Array(MAX_LPC_ORDER);
    private readonly ecIx = new Int16Array(MAX_LPC_ORDER);
    private readonly predQ8 = new Uint8Array(MAX_LPC_ORDER);
    private readonly resQ10 = new Int16Array(MAX_LPC_ORDER);
    private readonly plcAQ12 = new Int16Array(MAX_LPC_ORDER);
    private readonly plcExcBuf = new Int16Array(2 * MAX_SUB_FRAME_LENGTH);
    private readonly cngSigQ14 = new Int32Array(MAX_FRAME_LENGTH + MAX_LPC_ORDER);
    private readonly cngAQ12 = new Int16Array(MAX_LPC_ORDER);

    reset(): void {
        this.prevGainQ16 = 65536;
        this.excQ14.fill(0);
        this.sLPCQ14Buf.fill(0);
        this.outBuf.fill(0);
        this.lagPrev = 0;
        this.lastGainIndex = 0;
        this.fsKHz = 0;
        this.nbSubfr = 0;
        this.frameLength = 0;
        this.subfrLength = 0;
        this.ltpMemLength = 0;
        this.lpcOrder = 0;
        this.prevNLSFQ15.fill(0);
        this.firstFrameAfterReset = 1;
        this.nFramesDecoded = 0;
        this.nFramesPerPacket = 0;
        this.ecPrevSignalType = 0;
        this.ecPrevLagIndex = 0;
        this.vadFlags.fill(0);
        this.lbrrFlag = 0;
        this.lbrrFlags.fill(0);
        this.lossCnt = 0;
        this.prevSignalType = 0;
        this.signalType = 0;
        this.cngExcBufQ14.fill(0);
        this.cngSynthState.fill(0);
        this.cngFsKHz = 0;
        this.cngReset();
        this.plcLTPCoefQ14.fill(0);
        this.plcPrevLPCQ12.fill(0);
        this.plcLastFrameLost = 0;
        this.plcRandSeed = 0;
        this.plcRandScaleQ14 = 0;
        this.plcConcEnergy = 0;
        this.plcConcEnergyShift = 0;
        this.plcPrevLTPScaleQ14 = 0;
        this.plcFsKHz = 0;
        this.plcReset();
    }

    private cngReset(): void {
        const step = div32(32767, this.lpcOrder + 1);
        let acc = 0;
        for (let i = 0; i < this.lpcOrder; i++) {
            acc += step;
            this.cngSmthNLSFQ15[i] = acc;
        }
        this.cngSmthGainQ16 = 0;
        this.cngRandSeed = 3176576;
    }

    private plcReset(): void {
        this.plcPitchLQ8 = this.frameLength << 7;
        this.plcPrevGainQ16[0] = 1 << 16;
        this.plcPrevGainQ16[1] = 1 << 16;
        this.plcSubfrLength = 20;
        this.plcNbSubfr = 2;
    }

    setFs(fsKHz: number): void {
        this.subfrLength = 5 * fsKHz;
        const frameLength = this.nbSubfr * this.subfrLength;
        if (this.fsKHz !== fsKHz) this.resampler.init(fsKHz);
        if (this.fsKHz !== fsKHz || frameLength !== this.frameLength) {
            if (fsKHz === 8) {
                this.pitchContourIcdf =
                    this.nbSubfr === MAX_NB_SUBFR
                        ? T.SILK_PITCH_CONTOUR_NB_ICDF
                        : T.SILK_PITCH_CONTOUR_10MS_NB_ICDF;
            } else {
                this.pitchContourIcdf =
                    this.nbSubfr === MAX_NB_SUBFR
                        ? T.SILK_PITCH_CONTOUR_ICDF
                        : T.SILK_PITCH_CONTOUR_10MS_ICDF;
            }
            if (this.fsKHz !== fsKHz) {
                this.ltpMemLength = LTP_MEM_LENGTH_MS * fsKHz;
                if (fsKHz === 8 || fsKHz === 12) {
                    this.lpcOrder = 10;
                    this.nlsfCB = NLSF_CB_NB_MB;
                } else {
                    this.lpcOrder = MAX_LPC_ORDER;
                    this.nlsfCB = NLSF_CB_WB;
                }
                this.pitchLagLowBitsIcdf =
                    fsKHz === 16
                        ? T.SILK_UNIFORM8_ICDF
                        : fsKHz === 12
                          ? T.SILK_UNIFORM6_ICDF
                          : T.SILK_UNIFORM4_ICDF;
                this.firstFrameAfterReset = 1;
                this.lagPrev = 100;
                this.lastGainIndex = 10;
                this.prevSignalType = TYPE_NO_VOICE_ACTIVITY;
                this.outBuf.fill(0);
                this.sLPCQ14Buf.fill(0);
            }
            this.fsKHz = fsKHz;
            this.frameLength = frameLength;
        }
    }

    decodeIndices(
        dec: RangeDecoder,
        frameIndex: number,
        decodeLBRR: boolean,
        condCoding: number,
    ): void {
        let ix: number;
        if (decodeLBRR || this.vadFlags[frameIndex])
            ix = dec.decodeIcdf(T.SILK_TYPE_OFFSET_VAD_ICDF) + 2;
        else ix = dec.decodeIcdf(T.SILK_TYPE_OFFSET_NO_VAD_ICDF);
        this.signalType = ix >> 1;
        this.quantOffsetType = ix & 1;
        if (condCoding === CODE_CONDITIONALLY) {
            this.gainsIndices[0] = dec.decodeIcdf(T.SILK_DELTA_GAIN_ICDF);
        } else {
            this.gainsIndices[0] = dec.decodeIcdf(T.SILK_GAIN_ICDF, this.signalType * 8) << 3;
            this.gainsIndices[0] = this.gainsIndices[0]! + dec.decodeIcdf(T.SILK_UNIFORM8_ICDF);
        }
        for (let i = 1; i < this.nbSubfr; i++)
            this.gainsIndices[i] = dec.decodeIcdf(T.SILK_DELTA_GAIN_ICDF);
        const cb = this.nlsfCB;
        this.nlsfIndices[0] = dec.decodeIcdf(cb.cb1Icdf, (this.signalType >> 1) * cb.nVectors);
        this.nlsfUnpack(this.nlsfIndices[0]!);
        for (let i = 0; i < cb.order; i++) {
            let value = dec.decodeIcdf(cb.ecIcdf, this.ecIx[i]!);
            if (value === 0) value -= dec.decodeIcdf(T.SILK_NLSF_EXT_ICDF);
            else if (value === 2 * NLSF_QUANT_MAX_AMPLITUDE)
                value += dec.decodeIcdf(T.SILK_NLSF_EXT_ICDF);
            this.nlsfIndices[i + 1] = value - NLSF_QUANT_MAX_AMPLITUDE;
        }
        if (this.nbSubfr === MAX_NB_SUBFR)
            this.nlsfInterpCoefQ2 = dec.decodeIcdf(T.SILK_NLSF_INTERPOLATION_FACTOR_ICDF);
        else this.nlsfInterpCoefQ2 = 4;
        if (this.signalType === TYPE_VOICED) {
            let decodeAbsoluteLagIndex = true;
            if (condCoding === CODE_CONDITIONALLY && this.ecPrevSignalType === TYPE_VOICED) {
                let deltaLagIndex = dec.decodeIcdf(T.SILK_PITCH_DELTA_ICDF);
                if (deltaLagIndex > 0) {
                    deltaLagIndex -= 9;
                    this.lagIndex = this.ecPrevLagIndex + deltaLagIndex;
                    decodeAbsoluteLagIndex = false;
                }
            }
            if (decodeAbsoluteLagIndex) {
                this.lagIndex = dec.decodeIcdf(T.SILK_PITCH_LAG_ICDF) * (this.fsKHz >> 1);
                this.lagIndex += dec.decodeIcdf(this.pitchLagLowBitsIcdf);
            }
            this.ecPrevLagIndex = this.lagIndex;
            this.contourIndex = dec.decodeIcdf(this.pitchContourIcdf);
            this.perIndex = dec.decodeIcdf(T.SILK_LTP_PER_INDEX_ICDF);
            for (let k = 0; k < this.nbSubfr; k++)
                this.ltpIndex[k] = dec.decodeIcdf(LTP_GAIN_ICDF[this.perIndex]!);
            this.ltpScaleIndex =
                condCoding === CODE_INDEPENDENTLY ? dec.decodeIcdf(T.SILK_LTP_SCALE_ICDF) : 0;
        }
        this.ecPrevSignalType = this.signalType;
        this.seed = dec.decodeIcdf(T.SILK_UNIFORM4_ICDF);
    }

    private nlsfUnpack(cb1Index: number): void {
        const cb = this.nlsfCB;
        let sel = (cb1Index * cb.order) >> 1;
        for (let i = 0; i < cb.order; i += 2) {
            const entry = cb.ecSel[sel++]!;
            this.ecIx[i] = ((entry >> 1) & 7) * (2 * NLSF_QUANT_MAX_AMPLITUDE + 1);
            this.predQ8[i] = cb.predQ8[i + (entry & 1) * (cb.order - 1)]!;
            this.ecIx[i + 1] = ((entry >> 5) & 7) * (2 * NLSF_QUANT_MAX_AMPLITUDE + 1);
            this.predQ8[i + 1] = cb.predQ8[i + ((entry >> 4) & 1) * (cb.order - 1) + 1]!;
        }
    }

    decodePulses(dec: RangeDecoder, pulses: Int16Array): void {
        const signalType = this.signalType;
        const frameLength = this.frameLength;
        const rateLevelIndex = dec.decodeIcdf(T.SILK_RATE_LEVELS_ICDF, (signalType >> 1) * 9);
        let iter = frameLength >> 4;
        if (iter * SHELL_CODEC_FRAME_LENGTH < frameLength) iter++;
        const sumPulses = this.sumPulses;
        const nLshifts = this.nLshifts;
        const cdfOffset = rateLevelIndex * 18;
        for (let i = 0; i < iter; i++) {
            nLshifts[i] = 0;
            sumPulses[i] = dec.decodeIcdf(T.SILK_PULSES_PER_BLOCK_ICDF, cdfOffset);
            while (sumPulses[i] === SILK_MAX_PULSES + 1) {
                nLshifts[i]!++;
                sumPulses[i] = dec.decodeIcdf(
                    T.SILK_PULSES_PER_BLOCK_ICDF,
                    (N_RATE_LEVELS - 1) * 18 + (nLshifts[i] === 10 ? 1 : 0),
                );
            }
        }
        for (let i = 0; i < iter; i++) {
            if (sumPulses[i]! > 0)
                this.shellDecode(pulses, i * SHELL_CODEC_FRAME_LENGTH, dec, sumPulses[i]!);
            else pulses.fill(0, i * SHELL_CODEC_FRAME_LENGTH, (i + 1) * SHELL_CODEC_FRAME_LENGTH);
        }
        for (let i = 0; i < iter; i++) {
            if (nLshifts[i]! > 0) {
                const nLS = nLshifts[i]!;
                const base = i * SHELL_CODEC_FRAME_LENGTH;
                for (let k = 0; k < SHELL_CODEC_FRAME_LENGTH; k++) {
                    let absQ = pulses[base + k]!;
                    for (let j = 0; j < nLS; j++) {
                        absQ <<= 1;
                        absQ += dec.decodeIcdf(T.SILK_LSB_ICDF);
                    }
                    pulses[base + k] = absQ;
                }
                sumPulses[i] = sumPulses[i]! | (nLS << 5);
            }
        }
        this.decodeSigns(dec, pulses, frameLength, signalType, this.quantOffsetType, sumPulses);
    }

    private shellDecode(
        pulses: Int16Array,
        offset: number,
        dec: RangeDecoder,
        pulses4: number,
    ): void {
        const split = (p: number, table: Uint8Array): number =>
            p > 0 ? dec.decodeIcdf(table, T.SILK_SHELL_CODE_TABLE_OFFSETS[p]!) : 0;
        const p3a = split(pulses4, SHELL_TABLES[3]!);
        const p3b = pulses4 - p3a;
        const p2a = split(p3a, SHELL_TABLES[2]!);
        const p2b = p3a - p2a;
        const p1a = split(p2a, SHELL_TABLES[1]!);
        const p1b = p2a - p1a;
        let c = split(p1a, SHELL_TABLES[0]!);
        pulses[offset] = c;
        pulses[offset + 1] = p1a - c;
        c = split(p1b, SHELL_TABLES[0]!);
        pulses[offset + 2] = c;
        pulses[offset + 3] = p1b - c;
        const p1c = split(p2b, SHELL_TABLES[1]!);
        const p1d = p2b - p1c;
        c = split(p1c, SHELL_TABLES[0]!);
        pulses[offset + 4] = c;
        pulses[offset + 5] = p1c - c;
        c = split(p1d, SHELL_TABLES[0]!);
        pulses[offset + 6] = c;
        pulses[offset + 7] = p1d - c;
        const p2c = split(p3b, SHELL_TABLES[2]!);
        const p2d = p3b - p2c;
        const p1e = split(p2c, SHELL_TABLES[1]!);
        const p1f = p2c - p1e;
        c = split(p1e, SHELL_TABLES[0]!);
        pulses[offset + 8] = c;
        pulses[offset + 9] = p1e - c;
        c = split(p1f, SHELL_TABLES[0]!);
        pulses[offset + 10] = c;
        pulses[offset + 11] = p1f - c;
        const p1g = split(p2d, SHELL_TABLES[1]!);
        const p1h = p2d - p1g;
        c = split(p1g, SHELL_TABLES[0]!);
        pulses[offset + 12] = c;
        pulses[offset + 13] = p1g - c;
        c = split(p1h, SHELL_TABLES[0]!);
        pulses[offset + 14] = c;
        pulses[offset + 15] = p1h - c;
    }

    private decodeSigns(
        dec: RangeDecoder,
        pulses: Int16Array,
        length: number,
        signalType: number,
        quantOffsetType: number,
        sumPulses: Int32Array,
    ): void {
        const icdf = this.signIcdf;
        icdf[1] = 0;
        const icdfBase = 7 * (quantOffsetType + (signalType << 1));
        length = (length + SHELL_CODEC_FRAME_LENGTH / 2) >> 4;
        let q = 0;
        for (let i = 0; i < length; i++) {
            const p = sumPulses[i]!;
            if (p > 0) {
                icdf[0] = T.SILK_SIGN_ICDF[icdfBase + Math.min(p & 0x1f, 6)]!;
                for (let j = 0; j < SHELL_CODEC_FRAME_LENGTH; j++) {
                    if (pulses[q + j]! > 0)
                        pulses[q + j] = pulses[q + j]! * ((dec.decodeIcdf(icdf) << 1) - 1);
                }
            }
            q += SHELL_CODEC_FRAME_LENGTH;
        }
    }

    decodeParameters(condCoding: number): void {
        this.gainsDequant(condCoding === CODE_CONDITIONALLY);
        this.nlsfDecode(this.nlsfQ15);
        nlsf2a(this.predCoefQ12[1]!, this.nlsfQ15, this.lpcOrder);
        if (this.firstFrameAfterReset === 1) this.nlsfInterpCoefQ2 = 4;
        if (this.nlsfInterpCoefQ2 < 4) {
            for (let i = 0; i < this.lpcOrder; i++)
                this.nlsf0Q15[i] =
                    this.prevNLSFQ15[i]! +
                    ((Math.imul(this.nlsfInterpCoefQ2, this.nlsfQ15[i]! - this.prevNLSFQ15[i]!) >>
                        2) |
                        0);
            nlsf2a(this.predCoefQ12[0]!, this.nlsf0Q15, this.lpcOrder);
        } else {
            this.predCoefQ12[0]!.set(this.predCoefQ12[1]!.subarray(0, this.lpcOrder));
        }
        this.prevNLSFQ15.set(this.nlsfQ15.subarray(0, this.lpcOrder));
        if (this.lossCnt) {
            bwexpander(this.predCoefQ12[0]!, this.lpcOrder, BWE_AFTER_LOSS_Q16);
            bwexpander(this.predCoefQ12[1]!, this.lpcOrder, BWE_AFTER_LOSS_Q16);
        }
        if (this.signalType === TYPE_VOICED) {
            this.decodePitch();
            const cbk = LTP_VQ_Q7[this.perIndex]!;
            for (let k = 0; k < this.nbSubfr; k++) {
                const ix = this.ltpIndex[k]!;
                for (let i = 0; i < LTP_ORDER; i++)
                    this.ltpCoefQ14[k * LTP_ORDER + i] = cbk[ix * LTP_ORDER + i]! << 7;
            }
            this.ltpScaleQ14 = T.SILK_LTP_SCALES_TABLE_Q14[this.ltpScaleIndex]!;
        } else {
            this.pitchL.fill(0);
            this.ltpCoefQ14.fill(0);
            this.perIndex = 0;
            this.ltpScaleQ14 = 0;
        }
    }

    private gainsDequant(conditional: boolean): void {
        let prev = this.lastGainIndex;
        for (let k = 0; k < this.nbSubfr; k++) {
            const ind = this.gainsIndices[k]!;
            if (k === 0 && !conditional) prev = Math.max(ind, prev - 16);
            else {
                const indTmp = ind + MIN_DELTA_GAIN_QUANT;
                const doubleStepSizeThreshold = 2 * MAX_DELTA_GAIN_QUANT - N_LEVELS_QGAIN + prev;
                if (indTmp > doubleStepSizeThreshold)
                    prev += (indTmp << 1) - doubleStepSizeThreshold;
                else prev += indTmp;
            }
            prev = limit(prev, 0, N_LEVELS_QGAIN - 1);
            this.gainsQ16[k] = log2lin(
                Math.min(smulwb(GAIN_INV_SCALE_Q16, prev) + GAIN_OFFSET, 3967),
            );
        }
        this.lastGainIndex = prev;
    }

    private nlsfDecode(out: Int16Array): void {
        const cb = this.nlsfCB;
        const indices = this.nlsfIndices;
        this.nlsfUnpack(indices[0]!);
        const res = this.resQ10;
        let outQ10 = 0;
        for (let i = cb.order - 1; i >= 0; i--) {
            const predQ10 = smulbb(outQ10, this.predQ8[i]!) >> 8;
            outQ10 = indices[i + 1]! << 10;
            if (outQ10 > 0) outQ10 -= NLSF_QUANT_LEVEL_ADJ_Q10;
            else if (outQ10 < 0) outQ10 += NLSF_QUANT_LEVEL_ADJ_Q10;
            outQ10 = smlawb(predQ10, outQ10, cb.quantStepSizeQ16);
            res[i] = outQ10;
        }
        const base = indices[0]! * cb.order;
        for (let i = 0; i < cb.order; i++) {
            const value =
                (div32(res[i]! << 14, cb.cb1WghtQ9[base + i]!) + (cb.cb1Q8[base + i]! << 7)) | 0;
            out[i] = limit(value, 0, 32767);
        }
        nlsfStabilize(out, cb.deltaMinQ15, cb.order);
    }

    private decodePitch(): void {
        let table: Int8Array;
        let cbkSize: number;
        if (this.fsKHz === 8) {
            if (this.nbSubfr === MAX_NB_SUBFR) {
                table = T.SILK_CB_LAGS_STAGE2;
                cbkSize = 11;
            } else {
                table = T.SILK_CB_LAGS_STAGE2_10MS;
                cbkSize = 3;
            }
        } else if (this.nbSubfr === MAX_NB_SUBFR) {
            table = T.SILK_CB_LAGS_STAGE3;
            cbkSize = 34;
        } else {
            table = T.SILK_CB_LAGS_STAGE3_10MS;
            cbkSize = 12;
        }
        const minLag = PE_MIN_LAG_MS * this.fsKHz;
        const maxLag = PE_MAX_LAG_MS * this.fsKHz;
        const lag = minLag + this.lagIndex;
        for (let k = 0; k < this.nbSubfr; k++)
            this.pitchL[k] = limit(lag + table[k * cbkSize + this.contourIndex]!, minLag, maxLag);
    }

    decodeCore(xq: Int16Array, xqOffset: number, pulses: Int16Array): void {
        const lpcOrder = this.lpcOrder;
        const subfrLength = this.subfrLength;
        const ltpMemLength = this.ltpMemLength;
        const excQ14 = this.excQ14;
        const sLTP = this.sLTP;
        const sLTPQ15 = this.sLTPQ15;
        const sLPCQ14 = this.sLPCQ14;
        const offsetQ10 = QUANTIZATION_OFFSETS_Q10[this.signalType >> 1]![this.quantOffsetType]!;
        const nlsfInterpolationFlag = this.nlsfInterpCoefQ2 < 4;
        let randSeed = this.seed;
        for (let i = 0; i < this.frameLength; i++) {
            randSeed = rand(randSeed);
            let value = pulses[i]! << 14;
            if (value > 0) value -= QUANT_LEVEL_ADJUST_Q10 << 4;
            else if (value < 0) value += QUANT_LEVEL_ADJUST_Q10 << 4;
            value += offsetQ10 << 4;
            if (randSeed < 0) value = -value;
            excQ14[i] = value;
            randSeed = (randSeed + pulses[i]!) | 0;
        }
        sLPCQ14.set(this.sLPCQ14Buf, 0);
        let excOffset = 0;
        let pxq = xqOffset;
        let sLTPBufIdx = ltpMemLength;
        for (let k = 0; k < this.nbSubfr; k++) {
            let resQ14: Int32Array = this.resQ14;
            let resOffset = 0;
            const AQ12 = this.predCoefQ12[k >> 1]!;
            const bOffset = k * LTP_ORDER;
            const BQ14 = this.ltpCoefQ14;
            let signalType = this.signalType;
            const gainQ10 = this.gainsQ16[k]! >> 6;
            let invGainQ31 = inverse32VarQ(this.gainsQ16[k]!, 47);
            let gainAdjQ16: number;
            if (this.gainsQ16[k] !== this.prevGainQ16) {
                gainAdjQ16 = div32VarQ(this.prevGainQ16, this.gainsQ16[k]!, 16);
                for (let i = 0; i < MAX_LPC_ORDER; i++)
                    sLPCQ14[i] = smulww(gainAdjQ16, sLPCQ14[i]!);
            } else gainAdjQ16 = 1 << 16;
            this.prevGainQ16 = this.gainsQ16[k]!;
            if (
                this.lossCnt &&
                this.prevSignalType === TYPE_VOICED &&
                this.signalType !== TYPE_VOICED &&
                k < 2
            ) {
                BQ14.fill(0, bOffset, bOffset + LTP_ORDER);
                BQ14[bOffset + 2] = 4096;
                signalType = TYPE_VOICED;
                this.pitchL[k] = this.lagPrev;
            }
            let lag = 0;
            if (signalType === TYPE_VOICED) {
                lag = this.pitchL[k]!;
                if (k === 0 || (k === 2 && nlsfInterpolationFlag)) {
                    const startIdx = ltpMemLength - lag - lpcOrder - (LTP_ORDER >> 1);
                    if (k === 2)
                        this.outBuf.set(
                            xq.subarray(xqOffset, xqOffset + 2 * subfrLength),
                            ltpMemLength,
                        );
                    lpcAnalysisFilter(
                        sLTP,
                        startIdx,
                        this.outBuf,
                        startIdx + k * subfrLength,
                        AQ12,
                        ltpMemLength - startIdx,
                        lpcOrder,
                    );
                    if (k === 0) invGainQ31 = smulwb(invGainQ31, this.ltpScaleQ14) << 2;
                    for (let i = 0; i < lag + (LTP_ORDER >> 1); i++)
                        sLTPQ15[sLTPBufIdx - i - 1] = smulwb(
                            invGainQ31,
                            sLTP[ltpMemLength - i - 1]!,
                        );
                } else if (gainAdjQ16 !== 1 << 16) {
                    for (let i = 0; i < lag + (LTP_ORDER >> 1); i++)
                        sLTPQ15[sLTPBufIdx - i - 1] = smulww(
                            gainAdjQ16,
                            sLTPQ15[sLTPBufIdx - i - 1]!,
                        );
                }
            }
            if (signalType === TYPE_VOICED) {
                let predLag = sLTPBufIdx - lag + (LTP_ORDER >> 1);
                const b0 = BQ14[bOffset]!;
                const b1 = BQ14[bOffset + 1]!;
                const b2 = BQ14[bOffset + 2]!;
                const b3 = BQ14[bOffset + 3]!;
                const b4 = BQ14[bOffset + 4]!;
                for (let i = 0; i < subfrLength; i++) {
                    let ltpPredQ13 = 2;
                    ltpPredQ13 = smlawb(ltpPredQ13, sLTPQ15[predLag]!, b0);
                    ltpPredQ13 = smlawb(ltpPredQ13, sLTPQ15[predLag - 1]!, b1);
                    ltpPredQ13 = smlawb(ltpPredQ13, sLTPQ15[predLag - 2]!, b2);
                    ltpPredQ13 = smlawb(ltpPredQ13, sLTPQ15[predLag - 3]!, b3);
                    ltpPredQ13 = smlawb(ltpPredQ13, sLTPQ15[predLag - 4]!, b4);
                    predLag++;
                    resQ14[i] = (excQ14[excOffset + i]! + (ltpPredQ13 << 1)) | 0;
                    sLTPQ15[sLTPBufIdx] = resQ14[i]! << 1;
                    sLTPBufIdx++;
                }
            } else {
                resQ14 = excQ14;
                resOffset = excOffset;
            }
            for (let i = 0; i < subfrLength; i++) {
                const at = MAX_LPC_ORDER + i;
                let lpcPredQ10 = lpcOrder >> 1;
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 1]!, AQ12[0]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 2]!, AQ12[1]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 3]!, AQ12[2]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 4]!, AQ12[3]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 5]!, AQ12[4]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 6]!, AQ12[5]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 7]!, AQ12[6]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 8]!, AQ12[7]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 9]!, AQ12[8]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 10]!, AQ12[9]!);
                if (lpcOrder === 16) {
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 11]!, AQ12[10]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 12]!, AQ12[11]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 13]!, AQ12[12]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 14]!, AQ12[13]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 15]!, AQ12[14]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sLPCQ14[at - 16]!, AQ12[15]!);
                }
                sLPCQ14[at] = addSat32(resQ14[resOffset + i]!, lshiftSat32(lpcPredQ10, 4));
                xq[pxq + i] = sat16(rshiftRound(smulww(sLPCQ14[at]!, gainQ10), 8));
            }
            sLPCQ14.copyWithin(0, subfrLength, subfrLength + MAX_LPC_ORDER);
            excOffset += subfrLength;
            pxq += subfrLength;
        }
        this.sLPCQ14Buf.set(sLPCQ14.subarray(0, MAX_LPC_ORDER));
    }

    /**
     * silk_decode_frame: decodes or conceals one frame into out[outOffset, outOffset +
     * frameLength).
     */
    decodeFrame(
        dec: RangeDecoder | null,
        out: Int16Array,
        outOffset: number,
        lostFlag: number,
        condCoding: number,
    ): void {
        const L = this.frameLength;
        this.ltpScaleQ14 = 0;
        if (
            dec &&
            (lostFlag === FLAG_DECODE_NORMAL ||
                (lostFlag === FLAG_DECODE_LBRR && this.lbrrFlags[this.nFramesDecoded] === 1))
        ) {
            this.decodeIndices(dec, this.nFramesDecoded, lostFlag === FLAG_DECODE_LBRR, condCoding);
            this.decodePulses(dec, this.pulses);
            this.decodeParameters(condCoding);
            this.decodeCore(out, outOffset, this.pulses);
            this.plc(out, outOffset, false);
            this.lossCnt = 0;
            this.prevSignalType = this.signalType;
            this.firstFrameAfterReset = 0;
        } else {
            this.signalType = this.prevSignalType;
            this.plc(out, outOffset, true);
        }
        const mvLen = this.ltpMemLength - L;
        this.outBuf.copyWithin(0, L, L + mvLen);
        this.outBuf.set(out.subarray(outOffset, outOffset + L), mvLen);
        this.cng(out, outOffset, L);
        this.plcGlueFrames(out, outOffset, L);
        this.lagPrev = this.pitchL[this.nbSubfr - 1]!;
    }

    private plc(frame: Int16Array, offset: number, lost: boolean): void {
        if (this.fsKHz !== this.plcFsKHz) {
            this.plcReset();
            this.plcFsKHz = this.fsKHz;
        }
        if (lost) {
            this.plcConceal(frame, offset);
            this.lossCnt++;
        } else this.plcUpdate();
    }

    private plcUpdate(): void {
        this.prevSignalType = this.signalType;
        let ltpGainQ14 = 0;
        if (this.signalType === TYPE_VOICED) {
            for (let j = 0; j * this.subfrLength < this.pitchL[this.nbSubfr - 1]!; j++) {
                if (j === this.nbSubfr) break;
                let temp = 0;
                for (let i = 0; i < LTP_ORDER; i++)
                    temp += this.ltpCoefQ14[(this.nbSubfr - 1 - j) * LTP_ORDER + i]!;
                if (temp > ltpGainQ14) {
                    ltpGainQ14 = temp;
                    const base = (this.nbSubfr - 1 - j) * LTP_ORDER;
                    this.plcLTPCoefQ14.set(this.ltpCoefQ14.subarray(base, base + LTP_ORDER));
                    this.plcPitchLQ8 = this.pitchL[this.nbSubfr - 1 - j]! << 8;
                }
            }
            this.plcLTPCoefQ14.fill(0);
            this.plcLTPCoefQ14[LTP_ORDER >> 1] = ltpGainQ14;
            if (ltpGainQ14 < V_PITCH_GAIN_START_MIN_Q14) {
                const scaleQ10 = div32(V_PITCH_GAIN_START_MIN_Q14 << 10, Math.max(ltpGainQ14, 1));
                for (let i = 0; i < LTP_ORDER; i++)
                    this.plcLTPCoefQ14[i] = smulbb(this.plcLTPCoefQ14[i]!, scaleQ10) >> 10;
            } else if (ltpGainQ14 > V_PITCH_GAIN_START_MAX_Q14) {
                const scaleQ14 = div32(V_PITCH_GAIN_START_MAX_Q14 << 14, Math.max(ltpGainQ14, 1));
                for (let i = 0; i < LTP_ORDER; i++)
                    this.plcLTPCoefQ14[i] = smulbb(this.plcLTPCoefQ14[i]!, scaleQ14) >> 14;
            }
        } else {
            this.plcPitchLQ8 = (this.fsKHz * 18) << 8;
            this.plcLTPCoefQ14.fill(0);
        }
        this.plcPrevLPCQ12.set(this.predCoefQ12[1]!.subarray(0, this.lpcOrder));
        this.plcPrevLTPScaleQ14 = this.ltpScaleQ14;
        this.plcPrevGainQ16[0] = this.gainsQ16[this.nbSubfr - 2]!;
        this.plcPrevGainQ16[1] = this.gainsQ16[this.nbSubfr - 1]!;
        this.plcSubfrLength = this.subfrLength;
        this.plcNbSubfr = this.nbSubfr;
    }

    private plcConceal(frame: Int16Array, frameOffset: number): void {
        const lpcOrder = this.lpcOrder;
        const subfrLength = this.subfrLength;
        const ltpMemLength = this.ltpMemLength;
        const sLTP = this.sLTP;
        const sLTPQ14 = this.sLTPQ15;
        const prevGainQ10 = [this.plcPrevGainQ16[0]! >> 6, this.plcPrevGainQ16[1]! >> 6];
        if (this.firstFrameAfterReset) this.plcPrevLPCQ12.fill(0);
        const excBuf = this.plcExcBuf;
        for (let k = 0; k < 2; k++) {
            for (let i = 0; i < subfrLength; i++)
                excBuf[k * subfrLength + i] = sat16(
                    smulww(
                        this.excQ14[i + (k + this.nbSubfr - 2) * subfrLength]!,
                        prevGainQ10[k]!,
                    ) >> 8,
                );
        }
        const [energy1, shift1] = sumSqrShift(excBuf, 0, subfrLength);
        const [energy2, shift2] = sumSqrShift(excBuf, subfrLength, subfrLength);
        let randOffset: number;
        if (energy1 >> shift2 < energy2 >> shift1)
            randOffset = Math.max(0, (this.plcNbSubfr - 1) * this.plcSubfrLength - RAND_BUF_SIZE);
        else randOffset = Math.max(0, this.plcNbSubfr * this.plcSubfrLength - RAND_BUF_SIZE);
        const BQ14 = this.plcLTPCoefQ14;
        let randScaleQ14 = this.plcRandScaleQ14;
        const harmGainQ15 = HARM_ATT_Q15[Math.min(1, this.lossCnt)]!;
        let randGainQ15 =
            this.prevSignalType === TYPE_VOICED
                ? PLC_RAND_ATTENUATE_V_Q15[Math.min(1, this.lossCnt)]!
                : PLC_RAND_ATTENUATE_UV_Q15[Math.min(1, this.lossCnt)]!;
        bwexpander(this.plcPrevLPCQ12, lpcOrder, BWE_COEF_Q16);
        const AQ12 = this.plcAQ12;
        AQ12.set(this.plcPrevLPCQ12.subarray(0, lpcOrder));
        if (this.lossCnt === 0) {
            randScaleQ14 = 1 << 14;
            if (this.prevSignalType === TYPE_VOICED) {
                for (let i = 0; i < LTP_ORDER; i++) randScaleQ14 -= BQ14[i]!;
                randScaleQ14 = Math.max(3277, randScaleQ14);
                randScaleQ14 = smulbb(randScaleQ14, this.plcPrevLTPScaleQ14) >> 14;
            } else {
                const invGainQ30 = lpcInversePredGain(this.plcPrevLPCQ12, lpcOrder);
                let downScaleQ30 = Math.min((1 << 30) >> LOG2_INV_LPC_GAIN_HIGH_THRES, invGainQ30);
                downScaleQ30 = Math.max((1 << 30) >> LOG2_INV_LPC_GAIN_LOW_THRES, downScaleQ30);
                downScaleQ30 <<= LOG2_INV_LPC_GAIN_HIGH_THRES;
                randGainQ15 = smulwb(downScaleQ30, randGainQ15) >> 14;
            }
        }
        let randSeed = this.plcRandSeed;
        let lag = rshiftRound(this.plcPitchLQ8, 8);
        let sLTPBufIdx = ltpMemLength;
        let idx = ltpMemLength - lag - lpcOrder - (LTP_ORDER >> 1);
        lpcAnalysisFilter(sLTP, idx, this.outBuf, idx, AQ12, ltpMemLength - idx, lpcOrder);
        let invGainQ30 = inverse32VarQ(this.plcPrevGainQ16[1]!, 46);
        invGainQ30 = Math.min(invGainQ30, INT32_MAX >> 1);
        for (let i = idx + lpcOrder; i < ltpMemLength; i++)
            sLTPQ14[i] = smulwb(invGainQ30, sLTP[i]!);
        for (let k = 0; k < this.nbSubfr; k++) {
            let predLag = sLTPBufIdx - lag + (LTP_ORDER >> 1);
            for (let i = 0; i < subfrLength; i++) {
                let ltpPredQ12 = 2;
                ltpPredQ12 = smlawb(ltpPredQ12, sLTPQ14[predLag]!, BQ14[0]!);
                ltpPredQ12 = smlawb(ltpPredQ12, sLTPQ14[predLag - 1]!, BQ14[1]!);
                ltpPredQ12 = smlawb(ltpPredQ12, sLTPQ14[predLag - 2]!, BQ14[2]!);
                ltpPredQ12 = smlawb(ltpPredQ12, sLTPQ14[predLag - 3]!, BQ14[3]!);
                ltpPredQ12 = smlawb(ltpPredQ12, sLTPQ14[predLag - 4]!, BQ14[4]!);
                predLag++;
                randSeed = rand(randSeed);
                idx = (randSeed >> 25) & RAND_BUF_MASK;
                sLTPQ14[sLTPBufIdx] =
                    smlawb(ltpPredQ12, this.excQ14[randOffset + idx]!, randScaleQ14) << 2;
                sLTPBufIdx++;
            }
            for (let j = 0; j < LTP_ORDER; j++) BQ14[j] = smulbb(harmGainQ15, BQ14[j]!) >> 15;
            if (this.signalType !== TYPE_NO_VOICE_ACTIVITY)
                randScaleQ14 = smulbb(randScaleQ14, randGainQ15) >> 15;
            this.plcPitchLQ8 = smlawb(this.plcPitchLQ8, this.plcPitchLQ8, PITCH_DRIFT_FAC_Q16);
            this.plcPitchLQ8 = Math.min(this.plcPitchLQ8, (MAX_PITCH_LAG_MS * this.fsKHz) << 8);
            lag = rshiftRound(this.plcPitchLQ8, 8);
        }
        const sLPCBase = ltpMemLength - MAX_LPC_ORDER;
        sLTPQ14.set(this.sLPCQ14Buf, sLPCBase);
        for (let i = 0; i < this.frameLength; i++) {
            const at = sLPCBase + MAX_LPC_ORDER + i;
            let lpcPredQ10 = lpcOrder >> 1;
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 1]!, AQ12[0]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 2]!, AQ12[1]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 3]!, AQ12[2]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 4]!, AQ12[3]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 5]!, AQ12[4]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 6]!, AQ12[5]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 7]!, AQ12[6]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 8]!, AQ12[7]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 9]!, AQ12[8]!);
            lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - 10]!, AQ12[9]!);
            for (let j = 10; j < lpcOrder; j++)
                lpcPredQ10 = smlawb(lpcPredQ10, sLTPQ14[at - j - 1]!, AQ12[j]!);
            sLTPQ14[at] = addSat32(sLTPQ14[at]!, lshiftSat32(lpcPredQ10, 4));
            frame[frameOffset + i] = sat16(rshiftRound(smulww(sLTPQ14[at]!, prevGainQ10[1]!), 8));
        }
        this.sLPCQ14Buf.set(
            sLTPQ14.subarray(
                sLPCBase + this.frameLength,
                sLPCBase + this.frameLength + MAX_LPC_ORDER,
            ),
        );
        this.plcRandSeed = randSeed;
        this.plcRandScaleQ14 = randScaleQ14;
        for (let i = 0; i < MAX_NB_SUBFR; i++) this.pitchL[i] = lag;
    }

    private plcGlueFrames(frame: Int16Array, offset: number, length: number): void {
        if (this.lossCnt) {
            [this.plcConcEnergy, this.plcConcEnergyShift] = sumSqrShift(frame, offset, length);
            this.plcLastFrameLost = 1;
        } else {
            if (this.plcLastFrameLost) {
                let [energy, energyShift] = sumSqrShift(frame, offset, length);
                if (energyShift > this.plcConcEnergyShift)
                    this.plcConcEnergy =
                        this.plcConcEnergy >> (energyShift - this.plcConcEnergyShift);
                else if (energyShift < this.plcConcEnergyShift)
                    energy = energy >> (this.plcConcEnergyShift - energyShift);
                if (energy > this.plcConcEnergy) {
                    const LZ = clz32(this.plcConcEnergy) - 1;
                    this.plcConcEnergy = this.plcConcEnergy << LZ;
                    energy = energy >> Math.max(24 - LZ, 0);
                    const fracQ24 = div32(this.plcConcEnergy, Math.max(energy, 1));
                    let gainQ16 = sqrtApprox(fracQ24) << 4;
                    let slopeQ16 = div32((1 << 16) - gainQ16, length);
                    slopeQ16 <<= 2;
                    for (let i = 0; i < length; i++) {
                        frame[offset + i] = smulwb(gainQ16, frame[offset + i]!);
                        gainQ16 += slopeQ16;
                        if (gainQ16 > 1 << 16) break;
                    }
                }
            }
            this.plcLastFrameLost = 0;
        }
    }

    private cng(frame: Int16Array, offset: number, length: number): void {
        if (this.fsKHz !== this.cngFsKHz) {
            this.cngReset();
            this.cngFsKHz = this.fsKHz;
        }
        if (this.lossCnt === 0 && this.prevSignalType === TYPE_NO_VOICE_ACTIVITY) {
            for (let i = 0; i < this.lpcOrder; i++)
                this.cngSmthNLSFQ15[i] =
                    this.cngSmthNLSFQ15[i]! +
                    smulwb(this.prevNLSFQ15[i]! - this.cngSmthNLSFQ15[i]!, CNG_NLSF_SMTH_Q16);
            let maxGainQ16 = 0;
            let subfr = 0;
            for (let i = 0; i < this.nbSubfr; i++) {
                if (this.gainsQ16[i]! > maxGainQ16) {
                    maxGainQ16 = this.gainsQ16[i]!;
                    subfr = i;
                }
            }
            this.cngExcBufQ14.copyWithin(
                this.subfrLength,
                0,
                (this.nbSubfr - 1) * this.subfrLength,
            );
            this.cngExcBufQ14.set(
                this.excQ14.subarray(subfr * this.subfrLength, (subfr + 1) * this.subfrLength),
                0,
            );
            for (let i = 0; i < this.nbSubfr; i++)
                this.cngSmthGainQ16 =
                    (this.cngSmthGainQ16 +
                        smulwb(this.gainsQ16[i]! - this.cngSmthGainQ16, CNG_GAIN_SMTH_Q16)) |
                    0;
        }
        if (this.lossCnt) {
            const sig = this.cngSigQ14;
            let gainQ16 = smulww(this.plcRandScaleQ14, this.plcPrevGainQ16[1]!);
            if (gainQ16 >= 1 << 21 || this.cngSmthGainQ16 > 1 << 23) {
                gainQ16 = Math.imul(gainQ16 >> 16, gainQ16 >> 16);
                gainQ16 =
                    (Math.imul(this.cngSmthGainQ16 >> 16, this.cngSmthGainQ16 >> 16) -
                        (gainQ16 << 5)) |
                    0;
                gainQ16 = sqrtApprox(gainQ16) << 16;
            } else {
                gainQ16 = smulww(gainQ16, gainQ16);
                gainQ16 = (smulww(this.cngSmthGainQ16, this.cngSmthGainQ16) - (gainQ16 << 5)) | 0;
                gainQ16 = sqrtApprox(gainQ16) << 8;
            }
            const gainQ10 = gainQ16 >> 6;
            let excMask = CNG_BUF_MASK_MAX;
            while (excMask > length) excMask >>= 1;
            let seed = this.cngRandSeed;
            for (let i = 0; i < length; i++) {
                seed = rand(seed);
                sig[MAX_LPC_ORDER + i] = this.cngExcBufQ14[(seed >> 24) & excMask]!;
            }
            this.cngRandSeed = seed;
            const AQ12 = this.cngAQ12;
            nlsf2a(AQ12, this.cngSmthNLSFQ15, this.lpcOrder);
            sig.set(this.cngSynthState, 0);
            for (let i = 0; i < length; i++) {
                const at = MAX_LPC_ORDER + i;
                let lpcPredQ10 = this.lpcOrder >> 1;
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 1]!, AQ12[0]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 2]!, AQ12[1]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 3]!, AQ12[2]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 4]!, AQ12[3]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 5]!, AQ12[4]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 6]!, AQ12[5]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 7]!, AQ12[6]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 8]!, AQ12[7]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 9]!, AQ12[8]!);
                lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 10]!, AQ12[9]!);
                if (this.lpcOrder === 16) {
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 11]!, AQ12[10]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 12]!, AQ12[11]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 13]!, AQ12[12]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 14]!, AQ12[13]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 15]!, AQ12[14]!);
                    lpcPredQ10 = smlawb(lpcPredQ10, sig[at - 16]!, AQ12[15]!);
                }
                sig[at] = addSat32(sig[at]!, lshiftSat32(lpcPredQ10, 4));
                frame[offset + i] = sat16(
                    frame[offset + i]! + sat16(rshiftRound(smulww(sig[at]!, gainQ10), 8)),
                );
            }
            this.cngSynthState.set(sig.subarray(length, length + MAX_LPC_ORDER));
        } else this.cngSynthState.fill(0, 0, this.lpcOrder);
    }
}

/** silk_DecControlStruct: how the Opus layer configures a SILK decode call. */
export interface SilkDecodeControl {
    nChannelsAPI: number;
    nChannelsInternal: number;
    /** Hz: 8000, 12000 or 16000. */
    internalSampleRate: number;
    /** 10, 20, 40 or 60; 0 during packet loss. */
    payloadSizeMs: number;
}

/**
 * The SILK layer of RFC 6716 section 4.2: up to two channel decoders with mid/side stereo
 * prediction.
 */
export class SilkDecoder {
    private readonly channels = [new SilkChannel(), new SilkChannel()];
    private readonly predPrevQ13 = new Int32Array(2);
    private readonly sMid = new Int16Array(2);
    private readonly sSide = new Int16Array(2);
    private nChannelsAPI = 0;
    private nChannelsInternal = 0;
    private prevDecodeOnlyMiddle = 0;
    private readonly msPredQ13 = new Int32Array(2);
    private readonly samplesOut1 = [
        new Int16Array(MAX_FRAME_LENGTH + 2),
        new Int16Array(MAX_FRAME_LENGTH + 2),
    ];
    private readonly samplesOut2 = new Int16Array(960);
    private readonly stereoIx = new Int32Array(6);
    /** Pitch lag of the last voiced frame in 48 kHz samples, for the Opus layer. */
    prevPitchLag = 0;

    reset(): void {
        for (const channel of this.channels) channel.reset();
        this.predPrevQ13.fill(0);
        this.sMid.fill(0);
        this.sSide.fill(0);
        this.prevDecodeOnlyMiddle = 0;
    }

    /**
     * silk_Decode: one SILK frame (10 or 20 ms) into `out` interleaved by API channels at 48 kHz;
     * returns the samples per channel written.
     */
    decode(
        control: SilkDecodeControl,
        lostFlag: number,
        newPacketFlag: boolean,
        dec: RangeDecoder | null,
        out: Int16Array,
        outOffset: number,
    ): number {
        const channels = this.channels;
        const msPredQ13 = this.msPredQ13;
        let decodeOnlyMiddle = 0;
        msPredQ13[0] = 0;
        msPredQ13[1] = 0;
        if (newPacketFlag)
            for (let n = 0; n < control.nChannelsInternal; n++) channels[n]!.nFramesDecoded = 0;
        if (control.nChannelsInternal > this.nChannelsInternal) channels[1]!.reset();
        const stereoToMono =
            control.nChannelsInternal === 1 &&
            this.nChannelsInternal === 2 &&
            control.internalSampleRate === 1000 * channels[0]!.fsKHz;
        if (channels[0]!.nFramesDecoded === 0) {
            for (let n = 0; n < control.nChannelsInternal; n++) {
                const channel = channels[n]!;
                if (control.payloadSizeMs === 0 || control.payloadSizeMs === 10) {
                    channel.nFramesPerPacket = 1;
                    channel.nbSubfr = 2;
                } else if (control.payloadSizeMs === 20) {
                    channel.nFramesPerPacket = 1;
                    channel.nbSubfr = 4;
                } else if (control.payloadSizeMs === 40) {
                    channel.nFramesPerPacket = 2;
                    channel.nbSubfr = 4;
                } else {
                    channel.nFramesPerPacket = 3;
                    channel.nbSubfr = 4;
                }
                channel.setFs((control.internalSampleRate >> 10) + 1);
            }
        }
        if (
            control.nChannelsAPI === 2 &&
            control.nChannelsInternal === 2 &&
            (this.nChannelsAPI === 1 || this.nChannelsInternal === 1)
        ) {
            this.predPrevQ13.fill(0);
            this.sSide.fill(0);
            channels[1]!.resampler.copyFrom(channels[0]!.resampler);
        }
        this.nChannelsAPI = control.nChannelsAPI;
        this.nChannelsInternal = control.nChannelsInternal;
        if (lostFlag !== FLAG_PACKET_LOST && channels[0]!.nFramesDecoded === 0 && dec) {
            for (let n = 0; n < control.nChannelsInternal; n++) {
                const channel = channels[n]!;
                for (let i = 0; i < channel.nFramesPerPacket; i++)
                    channel.vadFlags[i] = dec.decodeBitLogp(1);
                channel.lbrrFlag = dec.decodeBitLogp(1);
            }
            for (let n = 0; n < control.nChannelsInternal; n++) {
                const channel = channels[n]!;
                channel.lbrrFlags.fill(0);
                if (channel.lbrrFlag) {
                    if (channel.nFramesPerPacket === 1) channel.lbrrFlags[0] = 1;
                    else {
                        const symbol =
                            dec.decodeIcdf(LBRR_FLAGS_ICDF[channel.nFramesPerPacket - 2]!) + 1;
                        for (let i = 0; i < channel.nFramesPerPacket; i++)
                            channel.lbrrFlags[i] = (symbol >> i) & 1;
                    }
                }
            }
            if (lostFlag === FLAG_DECODE_NORMAL) {
                for (let i = 0; i < channels[0]!.nFramesPerPacket; i++) {
                    for (let n = 0; n < control.nChannelsInternal; n++) {
                        const channel = channels[n]!;
                        if (channel.lbrrFlags[i]) {
                            if (control.nChannelsInternal === 2 && n === 0) {
                                this.stereoDecodePred(dec);
                                if (channels[1]!.lbrrFlags[i] === 0)
                                    decodeOnlyMiddle = dec.decodeIcdf(
                                        T.SILK_STEREO_ONLY_CODE_MID_ICDF,
                                    );
                            }
                            const condCoding =
                                i > 0 && channel.lbrrFlags[i - 1]
                                    ? CODE_CONDITIONALLY
                                    : CODE_INDEPENDENTLY;
                            channel.decodeIndices(dec, i, true, condCoding);
                            channel.decodePulses(dec, channel.pulses);
                        }
                    }
                }
            }
        }
        if (control.nChannelsInternal === 2) {
            if (
                dec &&
                (lostFlag === FLAG_DECODE_NORMAL ||
                    (lostFlag === FLAG_DECODE_LBRR &&
                        channels[0]!.lbrrFlags[channels[0]!.nFramesDecoded] === 1))
            ) {
                this.stereoDecodePred(dec);
                if (
                    (lostFlag === FLAG_DECODE_NORMAL &&
                        channels[1]!.vadFlags[channels[0]!.nFramesDecoded] === 0) ||
                    (lostFlag === FLAG_DECODE_LBRR &&
                        channels[1]!.lbrrFlags[channels[0]!.nFramesDecoded] === 0)
                )
                    decodeOnlyMiddle = dec.decodeIcdf(T.SILK_STEREO_ONLY_CODE_MID_ICDF);
                else decodeOnlyMiddle = 0;
            } else {
                msPredQ13[0] = this.predPrevQ13[0]!;
                msPredQ13[1] = this.predPrevQ13[1]!;
            }
        }
        if (
            control.nChannelsInternal === 2 &&
            decodeOnlyMiddle === 0 &&
            this.prevDecodeOnlyMiddle === 1
        ) {
            const side = channels[1]!;
            side.outBuf.fill(0);
            side.sLPCQ14Buf.fill(0);
            side.lagPrev = 100;
            side.lastGainIndex = 10;
            side.prevSignalType = TYPE_NO_VOICE_ACTIVITY;
            side.firstFrameAfterReset = 1;
        }
        let hasSide: boolean;
        if (lostFlag === FLAG_DECODE_NORMAL) hasSide = !decodeOnlyMiddle;
        else
            hasSide =
                !this.prevDecodeOnlyMiddle ||
                (control.nChannelsInternal === 2 &&
                    lostFlag === FLAG_DECODE_LBRR &&
                    channels[1]!.lbrrFlags[channels[1]!.nFramesDecoded] === 1);
        const frameLength = channels[0]!.frameLength;
        for (let n = 0; n < control.nChannelsInternal; n++) {
            const buffer = this.samplesOut1[n]!;
            if (n === 0 || hasSide) {
                const frameIndex = channels[0]!.nFramesDecoded - n;
                let condCoding: number;
                if (frameIndex <= 0) condCoding = CODE_INDEPENDENTLY;
                else if (lostFlag === FLAG_DECODE_LBRR)
                    condCoding = channels[n]!.lbrrFlags[frameIndex - 1]
                        ? CODE_CONDITIONALLY
                        : CODE_INDEPENDENTLY;
                else if (n > 0 && this.prevDecodeOnlyMiddle)
                    condCoding = CODE_INDEPENDENTLY_NO_LTP_SCALING;
                else condCoding = CODE_CONDITIONALLY;
                channels[n]!.decodeFrame(dec, buffer, 2, lostFlag, condCoding);
            } else buffer.fill(0, 2, 2 + frameLength);
            channels[n]!.nFramesDecoded++;
        }
        const fsKHz = channels[0]!.fsKHz;
        if (control.nChannelsAPI === 2 && control.nChannelsInternal === 2) {
            this.stereoMsToLr(this.samplesOut1[0]!, this.samplesOut1[1]!, fsKHz, frameLength);
        } else {
            const mid = this.samplesOut1[0]!;
            mid[0] = this.sMid[0]!;
            mid[1] = this.sMid[1]!;
            this.sMid[0] = mid[frameLength]!;
            this.sMid[1] = mid[frameLength + 1]!;
        }
        const nSamplesOut = (frameLength * 48) / fsKHz;
        const resampleOut = control.nChannelsAPI === 2 ? this.samplesOut2 : out;
        const resampleOffset = control.nChannelsAPI === 2 ? 0 : outOffset;
        for (let n = 0; n < Math.min(control.nChannelsAPI, control.nChannelsInternal); n++) {
            channels[n]!.resampler.process(
                resampleOut,
                resampleOffset,
                this.samplesOut1[n]!,
                1,
                frameLength,
            );
            if (control.nChannelsAPI === 2)
                for (let i = 0; i < nSamplesOut; i++) out[outOffset + n + 2 * i] = resampleOut[i]!;
        }
        if (control.nChannelsAPI === 2 && control.nChannelsInternal === 1) {
            if (stereoToMono) {
                channels[1]!.resampler.process(
                    resampleOut,
                    0,
                    this.samplesOut1[0]!,
                    1,
                    frameLength,
                );
                for (let i = 0; i < nSamplesOut; i++) out[outOffset + 1 + 2 * i] = resampleOut[i]!;
            } else {
                for (let i = 0; i < nSamplesOut; i++)
                    out[outOffset + 1 + 2 * i] = out[outOffset + 2 * i]!;
            }
        }
        if (channels[0]!.prevSignalType === TYPE_VOICED) {
            const mult = [6, 4, 3][(fsKHz - 8) >> 2]!;
            this.prevPitchLag = channels[0]!.lagPrev * mult;
        } else this.prevPitchLag = 0;
        if (lostFlag === FLAG_PACKET_LOST) {
            for (let i = 0; i < this.nChannelsInternal; i++) channels[i]!.lastGainIndex = 10;
        } else this.prevDecodeOnlyMiddle = decodeOnlyMiddle;
        return nSamplesOut;
    }

    private stereoDecodePred(dec: RangeDecoder): void {
        const ix = this.stereoIx;
        const n = dec.decodeIcdf(T.SILK_STEREO_PRED_JOINT_ICDF);
        ix[2] = div32(n, 5);
        ix[5] = n - 5 * ix[2]!;
        for (let k = 0; k < 2; k++) {
            ix[k * 3] = dec.decodeIcdf(T.SILK_UNIFORM3_ICDF);
            ix[k * 3 + 1] = dec.decodeIcdf(T.SILK_UNIFORM5_ICDF);
        }
        for (let k = 0; k < 2; k++) {
            ix[k * 3] = ix[k * 3]! + 3 * ix[k * 3 + 2]!;
            const lowQ13 = T.SILK_STEREO_PRED_QUANT_Q13[ix[k * 3]!]!;
            const stepQ13 = smulwb(T.SILK_STEREO_PRED_QUANT_Q13[ix[k * 3]! + 1]! - lowQ13, 6554);
            this.msPredQ13[k] = smlabb(lowQ13, stepQ13, 2 * ix[k * 3 + 1]! + 1);
        }
        this.msPredQ13[0] = this.msPredQ13[0]! - this.msPredQ13[1]!;
    }

    private stereoMsToLr(x1: Int16Array, x2: Int16Array, fsKHz: number, frameLength: number): void {
        const predQ13 = this.msPredQ13;
        x1[0] = this.sMid[0]!;
        x1[1] = this.sMid[1]!;
        x2[0] = this.sSide[0]!;
        x2[1] = this.sSide[1]!;
        this.sMid[0] = x1[frameLength]!;
        this.sMid[1] = x1[frameLength + 1]!;
        this.sSide[0] = x2[frameLength]!;
        this.sSide[1] = x2[frameLength + 1]!;
        let pred0Q13 = this.predPrevQ13[0]!;
        let pred1Q13 = this.predPrevQ13[1]!;
        const interpLength = STEREO_INTERP_LEN_MS * fsKHz;
        const denomQ16 = div32(1 << 16, interpLength);
        const delta0Q13 = rshiftRound(smulbb(predQ13[0]! - this.predPrevQ13[0]!, denomQ16), 16);
        const delta1Q13 = rshiftRound(smulbb(predQ13[1]! - this.predPrevQ13[1]!, denomQ16), 16);
        let n = 0;
        for (; n < interpLength; n++) {
            pred0Q13 += delta0Q13;
            pred1Q13 += delta1Q13;
            let sum = (x1[n]! + x1[n + 2]! + (x1[n + 1]! << 1)) << 9;
            sum = smlawb(x2[n + 1]! << 8, sum, pred0Q13);
            sum = smlawb(sum, x1[n + 1]! << 11, pred1Q13);
            x2[n + 1] = sat16(rshiftRound(sum, 8));
        }
        pred0Q13 = predQ13[0]!;
        pred1Q13 = predQ13[1]!;
        for (; n < frameLength; n++) {
            let sum = (x1[n]! + x1[n + 2]! + (x1[n + 1]! << 1)) << 9;
            sum = smlawb(x2[n + 1]! << 8, sum, pred0Q13);
            sum = smlawb(sum, x1[n + 1]! << 11, pred1Q13);
            x2[n + 1] = sat16(rshiftRound(sum, 8));
        }
        this.predPrevQ13[0] = predQ13[0]!;
        this.predPrevQ13[1] = predQ13[1]!;
        for (n = 0; n < frameLength; n++) {
            const sum = x1[n + 1]! + x2[n + 1]!;
            const diff = x1[n + 1]! - x2[n + 1]!;
            x1[n + 1] = sat16(sum);
            x2[n + 1] = sat16(diff);
        }
    }
}
