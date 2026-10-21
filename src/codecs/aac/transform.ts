/**
 * DCT-IV of a power-of-two length n through an n/2-point complex FFT: X[k] = sum_j x[j] cos(pi/n (j
 * + 1/2)(k + 1/2)). The AAC inverse MDCT and the SBR QMF banks reduce to it.
 */
export class Dct4 {
    private readonly n: number;
    private readonly preRe: Float64Array;
    private readonly preIm: Float64Array;
    private readonly postRe: Float64Array;
    private readonly postIm: Float64Array;
    private readonly twiddleRe: Float64Array;
    private readonly twiddleIm: Float64Array;
    private readonly reverse: Uint32Array;
    private readonly re: Float64Array;
    private readonly im: Float64Array;

    constructor(n: number) {
        const half = n >> 1;
        this.n = n;
        this.preRe = Float64Array.from({ length: half }, (_, j) =>
            Math.cos((-Math.PI * (j + 0.25)) / n),
        );
        this.preIm = Float64Array.from({ length: half }, (_, j) =>
            Math.sin((-Math.PI * (j + 0.25)) / n),
        );
        this.postRe = Float64Array.from({ length: half }, (_, k) => Math.cos((-Math.PI * k) / n));
        this.postIm = Float64Array.from({ length: half }, (_, k) => Math.sin((-Math.PI * k) / n));
        this.twiddleRe = Float64Array.from({ length: half >> 1 }, (_, j) =>
            Math.cos((-2 * Math.PI * j) / half),
        );
        this.twiddleIm = Float64Array.from({ length: half >> 1 }, (_, j) =>
            Math.sin((-2 * Math.PI * j) / half),
        );
        this.reverse = new Uint32Array(half);
        for (let i = 1, j = 0; i < half; i++) {
            let bit = half >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            this.reverse[i] = j;
        }
        this.re = new Float64Array(half);
        this.im = new Float64Array(half);
    }

    /**
     * out[at + k * stride] = scale * X[k] of input[from, from + n) for k < n; a stride of -1 with
     * `at` at the last slot writes the transform backwards.
     */
    run(
        input: Float64Array,
        from: number,
        out: Float64Array,
        at: number,
        stride: number,
        scale: number,
    ): void {
        const { n, re, im, preRe, preIm, postRe, postIm, twiddleRe, twiddleIm, reverse } = this;
        const half = n >> 1;
        for (let j = 0; j < half; j++) {
            const a = input[from + 2 * j]!;
            const b = input[from + n - 1 - 2 * j]!;
            const c = preRe[j]!;
            const s = preIm[j]!;
            const slot = reverse[j]!;
            re[slot] = a * c - b * s;
            im[slot] = a * s + b * c;
        }

        // The butterflies of a stage are independent: each twiddle factor serves all of its blocks
        // in turn.
        for (let len = 2, step = half >> 1; len <= half; len <<= 1, step >>= 1) {
            const span = len >> 1;
            for (let j = 0; j < span; j++) {
                const wr = twiddleRe[j * step]!;
                const wi = twiddleIm[j * step]!;
                for (let p = j; p < half; p += len) {
                    const q = p + span;
                    const qr = re[q]!;
                    const qi = im[q]!;
                    const pr = re[p]!;
                    const pi = im[p]!;
                    const xr = qr * wr - qi * wi;
                    const xi = qr * wi + qi * wr;
                    re[q] = pr - xr;
                    im[q] = pi - xi;
                    re[p] = pr + xr;
                    im[p] = pi + xi;
                }
            }
        }
        for (let k = 0; k < half; k++) {
            const c = postRe[k]!;
            const s = postIm[k]!;
            out[at + 2 * k * stride] = (re[k]! * c - im[k]! * s) * scale;
            out[at + (n - 1 - 2 * k) * stride] = -(re[k]! * s + im[k]! * c) * scale;
        }
    }
}
