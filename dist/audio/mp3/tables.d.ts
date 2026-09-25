export declare const MDCT_COS: Float64Array<ArrayBuffer>;
export declare const MDCT_WIN: Float64Array<ArrayBuffer>;
export declare const ALIAS_CS: Float64Array<ArrayBuffer>;
export declare const ALIAS_CA: Float64Array<ArrayBuffer>;
export declare const SFB_L: Record<number, number[]>;
export interface PairTableSpec {
    readonly id: number;
    readonly xlen: number;
    readonly linbits: number;
    readonly hb: readonly number[];
    readonly lens: readonly number[];
}
export interface HTable {
    readonly id: number;
    readonly xlen: number;
    readonly linbits: number;
    readonly maxval: number;
    readonly entries: ReadonlyArray<readonly [number, number]>;
}
export declare const PAIR_TABLE_SPECS: readonly PairTableSpec[];
export declare const HTABLES: (HTable | null)[];
export declare const PAIR_TABLES: HTable[];
export declare const HT0: HTable;
export declare const HT32: readonly (readonly [number, number])[];
export declare const HT33: readonly (readonly [number, number])[];
export declare const SFC_SLEN: ReadonlyArray<readonly [number, number]>;
export declare const LONG_BLOCK_SCF_SPLIT = 11;
export declare const LONG_BLOCK_SCF_BANDS = 21;
export declare const GLOBAL_GAIN_BIAS = 210;
export declare const SR_TAB: number[];
export declare const BR_TAB: number[];
export declare class Bits {
    readonly buf: Uint8Array;
    pos: number;
    constructor(buf: Uint8Array, byteStart: number);
    put(value: number, bitCount: number): void;
}
export declare function mdct18(cur: Float64Array, prev: Float64Array, out: Float64Array): void;
export declare const SFB_S: Record<number, number[]>;
export declare const SHORT_BLOCK_SCF_BANDS = 36;
export declare const SHORT_BLOCK_SCF_SPLIT = 18;
export declare const MIXED_BLOCK_SCF_BANDS = 35;
export declare const MIXED_BLOCK_SCF_SPLIT = 17;
export declare const MDCT_WIN_START: Float64Array<ArrayBuffer>;
export declare const MDCT_WIN_STOP: Float64Array<ArrayBuffer>;
export declare const MDCT_WIN_SHORT12: Float64Array<ArrayBuffer>;
export declare const MDCT_COS12: Float64Array<ArrayBuffer>;
export declare function mdctGranule(cur: Float64Array, prev: Float64Array, out: Float64Array, blockType: 0 | 1 | 2 | 3): void;
export declare function applyFrequencyInversion(subs: Float64Array, off: number): void;
export declare function applyAntialias(spec: Float64Array, off: number): void;
export declare function tableMaxValue(table: HTable): number;
export declare function candidateTables(maxval: number): HTable[];
