/** An N-point real FFT through an N/2-point complex FFT; spectra hold bins 0 to N/2. */
export class RealFft {
    private readonly half: number;
    private readonly reverse: Uint32Array;
    private readonly cos: Float64Array;
    private readonly sin: Float64Array;
    /** e^{-2πik/N} for k ≤ N/2. */
    private readonly splitCos: Float64Array;
    private readonly splitSin: Float64Array;
    private readonly re: Float64Array;
    private readonly im: Float64Array;

    constructor(readonly size: number) {
        const half = size >> 1;
        this.half = half;
        this.reverse = new Uint32Array(half);
        for (let i = 1, j = 0; i < half; i++) {
            let bit = half >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            this.reverse[i] = j;
        }
        this.cos = Float64Array.from({ length: half >> 1 }, (_, k) =>
            Math.cos((-2 * Math.PI * k) / half),
        );
        this.sin = Float64Array.from({ length: half >> 1 }, (_, k) =>
            Math.sin((-2 * Math.PI * k) / half),
        );
        this.splitCos = Float64Array.from({ length: half + 1 }, (_, k) =>
            Math.cos((-2 * Math.PI * k) / size),
        );
        this.splitSin = Float64Array.from({ length: half + 1 }, (_, k) =>
            Math.sin((-2 * Math.PI * k) / size),
        );
        this.re = new Float64Array(half);
        this.im = new Float64Array(half);
    }

    /**
     * In-place forward complex FFT of the work arrays, which hold their input in bit-reversed
     * order.
     */
    private transform(): void {
        const { half, re, im, cos, sin } = this;
        for (let length = 2, step = half >> 1; length <= half; length <<= 1, step >>= 1) {
            const span = length >> 1;
            for (let base = 0; base < half; base += length)
                for (let j = 0; j < span; j++) {
                    const p = base + j;
                    const q = p + span;
                    const wr = cos[j * step]!;
                    const wi = sin[j * step]!;
                    const xr = re[q]! * wr - im[q]! * wi;
                    const xi = re[q]! * wi + im[q]! * wr;
                    re[q] = re[p]! - xr;
                    im[q] = im[p]! - xi;
                    re[p] = re[p]! + xr;
                    im[p] = im[p]! + xi;
                }
        }
    }

    /** The spectrum of `input` (N samples) into `outRe`/`outIm` (N/2 + 1 bins). */
    forward(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
        const { half, re, im, reverse, splitCos, splitSin } = this;
        for (let k = 0; k < half; k++) {
            const slot = reverse[k]!;
            re[slot] = input[2 * k]!;
            im[slot] = input[2 * k + 1]!;
        }
        this.transform();
        for (let k = 0; k <= half; k++) {
            const zr = re[k % half]!;
            const zi = im[k % half]!;
            const cr = re[(half - k) % half]!;
            const ci = -im[(half - k) % half]!;
            const er = (zr + cr) / 2;
            const ei = (zi + ci) / 2;

            // O = (Z - conj Z[M-k]) / 2i
            const or = (zi - ci) / 2;
            const oi = -(zr - cr) / 2;
            const wr = splitCos[k]!;
            const wi = splitSin[k]!;
            outRe[k] = er + or * wr - oi * wi;
            outIm[k] = ei + or * wi + oi * wr;
        }
    }

    /** The N samples of a spectrum of N/2 + 1 bins, scaled by 1/N. */
    inverse(inRe: Float64Array, inIm: Float64Array, output: Float64Array): void {
        const { half, re, im, reverse, splitCos, splitSin } = this;
        for (let k = 0; k < half; k++) {
            const xr = inRe[k]!;
            const xi = inIm[k]!;
            const cr = inRe[half - k]!;
            const ci = -inIm[half - k]!;
            const er = (xr + cr) / 2;
            const ei = (xi + ci) / 2;

            // O = (X - conj X[M-k]) e^{2πik/N} / 2
            const dr = (xr - cr) / 2;
            const di = (xi - ci) / 2;
            const wr = splitCos[k]!;
            const wi = -splitSin[k]!;
            const or = dr * wr - di * wi;
            const oi = dr * wi + di * wr;

            // Z = E + iO, conjugated for the inverse through the forward transform.
            const slot = reverse[k]!;
            re[slot] = er - oi;
            im[slot] = -(ei + or);
        }
        this.transform();
        const scale = 1 / half;
        for (let k = 0; k < half; k++) {
            output[2 * k] = re[k]! * scale;
            output[2 * k + 1] = -im[k]! * scale;
        }
    }
}
