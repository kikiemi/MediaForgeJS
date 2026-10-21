// Mixed-radix complex FFT and the MDCT of the CELT layer (RFC 6716 section 4.3.7), float
// arithmetic.

interface FftPlan {
    readonly nfft: number;
    /** (radix, remaining size) pairs, outermost stage first. */
    readonly factors: Int32Array;
    readonly bitrev: Int32Array;
    /** Interleaved (re, im) twiddles of the largest transform; smaller ones stride through them. */
    readonly twiddles: Float32Array;
    readonly shift: number;
}

function factor(n: number): Int32Array {
    const facbuf: number[] = [];
    let p = 4;
    let stages = 0;
    const nbak = n;
    do {
        while (n % p) {
            if (p === 4) p = 2;
            else if (p === 2) p = 3;
            else p += 2;
            if (p > 32000 || p * p > n) p = n;
        }
        n = Math.floor(n / p);
        facbuf[2 * stages] = p;
        if (p === 2 && stages > 1) {
            facbuf[2 * stages] = 4;
            facbuf[2] = 2;
        }
        stages++;
    } while (n > 1);
    n = nbak;
    for (let i = 0; i < stages >> 1; i++) {
        const tmp = facbuf[2 * i]!;
        facbuf[2 * i] = facbuf[2 * (stages - i - 1)]!;
        facbuf[2 * (stages - i - 1)] = tmp;
    }
    for (let i = 0; i < stages; i++) {
        n = Math.floor(n / facbuf[2 * i]!);
        facbuf[2 * i + 1] = n;
    }
    return Int32Array.from(facbuf);
}

function bitrevTable(
    out: Int32Array,
    fout: number,
    at: number,
    fstride: number,
    factors: Int32Array,
    index: number,
): void {
    const p = factors[index]!;
    const m = factors[index + 1]!;
    if (m === 1) {
        for (let j = 0; j < p; j++) {
            out[at] = fout + j;
            at += fstride;
        }
    } else {
        for (let j = 0; j < p; j++) {
            bitrevTable(out, fout, at, fstride * p, factors, index + 2);
            at += fstride;
            fout += m;
        }
    }
}

function fftPlan(nfft: number, base: FftPlan | null): FftPlan {
    let twiddles: Float32Array;
    let shift: number;
    if (base) {
        twiddles = base.twiddles;
        shift = 0;
        while (shift < 32 && nfft << shift !== base.nfft) shift++;
    } else {
        twiddles = new Float32Array(2 * nfft);
        for (let i = 0; i < nfft; i++) {
            const phase = (-2 * Math.PI * i) / nfft;
            twiddles[2 * i] = Math.cos(phase);
            twiddles[2 * i + 1] = Math.sin(phase);
        }
        shift = -1;
    }
    const factors = factor(nfft);
    const bitrev = new Int32Array(nfft);
    bitrevTable(bitrev, 0, 0, 1, factors, 0);
    return { nfft, factors, bitrev, twiddles, shift };
}

function bfly2(f: Float32Array, base: number, N: number): void {
    const tw = 0.7071067812;
    let at = base;
    for (let i = 0; i < N; i++) {
        let a = at;
        let b = at + 8;
        let tr = f[b]!;
        let ti = f[b + 1]!;
        f[b] = f[a]! - tr;
        f[b + 1] = f[a + 1]! - ti;
        f[a] += tr;
        f[a + 1] += ti;
        a += 2;
        b += 2;
        tr = (f[b]! + f[b + 1]!) * tw;
        ti = (f[b + 1]! - f[b]!) * tw;
        f[b] = f[a]! - tr;
        f[b + 1] = f[a + 1]! - ti;
        f[a] += tr;
        f[a + 1] += ti;
        a += 2;
        b += 2;
        tr = f[b + 1]!;
        ti = -f[b]!;
        f[b] = f[a]! - tr;
        f[b + 1] = f[a + 1]! - ti;
        f[a] += tr;
        f[a + 1] += ti;
        a += 2;
        b += 2;
        tr = (f[b + 1]! - f[b]!) * tw;
        ti = -(f[b + 1]! + f[b]!) * tw;
        f[b] = f[a]! - tr;
        f[b + 1] = f[a + 1]! - ti;
        f[a] += tr;
        f[a + 1] += ti;
        at += 16;
    }
}

function bfly4(
    f: Float32Array,
    base: number,
    fstride: number,
    plan: FftPlan,
    m: number,
    N: number,
    mm: number,
): void {
    if (m === 1) {
        let at = base;
        for (let i = 0; i < N; i++) {
            const s0r = f[at]! - f[at + 4]!;
            const s0i = f[at + 1]! - f[at + 5]!;
            f[at] += f[at + 4]!;
            f[at + 1] += f[at + 5]!;
            const s1r = f[at + 2]! + f[at + 6]!;
            const s1i = f[at + 3]! + f[at + 7]!;
            f[at + 4] = f[at]! - s1r;
            f[at + 5] = f[at + 1]! - s1i;
            f[at] += s1r;
            f[at + 1] += s1i;
            const d1r = f[at + 2]! - f[at + 6]!;
            const d1i = f[at + 3]! - f[at + 7]!;
            f[at + 2] = s0r + d1i;
            f[at + 3] = s0i - d1r;
            f[at + 6] = s0r - d1i;
            f[at + 7] = s0i + d1r;
            at += 8;
        }
        return;
    }
    const tw = plan.twiddles;
    const m2 = 2 * m;
    const m3 = 3 * m;
    for (let i = 0; i < N; i++) {
        let at = base + i * mm * 2;
        let t1 = 0;
        let t2 = 0;
        let t3 = 0;
        for (let j = 0; j < m; j++) {
            const a = at;
            const b = at + 2 * m;
            const c = at + 2 * m2;
            const d = at + 2 * m3;
            const s0r = f[b]! * tw[2 * t1]! - f[b + 1]! * tw[2 * t1 + 1]!;
            const s0i = f[b]! * tw[2 * t1 + 1]! + f[b + 1]! * tw[2 * t1]!;
            const s1r = f[c]! * tw[2 * t2]! - f[c + 1]! * tw[2 * t2 + 1]!;
            const s1i = f[c]! * tw[2 * t2 + 1]! + f[c + 1]! * tw[2 * t2]!;
            const s2r = f[d]! * tw[2 * t3]! - f[d + 1]! * tw[2 * t3 + 1]!;
            const s2i = f[d]! * tw[2 * t3 + 1]! + f[d + 1]! * tw[2 * t3]!;
            const s5r = f[a]! - s1r;
            const s5i = f[a + 1]! - s1i;
            f[a] += s1r;
            f[a + 1] += s1i;
            const s3r = s0r + s2r;
            const s3i = s0i + s2i;
            const s4r = s0r - s2r;
            const s4i = s0i - s2i;
            f[c] = f[a]! - s3r;
            f[c + 1] = f[a + 1]! - s3i;
            t1 += fstride;
            t2 += fstride * 2;
            t3 += fstride * 3;
            f[a] += s3r;
            f[a + 1] += s3i;
            f[b] = s5r + s4i;
            f[b + 1] = s5i - s4r;
            f[d] = s5r - s4i;
            f[d + 1] = s5i + s4r;
            at += 2;
        }
    }
}

function bfly3(
    f: Float32Array,
    base: number,
    fstride: number,
    plan: FftPlan,
    m: number,
    N: number,
    mm: number,
): void {
    const tw = plan.twiddles;
    const m2 = 2 * m;
    const epi3i = tw[2 * fstride * m + 1]!;
    for (let i = 0; i < N; i++) {
        let at = base + i * mm * 2;
        let t1 = 0;
        let t2 = 0;
        let k = m;
        do {
            const a = at;
            const b = at + 2 * m;
            const c = at + 2 * m2;
            const s1r = f[b]! * tw[2 * t1]! - f[b + 1]! * tw[2 * t1 + 1]!;
            const s1i = f[b]! * tw[2 * t1 + 1]! + f[b + 1]! * tw[2 * t1]!;
            const s2r = f[c]! * tw[2 * t2]! - f[c + 1]! * tw[2 * t2 + 1]!;
            const s2i = f[c]! * tw[2 * t2 + 1]! + f[c + 1]! * tw[2 * t2]!;
            const s3r = s1r + s2r;
            const s3i = s1i + s2i;
            const s0r = (s1r - s2r) * epi3i;
            const s0i = (s1i - s2i) * epi3i;
            t1 += fstride;
            t2 += fstride * 2;
            const br = f[a]! - s3r * 0.5;
            const bi = f[a + 1]! - s3i * 0.5;
            f[a] += s3r;
            f[a + 1] += s3i;
            f[c] = br + s0i;
            f[c + 1] = bi - s0r;
            f[b] = br - s0i;
            f[b + 1] = bi + s0r;
            at += 2;
        } while (--k);
    }
}

function bfly5(
    f: Float32Array,
    base: number,
    fstride: number,
    plan: FftPlan,
    m: number,
    N: number,
    mm: number,
): void {
    const tw = plan.twiddles;
    const yar = tw[2 * fstride * m]!;
    const yai = tw[2 * fstride * m + 1]!;
    const ybr = tw[2 * fstride * 2 * m]!;
    const ybi = tw[2 * fstride * 2 * m + 1]!;
    for (let i = 0; i < N; i++) {
        const group = base + i * mm * 2;
        for (let u = 0; u < m; u++) {
            const p0 = group + 2 * u;
            const p1 = p0 + 2 * m;
            const p2 = p0 + 4 * m;
            const p3 = p0 + 6 * m;
            const p4 = p0 + 8 * m;
            const s0r = f[p0]!;
            const s0i = f[p0 + 1]!;
            let t = 2 * u * fstride;
            const s1r = f[p1]! * tw[t]! - f[p1 + 1]! * tw[t + 1]!;
            const s1i = f[p1]! * tw[t + 1]! + f[p1 + 1]! * tw[t]!;
            t = 4 * u * fstride;
            const s2r = f[p2]! * tw[t]! - f[p2 + 1]! * tw[t + 1]!;
            const s2i = f[p2]! * tw[t + 1]! + f[p2 + 1]! * tw[t]!;
            t = 6 * u * fstride;
            const s3r = f[p3]! * tw[t]! - f[p3 + 1]! * tw[t + 1]!;
            const s3i = f[p3]! * tw[t + 1]! + f[p3 + 1]! * tw[t]!;
            t = 8 * u * fstride;
            const s4r = f[p4]! * tw[t]! - f[p4 + 1]! * tw[t + 1]!;
            const s4i = f[p4]! * tw[t + 1]! + f[p4 + 1]! * tw[t]!;
            const s7r = s1r + s4r;
            const s7i = s1i + s4i;
            const s10r = s1r - s4r;
            const s10i = s1i - s4i;
            const s8r = s2r + s3r;
            const s8i = s2i + s3i;
            const s9r = s2r - s3r;
            const s9i = s2i - s3i;
            f[p0] = s0r + s7r + s8r;
            f[p0 + 1] = s0i + s7i + s8i;
            const s5r = s0r + s7r * yar + s8r * ybr;
            const s5i = s0i + s7i * yar + s8i * ybr;
            const s6r = s10i * yai + s9i * ybi;
            const s6i = -(s10r * yai + s9r * ybi);
            f[p1] = s5r - s6r;
            f[p1 + 1] = s5i - s6i;
            f[p4] = s5r + s6r;
            f[p4 + 1] = s5i + s6i;
            const s11r = s0r + s7r * ybr + s8r * yar;
            const s11i = s0i + s7i * ybr + s8i * yar;
            const s12r = s9i * yai - s10i * ybi;
            const s12i = s10r * ybi - s9r * yai;
            f[p2] = s11r + s12r;
            f[p2 + 1] = s11i + s12i;
            f[p3] = s11r - s12r;
            f[p3 + 1] = s11i - s12i;
        }
    }
}

/** In-place FFT of bit-reversed interleaved complex input. */
function fftImpl(plan: FftPlan, f: Float32Array, base: number): void {
    const shift = plan.shift > 0 ? plan.shift : 0;
    const fstride = [1];
    let L = 0;
    let m: number;
    do {
        const p = plan.factors[2 * L]!;
        m = plan.factors[2 * L + 1]!;
        fstride[L + 1] = fstride[L]! * p;
        L++;
    } while (m !== 1);
    m = plan.factors[2 * L - 1]!;
    for (let i = L - 1; i >= 0; i--) {
        const m2 = i !== 0 ? plan.factors[2 * i - 1]! : 1;
        switch (plan.factors[2 * i]) {
            case 2:
                bfly2(f, base, fstride[i]!);
                break;
            case 4:
                bfly4(f, base, fstride[i]! << shift, plan, m, fstride[i]!, m2);
                break;
            case 3:
                bfly3(f, base, fstride[i]! << shift, plan, m, fstride[i]!, m2);
                break;
            case 5:
                bfly5(f, base, fstride[i]! << shift, plan, m, fstride[i]!, m2);
                break;
        }
        m = m2;
    }
}

/**
 * The 1920-point MDCT family (shift 0..3 halves the size each step) with its overlap-add window.
 */
export class CeltMdct {
    private readonly plans: FftPlan[] = [];
    private readonly trig: Float32Array;
    readonly n: number;

    constructor(n: number, maxShift: number) {
        this.n = n;
        let base: FftPlan | null = null;
        for (let i = 0; i <= maxShift; i++) {
            const plan = fftPlan((n >> 2) >> i, base);
            this.plans.push(plan);
            if (!base) base = plan;
        }
        this.trig = new Float32Array(n - ((n >> 1) >> maxShift));
        let offset = 0;
        let size = n;
        for (let shift = 0; shift <= maxShift; shift++) {
            const n2 = size >> 1;
            for (let i = 0; i < n2; i++)
                this.trig[offset + i] = Math.cos((2 * Math.PI * (i + 0.125)) / size);
            offset += n2;
            size >>= 1;
        }
    }

    /**
     * Inverse MDCT of `input[inOffset + stride * k]` into `out[outOffset..]` (N/2 + overlap
     * samples), overlap-added with the window at both ends as clt_mdct_backward does.
     */
    backward(
        input: Float32Array,
        inOffset: number,
        out: Float32Array,
        outOffset: number,
        window: Float32Array,
        overlap: number,
        shift: number,
        stride: number,
    ): void {
        let N = this.n;
        let trigOffset = 0;
        for (let i = 0; i < shift; i++) {
            N >>= 1;
            trigOffset += N;
        }
        const N2 = N >> 1;
        const N4 = N >> 2;
        const trig = this.trig;
        const plan = this.plans[shift]!;
        const bitrev = plan.bitrev;
        const yp = outOffset + (overlap >> 1);
        {
            let xp1 = inOffset;
            let xp2 = inOffset + stride * (N2 - 1);
            for (let i = 0; i < N4; i++) {
                const rev = bitrev[i]!;
                const t0 = trig[trigOffset + i]!;
                const t1 = trig[trigOffset + N4 + i]!;
                out[yp + 2 * rev + 1] = input[xp2]! * t0 + input[xp1]! * t1;
                out[yp + 2 * rev] = input[xp1]! * t0 - input[xp2]! * t1;
                xp1 += 2 * stride;
                xp2 -= 2 * stride;
            }
        }
        fftImpl(plan, out, yp);
        {
            let yp0 = yp;
            let yp1 = yp + N2 - 2;
            for (let i = 0; i < (N4 + 1) >> 1; i++) {
                let re = out[yp0 + 1]!;
                let im = out[yp0]!;
                let t0 = trig[trigOffset + i]!;
                let t1 = trig[trigOffset + N4 + i]!;
                const yr = re * t0 + im * t1;
                const yi = re * t1 - im * t0;
                re = out[yp1 + 1]!;
                im = out[yp1]!;
                out[yp0] = yr;
                out[yp1 + 1] = yi;
                t0 = trig[trigOffset + N4 - i - 1]!;
                t1 = trig[trigOffset + N2 - i - 1]!;
                out[yp1] = re * t0 + im * t1;
                out[yp0 + 1] = re * t1 - im * t0;
                yp0 += 2;
                yp1 -= 2;
            }
        }
        {
            let xp1 = outOffset + overlap - 1;
            let yp1 = outOffset;
            let wp1 = 0;
            let wp2 = overlap - 1;
            for (let i = 0; i < overlap >> 1; i++) {
                const x1 = out[xp1]!;
                const x2 = out[yp1]!;
                out[yp1++] = window[wp2]! * x2 - window[wp1]! * x1;
                out[xp1--] = window[wp1]! * x2 + window[wp2]! * x1;
                wp1++;
                wp2--;
            }
        }
    }
}
