const ROW_TABLES: readonly (readonly number[])[] = [
    [22725, 21407, 19266, 16384, 12873, 8867, 4520],
    [31521, 29692, 26722, 22725, 17855, 12299, 6270],
    [29692, 27969, 25172, 21407, 16819, 11585, 5906],
    [26722, 25172, 22654, 19266, 15137, 10426, 5315],
    [22725, 21407, 19266, 16384, 12873, 8867, 4520],
    [26722, 25172, 22654, 19266, 15137, 10426, 5315],
    [29692, 27969, 25172, 21407, 16819, 11585, 5906],
    [31521, 29692, 26722, 22725, 17855, 12299, 6270],
];

/**
 * Per-row rounders of the Xvid (Walken) IDCT in 11-bit fixed point; row 0 carries the column
 * rounding.
 */
const ROW_ROUNDERS = [65536, 3597, 2260, 1203, 0, 120, 512, 512];
const TAN1 = 0x32ec;
const TAN2 = 0x6a0a;
const TAN3 = 0xab0e;
const SQRT2 = 0x5a82;

/**
 * In-place 8x8 inverse DCT matching the Xvid encoder's reconstruction, for streams whose user data
 * names Xvid. Same contract as `idct8x8`: natural-order coefficients in, residual samples before
 * clamping out.
 */
export function xvidIdct8x8(block: Int32Array): void {
    for (let row = 0; row < 8; row++) {
        const o = row << 3;
        const t = ROW_TABLES[row];
        const c1 = t[0];
        const c2 = t[1];
        const c3 = t[2];
        const c4 = t[3];
        const c5 = t[4];
        const c6 = t[5];
        const c7 = t[6];
        const rnd = ROW_ROUNDERS[row];
        const i0 = block[o];
        const i1 = block[o + 1];
        const i2 = block[o + 2];
        const i3 = block[o + 3];
        const i4 = block[o + 4];
        const i5 = block[o + 5];
        const i6 = block[o + 6];
        const i7 = block[o + 7];
        if ((i4 | i5 | i6 | i7) === 0) {
            const k = c4 * i0 + rnd;
            if ((i1 | i2 | i3) === 0) {
                const a0 = k >> 11;
                for (let i = 0; i < 8; i++) block[o + i] = a0;
                continue;
            }
            const a0 = k + c2 * i2;
            const a1 = k + c6 * i2;
            const a2 = k - c6 * i2;
            const a3 = k - c2 * i2;
            const b0 = c1 * i1 + c3 * i3;
            const b1 = c3 * i1 - c7 * i3;
            const b2 = c5 * i1 - c1 * i3;
            const b3 = c7 * i1 - c5 * i3;
            block[o] = (a0 + b0) >> 11;
            block[o + 1] = (a1 + b1) >> 11;
            block[o + 2] = (a2 + b2) >> 11;
            block[o + 3] = (a3 + b3) >> 11;
            block[o + 4] = (a3 - b3) >> 11;
            block[o + 5] = (a2 - b2) >> 11;
            block[o + 6] = (a1 - b1) >> 11;
            block[o + 7] = (a0 - b0) >> 11;
            continue;
        }
        if ((i1 | i2 | i3 | i5 | i6 | i7) === 0) {
            const a0 = (rnd + c4 * (i0 + i4)) >> 11;
            const a1 = (rnd + c4 * (i0 - i4)) >> 11;
            block[o] = a0;
            block[o + 3] = a0;
            block[o + 4] = a0;
            block[o + 7] = a0;
            block[o + 1] = a1;
            block[o + 2] = a1;
            block[o + 5] = a1;
            block[o + 6] = a1;
            continue;
        }
        const k = c4 * i0 + rnd;
        const a0 = k + c2 * i2 + c4 * i4 + c6 * i6;
        const a1 = k + c6 * i2 - c4 * i4 - c2 * i6;
        const a2 = k - c6 * i2 - c4 * i4 + c2 * i6;
        const a3 = k - c2 * i2 + c4 * i4 - c6 * i6;
        const b0 = c1 * i1 + c3 * i3 + c5 * i5 + c7 * i7;
        const b1 = c3 * i1 - c7 * i3 - c1 * i5 - c5 * i7;
        const b2 = c5 * i1 - c1 * i3 + c7 * i5 + c3 * i7;
        const b3 = c7 * i1 - c5 * i3 + c3 * i5 - c1 * i7;
        block[o] = (a0 + b0) >> 11;
        block[o + 1] = (a1 + b1) >> 11;
        block[o + 2] = (a2 + b2) >> 11;
        block[o + 3] = (a3 + b3) >> 11;
        block[o + 4] = (a3 - b3) >> 11;
        block[o + 5] = (a2 - b2) >> 11;
        block[o + 6] = (a1 - b1) >> 11;
        block[o + 7] = (a0 - b0) >> 11;
    }
    for (let col = 0; col < 8; col++) {
        const x7 = block[col + 56];
        const x5 = block[col + 40];
        const x3 = block[col + 24];
        const x1 = block[col + 8];
        const m0 = (Math.imul(TAN1, x7) >> 16) + x1;
        const m1 = (Math.imul(TAN1, x1) >> 16) - x7;
        const m2 = (Math.imul(TAN3, x5) >> 16) + x3;
        const m3 = (Math.imul(TAN3, x3) >> 16) - x5;
        const o7 = m0 + m2;
        const o4 = m1 - m3;
        const d0 = m0 - m2;
        const d1 = m1 + m3;
        const o5 = 2 * (Math.imul(SQRT2, d0 - d1) >> 16);
        const o6 = 2 * (Math.imul(SQRT2, d0 + d1) >> 16);
        const x2 = block[col + 16];
        const x6 = block[col + 48];
        const e3 = (Math.imul(TAN2, x6) >> 16) + x2;
        const e2 = (Math.imul(TAN2, x2) >> 16) - x6;
        const s0 = block[col] + block[col + 32];
        const s1 = block[col] - block[col + 32];
        const f0 = s0 + e3;
        const f3 = s0 - e3;
        const f1 = s1 + e2;
        const f2 = s1 - e2;
        block[col] = (f0 + o7) >> 6;
        block[col + 56] = (f0 - o7) >> 6;
        block[col + 24] = (f3 + o4) >> 6;
        block[col + 32] = (f3 - o4) >> 6;
        block[col + 8] = (f1 + o6) >> 6;
        block[col + 48] = (f1 - o6) >> 6;
        block[col + 16] = (f2 + o5) >> 6;
        block[col + 40] = (f2 - o5) >> 6;
    }
}
