// CRC-32 of polynomial 0x04C11DB7 computed most significant bit first, without reflection, as
// MPEG-2 PSI sections (from 0xFFFFFFFF) and Ogg pages (from 0) check their contents with it.

/**
 * Sixteen 256-entry tables: table k maps a byte to its CRC contribution k bytes before the end of a
 * 16-byte block.
 */
let tables: Int32Array | null = null;

function crcTables(): Int32Array {
    if (tables) return tables;
    const result = new Int32Array(16 * 256);
    for (let index = 0; index < 256; index++) {
        let value = index << 24;
        for (let bit = 0; bit < 8; bit++)
            value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
        result[index] = value;
    }
    for (let index = 0; index < 256; index++) {
        let value = result[index]!;
        for (let table = 1; table < 16; table++) {
            value = (value << 8) ^ result[(value >>> 24) & 0xff]!;
            result[table * 256 + index] = value;
        }
    }
    return (tables = result);
}

/**
 * The CRC-32 `crc` continued over `data[start, end)`, sixteen bytes per step, read as four
 * big-endian words; a 32-bit signed value (`>>> 0` makes it unsigned).
 */
export function crc32MpegUpdate(
    crc: number,
    data: Uint8Array,
    start = 0,
    end = data.length,
): number {
    const t = crcTables();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let index = start;
    const blocks = end - ((end - start) & 15);
    while (index < blocks) {
        const a = crc ^ view.getInt32(index);
        const b = view.getInt32(index + 4);
        const c = view.getInt32(index + 8);
        const d = view.getInt32(index + 12);
        crc =
            t[3840 + (a >>> 24)]! ^
            t[3584 + ((a >>> 16) & 0xff)]! ^
            t[3328 + ((a >>> 8) & 0xff)]! ^
            t[3072 + (a & 0xff)]! ^
            t[2816 + (b >>> 24)]! ^
            t[2560 + ((b >>> 16) & 0xff)]! ^
            t[2304 + ((b >>> 8) & 0xff)]! ^
            t[2048 + (b & 0xff)]! ^
            t[1792 + (c >>> 24)]! ^
            t[1536 + ((c >>> 16) & 0xff)]! ^
            t[1280 + ((c >>> 8) & 0xff)]! ^
            t[1024 + (c & 0xff)]! ^
            t[768 + (d >>> 24)]! ^
            t[512 + ((d >>> 16) & 0xff)]! ^
            t[256 + ((d >>> 8) & 0xff)]! ^
            t[d & 0xff]!;
        index += 16;
    }
    for (; index < end; index++) crc = (crc << 8) ^ t[((crc >>> 24) ^ data[index]!) & 0xff]!;
    return crc;
}
