import { ANALYSIS_WIN } from './mpeg-common.js';
const QUANT_SNR_DB = [
    [3, 7.0],
    [5, 11.0],
    [7, 16.0],
    [9, 20.84],
    [15, 25.28],
    [31, 31.59],
    [63, 37.75],
    [127, 43.84],
    [255, 49.89],
    [511, 55.93],
    [1023, 61.96],
    [2047, 67.98],
    [4095, 74.01],
    [8191, 80.03],
    [16383, 86.05],
    [32767, 92.01],
    [65535, 98.01],
];
export const QUANT_CLASSES = (() => {
    const classes = new Map();
    for (const [nlevels, snrDb] of QUANT_SNR_DB) {
        const grouped = nlevels === 3 || nlevels === 5 || nlevels === 9;
        const sampleBits = Math.ceil(Math.log2(nlevels + 1));
        const wordBits = nlevels === 3 ? 5 : nlevels === 5 ? 7 : nlevels === 9 ? 10 : sampleBits;
        const a = nlevels / (1 << sampleBits);
        classes.set(nlevels, { nlevels, grouped, sampleBits, wordBits, a, b: a - 1, snrDb });
    }
    return classes;
})();
const ROW_1A = [0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535];
const ROW_1B = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535];
const ROW_1C = [0, 3, 5, 7, 9, 15, 31, 65535];
const ROW_1D = [0, 3, 5, 65535];
const ROW_3A = [0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767];
const ROW_3B = [0, 3, 5, 9, 15, 31, 63, 127];
const ROW_LSF_A = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383];
const ROW_LSF_C = [0, 3, 5, 9];
function makeAllocTable(sblimit, rows) {
    return { sblimit, rows, nbal: rows.map(row => Math.log2(row.length)) };
}
const GRID_AB = [
    ROW_1A,
    ROW_1A,
    ROW_1A,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1B,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1C,
    ROW_1D,
    ROW_1D,
    ROW_1D,
    ROW_1D,
    ROW_1D,
    ROW_1D,
    ROW_1D,
];
const GRID_CD = [
    ROW_3A,
    ROW_3A,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
];
const GRID_LSF = [
    ROW_LSF_A,
    ROW_LSF_A,
    ROW_LSF_A,
    ROW_LSF_A,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_3B,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
    ROW_LSF_C,
];
export const TABLE_B2A = makeAllocTable(27, GRID_AB.slice(0, 27));
export const TABLE_B2B = makeAllocTable(30, GRID_AB);
export const TABLE_B2C = makeAllocTable(8, GRID_CD.slice(0, 8));
export const TABLE_B2D = makeAllocTable(12, GRID_CD);
export const TABLE_LSF = makeAllocTable(30, GRID_LSF);
export function chooseAllocTable(sampleRate, bitrateKbps, channels) {
    const perChannel = bitrateKbps / channels;
    if (perChannel === 32 || perChannel === 48) {
        return sampleRate === 32000 ? TABLE_B2D : TABLE_B2C;
    }
    if (sampleRate === 48000 || perChannel <= 80)
        return TABLE_B2A;
    return TABLE_B2B;
}
export const SCF_VALUES = new Float64Array(63);
for (let i = 0; i < 63; i++)
    SCF_VALUES[i] = Math.pow(2, 1 - i / 3);
export function requantize(code, nlevels) {
    return ((code - (nlevels >> 1)) * 2) / nlevels;
}
export const SYNTHESIS_WINDOW = new Float64Array(512);
for (let i = 0; i < 512; i++)
    SYNTHESIS_WINDOW[i] = 32 * ANALYSIS_WIN[i];
