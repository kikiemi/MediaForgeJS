import { EncodeError } from '../core/errors.js';
import { filterPngRgbaScanlines } from './png-filter.js';
import { pngCrc32 } from './png-crc.js';
const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_PIXEL_BUDGET = 8192 * 4320;
const MAX_APNG_DELAY_COMPONENT = 65535;
function validateEncoderDimensions(name, width, height, maximum) {
    if (!Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > maximum ||
        height > maximum) {
        throw new EncodeError(`${name}: width and height must be positive integers no greater than ${maximum}`);
    }
    if (width * height > IMAGE_PIXEL_BUDGET) {
        throw new EncodeError(`${name}: ${width}x${height} exceeds the supported pixel budget (8192x4320)`);
    }
}
function validateLoopCount(name, loopCount, maximum) {
    if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > maximum) {
        throw new EncodeError(`${name}: loop count must be an integer between 0 and ${maximum}`);
    }
}
function validateRgbaLength(name, rgba, width, height) {
    const expected = width * height * 4;
    if (rgba.length !== expected) {
        throw new EncodeError(`${name}: expected ${expected} RGBA bytes for ${width}x${height}, received ${rgba.length}`);
    }
}
function asEncodeError(context, error) {
    if (error instanceof EncodeError)
        return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new EncodeError(`${context}: ${detail}`);
}
function validateFrameDelay(delayMs, maximum) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > maximum) {
        throw new EncodeError(`frame delay must be between 0 and ${maximum} milliseconds`);
    }
}
function apngDelay(delayMs) {
    if (delayMs <= 0)
        return { numerator: 0, denominator: 1000 };
    const maximum = MAX_APNG_DELAY_COMPONENT;
    const seconds = Math.max(1 / maximum, Math.min(maximum, delayMs / 1000));
    let previousNumerator = 0, previousDenominator = 1;
    let numerator = 1, denominator = 0;
    let remaining = seconds;
    for (;;) {
        const whole = Math.floor(remaining);
        const nextNumerator = whole * numerator + previousNumerator;
        const nextDenominator = whole * denominator + previousDenominator;
        if (nextNumerator > maximum || nextDenominator > maximum)
            break;
        previousNumerator = numerator;
        previousDenominator = denominator;
        numerator = nextNumerator;
        denominator = nextDenominator;
        const fraction = remaining - whole;
        if (fraction === 0)
            return { numerator, denominator };
        remaining = 1 / fraction;
    }
    const steps = Math.min(numerator === 0 ? Infinity : Math.floor((maximum - previousNumerator) / numerator), denominator === 0 ? Infinity : Math.floor((maximum - previousDenominator) / denominator));
    const boundedNumerator = previousNumerator + steps * numerator;
    const boundedDenominator = previousDenominator + steps * denominator;
    if (Math.abs(seconds - numerator / denominator) <= Math.abs(seconds - boundedNumerator / boundedDenominator))
        return { numerator, denominator };
    return { numerator: boundedNumerator, denominator: boundedDenominator };
}
async function encodeCanvasType(canvas, type, quality) {
    if (quality !== undefined && (!Number.isFinite(quality) || quality < 0 || quality > 1)) {
        throw new EncodeError('image quality must be between 0 and 1');
    }
    const blob = await canvas.convertToBlob({ type, quality });
    if (blob.type !== type)
        throw new EncodeError(`browser cannot encode ${type}; returned ${blob.type || 'an unknown format'}`);
    return blob;
}
function pngChunk(type, data) {
    const buf = new Uint8Array(12 + data.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++)
        buf[4 + i] = type.charCodeAt(i);
    buf.set(data, 8);
    dv.setUint32(8 + data.length, pngCrc32(buf.subarray(4, 8 + data.length)), false);
    return buf;
}
async function deflateZlib(data) {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function encodePngFromRgba(rgba, w, h) {
    validateEncoderDimensions('encodePngFromRgba', w, h, 0xffffffff);
    validateRgbaLength('encodePngFromRgba', rgba, w, h);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w, false);
    dv.setUint32(4, h, false);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = filterPngRgbaScanlines(rgba, w, h);
    let idat;
    try {
        idat = await deflateZlib(raw);
    }
    catch (error) {
        throw asEncodeError('encodePngFromRgba: compression failed', error);
    }
    const parts = [PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
    const total = parts.reduce((n, x) => n + x.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const x of parts) {
        out.set(x, off);
        off += x.length;
    }
    return out;
}
export async function encodePNG(canvas) {
    return encodeCanvasType(canvas, 'image/png');
}
export async function encodeJPEG(canvas, quality = 0.9) {
    const { data } = readStaticCanvasRgba('encodeJPEG', canvas, 0xffffffff);
    if (hasTransparency(data)) {
        throw new EncodeError('JPEG cannot preserve transparency; use PNG, WebP, TIFF, BMP or APNG, or composite onto an opaque background before encoding');
    }
    return encodeCanvasType(canvas, 'image/jpeg', quality);
}
export async function encodeWebP(canvas, quality = 0.9) {
    return encodeCanvasType(canvas, 'image/webp', quality);
}
function readStaticCanvasRgba(name, canvas, maximum) {
    const { width, height } = canvas;
    validateEncoderDimensions(name, width, height, maximum);
    try {
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new EncodeError(`${name}: no 2D context`);
        return { width, height, data: ctx.getImageData(0, 0, width, height).data };
    }
    catch (error) {
        throw asEncodeError(`${name}: canvas readback failed`, error);
    }
}
function hasTransparency(rgba) {
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255)
            return true;
    }
    return false;
}
export async function encodeBMP(canvas) {
    const imgData = readStaticCanvasRgba('encodeBMP', canvas, 0x7fffffff);
    const { width: w, height: h } = imgData;
    const alpha = hasTransparency(imgData.data);
    const headerSize = alpha ? 124 : 40;
    const pixelOffset = 14 + headerSize;
    const rowBytes = w * (alpha ? 4 : 3);
    const paddedRow = (rowBytes + 3) & ~3;
    const pixelDataSize = paddedRow * h;
    const fileSize = pixelOffset + pixelDataSize;
    const buf = new ArrayBuffer(fileSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint8(0, 0x42);
    dv.setUint8(1, 0x4d);
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, pixelOffset, true);
    dv.setUint32(14, headerSize, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, -h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, alpha ? 32 : 24, true);
    dv.setUint32(34, pixelDataSize, true);
    if (alpha) {
        dv.setUint32(30, 3, true);
        dv.setUint32(54, 0x00ff0000, true);
        dv.setUint32(58, 0x0000ff00, true);
        dv.setUint32(62, 0x000000ff, true);
        dv.setUint32(66, 0xff000000, true);
        dv.setUint32(70, 0x73524742, true);
        dv.setUint32(122, 4, true);
    }
    let off = pixelOffset;
    const px = imgData.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            u8[off++] = px[si + 2];
            u8[off++] = px[si + 1];
            u8[off++] = px[si + 0];
            if (alpha)
                u8[off++] = px[si + 3];
        }
        off += paddedRow - rowBytes;
    }
    return new Blob([buf], { type: 'image/bmp' });
}
export async function encodeTIFF(canvas) {
    const imgData = readStaticCanvasRgba('encodeTIFF', canvas, 0xffffffff);
    const { width: w, height: h } = imgData;
    const alpha = hasTransparency(imgData.data);
    const samples = alpha ? 4 : 3;
    const pixelBytes = w * h * samples;
    const ifdOffset = 8;
    const ifdEntries = alpha ? 11 : 10;
    const ifdSize = 2 + ifdEntries * 12 + 4;
    const bitsOffset = ifdOffset + ifdSize;
    const stripOffset = bitsOffset + samples * 2;
    const fileSize = stripOffset + pixelBytes;
    const buf = new ArrayBuffer(fileSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint8(0, 0x49);
    dv.setUint8(1, 0x49);
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffset, true);
    let pos = ifdOffset;
    dv.setUint16(pos, ifdEntries, true);
    pos += 2;
    const writeIFDEntry = (tag, type, count, value) => {
        dv.setUint16(pos, tag, true);
        pos += 2;
        dv.setUint16(pos, type, true);
        pos += 2;
        dv.setUint32(pos, count, true);
        pos += 4;
        dv.setUint32(pos, value, true);
        pos += 4;
    };
    writeIFDEntry(0x0100, 4, 1, w);
    writeIFDEntry(0x0101, 4, 1, h);
    writeIFDEntry(0x0102, 3, samples, bitsOffset);
    writeIFDEntry(0x0103, 3, 1, 1);
    writeIFDEntry(0x0106, 3, 1, 2);
    writeIFDEntry(0x0111, 4, 1, stripOffset);
    writeIFDEntry(0x0115, 3, 1, samples);
    writeIFDEntry(0x0116, 4, 1, h);
    writeIFDEntry(0x0117, 4, 1, pixelBytes);
    writeIFDEntry(0x011c, 3, 1, 1);
    if (alpha)
        writeIFDEntry(0x0152, 3, 1, 2);
    dv.setUint32(pos, 0, true);
    for (let sample = 0; sample < samples; sample++)
        dv.setUint16(bitsOffset + sample * 2, 8, true);
    let si = 0;
    let di = stripOffset;
    const px = imgData.data;
    for (let i = 0; i < w * h; i++) {
        u8[di++] = px[si];
        u8[di++] = px[si + 1];
        u8[di++] = px[si + 2];
        if (alpha)
            u8[di++] = px[si + 3];
        si += 4;
    }
    return new Blob([buf], { type: 'image/tiff' });
}
export async function encodeICO(canvas) {
    const { width, height } = canvas;
    validateEncoderDimensions('encodeICO', width, height, 0xffffffff);
    const size = Math.min(width, 256);
    let pngBuf;
    try {
        let src = canvas;
        if (width !== size || height !== size) {
            src = new OffscreenCanvas(size, size);
            const ctx = src.getContext('2d');
            if (!ctx)
                throw new EncodeError('encodeICO: no 2D context');
            ctx.drawImage(canvas, 0, 0, size, size);
        }
        const pngBlob = await encodeCanvasType(src, 'image/png');
        pngBuf = new Uint8Array(await pngBlob.arrayBuffer());
    }
    catch (error) {
        throw asEncodeError('encodeICO: PNG encoding failed', error);
    }
    const headerSize = 6 + 16;
    const buf = new ArrayBuffer(headerSize + pngBuf.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, 1, true);
    dv.setUint8(6, size >= 256 ? 0 : size);
    dv.setUint8(7, size >= 256 ? 0 : size);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);
    dv.setUint16(10, 1, true);
    dv.setUint16(12, 32, true);
    dv.setUint32(14, pngBuf.length, true);
    dv.setUint32(18, headerSize, true);
    u8.set(pngBuf, headerSize);
    return new Blob([buf], { type: 'image/x-icon' });
}
function gifDitherMode(options) {
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new EncodeError('AnimatedGifEncoder: options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'dither')
                throw new EncodeError(`AnimatedGifEncoder: unknown option ${key}`);
        }
        const dither = options.dither;
        if (dither !== undefined && dither !== 'floyd-steinberg' && dither !== 'none') {
            throw new EncodeError('AnimatedGifEncoder: dither must be floyd-steinberg or none');
        }
        return dither ?? 'floyd-steinberg';
    }
    catch (error) {
        throw asEncodeError('AnimatedGifEncoder: invalid options', error);
    }
}
export class AnimatedGifEncoder {
    width;
    height;
    repeatCount;
    dither;
    parts = [];
    frameCount = 0;
    previous = null;
    prevClearedCanvas = false;
    pending = null;
    idealMs = 0;
    emittedCs = 0;
    constructor(w, h, loopCount = 0, options = {}) {
        validateEncoderDimensions('AnimatedGifEncoder', w, h, 0xffff);
        validateLoopCount('AnimatedGifEncoder', loopCount, 0xffff);
        this.width = w;
        this.height = h;
        this.repeatCount = loopCount === 1 ? null : loopCount;
        this.dither = gifDitherMode(options);
    }
    static fromPlayCount(w, h, playCount, options = {}) {
        validateLoopCount('AnimatedGifEncoder.fromPlayCount', playCount, 0x10000);
        const encoder = new AnimatedGifEncoder(w, h, 0, options);
        encoder.repeatCount = playCount === 1 ? null : playCount === 0 ? 0 : playCount - 1;
        return encoder;
    }
    async addFrame(source, delayMs) {
        const canvas = new OffscreenCanvas(this.width, this.height);
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new EncodeError('AnimatedGifEncoder: 2d context unavailable');
        ctx.drawImage(source, 0, 0, this.width, this.height);
        const imgData = ctx.getImageData(0, 0, this.width, this.height);
        this.addFrameData(imgData, delayMs);
    }
    addFrameData(frame, delayMs) {
        validateFrameDelay(delayMs, 655350);
        if (frame.width !== this.width || frame.height !== this.height) {
            throw new EncodeError('AnimatedGifEncoder: frame size mismatch');
        }
        validateRgbaLength('AnimatedGifEncoder', frame.data, this.width, this.height);
        const rgba = new Uint8ClampedArray(frame.data);
        let nextHasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] === 0)
                nextHasAlpha = true;
            else if (rgba[i] !== 255) {
                throw new EncodeError('GIF cannot preserve partial alpha; use PNG, WebP, TIFF, BMP or APNG, or composite onto an opaque background before encoding');
            }
        }
        if (this.pending) {
            this.emitFrame(this.pending.rgba, this.pending.delayMs, nextHasAlpha);
        }
        this.pending = { rgba, delayMs };
    }
    emitFrame(rgba, delayMs, clearWholeCanvasAfter) {
        if (this.frameCount === 0)
            this.writeHeader();
        this.frameCount++;
        let frameHasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] < 128) {
                frameHasAlpha = true;
                break;
            }
        }
        const fullCanvas = frameHasAlpha || clearWholeCanvasAfter;
        let x0 = 0;
        let y0 = 0;
        let x1 = this.width;
        let y1 = this.height;
        const prev = fullCanvas || this.prevClearedCanvas ? null : this.previous;
        if (prev) {
            x0 = this.width;
            y0 = this.height;
            x1 = 0;
            y1 = 0;
            for (let y = 0; y < this.height; y++) {
                const row = y * this.width * 4;
                for (let x = 0; x < this.width; x++) {
                    const i = row + x * 4;
                    if (rgba[i] !== prev[i] ||
                        rgba[i + 1] !== prev[i + 1] ||
                        rgba[i + 2] !== prev[i + 2] ||
                        rgba[i + 3] !== prev[i + 3]) {
                        if (x < x0)
                            x0 = x;
                        if (x >= x1)
                            x1 = x + 1;
                        if (y < y0)
                            y0 = y;
                        if (y >= y1)
                            y1 = y + 1;
                    }
                }
            }
            if (x0 >= x1 || y0 >= y1) {
                x0 = 0;
                y0 = 0;
                x1 = 1;
                y1 = 1;
            }
        }
        const rw = x1 - x0;
        const rh = y1 - y0;
        const palette = this.buildPalette(rgba, x0, y0, rw, rh);
        const transparentIndex = palette.length / 3;
        const paletteBits = Math.max(1, Math.ceil(Math.log2(transparentIndex + 1)));
        const paletteSize = 1 << paletteBits;
        const indexed = this.ditherRegion(rgba, prev, x0, y0, rw, rh, palette, frameHasAlpha);
        const disposal = fullCanvas ? 2 : 1;
        const transparentFlag = fullCanvas || prev ? 1 : 0;
        this.idealMs += delayMs;
        const targetCs = Math.round(this.idealMs / 10);
        const delay = Math.max(1, targetCs - this.emittedCs);
        this.emittedCs += delay;
        this.parts.push(Uint8Array.from([
            0x21,
            0xf9,
            0x04,
            (disposal << 2) | transparentFlag,
            delay & 0xff,
            (delay >> 8) & 0xff,
            transparentIndex,
            0,
        ]));
        this.prevClearedCanvas = disposal === 2;
        const desc = new Uint8Array(10);
        desc[0] = 0x2c;
        desc[1] = x0 & 0xff;
        desc[2] = (x0 >> 8) & 0xff;
        desc[3] = y0 & 0xff;
        desc[4] = (y0 >> 8) & 0xff;
        desc[5] = rw & 0xff;
        desc[6] = (rw >> 8) & 0xff;
        desc[7] = rh & 0xff;
        desc[8] = (rh >> 8) & 0xff;
        desc[9] = 0x80 | (paletteBits - 1);
        this.parts.push(desc);
        const lct = new Uint8Array(paletteSize * 3);
        for (let i = 0; i < transparentIndex; i++) {
            lct[i * 3] = palette[i * 3];
            lct[i * 3 + 1] = palette[i * 3 + 1];
            lct[i * 3 + 2] = palette[i * 3 + 2];
        }
        this.parts.push(lct);
        const minimumCodeSize = Math.max(2, paletteBits);
        this.parts.push(Uint8Array.from([minimumCodeSize]));
        const compressed = lzwEncode(indexed, minimumCodeSize);
        for (let i = 0; i < compressed.length; i += 255) {
            const blockLen = Math.min(255, compressed.length - i);
            this.parts.push(Uint8Array.from([blockLen]));
            this.parts.push(compressed.slice(i, i + blockLen));
        }
        this.parts.push(Uint8Array.from([0]));
        this.previous = rgba;
    }
    async encode() {
        if (!this.pending && this.frameCount === 0)
            throw new EncodeError('AnimatedGifEncoder: no frames');
        if (this.pending) {
            this.emitFrame(this.pending.rgba, this.pending.delayMs, false);
            this.pending = null;
        }
        this.parts.push(Uint8Array.from([0x3b]));
        const blob = new Blob(this.parts, { type: 'image/gif' });
        this.parts = [];
        this.previous = null;
        this.prevClearedCanvas = false;
        this.pending = null;
        this.idealMs = 0;
        this.emittedCs = 0;
        this.frameCount = 0;
        return blob;
    }
    writeHeader() {
        this.parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
        const lsd = new Uint8Array(7);
        lsd[0] = this.width & 0xff;
        lsd[1] = (this.width >> 8) & 0xff;
        lsd[2] = this.height & 0xff;
        lsd[3] = (this.height >> 8) & 0xff;
        lsd[4] = 0xf0;
        lsd[5] = 0;
        this.parts.push(lsd);
        this.parts.push(new Uint8Array(2 * 3));
        if (this.repeatCount !== null) {
            this.parts.push(Uint8Array.from([0x21, 0xff, 0x0b]));
            this.parts.push(new TextEncoder().encode('NETSCAPE2.0'));
            this.parts.push(Uint8Array.from([3, 1, this.repeatCount & 0xff, (this.repeatCount >> 8) & 0xff, 0]));
        }
    }
    buildPalette(rgba, x0, y0, rw, rh) {
        const total = rw * rh;
        const exact = new Map();
        for (let p = 0; p < total; p++) {
            const x = x0 + (p % rw);
            const y = y0 + Math.floor(p / rw);
            const i = (y * this.width + x) * 4;
            if (rgba[i + 3] < 128)
                continue;
            const color = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
            if (!exact.has(color))
                exact.set(color, exact.size);
            if (exact.size > 255)
                break;
        }
        if (exact.size <= 255) {
            const palette = new Uint8Array(Math.max(1, exact.size) * 3);
            for (const [color, index] of exact) {
                palette[index * 3] = color >> 16;
                palette[index * 3 + 1] = color >> 8;
                palette[index * 3 + 2] = color;
            }
            return palette;
        }
        const step = Math.max(1, Math.floor(total / 65536));
        const samples = new Int32Array(Math.ceil(total / step));
        let count = 0;
        for (let p = 0; p < total; p += step) {
            const x = x0 + (p % rw);
            const y = y0 + Math.floor(p / rw);
            const i = (y * this.width + x) * 4;
            if (rgba[i + 3] < 128)
                continue;
            samples[count++] = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        }
        if (count === 0)
            samples[count++] = 0;
        const boxes = [makeBox(samples.subarray(0, count))];
        while (boxes.length < 255) {
            let pick = -1;
            let pickScore = 0;
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const spanR = box.hi[0] - box.lo[0];
                const spanG = box.hi[1] - box.lo[1];
                const spanB = box.hi[2] - box.lo[2];
                const span = Math.max(spanR, spanG, spanB);
                if (span === 0 || box.count < 2)
                    continue;
                const score = box.count * (span + 1);
                if (score > pickScore) {
                    pickScore = score;
                    pick = i;
                }
            }
            if (pick < 0)
                break;
            const [a, b] = splitBox(boxes[pick]);
            boxes.splice(pick, 1, a, b);
        }
        const palette = new Uint8Array(boxes.length * 3);
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            let r = 0;
            let g = 0;
            let b = 0;
            for (let j = 0; j < box.count; j++) {
                const c = box.pixels[j];
                r += (c >> 16) & 0xff;
                g += (c >> 8) & 0xff;
                b += c & 0xff;
            }
            palette[i * 3] = Math.round(r / box.count);
            palette[i * 3 + 1] = Math.round(g / box.count);
            palette[i * 3 + 2] = Math.round(b / box.count);
        }
        refinePalette(palette, samples.subarray(0, count));
        return palette;
    }
    ditherRegion(rgba, prev, x0, y0, rw, rh, palette, sourceAlpha = false) {
        const colorCount = palette.length / 3;
        const nearest = createGifPaletteLookup(palette);
        const out = new Uint8Array(rw * rh);
        if (this.dither === 'none') {
            for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) {
                    const src = ((y0 + y) * this.width + x0 + x) * 4;
                    const transparent = sourceAlpha && rgba[src + 3] < 128;
                    const unchanged = prev &&
                        rgba[src] === prev[src] &&
                        rgba[src + 1] === prev[src + 1] &&
                        rgba[src + 2] === prev[src + 2] &&
                        rgba[src + 3] === prev[src + 3];
                    out[y * rw + x] =
                        transparent || unchanged ? colorCount : nearest(rgba[src], rgba[src + 1], rgba[src + 2]);
                }
            }
            return out;
        }
        const errR = new Float32Array(rw + 2);
        const errG = new Float32Array(rw + 2);
        const errB = new Float32Array(rw + 2);
        const nextR = new Float32Array(rw + 2);
        const nextG = new Float32Array(rw + 2);
        const nextB = new Float32Array(rw + 2);
        for (let y = 0; y < rh; y++) {
            nextR.fill(0);
            nextG.fill(0);
            nextB.fill(0);
            for (let x = 0; x < rw; x++) {
                const src = ((y0 + y) * this.width + (x0 + x)) * 4;
                if (sourceAlpha && rgba[src + 3] < 128) {
                    out[y * rw + x] = colorCount;
                    continue;
                }
                if (prev &&
                    rgba[src] === prev[src] &&
                    rgba[src + 1] === prev[src + 1] &&
                    rgba[src + 2] === prev[src + 2] &&
                    rgba[src + 3] === prev[src + 3]) {
                    out[y * rw + x] = colorCount;
                    continue;
                }
                const r = clamp255(rgba[src] + errR[x + 1]);
                const g = clamp255(rgba[src + 1] + errG[x + 1]);
                const b = clamp255(rgba[src + 2] + errB[x + 1]);
                const idx = nearest(r | 0, g | 0, b | 0);
                out[y * rw + x] = idx;
                const er = r - palette[idx * 3];
                const eg = g - palette[idx * 3 + 1];
                const eb = b - palette[idx * 3 + 2];
                errR[x + 2] += er * (7 / 16);
                errG[x + 2] += eg * (7 / 16);
                errB[x + 2] += eb * (7 / 16);
                nextR[x] += er * (3 / 16);
                nextG[x] += eg * (3 / 16);
                nextB[x] += eb * (3 / 16);
                nextR[x + 1] += er * (5 / 16);
                nextG[x + 1] += eg * (5 / 16);
                nextB[x + 1] += eb * (5 / 16);
                nextR[x + 2] += er * (1 / 16);
                nextG[x + 2] += eg * (1 / 16);
                nextB[x + 2] += eb * (1 / 16);
            }
            errR.set(nextR);
            errG.set(nextG);
            errB.set(nextB);
        }
        return out;
    }
}
function createGifPaletteLookup(palette) {
    const count = palette.length / 3;
    const order = Uint8Array.from({ length: count }, (_, index) => index);
    const axes = new Uint8Array(count);
    const weights = [2, 3, 1];
    const build = (lo, hi) => {
        if (lo >= hi)
            return;
        let axis = 0;
        let widest = -1;
        for (let channel = 0; channel < 3; channel++) {
            let minimum = 255;
            let maximum = 0;
            for (let i = lo; i < hi; i++) {
                const value = palette[order[i] * 3 + channel];
                minimum = Math.min(minimum, value);
                maximum = Math.max(maximum, value);
            }
            const span = maximum - minimum;
            const score = span * span * weights[channel];
            if (score > widest) {
                widest = score;
                axis = channel;
            }
        }
        order.subarray(lo, hi).sort((a, b) => palette[a * 3 + axis] - palette[b * 3 + axis] || a - b);
        const mid = (lo + hi) >> 1;
        axes[mid] = axis;
        build(lo, mid);
        build(mid + 1, hi);
    };
    build(0, count);
    const cachedIndices = new Uint8Array(32768);
    const cachedColors = new Int32Array(32768).fill(-1);
    let red = 0, green = 0, blue = 0;
    let best = 0;
    let bestDistance = Infinity;
    const search = (lo, hi) => {
        if (lo >= hi)
            return;
        const mid = (lo + hi) >> 1;
        const index = order[mid];
        const dr = red - palette[index * 3];
        const dg = green - palette[index * 3 + 1];
        const db = blue - palette[index * 3 + 2];
        const distance = dr * dr * 2 + dg * dg * 3 + db * db;
        if (distance < bestDistance || (distance === bestDistance && index < best)) {
            bestDistance = distance;
            best = index;
        }
        const axis = axes[mid];
        const delta = axis === 0 ? dr : axis === 1 ? dg : db;
        if (delta < 0)
            search(lo, mid);
        else
            search(mid + 1, hi);
        if (delta * delta * weights[axis] <= bestDistance) {
            if (delta < 0)
                search(mid + 1, hi);
            else
                search(lo, mid);
        }
    };
    return (r, g, b) => {
        const slot = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const color = (r << 16) | (g << 8) | b;
        if (cachedColors[slot] === color)
            return cachedIndices[slot];
        red = r;
        green = g;
        blue = b;
        best = 0;
        bestDistance = Infinity;
        search(0, count);
        cachedColors[slot] = color;
        cachedIndices[slot] = best;
        return best;
    };
}
function refinePalette(palette, samples) {
    const colorCount = palette.length / 3;
    const sumR = new Float64Array(colorCount);
    const sumG = new Float64Array(colorCount);
    const sumB = new Float64Array(colorCount);
    const num = new Int32Array(colorCount);
    for (let iter = 0; iter < 2; iter++) {
        sumR.fill(0);
        sumG.fill(0);
        sumB.fill(0);
        num.fill(0);
        const nearest = createGifPaletteLookup(palette);
        for (let s = 0; s < samples.length; s++) {
            const c = samples[s];
            const r = (c >> 16) & 0xff;
            const g = (c >> 8) & 0xff;
            const b = c & 0xff;
            const best = nearest(r, g, b);
            sumR[best] += r;
            sumG[best] += g;
            sumB[best] += b;
            num[best]++;
        }
        for (let i = 0; i < colorCount; i++) {
            if (num[i] === 0)
                continue;
            palette[i * 3] = Math.round(sumR[i] / num[i]);
            palette[i * 3 + 1] = Math.round(sumG[i] / num[i]);
            palette[i * 3 + 2] = Math.round(sumB[i] / num[i]);
        }
    }
}
function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}
function makeBox(pixels) {
    const box = { lo: [255, 255, 255], hi: [0, 0, 0], pixels, count: pixels.length };
    for (let i = 0; i < pixels.length; i++) {
        const c = pixels[i];
        const r = (c >> 16) & 0xff;
        const g = (c >> 8) & 0xff;
        const b = c & 0xff;
        if (r < box.lo[0])
            box.lo[0] = r;
        if (r > box.hi[0])
            box.hi[0] = r;
        if (g < box.lo[1])
            box.lo[1] = g;
        if (g > box.hi[1])
            box.hi[1] = g;
        if (b < box.lo[2])
            box.lo[2] = b;
        if (b > box.hi[2])
            box.hi[2] = b;
    }
    return box;
}
function splitBox(box) {
    const spanR = box.hi[0] - box.lo[0];
    const spanG = box.hi[1] - box.lo[1];
    const spanB = box.hi[2] - box.lo[2];
    const shift = spanG >= spanR && spanG >= spanB ? 8 : spanR >= spanB ? 16 : 0;
    const sorted = Int32Array.from(box.pixels.subarray(0, box.count));
    sorted.sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
    const mid = box.count >> 1;
    return [makeBox(sorted.subarray(0, mid)), makeBox(sorted.subarray(mid))];
}
function lzwEncode(data, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const maxCode = 4096;
    const hashSize = 8192;
    const hashCodes = new Int32Array(hashSize);
    const hashKeys = new Int32Array(hashSize);
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const output = [];
    let bitBuf = 0;
    let bitCount = 0;
    const emit = (code) => {
        bitBuf |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            output.push(bitBuf & 0xff);
            bitBuf >>= 8;
            bitCount -= 8;
        }
    };
    const resetDict = () => {
        hashCodes.fill(-1);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
    };
    resetDict();
    emit(clearCode);
    if (data.length === 0) {
        emit(eoiCode);
        if (bitCount > 0)
            output.push(bitBuf & 0xff);
        return Uint8Array.from(output);
    }
    let prefix = data[0];
    for (let i = 1; i < data.length; i++) {
        const k = data[i];
        const key = (prefix << 8) | k;
        let h = ((key * 2654435761) >>> 19) & (hashSize - 1);
        let found = -1;
        for (;;) {
            const code = hashCodes[h];
            if (code < 0)
                break;
            if (hashKeys[h] === key) {
                found = code;
                break;
            }
            h = (h + 1) & (hashSize - 1);
        }
        if (found >= 0) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (nextCode < maxCode) {
            hashCodes[h] = nextCode;
            hashKeys[h] = key;
            if (nextCode === 1 << codeSize && codeSize < 12)
                codeSize++;
            nextCode++;
        }
        else {
            emit(clearCode);
            resetDict();
        }
        prefix = k;
    }
    emit(prefix);
    if (nextCode === 1 << codeSize && codeSize < 12)
        codeSize++;
    emit(eoiCode);
    if (bitCount > 0)
        output.push(bitBuf & 0xff);
    return Uint8Array.from(output);
}
function parsePng(data) {
    if (data.length < PNG_SIG.length || PNG_SIG.some((byte, index) => data[index] !== byte)) {
        throw new EncodeError('APNGEncoder: encoded frame is not a PNG');
    }
    const chunks = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let position = PNG_SIG.length;
    while (position + 12 <= data.length) {
        const length = view.getUint32(position, false);
        const end = position + 12 + length;
        if (end > data.length)
            throw new EncodeError('APNGEncoder: encoded PNG frame is truncated');
        const type = String.fromCharCode(data[position + 4], data[position + 5], data[position + 6], data[position + 7]);
        chunks.push({
            type,
            data: data.subarray(position + 8, position + 8 + length),
            raw: data.subarray(position, end),
        });
        position = end;
        if (type === 'IEND')
            return chunks;
    }
    throw new EncodeError('APNGEncoder: encoded PNG frame has no IEND chunk');
}
function apngOptimizeFrames(options) {
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new EncodeError('APNGEncoder: options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'optimizeFrames')
                throw new EncodeError(`APNGEncoder: unknown option ${key}`);
        }
        const optimizeFrames = options.optimizeFrames;
        if (optimizeFrames !== undefined && typeof optimizeFrames !== 'boolean') {
            throw new EncodeError('APNGEncoder: optimizeFrames must be a boolean');
        }
        return optimizeFrames === true;
    }
    catch (error) {
        throw asEncodeError('APNGEncoder: invalid options', error);
    }
}
export class APNGEncoder {
    width;
    height;
    loopCount;
    optimizeFrames;
    frames = [];
    encoding = false;
    previousRgba = null;
    optimizationTail = Promise.resolve();
    constructor(w, h, loopCount = 0, options = {}) {
        validateEncoderDimensions('APNGEncoder', w, h, 0xffffffff);
        validateLoopCount('APNGEncoder', loopCount, 0xffffffff);
        this.width = w;
        this.height = h;
        this.loopCount = loopCount;
        this.optimizeFrames = apngOptimizeFrames(options);
    }
    addFrame(source, delayMs) {
        try {
            this.assertCanAdd();
            validateFrameDelay(delayMs, 65535000);
        }
        catch (error) {
            return this.handledRejection(error);
        }
        const capture = () => {
            const canvas = new OffscreenCanvas(this.width, this.height);
            const context = canvas.getContext('2d');
            if (!context)
                throw new EncodeError('APNGEncoder: 2d context unavailable');
            context.drawImage(source, 0, 0, this.width, this.height);
            const image = context.getImageData(0, 0, this.width, this.height);
            return image.data;
        };
        if (this.optimizeFrames) {
            return this.trackFrame(() => this.queueOptimizedFrame(() => new Uint8Array(capture()), delayMs, 'bitmap'));
        }
        return this.trackFrame(async () => {
            try {
                const png = await encodePngFromRgba(capture(), this.width, this.height);
                return { png, delay: delayMs, x: 0, y: 0, width: this.width, height: this.height };
            }
            catch (error) {
                throw asEncodeError('APNGEncoder: bitmap frame encoding failed', error);
            }
        });
    }
    addFrameRgba(rgba, delayMs) {
        try {
            this.assertCanAdd();
            validateFrameDelay(delayMs, 65535000);
            validateRgbaLength('APNGEncoder', rgba, this.width, this.height);
        }
        catch (error) {
            return this.handledRejection(error);
        }
        if (this.optimizeFrames) {
            return this.trackFrame(() => this.queueOptimizedFrame(() => new Uint8Array(rgba), delayMs, 'RGBA'));
        }
        return this.trackFrame(() => encodePngFromRgba(rgba, this.width, this.height)
            .then((png) => ({ png, delay: delayMs, x: 0, y: 0, width: this.width, height: this.height }))
            .catch((error) => {
            throw asEncodeError('APNGEncoder: RGBA frame encoding failed', error);
        }));
    }
    async encode() {
        if (this.encoding)
            throw new EncodeError('APNGEncoder: encode already in progress');
        const batch = this.frames.slice();
        if (batch.length === 0)
            throw new EncodeError('APNGEncoder: no frames');
        this.encoding = true;
        try {
            const settled = await Promise.allSettled(batch.map(slot => slot.task));
            const failed = new Set();
            let firstError;
            for (let i = 0; i < settled.length; i++) {
                const result = settled[i];
                if (result.status === 'rejected') {
                    failed.add(batch[i]);
                    if (firstError === undefined)
                        firstError = result.reason;
                }
            }
            if (failed.size > 0) {
                this.frames = this.frames.filter(slot => !failed.has(slot));
                throw asEncodeError('APNGEncoder: frame addition failed', firstError);
            }
            const frames = settled.map(result => result.value);
            const blob = this.encodeFrames(frames);
            this.frames.length = 0;
            this.previousRgba = null;
            this.optimizationTail = Promise.resolve();
            return blob;
        }
        finally {
            this.encoding = false;
        }
    }
    assertCanAdd() {
        if (this.encoding)
            throw new EncodeError('APNGEncoder: cannot add a frame while encode is in progress');
    }
    handledRejection(error) {
        const rejected = Promise.reject(asEncodeError('APNGEncoder: frame addition failed', error));
        rejected.catch(() => undefined);
        return rejected;
    }
    trackFrame(createTask) {
        let resolveTask;
        let rejectTask;
        const task = new Promise((resolve, reject) => {
            resolveTask = resolve;
            rejectTask = reject;
        });
        const slot = { task };
        this.frames.push(slot);
        task.catch(() => undefined);
        const completion = task.then(() => undefined);
        completion.catch(() => undefined);
        try {
            createTask().then(resolveTask, rejectTask);
        }
        catch (error) {
            rejectTask(asEncodeError('APNGEncoder: frame addition failed', error));
        }
        return completion;
    }
    queueOptimizedFrame(capture, delay, kind) {
        let rgba;
        let captureError;
        const task = this.optimizationTail
            .then(async () => {
            if (!rgba)
                throw captureError;
            const region = this.frameRegion(rgba);
            const png = await encodePngFromRgba(region.rgba, region.width, region.height);
            this.previousRgba = rgba;
            return { png, delay, x: region.x, y: region.y, width: region.width, height: region.height };
        })
            .catch((error) => {
            throw asEncodeError(`APNGEncoder: ${kind} frame encoding failed`, error);
        });
        this.optimizationTail = task.then(() => undefined, () => undefined);
        try {
            rgba = capture();
        }
        catch (error) {
            captureError = error;
        }
        return task;
    }
    frameRegion(rgba) {
        const previous = this.previousRgba;
        if (!previous)
            return { rgba, x: 0, y: 0, width: this.width, height: this.height };
        let left = this.width, top = this.height, right = -1, bottom = -1;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const offset = (y * this.width + x) * 4;
                if (rgba[offset] === previous[offset] &&
                    rgba[offset + 1] === previous[offset + 1] &&
                    rgba[offset + 2] === previous[offset + 2] &&
                    rgba[offset + 3] === previous[offset + 3])
                    continue;
                if (x < left)
                    left = x;
                if (x > right)
                    right = x;
                if (y < top)
                    top = y;
                bottom = y;
            }
        }
        if (right < 0)
            return { rgba: rgba.subarray(0, 4), x: 0, y: 0, width: 1, height: 1 };
        const width = right - left + 1, height = bottom - top + 1;
        if (width === this.width && height === this.height)
            return { rgba, x: 0, y: 0, width, height };
        const cropped = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const offset = ((top + y) * this.width + left) * 4;
            cropped.set(rgba.subarray(offset, offset + width * 4), y * width * 4);
        }
        return { rgba: cropped, x: left, y: top, width, height };
    }
    encodeFrames(frames) {
        const firstChunks = parsePng(frames[0].png);
        const ihdr = firstChunks.find(chunk => chunk.type === 'IHDR');
        if (!ihdr)
            throw new EncodeError('APNGEncoder: encoded PNG frame has no IHDR chunk');
        const result = [PNG_SIG, ihdr.raw];
        const actlData = new Uint8Array(8);
        const actlView = new DataView(actlData.buffer);
        actlView.setUint32(0, frames.length, false);
        actlView.setUint32(4, this.loopCount, false);
        result.push(pngChunk('acTL', actlData));
        let sequence = 0;
        let idealMs = 0;
        let emittedMs = 0;
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const frame = frames[frameIndex];
            idealMs += frame.delay;
            const delay = apngDelay(frame.delay === 0 ? 0 : Math.max(1000 / MAX_APNG_DELAY_COMPONENT, idealMs - emittedMs));
            emittedMs += (delay.numerator * 1000) / delay.denominator;
            const fctlData = new Uint8Array(26);
            const fctlView = new DataView(fctlData.buffer);
            fctlView.setUint32(0, sequence++, false);
            fctlView.setUint32(4, frame.width, false);
            fctlView.setUint32(8, frame.height, false);
            fctlView.setUint32(12, frame.x, false);
            fctlView.setUint32(16, frame.y, false);
            fctlView.setUint16(20, delay.numerator, false);
            fctlView.setUint16(22, delay.denominator, false);
            result.push(pngChunk('fcTL', fctlData));
            const frameChunks = frameIndex === 0 ? firstChunks : parsePng(frame.png);
            for (const idat of frameChunks.filter(chunk => chunk.type === 'IDAT')) {
                if (frameIndex === 0) {
                    result.push(idat.raw);
                    continue;
                }
                const payload = new Uint8Array(4 + idat.data.length);
                new DataView(payload.buffer).setUint32(0, sequence++, false);
                payload.set(idat.data, 4);
                result.push(pngChunk('fdAT', payload));
            }
        }
        result.push(pngChunk('IEND', new Uint8Array(0)));
        return new Blob(result, { type: 'image/apng' });
    }
}
