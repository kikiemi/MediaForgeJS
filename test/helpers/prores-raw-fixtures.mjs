// Original synthetic ProRes RAW packets. No camera footage or encoder binary is needed.
// Codebook numbers describe the bitstream; the test encoder is intentionally small.
const DC = [0x10, 0x21, 0x32, 0x33, 0x33, 0x33, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x76];
function acBook(value) {
    if (value === 0) return 0;
    if (value === 1) return 0x211;
    if (value < 4) return 0x111;
    if (value < 7) return 0x222;
    if (value < 10) return 0x122;
    if (value < 18) return 0x233;
    if (value < 20) return 0x133;
    if (value < 42) return 0x244;
    return value < 94 ? 0x355 : 0x166;
}
const LN = [0x100, 0x111, 0x222, 0x222, 0x122];
const RUN = [
    0x200, 0x100, 0, 0, 0x211, 0x211, 0x111, 0x111, 0x11, 0x11, 0x21, 0x21, 0x222, 0x22, 0x22, 0x22,
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x32, 0x32, 0x44,
];
function lengthBook(value) {
    if (value === 0) return 0x100;
    if (value === 1) return 0x111;
    if (value < 4) return 0x222;
    if (value < 6) return 0x122;
    if (value < 8) return 0x433;
    return value < 14 ? 0x233 : 0x33;
}

function symbol(value, codebook) {
    const rice = codebook & 15;
    const exp = (codebook >> 4) & 15;
    const change = codebook >> 8;
    if (value < (change + 1) * 2 ** rice) {
        const quotient = Math.floor(value / 2 ** rice);
        return (
            '0'.repeat(quotient) +
            '1' +
            (rice ? (value % 2 ** rice).toString(2).padStart(rice, '0') : '')
        );
    }
    const tail = (value - (change + 1) * 2 ** rice + 2 ** exp).toString(2);
    return '0'.repeat(tail.length - exp + change) + tail;
}

function component(blocks, channel, tile, detail) {
    const dc = (channel * 257 + tile * 43) * (tile % 2 ? -1 : 1);
    let previous = dc < 0 ? -dc * 2 - 1 : dc * 2;
    let bits = symbol(previous, 700);
    for (let block = 1; block < blocks; block++) {
        const next =
            detail === 'wide'
                ? [0, 1, 2, 3, 7, 19, 64, 129, 511, 1024, 8191, 0, 23, 1, 4, 12][block]
                : 0;
        bits += symbol(next, block === 1 ? 100 : DC[Math.min((previous + 1) >> 1, 12)]);
        previous = next;
    }
    if (detail === 'sparse') {
        const coefficients = new Int32Array(blocks * 64);
        const gaps = [1, 2, 3, 5, 7, 9, 11, 13, 21, 27, 28, 56];
        const levels = [0, 1, 3, 4, 5, 6, 8, 10, 14, 18, 20, 42, 94, 513];
        for (let position = blocks, group = 0; position < coefficients.length; group++) {
            position += gaps[group % gaps.length];
            for (let i = 0; i <= group % 8 && position < coefficients.length; i++, position++) {
                coefficients[position] =
                    (levels[(group + i + channel) % levels.length] + 1) * (group % 2 ? -1 : 1);
            }
        }
        let position = blocks,
            levelCode = 49,
            countCode = 66,
            runCode = 0;
        const emit = value => {
            const magnitude = Math.abs(value) - 1;
            bits += symbol(magnitude, levelCode) + (value < 0 ? '1' : '0');
            levelCode = acBook(magnitude);
            return magnitude;
        };
        while (position < coefficients.length) {
            let count = 0;
            while (position + count < coefficients.length && coefficients[position + count])
                count++;
            bits += symbol(count, countCode);
            for (let i = 0; i < count; i++) emit(coefficients[position++]);
            if (position === coefficients.length) break;
            let next = position;
            while (next < coefficients.length && !coefficients[next]) next++;
            if (next === coefficients.length) break;
            const run = next - position - 1;
            bits += symbol(run, runCode);
            runCode = RUN[Math.min(run, 27)];
            countCode = lengthBook(emit(coefficients[next]));
            position = next + 1;
        }
    } else if (detail) {
        // Zero run, then a signed AC, then a dense run; exercise both AC coding paths.
        bits += symbol(0, 66) + symbol(2, 0) + symbol(1, 49) + '1';
        let book = acBook(1);
        const count = detail === 'wide' ? blocks * 63 - 4 : Math.min(11, blocks * 63 - 4);
        bits += symbol(count, LN[1]);
        for (let n = 0; n < count; n++) {
            const ac =
                detail === 'wide'
                    ? [0, 1, 3, 4, 7, 10, 18, 20, 42, 94, 513, 4095, 32760][
                          (n + channel + tile) % 13
                      ]
                    : (n + channel + tile) % 4;
            bits += symbol(ac, book) + String(n % 2);
            book = acBook(ac);
        }
    }
    bits += '00000000';
    bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
    return Uint8Array.from({ length: bits.length / 8 }, (_, i) =>
        parseInt(bits.slice(i * 8, i * 8 + 8), 2),
    );
}

export function makeProResRawPacket({
    width = 32,
    height = 24,
    version = 0,
    alignment = 1,
    detail = true,
    quantization,
    curve,
    trailer = new Uint8Array(),
} = {}) {
    const headerSize = 72 + (quantization ? 64 : 0) + (curve ? 16 : 0);
    const tiles = [];
    for (let y = 0; y < height; y += 16) {
        let remaining = Math.ceil(width / 16);
        for (let exponent = alignment; exponent >= 0; exponent--) {
            const blocks = 2 ** exponent;
            while (remaining >= blocks) {
                const components = [2, 1, 3, 0].map(channel =>
                    component(blocks, channel, tiles.length, detail),
                );
                const tile = new Uint8Array(
                    8 + components.reduce((sum, bytes) => sum + bytes.length, 0),
                );
                const view = new DataView(tile.buffer);
                tile[0] = 8 << 3;
                tile[1] = 8;
                let offset = 8;
                for (let i = 0; i < 4; i++) {
                    if (i < 3) view.setUint16(2 + i * 2, components[i].length);
                    tile.set(components[i], offset);
                    offset += components[i].length;
                }
                tiles.push(tile);
                remaining -= blocks;
            }
        }
    }
    const packet = new Uint8Array(
        8 +
            headerSize +
            tiles.length * 2 +
            tiles.reduce((n, b) => n + b.length, 0) +
            trailer.length,
    );
    const view = new DataView(packet.buffer);
    view.setUint32(0, packet.length);
    packet.set([0x70, 0x72, 0x72, 0x66], 4);
    view.setUint16(8, headerSize);
    view.setUint16(10, version);
    packet.set([0x54, 0x45, 0x53, 0x54], 12);
    view.setUint16(16, width);
    view.setUint16(18, height);
    view.setUint16(26, 65279);
    view.setFloat32(28, 1.5);
    view.setFloat32(32, 1.25);
    for (let i = 0; i < 9; i++) view.setFloat32(36 + i * 4, i % 4 === 0 ? 1 : 0);
    view.setFloat32(72, 1);
    view.setUint16(76, 5600);
    view.setUint16(78, alignment * 2 + (quantization ? 1 : 0) + (curve ? 16 : 0));
    let offset = 80;
    if (quantization) {
        packet.set(quantization, offset);
        offset += 64;
    }
    if (curve)
        for (const value of curve) {
            view.setUint16(offset, value);
            offset += 2;
        }
    offset += tiles.length * 2;
    tiles.forEach((tile, i) => {
        view.setUint16(8 + headerSize + i * 2, tile.length);
        packet.set(tile, offset);
        offset += tile.length;
    });
    packet.set(trailer, offset);
    return packet;
}

export const proResRawFrames = {
    aprn: makeProResRawPacket(),
    aprh: makeProResRawPacket({
        version: 1,
        quantization: Uint8Array.from({ length: 64 }, (_, i) => 1 + (i % 4)),
    }),
};
