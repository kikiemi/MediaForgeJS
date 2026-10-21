import { celtLcgRand, decodeAllBands, renormaliseVector } from './celt-bands';
import {
    ALLOC_VECTORS,
    BITRES,
    EBANDS,
    EFF_EBANDS,
    FINE_OFFSET,
    LOGN,
    MAX_FINE_BITS,
    MAX_LM,
    MDCT,
    NB_ALLOC_VECTORS,
    NB_EBANDS,
    OVERLAP,
    PREEMPH_COEF,
    PULSE_CACHE,
    SHORT_MDCT_SIZE,
    WINDOW,
} from './celt-mode';
import type { RangeDecoder } from './range-decoder';

// CELT layer decoder of RFC 6716 section 4.3 (float, 48 kHz, 2.5 to 20 ms frames), with its packet
// loss concealment.

const DECODE_BUFFER_SIZE = 2048;
const MAX_PERIOD = 1024;
const LPC_ORDER = 24;
const PLC_PITCH_LAG_MAX = 720;
const PLC_PITCH_LAG_MIN = 100;
const COMBFILTER_MINPERIOD = 15;
const SPREAD_NORMAL = 2;
const TRIM_ICDF = new Uint8Array([126, 124, 119, 109, 87, 41, 19, 9, 4, 2, 0]);
const SPREAD_ICDF = new Uint8Array([25, 23, 2, 0]);
const TAPSET_ICDF = new Uint8Array([2, 1, 0]);
const SMALL_ENERGY_ICDF = new Uint8Array([2, 1, 0]);
const TF_SELECT_TABLE = [
    [0, -1, 0, -1, 0, -1, 0, -1],
    [0, -1, 0, -2, 1, 0, 1, -1],
    [0, -2, 0, -3, 2, 0, 1, -1],
    [0, -2, 0, -3, 3, 0, 1, -1],
];
const E_MEANS = [
    6.4375, 6.25, 5.75, 5.3125, 5.0625, 4.8125, 4.5, 4.375, 4.875, 4.6875, 4.5625, 4.4375, 4.875,
    4.625, 4.3125, 4.5, 4.375, 4.625, 4.75, 4.4375, 3.75, 3.75, 3.75, 3.75, 3.75,
];
const PRED_COEF = [29440 / 32768, 26112 / 32768, 21248 / 32768, 16384 / 32768];
const BETA_COEF = [30147 / 32768, 22282 / 32768, 12124 / 32768, 6554 / 32768];
const BETA_INTRA = 4915 / 32768;
const E_PROB_MODEL = [
    [
        [
            72, 127, 65, 129, 66, 128, 65, 128, 64, 128, 62, 128, 64, 128, 64, 128, 92, 78, 92, 79,
            92, 78, 90, 79, 116, 41, 115, 40, 114, 40, 132, 26, 132, 26, 145, 17, 161, 12, 176, 10,
            177, 11,
        ],
        [
            24, 179, 48, 138, 54, 135, 54, 132, 53, 134, 56, 133, 55, 132, 55, 132, 61, 114, 70, 96,
            74, 88, 75, 88, 87, 74, 89, 66, 91, 67, 100, 59, 108, 50, 120, 40, 122, 37, 97, 43, 78,
            50,
        ],
    ],
    [
        [
            83, 78, 84, 81, 88, 75, 86, 74, 87, 71, 90, 73, 93, 74, 93, 74, 109, 40, 114, 36, 117,
            34, 117, 34, 143, 17, 145, 18, 146, 19, 162, 12, 165, 10, 178, 7, 189, 6, 190, 8, 177,
            9,
        ],
        [
            23, 178, 54, 115, 63, 102, 66, 98, 69, 99, 74, 89, 71, 91, 73, 91, 78, 89, 86, 80, 92,
            66, 93, 64, 102, 59, 103, 60, 104, 60, 117, 52, 123, 44, 138, 35, 133, 31, 97, 38, 77,
            45,
        ],
    ],
    [
        [
            61, 90, 93, 60, 105, 42, 107, 41, 110, 45, 116, 38, 113, 38, 112, 38, 124, 26, 132, 27,
            136, 19, 140, 20, 155, 14, 159, 16, 158, 18, 170, 13, 177, 10, 187, 8, 192, 6, 175, 9,
            159, 10,
        ],
        [
            21, 178, 59, 110, 71, 86, 75, 85, 84, 83, 91, 66, 88, 73, 87, 72, 92, 75, 98, 72, 105,
            58, 107, 54, 115, 52, 114, 55, 112, 56, 129, 51, 132, 40, 150, 33, 140, 29, 98, 35, 77,
            42,
        ],
    ],
    [
        [
            42, 121, 96, 66, 108, 43, 111, 40, 117, 44, 123, 32, 120, 36, 119, 33, 127, 33, 134, 34,
            139, 21, 147, 23, 152, 20, 158, 25, 154, 26, 166, 21, 173, 16, 184, 13, 184, 10, 150,
            13, 139, 15,
        ],
        [
            22, 178, 63, 114, 74, 82, 84, 83, 92, 82, 103, 62, 96, 72, 96, 67, 101, 73, 107, 72,
            113, 55, 118, 52, 125, 52, 118, 52, 117, 55, 135, 49, 137, 39, 157, 32, 145, 29, 97, 33,
            77, 40,
        ],
    ],
];
const LOG2_FRAC_TABLE = [
    0, 8, 13, 16, 19, 21, 23, 24, 26, 27, 28, 29, 30, 31, 32, 32, 33, 34, 34, 35, 36, 36, 37, 37,
];
const COMB_GAINS = [
    [0.306640625, 0.2170410156, 0.1296386719],
    [0.4638671875, 0.2680664062, 0],
    [0.7998046875, 0.1000976562, 0],
];

function celtExp2(x: number): number {
    return Math.exp(0.6931471805599453 * x);
}

function combFilter(
    y: Float32Array,
    yAt: number,
    x: Float32Array,
    xAt: number,
    T0: number,
    T1: number,
    N: number,
    g0: number,
    g1: number,
    tapset0: number,
    tapset1: number,
    window: Float32Array | null,
    overlap: number,
): void {
    if (g0 === 0 && g1 === 0) {
        if (x !== y || xAt !== yAt) y.set(x.subarray(xAt, xAt + N), yAt);
        return;
    }
    T0 = Math.max(T0, COMBFILTER_MINPERIOD);
    T1 = Math.max(T1, COMBFILTER_MINPERIOD);
    const g00 = g0 * COMB_GAINS[tapset0]![0]!;
    const g01 = g0 * COMB_GAINS[tapset0]![1]!;
    const g02 = g0 * COMB_GAINS[tapset0]![2]!;
    const g10 = g1 * COMB_GAINS[tapset1]![0]!;
    const g11 = g1 * COMB_GAINS[tapset1]![1]!;
    const g12 = g1 * COMB_GAINS[tapset1]![2]!;
    let x1 = x[xAt - T1 + 1]!;
    let x2 = x[xAt - T1]!;
    let x3 = x[xAt - T1 - 1]!;
    let x4 = x[xAt - T1 - 2]!;
    if (g0 === g1 && T0 === T1 && tapset0 === tapset1) overlap = 0;
    let i = 0;
    for (; i < overlap; i++) {
        const x0 = x[xAt + i - T1 + 2]!;
        const f = window![i]! * window![i]!;
        y[yAt + i] =
            x[xAt + i]! +
            (1 - f) * g00 * x[xAt + i - T0]! +
            (1 - f) * g01 * (x[xAt + i - T0 + 1]! + x[xAt + i - T0 - 1]!) +
            (1 - f) * g02 * (x[xAt + i - T0 + 2]! + x[xAt + i - T0 - 2]!) +
            f * g10 * x2 +
            f * g11 * (x1 + x3) +
            f * g12 * (x0 + x4);
        x4 = x3;
        x3 = x2;
        x2 = x1;
        x1 = x0;
    }
    if (g1 === 0) {
        if (x !== y || xAt !== yAt) y.set(x.subarray(xAt + overlap, xAt + N), yAt + overlap);
        return;
    }
    x4 = x[xAt + i - T1 - 2]!;
    x3 = x[xAt + i - T1 - 1]!;
    x2 = x[xAt + i - T1]!;
    x1 = x[xAt + i - T1 + 1]!;
    for (; i < N; i++) {
        const x0 = x[xAt + i - T1 + 2]!;
        y[yAt + i] = x[xAt + i]! + g10 * x2 + g11 * (x1 + x3) + g12 * (x0 + x4);
        x4 = x3;
        x3 = x2;
        x2 = x1;
        x1 = x0;
    }
}

/** Levinson-Durbin LPC from autocorrelation `ac` (celt_lpc.c _celt_lpc). */
function celtLpc(lpc: Float32Array, lpcAt: number, ac: Float64Array, p: number): void {
    let error = ac[0]!;
    lpc.fill(0, lpcAt, lpcAt + p);
    if (ac[0] !== 0) {
        for (let i = 0; i < p; i++) {
            let rr = 0;
            for (let j = 0; j < i; j++) rr += lpc[lpcAt + j]! * ac[i - j]!;
            rr += ac[i + 1]!;
            const r = -rr / error;
            lpc[lpcAt + i] = r;
            for (let j = 0; j < (i + 1) >> 1; j++) {
                const tmp1 = lpc[lpcAt + j]!;
                const tmp2 = lpc[lpcAt + i - 1 - j]!;
                lpc[lpcAt + j] = tmp1 + r * tmp2;
                lpc[lpcAt + i - 1 - j] = tmp2 + r * tmp1;
            }
            error = error - r * r * error;
            if (error < 0.001 * ac[0]!) break;
        }
    }
}

function celtAutocorr(
    x: Float32Array,
    xAt: number,
    ac: Float64Array,
    window: Float32Array | null,
    overlap: number,
    lag: number,
    n: number,
    xx: Float32Array,
): void {
    let src = x;
    let at = xAt;
    if (overlap !== 0) {
        xx.set(x.subarray(xAt, xAt + n));
        for (let i = 0; i < overlap; i++) {
            xx[i] = x[xAt + i]! * window![i]!;
            xx[n - i - 1] = x[xAt + n - i - 1]! * window![i]!;
        }
        src = xx;
        at = 0;
    }
    for (let k = 0; k <= lag; k++) {
        let d = 0;
        for (let i = k; i < n; i++) d += src[at + i]! * src[at + i - k]!;
        ac[k] = d;
    }
}

/** Per-frame allocation results (rate.c). */
interface Allocation {
    codedBands: number;
    intensity: number;
    dualStereo: number;
    balance: number;
}

export class CeltDecoder {
    private readonly channels: number;
    private streamChannels: number;
    private start = 0;
    private end = EFF_EBANDS;
    private disableInv: boolean;
    private rng = 0;
    private lastPitchIndex = 0;
    private lossCount = 0;
    private skipPlc = false;
    private postfilterPeriod = 0;
    private postfilterPeriodOld = 0;
    private postfilterGain = 0;
    private postfilterGainOld = 0;
    private postfilterTapset = 0;
    private postfilterTapsetOld = 0;
    private readonly preemphMem = new Float32Array(2);
    private readonly decodeMem: Float32Array[];
    private readonly lpc: Float32Array;
    private readonly oldBandE = new Float32Array(2 * NB_EBANDS);
    private readonly oldLogE = new Float32Array(2 * NB_EBANDS);
    private readonly oldLogE2 = new Float32Array(2 * NB_EBANDS);
    private readonly backgroundLogE = new Float32Array(2 * NB_EBANDS);
    private readonly X: Float32Array;
    /** X viewed from the second channel's offset for each LM. */
    private readonly yViews: Float32Array[];
    private readonly freq = new Float32Array(SHORT_MDCT_SIZE << MAX_LM);
    private readonly tfRes = new Int32Array(NB_EBANDS);
    private readonly cap = new Int32Array(NB_EBANDS);
    private readonly offsets = new Int32Array(NB_EBANDS);
    private readonly fineQuant = new Int32Array(NB_EBANDS);
    private readonly pulses = new Int32Array(NB_EBANDS);
    private readonly finePriority = new Int32Array(NB_EBANDS);
    private readonly collapseMasks = new Uint8Array(2 * NB_EBANDS);
    private readonly bits1 = new Int32Array(NB_EBANDS);
    private readonly bits2 = new Int32Array(NB_EBANDS);
    private readonly thresh = new Int32Array(NB_EBANDS);
    private readonly trimOffset = new Int32Array(NB_EBANDS);
    private readonly plcExc = new Float32Array(MAX_PERIOD + LPC_ORDER);
    private readonly plcFir = new Float32Array(MAX_PERIOD);
    private readonly plcWindowed = new Float32Array(MAX_PERIOD);
    private readonly plcAc = new Float64Array(LPC_ORDER + 1);
    private readonly plcEtmp = new Float32Array(OVERLAP);
    private readonly plcLpcMem = new Float32Array(LPC_ORDER);
    private readonly plcLpPitch = new Float32Array(DECODE_BUFFER_SIZE >> 1);
    private readonly plcXlp4 = new Float32Array(DECODE_BUFFER_SIZE >> 2);
    private readonly plcYlp4 = new Float32Array(DECODE_BUFFER_SIZE >> 2);
    private readonly plcXcorr = new Float32Array(PLC_PITCH_LAG_MAX >> 1);

    constructor(channels: number) {
        this.channels = channels;
        this.streamChannels = channels;
        this.disableInv = channels === 1;
        this.decodeMem = [
            new Float32Array(DECODE_BUFFER_SIZE + OVERLAP),
            new Float32Array(DECODE_BUFFER_SIZE + OVERLAP),
        ];
        this.lpc = new Float32Array(2 * LPC_ORDER);
        this.X = new Float32Array(2 * (SHORT_MDCT_SIZE << MAX_LM));
        this.yViews = [0, 1, 2, 3].map(lm => this.X.subarray(SHORT_MDCT_SIZE << lm));
        this.reset();
    }

    reset(): void {
        this.rng = 0;
        this.lastPitchIndex = 0;
        this.lossCount = 0;
        this.postfilterPeriod = 0;
        this.postfilterPeriodOld = 0;
        this.postfilterGain = 0;
        this.postfilterGainOld = 0;
        this.postfilterTapset = 0;
        this.postfilterTapsetOld = 0;
        this.preemphMem.fill(0);
        for (const mem of this.decodeMem) mem.fill(0);
        this.lpc.fill(0);
        this.oldBandE.fill(0);
        this.backgroundLogE.fill(0);
        this.oldLogE.fill(-28);
        this.oldLogE2.fill(-28);
        this.skipPlc = true;
    }

    setStartBand(start: number): void {
        this.start = start;
    }

    setEndBand(end: number): void {
        this.end = end;
    }

    setStreamChannels(channels: number): void {
        this.streamChannels = channels;
    }

    /** The window of the mode, for the Opus layer's transition cross-fades. */
    get window(): Float32Array {
        return WINDOW;
    }

    private deemphasis(pcm: Float32Array, pcmAt: number, N: number, accum: boolean): void {
        const C = this.channels;
        for (let c = 0; c < C; c++) {
            const x = this.decodeMem[c]!;
            const xAt = DECODE_BUFFER_SIZE - N;
            let m = this.preemphMem[c]!;
            let y = pcmAt + c;
            if (accum) {
                for (let j = 0; j < N; j++) {
                    const tmp = x[xAt + j]! + 1e-30 + m;
                    m = PREEMPH_COEF * tmp;
                    pcm[y] += tmp / 32768;
                    y += C;
                }
            } else {
                for (let j = 0; j < N; j++) {
                    const tmp = x[xAt + j]! + 1e-30 + m;
                    m = PREEMPH_COEF * tmp;
                    pcm[y] = tmp / 32768;
                    y += C;
                }
            }
            this.preemphMem[c] = m;
        }
    }

    private denormaliseBands(
        X: Float32Array,
        xAt: number,
        freq: Float32Array,
        freqAt: number,
        bandLogE: Float32Array,
        bandAt: number,
        start: number,
        end: number,
        M: number,
        silence: boolean,
    ): void {
        const N = M * SHORT_MDCT_SIZE;
        let bound = M * EBANDS[end]!;
        if (silence) {
            bound = 0;
            start = end = 0;
        }
        freq.fill(0, freqAt, freqAt + M * EBANDS[start]!);
        for (let i = start; i < end; i++) {
            const bandEnd = M * EBANDS[i + 1]!;
            const lg = bandLogE[bandAt + i]! + E_MEANS[i]!;
            const g = celtExp2(Math.min(32, lg));
            for (let j = M * EBANDS[i]!; j < bandEnd; j++) freq[freqAt + j] = X[xAt + j]! * g;
        }
        freq.fill(0, freqAt + bound, freqAt + N);
    }

    private synthesis(
        start: number,
        effEnd: number,
        C: number,
        isTransient: boolean,
        LM: number,
        silence: boolean,
    ): void {
        const CC = this.channels;
        const N = SHORT_MDCT_SIZE << LM;
        const M = 1 << LM;
        const X = this.X;
        const freq = this.freq;
        let B: number;
        let NB: number;
        let shift: number;
        if (isTransient) {
            B = M;
            NB = SHORT_MDCT_SIZE;
            shift = MAX_LM;
        } else {
            B = 1;
            NB = SHORT_MDCT_SIZE << LM;
            shift = MAX_LM - LM;
        }
        const outAt = DECODE_BUFFER_SIZE - N;
        if (CC === 2 && C === 1) {
            this.denormaliseBands(X, 0, freq, 0, this.oldBandE, 0, start, effEnd, M, silence);
            const freq2 = this.decodeMem[1]!;
            const freq2At = outAt + (OVERLAP >> 1);
            freq2.set(freq.subarray(0, N), freq2At);
            for (let b = 0; b < B; b++)
                MDCT.backward(
                    freq2,
                    freq2At + b,
                    this.decodeMem[0]!,
                    outAt + NB * b,
                    WINDOW,
                    OVERLAP,
                    shift,
                    B,
                );
            for (let b = 0; b < B; b++)
                MDCT.backward(
                    freq,
                    b,
                    this.decodeMem[1]!,
                    outAt + NB * b,
                    WINDOW,
                    OVERLAP,
                    shift,
                    B,
                );
        } else if (CC === 1 && C === 2) {
            const freq2 = this.decodeMem[0]!;
            const freq2At = outAt + (OVERLAP >> 1);
            this.denormaliseBands(X, 0, freq, 0, this.oldBandE, 0, start, effEnd, M, silence);
            this.denormaliseBands(
                X,
                N,
                freq2,
                freq2At,
                this.oldBandE,
                NB_EBANDS,
                start,
                effEnd,
                M,
                silence,
            );
            for (let i = 0; i < N; i++) freq[i] = 0.5 * freq[i]! + 0.5 * freq2[freq2At + i]!;
            for (let b = 0; b < B; b++)
                MDCT.backward(
                    freq,
                    b,
                    this.decodeMem[0]!,
                    outAt + NB * b,
                    WINDOW,
                    OVERLAP,
                    shift,
                    B,
                );
        } else {
            for (let c = 0; c < CC; c++) {
                this.denormaliseBands(
                    X,
                    c * N,
                    freq,
                    0,
                    this.oldBandE,
                    c * NB_EBANDS,
                    start,
                    effEnd,
                    M,
                    silence,
                );
                for (let b = 0; b < B; b++)
                    MDCT.backward(
                        freq,
                        b,
                        this.decodeMem[c]!,
                        outAt + NB * b,
                        WINDOW,
                        OVERLAP,
                        shift,
                        B,
                    );
            }
        }
    }

    private tfDecode(
        start: number,
        end: number,
        isTransient: boolean,
        LM: number,
        dec: RangeDecoder,
    ): void {
        const tfRes = this.tfRes;
        let budget = dec.storage * 8;
        let tell = dec.tell();
        let logp = isTransient ? 2 : 4;
        const tfSelectRsv = LM > 0 && tell + logp + 1 <= budget ? 1 : 0;
        budget -= tfSelectRsv;
        let tfChanged = 0;
        let curr = 0;
        for (let i = start; i < end; i++) {
            if (tell + logp <= budget) {
                curr ^= dec.decodeBitLogp(logp);
                tell = dec.tell();
                tfChanged |= curr;
            }
            tfRes[i] = curr;
            logp = isTransient ? 4 : 5;
        }
        let tfSelect = 0;
        const table = TF_SELECT_TABLE[LM]!;
        const t = isTransient ? 4 : 0;
        if (tfSelectRsv && table[t + 0 + tfChanged] !== table[t + 2 + tfChanged])
            tfSelect = dec.decodeBitLogp(1);
        for (let i = start; i < end; i++) tfRes[i] = table[t + 2 * tfSelect + tfRes[i]!]!;
    }

    private unquantCoarseEnergy(
        start: number,
        end: number,
        intra: number,
        dec: RangeDecoder,
        C: number,
        LM: number,
    ): void {
        const probModel = E_PROB_MODEL[LM]![intra]!;
        const oldEBands = this.oldBandE;
        const prev = [0, 0];
        const coef = intra ? 0 : PRED_COEF[LM]!;
        const beta = intra ? BETA_INTRA : BETA_COEF[LM]!;
        const budget = dec.storage * 8;
        for (let i = start; i < end; i++) {
            for (let c = 0; c < C; c++) {
                const tell = dec.tell();
                let qi: number;
                if (budget - tell >= 15) {
                    const pi = 2 * Math.min(i, 20);
                    qi = dec.decodeLaplace(probModel[pi]! << 7, probModel[pi + 1]! << 6);
                } else if (budget - tell >= 2) {
                    qi = dec.decodeIcdf(SMALL_ENERGY_ICDF, 0, 2);
                    qi = (qi >> 1) ^ -(qi & 1);
                } else if (budget - tell >= 1) qi = -dec.decodeBitLogp(1);
                else qi = -1;
                const q = qi;
                oldEBands[i + c * NB_EBANDS] = Math.max(-9, oldEBands[i + c * NB_EBANDS]!);
                const tmp = coef * oldEBands[i + c * NB_EBANDS]! + prev[c]! + q;
                oldEBands[i + c * NB_EBANDS] = tmp;
                prev[c] = prev[c]! + q - beta * q;
            }
        }
    }

    private unquantFineEnergy(start: number, end: number, dec: RangeDecoder, C: number): void {
        const fineQuant = this.fineQuant;
        for (let i = start; i < end; i++) {
            if (fineQuant[i]! <= 0) continue;
            for (let c = 0; c < C; c++) {
                const q2 = dec.decodeBits(fineQuant[i]!);
                const offset = (q2 + 0.5) * (1 << (14 - fineQuant[i]!)) * (1 / 16384) - 0.5;
                this.oldBandE[i + c * NB_EBANDS] += offset;
            }
        }
    }

    private unquantEnergyFinalise(
        start: number,
        end: number,
        bitsLeft: number,
        dec: RangeDecoder,
        C: number,
    ): void {
        for (let prio = 0; prio < 2; prio++) {
            for (let i = start; i < end && bitsLeft >= C; i++) {
                if (this.fineQuant[i]! >= MAX_FINE_BITS || this.finePriority[i] !== prio) continue;
                for (let c = 0; c < C; c++) {
                    const q2 = dec.decodeBits(1);
                    const offset = (q2 - 0.5) * (1 << (14 - this.fineQuant[i]! - 1)) * (1 / 16384);
                    this.oldBandE[i + c * NB_EBANDS] += offset;
                    bitsLeft--;
                }
            }
        }
    }

    private computeAllocation(
        start: number,
        end: number,
        allocTrim: number,
        total: number,
        C: number,
        LM: number,
        dec: RangeDecoder,
    ): Allocation {
        const offsets = this.offsets;
        const cap = this.cap;
        const bits1 = this.bits1;
        const bits2 = this.bits2;
        const thresh = this.thresh;
        const trimOffset = this.trimOffset;
        const bits = this.pulses;
        const ebits = this.fineQuant;
        const finePriority = this.finePriority;
        total = Math.max(total, 0);
        let skipStart = start;
        const skipRsv = total >= 1 << BITRES ? 1 << BITRES : 0;
        total -= skipRsv;
        let intensityRsv = 0;
        let dualStereoRsv = 0;
        if (C === 2) {
            intensityRsv = LOG2_FRAC_TABLE[end - start]!;
            if (intensityRsv > total) intensityRsv = 0;
            else {
                total -= intensityRsv;
                dualStereoRsv = total >= 1 << BITRES ? 1 << BITRES : 0;
                total -= dualStereoRsv;
            }
        }
        for (let j = start; j < end; j++) {
            const width = EBANDS[j + 1]! - EBANDS[j]!;
            thresh[j] = Math.max(C << BITRES, (((3 * width) << LM) << BITRES) >> 4);
            trimOffset[j] =
                (C * width * (allocTrim - 5 - LM) * (end - j - 1) * (1 << (LM + BITRES))) >> 6;
            if (width << LM === 1) trimOffset[j] = trimOffset[j]! - (C << BITRES);
        }
        let lo = 1;
        let hi = NB_ALLOC_VECTORS - 1;
        do {
            let done = false;
            let psum = 0;
            const mid = (lo + hi) >> 1;
            for (let j = end; j-- > start;) {
                const N = EBANDS[j + 1]! - EBANDS[j]!;
                let bitsj = ((C * N * ALLOC_VECTORS[mid * NB_EBANDS + j]!) << LM) >> 2;
                if (bitsj > 0) bitsj = Math.max(0, bitsj + trimOffset[j]!);
                bitsj += offsets[j]!;
                if (bitsj >= thresh[j]! || done) {
                    done = true;
                    psum += Math.min(bitsj, cap[j]!);
                } else if (bitsj >= C << BITRES) psum += C << BITRES;
            }
            if (psum > total) hi = mid - 1;
            else lo = mid + 1;
        } while (lo <= hi);
        hi = lo--;
        for (let j = start; j < end; j++) {
            const N = EBANDS[j + 1]! - EBANDS[j]!;
            let bits1j = ((C * N * ALLOC_VECTORS[lo * NB_EBANDS + j]!) << LM) >> 2;
            let bits2j =
                hi >= NB_ALLOC_VECTORS
                    ? cap[j]!
                    : ((C * N * ALLOC_VECTORS[hi * NB_EBANDS + j]!) << LM) >> 2;
            if (bits1j > 0) bits1j = Math.max(0, bits1j + trimOffset[j]!);
            if (bits2j > 0) bits2j = Math.max(0, bits2j + trimOffset[j]!);
            if (lo > 0) bits1j += offsets[j]!;
            bits2j += offsets[j]!;
            if (offsets[j]! > 0) skipStart = j;
            bits2j = Math.max(0, bits2j - bits1j);
            bits1[j] = bits1j;
            bits2[j] = bits2j;
        }
        const allocFloor = C << BITRES;
        const stereo = C > 1 ? 1 : 0;
        const logM = LM << BITRES;
        lo = 0;
        hi = 1 << 6;
        for (let i = 0; i < 6; i++) {
            const mid = (lo + hi) >> 1;
            let psum = 0;
            let done = false;
            for (let j = end; j-- > start;) {
                const tmp = bits1[j]! + ((mid * bits2[j]!) >> 6);
                if (tmp >= thresh[j]! || done) {
                    done = true;
                    psum += Math.min(tmp, cap[j]!);
                } else if (tmp >= allocFloor) psum += allocFloor;
            }
            if (psum > total) hi = mid;
            else lo = mid;
        }
        let psum = 0;
        let done = false;
        for (let j = end; j-- > start;) {
            let tmp = bits1[j]! + ((lo * bits2[j]!) >> 6);
            if (tmp < thresh[j]! && !done) tmp = tmp >= allocFloor ? allocFloor : 0;
            else done = true;
            tmp = Math.min(tmp, cap[j]!);
            bits[j] = tmp;
            psum += tmp;
        }
        let codedBands: number;
        for (codedBands = end; ; codedBands--) {
            const j = codedBands - 1;
            if (j <= skipStart) {
                total += skipRsv;
                break;
            }
            let left = total - psum;
            const percoeff = Math.floor(left / (EBANDS[codedBands]! - EBANDS[start]!));
            left -= (EBANDS[codedBands]! - EBANDS[start]!) * percoeff;
            const rem = Math.max(left - (EBANDS[j]! - EBANDS[start]!), 0);
            const bandWidth = EBANDS[codedBands]! - EBANDS[j]!;
            let bandBits = bits[j]! + percoeff * bandWidth + rem;
            if (bandBits >= Math.max(thresh[j]!, allocFloor + (1 << BITRES))) {
                if (dec.decodeBitLogp(1)) break;
                psum += 1 << BITRES;
                bandBits -= 1 << BITRES;
            }
            psum -= bits[j]! + intensityRsv;
            if (intensityRsv > 0) intensityRsv = LOG2_FRAC_TABLE[j - start]!;
            psum += intensityRsv;
            if (bandBits >= allocFloor) {
                psum += allocFloor;
                bits[j] = allocFloor;
            } else bits[j] = 0;
        }
        let intensity = 0;
        if (intensityRsv > 0) intensity = start + dec.decodeUint(codedBands + 1 - start);
        if (intensity <= start) {
            total += dualStereoRsv;
            dualStereoRsv = 0;
        }
        let dualStereo = 0;
        if (dualStereoRsv > 0) dualStereo = dec.decodeBitLogp(1);
        let left = total - psum;
        const percoeff = Math.floor(left / (EBANDS[codedBands]! - EBANDS[start]!));
        left -= (EBANDS[codedBands]! - EBANDS[start]!) * percoeff;
        for (let j = start; j < codedBands; j++)
            bits[j] = bits[j]! + percoeff * (EBANDS[j + 1]! - EBANDS[j]!);
        for (let j = start; j < codedBands; j++) {
            const tmp = Math.min(left, EBANDS[j + 1]! - EBANDS[j]!);
            bits[j] = bits[j]! + tmp;
            left -= tmp;
        }
        let balance = 0;
        let j: number;
        for (j = start; j < codedBands; j++) {
            const N0 = EBANDS[j + 1]! - EBANDS[j]!;
            const N = N0 << LM;
            const bit = bits[j]! + balance;
            let excess: number;
            if (N > 1) {
                excess = Math.max(bit - cap[j]!, 0);
                bits[j] = bit - excess;
                const den = C * N + (C === 2 && N > 2 && !dualStereo && j < intensity ? 1 : 0);
                const NClogN = den * (LOGN[j]! + logM);
                let offset = (NClogN >> 1) - den * FINE_OFFSET;
                if (N === 2) offset += (den << BITRES) >> 2;
                if (bits[j]! + offset < (den * 2) << BITRES) offset += NClogN >> 2;
                else if (bits[j]! + offset < (den * 3) << BITRES) offset += NClogN >> 3;
                ebits[j] = Math.max(0, bits[j]! + offset + (den << (BITRES - 1)));
                ebits[j] = Math.floor(ebits[j]! / den) >> BITRES;
                if (C * ebits[j]! > bits[j]! >> BITRES) ebits[j] = (bits[j]! >> stereo) >> BITRES;
                ebits[j] = Math.min(ebits[j]!, MAX_FINE_BITS);
                finePriority[j] = ebits[j]! * (den << BITRES) >= bits[j]! + offset ? 1 : 0;
                bits[j] = bits[j]! - ((C * ebits[j]!) << BITRES);
            } else {
                excess = Math.max(0, bit - (C << BITRES));
                bits[j] = bit - excess;
                ebits[j] = 0;
                finePriority[j] = 1;
            }
            if (excess > 0) {
                const extraFine = Math.min(excess >> (stereo + BITRES), MAX_FINE_BITS - ebits[j]!);
                ebits[j] = ebits[j]! + extraFine;
                const extraBits = (extraFine * C) << BITRES;
                finePriority[j] = extraBits >= excess - balance ? 1 : 0;
                excess -= extraBits;
            }
            balance = excess;
        }
        for (; j < end; j++) {
            ebits[j] = (bits[j]! >> stereo) >> BITRES;
            bits[j] = 0;
            finePriority[j] = ebits[j]! < 1 ? 1 : 0;
        }
        return { codedBands, intensity, dualStereo, balance };
    }

    private antiCollapse(
        LM: number,
        C: number,
        size: number,
        start: number,
        end: number,
        seed: number,
    ): void {
        const X_ = this.X;
        const collapseMasks = this.collapseMasks;
        const logE = this.oldBandE;
        const prev1logE = this.oldLogE;
        const prev2logE = this.oldLogE2;
        const pulses = this.pulses;
        for (let i = start; i < end; i++) {
            const N0 = EBANDS[i + 1]! - EBANDS[i]!;
            const depth = Math.floor((1 + pulses[i]!) / N0) >> LM;
            const thresh = 0.5 * celtExp2(-0.125 * depth);
            const sqrt1 = 1 / Math.sqrt(N0 << LM);
            for (let c = 0; c < C; c++) {
                let prev1 = prev1logE[c * NB_EBANDS + i]!;
                let prev2 = prev2logE[c * NB_EBANDS + i]!;
                if (C === 1) {
                    prev1 = Math.max(prev1, prev1logE[NB_EBANDS + i]!);
                    prev2 = Math.max(prev2, prev2logE[NB_EBANDS + i]!);
                }
                let Ediff = logE[c * NB_EBANDS + i]! - Math.min(prev1, prev2);
                Ediff = Math.max(0, Ediff);
                let r = 2 * celtExp2(-Ediff);
                if (LM === 3) r *= 1.41421356;
                r = Math.min(thresh, r);
                r = r * sqrt1;
                const xAt = c * size + (EBANDS[i]! << LM);
                let renormalize = false;
                for (let k = 0; k < 1 << LM; k++) {
                    if (!(collapseMasks[i * C + c]! & (1 << k))) {
                        for (let j = 0; j < N0; j++) {
                            seed = celtLcgRand(seed);
                            X_[xAt + (j << LM) + k] = seed & 0x8000 ? r : -r;
                        }
                        renormalize = true;
                    }
                }
                if (renormalize) renormaliseVector(X_, xAt, N0 << LM, 1);
            }
        }
    }

    private plcPitchSearch(): number {
        const C = this.channels;
        const len = DECODE_BUFFER_SIZE;
        const xLp = this.plcLpPitch;
        const x0 = this.decodeMem[0]!;
        for (let i = 1; i < len >> 1; i++)
            xLp[i] = 0.5 * (0.5 * (x0[2 * i - 1]! + x0[2 * i + 1]!) + x0[2 * i]!);
        xLp[0] = 0.5 * (0.5 * x0[1]! + x0[0]!);
        if (C === 2) {
            const x1 = this.decodeMem[1]!;
            for (let i = 1; i < len >> 1; i++)
                xLp[i] += 0.5 * (0.5 * (x1[2 * i - 1]! + x1[2 * i + 1]!) + x1[2 * i]!);
            xLp[0] += 0.5 * (0.5 * x1[1]! + x1[0]!);
        }
        const ac = this.plcAc;
        celtAutocorr(xLp, 0, ac, null, 0, 4, len >> 1, this.plcWindowed);
        ac[0]! *= 1.0001;
        for (let i = 1; i <= 4; i++) ac[i]! -= ac[i]! * (0.008 * i) * (0.008 * i);
        const lpc = this.plcLpcMem;
        celtLpc(lpc, 0, ac, 4);
        let tmp = 1;
        for (let i = 0; i < 4; i++) {
            tmp = 0.9 * tmp;
            lpc[i] = lpc[i]! * tmp;
        }
        const c1 = 0.8;
        const lpc2 = [
            lpc[0]! + 0.8,
            lpc[1]! + c1 * lpc[0]!,
            lpc[2]! + c1 * lpc[1]!,
            lpc[3]! + c1 * lpc[2]!,
            c1 * lpc[3]!,
        ];
        let mem0 = 0;
        let mem1 = 0;
        let mem2 = 0;
        let mem3 = 0;
        let mem4 = 0;
        for (let i = 0; i < len >> 1; i++) {
            const sum =
                xLp[i]! +
                lpc2[0]! * mem0 +
                lpc2[1]! * mem1 +
                lpc2[2]! * mem2 +
                lpc2[3]! * mem3 +
                lpc2[4]! * mem4;
            mem4 = mem3;
            mem3 = mem2;
            mem2 = mem1;
            mem1 = mem0;
            mem0 = xLp[i]!;
            xLp[i] = sum;
        }
        const pitchIndex = this.pitchSearch(
            xLp,
            PLC_PITCH_LAG_MAX >> 1,
            xLp,
            len - PLC_PITCH_LAG_MAX,
            PLC_PITCH_LAG_MAX - PLC_PITCH_LAG_MIN,
        );
        return PLC_PITCH_LAG_MAX - pitchIndex;
    }

    private pitchSearch(
        xLp: Float32Array,
        xAt: number,
        y: Float32Array,
        len: number,
        maxPitch: number,
    ): number {
        const lag = len + maxPitch;
        const xLp4 = this.plcXlp4;
        const yLp4 = this.plcYlp4;
        const xcorr = this.plcXcorr;
        for (let j = 0; j < len >> 2; j++) xLp4[j] = xLp[xAt + 2 * j]!;
        for (let j = 0; j < lag >> 2; j++) yLp4[j] = y[2 * j]!;
        for (let i = 0; i < maxPitch >> 2; i++) {
            let sum = 0;
            for (let j = 0; j < len >> 2; j++) sum += xLp4[j]! * yLp4[i + j]!;
            xcorr[i] = sum;
        }
        const best = [0, 0];
        findBestPitch(xcorr, yLp4, len >> 2, maxPitch >> 2, best);
        for (let i = 0; i < maxPitch >> 1; i++) {
            xcorr[i] = 0;
            if (Math.abs(i - 2 * best[0]!) > 2 && Math.abs(i - 2 * best[1]!) > 2) continue;
            let sum = 0;
            for (let j = 0; j < len >> 1; j++) sum += xLp[xAt + j]! * y[i + j]!;
            xcorr[i] = Math.max(-1, sum);
        }
        findBestPitch(xcorr, y, len >> 1, maxPitch >> 1, best);
        let offset = 0;
        if (best[0]! > 0 && best[0]! < (maxPitch >> 1) - 1) {
            const a = xcorr[best[0]! - 1]!;
            const b = xcorr[best[0]!]!;
            const c = xcorr[best[0]! + 1]!;
            if (c - a > 0.7 * (b - a)) offset = 1;
            else if (a - c > 0.7 * (b - c)) offset = -1;
        }
        return 2 * best[0]! - offset;
    }

    private decodeLost(N: number, LM: number): void {
        const C = this.channels;
        const start = this.start;
        const lossCount = this.lossCount;
        const noiseBased = lossCount >= 5 || start !== 0 || this.skipPlc;
        if (noiseBased) {
            const end = this.end;
            const effEnd = Math.max(start, Math.min(end, EFF_EBANDS));
            const X = this.X;
            const decay = lossCount === 0 ? 1.5 : 0.5;
            for (let c = 0; c < C; c++)
                for (let i = start; i < end; i++)
                    this.oldBandE[c * NB_EBANDS + i] = Math.max(
                        this.backgroundLogE[c * NB_EBANDS + i]!,
                        this.oldBandE[c * NB_EBANDS + i]! - decay,
                    );
            let seed = this.rng;
            for (let c = 0; c < C; c++) {
                for (let i = start; i < effEnd; i++) {
                    const boffs = N * c + (EBANDS[i]! << LM);
                    const blen = (EBANDS[i + 1]! - EBANDS[i]!) << LM;
                    for (let j = 0; j < blen; j++) {
                        seed = celtLcgRand(seed);
                        X[boffs + j] = (seed | 0) >> 20;
                    }
                    renormaliseVector(X, boffs, blen, 1);
                }
            }
            this.rng = seed;
            for (let c = 0; c < C; c++)
                this.decodeMem[c]!.copyWithin(0, N, N + DECODE_BUFFER_SIZE - N + (OVERLAP >> 1));
            this.synthesis(start, effEnd, C, false, LM, false);
        } else {
            let fade = 1;
            let pitchIndex: number;
            if (lossCount === 0) {
                this.lastPitchIndex = pitchIndex = this.plcPitchSearch();
            } else {
                pitchIndex = this.lastPitchIndex;
                fade = 0.8;
            }
            const excLength = Math.min(2 * pitchIndex, MAX_PERIOD);
            const exc = this.plcExc;
            const excAt = LPC_ORDER;
            const fir = this.plcFir;
            const etmp = this.plcEtmp;
            for (let c = 0; c < C; c++) {
                const buf = this.decodeMem[c]!;
                const lpcAt = c * LPC_ORDER;
                for (let i = 0; i < MAX_PERIOD + LPC_ORDER; i++)
                    exc[i] = buf[DECODE_BUFFER_SIZE - MAX_PERIOD - LPC_ORDER + i]!;
                if (lossCount === 0) {
                    const ac = this.plcAc;
                    celtAutocorr(
                        exc,
                        excAt,
                        ac,
                        WINDOW,
                        OVERLAP,
                        LPC_ORDER,
                        MAX_PERIOD,
                        this.plcWindowed,
                    );
                    ac[0]! *= 1.0001;
                    for (let i = 1; i <= LPC_ORDER; i++) ac[i]! -= ac[i]! * (0.008 * 0.008) * i * i;
                    celtLpc(this.lpc, lpcAt, ac, LPC_ORDER);
                }
                for (let i = 0; i < excLength; i++) {
                    const at = excAt + MAX_PERIOD - excLength + i;
                    let sum = exc[at]!;
                    for (let j = 0; j < LPC_ORDER; j++)
                        sum += this.lpc[lpcAt + j]! * exc[at - j - 1]!;
                    fir[i] = sum;
                }
                exc.set(fir.subarray(0, excLength), excAt + MAX_PERIOD - excLength);
                let E1 = 1;
                let E2 = 1;
                const decayLength = excLength >> 1;
                for (let i = 0; i < decayLength; i++) {
                    let e = exc[excAt + MAX_PERIOD - decayLength + i]!;
                    E1 += e * e;
                    e = exc[excAt + MAX_PERIOD - 2 * decayLength + i]!;
                    E2 += e * e;
                }
                E1 = Math.min(E1, E2);
                const decay = Math.sqrt((E1 * 0.5) / E2);
                buf.copyWithin(0, N, DECODE_BUFFER_SIZE);
                const extrapolationOffset = MAX_PERIOD - pitchIndex;
                const extrapolationLen = N + OVERLAP;
                let attenuation = fade * decay;
                let S1 = 0;
                for (let i = 0, j = 0; i < extrapolationLen; i++, j++) {
                    if (j >= pitchIndex) {
                        j -= pitchIndex;
                        attenuation = attenuation * decay;
                    }
                    buf[DECODE_BUFFER_SIZE - N + i] =
                        attenuation * exc[excAt + extrapolationOffset + j]!;
                    const tmp = buf[DECODE_BUFFER_SIZE - MAX_PERIOD - N + extrapolationOffset + j]!;
                    S1 += tmp * tmp;
                }
                const mem = this.plcLpcMem;
                for (let i = 0; i < LPC_ORDER; i++) mem[i] = buf[DECODE_BUFFER_SIZE - N - 1 - i]!;
                for (let i = 0; i < extrapolationLen; i++) {
                    let sum = buf[DECODE_BUFFER_SIZE - N + i]!;
                    for (let j = 0; j < LPC_ORDER; j++) sum -= this.lpc[lpcAt + j]! * mem[j]!;
                    for (let j = LPC_ORDER - 1; j >= 1; j--) mem[j] = mem[j - 1]!;
                    mem[0] = sum;
                    buf[DECODE_BUFFER_SIZE - N + i] = sum;
                }
                let S2 = 0;
                for (let i = 0; i < extrapolationLen; i++) {
                    const tmp = buf[DECODE_BUFFER_SIZE - N + i]!;
                    S2 += tmp * tmp;
                }
                if (!(S1 > 0.2 * S2)) {
                    buf.fill(0, DECODE_BUFFER_SIZE - N, DECODE_BUFFER_SIZE - N + extrapolationLen);
                } else if (S1 < S2) {
                    const ratio = Math.sqrt((S1 * 0.5 + 1) / (S2 + 1));
                    for (let i = 0; i < OVERLAP; i++) {
                        const tmpG = 1 - WINDOW[i]! * (1 - ratio);
                        buf[DECODE_BUFFER_SIZE - N + i] = tmpG * buf[DECODE_BUFFER_SIZE - N + i]!;
                    }
                    for (let i = OVERLAP; i < extrapolationLen; i++)
                        buf[DECODE_BUFFER_SIZE - N + i] = ratio * buf[DECODE_BUFFER_SIZE - N + i]!;
                }
                combFilter(
                    etmp,
                    0,
                    buf,
                    DECODE_BUFFER_SIZE,
                    this.postfilterPeriod,
                    this.postfilterPeriod,
                    OVERLAP,
                    -this.postfilterGain,
                    -this.postfilterGain,
                    this.postfilterTapset,
                    this.postfilterTapset,
                    null,
                    0,
                );
                for (let i = 0; i < OVERLAP >> 1; i++)
                    buf[DECODE_BUFFER_SIZE + i] =
                        WINDOW[i]! * etmp[OVERLAP - 1 - i]! + WINDOW[OVERLAP - i - 1]! * etmp[i]!;
            }
        }
        this.lossCount = lossCount + 1;
    }

    /**
     * celt_decode_with_ec: one CELT frame of `frameSize` samples (a null `data` conceals a lost
     * frame) into `pcm` interleaved at pcmAt (added when `accum`), sharing the range decoder `dec`
     * when given.
     */
    decode(
        data: Uint8Array | null,
        dataStart: number,
        len: number,
        pcm: Float32Array,
        pcmAt: number,
        frameSize: number,
        dec: RangeDecoder | null,
        accum: boolean,
        scratchDec: RangeDecoder,
    ): void {
        const CC = this.channels;
        const C = this.streamChannels;
        const start = this.start;
        const end = this.end;
        let LM: number;
        for (LM = 0; LM <= MAX_LM; LM++) if (SHORT_MDCT_SIZE << LM === frameSize) break;
        if (LM > MAX_LM) throw new Error('CELT frame size is not 120 << LM');
        const M = 1 << LM;
        const N = M * SHORT_MDCT_SIZE;
        const effEnd = Math.min(end, EFF_EBANDS);
        if (data === null || len <= 1) {
            this.decodeLost(N, LM);
            this.deemphasis(pcm, pcmAt, N, accum);
            return;
        }
        this.skipPlc = this.lossCount !== 0;
        if (dec === null) {
            scratchDec.init(data, dataStart, len);
            dec = scratchDec;
        }
        const oldBandE = this.oldBandE;
        if (C === 1)
            for (let i = 0; i < NB_EBANDS; i++)
                oldBandE[i] = Math.max(oldBandE[i]!, oldBandE[NB_EBANDS + i]!);
        let totalBits = len * 8;
        let tell = dec.tell();
        let silence: boolean;
        if (tell >= totalBits) silence = true;
        else if (tell === 1) silence = dec.decodeBitLogp(15) === 1;
        else silence = false;
        if (silence) {
            tell = len * 8;
            dec.nbitsTotal += tell - dec.tell();
        }
        let postfilterGain = 0;
        let postfilterPitch = 0;
        let postfilterTapset = 0;
        if (start === 0 && tell + 16 <= totalBits) {
            if (dec.decodeBitLogp(1)) {
                const octave = dec.decodeUint(6);
                postfilterPitch = (16 << octave) + dec.decodeBits(4 + octave) - 1;
                const qg = dec.decodeBits(3);
                if (dec.tell() + 2 <= totalBits)
                    postfilterTapset = dec.decodeIcdf(TAPSET_ICDF, 0, 2);
                postfilterGain = 0.09375 * (qg + 1);
            }
            tell = dec.tell();
        }
        let isTransient = false;
        if (LM > 0 && tell + 3 <= totalBits) {
            isTransient = dec.decodeBitLogp(3) === 1;
            tell = dec.tell();
        }
        const shortBlocks = isTransient ? M : 0;
        const intraEner = tell + 3 <= totalBits ? dec.decodeBitLogp(3) : 0;
        this.unquantCoarseEnergy(start, end, intraEner, dec, C, LM);
        this.tfDecode(start, end, isTransient, LM, dec);
        tell = dec.tell();
        let spreadDecision = SPREAD_NORMAL;
        if (tell + 4 <= totalBits) spreadDecision = dec.decodeIcdf(SPREAD_ICDF, 0, 5);
        const cap = this.cap;
        for (let i = 0; i < NB_EBANDS; i++) {
            const width = (EBANDS[i + 1]! - EBANDS[i]!) << LM;
            cap[i] = ((PULSE_CACHE.caps[NB_EBANDS * (2 * LM + C - 1) + i]! + 64) * C * width) >> 2;
        }
        const offsets = this.offsets;
        let dynallocLogp = 6;
        totalBits <<= BITRES;
        tell = dec.tellFrac();
        for (let i = start; i < end; i++) {
            const width = (C * (EBANDS[i + 1]! - EBANDS[i]!)) << LM;
            const quanta = Math.min(width << BITRES, Math.max(6 << BITRES, width));
            let dynallocLoopLogp = dynallocLogp;
            let boost = 0;
            while (tell + (dynallocLoopLogp << BITRES) < totalBits && boost < cap[i]!) {
                const flag = dec.decodeBitLogp(dynallocLoopLogp);
                tell = dec.tellFrac();
                if (!flag) break;
                boost += quanta;
                totalBits -= quanta;
                dynallocLoopLogp = 1;
            }
            offsets[i] = boost;
            if (boost > 0) dynallocLogp = Math.max(2, dynallocLogp - 1);
        }
        const allocTrim = tell + (6 << BITRES) <= totalBits ? dec.decodeIcdf(TRIM_ICDF, 0, 7) : 5;
        let bits = ((len * 8) << BITRES) - dec.tellFrac() - 1;
        const antiCollapseRsv =
            isTransient && LM >= 2 && bits >= (LM + 2) << BITRES ? 1 << BITRES : 0;
        bits -= antiCollapseRsv;
        const allocation = this.computeAllocation(start, end, allocTrim, bits, C, LM, dec);
        this.unquantFineEnergy(start, end, dec, C);
        for (let c = 0; c < CC; c++)
            this.decodeMem[c]!.copyWithin(0, N, N + DECODE_BUFFER_SIZE - N + (OVERLAP >> 1));
        const X = this.X;
        this.rng = decodeAllBands(
            start,
            end,
            X,
            C === 2 ? this.yViews[LM]! : null,
            this.collapseMasks,
            this.pulses,
            shortBlocks,
            spreadDecision,
            allocation.dualStereo,
            allocation.intensity,
            this.tfRes,
            len * (8 << BITRES) - antiCollapseRsv,
            allocation.balance,
            dec,
            LM,
            allocation.codedBands,
            this.rng,
            this.disableInv,
        );
        let antiCollapseOn = 0;
        if (antiCollapseRsv > 0) antiCollapseOn = dec.decodeBits(1);
        this.unquantEnergyFinalise(start, end, len * 8 - dec.tell(), dec, C);
        if (antiCollapseOn) this.antiCollapse(LM, C, N, start, end, this.rng);
        if (silence) for (let i = 0; i < C * NB_EBANDS; i++) oldBandE[i] = -28;
        this.synthesis(start, effEnd, C, isTransient, LM, silence);
        for (let c = 0; c < CC; c++) {
            const out = this.decodeMem[c]!;
            const outAt = DECODE_BUFFER_SIZE - N;
            this.postfilterPeriod = Math.max(this.postfilterPeriod, COMBFILTER_MINPERIOD);
            this.postfilterPeriodOld = Math.max(this.postfilterPeriodOld, COMBFILTER_MINPERIOD);
            combFilter(
                out,
                outAt,
                out,
                outAt,
                this.postfilterPeriodOld,
                this.postfilterPeriod,
                SHORT_MDCT_SIZE,
                this.postfilterGainOld,
                this.postfilterGain,
                this.postfilterTapsetOld,
                this.postfilterTapset,
                WINDOW,
                OVERLAP,
            );
            if (LM !== 0)
                combFilter(
                    out,
                    outAt + SHORT_MDCT_SIZE,
                    out,
                    outAt + SHORT_MDCT_SIZE,
                    this.postfilterPeriod,
                    postfilterPitch,
                    N - SHORT_MDCT_SIZE,
                    this.postfilterGain,
                    postfilterGain,
                    this.postfilterTapset,
                    postfilterTapset,
                    WINDOW,
                    OVERLAP,
                );
        }
        this.postfilterPeriodOld = this.postfilterPeriod;
        this.postfilterGainOld = this.postfilterGain;
        this.postfilterTapsetOld = this.postfilterTapset;
        this.postfilterPeriod = postfilterPitch;
        this.postfilterGain = postfilterGain;
        this.postfilterTapset = postfilterTapset;
        if (LM !== 0) {
            this.postfilterPeriodOld = this.postfilterPeriod;
            this.postfilterGainOld = this.postfilterGain;
            this.postfilterTapsetOld = this.postfilterTapset;
        }
        if (C === 1) oldBandE.copyWithin(NB_EBANDS, 0, NB_EBANDS);
        if (!isTransient) {
            this.oldLogE2.set(this.oldLogE);
            this.oldLogE.set(oldBandE);
            const maxBackgroundIncrease = this.lossCount < 10 ? M * 0.001 : 1;
            for (let i = 0; i < 2 * NB_EBANDS; i++)
                this.backgroundLogE[i] = Math.min(
                    this.backgroundLogE[i]! + maxBackgroundIncrease,
                    oldBandE[i]!,
                );
        } else {
            for (let i = 0; i < 2 * NB_EBANDS; i++)
                this.oldLogE[i] = Math.min(this.oldLogE[i]!, oldBandE[i]!);
        }
        for (let c = 0; c < 2; c++) {
            for (let i = 0; i < start; i++) {
                oldBandE[c * NB_EBANDS + i] = 0;
                this.oldLogE[c * NB_EBANDS + i] = this.oldLogE2[c * NB_EBANDS + i] = -28;
            }
            for (let i = end; i < NB_EBANDS; i++) {
                oldBandE[c * NB_EBANDS + i] = 0;
                this.oldLogE[c * NB_EBANDS + i] = this.oldLogE2[c * NB_EBANDS + i] = -28;
            }
        }
        this.rng = dec.rng;
        this.deemphasis(pcm, pcmAt, N, accum);
        this.lossCount = 0;
        dec.checkOverrun(len, 'CELT');
    }
}

function findBestPitch(
    xcorr: Float32Array,
    y: Float32Array,
    len: number,
    maxPitch: number,
    best: number[],
): void {
    let Syy = 1;
    const bestNum = [-1, -1];
    const bestDen = [0, 0];
    best[0] = 0;
    best[1] = 1;
    for (let j = 0; j < len; j++) Syy += y[j]! * y[j]!;
    for (let i = 0; i < maxPitch; i++) {
        if (xcorr[i]! > 0) {
            let xcorr16 = xcorr[i]!;
            xcorr16 *= 1e-12;
            const num = xcorr16 * xcorr16;
            if (num * bestDen[1]! > bestNum[1]! * Syy) {
                if (num * bestDen[0]! > bestNum[0]! * Syy) {
                    bestNum[1] = bestNum[0]!;
                    bestDen[1] = bestDen[0]!;
                    best[1] = best[0]!;
                    bestNum[0] = num;
                    bestDen[0] = Syy;
                    best[0] = i;
                } else {
                    bestNum[1] = num;
                    bestDen[1] = Syy;
                    best[1] = i;
                }
            }
        }
        Syy += y[i + len]! * y[i + len]! - y[i]! * y[i]!;
        Syy = Math.max(1, Syy);
    }
}
