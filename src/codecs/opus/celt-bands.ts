import {
    BITRES,
    EBANDS,
    EFF_EBANDS,
    LOGN,
    MAX_LM,
    NB_EBANDS,
    PULSE_CACHE,
    QTHETA_OFFSET,
    QTHETA_OFFSET_TWOPHASE,
    bits2pulses,
    getPulses,
    pulses2bits,
    pvqU,
    pvqV,
} from './celt-mode';
import { ilog, type RangeDecoder } from './range-decoder';

// Band shape decoding of the CELT layer (RFC 6716 section 4.3.4): PVQ, splitting, spreading,
// folding and stereo.

const SPREAD_NONE = 0;
const SPREAD_AGGRESSIVE = 3;
const SPREAD_FACTOR = [15, 10, 5];
const EPSILON = 1e-15;
const ORDERY_TABLE = [
    1, 0, 3, 0, 2, 1, 7, 0, 4, 3, 6, 1, 5, 2, 15, 0, 8, 7, 12, 3, 11, 4, 14, 1, 9, 6, 13, 2, 10, 5,
];
const BIT_INTERLEAVE_TABLE = [0, 1, 1, 1, 2, 3, 3, 3, 2, 3, 3, 3, 2, 3, 3, 3];
const BIT_DEINTERLEAVE_TABLE = [
    0x00, 0x03, 0x0c, 0x0f, 0x30, 0x33, 0x3c, 0x3f, 0xc0, 0xc3, 0xcc, 0xcf, 0xf0, 0xf3, 0xfc, 0xff,
];
const EXP2_TABLE8 = [16384, 17866, 19483, 21247, 23170, 25267, 27554, 30048];
const MAX_BAND_N = 176;

export function celtLcgRand(seed: number): number {
    return (Math.imul(1664525, seed) + 1013904223) >>> 0;
}

function fracMul16(a: number, b: number): number {
    return (16384 + Math.imul((a << 16) >> 16, (b << 16) >> 16)) >> 15;
}

function bitexactCos(x: number): number {
    const tmp = (4096 + Math.imul(x, x)) >> 13;
    let x2 = tmp;
    x2 = 32767 - x2 + fracMul16(x2, -7651 + fracMul16(x2, 8277 + fracMul16(-626, x2)));
    return 1 + x2;
}

function bitexactLog2tan(isin: number, icos: number): number {
    const lc = ilog(icos);
    const ls = ilog(isin);
    icos <<= 15 - lc;
    isin <<= 15 - ls;
    return (
        (ls - lc) * (1 << 11) +
        fracMul16(isin, fracMul16(isin, -2597) + 7932) -
        fracMul16(icos, fracMul16(icos, -2597) + 7932)
    );
}

/** floor(sqrt(val)) for 0 < val < 2^32, exact in double precision. */
function isqrt32(val: number): number {
    return Math.floor(Math.sqrt(val));
}

function expRotation1(
    X: Float32Array,
    at: number,
    len: number,
    stride: number,
    c: number,
    s: number,
): void {
    const ms = -s;
    let p = at;
    for (let i = 0; i < len - stride; i++) {
        const x1 = X[p]!;
        const x2 = X[p + stride]!;
        X[p + stride] = c * x2 + s * x1;
        X[p++] = c * x1 + ms * x2;
    }
    p = at + len - 2 * stride - 1;
    for (let i = len - 2 * stride - 1; i >= 0; i--) {
        const x1 = X[p]!;
        const x2 = X[p + stride]!;
        X[p + stride] = c * x2 + s * x1;
        X[p--] = c * x1 + ms * x2;
    }
}

function expRotation(
    X: Float32Array,
    at: number,
    len: number,
    dir: number,
    stride: number,
    K: number,
    spread: number,
): void {
    if (2 * K >= len || spread === SPREAD_NONE) return;
    const factor = SPREAD_FACTOR[spread - 1]!;
    const gain = len / (len + factor * K);
    const theta = 0.5 * gain * gain;
    const c = Math.cos(0.5 * Math.PI * theta);
    const s = Math.cos(0.5 * Math.PI * (1 - theta));
    let stride2 = 0;
    if (len >= 8 * stride) {
        stride2 = 1;
        while ((stride2 * stride2 + stride2) * stride + (stride >> 2) < len) stride2++;
    }
    len = Math.floor(len / stride);
    for (let i = 0; i < stride; i++) {
        if (dir < 0) {
            if (stride2) expRotation1(X, at + i * len, len, stride2, s, c);
            expRotation1(X, at + i * len, len, 1, c, s);
        } else {
            expRotation1(X, at + i * len, len, 1, c, -s);
            if (stride2) expRotation1(X, at + i * len, len, stride2, s, -c);
        }
    }
}

function normaliseResidual(
    iy: Int32Array,
    X: Float32Array,
    at: number,
    N: number,
    Ryy: number,
    gain: number,
): void {
    const g = gain / Math.sqrt(Ryy);
    for (let i = 0; i < N; i++) X[at + i] = g * iy[i]!;
}

function extractCollapseMask(iy: Int32Array, N: number, B: number): number {
    if (B <= 1) return 1;
    const N0 = Math.floor(N / B);
    let mask = 0;
    for (let i = 0; i < B; i++) {
        let tmp = 0;
        for (let j = 0; j < N0; j++) tmp |= iy[i * N0 + j]!;
        mask |= (tmp !== 0 ? 1 : 0) << i;
    }
    return mask;
}

/** Decodes a PVQ index into `iy` (cwrs.c cwrsi); returns the energy of the pulse vector. */
function cwrsi(n: number, k: number, i: number, iy: Int32Array): number {
    let yy = 0;
    let at = 0;
    while (n > 2) {
        let s: number;
        let k0: number;
        let p: number;
        if (k >= n) {
            p = pvqU(n, k + 1);
            s = i >= p ? -1 : 0;
            if (s) i -= p;
            k0 = k;
            const q = pvqU(n, n);
            if (q > i) {
                k = n;
                do p = pvqU(--k, n);
                while (p > i);
            } else {
                for (p = pvqU(n, k); p > i; p = pvqU(n, k)) k--;
            }
            i -= p;
            const val = (k0 - k + s) ^ s;
            iy[at++] = val;
            yy += val * val;
        } else {
            p = pvqU(k, n);
            const q = pvqU(k + 1, n);
            if (p <= i && i < q) {
                i -= p;
                iy[at++] = 0;
            } else {
                s = i >= q ? -1 : 0;
                if (s) i -= q;
                k0 = k;
                do p = pvqU(--k, n);
                while (p > i);
                i -= p;
                const val = (k0 - k + s) ^ s;
                iy[at++] = val;
                yy += val * val;
            }
        }
        n--;
    }
    let p = 2 * k + 1;
    let s = i >= p ? -1 : 0;
    if (s) i -= p;
    const k0 = k;
    k = (i + 1) >> 1;
    if (k) i -= 2 * k - 1;
    let val = (k0 - k + s) ^ s;
    iy[at++] = val;
    yy += val * val;
    s = -i;
    val = (k + s) ^ s;
    iy[at] = val;
    yy += val * val;
    return yy;
}

const iyScratch = new Int32Array(MAX_BAND_N);

function algUnquant(
    X: Float32Array,
    at: number,
    N: number,
    K: number,
    spread: number,
    B: number,
    dec: RangeDecoder,
    gain: number,
): number {
    const iy = iyScratch;
    const Ryy = cwrsi(N, K, dec.decodeUint(pvqV(N, K)), iy);
    normaliseResidual(iy, X, at, N, Ryy, gain);
    expRotation(X, at, N, -1, B, K, spread);
    return extractCollapseMask(iy, N, B);
}

export function renormaliseVector(X: Float32Array, at: number, N: number, gain: number): void {
    let E = EPSILON;
    for (let i = 0; i < N; i++) E += X[at + i]! * X[at + i]!;
    const g = gain / Math.sqrt(E);
    for (let i = 0; i < N; i++) X[at + i] = g * X[at + i]!;
}

function stereoMerge(
    X: Float32Array,
    xAt: number,
    Y: Float32Array,
    yAt: number,
    mid: number,
    N: number,
): void {
    let xp = 0;
    let side = 0;
    for (let j = 0; j < N; j++) {
        xp += Y[yAt + j]! * X[xAt + j]!;
        side += Y[yAt + j]! * Y[yAt + j]!;
    }
    xp *= mid;
    const El = mid * mid + side - 2 * xp;
    const Er = mid * mid + side + 2 * xp;
    if (Er < 6e-4 || El < 6e-4) {
        Y.set(X.subarray(xAt, xAt + N), yAt);
        return;
    }
    const lgain = 1 / Math.sqrt(El);
    const rgain = 1 / Math.sqrt(Er);
    for (let j = 0; j < N; j++) {
        const l = mid * X[xAt + j]!;
        const r = Y[yAt + j]!;
        X[xAt + j] = lgain * (l - r);
        Y[yAt + j] = rgain * (l + r);
    }
}

const hadamardScratch = new Float32Array(MAX_BAND_N);

function deinterleaveHadamard(
    X: Float32Array,
    at: number,
    N0: number,
    stride: number,
    hadamard: boolean,
): void {
    const N = N0 * stride;
    const tmp = hadamardScratch;
    if (hadamard) {
        const ordery = stride - 2;
        for (let i = 0; i < stride; i++)
            for (let j = 0; j < N0; j++)
                tmp[ORDERY_TABLE[ordery + i]! * N0 + j] = X[at + j * stride + i]!;
    } else {
        for (let i = 0; i < stride; i++)
            for (let j = 0; j < N0; j++) tmp[i * N0 + j] = X[at + j * stride + i]!;
    }
    X.set(tmp.subarray(0, N), at);
}

function interleaveHadamard(
    X: Float32Array,
    at: number,
    N0: number,
    stride: number,
    hadamard: boolean,
): void {
    const N = N0 * stride;
    const tmp = hadamardScratch;
    if (hadamard) {
        const ordery = stride - 2;
        for (let i = 0; i < stride; i++)
            for (let j = 0; j < N0; j++)
                tmp[j * stride + i] = X[at + ORDERY_TABLE[ordery + i]! * N0 + j]!;
    } else {
        for (let i = 0; i < stride; i++)
            for (let j = 0; j < N0; j++) tmp[j * stride + i] = X[at + i * N0 + j]!;
    }
    X.set(tmp.subarray(0, N), at);
}

function haar1(X: Float32Array, at: number, N0: number, stride: number): void {
    N0 >>= 1;
    for (let i = 0; i < stride; i++) {
        for (let j = 0; j < N0; j++) {
            const tmp1 = 0.70710678 * X[at + stride * 2 * j + i]!;
            const tmp2 = 0.70710678 * X[at + stride * (2 * j + 1) + i]!;
            X[at + stride * 2 * j + i] = tmp1 + tmp2;
            X[at + stride * (2 * j + 1) + i] = tmp1 - tmp2;
        }
    }
}

function computeQn(
    N: number,
    b: number,
    offset: number,
    pulseCap: number,
    stereo: boolean,
): number {
    let N2 = 2 * N - 1;
    if (stereo && N === 2) N2--;
    let qb = Math.trunc((b + N2 * offset) / N2);
    qb = Math.min(b - pulseCap - (4 << BITRES), qb);
    qb = Math.min(8 << BITRES, qb);
    if (qb < (1 << BITRES) >> 1) return 1;
    let qn = EXP2_TABLE8[qb & 0x7]! >> (14 - (qb >> BITRES));
    qn = ((qn + 1) >> 1) << 1;
    return qn;
}

/** State threaded through the band decoding of one frame (bands.c band_ctx). */
interface BandContext {
    dec: RangeDecoder;
    i: number;
    intensity: number;
    spread: number;
    tfChange: number;
    remainingBits: number;
    seed: number;
    disableInv: boolean;
}

interface SplitResult {
    inv: number;
    imid: number;
    iside: number;
    delta: number;
    itheta: number;
    qalloc: number;
}

const split: SplitResult = { inv: 0, imid: 0, iside: 0, delta: 0, itheta: 0, qalloc: 0 };

/** b (the remaining band bits) is passed back through this cell. */
const bCell = { b: 0, fill: 0 };

function computeTheta(
    ctx: BandContext,
    N: number,
    B: number,
    B0: number,
    LM: number,
    stereo: boolean,
): void {
    const dec = ctx.dec;
    const i = ctx.i;
    let b = bCell.b;
    let itheta = 0;
    let inv = 0;
    const pulseCap = LOGN[i]! + LM * (1 << BITRES);
    const offset = (pulseCap >> 1) - (stereo && N === 2 ? QTHETA_OFFSET_TWOPHASE : QTHETA_OFFSET);
    let qn = computeQn(N, b, offset, pulseCap, stereo);
    if (stereo && i >= ctx.intensity) qn = 1;
    const tell = dec.tellFrac();
    if (qn !== 1) {
        if (stereo && N > 2) {
            const p0 = 3;
            const x0 = qn >> 1;
            const ft = p0 * (x0 + 1) + x0;
            const fs = dec.decode(ft);
            const x = fs < (x0 + 1) * p0 ? Math.floor(fs / p0) : x0 + 1 + (fs - (x0 + 1) * p0);
            dec.update(
                x <= x0 ? p0 * x : x - 1 - x0 + (x0 + 1) * p0,
                x <= x0 ? p0 * (x + 1) : x - x0 + (x0 + 1) * p0,
                ft,
            );
            itheta = x;
        } else if (B0 > 1 || stereo) {
            itheta = dec.decodeUint(qn + 1);
        } else {
            const ft = ((qn >> 1) + 1) * ((qn >> 1) + 1);
            const fm = dec.decode(ft);
            let fl: number;
            let fs: number;
            if (fm < ((qn >> 1) * ((qn >> 1) + 1)) >> 1) {
                itheta = (isqrt32(8 * fm + 1) - 1) >> 1;
                fs = itheta + 1;
                fl = (itheta * (itheta + 1)) >> 1;
            } else {
                itheta = (2 * (qn + 1) - isqrt32(8 * (ft - fm - 1) + 1)) >> 1;
                fs = qn + 1 - itheta;
                fl = ft - (((qn + 1 - itheta) * (qn + 2 - itheta)) >> 1);
            }
            dec.update(fl, fl + fs, ft);
        }
        itheta = Math.floor((itheta * 16384) / qn);
    } else if (stereo) {
        if (b > 2 << BITRES && ctx.remainingBits > 2 << BITRES) inv = dec.decodeBitLogp(2);
        else inv = 0;
        if (ctx.disableInv) inv = 0;
        itheta = 0;
    }
    const qalloc = dec.tellFrac() - tell;
    b -= qalloc;
    let imid: number;
    let iside: number;
    let delta: number;
    if (itheta === 0) {
        imid = 32767;
        iside = 0;
        bCell.fill &= (1 << B) - 1;
        delta = -16384;
    } else if (itheta === 16384) {
        imid = 0;
        iside = 32767;
        bCell.fill &= ((1 << B) - 1) << B;
        delta = 16384;
    } else {
        imid = bitexactCos(itheta);
        iside = bitexactCos(16384 - itheta);
        delta = fracMul16((N - 1) << 7, bitexactLog2tan(iside, imid));
    }
    split.inv = inv;
    split.imid = imid;
    split.iside = iside;
    split.delta = delta;
    split.itheta = itheta;
    split.qalloc = qalloc;
    bCell.b = b;
}

function quantBandN1(
    ctx: BandContext,
    X: Float32Array,
    xAt: number,
    Y: Float32Array | null,
    yAt: number,
    lowbandOut: Float32Array | null,
    lowbandOutAt: number,
): number {
    let target = X;
    let at = xAt;
    for (let c = 0; c < (Y ? 2 : 1); c++) {
        let sign = 0;
        if (ctx.remainingBits >= 1 << BITRES) {
            sign = ctx.dec.decodeBits(1);
            ctx.remainingBits -= 1 << BITRES;
        }
        target[at] = sign ? -1 : 1;
        if (Y) {
            target = Y;
            at = yAt;
        }
    }
    if (lowbandOut) lowbandOut[lowbandOutAt] = X[xAt]!;
    return 1;
}

function quantPartition(
    ctx: BandContext,
    X: Float32Array,
    xAt: number,
    N: number,
    b: number,
    B: number,
    lowband: Float32Array | null,
    lowbandAt: number,
    LM: number,
    gain: number,
    fill: number,
): number {
    const i = ctx.i;
    const dec = ctx.dec;
    const cacheAt = PULSE_CACHE.index[(LM + 1) * NB_EBANDS + i]!;
    const cacheBits = PULSE_CACHE.bits;
    let cm = 0;
    if (LM !== -1 && b > cacheBits[cacheAt + cacheBits[cacheAt]!]! + 12 && N > 2) {
        const B0 = B;
        N >>= 1;
        const yAt = xAt + N;
        LM -= 1;
        if (B === 1) fill = (fill & 1) | (fill << 1);
        B = (B + 1) >> 1;
        bCell.b = b;
        bCell.fill = fill;
        computeTheta(ctx, N, B, B0, LM, false);
        b = bCell.b;
        fill = bCell.fill;
        const imid = split.imid;
        const iside = split.iside;
        let delta = split.delta;
        const itheta = split.itheta;
        const qalloc = split.qalloc;
        const mid = (1 / 32768) * imid;
        const side = (1 / 32768) * iside;
        if (B0 > 1 && itheta & 0x3fff) {
            if (itheta > 8192) delta -= delta >> (4 - LM);
            else delta = Math.min(0, delta + ((N << BITRES) >> (5 - LM)));
        }
        let mbits = Math.max(0, Math.min(b, Math.trunc((b - delta) / 2)));
        let sbits = b - mbits;
        ctx.remainingBits -= qalloc;
        const nextLowband2At = lowband ? lowbandAt + N : 0;
        let rebalance = ctx.remainingBits;
        if (mbits >= sbits) {
            cm = quantPartition(ctx, X, xAt, N, mbits, B, lowband, lowbandAt, LM, gain * mid, fill);
            rebalance = mbits - (rebalance - ctx.remainingBits);
            if (rebalance > 3 << BITRES && itheta !== 0) sbits += rebalance - (3 << BITRES);
            cm |=
                quantPartition(
                    ctx,
                    X,
                    yAt,
                    N,
                    sbits,
                    B,
                    lowband,
                    nextLowband2At,
                    LM,
                    gain * side,
                    fill >> B,
                ) <<
                (B0 >> 1);
        } else {
            cm =
                quantPartition(
                    ctx,
                    X,
                    yAt,
                    N,
                    sbits,
                    B,
                    lowband,
                    nextLowband2At,
                    LM,
                    gain * side,
                    fill >> B,
                ) <<
                (B0 >> 1);
            rebalance = sbits - (rebalance - ctx.remainingBits);
            if (rebalance > 3 << BITRES && itheta !== 16384) mbits += rebalance - (3 << BITRES);
            cm |= quantPartition(
                ctx,
                X,
                xAt,
                N,
                mbits,
                B,
                lowband,
                lowbandAt,
                LM,
                gain * mid,
                fill,
            );
        }
    } else {
        let q = bits2pulses(i, LM, b);
        let currBits = pulses2bits(i, LM, q);
        ctx.remainingBits -= currBits;
        while (ctx.remainingBits < 0 && q > 0) {
            ctx.remainingBits += currBits;
            q--;
            currBits = pulses2bits(i, LM, q);
            ctx.remainingBits -= currBits;
        }
        if (q !== 0) {
            cm = algUnquant(X, xAt, N, getPulses(q), ctx.spread, B, dec, gain);
        } else {
            const cmMask = (1 << B) - 1;
            fill &= cmMask;
            if (!fill) X.fill(0, xAt, xAt + N);
            else {
                if (!lowband) {
                    for (let j = 0; j < N; j++) {
                        ctx.seed = celtLcgRand(ctx.seed);
                        X[xAt + j] = (ctx.seed | 0) >> 20;
                    }
                    cm = cmMask;
                } else {
                    for (let j = 0; j < N; j++) {
                        ctx.seed = celtLcgRand(ctx.seed);
                        const tmp = ctx.seed & 0x8000 ? 1 / 256 : -1 / 256;
                        X[xAt + j] = lowband[lowbandAt + j]! + tmp;
                    }
                    cm = fill;
                }
                renormaliseVector(X, xAt, N, gain);
            }
        }
    }
    return cm;
}

function quantBand(
    ctx: BandContext,
    X: Float32Array,
    xAt: number,
    N: number,
    b: number,
    B: number,
    lowband: Float32Array | null,
    lowbandAt: number,
    LM: number,
    lowbandOut: Float32Array | null,
    lowbandOutAt: number,
    gain: number,
    lowbandScratch: Float32Array | null,
    lowbandScratchAt: number,
    fill: number,
): number {
    const N0 = N;
    let N_B = N;
    const B0In = B;
    let timeDivide = 0;
    let recombine = 0;
    const longBlocks = B0In === 1;
    N_B = Math.floor(N_B / B);
    if (N === 1) return quantBandN1(ctx, X, xAt, null, 0, lowbandOut, lowbandOutAt);
    const tfChange = ctx.tfChange;
    if (tfChange > 0) recombine = tfChange;
    if (lowbandScratch && lowband && (recombine || ((N_B & 1) === 0 && tfChange < 0) || B0In > 1)) {
        lowbandScratch.set(lowband.subarray(lowbandAt, lowbandAt + N), lowbandScratchAt);
        lowband = lowbandScratch;
        lowbandAt = lowbandScratchAt;
    }
    for (let k = 0; k < recombine; k++) {
        if (lowband) haar1(lowband, lowbandAt, N >> k, 1 << k);
        fill = BIT_INTERLEAVE_TABLE[fill & 0xf]! | (BIT_INTERLEAVE_TABLE[fill >> 4]! << 2);
    }
    B >>= recombine;
    N_B <<= recombine;
    let tf = tfChange;
    while ((N_B & 1) === 0 && tf < 0) {
        if (lowband) haar1(lowband, lowbandAt, N_B, B);
        fill |= fill << B;
        B <<= 1;
        N_B >>= 1;
        timeDivide++;
        tf++;
    }
    const B0 = B;
    const N_B0 = N_B;
    if (B0 > 1 && lowband)
        deinterleaveHadamard(lowband, lowbandAt, N_B >> recombine, B0 << recombine, longBlocks);
    let cm = quantPartition(ctx, X, xAt, N, b, B, lowband, lowbandAt, LM, gain, fill);
    if (B0 > 1) interleaveHadamard(X, xAt, N_B >> recombine, B0 << recombine, longBlocks);
    N_B = N_B0;
    B = B0;
    for (let k = 0; k < timeDivide; k++) {
        B >>= 1;
        N_B <<= 1;
        cm |= cm >> B;
        haar1(X, xAt, N_B, B);
    }
    for (let k = 0; k < recombine; k++) {
        cm = BIT_DEINTERLEAVE_TABLE[cm]!;
        haar1(X, xAt, N0 >> k, 1 << k);
    }
    B <<= recombine;
    if (lowbandOut) {
        const n = Math.sqrt(N0);
        for (let j = 0; j < N0; j++) lowbandOut[lowbandOutAt + j] = n * X[xAt + j]!;
    }
    cm &= (1 << B) - 1;
    return cm;
}

function quantBandStereo(
    ctx: BandContext,
    X: Float32Array,
    xAt: number,
    Y: Float32Array,
    yAt: number,
    N: number,
    b: number,
    B: number,
    lowband: Float32Array | null,
    lowbandAt: number,
    LM: number,
    lowbandOut: Float32Array | null,
    lowbandOutAt: number,
    lowbandScratch: Float32Array | null,
    lowbandScratchAt: number,
    fill: number,
): number {
    if (N === 1) return quantBandN1(ctx, X, xAt, Y, yAt, lowbandOut, lowbandOutAt);
    const origFill = fill;
    bCell.b = b;
    bCell.fill = fill;
    computeTheta(ctx, N, B, B, LM, true);
    b = bCell.b;
    fill = bCell.fill;
    const inv = split.inv;
    const imid = split.imid;
    const iside = split.iside;
    const delta = split.delta;
    const itheta = split.itheta;
    const qalloc = split.qalloc;
    const mid = (1 / 32768) * imid;
    const side = (1 / 32768) * iside;
    let cm: number;
    if (N === 2) {
        let mbits = b;
        let sbits = 0;
        if (itheta !== 0 && itheta !== 16384) sbits = 1 << BITRES;
        mbits -= sbits;
        const c = itheta > 8192;
        ctx.remainingBits -= qalloc + sbits;
        const x2 = c ? Y : X;
        const x2At = c ? yAt : xAt;
        const y2 = c ? X : Y;
        const y2At = c ? xAt : yAt;
        let sign = 0;
        if (sbits) sign = ctx.dec.decodeBits(1);
        sign = 1 - 2 * sign;
        cm = quantBand(
            ctx,
            x2,
            x2At,
            N,
            mbits,
            B,
            lowband,
            lowbandAt,
            LM,
            lowbandOut,
            lowbandOutAt,
            1,
            lowbandScratch,
            lowbandScratchAt,
            origFill,
        );
        y2[y2At] = -sign * x2[x2At + 1]!;
        y2[y2At + 1] = sign * x2[x2At]!;
        X[xAt] = mid * X[xAt]!;
        X[xAt + 1] = mid * X[xAt + 1]!;
        Y[yAt] = side * Y[yAt]!;
        Y[yAt + 1] = side * Y[yAt + 1]!;
        let tmp = X[xAt]!;
        X[xAt] = tmp - Y[yAt]!;
        Y[yAt] = tmp + Y[yAt]!;
        tmp = X[xAt + 1]!;
        X[xAt + 1] = tmp - Y[yAt + 1]!;
        Y[yAt + 1] = tmp + Y[yAt + 1]!;
    } else {
        let mbits = Math.max(0, Math.min(b, Math.trunc((b - delta) / 2)));
        let sbits = b - mbits;
        ctx.remainingBits -= qalloc;
        let rebalance = ctx.remainingBits;
        if (mbits >= sbits) {
            cm = quantBand(
                ctx,
                X,
                xAt,
                N,
                mbits,
                B,
                lowband,
                lowbandAt,
                LM,
                lowbandOut,
                lowbandOutAt,
                1,
                lowbandScratch,
                lowbandScratchAt,
                fill,
            );
            rebalance = mbits - (rebalance - ctx.remainingBits);
            if (rebalance > 3 << BITRES && itheta !== 0) sbits += rebalance - (3 << BITRES);
            cm |= quantBand(
                ctx,
                Y,
                yAt,
                N,
                sbits,
                B,
                null,
                0,
                LM,
                null,
                0,
                side,
                null,
                0,
                fill >> B,
            );
        } else {
            cm = quantBand(
                ctx,
                Y,
                yAt,
                N,
                sbits,
                B,
                null,
                0,
                LM,
                null,
                0,
                side,
                null,
                0,
                fill >> B,
            );
            rebalance = sbits - (rebalance - ctx.remainingBits);
            if (rebalance > 3 << BITRES && itheta !== 16384) mbits += rebalance - (3 << BITRES);
            cm |= quantBand(
                ctx,
                X,
                xAt,
                N,
                mbits,
                B,
                lowband,
                lowbandAt,
                LM,
                lowbandOut,
                lowbandOutAt,
                1,
                lowbandScratch,
                lowbandScratchAt,
                fill,
            );
        }
    }
    if (N !== 2) stereoMerge(X, xAt, Y, yAt, mid, N);
    if (inv) for (let j = 0; j < N; j++) Y[yAt + j] = -Y[yAt + j]!;
    return cm;
}

const normBuffer = new Float32Array(2 * (EBANDS[NB_EBANDS - 1]! << MAX_LM));

/**
 * quant_all_bands for the decoder: fills X_ (and Y_ for stereo) with the normalised band shapes and
 * the collapse masks; returns the updated seed.
 */
export function decodeAllBands(
    start: number,
    end: number,
    X_: Float32Array,
    Y_: Float32Array | null,
    collapseMasks: Uint8Array,
    pulses: Int32Array,
    shortBlocks: number,
    spread: number,
    dualStereo: number,
    intensity: number,
    tfRes: Int32Array,
    totalBits: number,
    balance: number,
    dec: RangeDecoder,
    LM: number,
    codedBands: number,
    seed: number,
    disableInv: boolean,
): number {
    const M = 1 << LM;
    const B = shortBlocks ? M : 1;
    const normOffset = M * EBANDS[start]!;
    const C = Y_ ? 2 : 1;
    const norm = normBuffer;
    const normAt = 0;
    const norm2At = M * EBANDS[NB_EBANDS - 1]! - normOffset;
    let lowbandOffset = 0;
    let updateLowband = true;
    const lowbandScratchDefault = X_;
    const lowbandScratchDefaultAt = M * EBANDS[NB_EBANDS - 1]!;
    const ctx: BandContext = {
        dec,
        i: start,
        intensity,
        spread,
        tfChange: 0,
        remainingBits: 0,
        seed,
        disableInv,
    };
    for (let i = start; i < end; i++) {
        ctx.i = i;
        const last = i === end - 1;
        const xAt = M * EBANDS[i]!;
        const yAt = xAt;
        let X = X_;
        let Y = Y_;
        let xTarget = xAt;
        let yTarget = yAt;
        const N = M * EBANDS[i + 1]! - M * EBANDS[i]!;
        const tell = dec.tellFrac();
        if (i !== start) balance -= tell;
        const remainingBits = totalBits - tell - 1;
        ctx.remainingBits = remainingBits;
        let b: number;
        if (i <= codedBands - 1) {
            const currBalance = Math.trunc(balance / Math.min(3, codedBands - i));
            b = Math.max(0, Math.min(16383, Math.min(remainingBits + 1, pulses[i]! + currBalance)));
        } else b = 0;
        if (
            (M * EBANDS[i]! - N >= M * EBANDS[start]! || i === start + 1) &&
            (updateLowband || lowbandOffset === 0)
        )
            lowbandOffset = i;
        if (i === start + 1) {
            const n1 = M * (EBANDS[start + 1]! - EBANDS[start]!);
            const n2 = M * (EBANDS[start + 2]! - EBANDS[start + 1]!);
            norm.copyWithin(normAt + n1, normAt + 2 * n1 - n2, normAt + n1);
            if (dualStereo) norm.copyWithin(norm2At + n1, norm2At + 2 * n1 - n2, norm2At + n1);
        }
        const tfChange = tfRes[i]!;
        ctx.tfChange = tfChange;
        let lowbandScratch: Float32Array | null = lowbandScratchDefault;
        let lowbandScratchAt = lowbandScratchDefaultAt;
        if (i >= EFF_EBANDS) {
            X = norm;
            xTarget = normAt;
            if (Y_) {
                Y = norm;
                yTarget = normAt;
            }
            lowbandScratch = null;
        }
        if (last) lowbandScratch = null;
        let xCm: number;
        let yCm: number;
        let effectiveLowband = -1;
        if (lowbandOffset !== 0 && (spread !== SPREAD_AGGRESSIVE || B > 1 || tfChange < 0)) {
            effectiveLowband = Math.max(0, M * EBANDS[lowbandOffset]! - normOffset - N);
            let foldStart = lowbandOffset;
            while (M * EBANDS[--foldStart]! > effectiveLowband + normOffset);
            let foldEnd = lowbandOffset - 1;
            while (++foldEnd < i && M * EBANDS[foldEnd]! < effectiveLowband + normOffset + N);
            xCm = 0;
            yCm = 0;
            let foldI = foldStart;
            do {
                xCm |= collapseMasks[foldI * C + 0]!;
                yCm |= collapseMasks[foldI * C + C - 1]!;
            } while (++foldI < foldEnd);
        } else {
            xCm = (1 << B) - 1;
            yCm = xCm;
        }
        if (dualStereo && i === intensity) {
            dualStereo = 0;
            for (let j = 0; j < M * EBANDS[i]! - normOffset; j++)
                norm[normAt + j] = 0.5 * (norm[normAt + j]! + norm[norm2At + j]!);
        }
        const lowbandOutAt = normAt + M * EBANDS[i]! - normOffset;
        if (dualStereo) {
            xCm = quantBand(
                ctx,
                X,
                xTarget,
                N,
                b >> 1,
                B,
                effectiveLowband !== -1 ? norm : null,
                normAt + effectiveLowband,
                LM,
                last ? null : norm,
                lowbandOutAt,
                1,
                lowbandScratch,
                lowbandScratchAt,
                xCm,
            );
            yCm = quantBand(
                ctx,
                Y!,
                yTarget,
                N,
                b >> 1,
                B,
                effectiveLowband !== -1 ? norm : null,
                norm2At + effectiveLowband,
                LM,
                last ? null : norm,
                norm2At + M * EBANDS[i]! - normOffset,
                1,
                lowbandScratch,
                lowbandScratchAt,
                yCm,
            );
        } else {
            if (Y) {
                xCm = quantBandStereo(
                    ctx,
                    X,
                    xTarget,
                    Y,
                    yTarget,
                    N,
                    b,
                    B,
                    effectiveLowband !== -1 ? norm : null,
                    normAt + effectiveLowband,
                    LM,
                    last ? null : norm,
                    lowbandOutAt,
                    lowbandScratch,
                    lowbandScratchAt,
                    xCm | yCm,
                );
            } else {
                xCm = quantBand(
                    ctx,
                    X,
                    xTarget,
                    N,
                    b,
                    B,
                    effectiveLowband !== -1 ? norm : null,
                    normAt + effectiveLowband,
                    LM,
                    last ? null : norm,
                    lowbandOutAt,
                    1,
                    lowbandScratch,
                    lowbandScratchAt,
                    xCm | yCm,
                );
            }
            yCm = xCm;
        }
        collapseMasks[i * C + 0] = xCm;
        collapseMasks[i * C + C - 1] = yCm;
        balance += pulses[i]! + tell;
        updateLowband = b > N << BITRES;
    }
    return ctx.seed;
}
