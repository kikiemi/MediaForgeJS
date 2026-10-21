import type { BitReader } from './bit-reader';
import {
    CHROMA422_DC_TOTAL_ZEROS,
    CHROMA_DC_TOTAL_ZEROS,
    COEFF_TOKEN,
    RUN_BEFORE,
    TOTAL_ZEROS,
} from './tables';

const levels = new Int32Array(16);
const runs = new Uint8Array(16);

/**
 * The 32 bits at bit position `pos` of an RBSP buffer with at least 5 readable bytes from pos / 8.
 */
function peek32(data: Uint8Array, pos: number): number {
    const p = pos >>> 3;
    const s = pos & 7;
    return (
        (((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) << s) |
        (data[p + 4] >>> (8 - s))
    );
}

/**
 * coeff_token table class for a luma or chroma AC block from nC (Table 9-5); -1 and -2 select the
 * chroma DC tables.
 */
export function coeffTokenTable(nC: number): number {
    if (nC < 0) return nC === -1 ? 4 : 5;
    if (nC < 2) return 0;
    if (nC < 4) return 1;
    if (nC < 8) return 2;
    return 3;
}

/**
 * Parses residual_block_cavlc (7.3.5.3.2, 9.2) and stores the level of coded position i =
 * 0..maxCoeff - 1 scaled at out[outOffset + p], p = scan[scanOffset + i], as (level *
 * scale[scaleOffset + p] + 32) >> 6. Returns TotalCoeff, or -1 for a damaged block. The bit
 * position is kept locally and advanced in the reader at the end.
 */
export function readResidualCavlc(
    br: BitReader,
    out: Int32Array,
    outOffset: number,
    scan: Uint8Array,
    scanOffset: number,
    maxCoeff: number,
    tokenTable: number,
    scale: Int32Array,
    scaleOffset: number,
): number {
    const data = br.data;
    let pos = br.pos;
    const tokenVlc = COEFF_TOKEN[tokenTable];
    const tokenEntry = tokenVlc.table[peek32(data, pos) >>> (32 - tokenVlc.bits)];
    if (!tokenEntry) return -1;
    pos += tokenEntry & 31;
    const token = tokenEntry >> 5;
    const totalCoeff = token >> 2;
    const trailingOnes = token & 3;
    if (totalCoeff === 0) {
        br.pos = pos;
        return 0;
    }
    if (totalCoeff > maxCoeff) return -1;
    if (trailingOnes) {
        const signs = peek32(data, pos) >>> (32 - trailingOnes);
        for (let i = 0; i < trailingOnes; i++)
            levels[i] = 1 - 2 * ((signs >> (trailingOnes - 1 - i)) & 1);
        pos += trailingOnes;
    }
    let suffixLength = totalCoeff > 10 && trailingOnes < 3 ? 1 : 0;
    for (let i = trailingOnes; i < totalCoeff; i++) {
        // level_prefix: the leading zero bits before a one.
        const window = peek32(data, pos);
        if (window === 0) return -1;
        const prefix = Math.clz32(window);
        pos += prefix + 1;
        if (pos > br.end + 32) return -1;
        let levelCode = (prefix < 15 ? prefix : 15) << suffixLength;
        if (suffixLength > 0 || prefix >= 14) {
            const suffixSize =
                prefix === 14 && suffixLength === 0 ? 4 : prefix >= 15 ? prefix - 3 : suffixLength;
            if (suffixSize > 0) {
                levelCode += peek32(data, pos) >>> (32 - suffixSize);
                pos += suffixSize;
            }
        }
        if (prefix >= 15 && suffixLength === 0) levelCode += 15;
        if (prefix >= 16) levelCode += 2 ** (prefix - 3) - 4096;
        if (i === trailingOnes && trailingOnes < 3) levelCode += 2;
        const level = levelCode & 1 ? (-levelCode - 1) >> 1 : (levelCode + 2) >> 1;
        levels[i] = level;
        if (suffixLength === 0) suffixLength = 1;
        const magnitude = level < 0 ? -level : level;
        if (magnitude > 3 << (suffixLength - 1) && suffixLength < 6) suffixLength++;
    }
    let zerosLeft = 0;
    if (totalCoeff < maxCoeff) {
        const vlc =
            maxCoeff === 4
                ? CHROMA_DC_TOTAL_ZEROS[totalCoeff - 1]
                : maxCoeff === 8
                  ? CHROMA422_DC_TOTAL_ZEROS[totalCoeff - 1]
                  : TOTAL_ZEROS[totalCoeff - 1];
        const entry = vlc.table[peek32(data, pos) >>> (32 - vlc.bits)];
        if (!entry) return -1;
        pos += entry & 31;
        zerosLeft = entry >> 5;
        if (zerosLeft > maxCoeff - totalCoeff) return -1;
    }
    for (let i = 0; i < totalCoeff - 1; i++) {
        if (zerosLeft > 0) {
            const vlc = RUN_BEFORE[(zerosLeft < 7 ? zerosLeft : 7) - 1];
            const entry = vlc.table[peek32(data, pos) >>> (32 - vlc.bits)];
            if (!entry) return -1;
            pos += entry & 31;
            const run = entry >> 5;
            if (run > zerosLeft) return -1;
            runs[i] = run;
            zerosLeft -= run;
        } else runs[i] = 0;
    }
    runs[totalCoeff - 1] = zerosLeft;
    let coeffNum = -1;
    for (let i = totalCoeff - 1; i >= 0; i--) {
        coeffNum += runs[i] + 1;
        const p = scan[scanOffset + coeffNum];
        out[outOffset + p] = (Math.imul(levels[i], scale[scaleOffset + p]) + 32) >> 6;
    }
    br.pos = pos;
    return totalCoeff;
}
