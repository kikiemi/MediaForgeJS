import { CeltMdct } from './celt-mdct';
import { ilog } from './range-decoder';

// The 48 kHz, 960-sample CELT mode of RFC 6716 section 4.3 with its derived tables (built once at
// module load).

export const NB_EBANDS = 21;
export const EFF_EBANDS = 21;
export const MAX_LM = 3;
export const SHORT_MDCT_SIZE = 120;
export const OVERLAP = 120;
export const BITRES = 3;
const MAX_PSEUDO = 40;
export const MAX_FINE_BITS = 8;
export const FINE_OFFSET = 21;
export const QTHETA_OFFSET = 4;
export const QTHETA_OFFSET_TWOPHASE = 16;
export const PREEMPH_COEF = 0.85;

export const EBANDS = new Int16Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 34, 40, 48, 60, 78, 100,
]);

export const NB_ALLOC_VECTORS = 11;
export const ALLOC_VECTORS = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90, 80, 75, 69, 63, 56, 49, 40,
    34, 29, 20, 18, 10, 0, 0, 0, 0, 0, 0, 0, 0, 110, 100, 90, 84, 78, 71, 65, 58, 51, 45, 39, 32,
    26, 20, 12, 0, 0, 0, 0, 0, 0, 118, 110, 103, 93, 86, 80, 75, 70, 65, 59, 53, 47, 40, 31, 23, 15,
    4, 0, 0, 0, 0, 126, 119, 112, 104, 95, 89, 83, 78, 72, 66, 60, 54, 47, 39, 32, 25, 17, 12, 1, 0,
    0, 134, 127, 120, 114, 103, 97, 91, 85, 78, 72, 66, 60, 54, 47, 41, 35, 29, 23, 16, 10, 1, 144,
    137, 130, 124, 113, 107, 101, 95, 88, 82, 76, 70, 64, 57, 51, 45, 39, 33, 26, 15, 1, 152, 145,
    138, 132, 123, 117, 111, 105, 98, 92, 86, 80, 74, 67, 61, 55, 49, 43, 36, 20, 1, 162, 155, 148,
    142, 133, 127, 121, 115, 108, 102, 96, 90, 84, 77, 71, 65, 59, 53, 46, 30, 1, 172, 165, 158,
    152, 143, 137, 131, 125, 118, 112, 106, 100, 94, 87, 81, 75, 69, 63, 56, 45, 20, 200, 200, 200,
    200, 200, 200, 200, 200, 198, 193, 188, 183, 178, 173, 168, 163, 158, 153, 148, 129, 104,
]);

/** Power-complementary overlap window of the mode (static_modes_float window120). */
export const WINDOW = new Float32Array([
    6.7286966e-5, 0.00060551348, 0.001681597, 0.0032947962, 0.0054439943, 0.0081276923, 0.011344001,
    0.015090633, 0.019364886, 0.024163635, 0.029483315, 0.035319905, 0.041668911, 0.048525347,
    0.055883718, 0.063737999, 0.072081616, 0.080907428, 0.090207705, 0.099974111, 0.11019769,
    0.12086883, 0.13197729, 0.14351214, 0.15546177, 0.16781389, 0.1805555, 0.1936729, 0.20715171,
    0.22097682, 0.23513243, 0.24960208, 0.2643686, 0.27941419, 0.2947204, 0.31026818, 0.32603788,
    0.34200931, 0.35816177, 0.37447407, 0.39092462, 0.40749142, 0.42415215, 0.44088423, 0.45766484,
    0.47447104, 0.49127978, 0.50806798, 0.52481261, 0.54149077, 0.55807973, 0.57455701, 0.59090049,
    0.60708841, 0.62309951, 0.63891306, 0.65450896, 0.66986776, 0.68497077, 0.6998001, 0.71433873,
    0.72857055, 0.74248043, 0.75605424, 0.76927895, 0.78214257, 0.7946343, 0.80674445, 0.81846456,
    0.82978733, 0.84070669, 0.85121779, 0.86131698, 0.87100183, 0.88027111, 0.88912479, 0.89756398,
    0.90559094, 0.91320904, 0.9204227, 0.92723738, 0.93365955, 0.93969656, 0.94535671, 0.95064907,
    0.95558353, 0.96017067, 0.96442171, 0.96834849, 0.97196334, 0.97527906, 0.97830883, 0.98106616,
    0.9835648, 0.98581869, 0.98784191, 0.98964856, 0.99125274, 0.99266849, 0.99390969, 0.99499004,
    0.99592297, 0.99672162, 0.99739874, 0.99796667, 0.99843728, 0.99882195, 0.99913147, 0.99937606,
    0.99956527, 0.99970802, 0.99981248, 0.99988613, 0.99993565, 0.99996697, 0.99998518, 0.99999457,
    0.99999859, 0.99999982, 1.0,
]);

/** log2 of val in 1/2^frac units, rounded (cwrs.c log2_frac). */
function log2Frac(val: number, frac: number): number {
    let l = ilog(val);
    if (val & (val - 1)) {
        if (l > 16) val = ((val - 1) >>> (l - 16)) + 1;
        else val <<= 16 - l;
        l = (l - 1) << frac;
        do {
            const b = val >>> 16;
            l += b << frac;
            val = (val + b) >>> b;
            val = (val * val + 0x7fff) >>> 15;
        } while (frac-- > 0);
        return l + (val > 0x8000 ? 1 : 0);
    }
    return (l - 1) << frac;
}

export const LOGN = new Int16Array(NB_EBANDS);
for (let i = 0; i < NB_EBANDS; i++) LOGN[i] = log2Frac(EBANDS[i + 1]! - EBANDS[i]!, BITRES);

/**
 * Rows n = 0..PVQ_ROWS-1 of U(n, k) for k < PVQ_COLUMNS; larger n reads U(k, n) by symmetry
 * (cwrs.c).
 */
const PVQ_ROWS = 15;
const PVQ_COLUMNS = 210;
const PVQ_U = new Float64Array(PVQ_ROWS * PVQ_COLUMNS);
PVQ_U[0] = 1;
for (let n = 1; n < PVQ_ROWS; n++) {
    for (let k = 1; k < PVQ_COLUMNS; k++) {
        PVQ_U[n * PVQ_COLUMNS + k] =
            PVQ_U[(n - 1) * PVQ_COLUMNS + k]! +
            PVQ_U[n * PVQ_COLUMNS + k - 1]! +
            PVQ_U[(n - 1) * PVQ_COLUMNS + k - 1]!;
    }
}

export function pvqU(n: number, k: number): number {
    return n < k ? PVQ_U[n * PVQ_COLUMNS + k]! : PVQ_U[k * PVQ_COLUMNS + n]!;
}

/** Number of codewords with n dimensions and k pulses, V(n, k) = U(n, k) + U(n, k + 1). */
export function pvqV(n: number, k: number): number {
    return pvqU(n, k) + pvqU(n, k + 1);
}

export function getPulses(i: number): number {
    return i < 8 ? i : (8 + (i & 7)) << ((i >> 3) - 1);
}

const MAX_N_FOR_K = [32767, 32767, 32767, 1476, 283, 109, 60, 40, 29, 24, 20, 18, 16, 14, 13];
const MAX_K_FOR_N = [32767, 32767, 32767, 32767, 1172, 238, 95, 53, 36, 27, 22, 18, 16, 15, 13];

function fitsIn32(n: number, k: number): boolean {
    if (n >= 14) return k < 14 && n <= MAX_N_FOR_K[k]!;
    return k <= MAX_K_FOR_N[n]!;
}

/**
 * Per band and LM the bit costs of each pulse count (cache.bits) and the maximum boost
 * (cache.caps), rate.c.
 */
interface PulseCache {
    readonly index: Int16Array;
    readonly bits: Uint8Array;
    readonly caps: Uint8Array;
}

function computePulseCache(): PulseCache {
    const LM = MAX_LM;
    const index = new Int16Array(NB_EBANDS * (LM + 2));
    const entryN: number[] = [];
    const entryK: number[] = [];
    const entryI: number[] = [];
    let curr = 0;
    for (let i = 0; i <= LM + 1; i++) {
        for (let j = 0; j < NB_EBANDS; j++) {
            const N = ((EBANDS[j + 1]! - EBANDS[j]!) << i) >> 1;
            index[i * NB_EBANDS + j] = -1;
            for (let k = 0; k <= i; k++) {
                for (let n = 0; n < NB_EBANDS && (k !== i || n < j); n++) {
                    if (N === ((EBANDS[n + 1]! - EBANDS[n]!) << k) >> 1) {
                        index[i * NB_EBANDS + j] = index[k * NB_EBANDS + n]!;
                        break;
                    }
                }
            }
            if (index[i * NB_EBANDS + j] === -1 && N !== 0) {
                let K = 0;
                while (fitsIn32(N, getPulses(K + 1)) && K < MAX_PSEUDO) K++;
                entryN.push(N);
                entryK.push(K);
                index[i * NB_EBANDS + j] = curr;
                entryI.push(curr);
                curr += K + 1;
            }
        }
    }
    const bits = new Uint8Array(curr);
    for (let i = 0; i < entryN.length; i++) {
        const at = entryI[i]!;
        const N = entryN[i]!;
        for (let j = 1; j <= entryK[i]!; j++) {
            const k = getPulses(j);
            bits[at + j] = (N === 1 ? 1 << BITRES : log2Frac(pvqV(N, k), BITRES)) - 1;
        }
        bits[at] = entryK[i]!;
    }
    const caps = new Uint8Array((LM + 1) * 2 * NB_EBANDS);
    let cap = 0;
    for (let i = 0; i <= LM; i++) {
        for (let C = 1; C <= 2; C++) {
            for (let j = 0; j < NB_EBANDS; j++) {
                let N0 = EBANDS[j + 1]! - EBANDS[j]!;
                let maxBits: number;
                if (N0 << i === 1) maxBits = (C * (1 + MAX_FINE_BITS)) << BITRES;
                else {
                    let LM0 = 0;
                    if (N0 > 2) {
                        N0 >>= 1;
                        LM0--;
                    } else if (N0 <= 1) {
                        LM0 = Math.min(i, 1);
                        N0 <<= LM0;
                    }
                    const pcache = index[(LM0 + 1) * NB_EBANDS + j]!;
                    maxBits = bits[pcache + bits[pcache]!]! + 1;
                    let N = N0;
                    for (let k = 0; k < i - LM0; k++) {
                        maxBits <<= 1;
                        const offset = ((LOGN[j]! + ((LM0 + k) << BITRES)) >> 1) - QTHETA_OFFSET;
                        const num = 459 * ((2 * N - 1) * offset + maxBits);
                        const den = ((2 * N - 1) << 9) - 459;
                        const qb = Math.min(Math.trunc((num + (den >> 1)) / den), 57);
                        maxBits += qb;
                        N <<= 1;
                    }
                    if (C === 2) {
                        maxBits <<= 1;
                        const offset =
                            ((LOGN[j]! + (i << BITRES)) >> 1) -
                            (N === 2 ? QTHETA_OFFSET_TWOPHASE : QTHETA_OFFSET);
                        const ndof = 2 * N - 1 - (N === 2 ? 1 : 0);
                        const num = (N === 2 ? 512 : 487) * (maxBits + ndof * offset);
                        const den = (ndof << 9) - (N === 2 ? 512 : 487);
                        const qb = Math.min(
                            Math.trunc((num + (den >> 1)) / den),
                            N === 2 ? 64 : 61,
                        );
                        maxBits += qb;
                    }
                    const ndof = C * N + (C === 2 && N > 2 ? 1 : 0);
                    let offset = ((LOGN[j]! + (i << BITRES)) >> 1) - FINE_OFFSET;
                    if (N === 2) offset += (1 << BITRES) >> 2;
                    const num = maxBits + ndof * offset;
                    const den = (ndof - 1) << BITRES;
                    const qb = Math.min(Math.trunc((num + (den >> 1)) / den), MAX_FINE_BITS);
                    maxBits += (C * qb) << BITRES;
                }
                maxBits =
                    Math.trunc((4 * maxBits) / (C * ((EBANDS[j + 1]! - EBANDS[j]!) << i))) - 64;
                caps[cap++] = maxBits;
            }
        }
    }
    return { index, bits, caps };
}

export const PULSE_CACHE = computePulseCache();

export function bits2pulses(band: number, LM: number, bits: number): number {
    const cache = PULSE_CACHE.bits;
    const at = PULSE_CACHE.index[(LM + 1) * NB_EBANDS + band]!;
    let lo = 0;
    let hi = cache[at]!;
    bits--;
    for (let i = 0; i < 6; i++) {
        const mid = (lo + hi + 1) >> 1;
        if (cache[at + mid]! >= bits) hi = mid;
        else lo = mid;
    }
    return bits - (lo === 0 ? -1 : cache[at + lo]!) <= cache[at + hi]! - bits ? lo : hi;
}

export function pulses2bits(band: number, LM: number, pulses: number): number {
    const at = PULSE_CACHE.index[(LM + 1) * NB_EBANDS + band]!;
    return pulses === 0 ? 0 : PULSE_CACHE.bits[at + pulses]! + 1;
}

export const MDCT = new CeltMdct(2 * SHORT_MDCT_SIZE * (1 << MAX_LM), MAX_LM);
