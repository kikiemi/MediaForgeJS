/**
 * The AC-3 synthesis filter bank (A/52 7.9): inverse MDCTs of 256 coefficients, or of two
 * interleaved sets of 128 for a block-switched block, windowed by the 512-point Kaiser-Bessel
 * derived window (alpha 5) and overlapped with the previous block.
 */

/**
 * The middle half of the inverse MDCT of `size` coefficients, of the sign A/52 synthesizes with:
 * -x[n + size / 2] for n below `size`, where x[n] = sum over k of X[k] cos(pi / size
 * (n + 1/2 + size / 2)(k + 1/2)). It is computed as a DCT-IV of the alternately negated, reversed
 * coefficients through a complex FFT of size / 4 points.
 */
export class HalfImdct {
    private readonly quarter: number;
    private readonly preCos: Float64Array;
    private readonly preSin: Float64Array;
    private readonly postCos: Float64Array;
    private readonly postSin: Float64Array;
    private readonly fftCos: Float64Array;
    private readonly fftSin: Float64Array;
    private readonly reversed: Uint16Array;
    private readonly re: Float64Array;
    private readonly im: Float64Array;

    constructor(private readonly size: number) {
        const half = size >> 1;
        this.quarter = half;
        this.preCos = new Float64Array(half);
        this.preSin = new Float64Array(half);
        this.postCos = new Float64Array(half);
        this.postSin = new Float64Array(half);
        for (let t = 0; t < half; t++) {
            const pre = (-Math.PI * (4 * t + 1)) / (4 * size);
            const post = (-Math.PI * t) / size;
            this.preCos[t] = Math.cos(pre);
            this.preSin[t] = Math.sin(pre);
            this.postCos[t] = Math.cos(post);
            this.postSin[t] = Math.sin(post);
        }
        this.fftCos = new Float64Array(half >> 1);
        this.fftSin = new Float64Array(half >> 1);
        for (let k = 0; k < half >> 1; k++) {
            this.fftCos[k] = Math.cos((-2 * Math.PI * k) / half);
            this.fftSin[k] = Math.sin((-2 * Math.PI * k) / half);
        }
        this.reversed = new Uint16Array(half);
        const bits = Math.log2(half);
        for (let index = 0; index < half; index++) {
            let value = 0;
            for (let bit = 0; bit < bits; bit++) value |= ((index >> bit) & 1) << (bits - 1 - bit);
            this.reversed[index] = value;
        }
        this.re = new Float64Array(half);
        this.im = new Float64Array(half);
    }

    /** Writes the `size` outputs of the coefficients at in[from + step * k] into out[at...]. */
    run(input: Float32Array, from: number, step: number, out: Float32Array, at: number): void {
        const size = this.size;
        const half = this.quarter;
        const { re, im, preCos, preSin, reversed } = this;

        // The DCT-IV input c[j] = (-1)^j X[size - 1 - j], pre-twiddled in pairs
        // (c[2t], c[size-1-2t]).
        for (let t = 0; t < half; t++) {
            const a = input[from + step * (size - 1 - 2 * t)]!;
            const b = -input[from + step * (2 * t)]!;
            const slot = reversed[t]!;
            re[slot] = a * preCos[t]! - b * preSin[t]!;
            im[slot] = a * preSin[t]! + b * preCos[t]!;
        }

        // Radix-2 decimation in time over the bit-reversed order.
        const { fftCos, fftSin } = this;
        for (let span = 1, stride = half >> 1; span < half; span <<= 1, stride >>= 1)
            for (let start = 0; start < half; start += span << 1)
                for (let k = 0; k < span; k++) {
                    const wr = fftCos[k * stride]!;
                    const wi = fftSin[k * stride]!;
                    const p = start + k;
                    const q = p + span;
                    const tr = re[q]! * wr - im[q]! * wi;
                    const ti = re[q]! * wi + im[q]! * wr;
                    re[q] = re[p]! - tr;
                    im[q] = im[p]! - ti;
                    re[p] = re[p]! + tr;
                    im[p] = im[p]! + ti;
                }

        // Post-twiddle: y[2t] and y[size-1-2t] of the DCT-IV, then the alternating sign.
        const { postCos, postSin } = this;
        for (let t = 0; t < half; t++) {
            const r = re[t]! * postCos[t]! - im[t]! * postSin[t]!;
            const i = re[t]! * postSin[t]! + im[t]! * postCos[t]!;
            out[at + 2 * t] = -r;
            out[at + size - 1 - 2 * t] = -i;
        }
    }
}

/**
 * The 256 output samples of a block: the 128 delayed samples of the previous block and the first
 * 128 of this block's transform, windowed and overlapped (time-domain aliasing cancellation).
 */
export function overlap(
    delay: Float32Array,
    current: Float32Array,
    window: Float32Array,
    out: Float32Array,
    at: number,
): void {
    for (let m = 0; m < 128; m++) {
        const previous = delay[m]!;
        const next = current[127 - m]!;
        const rising = window[m]!;
        const falling = window[255 - m]!;
        out[at + m] = previous * falling - next * rising;
        out[at + 255 - m] = previous * rising + next * falling;
    }
}
