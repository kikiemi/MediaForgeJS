let table = null;
export function oggCrc32(data) {
    if (!table) {
        table = new Uint32Array(256);
        for (let index = 0; index < 256; index++) {
            let value = index << 24;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
            }
            table[index] = value >>> 0;
        }
    }
    let crc = 0;
    for (let index = 0; index < data.length; index++) {
        crc = ((crc << 8) ^ table[((crc >>> 24) & 0xff) ^ data[index]]) >>> 0;
    }
    return crc >>> 0;
}
