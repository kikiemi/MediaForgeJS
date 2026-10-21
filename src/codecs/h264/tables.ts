/** Raster positions of the coefficients in coded order (ITU-T H.264 Table 8-12 and Table 8-13). */
export const ZIGZAG_4X4 = new Uint8Array([0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15]);
export const FIELD_4X4 = new Uint8Array([0, 4, 1, 8, 12, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]);
export const FIELD_8X8 = new Uint8Array([
    0, 8, 16, 1, 9, 24, 32, 17, 2, 25, 40, 48, 56, 33, 10, 3, 18, 41, 49, 57, 26, 11, 4, 19, 34, 42,
    50, 58, 27, 12, 5, 20, 35, 43, 51, 59, 28, 13, 6, 21, 36, 44, 52, 60, 29, 14, 22, 37, 45, 53,
    61, 30, 7, 15, 38, 46, 54, 62, 23, 31, 39, 47, 55, 63,
]);

/** Table 7-3 and Table 7-4 default scaling lists in coded (zig-zag) order. */
export const DEFAULT_4X4_INTRA = new Uint8Array([
    6, 13, 13, 20, 20, 20, 28, 28, 28, 28, 32, 32, 32, 37, 37, 42,
]);
export const DEFAULT_4X4_INTER = new Uint8Array([
    10, 14, 14, 20, 20, 20, 24, 24, 24, 24, 27, 27, 27, 30, 30, 34,
]);
export const DEFAULT_8X8_INTRA = new Uint8Array([
    6, 10, 10, 13, 11, 13, 16, 16, 16, 16, 18, 18, 18, 18, 18, 23, 23, 23, 23, 23, 23, 25, 25, 25,
    25, 25, 25, 25, 27, 27, 27, 27, 27, 27, 27, 27, 29, 29, 29, 29, 29, 29, 29, 31, 31, 31, 31, 31,
    31, 33, 33, 33, 33, 33, 36, 36, 36, 36, 38, 38, 38, 40, 40, 42,
]);
export const DEFAULT_8X8_INTER = new Uint8Array([
    9, 13, 13, 15, 13, 15, 17, 17, 17, 17, 19, 19, 19, 19, 19, 21, 21, 21, 21, 21, 21, 22, 22, 22,
    22, 22, 22, 22, 24, 24, 24, 24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 25, 25, 27, 27, 27, 27, 27,
    27, 28, 28, 28, 28, 28, 30, 30, 30, 30, 32, 32, 32, 33, 33, 35,
]);

/** normAdjust4x4 (8.5.9): rows are qP % 6, columns the position class. */
const NORM_ADJUST_4X4 = [
    [10, 16, 13],
    [11, 18, 14],
    [13, 20, 16],
    [14, 23, 18],
    [16, 25, 20],
    [18, 29, 23],
];
const NORM_ADJUST_8X8 = [
    [20, 18, 32, 19, 25, 24],
    [22, 19, 35, 21, 28, 26],
    [26, 23, 42, 24, 33, 31],
    [28, 25, 45, 26, 35, 33],
    [32, 28, 51, 30, 40, 38],
    [36, 32, 58, 34, 46, 43],
];

/** Position class of each raster 4x4 coefficient for normAdjust4x4. */
const NORM_CLASS_4X4 = new Uint8Array(16);

/** Position class of each raster 8x8 coefficient for normAdjust8x8. */
const NORM_CLASS_8X8 = new Uint8Array(64);
for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
        NORM_CLASS_4X4[i * 4 + j] = (i & 1) === 0 && (j & 1) === 0 ? 0 : i & 1 && j & 1 ? 1 : 2;
for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
        let cls: number;
        if ((i & 3) === 0 && (j & 3) === 0) cls = 0;
        else if (i & 1 && j & 1) cls = 1;
        else if ((i & 3) === 2 && (j & 3) === 2) cls = 2;
        else if (((i & 3) === 0 && j & 1) || (i & 1 && (j & 3) === 0)) cls = 3;
        else if (((i & 3) === 0 && (j & 3) === 2) || ((i & 3) === 2 && (j & 3) === 0)) cls = 4;
        else cls = 5;
        NORM_CLASS_8X8[i * 8 + j] = cls;
    }
}

/** LevelScale4x4 for a flat weight of 16, rows qP % 6, raster positions. */
export const LEVEL_SCALE_4X4_FLAT: readonly Uint16Array[] = NORM_ADJUST_4X4.map(row => {
    const out = new Uint16Array(16);
    for (let i = 0; i < 16; i++) out[i] = 16 * row[NORM_CLASS_4X4[i]];
    return out;
});

/**
 * Builds LevelScale4x4(m, i, j) = weightScale(i, j) * normAdjust4x4(m, i, j) for raster positions.
 */
export function levelScale4x4(weights: Uint8Array): Int32Array {
    const out = new Int32Array(6 * 16);
    for (let m = 0; m < 6; m++) {
        for (let i = 0; i < 16; i++)
            out[m * 16 + i] = weights[i] * NORM_ADJUST_4X4[m][NORM_CLASS_4X4[i]];
    }
    return out;
}

export function levelScale8x8(weights: Uint8Array): Int32Array {
    const out = new Int32Array(6 * 64);
    for (let m = 0; m < 6; m++) {
        for (let i = 0; i < 64; i++)
            out[m * 64 + i] = weights[i] * NORM_ADJUST_8X8[m][NORM_CLASS_8X8[i]];
    }
    return out;
}

/** QPc as a function of qPi (Table 8-15). */
export const CHROMA_QP = new Uint8Array(52);
for (let i = 0; i < 30; i++) CHROMA_QP[i] = i;
CHROMA_QP.set(
    [29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39],
    30,
);

/**
 * MaxDpbMbs per level_idc (Table A-1); level 1b is level_idc 11 with constraint_set3_flag or
 * level_idc 9.
 */
const LEVEL_DPB_MBS: Readonly<Record<number, number>> = {
    9: 396,
    10: 396,
    11: 900,
    12: 2376,
    13: 2376,
    20: 2376,
    21: 4752,
    22: 8100,
    30: 8100,
    31: 18000,
    32: 20480,
    40: 32768,
    41: 32768,
    42: 34816,
    50: 110400,
    51: 184320,
    52: 184320,
    60: 696320,
    61: 696320,
    62: 696320,
};

/**
 * Frames the level allows in the decoded picture buffer for a frame of `mbCount` macroblocks
 * (A.3.1, 1..16).
 */
export function levelDpbFrames(levelIdc: number, constraintSet3: boolean, mbCount: number): number {
    const mbs = LEVEL_DPB_MBS[levelIdc === 11 && constraintSet3 ? 9 : levelIdc] ?? 696320;
    return Math.max(1, Math.min(16, Math.floor(mbs / mbCount)));
}

/**
 * coded_block_pattern from the me(v) code number (Table 9-4), intra then inter, ChromaArrayType 1
 * or 2.
 */
export const CBP_INTRA = new Uint8Array([
    47, 31, 15, 0, 23, 27, 29, 30, 7, 11, 13, 14, 39, 43, 45, 46, 16, 3, 5, 10, 12, 19, 21, 26, 28,
    35, 37, 42, 44, 1, 2, 4, 8, 17, 18, 20, 24, 6, 9, 22, 25, 32, 33, 34, 36, 40, 38, 41,
]);
export const CBP_INTER = new Uint8Array([
    0, 16, 1, 2, 4, 8, 32, 3, 5, 10, 12, 15, 47, 7, 11, 13, 14, 6, 9, 31, 35, 37, 42, 44, 33, 34,
    36, 40, 39, 43, 45, 46, 17, 18, 20, 24, 19, 21, 26, 28, 23, 27, 29, 30, 22, 25, 38, 41,
]);

/** Table 9-4 for ChromaArrayType 0 or 3 (luma only). */
export const CBP_INTRA_MONO = new Uint8Array([
    15, 0, 7, 11, 13, 14, 3, 5, 10, 12, 1, 2, 4, 8, 6, 9,
]);
export const CBP_INTER_MONO = new Uint8Array([
    0, 1, 2, 4, 8, 3, 5, 10, 12, 15, 7, 11, 13, 14, 6, 9,
]);

/** Bit 0 ... of a packed VLC entry: code length in bits 0..4, the symbol above. */
interface Vlc {
    readonly bits: number;
    readonly table: Uint16Array;
}

/**
 * Packs (length, symbol) so `table[peek(bits)]` yields `symbol << 5 | length`; a zero entry marks
 * an invalid code.
 */
function buildVlc(
    bits: number,
    codes: readonly (readonly [length: number, code: number, symbol: number])[],
): Vlc {
    const table = new Uint16Array(1 << bits);
    for (const [length, code, symbol] of codes) {
        if (!length) continue;
        const shift = bits - length;
        const start = code << shift;
        const packed = (symbol << 5) | length;
        for (let i = 0; i < 1 << shift; i++) table[start + i] = packed;
    }
    return { bits, table };
}

const COEFF_TOKEN_LEN = [
    [
        1, 0, 0, 0, 6, 2, 0, 0, 8, 6, 3, 0, 9, 8, 7, 5, 10, 9, 8, 6, 11, 10, 9, 7, 13, 11, 10, 8,
        13, 13, 11, 9, 13, 13, 13, 10, 14, 14, 13, 11, 14, 14, 14, 13, 15, 15, 14, 14, 15, 15, 15,
        14, 16, 15, 15, 15, 16, 16, 16, 15, 16, 16, 16, 16, 16, 16, 16, 16,
    ],
    [
        2, 0, 0, 0, 6, 2, 0, 0, 6, 5, 3, 0, 7, 6, 6, 4, 8, 6, 6, 4, 8, 7, 7, 5, 9, 8, 8, 6, 11, 9,
        9, 6, 11, 11, 11, 7, 12, 11, 11, 9, 12, 12, 12, 11, 12, 12, 12, 11, 13, 13, 13, 12, 13, 13,
        13, 13, 13, 14, 13, 13, 14, 14, 14, 13, 14, 14, 14, 14,
    ],
    [
        4, 0, 0, 0, 6, 4, 0, 0, 6, 5, 4, 0, 6, 5, 5, 4, 7, 5, 5, 4, 7, 5, 5, 4, 7, 6, 6, 4, 7, 6, 6,
        4, 8, 7, 7, 5, 8, 8, 7, 6, 9, 8, 8, 7, 9, 9, 8, 8, 9, 9, 9, 8, 10, 9, 9, 9, 10, 10, 10, 10,
        10, 10, 10, 10, 10, 10, 10, 10,
    ],
    [
        6, 0, 0, 0, 6, 6, 0, 0, 6, 6, 6, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
        6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
        6, 6, 6, 6, 6, 6,
    ],
];
const COEFF_TOKEN_BITS = [
    [
        1, 0, 0, 0, 5, 1, 0, 0, 7, 4, 1, 0, 7, 6, 5, 3, 7, 6, 5, 3, 7, 6, 5, 4, 15, 6, 5, 4, 11, 14,
        5, 4, 8, 10, 13, 4, 15, 14, 9, 4, 11, 10, 13, 12, 15, 14, 9, 12, 11, 10, 13, 8, 15, 1, 9,
        12, 11, 14, 13, 8, 7, 10, 9, 12, 4, 6, 5, 8,
    ],
    [
        3, 0, 0, 0, 11, 2, 0, 0, 7, 7, 3, 0, 7, 10, 9, 5, 7, 6, 5, 4, 4, 6, 5, 6, 7, 6, 5, 8, 15, 6,
        5, 4, 11, 14, 13, 4, 15, 10, 9, 4, 11, 14, 13, 12, 8, 10, 9, 8, 15, 14, 13, 12, 11, 10, 9,
        12, 7, 11, 6, 8, 9, 8, 10, 1, 7, 6, 5, 4,
    ],
    [
        15, 0, 0, 0, 15, 14, 0, 0, 11, 15, 13, 0, 8, 12, 14, 12, 15, 10, 11, 11, 11, 8, 9, 10, 9,
        14, 13, 9, 8, 10, 9, 8, 15, 14, 13, 13, 11, 14, 10, 12, 15, 10, 13, 12, 11, 14, 9, 12, 8,
        10, 13, 8, 13, 7, 9, 12, 9, 12, 11, 10, 5, 8, 7, 6, 1, 4, 3, 2,
    ],
    [
        3, 0, 0, 0, 0, 1, 0, 0, 4, 5, 6, 0, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
        22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
        45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
    ],
];
const CHROMA_DC_TOKEN_LEN = [2, 0, 0, 0, 6, 1, 0, 0, 6, 6, 3, 0, 6, 7, 7, 6, 6, 8, 8, 7];
const CHROMA_DC_TOKEN_BITS = [1, 0, 0, 0, 7, 1, 0, 0, 4, 6, 1, 0, 3, 3, 2, 5, 2, 3, 2, 0];
const CHROMA422_DC_TOKEN_LEN = [
    1, 0, 0, 0, 7, 2, 0, 0, 7, 7, 3, 0, 9, 7, 7, 5, 9, 9, 7, 6, 10, 10, 9, 7, 11, 11, 10, 7, 12, 12,
    11, 10, 13, 12, 12, 11,
];
const CHROMA422_DC_TOKEN_BITS = [
    1, 0, 0, 0, 15, 1, 0, 0, 14, 13, 1, 0, 7, 12, 11, 1, 6, 5, 10, 1, 7, 6, 4, 9, 7, 6, 5, 8, 7, 6,
    5, 4, 7, 5, 4, 4,
];

function coeffTokenVlc(
    len: readonly number[],
    bits: readonly number[],
    maxCoeff: number,
    width: number,
): Vlc {
    const codes: [number, number, number][] = [];
    for (let total = 0; total <= maxCoeff; total++) {
        for (let ones = 0; ones < 4; ones++) {
            const index = total * 4 + ones;
            if (len[index]) codes.push([len[index], bits[index], (total << 2) | ones]);
        }
    }
    return buildVlc(width, codes);
}

/**
 * coeff_token (Table 9-5): symbol = TotalCoeff << 2 | TrailingOnes; indexed by the nC class 0..3, 4
 * (chroma DC 4:2:0) and 5 (4:2:2).
 */
export const COEFF_TOKEN: readonly Vlc[] = [
    coeffTokenVlc(COEFF_TOKEN_LEN[0], COEFF_TOKEN_BITS[0], 16, 16),
    coeffTokenVlc(COEFF_TOKEN_LEN[1], COEFF_TOKEN_BITS[1], 16, 14),
    coeffTokenVlc(COEFF_TOKEN_LEN[2], COEFF_TOKEN_BITS[2], 16, 10),
    coeffTokenVlc(COEFF_TOKEN_LEN[3], COEFF_TOKEN_BITS[3], 16, 6),
    coeffTokenVlc(CHROMA_DC_TOKEN_LEN, CHROMA_DC_TOKEN_BITS, 4, 8),
    coeffTokenVlc(CHROMA422_DC_TOKEN_LEN, CHROMA422_DC_TOKEN_BITS, 8, 13),
];

const TOTAL_ZEROS_LEN = [
    [1, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9],
    [3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 6, 6],
    [4, 3, 3, 3, 4, 4, 3, 3, 4, 5, 5, 6, 5, 6],
    [5, 3, 4, 4, 3, 3, 3, 4, 3, 4, 5, 5, 5],
    [4, 4, 4, 3, 3, 3, 3, 3, 4, 5, 4, 5],
    [6, 5, 3, 3, 3, 3, 3, 3, 4, 3, 6],
    [6, 5, 3, 3, 3, 2, 3, 4, 3, 6],
    [6, 4, 5, 3, 2, 2, 3, 3, 6],
    [6, 6, 4, 2, 2, 3, 2, 5],
    [5, 5, 3, 2, 2, 2, 4],
    [4, 4, 3, 3, 1, 3],
    [4, 4, 2, 1, 3],
    [3, 3, 1, 2],
    [2, 2, 1],
    [1, 1],
];
const TOTAL_ZEROS_BITS = [
    [1, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 1],
    [7, 6, 5, 4, 3, 5, 4, 3, 2, 3, 2, 3, 2, 1, 0],
    [5, 7, 6, 5, 4, 3, 4, 3, 2, 3, 2, 1, 1, 0],
    [3, 7, 5, 4, 6, 5, 4, 3, 3, 2, 2, 1, 0],
    [5, 4, 3, 7, 6, 5, 4, 3, 2, 1, 1, 0],
    [1, 1, 7, 6, 5, 4, 3, 2, 1, 1, 0],
    [1, 1, 5, 4, 3, 3, 2, 1, 1, 0],
    [1, 1, 1, 3, 3, 2, 2, 1, 0],
    [1, 0, 1, 3, 2, 1, 1, 1],
    [1, 0, 1, 3, 2, 1, 1],
    [0, 1, 1, 2, 1, 3],
    [0, 1, 1, 1, 1],
    [0, 1, 1, 1],
    [0, 1, 1],
    [0, 1],
];
const CHROMA_DC_TOTAL_ZEROS_LEN = [
    [1, 2, 3, 3],
    [1, 2, 2],
    [1, 1],
];
const CHROMA_DC_TOTAL_ZEROS_BITS = [
    [1, 1, 1, 0],
    [1, 1, 0],
    [1, 0],
];
const CHROMA422_DC_TOTAL_ZEROS_LEN = [
    [1, 3, 3, 4, 4, 4, 5, 5],
    [3, 2, 3, 3, 3, 3, 3],
    [3, 3, 2, 2, 3, 3],
    [3, 2, 2, 2, 3],
    [2, 2, 2, 2],
    [2, 2, 1],
    [1, 1],
];
const CHROMA422_DC_TOTAL_ZEROS_BITS = [
    [1, 2, 3, 2, 3, 1, 1, 0],
    [0, 1, 1, 4, 5, 6, 7],
    [0, 1, 1, 2, 6, 7],
    [6, 0, 1, 2, 7],
    [0, 1, 2, 3],
    [0, 1, 1],
    [0, 1],
];
const RUN_BEFORE_LEN = [
    [1, 1],
    [1, 2, 2],
    [2, 2, 2, 2],
    [2, 2, 2, 3, 3],
    [2, 2, 3, 3, 3, 3],
    [2, 3, 3, 3, 3, 3, 3],
    [3, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11],
];
const RUN_BEFORE_BITS = [
    [1, 0],
    [1, 1, 0],
    [3, 2, 1, 0],
    [3, 2, 1, 1, 0],
    [3, 2, 3, 2, 1, 0],
    [3, 0, 1, 3, 2, 5, 4],
    [7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

function symbolVlc(len: readonly number[], bits: readonly number[], width: number): Vlc {
    return buildVlc(
        width,
        len.map((length, symbol) => [length, bits[symbol], symbol] as [number, number, number]),
    );
}

/** total_zeros (Tables 9-7 and 9-8) indexed by TotalCoeff - 1. */
export const TOTAL_ZEROS: readonly Vlc[] = TOTAL_ZEROS_LEN.map((len, i) =>
    symbolVlc(len, TOTAL_ZEROS_BITS[i], 9),
);

/** total_zeros for chroma DC 4:2:0 (Table 9-9a) indexed by TotalCoeff - 1. */
export const CHROMA_DC_TOTAL_ZEROS: readonly Vlc[] = CHROMA_DC_TOTAL_ZEROS_LEN.map((len, i) =>
    symbolVlc(len, CHROMA_DC_TOTAL_ZEROS_BITS[i], 3),
);

/** total_zeros for chroma DC 4:2:2 (Table 9-9b) indexed by TotalCoeff - 1. */
export const CHROMA422_DC_TOTAL_ZEROS: readonly Vlc[] = CHROMA422_DC_TOTAL_ZEROS_LEN.map((len, i) =>
    symbolVlc(len, CHROMA422_DC_TOTAL_ZEROS_BITS[i], 5),
);

/** run_before (Table 9-10) indexed by min(zerosLeft, 7) - 1. */
export const RUN_BEFORE: readonly Vlc[] = RUN_BEFORE_LEN.map((len, i) =>
    symbolVlc(len, RUN_BEFORE_BITS[i], 11),
);

/** rangeTabLPS (Table 9-44), indexed pStateIdx * 4 + qRangeIdx. */
export const RANGE_LPS = new Uint8Array([
    128, 176, 208, 240, 128, 167, 197, 227, 128, 158, 187, 216, 123, 150, 178, 205, 116, 142, 169,
    195, 111, 135, 160, 185, 105, 128, 152, 175, 100, 122, 144, 166, 95, 116, 137, 158, 90, 110,
    130, 150, 85, 104, 123, 142, 81, 99, 117, 135, 77, 94, 111, 128, 73, 89, 105, 122, 69, 85, 100,
    116, 66, 80, 95, 110, 62, 76, 90, 104, 59, 72, 86, 99, 56, 69, 81, 94, 53, 65, 77, 89, 51, 62,
    73, 85, 48, 59, 69, 80, 46, 56, 66, 76, 43, 53, 63, 72, 41, 50, 59, 69, 39, 48, 56, 65, 37, 45,
    54, 62, 35, 43, 51, 59, 33, 41, 48, 56, 32, 39, 46, 53, 30, 37, 43, 50, 29, 35, 41, 48, 27, 33,
    39, 45, 26, 31, 37, 43, 24, 30, 35, 41, 23, 28, 33, 39, 22, 27, 32, 37, 21, 26, 30, 35, 20, 24,
    29, 33, 19, 23, 27, 31, 18, 22, 26, 30, 17, 21, 25, 28, 16, 20, 23, 27, 15, 19, 22, 25, 14, 18,
    21, 24, 14, 17, 20, 23, 13, 16, 19, 22, 12, 15, 18, 21, 12, 14, 17, 20, 11, 14, 16, 19, 11, 13,
    15, 18, 10, 12, 15, 17, 10, 12, 14, 16, 9, 11, 13, 15, 9, 11, 12, 14, 8, 10, 12, 14, 8, 9, 11,
    13, 7, 9, 11, 12, 7, 9, 10, 12, 7, 8, 10, 11, 6, 8, 9, 11, 6, 7, 9, 10, 6, 7, 8, 9, 2, 2, 2, 2,
]);

/** transIdxLPS (Table 9-45). */
export const TRANS_IDX_LPS = new Uint8Array([
    0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21,
    21, 22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34,
    34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
]);

/** x and y in 4x4 units of luma block blkIdx (6.4.3). */
export const BLOCK_X = new Uint8Array([0, 1, 0, 1, 2, 3, 2, 3, 0, 1, 0, 1, 2, 3, 2, 3]);
export const BLOCK_Y = new Uint8Array([0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3]);

/** blkIdx of the 4x4 block at raster position (x + 4 * y). */
export const RASTER_TO_BLOCK = new Uint8Array([
    0, 1, 4, 5, 2, 3, 6, 7, 8, 9, 12, 13, 10, 11, 14, 15,
]);

/** Slice types after modulo 5 (Table 7-6). */
export const SLICE_P = 0;
export const SLICE_B = 1;
export const SLICE_I = 2;
export const SLICE_SP = 3;
export const SLICE_SI = 4;

/** Coded picture structure (Table 7-5 field_pic_flag and bottom_field_flag). */
export const PICT_TOP = 1;
export const PICT_BOTTOM = 2;
export const PICT_FRAME = 3;
