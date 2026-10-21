/**
 * Lookup tables are indexed by the next `bits` bitstream bits. Entry layout: bits 0-4 code length
 * including any sign bit (0 = invalid code), bits 5+ the decoded value. Coefficient tables pack
 * `last` in bit 5, `run` in bits 6-11 and the signed level from bit 12; `ESCAPE` marks the escape
 * prefix.
 */
export const ESCAPE = 31;

/**
 * ISO/IEC 14496-2 Table B-16 (intra TCOEF): code, length, run, level; entries from index 67 have
 * last = 1.
 */
const INTRA_TCOEF = [
    2, 2, 0, 1, 6, 3, 0, 2, 15, 4, 0, 3, 13, 5, 0, 4, 12, 5, 0, 5, 21, 6, 0, 6, 19, 6, 0, 7, 18, 6,
    0, 8, 23, 7, 0, 9, 31, 8, 0, 10, 30, 8, 0, 11, 29, 8, 0, 12, 37, 9, 0, 13, 36, 9, 0, 14, 35, 9,
    0, 15, 33, 9, 0, 16, 33, 10, 0, 17, 32, 10, 0, 18, 15, 10, 0, 19, 14, 10, 0, 20, 7, 11, 0, 21,
    6, 11, 0, 22, 32, 11, 0, 23, 33, 11, 0, 24, 80, 12, 0, 25, 81, 12, 0, 26, 82, 12, 0, 27, 14, 4,
    1, 1, 20, 6, 1, 2, 22, 7, 1, 3, 28, 8, 1, 4, 32, 9, 1, 5, 31, 9, 1, 6, 13, 10, 1, 7, 34, 11, 1,
    8, 83, 12, 1, 9, 85, 12, 1, 10, 11, 5, 2, 1, 21, 7, 2, 2, 30, 9, 2, 3, 12, 10, 2, 4, 86, 12, 2,
    5, 17, 6, 3, 1, 27, 8, 3, 2, 29, 9, 3, 3, 11, 10, 3, 4, 16, 6, 4, 1, 34, 9, 4, 2, 10, 10, 4, 3,
    13, 6, 5, 1, 28, 9, 5, 2, 8, 10, 5, 3, 18, 7, 6, 1, 27, 9, 6, 2, 84, 12, 6, 3, 20, 7, 7, 1, 26,
    9, 7, 2, 87, 12, 7, 3, 25, 8, 8, 1, 9, 10, 8, 2, 24, 8, 9, 1, 35, 11, 9, 2, 23, 8, 10, 1, 25, 9,
    11, 1, 24, 9, 12, 1, 7, 10, 13, 1, 88, 12, 14, 1, 7, 4, 0, 1, 12, 6, 0, 2, 22, 8, 0, 3, 23, 9,
    0, 4, 6, 10, 0, 5, 5, 11, 0, 6, 4, 11, 0, 7, 89, 12, 0, 8, 15, 6, 1, 1, 22, 9, 1, 2, 5, 10, 1,
    3, 14, 6, 2, 1, 4, 10, 2, 2, 17, 7, 3, 1, 36, 11, 3, 2, 16, 7, 4, 1, 37, 11, 4, 2, 19, 7, 5, 1,
    90, 12, 5, 2, 21, 8, 6, 1, 91, 12, 6, 2, 20, 8, 7, 1, 19, 8, 8, 1, 26, 8, 9, 1, 21, 9, 10, 1,
    20, 9, 11, 1, 19, 9, 12, 1, 18, 9, 13, 1, 17, 9, 14, 1, 38, 11, 15, 1, 39, 11, 16, 1, 92, 12,
    17, 1, 93, 12, 18, 1, 94, 12, 19, 1, 95, 12, 20, 1,
];

/**
 * ISO/IEC 14496-2 Table B-17 (inter TCOEF, also H.263 TCOEF): entries from index 58 have last = 1.
 */
const INTER_TCOEF = [
    2, 2, 0, 1, 15, 4, 0, 2, 21, 6, 0, 3, 23, 7, 0, 4, 31, 8, 0, 5, 37, 9, 0, 6, 36, 9, 0, 7, 33,
    10, 0, 8, 32, 10, 0, 9, 7, 11, 0, 10, 6, 11, 0, 11, 32, 11, 0, 12, 6, 3, 1, 1, 20, 6, 1, 2, 30,
    8, 1, 3, 15, 10, 1, 4, 33, 11, 1, 5, 80, 12, 1, 6, 14, 4, 2, 1, 29, 8, 2, 2, 14, 10, 2, 3, 81,
    12, 2, 4, 13, 5, 3, 1, 35, 9, 3, 2, 13, 10, 3, 3, 12, 5, 4, 1, 34, 9, 4, 2, 82, 12, 4, 3, 11, 5,
    5, 1, 12, 10, 5, 2, 83, 12, 5, 3, 19, 6, 6, 1, 11, 10, 6, 2, 84, 12, 6, 3, 18, 6, 7, 1, 10, 10,
    7, 2, 17, 6, 8, 1, 9, 10, 8, 2, 16, 6, 9, 1, 8, 10, 9, 2, 22, 7, 10, 1, 85, 12, 10, 2, 21, 7,
    11, 1, 20, 7, 12, 1, 28, 8, 13, 1, 27, 8, 14, 1, 33, 9, 15, 1, 32, 9, 16, 1, 31, 9, 17, 1, 30,
    9, 18, 1, 29, 9, 19, 1, 28, 9, 20, 1, 27, 9, 21, 1, 26, 9, 22, 1, 34, 11, 23, 1, 35, 11, 24, 1,
    86, 12, 25, 1, 87, 12, 26, 1, 7, 4, 0, 1, 25, 9, 0, 2, 5, 11, 0, 3, 15, 6, 1, 1, 4, 11, 1, 2,
    14, 6, 2, 1, 13, 6, 3, 1, 12, 6, 4, 1, 19, 7, 5, 1, 18, 7, 6, 1, 17, 7, 7, 1, 16, 7, 8, 1, 26,
    8, 9, 1, 25, 8, 10, 1, 24, 8, 11, 1, 23, 8, 12, 1, 22, 8, 13, 1, 21, 8, 14, 1, 20, 8, 15, 1, 19,
    8, 16, 1, 24, 9, 17, 1, 23, 9, 18, 1, 22, 9, 19, 1, 21, 9, 20, 1, 20, 9, 21, 1, 19, 9, 22, 1,
    18, 9, 23, 1, 17, 9, 24, 1, 7, 10, 25, 1, 6, 10, 26, 1, 5, 10, 27, 1, 4, 10, 28, 1, 36, 11, 29,
    1, 37, 11, 30, 1, 38, 11, 31, 1, 39, 11, 32, 1, 88, 12, 33, 1, 89, 12, 34, 1, 90, 12, 35, 1, 91,
    12, 36, 1, 92, 12, 37, 1, 93, 12, 38, 1, 94, 12, 39, 1, 95, 12, 40, 1,
];

/**
 * ITU-T H.263 Annex I Table I.2 (advanced INTRA coding TCOEF) has the codewords of Table B-17 with
 * runs and levels of its own: its entries count levels from 1 to each run's maximum, runs in order,
 * for last = 0 and then last = 1 (from entry 58), and entry k takes the codeword of Table B-17
 * entry ADVANCED_INTRA_CODES[k].
 */
const ADVANCED_INTRA_CODES = [
    0, 12, 18, 25, 22, 38, 36, 34, 40, 45, 47, 46, 53, 52, 51, 50, 49, 48, 55, 54, 57, 56, 41, 33,
    30, 1, 13, 43, 14, 15, 16, 17, 28, 42, 20, 37, 2, 19, 24, 21, 31, 23, 9, 3, 26, 27, 44, 29, 4,
    32, 5, 35, 6, 10, 7, 8, 39, 11, 58, 65, 69, 77, 85, 84, 89, 93, 92, 101, 61, 83, 88, 91, 63, 82,
    90, 64, 87, 100, 68, 86, 66, 99, 67, 98, 76, 97, 75, 70, 71, 72, 73, 74, 59, 81, 80, 78, 79, 62,
    60, 94, 95, 96,
];
const ADVANCED_INTRA_MAX_LEVELS = [
    [25, 7, 4, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1],
    [10, 4, 3, 3, 2, 2, 2, 2, ...new Array<number>(16).fill(1)],
];

function advancedIntraEntries(): number[] {
    const entries: number[] = [];
    for (const maxima of ADVANCED_INTRA_MAX_LEVELS)
        maxima.forEach((max, run) => {
            for (let level = 1; level <= max; level++) {
                const code = ADVANCED_INTRA_CODES[entries.length / 4]! * 4;
                entries.push(INTER_TCOEF[code]!, INTER_TCOEF[code + 1]!, run, level);
            }
        });
    return entries;
}

/**
 * Table B-23 (intra RVLC) and B-24 (inter RVLC): entries from index 103 have last = 1; escape is
 * 0000.
 */
const INTRA_RVLC = [
    6, 3, 0, 1, 7, 3, 0, 2, 10, 4, 0, 3, 9, 5, 0, 4, 20, 6, 0, 5, 21, 6, 0, 6, 52, 7, 0, 7, 116, 8,
    0, 8, 117, 8, 0, 9, 221, 9, 0, 10, 236, 9, 0, 11, 492, 10, 0, 12, 493, 10, 0, 13, 500, 10, 0,
    14, 1004, 11, 0, 15, 1005, 11, 0, 16, 1012, 11, 0, 17, 1917, 12, 0, 18, 1980, 12, 0, 19, 4029,
    13, 0, 20, 4060, 13, 0, 21, 1981, 12, 0, 22, 4061, 13, 0, 23, 8125, 14, 0, 24, 8156, 14, 0, 25,
    8157, 14, 0, 26, 8188, 15, 0, 27, 1, 4, 1, 1, 8, 5, 1, 2, 45, 7, 1, 3, 108, 8, 1, 4, 109, 8, 1,
    5, 220, 9, 1, 6, 477, 10, 1, 7, 988, 11, 1, 8, 989, 11, 1, 9, 1916, 12, 1, 10, 4028, 13, 1, 11,
    8061, 14, 1, 12, 8124, 14, 1, 13, 4, 5, 2, 1, 44, 7, 2, 2, 188, 9, 2, 3, 476, 10, 2, 4, 956, 11,
    2, 5, 957, 11, 2, 6, 3837, 13, 2, 7, 3964, 13, 2, 8, 3965, 13, 2, 9, 7933, 14, 2, 10, 8060, 14,
    2, 11, 5, 5, 3, 1, 92, 8, 3, 2, 189, 9, 3, 3, 893, 11, 3, 4, 1788, 12, 3, 5, 3836, 13, 3, 6,
    7677, 14, 3, 7, 7932, 14, 3, 8, 8189, 15, 3, 9, 12, 6, 4, 1, 93, 8, 4, 2, 445, 10, 4, 3, 1021,
    12, 4, 4, 1789, 12, 4, 5, 7165, 14, 4, 6, 13, 6, 5, 1, 125, 9, 5, 2, 764, 11, 5, 3, 1532, 12, 5,
    4, 7164, 14, 5, 5, 7676, 14, 5, 6, 28, 7, 6, 1, 380, 10, 6, 2, 765, 11, 6, 3, 1533, 12, 6, 4,
    12284, 15, 6, 5, 29, 7, 7, 1, 381, 10, 7, 2, 892, 11, 7, 3, 3581, 13, 7, 4, 12285, 15, 7, 5, 60,
    8, 8, 1, 444, 10, 8, 2, 3069, 13, 8, 3, 6141, 14, 8, 4, 61, 8, 9, 1, 509, 11, 9, 2, 3580, 13, 9,
    3, 14332, 15, 9, 4, 124, 9, 10, 1, 1020, 12, 10, 2, 252, 10, 11, 1, 3068, 13, 11, 2, 253, 10,
    12, 1, 14333, 15, 12, 2, 508, 11, 13, 1, 2044, 13, 14, 1, 2045, 13, 15, 1, 4092, 14, 16, 1,
    4093, 14, 17, 1, 6140, 14, 18, 1, 15356, 15, 19, 1, 11, 4, 0, 1, 120, 8, 0, 2, 1013, 11, 0, 3,
    4076, 13, 0, 4, 8172, 14, 0, 5, 18, 5, 1, 1, 237, 9, 1, 2, 2012, 12, 1, 3, 8173, 14, 1, 4,
    15357, 15, 1, 5, 19, 5, 2, 1, 1016, 11, 2, 2, 15868, 15, 2, 3, 24, 6, 3, 1, 2013, 12, 3, 2, 25,
    6, 4, 1, 2028, 12, 4, 2, 34, 6, 5, 1, 4077, 13, 5, 2, 35, 6, 6, 1, 4084, 13, 6, 2, 53, 7, 7, 1,
    4085, 13, 7, 2, 56, 7, 8, 1, 4088, 13, 8, 2, 57, 7, 9, 1, 4089, 13, 9, 2, 66, 7, 10, 1, 8180,
    14, 10, 2, 67, 7, 11, 1, 8181, 14, 11, 2, 121, 8, 12, 1, 8184, 14, 12, 2, 130, 8, 13, 1, 15869,
    15, 13, 2, 131, 8, 14, 1, 244, 9, 15, 1, 245, 9, 16, 1, 248, 9, 17, 1, 249, 9, 18, 1, 258, 9,
    19, 1, 259, 9, 20, 1, 501, 10, 21, 1, 504, 10, 22, 1, 505, 10, 23, 1, 514, 10, 24, 1, 515, 10,
    25, 1, 1017, 11, 26, 1, 1026, 11, 27, 1, 1027, 11, 28, 1, 2029, 12, 29, 1, 2036, 12, 30, 1,
    2037, 12, 31, 1, 2040, 12, 32, 1, 2041, 12, 33, 1, 2050, 12, 34, 1, 2051, 12, 35, 1, 4098, 13,
    36, 1, 4099, 13, 37, 1, 8185, 14, 38, 1, 8194, 14, 39, 1, 8195, 14, 40, 1, 16124, 15, 41, 1,
    16125, 15, 42, 1, 16252, 15, 43, 1, 16253, 15, 44, 1,
];
const INTER_RVLC = [
    6, 3, 0, 1, 1, 4, 0, 2, 4, 5, 0, 3, 28, 7, 0, 4, 60, 8, 0, 5, 61, 8, 0, 6, 124, 9, 0, 7, 252,
    10, 0, 8, 253, 10, 0, 9, 508, 11, 0, 10, 509, 11, 0, 11, 1020, 12, 0, 12, 2044, 13, 0, 13, 2045,
    13, 0, 14, 3068, 13, 0, 15, 3069, 13, 0, 16, 4092, 14, 0, 17, 4093, 14, 0, 18, 8188, 15, 0, 19,
    7, 3, 1, 1, 12, 6, 1, 2, 92, 8, 1, 3, 125, 9, 1, 4, 380, 10, 1, 5, 764, 11, 1, 6, 1021, 12, 1,
    7, 3580, 13, 1, 8, 6140, 14, 1, 9, 6141, 14, 1, 10, 10, 4, 2, 1, 29, 7, 2, 2, 188, 9, 2, 3, 765,
    11, 2, 4, 1532, 12, 2, 5, 7164, 14, 2, 6, 7165, 14, 2, 7, 5, 5, 3, 1, 93, 8, 3, 2, 381, 10, 3,
    3, 1533, 12, 3, 4, 3581, 13, 3, 5, 7676, 14, 3, 6, 8189, 15, 3, 7, 8, 5, 4, 1, 108, 8, 4, 2,
    892, 11, 4, 3, 3836, 13, 4, 4, 12284, 15, 4, 5, 9, 5, 5, 1, 189, 9, 5, 2, 893, 11, 5, 3, 3837,
    13, 5, 4, 13, 6, 6, 1, 444, 10, 6, 2, 1788, 12, 6, 3, 7677, 14, 6, 4, 20, 6, 7, 1, 445, 10, 7,
    2, 1789, 12, 7, 3, 12285, 15, 7, 4, 21, 6, 8, 1, 476, 10, 8, 2, 3964, 13, 8, 3, 44, 7, 9, 1,
    477, 10, 9, 2, 7932, 14, 9, 3, 45, 7, 10, 1, 956, 11, 10, 2, 52, 7, 11, 1, 1916, 12, 11, 2, 109,
    8, 12, 1, 3965, 13, 12, 2, 116, 8, 13, 1, 7933, 14, 13, 2, 117, 8, 14, 1, 8060, 14, 14, 2, 220,
    9, 15, 1, 8061, 14, 15, 2, 221, 9, 16, 1, 8124, 14, 16, 2, 236, 9, 17, 1, 14332, 15, 17, 2, 492,
    10, 18, 1, 493, 10, 19, 1, 500, 10, 20, 1, 957, 11, 21, 1, 988, 11, 22, 1, 989, 11, 23, 1, 1004,
    11, 24, 1, 1005, 11, 25, 1, 1012, 11, 26, 1, 1917, 12, 27, 1, 1980, 12, 28, 1, 1981, 12, 29, 1,
    4028, 13, 30, 1, 4029, 13, 31, 1, 4060, 13, 32, 1, 4061, 13, 33, 1, 8125, 14, 34, 1, 8156, 14,
    35, 1, 8157, 14, 36, 1, 14333, 15, 37, 1, 15356, 15, 38, 1, 11, 4, 0, 1, 120, 8, 0, 2, 1013, 11,
    0, 3, 4076, 13, 0, 4, 8172, 14, 0, 5, 18, 5, 1, 1, 237, 9, 1, 2, 2012, 12, 1, 3, 8173, 14, 1, 4,
    15357, 15, 1, 5, 19, 5, 2, 1, 1016, 11, 2, 2, 15868, 15, 2, 3, 24, 6, 3, 1, 2013, 12, 3, 2, 25,
    6, 4, 1, 2028, 12, 4, 2, 34, 6, 5, 1, 4077, 13, 5, 2, 35, 6, 6, 1, 4084, 13, 6, 2, 53, 7, 7, 1,
    4085, 13, 7, 2, 56, 7, 8, 1, 4088, 13, 8, 2, 57, 7, 9, 1, 4089, 13, 9, 2, 66, 7, 10, 1, 8180,
    14, 10, 2, 67, 7, 11, 1, 8181, 14, 11, 2, 121, 8, 12, 1, 8184, 14, 12, 2, 130, 8, 13, 1, 15869,
    15, 13, 2, 131, 8, 14, 1, 244, 9, 15, 1, 245, 9, 16, 1, 248, 9, 17, 1, 249, 9, 18, 1, 258, 9,
    19, 1, 259, 9, 20, 1, 501, 10, 21, 1, 504, 10, 22, 1, 505, 10, 23, 1, 514, 10, 24, 1, 515, 10,
    25, 1, 1017, 11, 26, 1, 1026, 11, 27, 1, 1027, 11, 28, 1, 2029, 12, 29, 1, 2036, 12, 30, 1,
    2037, 12, 31, 1, 2040, 12, 32, 1, 2041, 12, 33, 1, 2050, 12, 34, 1, 2051, 12, 35, 1, 4098, 13,
    36, 1, 4099, 13, 37, 1, 8185, 14, 38, 1, 8194, 14, 39, 1, 8195, 14, 40, 1, 16124, 15, 41, 1,
    16125, 15, 42, 1, 16252, 15, 43, 1, 16253, 15, 44, 1,
];

export interface CoefficientTable {
    /** `bits`-wide lookup including the sign bit that follows each code. */
    readonly lookup: Int32Array;
    readonly bits: number;
    /** Largest level per `last * 64 + run`, for escape type 1. */
    readonly maxLevel: Uint8Array;
    /** Largest run per `last * 64 + level`, for escape type 2. */
    readonly maxRun: Uint8Array;
}

export const COEFFICIENT_BITS = 13;

function coefficientTable(
    entries: readonly number[],
    lastStart: number,
    bits: number,
    escapeCode: number,
    escapeLength: number,
): CoefficientTable {
    const lookup = new Int32Array(1 << bits);
    const maxLevel = new Uint8Array(128);
    const maxRun = new Uint8Array(128);
    for (let index = 0; index < entries.length / 4; index++) {
        const code = entries[index * 4];
        const length = entries[index * 4 + 1] + 1;
        const run = entries[index * 4 + 2];
        const level = entries[index * 4 + 3];
        const last = index >= lastStart ? 1 : 0;
        maxLevel[last * 64 + run] = Math.max(maxLevel[last * 64 + run], level);
        maxRun[last * 64 + level] = Math.max(maxRun[last * 64 + level], run);
        const shift = bits - length;
        for (let sign = 0; sign < 2; sign++) {
            const base = ((code << 1) | sign) << shift;
            const value = ((sign ? -level : level) << 12) | (run << 6) | (last << 5) | length;
            lookup.fill(value, base, base + (1 << shift));
        }
    }
    const escapeShift = bits - escapeLength;
    lookup.fill(ESCAPE, escapeCode << escapeShift, (escapeCode + 1) << escapeShift);
    return { lookup, bits, maxLevel, maxRun };
}

export const INTRA_COEFFICIENTS = coefficientTable(INTRA_TCOEF, 67, COEFFICIENT_BITS, 3, 7);
export const INTER_COEFFICIENTS = coefficientTable(INTER_TCOEF, 58, COEFFICIENT_BITS, 3, 7);
export const ADVANCED_INTRA_COEFFICIENTS = coefficientTable(
    advancedIntraEntries(),
    58,
    COEFFICIENT_BITS,
    3,
    7,
);

let reversibleTables: [CoefficientTable, CoefficientTable] | undefined;

/** Intra and inter RVLC lookups (16-bit), built on first use by data partitioned streams. */
export function reversibleCoefficients(): [CoefficientTable, CoefficientTable] {
    reversibleTables ??= [
        coefficientTable(INTRA_RVLC, 103, 16, 0, 4),
        coefficientTable(INTER_RVLC, 103, 16, 0, 4),
    ];
    return reversibleTables;
}

/** Builds a lookup from (code, length) pairs whose values are their positions in the list. */
function vlcTable(pairs: readonly number[], bits: number): Int32Array {
    const table = new Int32Array(1 << bits);
    for (let value = 0; value < pairs.length / 2; value++) {
        const length = pairs[value * 2 + 1];
        if (length === 0) continue;
        const shift = bits - length;
        const base = pairs[value * 2] << shift;
        table.fill((value << 5) | length, base, base + (1 << shift));
    }
    return table;
}

export const INTRA_MCBPC_BITS = 9;

/** Table B-6; value bit 2 flags dquant, bits 0-1 carry cbpc, 8 is stuffing. */
export const INTRA_MCBPC = vlcTable(
    [1, 1, 1, 3, 2, 3, 3, 3, 1, 4, 1, 6, 2, 6, 3, 6, 1, 9],
    INTRA_MCBPC_BITS,
);
export const MCBPC_INTRA_STUFFING = 8;

export const INTER_MCBPC_BITS = 9;

/**
 * Table B-7; value bit 2 flags intra, bit 3 dquant, bit 4 inter4v, bits 0-1 cbpc, 20 is stuffing.
 */
export const INTER_MCBPC = vlcTable(
    [
        1, 1, 3, 4, 2, 4, 5, 6, 3, 5, 4, 8, 3, 8, 3, 7, 3, 3, 7, 7, 6, 7, 5, 9, 4, 6, 4, 9, 3, 9, 2,
        9, 2, 3, 5, 7, 4, 7, 5, 8, 1, 9,
    ],
    INTER_MCBPC_BITS,
);
export const MCBPC_INTER_STUFFING = 20;

export const B_MBTYPE_BITS = 10;

/**
 * MBTYPE of H.263 B pictures (Annex O) as ffmpeg reads it: 0-2 direct, 3-5 forward, 6-8 backward
 * and 9-11 bidirectional prediction, each without coefficients, with CBPC and CBPY, and with DQUANT
 * as well; 12 is stuffing, 13 and 14 are intra with CBPC and CBPY, without and with DQUANT.
 */
export const B_MBTYPE = vlcTable(
    [1, 1, 3, 3, 1, 5, 4, 4, 5, 4, 6, 6, 2, 4, 3, 4, 7, 6, 4, 6, 5, 6, 1, 6, 1, 10, 1, 7, 1, 8],
    B_MBTYPE_BITS,
);
export const B_MBTYPE_STUFFING = 12;

export const CBPY_BITS = 6;

/** Table B-8 indexed by the intra cbpy value; inter macroblocks invert all four bits. */
export const CBPY = vlcTable(
    [
        3, 4, 5, 5, 4, 5, 9, 4, 3, 5, 7, 4, 2, 6, 11, 4, 2, 5, 3, 6, 5, 4, 10, 4, 4, 4, 8, 4, 6, 4,
        3, 2,
    ],
    CBPY_BITS,
);

export const MV_BITS = 13;

/** Table B-12 with the sign bit folded in: value is the signed motion code plus 32. */
export const MV_CODES = (() => {
    const codes = [
        1, 1, 1, 2, 1, 3, 1, 4, 3, 6, 5, 7, 4, 7, 3, 7, 11, 9, 10, 9, 9, 9, 17, 10, 16, 10, 15, 10,
        14, 10, 13, 10, 12, 10, 11, 10, 10, 10, 9, 10, 8, 10, 7, 10, 6, 10, 5, 10, 4, 10, 7, 11, 6,
        11, 5, 11, 4, 11, 3, 11, 2, 11, 3, 12, 2, 12,
    ];
    const table = new Int32Array(1 << MV_BITS);
    for (let magnitude = 0; magnitude <= 32; magnitude++) {
        const code = codes[magnitude * 2];
        const length = codes[magnitude * 2 + 1];
        for (let sign = 0; sign < (magnitude ? 2 : 1); sign++) {
            const total = magnitude ? length + 1 : length;
            const prefix = magnitude ? (code << 1) | sign : code;
            const shift = MV_BITS - total;
            const value = (sign ? 32 - magnitude : 32 + magnitude) << 5;
            table.fill(value | total, prefix << shift, (prefix + 1) << shift);
        }
    }
    return table;
})();

export const DC_SIZE_BITS = 12;

/** Tables B-13 and B-14: dct_dc_size for luminance and chrominance. */
export const DC_SIZE_LUMA = vlcTable(
    [3, 3, 3, 2, 2, 2, 2, 3, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1, 8, 1, 9, 1, 10, 1, 11],
    DC_SIZE_BITS,
);
export const DC_SIZE_CHROMA = vlcTable(
    [3, 2, 2, 2, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1, 8, 1, 9, 1, 10, 1, 11, 1, 12],
    DC_SIZE_BITS,
);

export const SPRITE_TRAJECTORY_BITS = 12;

/** Table B-33: dmv_length codes are canonical for these lengths. */
export const SPRITE_TRAJECTORY = (() => {
    const lengths = [2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const pairs: number[] = [];
    let code = 0;
    let previous = lengths[0];
    for (const length of lengths) {
        code <<= length - previous;
        previous = length;
        pairs.push(code++, length);
    }
    return vlcTable(pairs, SPRITE_TRAJECTORY_BITS);
})();

export const ALTERNATE_HORIZONTAL = Uint8Array.of(
    0,
    1,
    2,
    3,
    8,
    9,
    16,
    17,
    10,
    11,
    4,
    5,
    6,
    7,
    15,
    14,
    13,
    12,
    19,
    18,
    24,
    25,
    32,
    33,
    26,
    27,
    20,
    21,
    22,
    23,
    28,
    29,
    30,
    31,
    34,
    35,
    40,
    41,
    48,
    49,
    42,
    43,
    36,
    37,
    38,
    39,
    44,
    45,
    46,
    47,
    50,
    51,
    56,
    57,
    58,
    59,
    52,
    53,
    54,
    55,
    60,
    61,
    62,
    63,
);

/** Default quantiser matrices in natural (row-major) order, ISO/IEC 14496-2 6.3.3. */
export const DEFAULT_INTRA_MATRIX = Uint8Array.of(
    8,
    17,
    18,
    19,
    21,
    23,
    25,
    27,
    17,
    18,
    19,
    21,
    23,
    25,
    27,
    28,
    20,
    21,
    22,
    23,
    24,
    26,
    28,
    30,
    21,
    22,
    23,
    24,
    26,
    28,
    30,
    32,
    22,
    23,
    24,
    26,
    28,
    30,
    32,
    35,
    23,
    24,
    26,
    28,
    30,
    32,
    35,
    38,
    25,
    26,
    28,
    30,
    32,
    35,
    38,
    41,
    27,
    28,
    30,
    32,
    35,
    38,
    41,
    45,
);
export const DEFAULT_INTER_MATRIX = Uint8Array.of(
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    19,
    20,
    21,
    22,
    23,
    24,
    26,
    27,
    20,
    21,
    22,
    23,
    25,
    26,
    27,
    28,
    21,
    22,
    23,
    24,
    26,
    27,
    28,
    30,
    22,
    23,
    24,
    26,
    27,
    28,
    30,
    31,
    23,
    24,
    25,
    27,
    28,
    30,
    31,
    33,
);

/** dc_scaler by quantiser_scale, Table 7-1. */
export const LUMA_DC_SCALE = Uint8Array.of(
    0,
    8,
    8,
    8,
    8,
    10,
    12,
    14,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    34,
    36,
    38,
    40,
    42,
    44,
    46,
);
export const CHROMA_DC_SCALE = Uint8Array.of(
    0,
    8,
    8,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    14,
    14,
    15,
    15,
    16,
    16,
    17,
    17,
    18,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
);

/** Running quantiser below which intra DC uses its own VLC, by intra_dc_vlc_thr (Table 6-21). */
export const INTRA_DC_THRESHOLD = Uint8Array.of(99, 13, 15, 17, 19, 21, 23, 0);

/** Pixel aspect ratios by aspect_ratio_info (Table 6-12); 0 marks forbidden or reserved codes. */
export const PIXEL_ASPECT: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 1],
    [12, 11],
    [10, 11],
    [16, 11],
    [40, 33],
];

/**
 * Rounding of the inter4v chroma vector: a component whose four luma vectors sum to `s` half
 * samples becomes `(s >> 3) + CHROMA_4MV_ROUND[s & 15]` chroma half samples.
 */
export const CHROMA_4MV_ROUND = Uint8Array.of(0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1);
