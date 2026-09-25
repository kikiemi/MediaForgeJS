import { MediaForgeError } from './errors.js';
export function isProResCodec(codec) {
    return /^ap(?:co|cs|cn|ch|4h|4x)$/.test(codec);
}
export function readProResFourCC(config) {
    if (config?.length !== 4)
        return undefined;
    const codec = String.fromCharCode(config[0], config[1], config[2], config[3]);
    return isProResCodec(codec) ? codec : undefined;
}
export function hasProResFrameHeader(data) {
    return data.length >= 8 && data[4] === 0x69 && data[5] === 0x63 && data[6] === 0x70 && data[7] === 0x66;
}
export function proResFrameError(data, track, headerless = false) {
    const start = headerless ? 0 : 8;
    if (data.length < start + 20)
        return 'ProRes frame is truncated';
    if (!headerless && !hasProResFrameHeader(data))
        return 'ProRes requires a complete size/icpf frame header';
    if (headerless && data.length > 0xffffffff - 8)
        return 'ProRes frame size exceeds its 32-bit field';
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (!headerless && view.getUint32(0) !== data.length)
        return 'ProRes frame size does not match its packet';
    const headerSize = view.getUint16(start);
    if (headerSize < 20 || headerSize > data.length - start)
        return 'ProRes frame header size is invalid';
    if (view.getUint16(start + 2) > 1)
        return 'ProRes bitstream version is unsupported';
    const width = view.getUint16(start + 8);
    const height = view.getUint16(start + 10);
    if (!width || !height)
        return 'ProRes frame dimensions must be positive';
    if ((track?.width !== undefined && track.width !== width) ||
        (track?.height !== undefined && track.height !== height))
        return 'ProRes frame dimensions do not match its track';
    const chroma = data[start + 12] >>> 6;
    const interlace = (data[start + 12] >>> 2) & 3;
    const alpha = data[start + 17] & 15;
    if (chroma < 2)
        return 'ProRes chroma format is unsupported';
    if (interlace === 3)
        return 'ProRes interlace mode is unsupported';
    if (alpha > 2)
        return 'ProRes alpha mode is unsupported';
    if (track?.codec && /^apc[osnh]$/.test(track.codec) && (chroma !== 2 || alpha !== 0))
        return 'ProRes frame chroma or alpha contradicts its 422 profile';
    const matrixFlags = data[start + 19] & 3;
    const matrixBytes = ((matrixFlags & 1 ? 1 : 0) + (matrixFlags & 2 ? 1 : 0)) * 64;
    if (20 + matrixBytes > headerSize)
        return 'ProRes quantization matrices exceed the frame header';
    const mbWidth = Math.ceil(width / 16);
    let picture = start + headerSize;
    for (let field = 0; field < (interlace ? 2 : 1); field++) {
        if (data.length - picture < 8)
            return 'ProRes picture header is truncated';
        const pictureHeaderSize = data[picture] >>> 3;
        const pictureSize = view.getUint32(picture + 1);
        if (pictureHeaderSize < 8 || pictureHeaderSize > pictureSize || pictureSize > data.length - picture)
            return 'ProRes picture size or header is invalid';
        const pictureEnd = picture + pictureSize;
        const sliceWidth = 1 << ((data[picture + 7] >>> 4) & 3);
        let remaining = mbWidth;
        let slicesPerRow = 0;
        for (let size = sliceWidth; size >= 1; size /= 2) {
            slicesPerRow += Math.floor(remaining / size);
            remaining %= size;
        }
        const pictureHeight = interlace
            ? Math.floor((height + (field === (interlace === 1 ? 0 : 1) ? 1 : 0)) / 2)
            : height;
        const sliceCount = slicesPerRow * Math.ceil(pictureHeight / 16);
        const table = picture + pictureHeaderSize;
        let error = proResSliceTableError(data, view, table, pictureEnd, sliceCount, alpha);
        const paddedSliceCount = interlace ? slicesPerRow * Math.ceil(height / 32) : sliceCount;
        if (error && paddedSliceCount !== sliceCount)
            error = proResSliceTableError(data, view, table, pictureEnd, paddedSliceCount, alpha);
        if (error)
            return error;
        picture = pictureEnd;
    }
    for (let offset = picture; offset < data.length; offset++) {
        if (data[offset] !== 0)
            return 'ProRes frame stuffing must contain only zero bytes';
    }
    return undefined;
}
function proResSliceTableError(data, view, table, pictureEnd, sliceCount, alpha) {
    let slice = table + sliceCount * 2;
    if (!sliceCount || slice > pictureEnd)
        return 'ProRes slice table exceeds its picture';
    for (let index = 0; index < sliceCount; index++) {
        const size = view.getUint16(table + index * 2);
        if (size < (alpha ? 8 : 6) || size > pictureEnd - slice)
            return 'ProRes slice size is invalid';
        const sliceHeaderSize = data[slice] >>> 3;
        if (sliceHeaderSize < (alpha ? 8 : 6) || sliceHeaderSize > size)
            return 'ProRes slice header size is invalid';
        const y = view.getUint16(slice + 2);
        const cb = view.getUint16(slice + 4);
        const cr = alpha ? view.getUint16(slice + 6) : size - sliceHeaderSize - y - cb;
        const planesSize = sliceHeaderSize + y + cb + cr;
        if (!y || cr < 0 || planesSize > size || (alpha && planesSize === size))
            return 'ProRes plane data sizes are invalid';
        slice += size;
    }
    return slice === pictureEnd ? undefined : 'ProRes slice sizes do not fill their picture';
}
export function restoreProResFrame(data) {
    const error = proResFrameError(data, undefined, true);
    if (error)
        throw new MediaForgeError(error, 'DEMUX');
    const frame = new Uint8Array(data.length + 8);
    new DataView(frame.buffer).setUint32(0, frame.length);
    frame.set([0x69, 0x63, 0x70, 0x66], 4);
    frame.set(data, 8);
    return frame;
}
