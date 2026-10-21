import { HT32, HTABLES, SFB_L, SFB_S } from './mp3-tables';

/**
 * Long-block scalefactor band boundaries (ISO/IEC 11172-3 Table B.8, ISO/IEC 13818-3 Table B.2).
 */
export const SFB_LONG: Readonly<Record<number, readonly number[]>> = {
    ...SFB_L,
    22050: [
        0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
        522, 576,
    ],
    24000: [
        0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 114, 136, 162, 194, 232, 278, 332, 394, 464,
        540, 576,
    ],
    16000: [
        0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
        522, 576,
    ],
    11025: [
        0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
        522, 576,
    ],
    12000: [
        0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 116, 140, 168, 200, 238, 284, 336, 396, 464,
        522, 576,
    ],
    8000: [
        0, 12, 24, 36, 48, 60, 72, 88, 108, 132, 160, 192, 232, 280, 336, 400, 476, 566, 568, 570,
        572, 574, 576,
    ],
};

/** Short-block scalefactor band boundaries per window. */
export const SFB_SHORT: Readonly<Record<number, readonly number[]>> = {
    ...SFB_S,
    22050: [0, 4, 8, 12, 18, 24, 32, 42, 56, 74, 100, 132, 174, 192],
    24000: [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 136, 180, 192],
    16000: [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192],
    11025: [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192],
    12000: [0, 4, 8, 12, 18, 26, 36, 48, 62, 80, 104, 134, 174, 192],
    8000: [0, 8, 16, 24, 36, 52, 72, 96, 124, 160, 162, 164, 166, 192],
};

export const PRETAB: readonly number[] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 2, 0,
];

/** MPEG-2 LSF scalefactor group sizes [table][block layout: long, short, mixed][group]. */
export const LSF_SCALEFACTOR_BANDS: readonly (readonly (readonly number[])[])[] = [
    [
        [6, 5, 5, 5],
        [9, 9, 9, 9],
        [6, 9, 9, 9],
    ],
    [
        [6, 5, 7, 3],
        [9, 9, 12, 6],
        [6, 9, 12, 6],
    ],
    [
        [11, 10, 0, 0],
        [18, 18, 0, 0],
        [15, 18, 0, 0],
    ],
    [
        [7, 7, 7, 0],
        [12, 12, 12, 0],
        [6, 15, 12, 0],
    ],
    [
        [6, 6, 6, 3],
        [12, 9, 9, 6],
        [6, 12, 9, 6],
    ],
    [
        [8, 8, 5, 0],
        [15, 12, 9, 0],
        [6, 18, 9, 0],
    ],
];

/** 2^(0.25 * (gain - 210)) for gain - 8 * subblock_gain in [-56, 255]. */
export const GAIN_OFFSET = 56;
export const GAIN_POW = new Float64Array(256 + GAIN_OFFSET);
for (let index = 0; index < GAIN_POW.length; index++)
    GAIN_POW[index] = Math.pow(2, 0.25 * (index - GAIN_OFFSET - 210));

/**
 * 2^(-0.5 * (1 + scalefac_scale) * value) for scalefactors with pretab, indexed
 * [scalefac_scale][value].
 */
export const SCALEFACTOR_POW: readonly Float64Array[] = [0, 1].map(scale => {
    const table = new Float64Array(64);
    for (let value = 0; value < 64; value++) table[value] = Math.pow(2, -0.5 * (1 + scale) * value);
    return table;
});

/** MPEG-1 intensity positions 0..6: [left gain, right gain] from tan(is_pos * pi / 12). */
export const INTENSITY_MPEG1 = new Float64Array(14);
for (let position = 0; position < 7; position++) {
    if (position === 6) {
        INTENSITY_MPEG1[12] = 1;
        INTENSITY_MPEG1[13] = 0;
        continue;
    }
    const ratio = Math.tan((position * Math.PI) / 12);
    INTENSITY_MPEG1[position * 2] = ratio / (1 + ratio);
    INTENSITY_MPEG1[position * 2 + 1] = 1 / (1 + ratio);
}

/**
 * MPEG-2 LSF intensity positions 0..63 for intensity_scale 0 and 1: [left gain, right gain]
 * (ISO/IEC 13818-3 2.4.3.2): odd positions attenuate the left channel, even positions the right.
 */
export const INTENSITY_LSF: readonly Float64Array[] = [0, 1].map(scale => {
    const io = Math.pow(2, scale === 0 ? -0.25 : -0.5);
    const table = new Float64Array(128);
    for (let position = 0; position < 64; position++) {
        if (position & 1) {
            table[position * 2] = Math.pow(io, (position + 1) / 2);
            table[position * 2 + 1] = 1;
        } else {
            table[position * 2] = 1;
            table[position * 2 + 1] = Math.pow(io, position / 2);
        }
    }
    return table;
});

export const PRIMARY_BITS = 10;

/**
 * Two-level Huffman lookup. Entries hold (length << 8) | (x << 4) | y; a negative primary entry is
 * -(1 + index) into `secondary`, whose table is indexed by the next `secondaryBits` bits.
 */
export interface HuffmanLookup {
    readonly primary: Int32Array;
    readonly secondary: readonly Int32Array[];
    readonly secondaryBits: number;
    readonly linbits: number;
}

function buildLookup(
    codes: ReadonlyArray<readonly [number, number, number]>,
    linbits: number,
): HuffmanLookup {
    let maxLength = 0;
    for (const [length] of codes) maxLength = Math.max(maxLength, length);
    const secondaryBits = Math.max(0, maxLength - PRIMARY_BITS);
    const primary = new Int32Array(1 << PRIMARY_BITS);
    const secondary: Int32Array[] = [];
    const prefixes = new Map<number, number>();
    for (const [length, code, value] of codes) {
        if (length === 0) continue;
        if (length <= PRIMARY_BITS) {
            const base = code << (PRIMARY_BITS - length);
            primary.fill((length << 8) | value, base, base + (1 << (PRIMARY_BITS - length)));
            continue;
        }
        const prefix = code >>> (length - PRIMARY_BITS);
        let table = prefixes.get(prefix);
        if (table === undefined) {
            table = secondary.length;
            secondary.push(new Int32Array(1 << secondaryBits));
            prefixes.set(prefix, table);
            primary[prefix] = -(1 + table);
        }
        const rest = code & ((1 << (length - PRIMARY_BITS)) - 1);
        const base = rest << (secondaryBits - (length - PRIMARY_BITS));
        secondary[table]!.fill(
            (length << 8) | value,
            base,
            base + (1 << (secondaryBits - (length - PRIMARY_BITS))),
        );
    }
    return { primary, secondary, secondaryBits, linbits };
}

const lookupCache = new Map<number, HuffmanLookup>();

/** Pair-table lookup for table_select 1..31; tables 4 and 14 are reserved. */
export function pairLookup(id: number): HuffmanLookup | null {
    const table = HTABLES[id];
    if (!table) return null;
    let lookup = lookupCache.get(id);
    if (!lookup) {
        const codes: [number, number, number][] = [];
        for (let x = 0; x < table.xlen; x++) {
            for (let y = 0; y < table.xlen; y++) {
                const [length, code] = table.entries[x * table.xlen + y]!;
                codes.push([length, code, (x << 4) | y]);
            }
        }
        lookup = buildLookup(codes, table.linbits);
        lookupCache.set(id, lookup);
    }
    return lookup;
}

/** count1 table A (HT32) as a flat 8-bit lookup: (length << 8) | vwxy bits. */
export const QUAD_A_LOOKUP = ((): Int32Array => {
    const lookup = new Int32Array(256);
    HT32.forEach(([length, code], value) => {
        const base = code << (8 - length);
        lookup.fill((length << 8) | value, base, base + (1 << (8 - length)));
    });
    return lookup;
})();
