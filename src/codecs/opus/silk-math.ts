// Fixed-point primitives of the SILK reference decoder (RFC 6716 section 4.2); every result is a
// 32-bit integer.

export const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;

export function sat16(a: number): number {
    return a > 32767 ? 32767 : a < -32768 ? -32768 : a;
}

export function clz32(a: number): number {
    return Math.clz32(a);
}

/** (a * (int16)b) >> 16 */
export function smulwb(a: number, b: number): number {
    const b16 = (b << 16) >> 16;
    return (Math.imul(a >> 16, b16) + (Math.imul(a & 0xffff, b16) >> 16)) | 0;
}

export function smlawb(a: number, b: number, c: number): number {
    return (a + smulwb(b, c)) | 0;
}

/** (int32)(((int64)a * b) >> 16) */
export function smulww(a: number, b: number): number {
    return (a * (b >> 16) + Math.floor((a * (b & 0xffff)) / 65536)) | 0;
}

function smlaww(a: number, b: number, c: number): number {
    return (a + smulww(b, c)) | 0;
}

export function smulbb(a: number, b: number): number {
    return Math.imul((a << 16) >> 16, (b << 16) >> 16);
}

export function smlabb(a: number, b: number, c: number): number {
    return (a + smulbb(b, c)) | 0;
}

/** (int32)(((int64)a * b) >> 32) */
export function smmul(a: number, b: number): number {
    return Math.floor((a * (b >> 16) + Math.floor((a * (b & 0xffff)) / 65536)) / 65536) | 0;
}

/** ((int64)a * b + (1 << (shift - 1))) >> shift as an exact double, for 15 <= shift <= 31. */
export function mulRoundShift64(a: number, b: number, shift: number): number {
    const lo = a * (b & 0xffff);
    const loHigh = Math.floor(lo / 65536);
    const n = a * (b >> 16) + loHigh;
    const loLow = lo - loHigh * 65536;
    const k = shift - 1;
    const shifted =
        k >= 16 ? Math.floor(n / 2 ** (k - 16)) : n * 2 ** (16 - k) + Math.floor(loLow / 2 ** k);
    return Math.floor((shifted + 1) / 2);
}

export function rshiftRound(a: number, shift: number): number {
    return shift === 1 ? ((a >> 1) + (a & 1)) | 0 : ((a >> (shift - 1)) + 1) >> 1;
}

export function addSat32(a: number, b: number): number {
    const sum = a + b;
    return sum > INT32_MAX ? INT32_MAX : sum < INT32_MIN ? INT32_MIN : sum;
}

export function subSat32(a: number, b: number): number {
    const difference = a - b;
    return difference > INT32_MAX ? INT32_MAX : difference < INT32_MIN ? INT32_MIN : difference;
}

export function lshiftSat32(a: number, shift: number): number {
    const high = INT32_MAX >> shift;
    const low = INT32_MIN >> shift;
    return (a > high ? high : a < low ? low : a) << shift;
}

export function limit(a: number, low: number, high: number): number {
    return a > high ? high : a < low ? low : a;
}

/** C integer division (truncates toward zero). */
export function div32(a: number, b: number): number {
    return (a / b) | 0;
}

export function rand(seed: number): number {
    return (Math.imul(seed, 196314165) + 907633515) | 0;
}

function ror32(a: number, rot: number): number {
    if (rot === 0) return a;
    if (rot < 0) return (a << -rot) | (a >>> (32 + rot)) | 0;
    return (a << (32 - rot)) | (a >>> rot) | 0;
}

/** Leading zeros of `a` and the seven fraction bits below its highest set bit. */
function clzFrac(a: number): [number, number] {
    const lz = clz32(a);
    return [lz, ror32(a, 24 - lz) & 0x7f];
}

export function sqrtApprox(x: number): number {
    if (x <= 0) return 0;
    const [lz, frac] = clzFrac(x);
    let y = lz & 1 ? 32768 : 46214;
    y >>= lz >> 1;
    return smlawb(y, y, smulbb(213, frac));
}

export function log2lin(inLogQ7: number): number {
    if (inLogQ7 < 0) return 0;
    if (inLogQ7 >= 3967) return INT32_MAX;
    let out = 1 << (inLogQ7 >> 7);
    const frac = inLogQ7 & 0x7f;
    const curve = smlawb(frac, smulbb(frac, 128 - frac), -174);
    if (inLogQ7 < 2048) out = (out + (Math.imul(out, curve) >> 7)) | 0;
    else out = (out + Math.imul(out >> 7, curve)) | 0;
    return out;
}

/** 1 / b32 in Q(Qres). */
export function inverse32VarQ(b32: number, qres: number): number {
    const headroom = clz32(Math.abs(b32)) - 1;
    const bNorm = b32 << headroom;
    const bInv = div32(INT32_MAX >> 2, bNorm >> 16);
    let result = bInv << 16;
    const errQ32 = (((1 << 29) - smulwb(bNorm, bInv)) << 3) | 0;
    result = smlaww(result, errQ32, bInv);
    const lshift = 61 - headroom - qres;
    if (lshift <= 0) return lshiftSat32(result, -lshift);
    return lshift < 32 ? result >> lshift : 0;
}

/** a32 / b32 in Q(Qres). */
export function div32VarQ(a32: number, b32: number, qres: number): number {
    const aHeadroom = clz32(Math.abs(a32)) - 1;
    let aNorm = a32 << aHeadroom;
    const bHeadroom = clz32(Math.abs(b32)) - 1;
    const bNorm = b32 << bHeadroom;
    const bInv = div32(INT32_MAX >> 2, bNorm >> 16);
    let result = smulwb(aNorm, bInv);
    aNorm = (aNorm - (smmul(bNorm, result) << 3)) | 0;
    result = smlawb(result, aNorm, bInv);
    const lshift = 29 + aHeadroom - bHeadroom - qres;
    if (lshift < 0) return lshiftSat32(result, -lshift);
    return lshift < 32 ? result >> lshift : 0;
}
