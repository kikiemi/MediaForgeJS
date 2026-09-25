import { unpackAlpha16 } from './alpha.js';

export const profiles = Object.freeze({ apco: 0, apcs: 1, apcn: 2, apch: 3, ap4h: 4, ap4x: 5 });

export function profileOf(codec) {
    if (!Object.hasOwn(profiles, codec))
        throw new TypeError(`Unsupported ProRes codec '${codec}'; ProRes RAW is separate`);
    return profiles[codec];
}

export function inspectPacket(data, config) {
    if (!(data instanceof Uint8Array) || data.length < 28) throw new TypeError('ProRes packet is truncated');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== data.length || view.getUint32(4) !== 0x69637066) {
        throw new Error('ProRes requires a complete size/icpf packet');
    }
    if (view.getUint16(10) > 1) throw new Error('Unsupported ProRes bitstream version');
    const headerSize = view.getUint16(8);
    if (headerSize < 20 || headerSize > data.length - 8) throw new Error('ProRes frame header size is invalid');
    const width = view.getUint16(16);
    const height = view.getUint16(18);
    if (
        !width ||
        !height ||
        (config.width !== undefined && width !== config.width) ||
        (config.height !== undefined && height !== config.height)
    )
        throw new Error('ProRes dimensions do not match the decoder');
    if (Math.ceil(width / 16) * 16 * Math.ceil(height / 32) * 32 > config.maxPixels) {
        throw new RangeError('ProRes dimensions exceed maxPixels');
    }
    const chroma = data[20] >>> 6;
    const alpha = data[25] & 15;
    const interlace = (data[20] >> 2) & 3;
    if (chroma < 2 || alpha > 2 || interlace === 3)
        throw new Error('Unsupported ProRes frame chroma, alpha or scan type');
    if (profileOf(config.codec) < 4 && (chroma !== 2 || alpha))
        throw new Error('ProRes frame contradicts its 422 profile');
    return { width, height, alpha, chroma, interlace, headerSize };
}

// TurboRes validates the complete picture/slice structure before this is called.
// Traverse the same slices to recover the alpha low bits it does not expose.
export function restoreAlpha16(packet, info, output, layout, codedWidth, codedHeight) {
    const input = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const target = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const macroblockWidth = Math.ceil(info.width / 16);
    const fields = info.interlace ? 2 : 1;
    let picture = 8 + info.headerSize;
    for (let field = 0; field < fields; field++) {
        if (picture + 8 > packet.length) throw new Error('ProRes picture header is truncated');
        const pictureSize = input.getUint32(picture + 1);
        const count = input.getUint16(picture + 5);
        const table = picture + (packet[picture] >>> 3);
        const pictureEnd = picture + pictureSize;
        if (pictureSize < 8 || pictureEnd > packet.length || table + count * 2 > pictureEnd) {
            throw new Error('ProRes alpha slice table is invalid');
        }
        const maxBlocks = 1 << (packet[picture + 7] >>> 4);
        let slice = table + count * 2;
        let mbX = 0;
        let mbY = 0;
        for (let index = 0; index < count; index++) {
            const sliceSize = input.getUint16(table + index * 2);
            const sliceEnd = slice + sliceSize;
            if (sliceSize < 8 || sliceEnd > pictureEnd) throw new Error('ProRes alpha slice size is invalid');
            const headerSize = packet[slice] >>> 3;
            const alphaStart =
                slice +
                headerSize +
                input.getUint16(slice + 2) +
                input.getUint16(slice + 4) +
                input.getUint16(slice + 6);
            if (headerSize < 8 || alphaStart >= sliceEnd) throw new Error('ProRes alpha plane is missing');
            let blocks = maxBlocks;
            while (blocks > macroblockWidth - mbX) blocks >>= 1;
            if (!blocks) throw new Error('ProRes alpha slice position is invalid');
            const rowWidth = blocks * 16;
            const values = unpackAlpha16(packet.subarray(alphaStart, sliceEnd), rowWidth * 16);
            const parity = info.interlace === 1 ? field : 1 - field;
            for (let y = 0; y < 16; y++) {
                const targetY = fields === 1 ? mbY * 16 + y : (mbY * 16 + y) * 2 + parity;
                if (targetY >= codedHeight) continue;
                for (let x = 0; x < rowWidth; x++) {
                    const targetX = mbX * 16 + x;
                    if (targetX < codedWidth)
                        target.setUint16(
                            layout.offset + targetY * layout.stride + targetX * 2,
                            values[y * rowWidth + x],
                            true,
                        );
                }
            }
            mbX += blocks;
            if (mbX === macroblockWidth) {
                mbX = 0;
                mbY++;
            }
            slice = sliceEnd;
        }
        if (slice !== pictureEnd || mbX) throw new Error('ProRes alpha slice layout is invalid');
        picture = pictureEnd;
    }
}
