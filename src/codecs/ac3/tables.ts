/**
 * Tables of ATSC A/52 (ETSI TS 102 366) bit allocation and decoding, held as their runs and steps
 * where the standard's tables follow one, and expanded once when the module loads.
 */

/** First bin of each of the 50 critical bands and the end bin (Table 7.12, bndtab). */
export const BAND_START = new Uint8Array(51);

/** The critical band of each bin (Table 7.13, masktab). */
export const BIN_BAND = new Uint8Array(256);
{
    let band = 0;
    let bin = 0;
    for (const [count, size] of [
        [28, 1],
        [7, 3],
        [6, 6],
        [4, 12],
        [5, 24],
    ] as const)
        for (let index = 0; index < count; index++, band++) {
            BAND_START[band] = bin;
            BIN_BAND.fill(band, bin, bin + size);
            bin += size;
        }
    BAND_START[50] = bin;
}

/** Log-addition table (Table 7.14, latab): how many entries hold each value from 64 down to 0. */
const LOG_ADD_RUNS = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2,
    2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 8, 8, 11, 14, 19,
    32, 50,
];
export const LOG_ADD = new Uint8Array(260);
{
    let at = 0;
    LOG_ADD_RUNS.forEach((count, index) => {
        LOG_ADD.fill(64 - index, at, at + count);
        at += count;
    });
}

/**
 * Hearing threshold per band (Table 7.15, hth) at 48, 44.1 and 32 kHz, in sixteenths of the PSD
 * unit: band b at fscod f is HEARING_THRESHOLD[b * 3 + f] * 16.
 */
const HEARING_THRESHOLD_16 = [
    77, 79, 88, 77, 79, 88, 68, 70, 75, 64, 65, 69, 62, 62, 66, 60, 61, 63, 59, 60, 62, 59, 59, 61,
    58, 59, 60, 58, 58, 59, 58, 58, 59, 58, 58, 59, 58, 58, 58, 57, 58, 58, 57, 57, 58, 57, 57, 58,
    56, 57, 58, 56, 56, 58, 55, 56, 58, 55, 56, 58, 54, 55, 57, 54, 55, 57, 53, 54, 57, 53, 54, 57,
    52, 53, 56, 52, 53, 56, 51, 52, 56, 50, 52, 55, 49, 50, 54, 48, 49, 53, 47, 48, 52, 47, 47, 51,
    47, 47, 50, 47, 47, 49, 48, 47, 48, 49, 48, 47, 52, 50, 47, 57, 53, 47, 62, 57, 48, 66, 62, 49,
    70, 66, 51, 73, 69, 53, 74, 74, 60, 70, 73, 65, 68, 70, 71, 68, 68, 74, 82, 72, 70, 128, 99, 68,
    132, 132, 69, 132, 132, 78,
];
export const HEARING_THRESHOLD = Int16Array.from(HEARING_THRESHOLD_16, value => value * 16);

/** Bit allocation pointer by masked PSD address (Table 7.16, baptab). */
export const BAP_TABLE = Uint8Array.of(
    0,
    1,
    1,
    1,
    1,
    1,
    2,
    2,
    3,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    6,
    6,
    7,
    7,
    7,
    7,
    8,
    8,
    8,
    8,
    9,
    9,
    9,
    9,
    10,
    10,
    10,
    10,
    11,
    11,
    11,
    11,
    12,
    12,
    12,
    12,
    13,
    13,
    13,
    13,
    14,
    14,
    14,
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
    15,
    15,
    15,
    15,
);

/** Parametric bit allocation codes (Tables 7.6 to 7.11). */
export const SLOW_DECAY = [0x0f, 0x11, 0x13, 0x15];
export const FAST_DECAY = [0x3f, 0x53, 0x67, 0x7b];
export const SLOW_GAIN = [0x540, 0x4d8, 0x478, 0x410];
export const DB_PER_BIT = [0x000, 0x700, 0x900, 0xb00];
export const FLOOR = [0x2f0, 0x2b0, 0x270, 0x230, 0x1f0, 0x170, 0x0f0, -0x800];
export const FAST_GAIN = [0x080, 0x100, 0x180, 0x200, 0x280, 0x300, 0x380, 0x400];

/** Bits of the asymmetric mantissas of bap 6 to 15 (Table 7.18). */
export const ASYMMETRIC_BITS = [0, 0, 0, 0, 0, 0, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16];

/** First bins of the rematrixing bands and the end (7.5.2). */
export const REMATRIX_BANDS = [13, 25, 37, 61, 253];
