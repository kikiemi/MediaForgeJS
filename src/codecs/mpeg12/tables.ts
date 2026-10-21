/**
 * Scan position to natural (row-major) coefficient index: zig-zag and alternate scan (ISO/IEC
 * 13818-2 7.3.1).
 */

/**
 * Default intra quantiser matrix in natural order (13818-2 7.4.2.1); the default non-intra matrix
 * is all 16.
 */
export const DEFAULT_INTRA_MATRIX = Uint8Array.from([
    8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38,
    22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58,
    26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
]);

/** quantiser_scale for q_scale_type 1, indexed by quantiser_scale_code (13818-2 Table 7-6). */
export const NON_LINEAR_QUANTISER_SCALE = Uint8Array.from([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64,
    72, 80, 88, 96, 104, 112,
]);

/** MPEG-1 pel_aspect_ratio: pixel height over width (ISO/IEC 11172-2 2.4.3.2). */
export const MPEG1_PEL_ASPECT = [
    0, 1, 0.6735, 0.7031, 0.7615, 0.8055, 0.8437, 0.8935, 0.9157, 0.9815, 1.0255, 1.0695, 1.095,
    1.1575, 1.2015, 0,
];

/**
 * MPEG-2 display aspect ratios as [width, height]; code 1 means square samples (13818-2 Table 6-3).
 */
export const MPEG2_DISPLAY_ASPECT: readonly (readonly [number, number] | null)[] = [
    null,
    null,
    [4, 3],
    [16, 9],
    [221, 100],
];

type CodeList = string;

/**
 * Builds a table indexed by the next `bits` bits from "code:value" pairs; entries hold value |
 * length << 8.
 */
function prefixTable(bits: number, codes: CodeList): Int32Array {
    const table = new Int32Array(1 << bits);
    for (const item of codes.split(' ')) {
        const [code, value] = item.split(':') as [string, string];
        const shift = bits - code.length;
        const start = parseInt(code, 2) << shift;
        table.fill(Number(value) | (code.length << 8), start, start + (1 << shift));
    }
    return table;
}

export const MB_ESCAPE = 34;
export const MB_STUFFING = 35;

/** macroblock_address_increment (Table B.1): 11-bit lookup. */
export const MB_ADDRESS_INCREMENT = prefixTable(
    11,
    '1:1 011:2 010:3 0011:4 0010:5 00011:6 00010:7 0000111:8 0000110:9 00001011:10 00001010:11 ' +
        '00001001:12 ' +
        '00001000:13 00000111:14 00000110:15 0000010111:16 0000010110:17 0000010101:18 ' +
        '0000010100:19 0000010011:20 ' +
        '0000010010:21 00000100011:22 00000100010:23 00000100001:24 00000100000:25 ' +
        '00000011111:26 00000011110:27 ' +
        '00000011101:28 00000011100:29 00000011011:30 00000011010:31 00000011001:32 ' +
        '00000011000:33 ' +
        `00000001000:${MB_ESCAPE} 00000001111:${MB_STUFFING}`,
);

export const MB_QUANT = 16;
export const MB_FORWARD = 8;
export const MB_BACKWARD = 4;
export const MB_PATTERN = 2;
export const MB_INTRA = 1;

/**
 * macroblock_type for I, P and B pictures (Tables B.2 to B.4): 6-bit lookups of the flags above.
 */
export const MB_TYPE_I = prefixTable(6, '1:1 01:17');
export const MB_TYPE_P = prefixTable(6, '1:10 01:2 001:8 00011:1 00010:26 00001:18 000001:17');
export const MB_TYPE_B = prefixTable(
    6,
    '10:12 11:14 010:4 011:6 0010:8 0011:10 00011:1 00010:30 000011:26 000010:22 000001:17',
);

/** coded_block_pattern (Table B.9): 9-bit lookup. */
export const CODED_BLOCK_PATTERN = prefixTable(
    9,
    '111:60 1101:4 1100:8 1011:16 1010:32 10011:12 10010:48 10001:20 10000:40 01111:28 01110:44 ' +
        '01101:52 01100:56 01011:1 01010:61 01001:2 01000:62 001111:24 001110:36 001101:3 ' +
        '001100:63 0010111:5 0010110:9 0010101:17 0010100:33 0010011:6 0010010:10 0010001:18 ' +
        '0010000:34 00011111:7 00011110:11 00011101:19 00011100:35 00011011:13 00011010:49 ' +
        '00011001:21 00011000:41 00010111:14 00010110:50 00010101:22 00010100:42 00010011:15 ' +
        '00010010:51 00010001:23 00010000:43 00001111:25 00001110:37 00001101:26 00001100:38 ' +
        '00001011:29 00001010:45 00001001:53 00001000:57 00000111:30 00000110:46 00000101:54 ' +
        '00000100:58 000000111:31 000000110:47 000000101:55 000000100:59 000000011:27 ' +
        '000000010:39 000000001:0',
);

/** motion_code magnitude (Table B.10) before its sign bit: 10-bit lookup. */
export const MOTION_CODE = prefixTable(
    10,
    '1:0 01:1 001:2 0001:3 000011:4 0000101:5 0000100:6 0000011:7 000001011:8 000001010:9 ' +
        '000001001:10 0000010001:11 0000010000:12 0000001111:13 0000001110:14 0000001101:15 ' +
        '0000001100:16',
);

/** dct_dc_size_luminance and dct_dc_size_chrominance (Tables B.12, B.13): 10-bit lookups. */
export const DC_SIZE_LUMA = prefixTable(
    10,
    '100:0 00:1 01:2 101:3 110:4 1110:5 11110:6 111110:7 1111110:8 11111110:9 111111110:10 ' +
        '111111111:11',
);
export const DC_SIZE_CHROMA = prefixTable(
    10,
    '00:0 01:1 10:2 110:3 1110:4 11110:5 111110:6 1111110:7 11111110:8 111111110:9 1111111110:10 ' +
        '1111111111:11',
);

export const COEFFICIENT_EOB = 32;
export const COEFFICIENT_ESCAPE = 33;
const COEFFICIENT_LONG = -1;

/**
 * Codes of 12 or more bits shared by Tables B.14 and B.15, as "code:run,level" without the sign
 * bit.
 */
const SHARED_LONG_CODES =
    '000000011100:3,3 000000010010:4,3 000000011110:6,2 000000010101:7,2 000000010001:8,2 ' +
    '000000011111:17,1 000000011010:18,1 000000011001:19,1 000000010111:20,1 000000010110:21,1 ' +
    '0000000010110:1,6 0000000010101:1,7 0000000010100:2,5 0000000010011:3,4 0000000010010:5,3 ' +
    '0000000010001:9,2 0000000010000:10,2 0000000011111:22,1 0000000011110:23,1 ' +
    '0000000011101:24,1 0000000011100:25,1 0000000011011:26,1 00000000011111:0,16 ' +
    '00000000011110:0,17 00000000011101:0,18 00000000011100:0,19 00000000011011:0,20 ' +
    '00000000011010:0,21 00000000011001:0,22 00000000011000:0,23 00000000010111:0,24 ' +
    '00000000010110:0,25 00000000010101:0,26 00000000010100:0,27 00000000010011:0,28 ' +
    '00000000010010:0,29 00000000010001:0,30 00000000010000:0,31 000000000011000:0,32 ' +
    '000000000010111:0,33 000000000010110:0,34 000000000010101:0,35 000000000010100:0,36 ' +
    '000000000010011:0,37 000000000010010:0,38 000000000010001:0,39 000000000010000:0,40 ' +
    '000000000011111:1,8 000000000011110:1,9 000000000011101:1,10 000000000011100:1,11 ' +
    '000000000011011:1,12 000000000011010:1,13 000000000011001:1,14 0000000000010011:1,15 ' +
    '0000000000010010:1,16 0000000000010001:1,17 0000000000010000:1,18 0000000000010100:6,3 ' +
    '0000000000011010:11,2 0000000000011001:12,2 0000000000011000:13,2 0000000000010111:14,2 ' +
    '0000000000010110:15,2 0000000000010101:16,2 0000000000011111:27,1 0000000000011110:28,1 ' +
    '0000000000011101:29,1 0000000000011100:30,1 0000000000011011:31,1';

/**
 * Builds a two-level DCT coefficient lookup: entry `peek16 >>> 6`, or for codes with seven leading
 * zeros entry 1024 + (peek16 & 511). Entries hold the code length including the sign bit (bits
 * 0-4), the run or the EOB/escape marker (bits 5-10) and the level (bits 11+); zero marks an
 * invalid code.
 */
function coefficientTable(codes: CodeList): Int32Array {
    const table = new Int32Array(1024 + 512);
    table.fill(COEFFICIENT_LONG, 0, 8);
    for (const item of codes.split(' ')) {
        const [code, value] = item.split(':') as [string, string];
        let run: number;
        let level = 0;
        let length = code.length;
        if (value === 'eob') run = COEFFICIENT_EOB;
        else if (value === 'escape') run = COEFFICIENT_ESCAPE;
        else {
            const [runText, levelText] = value.split(',') as [string, string];
            run = Number(runText);
            level = Number(levelText);
            length++;
        }
        const entry = length | (run << 5) | (level << 11);
        if (code.startsWith('0000000')) {
            const shift = 16 - code.length;
            const start = (parseInt(code, 2) << shift) & 511;
            table.fill(entry, 1024 + start, 1024 + start + (1 << shift));
        } else {
            const shift = 10 - code.length;
            const start = parseInt(code, 2) << shift;
            table.fill(entry, start, start + (1 << shift));
        }
    }
    return table;
}

/**
 * Table B.14 for coefficients after the first; the first non-intra coefficient codes run 0 level 1
 * as "1s".
 */
export const COEFFICIENTS_B14 = coefficientTable(
    '10:eob 000001:escape 11:0,1 011:1,1 0100:0,2 0101:2,1 00101:0,3 00111:3,1 00110:4,1 ' +
        '000110:1,2 000111:5,1 ' +
        '000101:6,1 000100:7,1 0000110:0,4 0000100:2,2 0000111:8,1 0000101:9,1 00100110:0,5 ' +
        '00100001:0,6 ' +
        '00100101:1,3 00100100:3,2 00100111:10,1 00100011:11,1 00100010:12,1 00100000:13,1 ' +
        '0000001010:0,7 ' +
        '0000001100:1,4 0000001011:2,3 0000001111:4,2 0000001001:5,2 0000001110:14,1 ' +
        '0000001101:15,1 ' +
        '0000001000:16,1 000000011101:0,8 000000011000:0,9 000000010011:0,10 000000010000:0,11 ' +
        '000000011011:1,5 ' +
        '000000010100:2,4 0000000011010:0,12 0000000011001:0,13 0000000011000:0,14 ' +
        '0000000010111:0,15 ' +
        SHARED_LONG_CODES,
);

/** Table B.15, used for intra blocks when intra_vlc_format is 1. */
export const COEFFICIENTS_B15 = coefficientTable(
    '0110:eob 000001:escape 10:0,1 010:1,1 110:0,2 00101:2,1 0111:0,3 00111:3,1 000110:4,1 ' +
        '00110:1,2 000111:5,1 ' +
        '0000110:6,1 0000100:7,1 11100:0,4 0000111:2,2 0000101:8,1 1111000:9,1 11101:0,5 ' +
        '000101:0,6 1111001:1,3 ' +
        '00100110:3,2 1111010:10,1 00100001:11,1 00100101:12,1 00100100:13,1 000100:0,7 ' +
        '00100111:1,4 11111100:2,3 ' +
        '11111101:4,2 000000100:5,2 000000101:14,1 000000111:15,1 0000001101:16,1 1111011:0,8 ' +
        '1111100:0,9 ' +
        '00100011:0,10 00100010:0,11 00100000:1,5 0000001100:2,4 11111010:0,12 11111011:0,13 ' +
        '11111110:0,14 ' +
        '11111111:0,15 ' +
        SHARED_LONG_CODES,
);
