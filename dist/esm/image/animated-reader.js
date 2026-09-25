import { RgbaResizer } from './rgba-resize.js';
import { yieldEventLoop } from '../core/demux-guard.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { inflateBounded } from '../core/inflate.js';
import { pngCrc32 } from './png-crc.js';
function assertPixelBudget(frames, w, h, maxTotalPixels, what) {
    if (!Number.isSafeInteger(maxTotalPixels) || maxTotalPixels < 0) {
        throw new MediaForgeError('animated image pixel budget must be a non-negative safe integer', 'FORMAT');
    }
    if (!Number.isSafeInteger(frames * w * h) || frames * w * h > maxTotalPixels) {
        const maxFrames = Math.floor(maxTotalPixels / Math.max(1, w * h));
        throw new MediaForgeError(`animated ${what} holds ${frames}×${w}×${h} pixels, over the decode budget; ` +
            `at ${w}×${h}, up to ${maxFrames} frames fit`, 'FORMAT');
    }
}
export async function decodeAnimatedGif(bytes, maxTotalPixels, signal) {
    signal?.throwIfAborted();
    if (bytes.length < 13)
        throw new DemuxError('GIF too small');
    const sig = String.fromCharCode(...bytes.subarray(0, 6));
    if (sig !== 'GIF87a' && sig !== 'GIF89a')
        throw new DemuxError('missing GIF signature');
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (width === 0 || height === 0)
        throw new DemuxError('GIF has zero logical screen size');
    let pos = 13;
    const packed = bytes[10];
    let globalPalette = null;
    if (packed & 0x80) {
        const n = 2 ** ((packed & 0x07) + 1);
        if (pos + n * 3 > bytes.length)
            throw new DemuxError('GIF global color table truncated');
        globalPalette = bytes.subarray(pos, pos + n * 3);
        pos += n * 3;
    }
    let frameCount = 0;
    let sawTrailer = false;
    {
        let p = pos;
        let blocks = 0;
        while (p < bytes.length) {
            if ((blocks++ & 255) === 0) {
                signal?.throwIfAborted();
                await yieldEventLoop();
                signal?.throwIfAborted();
            }
            const b = bytes[p];
            if (b === 0x3b) {
                sawTrailer = true;
                break;
            }
            if (b === 0x2c) {
                frameCount++;
                if (p + 10 > bytes.length)
                    throw new DemuxError('GIF image descriptor truncated');
                const lp = bytes[p + 9];
                p += 10;
                if (lp & 0x80)
                    p += 3 * 2 ** ((lp & 0x07) + 1);
                if (p >= bytes.length)
                    throw new DemuxError('GIF image data header truncated');
                p += 1;
                p = skipSubBlocks(bytes, p);
            }
            else if (b === 0x21) {
                p += 2;
                p = skipSubBlocks(bytes, p);
            }
            else {
                throw new DemuxError(`GIF: unknown block 0x${b.toString(16)} at ${p}`);
            }
        }
    }
    if (!sawTrailer)
        throw new DemuxError('GIF trailer missing');
    if (frameCount === 0)
        throw new DemuxError('GIF contains no image frames');
    assertPixelBudget(frameCount, width, height, maxTotalPixels, 'GIF');
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frames = [];
    let loopCount = 1;
    let transparentIdx = -1;
    let delayCs = 0;
    let disposal = 0;
    let snapshot = null;
    let blocks = 0;
    while (pos < bytes.length) {
        if ((blocks++ & 7) === 0) {
            signal?.throwIfAborted();
            await yieldEventLoop();
            signal?.throwIfAborted();
        }
        const b = bytes[pos];
        if (b === 0x3b)
            break;
        if (b === 0x21) {
            const label = bytes[pos + 1];
            if (label === 0xf9) {
                if (bytes[pos + 2] !== 4 || bytes[pos + 7] !== 0) {
                    throw new DemuxError('GIF graphic control extension has invalid size or terminator');
                }
                const flags = bytes[pos + 3];
                disposal = (flags >> 2) & 0x07;
                if (disposal > 3)
                    throw new DemuxError('GIF disposal method is invalid');
                delayCs = bytes[pos + 4] | (bytes[pos + 5] << 8);
                transparentIdx = flags & 1 ? bytes[pos + 6] : -1;
            }
            else if (label === 0xff && bytes[pos + 2] === 11) {
                const app = String.fromCharCode(...bytes.subarray(pos + 3, pos + 14));
                if (app === 'NETSCAPE2.0' && bytes[pos + 14] === 3 && bytes[pos + 15] === 1) {
                    const repeats = bytes[pos + 16] | (bytes[pos + 17] << 8);
                    loopCount = repeats === 0 ? 0 : repeats + 1;
                }
            }
            pos += 2;
            pos = skipSubBlocks(bytes, pos);
        }
        else if (b === 0x2c) {
            const fx = bytes[pos + 1] | (bytes[pos + 2] << 8);
            const fy = bytes[pos + 3] | (bytes[pos + 4] << 8);
            const fw = bytes[pos + 5] | (bytes[pos + 6] << 8);
            const fh = bytes[pos + 7] | (bytes[pos + 8] << 8);
            const lp = bytes[pos + 9];
            pos += 10;
            let palette = globalPalette;
            if (lp & 0x80) {
                const n = 2 ** ((lp & 0x07) + 1);
                if (pos + n * 3 > bytes.length)
                    throw new DemuxError('GIF local color table truncated');
                palette = bytes.subarray(pos, pos + n * 3);
                pos += n * 3;
            }
            if (!palette)
                throw new DemuxError('GIF frame has no color table');
            if (fw === 0 || fh === 0 || fx + fw > width || fy + fh > height) {
                throw new DemuxError('GIF frame rectangle outside the canvas');
            }
            const interlaced = !!(lp & 0x40);
            const minCode = bytes[pos];
            pos += 1;
            const { data: lzw, next } = collectSubBlocks(bytes, pos);
            pos = next;
            let indices = lzwDecode(lzw, minCode, fw * fh);
            if (interlaced)
                indices = deinterlace(indices, fw, fh);
            if (disposal === 3) {
                snapshot = canvas.slice();
            }
            for (let y = 0; y < fh; y++) {
                let src = y * fw;
                let dst = ((fy + y) * width + fx) * 4;
                for (let x = 0; x < fw; x++, src++, dst += 4) {
                    const idx = indices[src];
                    if (idx === transparentIdx)
                        continue;
                    const p3 = idx * 3;
                    if (p3 + 2 >= palette.length)
                        throw new DemuxError('GIF pixel index outside the color table');
                    canvas[dst] = palette[p3];
                    canvas[dst + 1] = palette[p3 + 1];
                    canvas[dst + 2] = palette[p3 + 2];
                    canvas[dst + 3] = 255;
                }
            }
            frames.push({ rgba: canvas.slice(), delayMs: delayCs * 10 });
            if (disposal === 2) {
                for (let y = 0; y < fh; y++) {
                    const dst = ((fy + y) * width + fx) * 4;
                    canvas.fill(0, dst, dst + fw * 4);
                }
            }
            else if (disposal === 3 && snapshot) {
                canvas.set(snapshot);
            }
            transparentIdx = -1;
            delayCs = 0;
            disposal = 0;
        }
        else {
            throw new DemuxError(`GIF: unknown block 0x${b.toString(16)} at ${pos}`);
        }
    }
    signal?.throwIfAborted();
    return { width, height, frames, loopCount };
}
function skipSubBlocks(bytes, p) {
    while (true) {
        if (p >= bytes.length)
            throw new DemuxError('GIF sub-block chain truncated');
        const n = bytes[p];
        p += 1 + n;
        if (n === 0)
            return p;
        if (p > bytes.length)
            throw new DemuxError('GIF sub-block data truncated');
    }
}
function collectSubBlocks(bytes, p) {
    let total = 0;
    let q = p;
    while (true) {
        if (q >= bytes.length)
            throw new DemuxError('GIF sub-block chain truncated');
        const n = bytes[q];
        q += 1;
        if (n === 0)
            break;
        if (q + n > bytes.length)
            throw new DemuxError('GIF sub-block data truncated');
        total += n;
        q += n;
    }
    const out = new Uint8Array(total);
    let o = 0;
    q = p;
    while (true) {
        const n = bytes[q];
        q += 1;
        if (n === 0)
            break;
        out.set(bytes.subarray(q, q + n), o);
        o += n;
        q += n;
    }
    return { data: out, next: q };
}
function lzwDecode(data, minCodeSize, expectedPixels) {
    if (minCodeSize < 2 || minCodeSize > 8)
        throw new DemuxError(`GIF LZW minimum code size ${minCodeSize} out of range`);
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const out = new Uint8Array(expectedPixels);
    let outPos = 0;
    const MAX = 4096;
    const prefix = new Int32Array(MAX);
    const suffix = new Uint8Array(MAX);
    const length = new Int32Array(MAX);
    let codeSize = 0;
    let nextCode = 0;
    const reset = () => {
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
        for (let i = 0; i < clearCode; i++) {
            prefix[i] = -1;
            suffix[i] = i;
            length[i] = 1;
        }
    };
    reset();
    let bitPos = 0;
    const readCode = () => {
        let v = 0;
        for (let i = 0; i < codeSize; i++) {
            const byte = data[bitPos >> 3];
            if (byte === undefined)
                return -1;
            v |= ((byte >> (bitPos & 7)) & 1) << i;
            bitPos++;
        }
        return v;
    };
    const emit = (code, firstOut) => {
        const len = length[code];
        if (outPos + len > out.length)
            throw new DemuxError('GIF LZW output exceeds the frame size');
        let p = outPos + len - 1;
        let c = code;
        while (c >= 0) {
            out[p--] = suffix[c];
            c = prefix[c];
        }
        if (firstOut)
            firstOut.v = out[outPos];
        outPos += len;
    };
    let prev = -1;
    while (true) {
        const code = readCode();
        if (code < 0)
            throw new DemuxError('GIF LZW stream has no end-of-information code');
        if (code === eoiCode)
            break;
        if (code === clearCode) {
            reset();
            prev = -1;
            continue;
        }
        if (prev < 0) {
            if (code >= clearCode)
                throw new DemuxError('GIF LZW stream starts with an undefined code');
            emit(code);
            prev = code;
            continue;
        }
        const first = { v: 0 };
        if (code < nextCode) {
            emit(code, first);
        }
        else if (code === nextCode) {
            const len = length[prev] + 1;
            if (outPos + len > out.length)
                throw new DemuxError('GIF LZW output exceeds the frame size');
            emit(prev, first);
            out[outPos++] = first.v;
        }
        else {
            throw new DemuxError('GIF LZW references a code past the dictionary');
        }
        if (nextCode < MAX) {
            prefix[nextCode] = prev;
            suffix[nextCode] = first.v;
            length[nextCode] = length[prev] + 1;
            nextCode++;
            if (nextCode === 1 << codeSize && codeSize < 12)
                codeSize++;
        }
        prev = code;
    }
    if (outPos < expectedPixels)
        throw new DemuxError(`GIF LZW ended after ${outPos}/${expectedPixels} pixels`);
    return out;
}
function deinterlace(indices, w, h) {
    const out = new Uint8Array(indices.length);
    const passes = [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
    ];
    let src = 0;
    for (const [start, step] of passes) {
        for (let y = start; y < h; y += step) {
            out.set(indices.subarray(src, src + w), y * w);
            src += w;
        }
    }
    return out;
}
async function parsePngChunks(bytes, signal) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 8 || sig.some((v, i) => bytes[i] !== v))
        throw new DemuxError('missing PNG signature');
    const chunks = [];
    const unique = new Set();
    let pos = 8;
    let checkedBytes = 0;
    let checkedChunks = 0;
    const checksumBatchBytes = 1024 * 1024;
    while (pos + 12 <= bytes.length) {
        if (checkedChunks >= 256) {
            signal?.throwIfAborted();
            await yieldEventLoop();
            signal?.throwIfAborted();
            checkedBytes = checkedChunks = 0;
        }
        const len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
        const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        if (pos + 12 + len > bytes.length)
            throw new DemuxError(`PNG chunk '${type}' truncated`);
        if (!/^[A-Za-z]{4}$/.test(type) || len > 0x7fffffff)
            throw new DemuxError('PNG has an invalid chunk header');
        if (chunks.length === 0 && type !== 'IHDR')
            throw new DemuxError('PNG must begin with IHDR');
        if (type === 'IHDR' || type === 'acTL' || type === 'PLTE' || type === 'tRNS') {
            if (unique.has(type))
                throw new DemuxError(`PNG has duplicate ${type}`);
            unique.add(type);
        }
        if (!(bytes[pos + 4] & 0x20) && type !== 'IHDR' && type !== 'PLTE' && type !== 'IDAT' && type !== 'IEND') {
            throw new DemuxError(`PNG has unsupported critical chunk '${type}'`);
        }
        const dataEnd = pos + 8 + len;
        let crc = 0;
        for (let start = pos + 4; start < dataEnd;) {
            const end = Math.min(dataEnd, start + checksumBatchBytes - checkedBytes);
            crc = pngCrc32(bytes.subarray(start, end), crc);
            checkedBytes += end - start;
            start = end;
            if (checkedBytes === checksumBatchBytes) {
                signal?.throwIfAborted();
                await yieldEventLoop();
                signal?.throwIfAborted();
                checkedBytes = checkedChunks = 0;
            }
        }
        const expectedCrc = ((bytes[dataEnd] << 24) |
            (bytes[dataEnd + 1] << 16) |
            (bytes[dataEnd + 2] << 8) |
            bytes[dataEnd + 3]) >>>
            0;
        if (crc !== expectedCrc)
            throw new DemuxError(`PNG chunk '${type}' CRC mismatch`);
        if (type === 'PLTE' && unique.has('tRNS'))
            throw new DemuxError('PNG PLTE must precede tRNS');
        chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + len) });
        checkedChunks++;
        pos += 12 + len;
        if (type === 'IEND') {
            if (len !== 0)
                throw new DemuxError('PNG IEND must be empty');
            return chunks;
        }
    }
    throw new DemuxError('PNG has no IEND');
}
function unfilterScanlines(raw, h, bpp, rowBytes) {
    const out = new Uint8Array(rowBytes * h);
    if (raw.length < (rowBytes + 1) * h)
        throw new DemuxError('PNG pixel data shorter than its geometry requires');
    for (let y = 0; y < h; y++) {
        const filter = raw[y * (rowBytes + 1)];
        const src = y * (rowBytes + 1) + 1;
        const dst = y * rowBytes;
        const prevRow = dst - rowBytes;
        switch (filter) {
            case 0:
                out.set(raw.subarray(src, src + rowBytes), dst);
                break;
            case 1:
                for (let x = 0; x < rowBytes; x++) {
                    out[dst + x] = (raw[src + x] + (x >= bpp ? out[dst + x - bpp] : 0)) & 0xff;
                }
                break;
            case 2:
                for (let x = 0; x < rowBytes; x++) {
                    out[dst + x] = (raw[src + x] + (y > 0 ? out[prevRow + x] : 0)) & 0xff;
                }
                break;
            case 3:
                for (let x = 0; x < rowBytes; x++) {
                    const a = x >= bpp ? out[dst + x - bpp] : 0;
                    const b = y > 0 ? out[prevRow + x] : 0;
                    out[dst + x] = (raw[src + x] + ((a + b) >> 1)) & 0xff;
                }
                break;
            case 4:
                for (let x = 0; x < rowBytes; x++) {
                    const a = x >= bpp ? out[dst + x - bpp] : 0;
                    const b = y > 0 ? out[prevRow + x] : 0;
                    const c = x >= bpp && y > 0 ? out[prevRow + x - bpp] : 0;
                    const p = a + b - c;
                    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    out[dst + x] = (raw[src + x] + pred) & 0xff;
                }
                break;
            default:
                throw new DemuxError(`PNG filter type ${filter} is invalid`);
        }
    }
    return out;
}
function samplesPerPixel(colorType) {
    switch (colorType) {
        case 0:
            return 1;
        case 2:
            return 3;
        case 3:
            return 1;
        case 4:
            return 2;
        case 6:
            return 4;
        default:
            throw new DemuxError(`PNG color type ${colorType} is invalid`);
    }
}
function rowsToRgba(rows, w, h, hdr, palette, trns, rowBytes) {
    const { bitDepth, colorType } = hdr;
    const out = new Uint8ClampedArray(w * h * 4);
    const readSample = (row, i) => {
        if (bitDepth === 8)
            return rows[row * rowBytes + i];
        const bitsPer = bitDepth;
        const bitOff = i * bitsPer;
        const byte = rows[row * rowBytes + (bitOff >> 3)];
        const shift = 8 - bitsPer - (bitOff & 7);
        return (byte >> shift) & ((1 << bitsPer) - 1);
    };
    const scaleMax = (1 << bitDepth) - 1;
    const transparentGray = colorType === 0 && trns ? ((trns[0] << 8) | trns[1]) & scaleMax : -1;
    const transparentRgb = colorType === 2 && trns ? [trns[1] & scaleMax, trns[3] & scaleMax, trns[5] & scaleMax] : null;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (colorType === 3) {
                const idx = readSample(y, x);
                const p3 = idx * 3;
                if (!palette || p3 + 2 >= palette.length)
                    throw new DemuxError('PNG pixel index outside the palette');
                out[o] = palette[p3];
                out[o + 1] = palette[p3 + 1];
                out[o + 2] = palette[p3 + 2];
                out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
            }
            else if (colorType === 0) {
                const sample = readSample(y, x);
                const g = Math.round((sample / scaleMax) * 255);
                out[o] = out[o + 1] = out[o + 2] = g;
                out[o + 3] = sample === transparentGray ? 0 : 255;
            }
            else if (colorType === 2) {
                const base = y * rowBytes + x * 3;
                out[o] = rows[base];
                out[o + 1] = rows[base + 1];
                out[o + 2] = rows[base + 2];
                out[o + 3] =
                    transparentRgb &&
                        out[o] === transparentRgb[0] &&
                        out[o + 1] === transparentRgb[1] &&
                        out[o + 2] === transparentRgb[2]
                        ? 0
                        : 255;
            }
            else if (colorType === 4) {
                const base = y * rowBytes + x * 2;
                out[o] = out[o + 1] = out[o + 2] = rows[base];
                out[o + 3] = rows[base + 1];
            }
            else {
                const base = y * rowBytes + x * 4;
                out[o] = rows[base];
                out[o + 1] = rows[base + 1];
                out[o + 2] = rows[base + 2];
                out[o + 3] = rows[base + 3];
            }
        }
    }
    return out;
}
export async function decodeApng(bytes, maxTotalPixels, signal) {
    signal?.throwIfAborted();
    const chunks = await parsePngChunks(bytes, signal);
    const ihdr = chunks.find(c => c.type === 'IHDR');
    if (!ihdr || ihdr.data.length !== 13)
        throw new DemuxError('PNG has an invalid IHDR');
    const width = ((ihdr.data[0] << 24) | (ihdr.data[1] << 16) | (ihdr.data[2] << 8) | ihdr.data[3]) >>> 0;
    const height = ((ihdr.data[4] << 24) | (ihdr.data[5] << 16) | (ihdr.data[6] << 8) | ihdr.data[7]) >>> 0;
    if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        throw new DemuxError('PNG has invalid image dimensions');
    }
    const bitDepth = ihdr.data[8];
    const colorType = ihdr.data[9];
    const spp = samplesPerPixel(colorType);
    if (ihdr.data[12] !== 0)
        throw new DemuxError('interlaced APNG is not supported');
    if (bitDepth === 16)
        throw new DemuxError('16-bit APNG is not supported');
    if ((bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) ||
        (colorType !== 0 && colorType !== 3 && bitDepth !== 8)) {
        throw new DemuxError('APNG bit depth is invalid for its color type');
    }
    if (ihdr.data[10] !== 0 || ihdr.data[11] !== 0)
        throw new DemuxError('APNG compression or filter method is invalid');
    const actl = chunks.find(c => c.type === 'acTL');
    if (!actl)
        throw new DemuxError('PNG has no acTL; not an APNG');
    if (actl.data.length !== 8)
        throw new DemuxError('APNG has invalid acTL size');
    const declaredFrames = ((actl.data[0] << 24) | (actl.data[1] << 16) | (actl.data[2] << 8) | actl.data[3]) >>> 0;
    if (declaredFrames === 0)
        throw new DemuxError('APNG declares zero frames');
    assertPixelBudget(declaredFrames, width, height, maxTotalPixels, 'APNG');
    const loopCount = ((actl.data[4] << 24) | (actl.data[5] << 16) | (actl.data[6] << 8) | actl.data[7]) >>> 0;
    const palette = chunks.find(c => c.type === 'PLTE')?.data ?? null;
    const trns = chunks.find(c => c.type === 'tRNS')?.data ?? null;
    if ((colorType === 3 && !palette) ||
        (palette &&
            (palette.length === 0 ||
                palette.length % 3 !== 0 ||
                palette.length > 768 ||
                colorType === 0 ||
                colorType === 4 ||
                (colorType === 3 && palette.length / 3 > 2 ** bitDepth)))) {
        throw new DemuxError('APNG has an invalid palette');
    }
    if (trns &&
        ((colorType === 0 && trns.length !== 2) ||
            (colorType === 2 && trns.length !== 6) ||
            colorType === 4 ||
            colorType === 6 ||
            (colorType === 3 && trns.length > palette.length / 3))) {
        throw new DemuxError('invalid APNG transparent-color data');
    }
    const frames = [];
    let current = null;
    let sawIdat = false;
    let idatBytes = 0;
    let endedIdat = false;
    let sequence = 0;
    for (const c of chunks) {
        if (sawIdat && c.type !== 'IDAT')
            endedIdat = true;
        if (sawIdat && (c.type === 'acTL' || c.type === 'PLTE' || c.type === 'tRNS')) {
            throw new DemuxError(`APNG ${c.type} must precede IDAT`);
        }
        if (c.type === 'fcTL' || c.type === 'fdAT') {
            if (c.data.length < 4)
                throw new DemuxError(`${c.type} truncated`);
            const actual = ((c.data[0] << 24) | (c.data[1] << 16) | (c.data[2] << 8) | c.data[3]) >>> 0;
            if (actual !== sequence++)
                throw new DemuxError('APNG frame sequence is invalid');
        }
        if (c.type === 'fcTL') {
            if (c.data.length !== 26)
                throw new DemuxError('APNG has invalid fcTL size');
            if (current && !current.parts.some(part => part.length > 0))
                throw new DemuxError('APNG frame has no data');
            const num = (c.data[20] << 8) | c.data[21];
            const den = (c.data[22] << 8) | c.data[23] || 100;
            current = {
                w: ((c.data[4] << 24) | (c.data[5] << 16) | (c.data[6] << 8) | c.data[7]) >>> 0,
                h: ((c.data[8] << 24) | (c.data[9] << 16) | (c.data[10] << 8) | c.data[11]) >>> 0,
                x: ((c.data[12] << 24) | (c.data[13] << 16) | (c.data[14] << 8) | c.data[15]) >>> 0,
                y: ((c.data[16] << 24) | (c.data[17] << 16) | (c.data[18] << 8) | c.data[19]) >>> 0,
                delayMs: (num * 1000) / den,
                dispose: c.data[24],
                blend: c.data[25],
                usesIdat: !sawIdat,
                parts: [],
            };
            if (current.w === 0 || current.h === 0 || current.x + current.w > width || current.y + current.h > height) {
                throw new DemuxError('APNG frame rectangle outside the canvas');
            }
            if (current.usesIdat &&
                (current.x !== 0 || current.y !== 0 || current.w !== width || current.h !== height)) {
                throw new DemuxError('APNG IDAT frame must cover the canvas');
            }
            if (current.dispose > 2 || current.blend > 1)
                throw new DemuxError('APNG frame disposal or blend is invalid');
            frames.push(current);
            if (frames.length > declaredFrames)
                throw new DemuxError('APNG frame count does not match acTL');
        }
        else if (c.type === 'IDAT') {
            if (endedIdat)
                throw new DemuxError('PNG IDAT chunks must be consecutive');
            sawIdat = true;
            idatBytes += c.data.length;
            if (current?.usesIdat)
                current.parts.push(c.data);
        }
        else if (c.type === 'fdAT') {
            if (!sawIdat || !current || current.usesIdat)
                throw new DemuxError('APNG fdAT has no corresponding frame');
            current.parts.push(c.data.subarray(4));
        }
    }
    if (!sawIdat)
        throw new DemuxError('PNG has no IDAT');
    if (idatBytes === 0)
        throw new DemuxError('PNG IDAT contains no image data');
    if (frames.length !== declaredFrames)
        throw new DemuxError('APNG frame count does not match acTL');
    if (!current || !current.parts.some(part => part.length > 0))
        throw new DemuxError('APNG frame has no data');
    const canvas = new Uint8ClampedArray(width * height * 4);
    const out = [];
    let snapshot = null;
    for (const f of frames) {
        signal?.throwIfAborted();
        await yieldEventLoop();
        signal?.throwIfAborted();
        const rowBytes = Math.ceil((f.w * spp * bitDepth) / 8);
        const raw = await inflateBounded(f.parts, (rowBytes + 1) * f.h, 'APNG frame data', signal);
        const rows = unfilterScanlines(raw, f.h, Math.max(1, (spp * bitDepth) >> 3), rowBytes);
        const rgba = rowsToRgba(rows, f.w, f.h, { bitDepth, colorType }, palette, trns, rowBytes);
        if (f.dispose === 2)
            snapshot = canvas.slice();
        for (let y = 0; y < f.h; y++) {
            let src = y * f.w * 4;
            let dst = ((f.y + y) * width + f.x) * 4;
            for (let x = 0; x < f.w; x++, src += 4, dst += 4) {
                const sa = rgba[src + 3];
                if (f.blend === 0 || sa === 255) {
                    canvas[dst] = rgba[src];
                    canvas[dst + 1] = rgba[src + 1];
                    canvas[dst + 2] = rgba[src + 2];
                    canvas[dst + 3] = sa;
                }
                else if (sa > 0) {
                    const da = canvas[dst + 3];
                    const oa = sa + (da * (255 - sa)) / 255;
                    if (oa > 0) {
                        canvas[dst] = (rgba[src] * sa + (canvas[dst] * da * (255 - sa)) / 255) / oa;
                        canvas[dst + 1] = (rgba[src + 1] * sa + (canvas[dst + 1] * da * (255 - sa)) / 255) / oa;
                        canvas[dst + 2] = (rgba[src + 2] * sa + (canvas[dst + 2] * da * (255 - sa)) / 255) / oa;
                    }
                    canvas[dst + 3] = oa;
                }
            }
        }
        out.push({ rgba: canvas.slice(), delayMs: f.delayMs });
        if (f.dispose === 1) {
            for (let y = 0; y < f.h; y++) {
                const dst = ((f.y + y) * width + f.x) * 4;
                canvas.fill(0, dst, dst + f.w * 4);
            }
        }
        else if (f.dispose === 2 && snapshot) {
            canvas.set(snapshot);
        }
    }
    signal?.throwIfAborted();
    return { width, height, frames: out, loopCount };
}
export function scaleRgbaNearest(src, sw, sh, dw, dh) {
    return new RgbaResizer(sw, sh, dw, dh, 'nearest').resize(src);
}
