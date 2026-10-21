/**
 * Optional coding modes of H.263 short header pictures (ITU-T H.263 Annexes D, G, I, J, K, M, S and
 * T) that the macroblock layer applies, with their tables and the in-loop deblocking filter. Values
 * follow ffmpeg's decoder.
 */

/** Optional modes of one short header picture; baseline pictures use only PB-frames. */
export interface H263Modes {
    /**
     * Annex D in a PLUSPTYPE picture: vectors without a range limit, coded with reversible codes.
     */
    readonly unlimitedVectors: boolean;
    /** Annex I advanced INTRA coding: predicted DC and AC coefficients with Table I.2. */
    readonly advancedIntra: boolean;
    /**
     * Annex F advanced prediction: overlapped motion compensation of P pictures (and four vectors).
     */
    readonly advancedPrediction: boolean;
    /** Annex J deblocking filter, applied in the loop after each macroblock. */
    readonly deblocking: boolean;
    /** Annex K slice structure: slice headers with a macroblock address replace GOB headers. */
    readonly slices: boolean;
    /**
     * Annex S alternative inter VLC: inter blocks may use Table I.2, and CBPY is kept with both
     * chroma coded.
     */
    readonly alternativeInterVlc: boolean;
    /**
     * Annex T modified quantisation: DQUANT as a step table or a new value, and chroma QP from
     * Table T.1.
     */
    readonly modifiedQuant: boolean;
    /**
     * PB-frames: 1 for Annex G, 3 for the improved PB-frames of Annex M, 0 without. The B part is
     * parsed and discarded, as ffmpeg does, so each picture yields its P picture.
     */
    readonly pbFrames: number;
}

export const NO_H263_MODES: H263Modes = {
    unlimitedVectors: false,
    advancedIntra: false,
    advancedPrediction: false,
    deblocking: false,
    slices: false,
    alternativeInterVlc: false,
    modifiedQuant: false,
    pbFrames: 0,
};

/**
 * The QP after an Annex T DQUANT of '1' then 0 (decrease) or 1 (increase): a step of 1 up to QP 10,
 * 2 up to 20 and 3 above, clipped to 1..31, with the two exceptions of its table (QP 1 decreases to
 * 3 and QP 31 increases to 26).
 */
export function modifiedQuant(quant: number, increase: number): number {
    const step = quant <= 10 ? 1 : quant <= 20 ? 2 : 3;
    if (!increase) return quant === 1 ? 3 : quant - step;
    return quant === 31 ? 26 : Math.min(31, quant + step);
}

/** Chroma QP for a luma QP under modified quantisation (Annex T). */
export const CHROMA_QUANT = Uint8Array.of(
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    6,
    7,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    12,
    13,
    13,
    13,
    14,
    14,
    14,
    14,
    14,
    15,
    15,
    15,
    15,
    15,
);

/**
 * Largest macroblock address each slice header address length (Table K.2) covers, and those
 * lengths.
 */
const MBA_MAX = [47, 98, 395, 1583, 6335, 9215];
const MBA_LENGTH = [6, 7, 9, 11, 13, 14];

/** Bit length of the macroblock address of a slice in a picture of `mbCount` macroblocks. */
export function mbaLength(mbCount: number): number {
    const index = MBA_MAX.findIndex(max => mbCount - 1 <= max);
    return MBA_LENGTH[index < 0 ? MBA_LENGTH.length - 1 : index];
}

/** Filter strength per QP (Table J.2). */
const LOOP_FILTER_STRENGTH = Uint8Array.of(
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    7,
    8,
    8,
    8,
    9,
    9,
    9,
    10,
    10,
    10,
    11,
    11,
    11,
    12,
    12,
    12,
);

/** Planes of an I420 picture in macroblock-aligned coded size. */
interface CodedPlanes {
    readonly mbWidth: number;
    readonly mbHeight: number;
    readonly lumaStride: number;
    readonly chromaStride: number;
    readonly chromaBase: number;
    readonly crBase: number;
}

/**
 * Annex J filter over 8 samples of one edge at `at`: `across` steps over the edge (between
 * `at - across` and `at`), `along` steps along it.
 */
function filterEdge(
    data: Uint8Array,
    at: number,
    across: number,
    along: number,
    quant: number,
): void {
    const strength = LOOP_FILTER_STRENGTH[quant];
    for (let i = 0; i < 8; i++) {
        const p = at + i * along;
        const p0 = data[p - 2 * across];
        let p1 = data[p - across];
        let p2 = data[p];
        const p3 = data[p + across];
        const d = Math.trunc((p0 - p3 + 4 * (p2 - p1)) / 8);
        const d1 =
            d < -2 * strength
                ? 0
                : d < -strength
                  ? -2 * strength - d
                  : d < strength
                    ? d
                    : d < 2 * strength
                      ? 2 * strength - d
                      : 0;
        p1 += d1;
        p2 -= d1;
        data[p - across] = p1 < 0 ? 0 : p1 > 255 ? 255 : p1;
        data[p] = p2 < 0 ? 0 : p2 > 255 ? 255 : p2;
        const limit = Math.abs(d1) >> 1;
        const d2 = Math.min(limit, Math.max(-limit, Math.trunc((p0 - p3) / 4)));
        data[p - 2 * across] = p0 - d2;
        data[p + across] = p3 + d2;
    }
}

/**
 * Deblocks macroblock (`mbx`, `mby`) right after it is reconstructed, in ffmpeg's order: its inner
 * edges, the edges shared with the macroblocks above and to the left, and the bottom edges of the
 * last row. `quants` holds each decoded macroblock's QP, 0 for skipped ones, which are not filtered
 * on their own. `chroma` maps luma QP to chroma QP under modified quantisation.
 */
export function deblockMacroblock(
    planes: CodedPlanes,
    data: Uint8Array,
    quants: Uint8Array,
    mbx: number,
    mby: number,
    chroma: Uint8Array | undefined,
): void {
    const { mbWidth, lumaStride: ls, chromaStride: cs } = planes;
    const mb = mby * mbWidth + mbx;
    const y = mby * 16 * ls + mbx * 16;
    const chromaAt = mby * 8 * cs + mbx * 8;
    const cb = planes.chromaBase + chromaAt;
    const cr = planes.crBase + chromaAt;
    const lastRow = mby + 1 === planes.mbHeight;
    const vertical = (at: number, stride: number, quant: number): void =>
        filterEdge(data, at, stride, 1, quant);
    const horizontal = (at: number, stride: number, quant: number): void =>
        filterEdge(data, at, 1, stride, quant);
    const chromaEdges = (filter: typeof vertical, offset: number, quant: number): void => {
        const q = chroma ? chroma[quant] : quant;
        filter(cb + offset, cs, q);
        filter(cr + offset, cs, q);
    };
    const current = quants[mb];
    if (current) {
        vertical(y + 8 * ls, ls, current);
        vertical(y + 8 * ls + 8, ls, current);
    }
    if (mby) {
        const top = quants[mb - mbWidth];
        const edge = current || top;
        if (edge) {
            vertical(y, ls, edge);
            vertical(y + 8, ls, edge);
            chromaEdges(vertical, 0, edge);
        }
        if (top) horizontal(y - 8 * ls + 8, ls, top);
        if (mbx) {
            const diagonal = top || quants[mb - mbWidth - 1];
            if (diagonal) {
                horizontal(y - 8 * ls, ls, diagonal);
                chromaEdges(horizontal, -8 * cs, diagonal);
            }
        }
    }
    if (current) {
        horizontal(y + 8, ls, current);
        if (lastRow) horizontal(y + 8 * ls + 8, ls, current);
    }
    if (mbx) {
        const left = current || quants[mb - 1];
        if (left) {
            horizontal(y, ls, left);
            if (lastRow) {
                horizontal(y + 8 * ls, ls, left);
                chromaEdges(horizontal, 0, left);
            }
        }
    }
}

/**
 * Annex F overlapped motion compensation weights of an 8x8 luma block, as ffmpeg's put_obmc applies
 * them: per sample the weights (out of 8) of the predictions from the vectors above, left, right
 * and below; the block's own vector takes the rest.
 */
const OBMC_WEIGHTS = ((): Uint8Array => {
    const weights = new Uint8Array(64 * 4);
    const set = (at: number, top: number, left: number, right: number, bottom: number): void =>
        weights.set([top, left, right, bottom], at * 4);

    // Each entry: first sample, top, left, right, bottom weights, and whether it covers a 2x2
    // square.
    const pattern: readonly (readonly number[])[] = [
        [0, 2, 2, 0, 0, 0],
        [1, 2, 1, 0, 0, 0],
        [2, 2, 1, 0, 0, 1],
        [4, 2, 0, 1, 0, 1],
        [6, 2, 0, 1, 0, 0],
        [7, 2, 0, 2, 0, 0],
        [8, 1, 2, 0, 0, 0],
        [9, 1, 2, 0, 0, 0],
        [14, 1, 0, 2, 0, 0],
        [15, 1, 0, 2, 0, 0],
        [16, 1, 2, 0, 0, 1],
        [18, 1, 1, 0, 0, 1],
        [20, 1, 0, 1, 0, 1],
        [22, 1, 0, 2, 0, 1],
        [32, 0, 2, 0, 1, 1],
        [34, 0, 1, 0, 1, 1],
        [36, 0, 0, 1, 1, 1],
        [38, 0, 0, 2, 1, 1],
        [48, 0, 2, 0, 1, 0],
        [49, 0, 2, 0, 1, 0],
        [50, 0, 1, 0, 2, 1],
        [52, 0, 0, 1, 2, 1],
        [54, 0, 0, 2, 1, 0],
        [55, 0, 0, 2, 1, 0],
        [56, 0, 2, 0, 2, 0],
        [57, 0, 1, 0, 2, 0],
        [62, 0, 0, 1, 2, 0],
        [63, 0, 0, 2, 2, 0],
    ];
    for (const [at, top, left, right, bottom, square] of pattern) {
        set(at, top, left, right, bottom);
        if (square) for (const step of [1, 8, 9]) set(at + step, top, left, right, bottom);
    }
    return weights;
})();

/**
 * Blends the five 8x8 predictions of one luma block (`predictions` holds them 64 samples apart:
 * own, above, left, right, below) into `data` at `at`.
 */
export function blendOverlapped(
    predictions: Uint8Array,
    data: Uint8Array,
    at: number,
    stride: number,
): void {
    for (let i = 0; i < 64; i++) {
        const w = i * 4;
        const top = OBMC_WEIGHTS[w];
        const left = OBMC_WEIGHTS[w + 1];
        const right = OBMC_WEIGHTS[w + 2];
        const bottom = OBMC_WEIGHTS[w + 3];
        const mid = 8 - top - left - right - bottom;
        const value =
            mid * predictions[i] +
            top * predictions[64 + i] +
            left * predictions[128 + i] +
            right * predictions[192 + i] +
            bottom * predictions[256 + i];
        data[at + (i >> 3) * stride + (i & 7)] = (value + 4) >> 3;
    }
}
