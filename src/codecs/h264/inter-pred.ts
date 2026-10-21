import { type KernelMemory, SCRATCH_EDGE } from './kernels';

const EDGE_STRIDE = 24;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const BLOCK_STRIDE = 16;

/** One reference sample array: a frame, or one field of a frame addressed with a doubled stride. */
export interface RefPlane {
    data: Uint8Array;
    /** `data` as 32-bit words. */
    words: Uint32Array;
    /** Address of `data` in the kernel memory holding it. */
    base: number;
    offset: number;
    stride: number;
    width: number;
    height: number;
}

/**
 * Six-tap intermediate values (8.4.2.2.1 b1, h1) of up to 21 x 21 positions; they fit in 16 bits.
 */
const mid = new Int16Array(EDGE_STRIDE * 21);

/**
 * Fractional-sample interpolation (8.4.2.2) into blocks of 8-bit samples. Positions outside the
 * reference are clamped to its edge samples through an emulated-edge copy.
 */
export class MotionCompensator {
    private readonly edge = new Uint8Array(EDGE_STRIDE * 22);
    private arena: KernelMemory | null = null;
    /** Address of the emulated-edge block in the scratch of `arena`. */
    private edgeAddress = 0;

    /**
     * Predicts with the WebAssembly kernels of `memory`, which then holds the references and
     * outputs, or with the JavaScript kernels when null.
     */
    useKernels(memory: KernelMemory | null): void {
        this.arena = memory;
        this.edgeAddress = memory ? memory.scratch + SCRATCH_EDGE : 0;
    }

    /**
     * Luma prediction of a `w` x `h` block whose integer position is (`x`, `y`) with quarter-sample
     * fractions `fx`, `fy`, written to `out[outOffset]` with row stride `outStride`; `outWords` is
     * `out` as 32-bit words.
     */
    luma(
        ref: RefPlane,
        x: number,
        y: number,
        fx: number,
        fy: number,
        w: number,
        h: number,
        out: Uint8Array,
        outWords: Uint32Array,
        outOffset: number,
        outStride: number,
    ): void {
        let src = ref.data;
        let stride = ref.stride;
        let p: number;
        const left = fx ? 2 : 0;
        const top = fy ? 2 : 0;
        const outside =
            x < left ||
            y < top ||
            x + w + (fx ? 3 : 0) > ref.width ||
            y + h + (fy ? 3 : 0) > ref.height;
        const arena = this.arena;
        if (arena !== null) {
            let address = ref.base + ref.offset + y * stride + x;
            if (outside) {
                const bytes = arena.bytes;
                emulate(
                    bytes,
                    ref.base + ref.offset,
                    ref,
                    x - 2,
                    y - 2,
                    w + 5,
                    h + 5,
                    bytes,
                    this.edgeAddress,
                );
                address = this.edgeAddress + 2 * EDGE_STRIDE + 2;
                stride = EDGE_STRIDE;
            }
            arena.kernels.mc_luma(
                address,
                stride,
                out.byteOffset + outOffset,
                outStride,
                w,
                h,
                fx | (fy << 2),
            );
            return;
        }
        if (outside) {
            emulate(ref.data, ref.offset, ref, x - 2, y - 2, w + 5, h + 5, this.edge, 0);
            src = this.edge;
            stride = EDGE_STRIDE;
            p = 2 * EDGE_STRIDE + 2;
        } else p = ref.offset + y * stride + x;
        const o = outOffset;
        const os = outStride;
        switch (fx | (fy << 2)) {
            case 0:
                copyBlock(src, ref.words, p, stride, out, outWords, o, os, w, h, src === ref.data);
                return;
            case 1:
                horizontalAverage(src, p, stride, w, h, out, o, os, 0);
                return;
            case 2:
                horizontal(src, p, stride, w, h, out, o, os);
                return;
            case 3:
                horizontalAverage(src, p, stride, w, h, out, o, os, 1);
                return;
            case 4:
                verticalAverage(src, p, stride, w, h, out, o, os, 0);
                return;
            case 8:
                vertical(src, p, stride, w, h, out, o, os);
                return;
            case 12:
                verticalAverage(src, p, stride, w, h, out, o, os, stride);
                return;
            case 10:
                centre(src, p, stride, w, h, out, o, os);
                return;
            case 6:
                centreAverageRow(src, p, stride, w, h, out, o, os, 0);
                return;
            case 14:
                centreAverageRow(src, p, stride, w, h, out, o, os, 1);
                return;
            case 9:
                centreAverageColumn(src, p, stride, w, h, out, o, os, 0);
                return;
            case 11:
                centreAverageColumn(src, p, stride, w, h, out, o, os, 1);
                return;
            default:
                horizontal(src, p + (fy === 3 ? stride : 0), stride, w, h, out, o, os);
                verticalOnto(src, p + (fx === 3 ? 1 : 0), stride, w, h, out, o, os);
        }
    }

    /**
     * Chroma prediction (8.4.2.2.2) of a `w` x `h` block at integer position (`x`, `y`) with
     * eighth-sample fractions in both chroma planes: Cb from `cb`, Cr from the same position
     * `crShift` samples further in the same array. Cb lands at `out[cbOffset]`, Cr at
     * `out[crOffset]`, rows `outStride` apart; `outWords` is `out` as words.
     */
    chroma(
        cb: RefPlane,
        crShift: number,
        x: number,
        y: number,
        fx: number,
        fy: number,
        w: number,
        h: number,
        out: Uint8Array,
        outWords: Uint32Array,
        cbOffset: number,
        crOffset: number,
        outStride: number,
    ): void {
        const outside = x < 0 || y < 0 || x + w + 1 > cb.width || y + h + 1 > cb.height;
        const arena = this.arena;
        if (arena !== null) {
            const kernels = arena.kernels;
            const cbAddress = out.byteOffset + cbOffset;
            const crAddress = out.byteOffset + crOffset;
            if (outside) {
                const origin = cb.base + cb.offset;
                const bytes = arena.bytes;
                const edge = this.edgeAddress;
                emulate(bytes, origin, cb, x, y, w + 1, h + 1, bytes, edge);
                kernels.mc_chroma(edge, EDGE_STRIDE, cbAddress, outStride, w, h, fx, fy);
                emulate(bytes, origin + crShift, cb, x, y, w + 1, h + 1, bytes, edge);
                kernels.mc_chroma(edge, EDGE_STRIDE, crAddress, outStride, w, h, fx, fy);
                return;
            }
            const p = cb.base + cb.offset + y * cb.stride + x;
            kernels.mc_chroma(p, cb.stride, cbAddress, outStride, w, h, fx, fy);
            kernels.mc_chroma(p + crShift, cb.stride, crAddress, outStride, w, h, fx, fy);
            return;
        }
        if (outside) {
            const edge = this.edge;
            emulate(cb.data, cb.offset, cb, x, y, w + 1, h + 1, edge, 0);
            bilinear(edge, 0, EDGE_STRIDE, fx, fy, w, h, out, cbOffset, outStride);
            emulate(cb.data, cb.offset + crShift, cb, x, y, w + 1, h + 1, edge, 0);
            bilinear(edge, 0, EDGE_STRIDE, fx, fy, w, h, out, crOffset, outStride);
            return;
        }
        const src = cb.data;
        const stride = cb.stride;
        const p = cb.offset + y * stride + x;
        if ((fx | fy) === 0) {
            copyBlock(src, cb.words, p, stride, out, outWords, cbOffset, outStride, w, h, true);
            copyBlock(
                src,
                cb.words,
                p + crShift,
                stride,
                out,
                outWords,
                crOffset,
                outStride,
                w,
                h,
                true,
            );
            return;
        }
        const words = cb.words;
        if (
            LITTLE_ENDIAN &&
            ((cbOffset | crOffset | outStride | w | stride) & 3) === 0 &&
            ((p + crShift + h * stride) >> 2) + (w >> 2) + 1 < words.length
        ) {
            bilinearWords(words, p, stride, fx, fy, w, h, outWords, cbOffset, outStride);
            bilinearWords(words, p + crShift, stride, fx, fy, w, h, outWords, crOffset, outStride);
            return;
        }
        bilinear(src, p, stride, fx, fy, w, h, out, cbOffset, outStride);
        bilinear(src, p + crShift, stride, fx, fy, w, h, out, crOffset, outStride);
    }

    /**
     * Bi-prediction (8.4.2.3) of two full-sample blocks read straight from the references: the `w`
     * x `h` blocks at (`xa`, `ya`) of `a` and (`xb`, `yb`) of `b`, each position `shift` samples
     * further, weighted by `w0` and `w1` with the rounding shift `logWD` + 1 and `offset`, into
     * `out[outOffset]`; weights of 1 << logWD and no offset are the default average. Returns false,
     * writing nothing, when a block leaves its reference.
     */
    blendFullSamples(
        a: RefPlane,
        xa: number,
        ya: number,
        b: RefPlane,
        xb: number,
        yb: number,
        shift: number,
        w: number,
        h: number,
        out: Uint8Array,
        outWords: Uint32Array,
        outOffset: number,
        outStride: number,
        w0: number,
        w1: number,
        offset: number,
        logWD: number,
    ): boolean {
        if (xa < 0 || ya < 0 || xa + w > a.width || ya + h > a.height) return false;
        if (xb < 0 || yb < 0 || xb + w > b.width || yb + h > b.height) return false;
        const arena = this.arena;
        if (arena !== null) {
            const sa = a.base + a.offset + shift + ya * a.stride + xa;
            const sb = b.base + b.offset + shift + yb * b.stride + xb;
            const d = out.byteOffset + outOffset;
            if (w0 === w1 && w0 === 1 << logWD && offset === 0)
                arena.kernels.avg(sa, a.stride, sb, b.stride, d, outStride, w, h);
            else
                arena.kernels.weight2(
                    sa,
                    a.stride,
                    sb,
                    b.stride,
                    d,
                    outStride,
                    w,
                    h,
                    w0,
                    w1,
                    offset,
                    logWD,
                );
            return true;
        }
        const pa = a.offset + shift + ya * a.stride + xa;
        const pb = b.offset + shift + yb * b.stride + xb;
        const as = a.stride;
        const bs = b.stride;
        const ad = a.data;
        const bd = b.data;
        let o = outOffset;
        const round = 1 << logWD;
        const rshift = logWD + 1;
        const plain = w0 === w1 && w0 === round && offset === 0;
        if (
            LITTLE_ENDIAN &&
            blendsInLanes(w0, w1, offset, logWD) &&
            ((o | outStride | w | as | bs) & 3) === 0
        ) {
            const aw = a.words;
            const bw = b.words;
            const n = w >> 2;
            const sa = (pa & 3) * 8;
            const sb = (pb & 3) * 8;
            const round2 = round * 0x10001;
            for (
                let r = 0, ia = pa >> 2, ib = pb >> 2;
                r < h;
                r++, ia += as >> 2, ib += bs >> 2, o += outStride
            ) {
                const d = o >> 2;
                for (let c = 0; c < n; c++) {
                    const x =
                        sa === 0 ? aw[ia + c] : (aw[ia + c] >>> sa) | (aw[ia + c + 1] << (32 - sa));
                    const y =
                        sb === 0 ? bw[ib + c] : (bw[ib + c] >>> sb) | (bw[ib + c + 1] << (32 - sb));
                    if (plain) outWords[d + c] = ((x | y) - (((x ^ y) & 0xfefefefe) >>> 1)) | 0;
                    else {
                        const even =
                            (Math.imul(x & 0xff00ff, w0) + Math.imul(y & 0xff00ff, w1) + round2) |
                            0;
                        const odd =
                            (Math.imul((x >>> 8) & 0xff00ff, w0) +
                                Math.imul((y >>> 8) & 0xff00ff, w1) +
                                round2) |
                            0;
                        outWords[d + c] =
                            ((even >>> rshift) & 0xff00ff) | (((odd >>> rshift) & 0xff00ff) << 8);
                    }
                }
            }
            return true;
        }
        for (let r = 0, ra = pa, rb = pb; r < h; r++, ra += as, rb += bs, o += outStride) {
            for (let c = 0; c < w; c++) {
                const v = ((ad[ra + c] * w0 + bd[rb + c] * w1 + round) >> rshift) + offset;
                out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
        }
        return true;
    }
}

/**
 * Copies the `w` x `h` area at (`x`, `y`) of the plane whose origin is `src[origin]`, with the size
 * and stride of `ref`, to `edge[edgeOffset]` with rows EDGE_STRIDE apart, clamping the coordinates
 * into the plane.
 */
function emulate(
    src: Uint8Array,
    origin: number,
    ref: RefPlane,
    x: number,
    y: number,
    w: number,
    h: number,
    edge: Uint8Array,
    edgeOffset: number,
): void {
    const maxX = ref.width - 1;
    const maxY = ref.height - 1;
    for (let r = 0; r < h; r++) {
        let sy = y + r;
        sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
        const row = origin + sy * ref.stride;
        const d = edgeOffset + r * EDGE_STRIDE;
        for (let c = 0; c < w; c++) {
            let sx = x + c;
            sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
            edge[d + c] = src[row + sx];
        }
    }
}

/** Half sample b (8.4.2.2.1) of each position of a block from the samples around `p`. */
function horizontal(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
): void {
    for (let r = 0; r < h; r++, p += stride, o += os) {
        const s = p - 2;
        let a = src[s];
        let b = src[s + 1];
        let c = src[s + 2];
        let e = src[s + 3];
        let f = src[s + 4];
        for (let i = 0; i < w; i++) {
            const g = src[s + i + 5];
            const v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
            out[o + i] = v < 0 ? 0 : v > 255 ? 255 : v;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/**
 * Quarter samples a (`right` 0) or c (`right` 1): the average of b with the full sample on its left
 * or right.
 */
function horizontalAverage(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
    right: number,
): void {
    for (let r = 0; r < h; r++, p += stride, o += os) {
        const s = p - 2;
        let a = src[s];
        let b = src[s + 1];
        let c = src[s + 2];
        let e = src[s + 3];
        let f = src[s + 4];
        if (right) {
            for (let i = 0; i < w; i++) {
                const g = src[s + i + 5];
                let v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
                v = v < 0 ? 0 : v > 255 ? 255 : v;
                out[o + i] = (v + e + 1) >> 1;
                a = b;
                b = c;
                c = e;
                e = f;
                f = g;
            }
        } else {
            for (let i = 0; i < w; i++) {
                const g = src[s + i + 5];
                let v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
                v = v < 0 ? 0 : v > 255 ? 255 : v;
                out[o + i] = (v + c + 1) >> 1;
                a = b;
                b = c;
                c = e;
                e = f;
                f = g;
            }
        }
    }
}

/** Half sample h of each position of a block. */
function vertical(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
): void {
    for (let i = 0; i < w; i++) {
        let s = p + i - 2 * stride;
        let d = o + i;
        let a = src[s];
        let b = src[s + stride];
        let c = src[s + 2 * stride];
        let e = src[s + 3 * stride];
        let f = src[s + 4 * stride];
        s += 5 * stride;
        for (let r = 0; r < h; r++, s += stride, d += os) {
            const g = src[s];
            const v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
            out[d] = v < 0 ? 0 : v > 255 ? 255 : v;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/**
 * Quarter samples d (`below` 0) or n (`below` stride): the average of h with the full sample above
 * or below it.
 */
function verticalAverage(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
    below: number,
): void {
    for (let i = 0; i < w; i++) {
        let s = p + i - 2 * stride;
        let d = o + i;
        let a = src[s];
        let b = src[s + stride];
        let c = src[s + 2 * stride];
        let e = src[s + 3 * stride];
        let f = src[s + 4 * stride];
        s += 5 * stride;
        for (let r = 0; r < h; r++, s += stride, d += os) {
            const g = src[s];
            let v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            out[d] = (v + (below ? e : c) + 1) >> 1;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/** Averages h at column `p` into the block already in `out` (quarter samples e, g, p and r). */
function verticalOnto(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
): void {
    for (let i = 0; i < w; i++) {
        let s = p + i - 2 * stride;
        let d = o + i;
        let a = src[s];
        let b = src[s + stride];
        let c = src[s + 2 * stride];
        let e = src[s + 3 * stride];
        let f = src[s + 4 * stride];
        s += 5 * stride;
        for (let r = 0; r < h; r++, s += stride, d += os) {
            const g = src[s];
            let v = (a + g - 5 * (b + f) + 20 * (c + e) + 16) >> 5;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            out[d] = (out[d] + v + 1) >> 1;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/** Horizontal intermediates b1 of rows -2..h+2 into `mid` (rows `w` apart). */
function horizontalRows(src: Uint8Array, p: number, stride: number, w: number, h: number): void {
    let m = 0;
    for (let r = 0, s = p - 2 * stride - 2; r < h + 5; r++, s += stride) {
        let a = src[s];
        let b = src[s + 1];
        let c = src[s + 2];
        let e = src[s + 3];
        let f = src[s + 4];
        for (let i = 0; i < w; i++) {
            const g = src[s + i + 5];
            mid[m++] = a + g - 5 * (b + f) + 20 * (c + e);
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/** Centre half sample j from the horizontal intermediates. */
function centre(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
): void {
    horizontalRows(src, p, stride, w, h);
    for (let i = 0; i < w; i++) {
        let m = i;
        let d = o + i;
        let a = mid[m];
        let b = mid[m + w];
        let c = mid[m + 2 * w];
        let e = mid[m + 3 * w];
        let f = mid[m + 4 * w];
        m += 5 * w;
        for (let r = 0; r < h; r++, m += w, d += os) {
            const g = mid[m];
            const v = (a + g - 5 * (b + f) + 20 * (c + e) + 512) >> 10;
            out[d] = v < 0 ? 0 : v > 255 ? 255 : v;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/**
 * Quarter samples f (`below` 0) or q (`below` 1): j averaged with b of the row above or below it.
 */
function centreAverageRow(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
    below: number,
): void {
    horizontalRows(src, p, stride, w, h);
    for (let i = 0; i < w; i++) {
        let m = i;
        let d = o + i;
        let a = mid[m];
        let b = mid[m + w];
        let c = mid[m + 2 * w];
        let e = mid[m + 3 * w];
        let f = mid[m + 4 * w];
        m += 5 * w;
        for (let r = 0; r < h; r++, m += w, d += os) {
            const g = mid[m];
            let v = (a + g - 5 * (b + f) + 20 * (c + e) + 512) >> 10;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            let half = ((below ? e : c) + 16) >> 5;
            half = half < 0 ? 0 : half > 255 ? 255 : half;
            out[d] = (v + half + 1) >> 1;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/**
 * Quarter samples i (`right` 0) or k (`right` 1): j averaged with h of the column left or right of
 * it, from the vertical intermediates h1 of columns -2..w+2.
 */
function centreAverageColumn(
    src: Uint8Array,
    p: number,
    stride: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
    right: number,
): void {
    const cols = w + 5;
    for (let i = 0; i < cols; i++) {
        let s = p + i - 2 - 2 * stride;
        let m = i;
        let a = src[s];
        let b = src[s + stride];
        let c = src[s + 2 * stride];
        let e = src[s + 3 * stride];
        let f = src[s + 4 * stride];
        s += 5 * stride;
        for (let r = 0; r < h; r++, s += stride, m += cols) {
            const g = src[s];
            mid[m] = a + g - 5 * (b + f) + 20 * (c + e);
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
    for (let r = 0, m = 0; r < h; r++, m += cols, o += os) {
        let a = mid[m];
        let b = mid[m + 1];
        let c = mid[m + 2];
        let e = mid[m + 3];
        let f = mid[m + 4];
        for (let i = 0; i < w; i++) {
            const g = mid[m + i + 5];
            let v = (a + g - 5 * (b + f) + 20 * (c + e) + 512) >> 10;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            let half = ((right ? e : c) + 16) >> 5;
            half = half < 0 ? 0 : half > 255 ? 255 : half;
            out[o + i] = (v + half + 1) >> 1;
            a = b;
            b = c;
            c = e;
            e = f;
            f = g;
        }
    }
}

/**
 * Chroma sample interpolation (8-266) with at least one fraction nonzero: each row is first
 * weighted horizontally, then pairs of rows vertically, which gives the same integers as the
 * four-weight form.
 */
function bilinear(
    src: Uint8Array,
    p: number,
    stride: number,
    fx: number,
    fy: number,
    w: number,
    h: number,
    out: Uint8Array,
    o: number,
    os: number,
): void {
    const gx = 8 - fx;
    if (fy === 0) {
        for (let r = 0; r < h; r++, p += stride, o += os) {
            let left = src[p];
            for (let c = 0; c < w; c++) {
                const right = src[p + c + 1];
                out[o + c] = (gx * left + fx * right + 4) >> 3;
                left = right;
            }
        }
        return;
    }
    const gy = 8 - fy;
    if (fx === 0) {
        for (let c = 0; c < w; c++) {
            let s = p + c;
            let d = o + c;
            let above = src[s];
            for (let r = 0; r < h; r++, d += os) {
                s += stride;
                const below = src[s];
                out[d] = (gy * above + fy * below + 4) >> 3;
                above = below;
            }
        }
        return;
    }
    for (let c = 0; c < w; c++) {
        let s = p + c;
        let d = o + c;
        let above = gx * src[s] + fx * src[s + 1];
        for (let r = 0; r < h; r++, d += os) {
            s += stride;
            const below = gx * src[s] + fx * src[s + 1];
            out[d] = (gy * above + fy * below + 32) >> 6;
            above = below;
        }
    }
}

/**
 * Horizontal chroma intermediates of the previous row, even and odd samples of each word in 16-bit
 * lanes.
 */
const laneEven = new Int32Array(4);
const laneOdd = new Int32Array(4);

/**
 * `bilinear` on four samples per word (little-endian): even and odd samples of a word are weighted
 * in two 16-bit lanes each; every intermediate is non-negative and below 2^14, so the integers are
 * the same. Byte `p` of the plane behind `src` starts the block; `o`, `os`, `w` and `stride` must
 * be multiples of 4 and the words through ((p + h * stride) >> 2) + w / 4 + 1 must exist.
 */
function bilinearWords(
    src: Uint32Array,
    p: number,
    stride: number,
    fx: number,
    fy: number,
    w: number,
    h: number,
    out: Uint32Array,
    o: number,
    os: number,
): void {
    const gx = 8 - fx;
    const gy = 8 - fy;
    const n = w >> 2;
    const sa = (p & 3) * 8;
    const back = 32 - sa;
    const round = 32 * 0x10001;
    const rowWords = stride >> 2;
    let i = p >> 2;
    for (let r = 0; r <= h; r++, i += rowWords) {
        let word = sa === 0 ? src[i] : (src[i] >>> sa) | (src[i + 1] << back);
        const d = (o >> 2) + (r - 1) * (os >> 2);
        for (let c = 0; c < n; c++) {
            const a1 = src[i + c + 1];
            const next = sa === 0 ? a1 : (a1 >>> sa) | (src[i + c + 2] << back);
            const right = (word >>> 8) | (next << 24);
            const even = (Math.imul(word & 0xff00ff, gx) + Math.imul(right & 0xff00ff, fx)) | 0;
            const odd =
                (Math.imul((word >>> 8) & 0xff00ff, gx) + Math.imul((right >>> 8) & 0xff00ff, fx)) |
                0;
            if (r > 0) {
                const e = (Math.imul(laneEven[c], gy) + Math.imul(even, fy) + round) >>> 6;
                const f = (Math.imul(laneOdd[c], gy) + Math.imul(odd, fy) + round) >>> 6;
                out[d + c] = (e & 0xff00ff) | ((f & 0xff00ff) << 8);
            }
            laneEven[c] = even;
            laneOdd[c] = odd;
            word = next;
        }
    }
}

/**
 * Copies a block; whole words at a time when `aligned` holds (`src` is the array behind `srcWords`)
 * and the destination offset, both strides and the width are multiples of 4.
 */
function copyBlock(
    src: Uint8Array,
    srcWords: Uint32Array,
    p: number,
    stride: number,
    out: Uint8Array,
    outWords: Uint32Array,
    o: number,
    outStride: number,
    w: number,
    h: number,
    aligned: boolean,
): void {
    if (aligned && ((stride | o | outStride | w) & 3) === 0) {
        const n = w >> 2;
        const shift = (p & 3) * 8;
        if (shift === 0) {
            for (let r = 0; r < h; r++) {
                const s = (p + r * stride) >> 2;
                const d = (o + r * outStride) >> 2;
                for (let c = 0; c < n; c++) outWords[d + c] = srcWords[s + c];
            }
            return;
        }
        if (LITTLE_ENDIAN) {
            const back = 32 - shift;
            for (let r = 0; r < h; r++) {
                const s = (p + r * stride) >> 2;
                const d = (o + r * outStride) >> 2;
                let word = srcWords[s];
                for (let c = 0; c < n; c++) {
                    const next = srcWords[s + c + 1];
                    outWords[d + c] = (word >>> shift) | (next << back);
                    word = next;
                }
            }
            return;
        }
    }
    for (let r = 0; r < h; r++) {
        const s = p + r * stride;
        const d = o + r * outStride;
        for (let c = 0; c < w; c++) out[d + c] = src[s + c];
    }
}

/** Default bi-prediction average (8.4.2.3.1) of two 16-stride blocks into the picture plane. */
export function putAverage(
    a: Uint8Array,
    b: Uint8Array,
    s: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    w: number,
    h: number,
): void {
    for (let r = 0; r < h; r++, s += BLOCK_STRIDE, o += stride) {
        for (let c = 0; c < w; c++) dst[o + c] = (a[s + c] + b[s + c] + 1) >> 1;
    }
}

/**
 * Whether bi-prediction weights allow `putBlendWords`: no offset and non-negative weights summing
 * to at most 2 << logWD, which never leave 0..255 and keep each of two 16-bit lanes below 2^16.
 */
export function blendsInLanes(w0: number, w1: number, offset: number, logWD: number): boolean {
    return w0 >= 0 && w1 >= 0 && offset === 0 && w0 + w1 <= 2 << logWD && logWD <= 7;
}

/**
 * Bi-prediction of two 16-stride blocks on four samples per word, for weights that `blendsInLanes`
 * accepts (the default average included); `s`, `o`, `stride` and `w` count 32-bit words, so the
 * offsets, stride and width must be multiples of 4 samples.
 */
export function putBlendWords(
    a: Uint32Array,
    b: Uint32Array,
    s: number,
    dst: Uint32Array,
    o: number,
    stride: number,
    w: number,
    h: number,
    w0: number,
    w1: number,
    logWD: number,
): void {
    if (w0 === w1 && w0 === 1 << logWD) {
        for (let r = 0; r < h; r++, s += BLOCK_STRIDE >> 2, o += stride) {
            for (let c = 0; c < w; c++) {
                const x = a[s + c];
                const y = b[s + c];
                dst[o + c] = ((x | y) - (((x ^ y) & 0xfefefefe) >>> 1)) | 0;
            }
        }
        return;
    }
    const round2 = (1 << logWD) * 0x10001;
    const rshift = logWD + 1;
    for (let r = 0; r < h; r++, s += BLOCK_STRIDE >> 2, o += stride) {
        for (let c = 0; c < w; c++) {
            const x = a[s + c];
            const y = b[s + c];
            const even = (Math.imul(x & 0xff00ff, w0) + Math.imul(y & 0xff00ff, w1) + round2) | 0;
            const odd =
                (Math.imul((x >>> 8) & 0xff00ff, w0) +
                    Math.imul((y >>> 8) & 0xff00ff, w1) +
                    round2) |
                0;
            dst[o + c] = ((even >>> rshift) & 0xff00ff) | (((odd >>> rshift) & 0xff00ff) << 8);
        }
    }
}

/** Explicit weighted prediction of one block (8.4.2.3.2, single list). */
export function putWeighted(
    src: Uint8Array,
    s: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    w: number,
    h: number,
    weight: number,
    offset: number,
    logWD: number,
): void {
    const round = logWD >= 1 ? 1 << (logWD - 1) : 0;
    for (let r = 0; r < h; r++, s += BLOCK_STRIDE, o += stride) {
        for (let c = 0; c < w; c++) {
            const v = ((src[s + c] * weight + round) >> logWD) + offset;
            dst[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
}

/** Weighted bi-prediction (8.4.2.3.2) of two blocks; `offset` is (o0 + o1 + 1) >> 1. */
export function putBiWeighted(
    a: Uint8Array,
    b: Uint8Array,
    s: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    w: number,
    h: number,
    w0: number,
    w1: number,
    offset: number,
    logWD: number,
): void {
    const round = 1 << logWD;
    const shift = logWD + 1;
    for (let r = 0; r < h; r++, s += BLOCK_STRIDE, o += stride) {
        for (let c = 0; c < w; c++) {
            const v = ((a[s + c] * w0 + b[s + c] * w1 + round) >> shift) + offset;
            dst[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
}
