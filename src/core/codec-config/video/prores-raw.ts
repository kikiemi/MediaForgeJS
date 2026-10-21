import { dataView } from '../../bytes/byte-fields'; /**
 * Structural packet checks only. Decoding is supplied by the optional mediaforgejs-prores-raw
 * package.
 */
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_TILES = 262144;

export function isProResRawCodec(codec: string): boolean {
    return codec === 'aprn' || codec === 'aprh';
}

function hasProResRawFrameHeader(data: Uint8Array): boolean {
    return (
        data.length >= 8 &&
        data[4] === 0x70 &&
        data[5] === 0x72 &&
        data[6] === 0x72 &&
        data[7] === 0x66
    );
}

function tileCount(width: number, height: number, alignment: number): number {
    let remaining = Math.ceil(width / 16);
    let columns = 0;
    for (let unit = 2 ** alignment; unit >= 1; unit /= 2) {
        columns += Math.floor(remaining / unit);
        remaining %= unit;
    }
    return columns * Math.ceil(height / 16);
}

export function proResRawFrameError(
    data: Uint8Array,
    track?: { codec?: string; width?: number; height?: number },
): string | undefined {
    if (data.length > MAX_FRAME_BYTES) return 'ProRes RAW packet byte size limit exceeded';
    if (data.length < 80) return 'ProRes RAW frame is truncated';
    if (!hasProResRawFrameHeader(data))
        return 'ProRes RAW requires a complete size/prrf frame header';
    const view = dataView(data);
    if (view.getUint32(0) !== data.length) return 'ProRes RAW frame size does not match its packet';
    const headerSize = view.getUint16(8);
    if (headerSize < 72 || headerSize > data.length - 8)
        return 'ProRes RAW frame header size is invalid';
    if (view.getUint16(10) > 1) return 'ProRes RAW bitstream version is not supported';
    const width = view.getUint16(16);
    const height = view.getUint16(18);
    if (!width || !height || width & 1 || height & 1)
        return 'ProRes RAW dimensions must be positive and even';
    if (width * height > MAX_PIXELS) return 'ProRes RAW pixel limit exceeded';
    if (track?.codec && !isProResRawCodec(track.codec))
        return 'ProRes RAW codec must be aprn or aprh';
    if (
        (track?.width !== undefined && track.width !== width) ||
        (track?.height !== undefined && track.height !== height)
    )
        return 'ProRes RAW frame dimensions do not match its track';
    if (view.getUint16(24) !== 0) return 'ProRes RAW Bayer pattern is not supported';
    if (data[20]! + data[21]! >= width || data[22]! + data[23]! >= height)
        return 'ProRes RAW recommended crop exceeds its dimensions';
    const flags = view.getUint16(78);
    const alignment = (flags >> 1) & 7;
    if (alignment > 4) return 'ProRes RAW tile alignment is invalid';
    if (flags & ~31) return 'ProRes RAW header flags are unsupported';
    if (72 + (flags & 1 ? 64 : 0) + (flags & 16 ? 16 : 0) > headerSize)
        return 'ProRes RAW quantization matrix or linearization curve exceeds its header';
    const count = tileCount(width, height, alignment);
    if (count > MAX_TILES) return 'ProRes RAW tile count limit exceeded';
    const table = 8 + headerSize;
    let offset = table + count * 2;
    if (offset > data.length) return 'ProRes RAW tile table is truncated';
    for (let index = 0; index < count; index++) {
        const size = view.getUint16(table + index * 2);
        if (size < 8 || size > data.length - offset) return 'ProRes RAW tile size is invalid';
        const tileHeader = data[offset]! >>> 3;
        if (tileHeader < 8 || tileHeader > size) return 'ProRes RAW tile header size is invalid';
        const a = view.getUint16(offset + 2);
        const b = view.getUint16(offset + 4);
        const c = view.getUint16(offset + 6);
        if (a + b + c > size - tileHeader) return 'ProRes RAW tile component sizes are invalid';
        offset += size;
    }

    // Vendor metadata after the tiles remains opaque and is preserved by packet copy.
    return undefined;
}
