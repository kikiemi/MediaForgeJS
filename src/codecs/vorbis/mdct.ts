/**
 * Inverse MDCT of Vorbis I section 1.3.2 for one power-of-two block size n (64..8192): n/2
 * coefficients X[k] give y[i] = sum X[k] cos(2 pi / n (i + 1/2 + n/4)(k + 1/2)), computed as a
 * DCT-IV through an n/4-point complex FFT.
 */
export class VorbisMdct {
    readonly n: number;
    private readonly preCos: Float32Array;
    private readonly preSin: Float32Array;
    private readonly postCos: Float32Array;
    private readonly postSin: Float32Array;
    private readonly reverse: Uint16Array;
    private readonly twiddleRe: Float32Array;
    private readonly twiddleIm: Float32Array;
    private readonly re: Float32Array;
    private readonly im: Float32Array;
    private readonly dct: Float32Array;

    constructor(n: number) {
        this.n = n;
        const m = n >> 1;
        const q = n >> 2;
        this.preCos = new Float32Array(q);
        this.preSin = new Float32Array(q);
        this.postCos = new Float32Array(q);
        this.postSin = new Float32Array(q);
        for (let k = 0; k < q; k++) {
            this.preCos[k] = Math.cos((-Math.PI * (k + 0.25)) / m);
            this.preSin[k] = Math.sin((-Math.PI * (k + 0.25)) / m);
            this.postCos[k] = Math.cos((-Math.PI * k) / m);
            this.postSin[k] = Math.sin((-Math.PI * k) / m);
        }
        const bits = Math.log2(q);
        this.reverse = new Uint16Array(q);
        for (let i = 0; i < q; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
            this.reverse[i] = r;
        }
        this.twiddleRe = new Float32Array(q >> 1);
        this.twiddleIm = new Float32Array(q >> 1);
        for (let k = 0; k < q >> 1; k++) {
            this.twiddleRe[k] = Math.cos((-2 * Math.PI * k) / q);
            this.twiddleIm[k] = Math.sin((-2 * Math.PI * k) / q);
        }
        this.re = new Float32Array(q);
        this.im = new Float32Array(q);
        this.dct = new Float32Array(m);
    }

    /** `input` holds n/2 coefficients; `output` receives n samples. */
    backward(input: Float32Array, output: Float32Array): void {
        const n = this.n;
        const m = n >> 1;
        const q = n >> 2;
        const { re, im, preCos, preSin, postCos, postSin, reverse, dct } = this;
        for (let r = 0; r < q; r++) {
            const a = input[2 * r]!;
            const b = input[m - 1 - 2 * r]!;
            const j = reverse[r]!;
            re[j] = a * preCos[r]! - b * preSin[r]!;
            im[j] = a * preSin[r]! + b * preCos[r]!;
        }
        this.fft();
        for (let k = 0; k < q; k++) {
            dct[2 * k] = re[k]! * postCos[k]! - im[k]! * postSin[k]!;
            dct[m - 1 - 2 * k] = -(re[k]! * postSin[k]! + im[k]! * postCos[k]!);
        }
        const half = m >> 1;
        for (let i = 0; i < half; i++) output[i] = dct[i + half]!;
        for (let i = half; i < m + half; i++) output[i] = -dct[m + half - 1 - i]!;
        for (let i = m + half; i < n; i++) output[i] = -dct[i - m - half]!;
    }

    private fft(): void {
        const { re, im, twiddleRe, twiddleIm } = this;
        const size = re.length;

        // The butterflies of a stage are independent: each twiddle factor serves all of its blocks
        // in turn.
        for (let half = 1; half < size; half <<= 1) {
            const step = size / (half << 1);
            const span = half << 1;
            for (let k = 0, t = 0; k < half; k++, t += step) {
                const wr = twiddleRe[t]!;
                const wi = twiddleIm[t]!;
                for (let a = k; a < size; a += span) {
                    const b = a + half;
                    const br = re[b]!;
                    const bi = im[b]!;
                    const ar = re[a]!;
                    const ai = im[a]!;
                    const xr = br * wr - bi * wi;
                    const xi = br * wi + bi * wr;
                    re[b] = ar - xr;
                    im[b] = ai - xi;
                    re[a] = ar + xr;
                    im[a] = ai + xi;
                }
            }
        }
    }
}
