export interface QuantClass {
    readonly nlevels: number;
    readonly grouped: boolean;
    readonly sampleBits: number;
    readonly wordBits: number;
    readonly a: number;
    readonly b: number;
    readonly snrDb: number;
}
export declare const QUANT_CLASSES: ReadonlyMap<number, QuantClass>;
export interface AllocTable {
    readonly sblimit: number;
    readonly rows: ReadonlyArray<readonly number[]>;
    readonly nbal: readonly number[];
}
export declare const TABLE_B2A: AllocTable;
export declare const TABLE_B2B: AllocTable;
export declare const TABLE_B2C: AllocTable;
export declare const TABLE_B2D: AllocTable;
export declare const TABLE_LSF: AllocTable;
export declare function chooseAllocTable(sampleRate: number, bitrateKbps: number, channels: number): AllocTable;
export declare const SCF_VALUES: Float64Array<ArrayBuffer>;
export declare function requantize(code: number, nlevels: number): number;
export declare const SYNTHESIS_WINDOW: Float64Array;
