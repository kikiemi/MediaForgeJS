/**
 * Separable 8x8 integer inverse DCT, IEEE 1180-1990 compliant for dequantized coefficients in
 * [-2048, 2047]. The weights are 2^14 * sqrt(2) * cos(k * pi / 16) with W4 = 2^14 - 1; rows round
 * at 2^11 and columns at 2^20.
 */
const W1 = 22725;
const W2 = 21407;
const W3 = 19266;
const W4 = 16383;
const W5 = 12873;
const W6 = 8867;
const W7 = 4520;

const COLUMNS_IN_PLACE = 0;
const COLUMNS_PUT = 1;
const COLUMNS_ADD = 2;

function transformRows(block: Int32Array): void {
    for (let row = 0; row < 64; row += 8) {
        const x0 = block[row];
        const x1 = block[row + 1];
        const x2 = block[row + 2];
        const x3 = block[row + 3];
        const x4 = block[row + 4];
        const x5 = block[row + 5];
        const x6 = block[row + 6];
        const x7 = block[row + 7];
        if ((x1 | x2 | x3 | x4 | x5 | x6 | x7) === 0) {
            if (x0 !== 0) {
                const dc = x0 << 3;
                block[row] = dc;
                block[row + 1] = dc;
                block[row + 2] = dc;
                block[row + 3] = dc;
                block[row + 4] = dc;
                block[row + 5] = dc;
                block[row + 6] = dc;
                block[row + 7] = dc;
            }
            continue;
        }
        let a0 = W4 * x0 + 1024;
        let a1 = a0 + W6 * x2;
        let a2 = a0 - W6 * x2;
        let a3 = a0 - W2 * x2;
        a0 += W2 * x2;
        let b0 = W1 * x1 + W3 * x3;
        let b1 = W3 * x1 - W7 * x3;
        let b2 = W5 * x1 - W1 * x3;
        let b3 = W7 * x1 - W5 * x3;
        if ((x4 | x5 | x6 | x7) !== 0) {
            a0 += W4 * x4 + W6 * x6;
            a1 += -W4 * x4 - W2 * x6;
            a2 += -W4 * x4 + W2 * x6;
            a3 += W4 * x4 - W6 * x6;
            b0 += W5 * x5 + W7 * x7;
            b1 += -W1 * x5 - W5 * x7;
            b2 += W7 * x5 + W3 * x7;
            b3 += W3 * x5 - W1 * x7;
        }
        block[row] = (a0 + b0) >> 11;
        block[row + 7] = (a0 - b0) >> 11;
        block[row + 1] = (a1 + b1) >> 11;
        block[row + 6] = (a1 - b1) >> 11;
        block[row + 2] = (a2 + b2) >> 11;
        block[row + 5] = (a2 - b2) >> 11;
        block[row + 3] = (a3 + b3) >> 11;
        block[row + 4] = (a3 - b3) >> 11;
    }
}

function transformColumns(
    block: Int32Array,
    mode: number,
    out: Uint8ClampedArray,
    offset: number,
    stride: number,
): void {
    for (let col = 0; col < 8; col++) {
        const x0 = block[col];
        const x1 = block[col + 8];
        const x2 = block[col + 16];
        const x3 = block[col + 24];
        const x4 = block[col + 32];
        const x5 = block[col + 40];
        const x6 = block[col + 48];
        const x7 = block[col + 56];
        let a0 = W4 * (x0 + 32);
        let a1 = a0 + W6 * x2;
        let a2 = a0 - W6 * x2;
        let a3 = a0 - W2 * x2;
        a0 += W2 * x2;
        let b0 = W1 * x1 + W3 * x3;
        let b1 = W3 * x1 - W7 * x3;
        let b2 = W5 * x1 - W1 * x3;
        let b3 = W7 * x1 - W5 * x3;
        if (x4 !== 0) {
            a0 += W4 * x4;
            a1 -= W4 * x4;
            a2 -= W4 * x4;
            a3 += W4 * x4;
        }
        if (x5 !== 0) {
            b0 += W5 * x5;
            b1 -= W1 * x5;
            b2 += W7 * x5;
            b3 += W3 * x5;
        }
        if (x6 !== 0) {
            a0 += W6 * x6;
            a1 -= W2 * x6;
            a2 += W2 * x6;
            a3 -= W6 * x6;
        }
        if (x7 !== 0) {
            b0 += W7 * x7;
            b1 -= W5 * x7;
            b2 += W3 * x7;
            b3 -= W1 * x7;
        }
        if (mode === COLUMNS_IN_PLACE) {
            block[col] = (a0 + b0) >> 20;
            block[col + 8] = (a1 + b1) >> 20;
            block[col + 16] = (a2 + b2) >> 20;
            block[col + 24] = (a3 + b3) >> 20;
            block[col + 32] = (a3 - b3) >> 20;
            block[col + 40] = (a2 - b2) >> 20;
            block[col + 48] = (a1 - b1) >> 20;
            block[col + 56] = (a0 - b0) >> 20;
            continue;
        }
        const o = offset + col;
        if (mode === COLUMNS_PUT) {
            out[o] = (a0 + b0) >> 20;
            out[o + stride] = (a1 + b1) >> 20;
            out[o + stride * 2] = (a2 + b2) >> 20;
            out[o + stride * 3] = (a3 + b3) >> 20;
            out[o + stride * 4] = (a3 - b3) >> 20;
            out[o + stride * 5] = (a2 - b2) >> 20;
            out[o + stride * 6] = (a1 - b1) >> 20;
            out[o + stride * 7] = (a0 - b0) >> 20;
        } else {
            out[o] = out[o] + ((a0 + b0) >> 20);
            out[o + stride] = out[o + stride] + ((a1 + b1) >> 20);
            out[o + stride * 2] = out[o + stride * 2] + ((a2 + b2) >> 20);
            out[o + stride * 3] = out[o + stride * 3] + ((a3 + b3) >> 20);
            out[o + stride * 4] = out[o + stride * 4] + ((a3 - b3) >> 20);
            out[o + stride * 5] = out[o + stride * 5] + ((a2 - b2) >> 20);
            out[o + stride * 6] = out[o + stride * 6] + ((a1 - b1) >> 20);
            out[o + stride * 7] = out[o + stride * 7] + ((a0 - b0) >> 20);
        }
    }
}

const NO_OUTPUT = new Uint8ClampedArray(0);

/**
 * Transforms 64 dequantized coefficients in row-major natural order, in place, into spatial samples
 * before any clamping or prediction add.
 */
export function idct8x8(block: Int32Array): void {
    transformRows(block);
    transformColumns(block, COLUMNS_IN_PLACE, NO_OUTPUT, 0, 0);
}

/**
 * Transforms like idct8x8 and stores the samples into the 8x8 area at `offset` of `out` (rows
 * `stride` apart), where the clamped array saturates them to 0-255. The block's contents are
 * unspecified afterwards.
 */
export function idct8x8Put(
    block: Int32Array,
    out: Uint8ClampedArray,
    offset: number,
    stride: number,
): void {
    transformRows(block);
    transformColumns(block, COLUMNS_PUT, out, offset, stride);
}

/** Like idct8x8Put, but adds the samples to the prediction already in `out`. */
export function idct8x8Add(
    block: Int32Array,
    out: Uint8ClampedArray,
    offset: number,
    stride: number,
): void {
    transformRows(block);
    transformColumns(block, COLUMNS_ADD, out, offset, stride);
}

/**
 * The constant sample value idct8x8 produces for a block whose only nonzero coefficient is the DC.
 */
export function idct8x8DcOnly(dc: number): number {
    return (W4 * ((dc << 3) + 32)) >> 20;
}
