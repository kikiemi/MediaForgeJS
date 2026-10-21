/**
 * Largest magnitude the table of q^(4/3) holds: above every value MP3 (15 plus 13 linbits) and AAC
 * (8191) code, and the range the MP3 encoder's quantizer searches.
 */
export const POW43_MAX = 16383;

let table: Float64Array | undefined;

/**
 * q^(4/3) for the quantized magnitudes 0..POW43_MAX: the inverse quantization of MP3 and AAC
 * spectra, computed when a decoder or encoder first needs it.
 */
export function pow43Table(): Float64Array {
    if (!table) {
        table = new Float64Array(POW43_MAX + 1);
        for (let q = 0; q <= POW43_MAX; q++) table[q] = Math.pow(q, 4 / 3);
    }
    return table;
}

/** q^(4/3) for a nonnegative magnitude, from the table when it holds q. */
export function pow43(q: number): number {
    return q <= POW43_MAX ? (table ?? pow43Table())[q]! : Math.pow(q, 4 / 3);
}
