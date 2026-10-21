import type { H264Kernels } from './kernels';
import { MB_FIELD, MB_INTRA, MB_T8X8, type Picture } from './picture';
import { CHROMA_QP, PICT_BOTTOM, PICT_FRAME } from './tables';

/** alpha' and beta' by indexA / indexB (Table 8-16). */
const ALPHA = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 17, 20, 22,
    25, 28, 32, 36, 40, 45, 50, 56, 63, 71, 80, 90, 101, 113, 127, 144, 162, 182, 203, 226, 255,
    255,
]);
const BETA = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 6, 6, 7, 7, 8, 8,
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18,
]);

/** tC0 by indexA * 4 + bS (Table 8-17). */
const TC0 = new Uint8Array(52 * 4);
{
    const rows = [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 2],
        [1, 1, 2],
        [1, 1, 2],
        [1, 1, 2],
        [1, 2, 3],
        [1, 2, 3],
        [2, 2, 3],
        [2, 2, 4],
        [2, 3, 4],
        [2, 3, 4],
        [3, 3, 5],
        [3, 4, 6],
        [3, 4, 6],
        [4, 5, 7],
        [4, 5, 8],
        [4, 6, 9],
        [5, 7, 10],
        [6, 8, 11],
        [6, 8, 13],
        [7, 10, 14],
        [8, 11, 16],
        [9, 12, 18],
        [10, 13, 20],
        [11, 15, 23],
        [13, 17, 25],
    ];
    for (let i = 0; i < rows.length; i++) {
        TC0[(17 + i) * 4 + 1] = rows[i][0];
        TC0[(17 + i) * 4 + 2] = rows[i][1];
        TC0[(17 + i) * 4 + 3] = rows[i][2];
    }
}

/**
 * Motion partition classes: which internal edges of an inter macroblock can separate different
 * motion.
 */
export const MOTION_UNIFORM = 0;
export const MOTION_16X8 = 1;
export const MOTION_8X16 = 2;
export const MOTION_8X8 = 3;
export const MOTION_4X4 = 4;

/**
 * The picture the filter reads, with its per-macroblock arrays (filterParams holds the parameters
 * of each macroblock's slice).
 */
export interface DeblockInput {
    readonly picture: Picture;
    readonly mbaff: boolean;
    /** PICT_FRAME, or the parity of the field picture being filtered. */
    readonly structure: number;
    /** WebAssembly kernels of the memory holding the picture, or null to filter in JavaScript. */
    readonly kernels: H264Kernels | null;
}

const bsEdge = new Uint8Array(8);
const lineBs = new Uint8Array(16);
const lineQpA = new Uint8Array(16);
const lineQpB = new Uint8Array(16);

/** Picture arrays of the filter in progress. */
let input: DeblockInput;
let data: Uint8Array = new Uint8Array(0);
let kernels: H264Kernels | null = null;

/** Address of `data` in the kernel memory. */
let base = 0;
let mbFlags: Uint8Array = new Uint8Array(0);
let nzMasks: Uint16Array = new Uint16Array(0);
let refs0: Int32Array = new Int32Array(0);
let refs1: Int32Array = new Int32Array(0);
let mvs0: Int16Array = new Int16Array(0);
let mvs1: Int16Array = new Int16Array(0);

/** `mvs0` and `mvs1` with one (x, y) vector per element. */
let vectors0: Int32Array = new Int32Array(0);
let vectors1: Int32Array = new Int32Array(0);

function clip(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clip3(lo: number, hi: number, v: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Filters `lines` lines across one edge: sample p_i sits at `o - (i + 1) * step` and q_i at
 * `o + i * step` of each line, lines being `lineStep` apart. `lineBs`, `lineQpA` and `lineQpB` hold
 * bS, indexA and indexB per line.
 */
function filterLumaLines(o: number, step: number, lineStep: number, lines: number): void {
    const px = data;
    for (let l = 0; l < lines; l++) {
        const bS = lineBs[l];
        if (!bS) continue;
        const alpha = ALPHA[lineQpA[l]];
        const beta = BETA[lineQpB[l]];
        const q = o + l * lineStep;
        const p0 = px[q - step];
        const q0 = px[q];
        const p1 = px[q - 2 * step];
        const q1 = px[q + step];
        if (Math.abs(p0 - q0) >= alpha || Math.abs(p1 - p0) >= beta || Math.abs(q1 - q0) >= beta)
            continue;
        const p2 = px[q - 3 * step];
        const q2 = px[q + 2 * step];
        const ap = Math.abs(p2 - p0);
        const aq = Math.abs(q2 - q0);
        if (bS < 4) {
            const tc0 = TC0[lineQpA[l] * 4 + bS];
            const tc = tc0 + (ap < beta ? 1 : 0) + (aq < beta ? 1 : 0);
            const delta = clip3(-tc, tc, (((q0 - p0) << 2) + (p1 - q1) + 4) >> 3);
            px[q - step] = clip(p0 + delta);
            px[q] = clip(q0 - delta);
            if (ap < beta)
                px[q - 2 * step] =
                    p1 + clip3(-tc0, tc0, (p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1);
            if (aq < beta)
                px[q + step] = q1 + clip3(-tc0, tc0, (q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1);
        } else {
            const strong = Math.abs(p0 - q0) < (alpha >> 2) + 2;
            if (strong && ap < beta) {
                const p3 = px[q - 4 * step];
                px[q - step] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3;
                px[q - 2 * step] = (p2 + p1 + p0 + q0 + 2) >> 2;
                px[q - 3 * step] = (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3;
            } else px[q - step] = (2 * p1 + p0 + q1 + 2) >> 2;
            if (strong && aq < beta) {
                const q3 = px[q + 3 * step];
                px[q] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3;
                px[q + step] = (p0 + q0 + q1 + q2 + 2) >> 2;
                px[q + 2 * step] = (2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3;
            } else px[q] = (2 * q1 + q0 + p1 + 2) >> 2;
        }
    }
}

/**
 * Chroma edge filter (8.7.2.4 with chromaStyleFilteringFlag) over `lines` lines with per-line
 * parameters.
 */
function filterChromaLines(o: number, step: number, lineStep: number, lines: number): void {
    const px = data;
    for (let l = 0; l < lines; l++) {
        const bS = lineBs[l];
        if (!bS) continue;
        const alpha = ALPHA[lineQpA[l]];
        const beta = BETA[lineQpB[l]];
        const q = o + l * lineStep;
        const p0 = px[q - step];
        const q0 = px[q];
        const p1 = px[q - 2 * step];
        const q1 = px[q + step];
        if (Math.abs(p0 - q0) >= alpha || Math.abs(p1 - p0) >= beta || Math.abs(q1 - q0) >= beta)
            continue;
        if (bS < 4) {
            const tc = TC0[lineQpA[l] * 4 + bS] + 1;
            const delta = clip3(-tc, tc, (((q0 - p0) << 2) + (p1 - q1) + 4) >> 3);
            px[q - step] = clip(p0 + delta);
            px[q] = clip(q0 - delta);
        } else {
            px[q - step] = (2 * p1 + p0 + q1 + 2) >> 2;
            px[q] = (2 * q1 + q0 + p1 + 2) >> 2;
        }
    }
}

/**
 * filterLumaEdge with the kernels, for MBAFF and 4:2:2 pictures (deblock_row filters the others).
 */
function kernelLumaEdge(
    simd: H264Kernels,
    o: number,
    step: number,
    lineStep: number,
    alpha: number,
    beta: number,
    indexA: number,
): void {
    const bs = bsEdge[0] | (bsEdge[1] << 8) | (bsEdge[2] << 16) | (bsEdge[3] << 24);
    const t = indexA * 4;
    const tc0 =
        TC0[t + (bsEdge[0] & 3)] |
        (TC0[t + (bsEdge[1] & 3)] << 8) |
        (TC0[t + (bsEdge[2] & 3)] << 16) |
        (TC0[t + (bsEdge[3] & 3)] << 24);
    if (step === 1) simd.deblock_luma_v(base + o, lineStep, alpha, beta, bs, tc0);
    else simd.deblock_luma_h(base + o, step, alpha, beta, bs, tc0);
}

/** filterChromaEdge with the kernels. */
function kernelChromaEdge(
    simd: H264Kernels,
    o: number,
    step: number,
    lineStep: number,
    linesPerBs: number,
    alpha: number,
    beta: number,
    indexA: number,
): void {
    const t = indexA * 4;
    const b0 = bsEdge[0];
    const b1 = bsEdge[1];
    const b2 = bsEdge[2];
    const b3 = bsEdge[3];
    const t0 = TC0[t + (b0 & 3)] + 1;
    const t1 = TC0[t + (b1 & 3)] + 1;
    const t2 = TC0[t + (b2 & 3)] + 1;
    const t3 = TC0[t + (b3 & 3)] + 1;
    if (linesPerBs === 2) {
        const bs = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
        const tcs = t0 | (t1 << 8) | (t2 << 16) | (t3 << 24);
        if (step === 1) simd.deblock_chroma_v(base + o, lineStep, alpha, beta, bs, tcs);
        else simd.deblock_chroma_h(base + o, step, alpha, beta, bs, tcs);
        return;
    }

    // Four lines per bS (4:2:2 vertical edges): two calls of eight lines, two lines per packed bS.
    for (let half = 0; half < 2; half++) {
        const bA = half ? b2 : b0;
        const bB = half ? b3 : b1;
        const tA = half ? t2 : t0;
        const tB = half ? t3 : t1;
        simd.deblock_chroma_v(
            base + o + half * 8 * lineStep,
            lineStep,
            alpha,
            beta,
            bA | (bA << 8) | (bB << 16) | (bB << 24),
            tA | (tA << 8) | (tB << 16) | (tB << 24),
        );
    }
}

/**
 * Luma edge of 16 lines, `lineStep` apart, with one bS per four lines in `bsEdge` and one indexA
 * and indexB.
 */
function filterLumaEdge(
    o: number,
    step: number,
    lineStep: number,
    indexA: number,
    indexB: number,
): void {
    const px = data;
    const alpha = ALPHA[indexA];
    const beta = BETA[indexB];
    if (alpha === 0 || beta === 0) return;
    if (kernels !== null) {
        kernelLumaEdge(kernels, o, step, lineStep, alpha, beta, indexA);
        return;
    }
    const step2 = step * 2;
    const step3 = step * 3;
    for (let g = 0; g < 4; g++) {
        const bS = bsEdge[g];
        if (bS === 0) continue;
        const tc0 = TC0[indexA * 4 + (bS < 4 ? bS : 0)];
        for (let l = 0, q = o + g * 4 * lineStep; l < 4; l++, q += lineStep) {
            const p0 = px[q - step];
            const q0 = px[q];
            const d0 = p0 - q0;
            if (d0 >= alpha || -d0 >= alpha) continue;
            const p1 = px[q - step2];
            const q1 = px[q + step];
            if (p1 - p0 >= beta || p0 - p1 >= beta || q1 - q0 >= beta || q0 - q1 >= beta) continue;
            const p2 = px[q - step3];
            const q2 = px[q + step2];
            const ap = p2 > p0 ? p2 - p0 : p0 - p2;
            const aq = q2 > q0 ? q2 - q0 : q0 - q2;
            if (bS < 4) {
                let tc = tc0;
                if (ap < beta) {
                    tc++;
                    let d = (p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1;
                    d = d < -tc0 ? -tc0 : d > tc0 ? tc0 : d;
                    px[q - step2] = p1 + d;
                }
                if (aq < beta) {
                    tc++;
                    let d = (q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1;
                    d = d < -tc0 ? -tc0 : d > tc0 ? tc0 : d;
                    px[q + step] = q1 + d;
                }
                let delta = (((q0 - p0) << 2) + (p1 - q1) + 4) >> 3;
                delta = delta < -tc ? -tc : delta > tc ? tc : delta;
                const np = p0 + delta;
                const nq = q0 - delta;
                px[q - step] = np < 0 ? 0 : np > 255 ? 255 : np;
                px[q] = nq < 0 ? 0 : nq > 255 ? 255 : nq;
            } else {
                const strong = (d0 < 0 ? -d0 : d0) < (alpha >> 2) + 2;
                if (strong && ap < beta) {
                    const p3 = px[q - 4 * step];
                    px[q - step] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3;
                    px[q - step2] = (p2 + p1 + p0 + q0 + 2) >> 2;
                    px[q - step3] = (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3;
                } else px[q - step] = (2 * p1 + p0 + q1 + 2) >> 2;
                if (strong && aq < beta) {
                    const q3 = px[q + step3];
                    px[q] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3;
                    px[q + step] = (p0 + q0 + q1 + q2 + 2) >> 2;
                    px[q + step2] = (2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3;
                } else px[q] = (2 * q1 + q0 + p1 + 2) >> 2;
            }
        }
    }
}

/**
 * Chroma edge of `lines` lines with one bS of `bsEdge` per `linesPerBs` lines and one indexA and
 * indexB.
 */
function filterChromaEdge(
    o: number,
    step: number,
    lineStep: number,
    linesPerBs: number,
    lines: number,
    indexA: number,
    indexB: number,
): void {
    const px = data;
    const alpha = ALPHA[indexA];
    const beta = BETA[indexB];
    if (alpha === 0 || beta === 0) return;
    if (kernels !== null) {
        kernelChromaEdge(kernels, o, step, lineStep, linesPerBs, alpha, beta, indexA);
        return;
    }
    const shift = linesPerBs === 4 ? 2 : 1;
    for (let l = 0, q = o; l < lines; l++, q += lineStep) {
        const bS = bsEdge[l >> shift];
        if (bS === 0) continue;
        const p0 = px[q - step];
        const q0 = px[q];
        const d0 = p0 - q0;
        if (d0 >= alpha || -d0 >= alpha) continue;
        const p1 = px[q - 2 * step];
        const q1 = px[q + step];
        if (p1 - p0 >= beta || p0 - p1 >= beta || q1 - q0 >= beta || q0 - q1 >= beta) continue;
        if (bS < 4) {
            const tc = TC0[indexA * 4 + bS] + 1;
            let delta = (((q0 - p0) << 2) + (p1 - q1) + 4) >> 3;
            delta = delta < -tc ? -tc : delta > tc ? tc : delta;
            const np = p0 + delta;
            const nq = q0 - delta;
            px[q - step] = np < 0 ? 0 : np > 255 ? 255 : np;
            px[q] = nq < 0 ? 0 : nq > 255 ? 255 : nq;
        } else {
            px[q - step] = (2 * p1 + p0 + q1 + 2) >> 2;
            px[q] = (2 * q1 + q0 + p1 + 2) >> 2;
        }
    }
}

/** Whether the 4x4 luma block `blk` (raster order) of macroblock `xy` has coefficients (0 or 1). */
function nonzero(xy: number, blk: number): number {
    return (nzMasks[xy] >> blk) & 1;
}

function mvDiffers(
    mvP: Int16Array,
    po: number,
    mvQ: Int16Array,
    qo: number,
    mvyLimit: number,
): boolean {
    const dx = mvP[po] - mvQ[qo];
    const dy = mvP[po + 1] - mvQ[qo + 1];
    return dx >= 4 || dx <= -4 || dy >= mvyLimit || dy <= -mvyLimit;
}

/**
 * Motion-based bS between 4x4 blocks bp of macroblock p and bq of q (8.7.2.1), raster block
 * indices.
 */
function motionBs(p: number, bp: number, q: number, bq: number, mvyLimit: number): number {
    const b8p = p * 4 + (bp >> 3) * 2 + ((bp & 3) >> 1);
    const b8q = q * 4 + (bq >> 3) * 2 + ((bq & 3) >> 1);
    const p0 = refs0[b8p];
    const p1 = refs1[b8p];
    const q0 = refs0[b8q];
    const q1 = refs1[b8q];
    const vp = p * 16 + bp;
    const vq = q * 16 + bq;
    if (p0 === q0 && p1 === q1 && vectors0[vp] === vectors0[vq] && vectors1[vp] === vectors1[vq])
        return 0;
    const countP = (p0 >= 0 ? 1 : 0) + (p1 >= 0 ? 1 : 0);
    const countQ = (q0 >= 0 ? 1 : 0) + (q1 >= 0 ? 1 : 0);
    if (countP !== countQ) return 1;
    if (countP === 0) return 0;
    const pm = vp * 2;
    const qm = vq * 2;
    if (countP === 1) {
        if ((p0 >= 0 ? p0 : p1) !== (q0 >= 0 ? q0 : q1)) return 1;
        return mvDiffers(p0 >= 0 ? mvs0 : mvs1, pm, q0 >= 0 ? mvs0 : mvs1, qm, mvyLimit) ? 1 : 0;
    }
    const same = p0 === q0 && p1 === q1;
    if (!same && !(p0 === q1 && p1 === q0)) return 1;
    if (p0 !== p1) {
        if (same)
            return mvDiffers(mvs0, pm, mvs0, qm, mvyLimit) ||
                mvDiffers(mvs1, pm, mvs1, qm, mvyLimit)
                ? 1
                : 0;
        return mvDiffers(mvs0, pm, mvs1, qm, mvyLimit) || mvDiffers(mvs1, pm, mvs0, qm, mvyLimit)
            ? 1
            : 0;
    }
    const direct =
        mvDiffers(mvs0, pm, mvs0, qm, mvyLimit) || mvDiffers(mvs1, pm, mvs1, qm, mvyLimit);
    const crossed =
        mvDiffers(mvs0, pm, mvs1, qm, mvyLimit) || mvDiffers(mvs1, pm, mvs0, qm, mvyLimit);
    return direct && crossed ? 1 : 0;
}

/**
 * Segments with identical motion along a vertical and a horizontal edge per MOTION_* class: 4 for a
 * partition spanning the edge, 2 for halves, 1 for 4x4 blocks.
 */
const RUN_VERTICAL = new Uint8Array([4, 2, 4, 2, 1]);
const RUN_HORIZONTAL = new Uint8Array([4, 4, 2, 2, 1]);

/**
 * Motion bS of the edge segments i in `uncoded` (bit per segment) between block pb + i * pStep of
 * macroblock p and qb + i * qStep of q, into bsEdge; segments in runs of `run` share motion on both
 * sides, so one comparison per run suffices. Returns the OR of the bS written.
 */
function edgeMotionBs(
    p: number,
    pb: number,
    pStep: number,
    q: number,
    qb: number,
    qStep: number,
    run: number,
    uncoded: number,
    mvyLimit: number,
): number {
    let any = 0;
    let last = -1;
    let bS = 0;
    for (let i = 0; i < 4; i++) {
        if (!(uncoded & (1 << i))) continue;
        const first = i & -run;
        if (first !== last) {
            bS = motionBs(p, pb + first * pStep, q, qb + first * qStep, mvyLimit);
            last = first;
        }
        bsEdge[i] = bS;
        any |= bS;
    }
    return any;
}

function chromaQp(mbQp: number, offset: number): number {
    const qpi = mbQp + offset;
    return CHROMA_QP[qpi < 0 ? 0 : qpi > 51 ? 51 : qpi];
}

/** Rows of macroblocks (pairs for MBAFF) of the picture or field in decoding order. */
export function deblockRowCount(target: DeblockInput): number {
    const mbHeight = target.picture.mbHeight;
    return target.mbaff || target.structure !== PICT_FRAME ? mbHeight >> 1 : mbHeight;
}

/**
 * Applies the deblocking filter (8.7) to the macroblocks of rows [firstRow, endRow) of the picture
 * or field in decoding order. Rows must be filtered in order, and a row only once every macroblock
 * of the row below it that will be decoded has been, since intra prediction reads unfiltered
 * samples of the row above.
 */
export function deblockRows(target: DeblockInput, firstRow: number, endRow: number): void {
    const pic = target.picture;
    input = target;
    data = pic.data;
    kernels = target.kernels;
    base = pic.base;
    mbFlags = pic.mbFlags;
    nzMasks = pic.nzMask;
    refs0 = pic.refId[0];
    refs1 = pic.refId[1];
    mvs0 = pic.mv[0];
    mvs1 = pic.mv[1];
    vectors0 = pic.mv32[0];
    vectors1 = pic.mv32[1];
    const mbWidth = pic.mbWidth;
    const parity = target.structure === PICT_BOTTOM ? 1 : 0;
    if (kernels !== null && !target.mbaff && pic.chromaFormat <= 1) {
        const field = target.structure !== PICT_FRAME;
        for (let row = firstRow; row < endRow; row++) {
            kernels.deblock_row(
                base,
                base + pic.chromaOffset,
                base + pic.crOffset,
                pic.lumaStride,
                pic.chromaStride,
                mbWidth,
                field ? 2 * row + parity : row,
                field ? 1 : 0,
                pic.chromaFormat,
                pic.mbFlags.byteOffset,
                pic.sliceNum.byteOffset,
                pic.filterParams.byteOffset,
                pic.nzMask.byteOffset,
                pic.qp.byteOffset,
                pic.motionClass.byteOffset,
                refs0.byteOffset,
                refs1.byteOffset,
                vectors0.byteOffset,
                vectors1.byteOffset,
            );
        }
        return;
    }
    for (let row = firstRow; row < endRow; row++) {
        if (target.mbaff) {
            for (let x = 0; x < mbWidth; x++) {
                filterMacroblock(x, 2 * row);
                filterMacroblock(x, 2 * row + 1);
            }
        } else {
            const y = target.structure !== PICT_FRAME ? 2 * row + parity : row;
            for (let x = 0; x < mbWidth; x++) filterMacroblock(x, y);
        }
    }
}

function filterMacroblock(x: number, y: number): void {
    const pic = input.picture;
    const mbWidth = pic.mbWidth;
    const flags = mbFlags;
    const qp = pic.qp;
    const sliceNum = pic.sliceNum;
    const lumaStride = pic.lumaStride;
    const chromaStride = pic.chromaStride;
    const chromaFormat = pic.chromaFormat;
    const chromaHeight = chromaFormat === 2 ? 16 : 8;
    const mbaff = input.mbaff;
    const fieldPicture = input.structure !== PICT_FRAME;
    const xy = y * mbWidth + x;
    const slice = sliceNum[xy];
    if (slice < 0) return;
    // The fields filterParams() packs: disable_deblocking_filter_idc, then four offsets plus 16.
    const packed = pic.filterParams[xy];
    const disableIdc = packed & 3;
    if (disableIdc === 1) return;
    const flagsXy = flags[xy];
    const fieldMb = (flagsXy & MB_FIELD) !== 0;
    const intra = (flagsXy & MB_INTRA) !== 0;
    const t8x8 = (flagsXy & MB_T8X8) !== 0;
    const mvyLimit = fieldMb ? 2 : 4;
    const mbQp = qp[xy];
    const lumaMbStride = fieldMb ? lumaStride * 2 : lumaStride;
    const chromaMbStride = fieldMb ? chromaStride * 2 : chromaStride;
    const lumaOffset = fieldMb
        ? ((y >> 1) * 32 + (y & 1)) * lumaStride + x * 16
        : y * 16 * lumaStride + x * 16;
    const chromaOffset = fieldMb
        ? ((y >> 1) * chromaHeight * 2 + (y & 1)) * chromaStride + x * 8
        : y * chromaHeight * chromaStride + x * 8;
    const cbOffset = pic.chromaOffset + chromaOffset;
    const crOffset = pic.crOffset + chromaOffset;
    const alphaOffset = ((packed >> 2) & 31) - 16;
    const betaOffset = ((packed >> 7) & 31) - 16;
    const cbQpOffset = ((packed >> 12) & 31) - 16;
    const crQpOffset = ((packed >> 17) & 31) - 16;
    const sameSliceOnly = disableIdc === 2;
    const cbQp = chromaFormat ? chromaQp(mbQp, cbQpOffset) : 0;
    const crQp = chromaFormat ? chromaQp(mbQp, crQpOffset) : 0;
    const coded = nzMasks[xy];
    const motion = intra ? MOTION_UNIFORM : pic.motionClass[xy];
    const innerEdges =
        ALPHA[clip3(0, 51, mbQp + alphaOffset)] !== 0 && (intra || coded !== 0 || motion !== 0);
    const innerChroma =
        chromaFormat !== 0 &&
        (ALPHA[clip3(0, 51, cbQp + alphaOffset)] !== 0 ||
            ALPHA[clip3(0, 51, crQp + alphaOffset)] !== 0) &&
        (intra || coded !== 0 || motion !== 0);

    // Vertical edges.
    for (let edge = 0; edge < 4; edge++) {
        if (edge > 0 && t8x8 && edge & 1) continue;
        const lumaCol = lumaOffset + edge * 4;
        if (edge === 0) {
            if (x === 0) continue;
            const leftXy = xy - 1;
            const leftField = (flags[leftXy] & MB_FIELD) !== 0;
            if (mbaff && leftField !== fieldMb) {
                // Left macroblock pair of the other kind: bS and qP per pair of luma lines
                // (8.7.2.1).
                const leftTop = x - 1 + (y & ~1) * mbWidth;
                if (sliceNum[leftTop] < 0 || (sameSliceOnly && sliceNum[leftTop] !== slice))
                    continue;
                const leftBottom = leftTop + mbWidth;
                for (let i = 0; i < 8; i++) {
                    let leftMb: number;
                    let leftRow: number;
                    if (fieldMb) {
                        leftMb = i < 4 ? leftTop : leftBottom;
                        leftRow = i & 3;
                    } else {
                        leftMb = i & 1 ? leftBottom : leftTop;
                        leftRow = (y & 1 ? 2 : 0) + (i >> 2);
                    }
                    let bS: number;
                    if (intra || flags[leftMb] & MB_INTRA) bS = 4;
                    else
                        bS =
                            1 +
                            (nonzero(xy, (i >> 1) * 4) | nonzero(leftMb, leftRow * 4 + 3) ? 1 : 0);
                    bsEdge[i] = bS;
                }
                const qpTop = (mbQp + qp[leftTop] + 1) >> 1;
                const qpBottom = (mbQp + qp[leftBottom] + 1) >> 1;
                for (let l = 0; l < 16; l++) {
                    lineBs[l] = bsEdge[fieldMb ? l >> 1 : ((l >> 2) << 1) | (l & 1)];
                    const avg = (fieldMb ? l < 8 : (l & 1) === 0) ? qpTop : qpBottom;
                    lineQpA[l] = clip3(0, 51, avg + alphaOffset);
                    lineQpB[l] = clip3(0, 51, avg + betaOffset);
                }
                filterLumaLines(lumaCol, 1, lumaMbStride, 16);
                if (chromaFormat) {
                    for (let plane = 0; plane < 2; plane++) {
                        const offset = plane ? crQpOffset : cbQpOffset;
                        const own = plane ? crQp : cbQp;
                        const cqTop = (own + chromaQp(qp[leftTop], offset) + 1) >> 1;
                        const cqBottom = (own + chromaQp(qp[leftBottom], offset) + 1) >> 1;
                        for (let l = 0; l < chromaHeight; l++) {
                            lineBs[l] = bsEdge[chromaFormat === 2 ? l >> 1 : l];
                            const avg = (fieldMb ? l < chromaHeight / 2 : (l & 1) === 0)
                                ? cqTop
                                : cqBottom;
                            lineQpA[l] = clip3(0, 51, avg + alphaOffset);
                            lineQpB[l] = clip3(0, 51, avg + betaOffset);
                        }
                        filterChromaLines(
                            plane ? crOffset : cbOffset,
                            1,
                            chromaMbStride,
                            chromaHeight,
                        );
                    }
                }
                continue;
            }
            if (sliceNum[leftXy] < 0 || (sameSliceOnly && sliceNum[leftXy] !== slice)) continue;
            let any = 0;
            if (intra || flags[leftXy] & MB_INTRA) {
                bsEdge[0] = bsEdge[1] = bsEdge[2] = bsEdge[3] = 4;
                any = 4;
            } else {
                const leftCoded = nzMasks[leftXy];
                let uncoded = 0;
                for (let i = 0; i < 4; i++) {
                    if (((coded >> (i * 4)) | (leftCoded >> (i * 4 + 3))) & 1) {
                        bsEdge[i] = 2;
                        any = 2;
                    } else uncoded |= 1 << i;
                }
                if (uncoded) {
                    const run = Math.min(
                        RUN_VERTICAL[motion],
                        RUN_VERTICAL[pic.motionClass[leftXy]],
                    );
                    any |= edgeMotionBs(leftXy, 3, 4, xy, 0, 4, run, uncoded, mvyLimit);
                }
            }
            if (!any) continue;
            const avg = (mbQp + qp[leftXy] + 1) >> 1;
            filterLumaEdge(
                lumaCol,
                1,
                lumaMbStride,
                clip3(0, 51, avg + alphaOffset),
                clip3(0, 51, avg + betaOffset),
            );
            if (chromaFormat) {
                const leftQp = qp[leftXy];
                const cbAvg = (cbQp + chromaQp(leftQp, cbQpOffset) + 1) >> 1;
                const crAvg = (crQp + chromaQp(leftQp, crQpOffset) + 1) >> 1;
                const perBs = chromaFormat === 2 ? 4 : 2;
                filterChromaEdge(
                    cbOffset,
                    1,
                    chromaMbStride,
                    perBs,
                    chromaHeight,
                    clip3(0, 51, cbAvg + alphaOffset),
                    clip3(0, 51, cbAvg + betaOffset),
                );
                filterChromaEdge(
                    crOffset,
                    1,
                    chromaMbStride,
                    perBs,
                    chromaHeight,
                    clip3(0, 51, crAvg + alphaOffset),
                    clip3(0, 51, crAvg + betaOffset),
                );
            }
            continue;
        }
        if (!innerEdges && !(innerChroma && edge === 2)) continue;
        let any = 0;
        if (intra) {
            bsEdge[0] = bsEdge[1] = bsEdge[2] = bsEdge[3] = 3;
            any = 3;
        } else {
            const motionEdge =
                motion === MOTION_4X4 ||
                (edge === 2 && (motion === MOTION_8X16 || motion === MOTION_8X8));
            let uncoded = 0;
            for (let i = 0; i < 4; i++) {
                if (((coded >> (i * 4 + edge)) | (coded >> (i * 4 + edge - 1))) & 1) {
                    bsEdge[i] = 2;
                    any = 2;
                } else {
                    bsEdge[i] = 0;
                    uncoded |= 1 << i;
                }
            }
            if (motionEdge && uncoded) {
                any |= edgeMotionBs(
                    xy,
                    edge - 1,
                    4,
                    xy,
                    edge,
                    4,
                    RUN_VERTICAL[motion],
                    uncoded,
                    mvyLimit,
                );
            }
        }
        if (!any) continue;
        filterLumaEdge(
            lumaCol,
            1,
            lumaMbStride,
            clip3(0, 51, mbQp + alphaOffset),
            clip3(0, 51, mbQp + betaOffset),
        );
        if (chromaFormat && edge === 2) {
            const perBs = chromaFormat === 2 ? 4 : 2;
            filterChromaEdge(
                cbOffset + 4,
                1,
                chromaMbStride,
                perBs,
                chromaHeight,
                clip3(0, 51, cbQp + alphaOffset),
                clip3(0, 51, cbQp + betaOffset),
            );
            filterChromaEdge(
                crOffset + 4,
                1,
                chromaMbStride,
                perBs,
                chromaHeight,
                clip3(0, 51, crQp + alphaOffset),
                clip3(0, 51, crQp + betaOffset),
            );
        }
    }

    // Horizontal edges.
    for (let edge = 0; edge < 4; edge++) {
        const lumaEdgeSkipped = edge > 0 && t8x8 && edge & 1;
        if (lumaEdgeSkipped && chromaFormat !== 2) continue;
        if (edge === 0) {
            let topXy: number;
            if (mbaff) {
                if (fieldMb) {
                    topXy = y >= 2 ? xy - 2 * mbWidth : -1;
                    if (topXy >= 0 && (y & 1) === 0 && !(flags[topXy] & MB_FIELD)) topXy += mbWidth;
                } else if (y & 1) topXy = xy - mbWidth;
                else topXy = y >= 2 ? xy - mbWidth : -1;
            } else if (fieldPicture) topXy = y >= 2 ? xy - 2 * mbWidth : -1;
            else topXy = y >= 1 ? xy - mbWidth : -1;
            if (topXy < 0 || sliceNum[topXy] < 0 || (sameSliceOnly && sliceNum[topXy] !== slice))
                continue;
            const topField = (flags[topXy] & MB_FIELD) !== 0;
            if (mbaff && !fieldMb && (y & 1) === 0 && topField) {
                // Frame macroblock below a field pair: filter the top edge once per field (8.7.1).
                for (let j = 0; j < 2; j++) {
                    const nbr = xy - 2 * mbWidth + j * mbWidth;
                    const nbrIntra = (flags[nbr] & MB_INTRA) !== 0;
                    for (let i = 0; i < 4; i++) {
                        bsEdge[i] =
                            intra || nbrIntra
                                ? 3
                                : 1 + (nonzero(xy, i) | nonzero(nbr, 12 + i) ? 1 : 0);
                    }
                    const avg = (mbQp + qp[nbr] + 1) >> 1;
                    filterLumaEdge(
                        lumaOffset + j * lumaStride,
                        lumaStride * 2,
                        1,
                        clip3(0, 51, avg + alphaOffset),
                        clip3(0, 51, avg + betaOffset),
                    );
                    if (chromaFormat) {
                        for (let plane = 0; plane < 2; plane++) {
                            const own = plane ? crQp : cbQp;
                            const cavg =
                                (own + chromaQp(qp[nbr], plane ? crQpOffset : cbQpOffset) + 1) >> 1;
                            filterChromaEdge(
                                (plane ? crOffset : cbOffset) + j * chromaStride,
                                chromaStride * 2,
                                1,
                                2,
                                8,
                                clip3(0, 51, cavg + alphaOffset),
                                clip3(0, 51, cavg + betaOffset),
                            );
                        }
                    }
                }
                continue;
            }
            const topIntra = (flags[topXy] & MB_INTRA) !== 0;
            const mixed = mbaff && topField !== fieldMb;
            let any = 0;
            if (intra || topIntra) {
                const bS = fieldMb || topField ? 3 : 4;
                bsEdge[0] = bsEdge[1] = bsEdge[2] = bsEdge[3] = bS;
                any = bS;
            } else {
                const topCoded = nzMasks[topXy];
                let uncoded = 0;
                for (let i = 0; i < 4; i++) {
                    if (((coded >> i) | (topCoded >> (12 + i))) & 1) {
                        bsEdge[i] = 2;
                        any = 2;
                    } else if (mixed) {
                        bsEdge[i] = 1;
                        any |= 1;
                    } else uncoded |= 1 << i;
                }
                if (uncoded) {
                    const run = Math.min(
                        RUN_HORIZONTAL[motion],
                        RUN_HORIZONTAL[pic.motionClass[topXy]],
                    );
                    any |= edgeMotionBs(topXy, 12, 1, xy, 0, 1, run, uncoded, mvyLimit);
                }
            }
            if (!any) continue;
            const avg = (mbQp + qp[topXy] + 1) >> 1;
            filterLumaEdge(
                lumaOffset,
                lumaMbStride,
                1,
                clip3(0, 51, avg + alphaOffset),
                clip3(0, 51, avg + betaOffset),
            );
            if (chromaFormat) {
                const topQp = qp[topXy];
                const cbAvg = (cbQp + chromaQp(topQp, cbQpOffset) + 1) >> 1;
                const crAvg = (crQp + chromaQp(topQp, crQpOffset) + 1) >> 1;
                filterChromaEdge(
                    cbOffset,
                    chromaMbStride,
                    1,
                    2,
                    8,
                    clip3(0, 51, cbAvg + alphaOffset),
                    clip3(0, 51, cbAvg + betaOffset),
                );
                filterChromaEdge(
                    crOffset,
                    chromaMbStride,
                    1,
                    2,
                    8,
                    clip3(0, 51, crAvg + alphaOffset),
                    clip3(0, 51, crAvg + betaOffset),
                );
            }
            continue;
        }
        if (!innerEdges && !(innerChroma && (chromaFormat === 2 || edge === 2))) continue;
        let any = 0;
        if (intra) {
            bsEdge[0] = bsEdge[1] = bsEdge[2] = bsEdge[3] = 3;
            any = 3;
        } else {
            const motionEdge =
                motion === MOTION_4X4 ||
                (edge === 2 && (motion === MOTION_16X8 || motion === MOTION_8X8));
            let uncoded = 0;
            for (let i = 0; i < 4; i++) {
                if (((coded >> (edge * 4 + i)) | (coded >> ((edge - 1) * 4 + i))) & 1) {
                    bsEdge[i] = 2;
                    any = 2;
                } else {
                    bsEdge[i] = 0;
                    uncoded |= 1 << i;
                }
            }
            if (motionEdge && uncoded) {
                any |= edgeMotionBs(
                    xy,
                    (edge - 1) * 4,
                    1,
                    xy,
                    edge * 4,
                    1,
                    RUN_HORIZONTAL[motion],
                    uncoded,
                    mvyLimit,
                );
            }
        }
        if (!any) continue;
        if (!lumaEdgeSkipped) {
            filterLumaEdge(
                lumaOffset + edge * 4 * lumaMbStride,
                lumaMbStride,
                1,
                clip3(0, 51, mbQp + alphaOffset),
                clip3(0, 51, mbQp + betaOffset),
            );
        }
        if (chromaFormat === 2 || (chromaFormat === 1 && edge === 2)) {
            const chromaRow = chromaFormat === 2 ? edge * 4 : 4;
            filterChromaEdge(
                cbOffset + chromaRow * chromaMbStride,
                chromaMbStride,
                1,
                2,
                8,
                clip3(0, 51, cbQp + alphaOffset),
                clip3(0, 51, cbQp + betaOffset),
            );
            filterChromaEdge(
                crOffset + chromaRow * chromaMbStride,
                chromaMbStride,
                1,
                2,
                8,
                clip3(0, 51, crQp + alphaOffset),
                clip3(0, 51, crQp + betaOffset),
            );
        }
    }
}
