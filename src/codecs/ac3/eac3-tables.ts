/**
 * Tables of E-AC-3 (ETSI TS 102 366 Annex E): the adaptive hybrid transform's vector quantization
 * and gain-adaptive quantization, the frame exponent strategies and the spectral extension
 * defaults, held compactly and expanded once when the module loads.
 */

/** Frame exponent strategy combinations (Table E2.14): six base-4 digits, block 0 first. */
const FRAME_STRATEGIES = [
    1024, 1027, 1032, 1039, 2080, 2083, 2104, 2111, 2112, 2179, 2184, 2191, 2272, 2275, 2296, 2303,
    3328, 3331, 3592, 3599, 3616, 3619, 3640, 3647, 3904, 3971, 3976, 3983, 4064, 4067, 4088, 4095,
];

/** The exponent strategy of block `block` under frame exponent strategy `code`. */
export function frameStrategy(code: number, block: number): number {
    return (FRAME_STRATEGIES[code]! >> (10 - 2 * block)) & 3;
}

/** High-efficiency bap by masked PSD address (Table E3.1): runs of each value from 0. */
export const HEBAP_TABLE = new Uint8Array(64);
{
    let at = 0;
    [1, 1, 1, 1, 1, 1, 1, 1, 4, 3, 4, 4, 4, 4, 4, 4, 4, 4, 8, 9].forEach((count, value) => {
        HEBAP_TABLE.fill(value, at, at + count);
        at += count;
    });
}

/** Mantissa bits by hebap (Table E3.2): VQ indexes for 1-7, GAQ mantissas from 8. */
export const HEBAP_BITS = [0, 2, 3, 4, 5, 7, 8, 9, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16];

/** GAQ remapping (Table E3.6) of mantissas without gain, Q15, by hebap - 8. */
export const GAQ_REMAP_1 = [4681, 2185, 1057, 520, 258, 129, 64, 32, 16, 8, 2, 0];

/**
 * Large-mantissa remapping, Q15, by hebap - 8 and gain 2 or 4: the scale A and negative offset B.
 */
export const GAQ_REMAP_A = [
    [-10923, -4681],
    [-14043, -6554],
    [-15292, -7399],
    [-15855, -7802],
    [-16124, -7998],
    [-16255, -8096],
    [-16320, -8144],
    [-16352, -8168],
    [-16368, -8180],
];
export const GAQ_REMAP_B = [
    [-5461, -1170],
    [-11703, -4915],
    [-14199, -6606],
    [-15327, -7412],
    [-15864, -7805],
    [-16126, -7999],
    [-16255, -8096],
    [-16320, -8144],
    [-16352, -8168],
];

/** Default spectral extension banding structure (Table E2.15). */
export const DEFAULT_SPX_BAND_STRUCT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];

/** Spectral extension notch attenuation (Table E3.14): 2^(-(bin + 1)(code + 1) / 15). */
export const SPX_ATTENUATION = Array.from({ length: 32 }, (_, code) =>
    Float32Array.from({ length: 3 }, (_, bin) => 2 ** (((bin + 1) * (code + 1)) / -15)),
);

/** The VQ codebooks of Tables E4.1-E4.7. */
const VQ_BASE64 =
    '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' +
    'KqLsnwws88hqThBt+fEB';

/**
 * The VQ vectors of hebap 1 to 7 (4, 8, 16, 32, 128, 256 and 512 of them), six Q15 values each,
 * little-endian Int16; the last vector of hebap 4 is zero, as ffmpeg's table leaves it.
 */
export const VQ_VECTORS: readonly Int16Array[] = (() => {
    const binary = atob(VQ_BASE64);
    const all = new Int16Array(binary.length >> 1);
    for (let index = 0; index < all.length; index++)
        all[index] =
            ((binary.charCodeAt(2 * index + 1) << 24) >> 16) | binary.charCodeAt(2 * index);
    const tables = [new Int16Array(0)];
    let at = 0;
    for (const count of [4, 8, 16, 32, 128, 256, 512]) {
        tables.push(all.subarray(at, at + count * 6));
        at += count * 6;
    }
    return tables;
})();
