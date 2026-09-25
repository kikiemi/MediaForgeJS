function readU16(bytes, offset, littleEndian) {
    return littleEndian ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}
function readU32(bytes, offset, littleEndian) {
    return littleEndian
        ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
        : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
function dimensions(width, height) {
    return width > 0 && height > 0 ? { width, height } : null;
}
function tiffByteOrder(bytes) {
    if (bytes.length < 8)
        return null;
    if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0)
        return true;
    if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a)
        return false;
    return null;
}
function tiffEntryDimensions(entries, littleEndian) {
    let width = 0;
    let height = 0;
    for (let offset = 0; offset < entries.length; offset += 12) {
        const tag = readU16(entries, offset, littleEndian);
        if (tag !== 256 && tag !== 257)
            continue;
        const type = readU16(entries, offset + 2, littleEndian);
        if (type !== 1 && type !== 3 && type !== 4)
            continue;
        if (readU32(entries, offset + 4, littleEndian) !== 1)
            return null;
        const value = type === 1
            ? entries[offset + 8]
            : type === 3
                ? readU16(entries, offset + 8, littleEndian)
                : readU32(entries, offset + 8, littleEndian);
        if (value === 0)
            return null;
        if (tag === 256) {
            if (width !== 0 && width !== value)
                return null;
            width = value;
        }
        else {
            if (height !== 0 && height !== value)
                return null;
            height = value;
        }
    }
    return dimensions(width, height);
}
export function sniffImageDimensions(head) {
    if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
        if (head[4] !== 0x0d ||
            head[5] !== 0x0a ||
            head[6] !== 0x1a ||
            head[7] !== 0x0a ||
            readU32(head, 8, false) !== 13 ||
            head[12] !== 0x49 ||
            head[13] !== 0x48 ||
            head[14] !== 0x44 ||
            head[15] !== 0x52) {
            return null;
        }
        const width = readU32(head, 16, false);
        const height = readU32(head, 20, false);
        return width <= 0x7fffffff && height <= 0x7fffffff ? dimensions(width, height) : null;
    }
    if (head.length >= 10 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
        if (head[3] !== 0x38 || (head[4] !== 0x37 && head[4] !== 0x39) || head[5] !== 0x61)
            return null;
        return dimensions(readU16(head, 6, true), readU16(head, 8, true));
    }
    if (head.length >= 22 && head[0] === 0x42 && head[1] === 0x4d) {
        const dibSize = readU32(head, 14, true);
        if (dibSize === 12)
            return dimensions(readU16(head, 18, true), readU16(head, 20, true));
        if (dibSize < 16 || (dibSize < 40 && dibSize % 4 !== 0) || head.length < 26)
            return null;
        return dimensions(readU32(head, 18, true) | 0, Math.abs(readU32(head, 22, true) | 0));
    }
    if (head.length >= 20 &&
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50) {
        const chunkSize = readU32(head, 16, true);
        if (20 + chunkSize + (chunkSize & 1) > 8 + readU32(head, 4, true))
            return null;
        const chunk = String.fromCharCode(head[12], head[13], head[14], head[15]);
        if (chunk === 'VP8X') {
            if (chunkSize !== 10 || head.length < 30)
                return null;
            const width = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
            const height = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
            return { width, height };
        }
        if (chunk === 'VP8 ') {
            if (chunkSize < 10 ||
                head.length < 30 ||
                (head[20] & 1) !== 0 ||
                head[23] !== 0x9d ||
                head[24] !== 1 ||
                head[25] !== 0x2a)
                return null;
            return dimensions(readU16(head, 26, true) & 0x3fff, readU16(head, 28, true) & 0x3fff);
        }
        if (chunk === 'VP8L') {
            if (chunkSize < 5 || head.length < 25 || head[20] !== 0x2f || (head[24] & 0xe0) !== 0)
                return null;
            const bits = readU32(head, 21, true);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
        }
        return null;
    }
    if (head.length >= 6 && head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0) {
        const count = readU16(head, 4, true);
        if (count === 0 || 6 + count * 16 > head.length)
            return null;
        let width = 0;
        let height = 0;
        for (let i = 0; i < count; i++) {
            const offset = 6 + i * 16;
            width = Math.max(width, head[offset] === 0 ? 256 : head[offset]);
            height = Math.max(height, head[offset + 1] === 0 ? 256 : head[offset + 1]);
        }
        return { width, height };
    }
    const littleEndian = tiffByteOrder(head);
    if (littleEndian !== null) {
        const ifd = readU32(head, 4, littleEndian);
        if (ifd < 8 || ifd + 2 > head.length)
            return null;
        const entries = readU16(head, ifd, littleEndian);
        const end = ifd + 2 + entries * 12;
        if (entries === 0 || end > head.length)
            return null;
        return tiffEntryDimensions(head.subarray(ifd + 2, end), littleEndian);
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
        let pos = 2;
        while (pos < head.length) {
            if (head[pos] !== 0xff)
                return null;
            while (head[pos] === 0xff)
                pos++;
            if (pos >= head.length)
                return null;
            const marker = head[pos++];
            if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda)
                return null;
            if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7))
                continue;
            if (pos + 2 > head.length)
                return null;
            const length = readU16(head, pos, false);
            if (length < 2)
                return null;
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                if (length < 11 || length > 773 || (length - 8) % 3 !== 0 || pos + 7 > head.length)
                    return null;
                if (pos + 7 < head.length && head[pos + 7] !== (length - 8) / 3)
                    return null;
                return dimensions(readU16(head, pos + 5, false), readU16(head, pos + 3, false));
            }
            pos += length;
            if (pos > head.length)
                return null;
        }
    }
    return null;
}
export async function sniffTiffDimensionsAt(file) {
    if (file.size < 8)
        return null;
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const littleEndian = tiffByteOrder(head);
    if (littleEndian === null)
        return null;
    const ifd = readU32(head, 4, littleEndian);
    if (ifd < 8 || ifd + 2 > file.size)
        return null;
    const countBytes = new Uint8Array(await file.slice(ifd, ifd + 2).arrayBuffer());
    if (countBytes.length !== 2)
        return null;
    const entries = readU16(countBytes, 0, littleEndian);
    if (entries === 0 || entries > 4096 || ifd + 2 + entries * 12 > file.size)
        return null;
    const dir = new Uint8Array(await file.slice(ifd + 2, ifd + 2 + entries * 12).arrayBuffer());
    if (dir.length !== entries * 12)
        return null;
    return tiffEntryDimensions(dir, littleEndian);
}
