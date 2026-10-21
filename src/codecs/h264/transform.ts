const tmp = new Int32Array(64);

/**
 * Adds the inverse 4x4 transform (8.5.12.2) of the scaled coefficients at `c[co..co+15]` to the
 * block at `dst[o]`, where the clamped array saturates the sums to 0-255, and clears the
 * coefficients.
 */
export function idct4x4Add(
    c: Int32Array,
    co: number,
    dst: Uint8ClampedArray,
    o: number,
    stride: number,
): void {
    for (let i = 0; i < 16; i += 4) {
        const row = co + i;
        const d0 = c[row];
        const d1 = c[row + 1];
        const d2 = c[row + 2];
        const d3 = c[row + 3];
        c[row] = c[row + 1] = c[row + 2] = c[row + 3] = 0;
        const e = d0 + d2;
        const f = d0 - d2;
        const g = (d1 >> 1) - d3;
        const h = d1 + (d3 >> 1);
        tmp[i] = e + h;
        tmp[i + 1] = f + g;
        tmp[i + 2] = f - g;
        tmp[i + 3] = e - h;
    }
    const s2 = stride * 2;
    const s3 = stride * 3;
    for (let j = 0; j < 4; j++) {
        const d0 = tmp[j] + 32;
        const d1 = tmp[4 + j];
        const d2 = tmp[8 + j];
        const d3 = tmp[12 + j];
        const e = d0 + d2;
        const f = d0 - d2;
        const g = (d1 >> 1) - d3;
        const h = d1 + (d3 >> 1);
        const p = o + j;
        dst[p] = dst[p] + ((e + h) >> 6);
        dst[p + stride] = dst[p + stride] + ((f + g) >> 6);
        dst[p + s2] = dst[p + s2] + ((f - g) >> 6);
        dst[p + s3] = dst[p + s3] + ((e - h) >> 6);
    }
}

/**
 * Adds a 4x4 block whose only coefficient is the scaled DC `dc`; the transform adds (dc + 32) >> 6
 * everywhere.
 */
export function dc4x4Add(dc: number, dst: Uint8ClampedArray, o: number, stride: number): void {
    const v = (dc + 32) >> 6;
    if (v === 0) return;
    for (let i = 0, p = o; i < 4; i++, p += stride) {
        dst[p] = dst[p] + v;
        dst[p + 1] = dst[p + 1] + v;
        dst[p + 2] = dst[p + 2] + v;
        dst[p + 3] = dst[p + 3] + v;
    }
}

/**
 * Adds the inverse 8x8 transform (8.5.13.2) of `c[co..co+63]` to the block at `dst[o]` and clears
 * the coefficients.
 */
export function idct8x8Add(
    c: Int32Array,
    co: number,
    dst: Uint8ClampedArray,
    o: number,
    stride: number,
): void {
    for (let i = 0; i < 8; i++) {
        const r = co + i * 8;
        const d0 = c[r];
        const d1 = c[r + 1];
        const d2 = c[r + 2];
        const d3 = c[r + 3];
        const d4 = c[r + 4];
        const d5 = c[r + 5];
        const d6 = c[r + 6];
        const d7 = c[r + 7];
        c[r] = c[r + 1] = c[r + 2] = c[r + 3] = c[r + 4] = c[r + 5] = c[r + 6] = c[r + 7] = 0;
        const a0 = d0 + d4;
        const a4 = d0 - d4;
        const a2 = (d2 >> 1) - d6;
        const a6 = d2 + (d6 >> 1);
        const b0 = a0 + a6;
        const b2 = a4 + a2;
        const b4 = a4 - a2;
        const b6 = a0 - a6;
        const a1 = -d3 + d5 - d7 - (d7 >> 1);
        const a3 = d1 + d7 - d3 - (d3 >> 1);
        const a5 = -d1 + d7 + d5 + (d5 >> 1);
        const a7 = d3 + d5 + d1 + (d1 >> 1);
        const b1 = a1 + (a7 >> 2);
        const b7 = a7 - (a1 >> 2);
        const b3 = a3 + (a5 >> 2);
        const b5 = (a3 >> 2) - a5;
        const t = i * 8;
        tmp[t] = b0 + b7;
        tmp[t + 1] = b2 + b5;
        tmp[t + 2] = b4 + b3;
        tmp[t + 3] = b6 + b1;
        tmp[t + 4] = b6 - b1;
        tmp[t + 5] = b4 - b3;
        tmp[t + 6] = b2 - b5;
        tmp[t + 7] = b0 - b7;
    }
    for (let j = 0; j < 8; j++) {
        const d0 = tmp[j] + 32;
        const d1 = tmp[8 + j];
        const d2 = tmp[16 + j];
        const d3 = tmp[24 + j];
        const d4 = tmp[32 + j];
        const d5 = tmp[40 + j];
        const d6 = tmp[48 + j];
        const d7 = tmp[56 + j];
        const a0 = d0 + d4;
        const a4 = d0 - d4;
        const a2 = (d2 >> 1) - d6;
        const a6 = d2 + (d6 >> 1);
        const b0 = a0 + a6;
        const b2 = a4 + a2;
        const b4 = a4 - a2;
        const b6 = a0 - a6;
        const a1 = -d3 + d5 - d7 - (d7 >> 1);
        const a3 = d1 + d7 - d3 - (d3 >> 1);
        const a5 = -d1 + d7 + d5 + (d5 >> 1);
        const a7 = d3 + d5 + d1 + (d1 >> 1);
        const b1 = a1 + (a7 >> 2);
        const b7 = a7 - (a1 >> 2);
        const b3 = a3 + (a5 >> 2);
        const b5 = (a3 >> 2) - a5;
        let p = o + j;
        dst[p] = dst[p] + ((b0 + b7) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b2 + b5) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b4 + b3) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b6 + b1) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b6 - b1) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b4 - b3) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b2 - b5) >> 6);
        p += stride;
        dst[p] = dst[p] + ((b0 - b7) >> 6);
    }
}

/** Adds an 8x8 block whose only coefficient is the scaled DC `dc`. */
export function dc8x8Add(dc: number, dst: Uint8ClampedArray, o: number, stride: number): void {
    const v = (dc + 32) >> 6;
    if (v === 0) return;
    for (let i = 0, p = o; i < 8; i++, p += stride) {
        for (let j = 0; j < 8; j++) dst[p + j] = dst[p + j] + v;
    }
}

/**
 * Inverse Hadamard and scaling of the Intra_16x16 luma DC coefficients (8.5.10): `c[co..co+15]`
 * holds the 4x4 DC matrix in raster order and receives the scaled values dcY.
 */
export function lumaDcTransform(c: Int32Array, co: number, scale: number, qp: number): void {
    for (let i = 0; i < 4; i++) {
        const d0 = c[co + i];
        const d1 = c[co + 4 + i];
        const d2 = c[co + 8 + i];
        const d3 = c[co + 12 + i];
        const s01 = d0 + d1;
        const d01 = d0 - d1;
        const s23 = d2 + d3;
        const d23 = d2 - d3;
        tmp[i] = s01 + s23;
        tmp[4 + i] = s01 - s23;
        tmp[8 + i] = d01 - d23;
        tmp[12 + i] = d01 + d23;
    }
    const div = Math.floor(qp / 6);
    for (let i = 0; i < 4; i++) {
        const r = i * 4;
        const d0 = tmp[r];
        const d1 = tmp[r + 1];
        const d2 = tmp[r + 2];
        const d3 = tmp[r + 3];
        const s01 = d0 + d1;
        const d01 = d0 - d1;
        const s23 = d2 + d3;
        const d23 = d2 - d3;
        const f0 = s01 + s23;
        const f1 = s01 - s23;
        const f2 = d01 - d23;
        const f3 = d01 + d23;
        if (qp >= 36) {
            const shift = div - 6;
            c[co + r] = (f0 * scale) << shift;
            c[co + r + 1] = (f1 * scale) << shift;
            c[co + r + 2] = (f2 * scale) << shift;
            c[co + r + 3] = (f3 * scale) << shift;
        } else {
            const shift = 6 - div;
            const round = 1 << (5 - div);
            c[co + r] = (f0 * scale + round) >> shift;
            c[co + r + 1] = (f1 * scale + round) >> shift;
            c[co + r + 2] = (f2 * scale + round) >> shift;
            c[co + r + 3] = (f3 * scale + round) >> shift;
        }
    }
}

/** 2x2 chroma DC transform and scaling for 4:2:0 (8.5.11.1, 8.5.11.2) in place at `c[co..co+3]`. */
export function chromaDcTransform420(c: Int32Array, co: number, scale: number, qp: number): void {
    const c0 = c[co];
    const c1 = c[co + 1];
    const c2 = c[co + 2];
    const c3 = c[co + 3];
    const f0 = c0 + c1 + c2 + c3;
    const f1 = c0 - c1 + c2 - c3;
    const f2 = c0 + c1 - c2 - c3;
    const f3 = c0 - c1 - c2 + c3;
    const shift = Math.floor(qp / 6);
    c[co] = ((f0 * scale) << shift) >> 5;
    c[co + 1] = ((f1 * scale) << shift) >> 5;
    c[co + 2] = ((f2 * scale) << shift) >> 5;
    c[co + 3] = ((f3 * scale) << shift) >> 5;
}

/**
 * 2x4 chroma DC transform and scaling for 4:2:2 (8.5.11.1, 8.5.11.2): `c[co..co+7]` holds the 4
 * rows x 2 columns in raster order; `scale` is LevelScale4x4(qPdc % 6, 0, 0) and `qp` is qPdc = QPc
 * + 3.
 */
export function chromaDcTransform422(c: Int32Array, co: number, scale: number, qp: number): void {
    for (let j = 0; j < 2; j++) {
        const d0 = c[co + j];
        const d1 = c[co + 2 + j];
        const d2 = c[co + 4 + j];
        const d3 = c[co + 6 + j];
        const s01 = d0 + d1;
        const d01 = d0 - d1;
        const s23 = d2 + d3;
        const d23 = d2 - d3;
        tmp[j] = s01 + s23;
        tmp[2 + j] = s01 - s23;
        tmp[4 + j] = d01 - d23;
        tmp[6 + j] = d01 + d23;
    }
    const div = Math.floor(qp / 6);
    for (let i = 0; i < 4; i++) {
        const a = tmp[i * 2];
        const b = tmp[i * 2 + 1];
        const f0 = a + b;
        const f1 = a - b;
        if (qp >= 36) {
            c[co + i * 2] = (f0 * scale) << (div - 6);
            c[co + i * 2 + 1] = (f1 * scale) << (div - 6);
        } else {
            const round = 1 << (5 - div);
            c[co + i * 2] = (f0 * scale + round) >> (6 - div);
            c[co + i * 2 + 1] = (f1 * scale + round) >> (6 - div);
        }
    }
}
