// SPDX-License-Identifier: LGPL-2.1-or-later
// Original bounded packet parser for the optional MediaForgeJS ProRes RAW decoder.

export class ProResRawError extends Error {
    constructor(message, code = 'INVALID_DATA') {
        super(`ProRes RAW: ${message}`);
        this.name = 'ProResRawError';
        this.code = code;
    }
}

export function checkAbort(signal) {
    if (signal?.aborted) {
        const error = new Error('ProRes RAW decoding aborted');
        error.name = 'AbortError';
        throw error;
    }
}

function limit(value, fallback, name, ceiling) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0 || result > ceiling)
        throw new ProResRawError(`${name} must be a positive integer no greater than ${ceiling}`, 'LIMIT');
    return result;
}

export function checkInput(data, options) {
    checkAbort(options.signal);
    if (!(data instanceof Uint8Array)) throw new TypeError('ProRes RAW data must be a Uint8Array');
    const maxBytes = limit(options.maxFrameBytes, 128 * 1024 * 1024, 'packet byte limit', 1024 * 1024 * 1024);
    if (data.length > maxBytes) throw new ProResRawError('packet byte size limit exceeded', 'LIMIT');
}

export function parsePacket(data, options) {
    checkInput(data, options);
    const maxPixels = limit(options.maxPixels, 64 * 1024 * 1024, 'pixel limit', 256 * 1024 * 1024);
    const maxTiles = limit(options.maxTiles, 262144, 'tile limit', 1048576);
    const invalid = message => {
        throw new ProResRawError(message);
    };
    const unsupported = message => {
        throw new ProResRawError(message, 'UNSUPPORTED');
    };
    if (options.codec !== undefined && options.codec !== 'aprn' && options.codec !== 'aprh')
        unsupported('codec must be aprn or aprh');
    if (data.length < 80) invalid('frame is truncated');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0) !== data.length) invalid('frame size does not match packet');
    if (view.getUint32(4) !== 0x70727266) invalid('complete size/prrf packet required');
    const headerSize = view.getUint16(8);
    if (headerSize < 72 || headerSize > data.length - 8) invalid('frame header size is invalid');
    const version = view.getUint16(10);
    if (version > 1) unsupported('bitstream version is unsupported');
    const width = view.getUint16(16);
    const height = view.getUint16(18);
    if (!width || !height || width & 1 || height & 1) invalid('dimensions must be positive and even');
    if (width * height > maxPixels) throw new ProResRawError('pixel limit exceeded', 'LIMIT');
    if (view.getUint16(24) !== 0) unsupported('Bayer pattern is unsupported; only RGGB is decoded');
    const crop = { left: data[20], right: data[21], top: data[22], bottom: data[23] };
    if (crop.left + crop.right >= width || crop.top + crop.bottom >= height)
        invalid('recommended crop exceeds dimensions');
    const flags = view.getUint16(78);
    const alignment = (flags >> 1) & 7;
    if (alignment > 4) invalid('tile alignment exceeds four');
    if (flags & ~31) unsupported('header flags are unsupported');
    const requiredHeader = 72 + (flags & 1 ? 64 : 0) + (flags & 16 ? 16 : 0);
    if (headerSize < requiredHeader) invalid('matrix or linearization curve exceeds header');
    let cursor = 80;
    const quantization = new Uint8Array(64).fill(1);
    if (flags & 1) {
        quantization.set(data.subarray(cursor, cursor + 64));
        cursor += 64;
    }
    const curve = [0, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    if (flags & 16)
        for (let i = 0; i < 8; i++) {
            curve[i] = view.getUint16(cursor);
            cursor += 2;
        }
    let columns = 0;
    let remaining = Math.ceil(width / 16);
    for (let unit = 2 ** alignment; unit >= 1; unit /= 2) {
        columns += Math.floor(remaining / unit);
        remaining %= unit;
    }
    const count = columns * Math.ceil(height / 16);
    if (count > maxTiles) throw new ProResRawError('tile count limit exceeded', 'LIMIT');
    const table = 8 + headerSize;
    let offset = table + count * 2;
    if (offset > data.length) invalid('tile table is truncated');
    const tiles = [];
    for (let y = 0; y < height; y += 16) {
        let x = 0;
        remaining = Math.ceil(width / 16);
        for (let log2Blocks = alignment; log2Blocks >= 0; log2Blocks--) {
            const blocks = 2 ** log2Blocks;
            while (remaining >= blocks) {
                const size = view.getUint16(table + tiles.length * 2);
                if (size < 8 || size > data.length - offset) invalid('tile size is invalid');
                const header = data[offset] >>> 3;
                if (header < 8 || header > size) invalid('tile header size is invalid');
                const lengths = [view.getUint16(offset + 2), view.getUint16(offset + 4), view.getUint16(offset + 6)];
                lengths.push(size - header - lengths[0] - lengths[1] - lengths[2]);
                if (lengths[3] < 0) invalid('tile component sizes are invalid');
                const scale = data[offset + 1];
                // Quantizers are signed 16-bit in the reference transform. Reject a
                // corrupt product instead of allowing it to become a negative scale.
                if (quantization.some(value => value * scale > 32767))
                    invalid('tile quantizer exceeds signed 16-bit range');
                tiles.push({ x, y, log2Blocks, offset: offset + header, lengths, scale });
                offset += size;
                x += blocks * 16;
                remaining -= blocks;
            }
        }
    }
    checkAbort(options.signal);
    const matrix = Array.from({ length: 9 }, (_, i) => view.getFloat32(36 + i * 4));
    const red = view.getFloat32(28),
        blue = view.getFloat32(32),
        gain = view.getFloat32(72);
    const whiteLevel = view.getUint16(26) + 256;
    const determinant =
        matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
        matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6]) +
        matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
    const color = {
        transfer: 'linear',
        blackLevel: 256,
        whiteLevel,
        whiteBalance: { red, green: 1, blue, cctKelvin: view.getUint16(76) },
        cameraToXYZD65: matrix,
        gain,
        linearizationCurve: curve,
        appliedLinearization: true,
        appliedWhiteBalance: false,
        appliedColorMatrix: false,
        appliedGain: false,
        valid:
            [red, blue, gain, ...matrix].every(Number.isFinite) &&
            red > 0 &&
            blue > 0 &&
            gain > 0 &&
            whiteLevel > 256 &&
            whiteLevel <= 65535 &&
            Number.isFinite(determinant) &&
            determinant !== 0,
    };
    return {
        tiles,
        quantization,
        frame: {
            width,
            height,
            stride: width,
            format: 'bayer-rggb16',
            bayerPattern: 'rggb',
            bitDepth: 16,
            data: new Uint16Array(width * height),
            codec: options.codec,
            version,
            vendor: String.fromCharCode(...data.subarray(12, 16)),
            recommendedCrop: crop,
            color,
            rawHeader: data.slice(8, 8 + headerSize),
            vendorMetadata: data.slice(offset),
        },
    };
}
