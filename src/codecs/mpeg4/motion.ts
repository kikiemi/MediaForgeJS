/**
 * Store modes: overwrite with rounding, overwrite with rounding_type 1, or average into the
 * destination.
 */
export const PUT = 0;
export const PUT_NO_RND = 1;
export const AVG = 2;

function clampSample(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Motion compensation primitives on 8-bit planes. Samples outside the reference are the nearest
 * edge sample of the `edgeWidth` x `edgeHeight` area, as unrestricted motion vectors require
 * (ISO/IEC 14496-2 7.6.4).
 */
export class MotionCompensation {
    /** Location of the block prepared by the last `fetch`. */
    src: Uint8Array;
    srcOff = 0;
    srcStride = 0;
    private readonly emu = new Uint8Array(24 * 40);
    private readonly halfH = new Uint8Array(17 * 16);
    private readonly halfV = new Uint8Array(16 * 16);
    private readonly halfHV = new Uint8Array(16 * 16);
    private readonly pred = new Uint8Array(16 * 16);
    private readonly taps = new Int32Array(24);

    constructor() {
        this.src = this.emu;
    }

    /**
     * Prepares a `width` x `rows` source block whose top-left sample is at (x, y) of the plane
     * starting at `base`, taking rows `rowStep` apart; reads outside the edge area are clamped to
     * it. `copy` forces a private copy.
     */
    fetch(
        plane: Uint8Array,
        base: number,
        stride: number,
        edgeWidth: number,
        edgeHeight: number,
        x: number,
        y: number,
        width: number,
        rows: number,
        rowStep: number,
        copy = false,
    ): void {
        const lastRow = y + (rows - 1) * rowStep;
        if (!copy && x >= 0 && y >= 0 && x + width <= edgeWidth && lastRow < edgeHeight) {
            this.src = plane;
            this.srcOff = base + y * stride + x;
            this.srcStride = stride * rowStep;
            return;
        }
        for (let r = 0; r < rows; r++)
            this.copyRow(r, plane, base, stride, edgeWidth, edgeHeight, x, y + r * rowStep, width);
        this.src = this.emu;
        this.srcOff = 0;
        this.srcStride = width;
    }

    /**
     * Fills row `row` of the private block with the clamped samples (x .. x+width-1, y) of a plane.
     */
    copyRow(
        row: number,
        plane: Uint8Array,
        base: number,
        stride: number,
        edgeWidth: number,
        edgeHeight: number,
        x: number,
        y: number,
        width: number,
    ): void {
        const emu = this.emu;
        const lastColumn = edgeWidth - 1;
        const rowOff = base + (y < 0 ? 0 : y >= edgeHeight ? edgeHeight - 1 : y) * stride;
        const out = row * width;
        for (let c = 0; c < width; c++) {
            const sx = x + c;
            emu[out + c] = plane[rowOff + (sx < 0 ? 0 : sx > lastColumn ? lastColumn : sx)];
        }
    }

    /**
     * Half-sample interpolation of a `width` x `height` block; `dxy` bit 0 is horizontal, bit 1
     * vertical.
     */
    halfSample(
        dst: Uint8Array,
        dOff: number,
        dStride: number,
        src: Uint8Array,
        sOff: number,
        sStride: number,
        width: number,
        height: number,
        dxy: number,
        mode: number,
    ): void {
        const noRound = mode === PUT_NO_RND ? 1 : 0;
        const average = mode === AVG;
        for (let y = 0; y < height; y++) {
            const s = sOff + y * sStride;
            const d = dOff + y * dStride;
            for (let x = 0; x < width; x++) {
                let v: number;
                if (dxy === 0) v = src[s + x];
                else if (dxy === 1) v = (src[s + x] + src[s + x + 1] + 1 - noRound) >> 1;
                else if (dxy === 2) v = (src[s + x] + src[s + x + sStride] + 1 - noRound) >> 1;
                else
                    v =
                        (src[s + x] +
                            src[s + x + 1] +
                            src[s + x + sStride] +
                            src[s + x + sStride + 1] +
                            2 -
                            noRound) >>
                        2;
                dst[d + x] = average ? (dst[d + x] + v + 1) >> 1 : v;
            }
        }
    }

    /**
     * 8-tap half-sample filter along rows with mirroring at the n+1 sample block edge (ISO/IEC
     * 14496-2 7.6.2.2).
     */
    private lowpassH(
        out: Uint8Array,
        outStride: number,
        src: Uint8Array,
        sOff: number,
        sStride: number,
        n: number,
        rows: number,
        rounder: number,
    ): void {
        const t = this.taps;
        for (let r = 0; r < rows; r++) {
            const s = sOff + r * sStride;
            for (let k = 0; k <= n; k++) t[k + 3] = src[s + k];
            t[2] = t[3];
            t[1] = t[4];
            t[0] = t[5];
            t[n + 4] = t[n + 3];
            t[n + 5] = t[n + 2];
            t[n + 6] = t[n + 1];
            const o = r * outStride;
            for (let i = 0; i < n; i++) {
                const j = i + 3;
                const v =
                    20 * (t[j] + t[j + 1]) -
                    6 * (t[j - 1] + t[j + 2]) +
                    3 * (t[j - 2] + t[j + 3]) -
                    (t[j - 3] + t[j + 4]);
                out[o + i] = clampSample((v + rounder) >> 5);
            }
        }
    }

    /**
     * 8-tap half-sample filter along columns of an (n+1)-row source with mirroring at the block
     * edge.
     */
    private lowpassV(
        out: Uint8Array,
        outStride: number,
        src: Uint8Array,
        sOff: number,
        sStride: number,
        n: number,
        rounder: number,
    ): void {
        const t = this.taps;
        for (let c = 0; c < n; c++) {
            for (let k = 0; k <= n; k++) t[k + 3] = src[sOff + c + k * sStride];
            t[2] = t[3];
            t[1] = t[4];
            t[0] = t[5];
            t[n + 4] = t[n + 3];
            t[n + 5] = t[n + 2];
            t[n + 6] = t[n + 1];
            for (let i = 0; i < n; i++) {
                const j = i + 3;
                const v =
                    20 * (t[j] + t[j + 1]) -
                    6 * (t[j - 1] + t[j + 2]) +
                    3 * (t[j - 2] + t[j + 3]) -
                    (t[j - 3] + t[j + 4]);
                out[c + i * outStride] = clampSample((v + rounder) >> 5);
            }
        }
    }

    private static average2(
        out: Uint8Array,
        a: Uint8Array,
        aOff: number,
        aStride: number,
        b: Uint8Array,
        bOff: number,
        bStride: number,
        n: number,
        rows: number,
        round: number,
    ): void {
        for (let r = 0; r < rows; r++) {
            const ao = aOff + r * aStride;
            const bo = bOff + r * bStride;
            const o = r * n;
            for (let i = 0; i < n; i++) out[o + i] = (a[ao + i] + b[bo + i] + round) >> 1;
        }
    }

    private store(dst: Uint8Array, dOff: number, dStride: number, n: number, mode: number): void {
        const pred = this.pred;
        for (let r = 0; r < n; r++) {
            const d = dOff + r * dStride;
            const p = r * n;
            if (mode === AVG)
                for (let i = 0; i < n; i++) dst[d + i] = (dst[d + i] + pred[p + i] + 1) >> 1;
            else for (let i = 0; i < n; i++) dst[d + i] = pred[p + i];
        }
    }

    /**
     * Quarter-sample prediction of an n x n block (n = 8 or 16) from an (n+1) x (n+1) source,
     * `dx`/`dy` in quarter samples. `legacy` selects the averaging of early libavcodec encoders for
     * the diagonal positions.
     */
    quarterSample(
        dst: Uint8Array,
        dOff: number,
        dStride: number,
        src: Uint8Array,
        sOff: number,
        sStride: number,
        n: number,
        dx: number,
        dy: number,
        mode: number,
        legacy: boolean,
    ): void {
        if ((dx | dy) === 0) {
            this.halfSample(dst, dOff, dStride, src, sOff, sStride, n, n, 0, mode);
            return;
        }
        const rounder = mode === PUT_NO_RND ? 15 : 16;
        const round = mode === PUT_NO_RND ? 0 : 1;
        const pred = this.pred;
        const halfH = this.halfH;
        const halfV = this.halfV;
        const halfHV = this.halfHV;
        if (dy === 0) {
            this.lowpassH(dx === 2 ? pred : halfH, n, src, sOff, sStride, n, n, rounder);
            if (dx !== 2)
                MotionCompensation.average2(
                    pred,
                    src,
                    sOff + (dx >> 1),
                    sStride,
                    halfH,
                    0,
                    n,
                    n,
                    n,
                    round,
                );
        } else if (dx === 0) {
            this.lowpassV(dy === 2 ? pred : halfV, n, src, sOff, sStride, n, rounder);
            if (dy !== 2) {
                const rowOff = sOff + (dy >> 1) * sStride;
                MotionCompensation.average2(pred, src, rowOff, sStride, halfV, 0, n, n, n, round);
            }
        } else if (legacy && dx !== 2) {
            const column = dx >> 1;
            this.lowpassH(halfH, n, src, sOff, sStride, n, n + 1, rounder);
            this.lowpassV(halfV, n, src, sOff + column, sStride, n, rounder);
            this.lowpassV(halfHV, n, halfH, 0, n, n, rounder);
            if (dy === 2) {
                MotionCompensation.average2(pred, halfV, 0, n, halfHV, 0, n, n, n, round);
            } else {
                const fullOff = sOff + (dy >> 1) * sStride + column;
                const hOff = (dy >> 1) * n;
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < n; i++) {
                        const p = r * n + i;
                        pred[p] =
                            (src[fullOff + r * sStride + i] +
                                halfH[hOff + p] +
                                halfV[p] +
                                halfHV[p] +
                                1 +
                                round) >>
                            2;
                    }
                }
            }
        } else {
            this.lowpassH(halfH, n, src, sOff, sStride, n, n + 1, rounder);
            if (dx !== 2)
                MotionCompensation.average2(
                    halfH,
                    halfH,
                    0,
                    n,
                    src,
                    sOff + (dx >> 1),
                    sStride,
                    n,
                    n + 1,
                    round,
                );
            if (dy === 2) {
                this.lowpassV(pred, n, halfH, 0, n, n, rounder);
            } else {
                this.lowpassV(halfHV, n, halfH, 0, n, n, rounder);
                MotionCompensation.average2(
                    pred,
                    halfH,
                    (dy >> 1) * n,
                    n,
                    halfHV,
                    0,
                    n,
                    n,
                    n,
                    round,
                );
            }
        }
        this.store(dst, dOff, dStride, n, mode);
    }

    /**
     * One-point global motion compensation of an 8 x `height` block with sixteenth-sample offsets
     * and the given rounder, from a 9-column source (ISO/IEC 14496-2 7.8.7.2).
     */
    static gmcOnePoint(
        dst: Uint8Array,
        dOff: number,
        dStride: number,
        src: Uint8Array,
        sOff: number,
        sStride: number,
        height: number,
        x16: number,
        y16: number,
        rounder: number,
    ): void {
        const a = (16 - x16) * (16 - y16);
        const b = x16 * (16 - y16);
        const c = (16 - x16) * y16;
        const d = x16 * y16;
        for (let y = 0; y < height; y++) {
            const s = sOff + y * sStride;
            const o = dOff + y * dStride;
            for (let x = 0; x < 8; x++) {
                dst[o + x] =
                    (a * src[s + x] +
                        b * src[s + x + 1] +
                        c * src[s + x + sStride] +
                        d * src[s + x + sStride + 1] +
                        rounder) >>
                    8;
            }
        }
    }

    /**
     * Affine global motion compensation of an 8 x `height` block. Positions are 16.16 fixed point
     * in units of 1/2^shift samples; samples outside `width` x `height` clamp to the edge (ISO/IEC
     * 14496-2 7.8.7.1).
     */
    static gmcAffine(
        dst: Uint8Array,
        dOff: number,
        dStride: number,
        src: Uint8Array,
        base: number,
        stride: number,
        height: number,
        ox: number,
        oy: number,
        dxx: number,
        dxy: number,
        dyx: number,
        dyy: number,
        shift: number,
        rounder: number,
        edgeWidth: number,
        edgeHeight: number,
    ): void {
        const unit = 1 << shift;
        const maxX = edgeWidth - 1;
        const maxY = edgeHeight - 1;
        for (let y = 0; y < height; y++) {
            let vx = ox;
            let vy = oy;
            const o = dOff + y * dStride;
            for (let x = 0; x < 8; x++) {
                let sx = vx >> 16;
                let sy = vy >> 16;
                const fx = sx & (unit - 1);
                const fy = sy & (unit - 1);
                sx >>= shift;
                sy >>= shift;
                let value: number;
                if (sx >= 0 && sx < maxX) {
                    if (sy >= 0 && sy < maxY) {
                        const i = base + sx + sy * stride;
                        value =
                            ((src[i] * (unit - fx) + src[i + 1] * fx) * (unit - fy) +
                                (src[i + stride] * (unit - fx) + src[i + stride + 1] * fx) * fy +
                                rounder) >>
                            (shift * 2);
                    } else {
                        const i = base + sx + (sy < 0 ? 0 : sy > maxY ? maxY : sy) * stride;
                        value =
                            ((src[i] * (unit - fx) + src[i + 1] * fx) * unit + rounder) >>
                            (shift * 2);
                    }
                } else {
                    const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
                    if (sy >= 0 && sy < maxY) {
                        const i = base + cx + sy * stride;
                        value =
                            ((src[i] * (unit - fy) + src[i + stride] * fy) * unit + rounder) >>
                            (shift * 2);
                    } else {
                        value = src[base + cx + (sy < 0 ? 0 : sy > maxY ? maxY : sy) * stride];
                    }
                }
                dst[o + x] = value;
                vx += dxx;
                vy += dyx;
            }
            ox += dxy;
            oy += dyy;
        }
    }
}
