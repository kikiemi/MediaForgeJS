export function isProResRawCodec(codec) {
    return codec === 'aprn' || codec === 'aprh';
}
export function hasProResRawFrameHeader(data) {
    return data.length >= 8 && data[4] === 0x70 && data[5] === 0x72 && data[6] === 0x72 && data[7] === 0x66;
}
function limitError(limits) {
    for (const [name, value] of Object.entries(limits)) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
            return `ProRes RAW ${name} must be a positive safe integer`;
    }
    return undefined;
}
function tileCount(width, height, alignment) {
    let remaining = Math.ceil(width / 16);
    let columns = 0;
    for (let unit = 2 ** alignment; unit >= 1; unit /= 2) {
        columns += Math.floor(remaining / unit);
        remaining %= unit;
    }
    return columns * Math.ceil(height / 16);
}
export function proResRawFrameError(data, track, limits = {}) {
    const badLimit = limitError(limits);
    if (badLimit)
        return badLimit;
    if (data.length > (limits.maxFrameBytes ?? 128 * 1024 * 1024))
        return 'ProRes RAW packet byte size limit exceeded';
    if (data.length < 80)
        return 'ProRes RAW frame is truncated';
    if (!hasProResRawFrameHeader(data))
        return 'ProRes RAW requires a complete size/prrf frame header';
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== data.length)
        return 'ProRes RAW frame size does not match its packet';
    const headerSize = view.getUint16(8);
    if (headerSize < 72 || headerSize > data.length - 8)
        return 'ProRes RAW frame header size is invalid';
    if (view.getUint16(10) > 1)
        return 'ProRes RAW bitstream version is unsupported';
    const width = view.getUint16(16);
    const height = view.getUint16(18);
    if (!width || !height || width & 1 || height & 1)
        return 'ProRes RAW dimensions must be positive and even';
    if (width * height > (limits.maxPixels ?? 64 * 1024 * 1024))
        return 'ProRes RAW pixel limit exceeded';
    if (track?.codec && !isProResRawCodec(track.codec))
        return 'ProRes RAW codec must be aprn or aprh';
    if ((track?.width !== undefined && track.width !== width) ||
        (track?.height !== undefined && track.height !== height))
        return 'ProRes RAW frame dimensions do not match its track';
    if (view.getUint16(24) !== 0)
        return 'ProRes RAW Bayer pattern is unsupported';
    if (data[20] + data[21] >= width || data[22] + data[23] >= height)
        return 'ProRes RAW recommended crop exceeds its dimensions';
    const flags = view.getUint16(78);
    const alignment = (flags >> 1) & 7;
    if (alignment > 4)
        return 'ProRes RAW tile alignment is invalid';
    if (flags & ~31)
        return 'ProRes RAW header flags are unsupported';
    if (72 + (flags & 1 ? 64 : 0) + (flags & 16 ? 16 : 0) > headerSize)
        return 'ProRes RAW quantization matrix or linearization curve exceeds its header';
    const count = tileCount(width, height, alignment);
    if (count > (limits.maxTiles ?? 262144))
        return 'ProRes RAW tile count limit exceeded';
    const table = 8 + headerSize;
    let offset = table + count * 2;
    if (offset > data.length)
        return 'ProRes RAW tile table is truncated';
    for (let index = 0; index < count; index++) {
        const size = view.getUint16(table + index * 2);
        if (size < 8 || size > data.length - offset)
            return 'ProRes RAW tile size is invalid';
        const tileHeader = data[offset] >>> 3;
        if (tileHeader < 8 || tileHeader > size)
            return 'ProRes RAW tile header size is invalid';
        const a = view.getUint16(offset + 2);
        const b = view.getUint16(offset + 4);
        const c = view.getUint16(offset + 6);
        if (a + b + c > size - tileHeader)
            return 'ProRes RAW tile component sizes are invalid';
        offset += size;
    }
    return undefined;
}
export function readProResRawFrameHeader(data, track, limits = {}) {
    const error = proResRawFrameError(data, track, limits);
    if (error)
        throw new RangeError(error);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = view.getUint16(16);
    const height = view.getUint16(18);
    const flags = view.getUint16(78);
    const tileAlignment = (flags >> 1) & 7;
    return {
        version: view.getUint16(10),
        width,
        height,
        headerSize: view.getUint16(8),
        tileAlignment,
        tileCount: tileCount(width, height, tileAlignment),
        bayerPattern: 0,
        flags,
    };
}
