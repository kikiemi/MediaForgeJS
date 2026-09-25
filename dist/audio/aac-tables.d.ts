export declare const AAC_SAMPLE_RATES: readonly number[];
export declare const SWB_OFFSET_1024: readonly Uint16Array[];
export declare const SF_HUFF_BITS: Uint8Array;
export declare const SF_HUFF_CODES: Uint32Array;
export interface SpectralBook {
    readonly dim: number;
    readonly lav: number;
    readonly range: number;
    readonly signed: boolean;
    readonly codes: Uint16Array;
    readonly bits: Uint8Array;
}
export declare const SPECTRAL_BOOKS: readonly (SpectralBook | null)[];
export declare const SWB_OFFSET_128: readonly Uint16Array[];
export declare const TNS_MAX_BANDS_1024: Uint8Array;
export declare const TNS_MAX_BANDS_128: Uint8Array;
