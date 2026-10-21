import { ANALYSIS_WIN } from './common';

export interface QuantClass {
    readonly nlevels: number;
    readonly grouped: boolean;
    readonly sampleBits: number;
    readonly wordBits: number;
    readonly a: number;
    readonly b: number;
    readonly snrDb: number;
}

const QUANT_SNR_DB: ReadonlyArray<readonly [number, number]> = [
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

export const QUANT_CLASSES: ReadonlyMap<number, QuantClass> = (() => {
    const classes = new Map<number, QuantClass>();
    for (const [nlevels, snrDb] of QUANT_SNR_DB) {
        const grouped = nlevels === 3 || nlevels === 5 || nlevels === 9;
        const sampleBits = Math.ceil(Math.log2(nlevels + 1));
        const wordBits = nlevels === 3 ? 5 : nlevels === 5 ? 7 : nlevels === 9 ? 10 : sampleBits;
        const a = nlevels / (1 << sampleBits);
        classes.set(nlevels, { nlevels, grouped, sampleBits, wordBits, a, b: a - 1, snrDb });
    }
    return classes;
})();

const ROW_1A: readonly number[] = [
    0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535,
];
const ROW_1B: readonly number[] = [
    0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535,
];
const ROW_1C: readonly number[] = [0, 3, 5, 7, 9, 15, 31, 65535];
const ROW_1D: readonly number[] = [0, 3, 5, 65535];
const ROW_3A: readonly number[] = [
    0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767,
];
const ROW_3B: readonly number[] = [0, 3, 5, 9, 15, 31, 63, 127];
const ROW_LSF_A: readonly number[] = [
    0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383,
];
const ROW_LSF_C: readonly number[] = [0, 3, 5, 9];

export interface AllocTable {
    readonly sblimit: number;
    readonly rows: ReadonlyArray<readonly number[]>;
    readonly nbal: readonly number[];
}

function makeAllocTable(sblimit: number, rows: ReadonlyArray<readonly number[]>): AllocTable {
    return { sblimit, rows, nbal: rows.map(row => Math.log2(row.length)) };
}

const GRID_AB: ReadonlyArray<readonly number[]> = [
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
const GRID_CD: ReadonlyArray<readonly number[]> = [
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
const GRID_LSF: ReadonlyArray<readonly number[]> = [
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

const TABLE_B2A = makeAllocTable(27, GRID_AB.slice(0, 27));
const TABLE_B2B = makeAllocTable(30, GRID_AB);
const TABLE_B2C = makeAllocTable(8, GRID_CD.slice(0, 8));
const TABLE_B2D = makeAllocTable(12, GRID_CD);
export const TABLE_LSF = makeAllocTable(30, GRID_LSF);

/**
 * ISO 11172-3 Table B.2 selection by bit rate per channel (integer division, as encoders and ffmpeg
 * compute it, so stereo at 56 or 80 kbit/s also falls into the low-rate tables): B.2a for 56..80
 * kbit/s and for 48 kHz above, B.2b for 96 kbit/s and up at 32/44.1 kHz, B.2c at or below 48 kbit/s
 * except at 32 kHz, otherwise B.2d.
 */
export function chooseAllocTable(
    sampleRate: number,
    bitrateKbps: number,
    channels: number,
): AllocTable {
    const perChannel = Math.floor(bitrateKbps / channels);
    if ((sampleRate === 48000 && perChannel >= 56) || (perChannel >= 56 && perChannel <= 80))
        return TABLE_B2A;
    if (sampleRate !== 48000 && perChannel >= 96) return TABLE_B2B;
    if (sampleRate !== 32000 && perChannel <= 48) return TABLE_B2C;
    return TABLE_B2D;
}

export const SCF_VALUES = new Float64Array(63);
for (let i = 0; i < 63; i++) SCF_VALUES[i] = Math.pow(2, 1 - i / 3);

export function requantize(code: number, nlevels: number): number {
    return ((code - (nlevels >> 1)) * 2) / nlevels;
}

export const SYNTHESIS_WINDOW: Float64Array = new Float64Array(512);
for (let i = 0; i < 512; i++) SYNTHESIS_WINDOW[i] = 32 * ANALYSIS_WIN[i];
