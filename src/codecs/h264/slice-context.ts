import type { Pps, SliceHeader, Sps } from './headers';
import type { Picture, RefEntry } from './picture';
import { levelScale4x4, levelScale8x8, LEVEL_SCALE_4X4_FLAT, ZIGZAG_4X4 } from './tables';
import { ZIGZAG_8X8 } from '../shared/dct-scan';

/**
 * LevelScale tables of a picture: six 4x4 lists (intra Y, Cb, Cr, inter Y, Cb, Cr) and two 8x8
 * lists, rows qP % 6. `dequant4` and `dequant8` hold the same lists per qP (rows of 16 or 64 raster
 * positions) with the qP / 6 shift folded in, so that a coefficient scales as (c * dequant + 32) >>
 * 6 (8.5.12.1, 8.5.13.1).
 */
export interface ScalingTables {
    readonly level4: readonly Int32Array[];
    readonly level8: readonly Int32Array[];
    readonly dequant4: readonly Int32Array[];
    readonly dequant8: readonly Int32Array[];
}

/**
 * Scale that leaves levels unchanged under (c * scale + 32) >> 6, for DC blocks transformed before
 * scaling.
 */
export const UNIT_SCALE = new Int32Array(16).fill(64);

/**
 * Per-qP scales: 4x4 lists scale by LevelScale << (qP / 6 + 2), 8x8 lists by LevelScale << (qP /
 * 6).
 */
function dequantTable(level: Int32Array, size: number, extraShift: number): Int32Array {
    const out = new Int32Array(52 * size);
    for (let qp = 0; qp < 52; qp++) {
        const row = (qp % 6) * size;
        const shift = Math.floor(qp / 6) + extraShift;
        for (let i = 0; i < size; i++) out[qp * size + i] = level[row + i] << shift;
    }
    return out;
}

function scalingTables(level4: Int32Array[], level8: Int32Array[]): ScalingTables {
    const cache = new Map<Int32Array, Int32Array>();
    const dequant = (level: Int32Array, size: number, extraShift: number) => {
        let table = cache.get(level);
        if (!table) cache.set(level, (table = dequantTable(level, size, extraShift)));
        return table;
    };
    return {
        level4,
        level8,
        dequant4: level4.map(level => dequant(level, 16, 2)),
        dequant8: level8.map(level => dequant(level, 64, 0)),
    };
}

const FLAT_4X4 = LEVEL_SCALE_4X4_FLAT.map(row => Int32Array.from(row));
const FLAT_TABLES: ScalingTables = (() => {
    const flat4 = new Int32Array(6 * 16);
    for (let m = 0; m < 6; m++) flat4.set(FLAT_4X4[m], m * 16);
    const flat8 = levelScale8x8(new Uint8Array(64).fill(16));
    return scalingTables([flat4, flat4, flat4, flat4, flat4, flat4], [flat8, flat8]);
})();

/**
 * Builds the LevelScale tables from scaling lists in coded order (8.5.6, 8.5.9), or the flat tables
 * for null.
 */
export function buildScalingTables(lists: Uint8Array[] | null): ScalingTables {
    if (!lists) return FLAT_TABLES;
    const level4: Int32Array[] = [];
    for (let i = 0; i < 6; i++) {
        const raster = new Uint8Array(16);
        for (let k = 0; k < 16; k++) raster[ZIGZAG_4X4[k]] = lists[i][k];
        level4.push(levelScale4x4(raster));
    }
    const level8: Int32Array[] = [];
    for (let i = 6; i < 8; i++) {
        const raster = new Uint8Array(64);
        for (let k = 0; k < 64; k++) raster[ZIGZAG_8X8[k]] = lists[i][k];
        level8.push(levelScale8x8(raster));
    }
    return scalingTables(level4, level8);
}

/** Everything the macroblock layer needs about the slice being decoded. */
export interface SliceContext {
    readonly header: SliceHeader;
    readonly sps: Sps;
    readonly pps: Pps;
    readonly sliceNum: number;
    readonly picture: Picture;
    /** PICT_TOP, PICT_BOTTOM or PICT_FRAME. */
    readonly structure: number;
    readonly mbaff: boolean;
    /** RefPicList0 and RefPicList1 of the slice (field lists for field pictures). */
    readonly refList: readonly [readonly RefEntry[], readonly RefEntry[]];
    /**
     * Field reference lists of MBAFF field macroblocks by parity (0 top, 1 bottom), or null
     * (8.4.2.1).
     */
    readonly fieldRefList:
        | readonly [
              readonly [readonly RefEntry[], readonly RefEntry[]],
              readonly [readonly RefEntry[], readonly RefEntry[]],
          ]
        | null;
    readonly scaling: ScalingTables;
    /**
     * Implicit bi-prediction weight w1 per refIdxL0 * 32 + refIdxL1 (w0 = 64 - w1); frame and per
     * field parity.
     */
    readonly implicitWeights: Int8Array | null;
    readonly implicitWeightsField: readonly [Int8Array, Int8Array] | null;
    /** DistScaleFactor per refIdxL0 for temporal direct prediction; frame and per field parity. */
    readonly distScale: Int32Array;
    readonly distScaleField: readonly [Int32Array, Int32Array] | null;
    /** Parity of the colocated field when a frame predicts from a field pair (0 top, 1 bottom). */
    readonly colParity: number;
    /**
     * Row adjustment to the colocated macroblock of a field picture whose RefPicList1[0] has the
     * other parity.
     */
    readonly colFieldOffset: number;
}

function clipInt8(v: number): number {
    return v < -128 ? -128 : v > 127 ? 127 : v;
}

/** DistScaleFactor (8.4.1.2.3) of one reference pair; 256 when the distances are unusable. */
function distScaleFactor(curPoc: number, poc0: number, poc1: number, longTerm: boolean): number {
    const td = clipInt8(poc1 - poc0);
    if (td === 0 || longTerm) return 256;
    const tb = clipInt8(curPoc - poc0);
    const tx = Math.trunc((16384 + (Math.abs(td) >> 1)) / td);
    const factor = (tb * tx + 32) >> 6;
    return factor < -1024 ? -1024 : factor > 1023 ? 1023 : factor;
}

export function buildDistScale(
    curPoc: number,
    list0: readonly RefEntry[],
    ref1: RefEntry | undefined,
): Int32Array {
    const out = new Int32Array(Math.max(1, list0.length));
    for (let i = 0; i < list0.length; i++) {
        out[i] = ref1 ? distScaleFactor(curPoc, list0[i].poc, ref1.poc, list0[i].longTerm) : 256;
    }
    return out;
}

/** Implicit weights (8.4.2.3.1): w1 per pair, 32 when the default applies. */
export function buildImplicitWeights(
    curPoc: number,
    list0: readonly RefEntry[],
    list1: readonly RefEntry[],
): Int8Array {
    const out = new Int8Array(32 * 32).fill(32);
    for (let i = 0; i < list0.length && i < 32; i++) {
        for (let j = 0; j < list1.length && j < 32; j++) {
            const r0 = list0[i];
            const r1 = list1[j];
            if (r0.longTerm || r1.longTerm) continue;
            const td = clipInt8(r1.poc - r0.poc);
            if (td === 0) continue;
            const tb = clipInt8(curPoc - r0.poc);
            const tx = Math.trunc((16384 + (Math.abs(td) >> 1)) / td);
            let factor = (tb * tx + 32) >> 6;
            factor = factor < -1024 ? -1024 : factor > 1023 ? 1023 : factor;
            const w1 = factor >> 2;
            if (w1 < -64 || w1 > 128) continue;
            out[i * 32 + j] = w1;
        }
    }
    return out;
}

/**
 * Field reference lists of MBAFF field macroblocks (8.4.2.1): same-parity field first for each
 * frame entry.
 */
export function fieldListsOf(
    list: readonly RefEntry[],
    parity: number,
    entryOf: (pic: Picture, parity: number, longTerm: boolean) => RefEntry,
): RefEntry[] {
    const out: RefEntry[] = [];
    for (const entry of list) {
        out.push(
            entryOf(entry.pic, parity, entry.longTerm),
            entryOf(entry.pic, parity === 1 ? 2 : 1, entry.longTerm),
        );
    }
    return out;
}
