import {
    EncodeError,
    MediaForgeError,
    rethrowIfAbort,
    throwIfAborted,
} from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';
import { filterPngRgbaScanlines } from './png-filter';
import { crc32 } from '../../core/bytes/crc32';
import { HOST_TYPES } from './host-formats';
import { concatBytes } from '../../core/bytes/bytes';
import { RgbaResizer } from './rgba-resize';
import { assertPixels, type DecodedImage, type RgbaImage } from './rgba-image';

/** The formats a host canvas encodes: the keys of HOST_TYPES (./host-formats). */
export type HostImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'heif' | 'jxl';

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_APNG_DELAY_COMPONENT = 65535;

/** The options of the image encoders of mediaforgejs/codecs. */
export interface ImageEncodeOptions {
    /** JPEG and WebP: 0 to 1, 0.9 by default; a value outside takes the nearer end. */
    readonly quality?: number;
    /** Stops the encode, which then rejects with ABORT. */
    readonly signal?: AbortSignal;
}

function validateEncoderDimensions(
    name: string,
    width: number,
    height: number,
    maximum: number,
): void {
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > maximum ||
        height > maximum
    ) {
        throw new MediaForgeError(
            `${name}: width and height must be integers from 1 to ${maximum}`,
            'INPUT',
        );
    }
    assertPixels(name, width, height);
}

function validateLoopCount(name: string, loopCount: number, maximum: number): void {
    if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > maximum) {
        throw new MediaForgeError(
            `${name}: loopCount must be an integer from 0 to ${maximum}`,
            'INPUT',
        );
    }
}

function validateRgbaLength(
    name: string,
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
): void {
    if (rgba.length !== width * height * 4) {
        throw new MediaForgeError(`${name}: the pixels are not ${width}x${height} RGBA`, 'INPUT');
    }
}

/** `image` checked: RGBA pixels of its size, within the encoders' limits. */
function readImage(name: string, image: RgbaImage, maximum = 0xffffffff): RgbaImage {
    const data = (image as Partial<RgbaImage> | null)?.data;
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
        throw new MediaForgeError(`${name}: expected { data, width, height } of RGBA`, 'INPUT');
    validateEncoderDimensions(name, image.width, image.height, maximum);
    validateRgbaLength(name, data, image.width, image.height);
    return image;
}

function asEncodeError(context: string, error: unknown): MediaForgeError {
    if (error instanceof MediaForgeError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new EncodeError(`${context}: ${detail}`);
}

function validateFrameDelay(delayMs: number, maximum: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > maximum) {
        throw new MediaForgeError(
            `frame delay must be between 0 and ${maximum} milliseconds`,
            'INPUT',
        );
    }
}

function apngDelay(delayMs: number): { numerator: number; denominator: number } {
    if (delayMs <= 0) return { numerator: 0, denominator: 1000 };
    const maximum = MAX_APNG_DELAY_COMPONENT;
    const seconds = Math.max(1 / maximum, Math.min(maximum, delayMs / 1000));
    let previousNumerator = 0,
        previousDenominator = 1;
    let numerator = 1,
        denominator = 0;
    let remaining = seconds;
    for (;;) {
        const whole = Math.floor(remaining);
        const nextNumerator = whole * numerator + previousNumerator;
        const nextDenominator = whole * denominator + previousDenominator;
        if (nextNumerator > maximum || nextDenominator > maximum) break;
        previousNumerator = numerator;
        previousDenominator = denominator;
        numerator = nextNumerator;
        denominator = nextDenominator;
        const fraction = remaining - whole;
        if (fraction === 0) return { numerator, denominator };
        remaining = 1 / fraction;
    }

    const steps = Math.min(
        numerator === 0 ? Infinity : Math.floor((maximum - previousNumerator) / numerator),
        denominator === 0 ? Infinity : Math.floor((maximum - previousDenominator) / denominator),
    );
    const boundedNumerator = previousNumerator + steps * numerator;
    const boundedDenominator = previousDenominator + steps * denominator;
    if (
        Math.abs(seconds - numerator / denominator) <=
        Math.abs(seconds - boundedNumerator / boundedDenominator)
    )
        return { numerator, denominator };
    return { numerator: boundedNumerator, denominator: boundedDenominator };
}

/** Encodes what `canvas` shows through the host; ENCODE says which format the host lacks. */
export async function encodeCanvas(
    canvas: OffscreenCanvas,
    format: HostImageFormat,
    quality?: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const type = HOST_TYPES[format];
    const q = quality === undefined || Number.isNaN(quality) ? 0.9 : quality;
    const blob = await canvas.convertToBlob(
        format === 'png' ? { type } : { type, quality: Math.min(1, Math.max(0, q)) },
    );
    if (blob.type !== type) throw new EncodeError(`This host's canvas cannot encode ${format}`);
    return new Uint8Array(await blob.arrayBuffer());
}

/** The pixels `canvas` shows, read back. */
export function canvasImage(canvas: OffscreenCanvas): DecodedImage {
    const context = canvas.getContext('2d');
    if (!context) throw new EncodeError('No 2D context to read the picture from');
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data, width, height };
}

/** `image` drawn on a canvas of its size, for the host encoders. */
function drawImage(name: string, image: RgbaImage): OffscreenCanvas {
    if (typeof OffscreenCanvas !== 'function' || typeof ImageData !== 'function')
        throw new EncodeError(`${name} needs the host OffscreenCanvas`, {
            hint: 'Use encodePng, which needs no canvas.',
        });
    const { data, width, height } = image;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new EncodeError(`${name}: no 2D context`);
    const pixels =
        data.buffer instanceof ArrayBuffer
            ? new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
            : new Uint8ClampedArray(data);
    context.putImageData(
        new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height),
        0,
        0,
    );
    return canvas;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const buf = new Uint8Array(12 + data.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
    buf.set(data, 8);
    dv.setUint32(8 + data.length, crc32(buf.subarray(4, 8 + data.length)), false);
    return buf;
}

/**
 * zlib-wrapped deflate of `data`, read from the stream directly (a Response would load the host's
 * fetch code).
 */
async function deflateZlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const reader = new Blob([data])
        .stream()
        .pipeThrough(new CompressionStream('deflate'))
        .getReader();
    const chunks: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read())
        chunks.push(read.value);
    return chunks.length === 1 ? chunks[0]! : concatBytes(chunks);
}

/** The library's PNG of RGBA pixels, byte for byte the same on every host. */
async function libraryPng(
    rgba: Uint8Array | Uint8ClampedArray,
    w: number,
    h: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w, false);
    dv.setUint32(4, h, false);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = filterPngRgbaScanlines(rgba, w, h);
    let idat: Uint8Array;
    try {
        idat = await deflateZlib(raw);
    } catch (error) {
        throw asEncodeError('PNG compression failed', error);
    }

    return concatBytes([
        PNG_SIG,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', new Uint8Array(0)),
    ]);
}

function hasTransparency(rgba: Uint8Array | Uint8ClampedArray): boolean {
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255) return true;
    }
    return false;
}

/**
 * A PNG of the picture: the host canvas encodes it where there is one and every pixel is opaque, as
 * a canvas keeps premultiplied alpha, which would change translucent pixels while opaque ones
 * decode the same; the library's encoder encodes the others (Node, translucent pictures, a canvas
 * that fails), byte for byte the same on every host.
 */
export async function encodePng(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    const { data, width, height } = readImage('encodePng', image);
    const { signal } = options;
    throwIfAborted(signal);
    if (
        typeof OffscreenCanvas === 'function' &&
        typeof ImageData === 'function' &&
        !hasTransparency(data)
    ) {
        try {
            return await awaitWithAbort(encodeCanvas(drawImage('encodePng', image), 'png'), signal);
        } catch (error) {
            rethrowIfAbort(error, signal);
        }
    }
    return awaitWithAbort(libraryPng(data, width, height), signal);
}

/** A JPEG of an opaque picture through the host canvas; transparency fails with ENCODE. */
export async function encodeJpeg(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    readImage('encodeJpeg', image);
    throwIfAborted(options.signal);
    if (hasTransparency(image.data)) {
        throw new EncodeError('JPEG cannot keep transparency', {
            hint: 'Use PNG or WebP, or draw the picture on an opaque background.',
        });
    }
    const canvas = drawImage('encodeJpeg', image);
    return awaitWithAbort(encodeCanvas(canvas, 'jpeg', options.quality), options.signal);
}

/** A lossy WebP through the host canvas. */
export async function encodeWebP(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    readImage('encodeWebP', image);
    throwIfAborted(options.signal);
    const canvas = drawImage('encodeWebP', image);
    return awaitWithAbort(encodeCanvas(canvas, 'webp', options.quality), options.signal);
}

/** A top-down BMP: 24-bit when opaque, else 32-bit V5 with alpha; at most 8192x4320 pixels. */
export async function encodeBmp(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    const { data: px, width: w, height: h } = readImage('encodeBmp', image, 0x7fffffff);
    throwIfAborted(options.signal);
    const alpha = hasTransparency(px);
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
        // BI_BITFIELDS and explicit V5 masks distinguish BGRA from unused RGB padding.
        dv.setUint32(30, 3, true);
        dv.setUint32(54, 0x00ff0000, true);
        dv.setUint32(58, 0x0000ff00, true);
        dv.setUint32(62, 0x000000ff, true);
        dv.setUint32(66, 0xff000000, true);
        dv.setUint32(70, 0x73524742, true);
        dv.setUint32(122, 4, true);
    }

    let off = pixelOffset;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            u8[off++] = px[si + 2]!;
            u8[off++] = px[si + 1]!;
            u8[off++] = px[si + 0]!;
            if (alpha) u8[off++] = px[si + 3]!;
        }
        off += paddedRow - rowBytes;
    }

    return u8;
}

/** A single-strip RGB or RGBA TIFF with unassociated alpha; at most 8192x4320 pixels. */
export async function encodeTiff(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    const { data: px, width: w, height: h } = readImage('encodeTiff', image);
    throwIfAborted(options.signal);
    const alpha = hasTransparency(px);
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

    const writeIfdEntry = (tag: number, type: number, count: number, value: number) => {
        dv.setUint16(pos, tag, true);
        pos += 2;
        dv.setUint16(pos, type, true);
        pos += 2;
        dv.setUint32(pos, count, true);
        pos += 4;
        dv.setUint32(pos, value, true);
        pos += 4;
    };

    writeIfdEntry(0x0100, 4, 1, w);
    writeIfdEntry(0x0101, 4, 1, h);
    writeIfdEntry(0x0102, 3, samples, bitsOffset);
    writeIfdEntry(0x0103, 3, 1, 1);
    writeIfdEntry(0x0106, 3, 1, 2);
    writeIfdEntry(0x0111, 4, 1, stripOffset);
    writeIfdEntry(0x0115, 3, 1, samples);
    writeIfdEntry(0x0116, 4, 1, h);
    writeIfdEntry(0x0117, 4, 1, pixelBytes);
    writeIfdEntry(0x011c, 3, 1, 1);
    if (alpha) writeIfdEntry(0x0152, 3, 1, 2);

    dv.setUint32(pos, 0, true);
    for (let sample = 0; sample < samples; sample++) dv.setUint16(bitsOffset + sample * 2, 8, true);

    let si = 0;
    let di = stripOffset;
    for (let i = 0; i < w * h; i++) {
        u8[di++] = px[si]!;
        u8[di++] = px[si + 1]!;
        u8[di++] = px[si + 2]!;
        if (alpha) u8[di++] = px[si + 3]!;
        si += 4;
    }

    return u8;
}

/**
 * A PNG-in-ICO keeping the picture's shape, scaled down (Lanczos) so neither side exceeds the
 * format's 256; at most 8192x4320 source pixels.
 */
export async function encodeIco(
    image: RgbaImage,
    options: ImageEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    const { data, width, height } = readImage('encodeIco', image);
    const { signal } = options;
    const scale = Math.min(1, 256 / Math.max(width, height));
    const iconWidth = Math.max(1, Math.round(width * scale));
    const iconHeight = Math.max(1, Math.round(height * scale));
    const pixels =
        iconWidth === width && iconHeight === height
            ? data
            : await new RgbaResizer(width, height, iconWidth, iconHeight, 'lanczos3').resizeAsync(
                  data instanceof Uint8ClampedArray
                      ? data
                      : new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
                  signal,
              );
    const png = await encodePng({ data: pixels, width: iconWidth, height: iconHeight }, { signal });

    const headerSize = 6 + 16;
    const u8 = new Uint8Array(headerSize + png.length);
    const dv = new DataView(u8.buffer);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, 1, true);

    // A side of 256 is written as 0.
    dv.setUint8(6, iconWidth & 0xff);
    dv.setUint8(7, iconHeight & 0xff);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);
    dv.setUint16(10, 1, true);
    dv.setUint16(12, 32, true);
    dv.setUint32(14, png.length, true);
    dv.setUint32(18, headerSize, true);

    u8.set(png, headerSize);
    return u8;
}

/** The options of the animation encoders. */
export interface AnimationEncoderOptions {
    /** Total plays; 0, the default, loops forever. */
    readonly loopCount?: number;
}

/** The options of AnimatedGifEncoder. */
export interface GifEncoderOptions extends AnimationEncoderOptions {
    /** Defaults to Floyd-Steinberg; none maps each pixel independently. */
    readonly dither?: GifDitherMode;
}

function gifDitherMode(dither: unknown): GifDitherMode {
    if (dither === undefined || dither === 'floyd-steinberg' || dither === 'none')
        return dither ?? 'floyd-steinberg';
    throw new MediaForgeError('AnimatedGifEncoder: dither is floyd-steinberg or none', 'INPUT');
}

interface PaletteBox {
    lo: [number, number, number];
    hi: [number, number, number];
    pixels: Int32Array;
    count: number;
}

export class AnimatedGifEncoder {
    private readonly width: number;
    private readonly height: number;
    private repeatCount: number | null;
    private readonly dither: GifDitherMode;
    private parts: Uint8Array<ArrayBuffer>[] = [];
    private frameCount = 0;
    private previous: Uint8ClampedArray | null = null;
    private prevClearedCanvas = false;
    private pending: { rgba: Uint8ClampedArray; delayMs: number } | null = null;
    private idealMs = 0;
    private emittedCs = 0;

    /** `width`x`height` frames, at most 65535 a side; loopCount plays, 0 to 65536. */
    constructor(width: number, height: number, options: GifEncoderOptions = {}) {
        validateEncoderDimensions('AnimatedGifEncoder', width, height, 0xffff);
        const plays = options.loopCount ?? 0;
        validateLoopCount('AnimatedGifEncoder', plays, 0x10000);
        this.width = width;
        this.height = height;
        // The NETSCAPE block counts repetitions after the first play; one play writes none.
        this.repeatCount = plays === 1 ? null : plays === 0 ? 0 : plays - 1;
        this.dither = gifDitherMode(options.dither);
    }

    /**
     * Adds a picture of the encoder's size shown for `delayMs`. GIF keeps only alpha 0 or 255;
     * partial alpha fails with ENCODE before the encoder changes.
     */
    async addFrame(image: RgbaImage, delayMs: number): Promise<void> {
        readImage('AnimatedGifEncoder', image, 0xffff);
        validateFrameDelay(delayMs, 655350);
        if (image.width !== this.width || image.height !== this.height)
            throw new MediaForgeError('AnimatedGifEncoder: the frame is not the size', 'INPUT');
        const rgba = new Uint8ClampedArray(image.data);
        let nextHasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] === 0) nextHasAlpha = true;
            else if (rgba[i] !== 255) {
                throw new EncodeError('GIF cannot keep partial transparency', {
                    hint: 'Use PNG or WebP, or draw the picture on an opaque background.',
                });
            }
        }

        if (this.pending) {
            this.emitFrame(this.pending.rgba, this.pending.delayMs, nextHasAlpha);
        }

        this.pending = { rgba, delayMs };
    }

    private emitFrame(
        rgba: Uint8ClampedArray,
        delayMs: number,
        clearWholeCanvasAfter: boolean,
    ): void {
        if (this.frameCount === 0) this.writeHeader();
        this.frameCount++;

        let frameHasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i]! < 128) {
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
                    if (
                        rgba[i] !== prev[i] ||
                        rgba[i + 1] !== prev[i + 1] ||
                        rgba[i + 2] !== prev[i + 2] ||
                        rgba[i + 3] !== prev[i + 3]
                    ) {
                        if (x < x0) x0 = x;
                        if (x >= x1) x1 = x + 1;
                        if (y < y0) y0 = y;
                        if (y >= y1) y1 = y + 1;
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
        this.parts.push(
            Uint8Array.from([
                0x21,
                0xf9,
                0x04,
                (disposal << 2) | transparentFlag,
                delay & 0xff,
                (delay >> 8) & 0xff,
                transparentIndex,
                0,
            ]),
        );
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

    /** The GIF of the frames added; the encoder is then empty for another animation. */
    async encode(): Promise<Uint8Array<ArrayBuffer>> {
        if (!this.pending && this.frameCount === 0)
            throw new EncodeError('AnimatedGifEncoder: no frames');
        if (this.pending) {
            this.emitFrame(this.pending.rgba, this.pending.delayMs, false);
            this.pending = null;
        }
        this.parts.push(Uint8Array.from([0x3b]));
        const gif = concatBytes(this.parts);
        this.parts = [];
        this.previous = null;
        this.prevClearedCanvas = false;
        this.pending = null;
        this.idealMs = 0;
        this.emittedCs = 0;
        this.frameCount = 0;
        return gif;
    }

    private writeHeader(): void {
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
            this.parts.push(new TextEncoder().encode('NETSCAPE2.0') as Uint8Array<ArrayBuffer>);
            this.parts.push(
                Uint8Array.from([3, 1, this.repeatCount & 0xff, (this.repeatCount >> 8) & 0xff, 0]),
            );
        }
    }

    private buildPalette(
        rgba: Uint8ClampedArray,
        x0: number,
        y0: number,
        rw: number,
        rh: number,
    ): Uint8Array {
        const total = rw * rh;
        const exact = new Map<number, number>();
        for (let p = 0; p < total; p++) {
            const x = x0 + (p % rw);
            const y = y0 + Math.floor(p / rw);
            const i = (y * this.width + x) * 4;
            if (rgba[i + 3]! < 128) continue;
            const color = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
            if (!exact.has(color)) exact.set(color, exact.size);
            if (exact.size > 255) break;
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
            if (rgba[i + 3]! < 128) continue;
            samples[count++] = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        }
        if (count === 0) samples[count++] = 0;
        const boxes: PaletteBox[] = [makeBox(samples.subarray(0, count))];
        while (boxes.length < 255) {
            let pick = -1;
            let pickScore = 0;
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const spanR = box.hi[0] - box.lo[0];
                const spanG = box.hi[1] - box.lo[1];
                const spanB = box.hi[2] - box.lo[2];
                const span = Math.max(spanR, spanG, spanB);
                if (span === 0 || box.count < 2) continue;
                const score = box.count * (span + 1);
                if (score > pickScore) {
                    pickScore = score;
                    pick = i;
                }
            }
            if (pick < 0) break;
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

    private ditherRegion(
        rgba: Uint8ClampedArray,
        prev: Uint8ClampedArray | null,
        x0: number,
        y0: number,
        rw: number,
        rh: number,
        palette: Uint8Array,
        sourceAlpha = false,
    ): Uint8Array {
        const colorCount = palette.length / 3;
        const nearest = createGifPaletteLookup(palette);

        const out = new Uint8Array(rw * rh);
        if (this.dither === 'none') {
            for (let y = 0; y < rh; y++) {
                for (let x = 0; x < rw; x++) {
                    const src = ((y0 + y) * this.width + x0 + x) * 4;
                    const transparent = sourceAlpha && rgba[src + 3]! < 128;
                    const unchanged =
                        prev &&
                        rgba[src] === prev[src] &&
                        rgba[src + 1] === prev[src + 1] &&
                        rgba[src + 2] === prev[src + 2] &&
                        rgba[src + 3] === prev[src + 3];
                    out[y * rw + x] =
                        transparent || unchanged
                            ? colorCount
                            : nearest(rgba[src], rgba[src + 1], rgba[src + 2]);
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
                if (sourceAlpha && rgba[src + 3]! < 128) {
                    out[y * rw + x] = colorCount;
                    continue;
                }
                if (
                    prev &&
                    rgba[src] === prev[src] &&
                    rgba[src + 1] === prev[src + 1] &&
                    rgba[src + 2] === prev[src + 2] &&
                    rgba[src + 3] === prev[src + 3]
                ) {
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

function createGifPaletteLookup(palette: Uint8Array): (r: number, g: number, b: number) => number {
    const count = palette.length / 3;
    const order = Uint8Array.from({ length: count }, (_, index) => index);
    const axes = new Uint8Array(count);
    const weights = [2, 3, 1];
    const build = (lo: number, hi: number): void => {
        if (lo >= hi) return;
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
        order
            .subarray(lo, hi)
            .sort((a, b) => palette[a * 3 + axis] - palette[b * 3 + axis] || a - b);
        const mid = (lo + hi) >> 1;
        axes[mid] = axis;
        build(lo, mid);
        build(mid + 1, hi);
    };
    build(0, count);

    const cachedIndices = new Uint8Array(32768);
    const cachedColors = new Int32Array(32768).fill(-1);
    let red = 0,
        green = 0,
        blue = 0;
    let best = 0;
    let bestDistance = Infinity;
    const search = (lo: number, hi: number): void => {
        if (lo >= hi) return;
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
        if (delta < 0) search(lo, mid);
        else search(mid + 1, hi);
        if (delta * delta * weights[axis] <= bestDistance) {
            if (delta < 0) search(mid + 1, hi);
            else search(lo, mid);
        }
    };
    return (r, g, b) => {
        const slot = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const color = (r << 16) | (g << 8) | b;
        if (cachedColors[slot] === color) return cachedIndices[slot];
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

function refinePalette(palette: Uint8Array, samples: Int32Array): void {
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
            if (num[i] === 0) continue;
            palette[i * 3] = Math.round(sumR[i] / num[i]);
            palette[i * 3 + 1] = Math.round(sumG[i] / num[i]);
            palette[i * 3 + 2] = Math.round(sumB[i] / num[i]);
        }
    }
}

function clamp255(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function makeBox(pixels: Int32Array): PaletteBox {
    const box: PaletteBox = { lo: [255, 255, 255], hi: [0, 0, 0], pixels, count: pixels.length };
    for (let i = 0; i < pixels.length; i++) {
        const c = pixels[i];
        const r = (c >> 16) & 0xff;
        const g = (c >> 8) & 0xff;
        const b = c & 0xff;
        if (r < box.lo[0]) box.lo[0] = r;
        if (r > box.hi[0]) box.hi[0] = r;
        if (g < box.lo[1]) box.lo[1] = g;
        if (g > box.hi[1]) box.hi[1] = g;
        if (b < box.lo[2]) box.lo[2] = b;
        if (b > box.hi[2]) box.hi[2] = b;
    }
    return box;
}

function splitBox(box: PaletteBox): [PaletteBox, PaletteBox] {
    const spanR = box.hi[0] - box.lo[0];
    const spanG = box.hi[1] - box.lo[1];
    const spanB = box.hi[2] - box.lo[2];
    const shift = spanG >= spanR && spanG >= spanB ? 8 : spanR >= spanB ? 16 : 0;
    const sorted = Int32Array.from(box.pixels.subarray(0, box.count));
    sorted.sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
    const mid = box.count >> 1;
    return [makeBox(sorted.subarray(0, mid)), makeBox(sorted.subarray(mid))];
}

function lzwEncode(data: Uint8Array, minCodeSize: number): Uint8Array<ArrayBuffer> {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const maxCode = 4096;
    const hashSize = 8192;
    const hashCodes = new Int32Array(hashSize);
    const hashKeys = new Int32Array(hashSize);

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const output: number[] = [];
    let bitBuf = 0;
    let bitCount = 0;

    const emit = (code: number): void => {
        bitBuf |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            output.push(bitBuf & 0xff);
            bitBuf >>= 8;
            bitCount -= 8;
        }
    };
    const resetDict = (): void => {
        hashCodes.fill(-1);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
    };

    resetDict();
    emit(clearCode);
    if (data.length === 0) {
        emit(eoiCode);
        if (bitCount > 0) output.push(bitBuf & 0xff);
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
            if (code < 0) break;
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
            if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
            nextCode++;
        } else {
            emit(clearCode);
            resetDict();
        }
        prefix = k;
    }
    emit(prefix);
    if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    emit(eoiCode);
    if (bitCount > 0) output.push(bitBuf & 0xff);
    return Uint8Array.from(output);
}

interface PngChunk {
    type: string;
    data: Uint8Array<ArrayBuffer>;
    raw: Uint8Array<ArrayBuffer>;
}

function parsePng(data: Uint8Array<ArrayBuffer>): PngChunk[] {
    if (data.length < PNG_SIG.length || PNG_SIG.some((byte, index) => data[index] !== byte)) {
        throw new EncodeError('ApngEncoder: encoded frame is not a PNG');
    }

    const chunks: PngChunk[] = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let position = PNG_SIG.length;
    while (position + 12 <= data.length) {
        const length = view.getUint32(position, false);
        const end = position + 12 + length;
        if (end > data.length) throw new EncodeError('ApngEncoder: encoded PNG frame is truncated');
        const type = String.fromCharCode(
            data[position + 4]!,
            data[position + 5]!,
            data[position + 6]!,
            data[position + 7]!,
        );

        chunks.push({
            type,
            data: data.subarray(position + 8, position + 8 + length),
            raw: data.subarray(position, end),
        });
        position = end;
        if (type === 'IEND') return chunks;
    }

    throw new EncodeError('ApngEncoder: encoded PNG frame has no IEND chunk');
}

interface ApngFrame {
    png: Uint8Array<ArrayBuffer>;
    delay: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ApngFrameSlot {
    task: Promise<ApngFrame>;
}

/** The options of ApngEncoder. */
export interface ApngEncoderOptions extends AnimationEncoderOptions {
    /** Encode only the rectangle of each frame that changed; defaults to false. */
    readonly optimizeFrames?: boolean;
}

/**
 * Frame-by-frame APNG encoder. Add calls reserve their frame order immediately. `encode()` waits
 * for prior additions, rejects overlapping mutations, and clears frames after success for reuse.
 */
export class ApngEncoder {
    private readonly width: number;
    private readonly height: number;
    private readonly loopCount: number;
    private readonly optimizeFrames: boolean;
    private frames: ApngFrameSlot[] = [];
    private encoding = false;
    private previousRgba: Uint8Array | null = null;
    private optimizationTail: Promise<void> = Promise.resolve();

    /** `width`x`height` frames; loopCount plays, 0 to 2^32 - 1. */
    constructor(width: number, height: number, options: ApngEncoderOptions = {}) {
        validateEncoderDimensions('ApngEncoder', width, height, 0xffffffff);
        const plays = options.loopCount ?? 0;
        validateLoopCount('ApngEncoder', plays, 0xffffffff);
        this.width = width;
        this.height = height;
        this.loopCount = plays;
        this.optimizeFrames = options.optimizeFrames === true;
    }

    /**
     * Adds a picture of the encoder's size shown for `delayMs`; additions are rejected while
     * `encode()` runs.
     */
    addFrame(image: RgbaImage, delayMs: number): Promise<void> {
        let rgba: Uint8Array | Uint8ClampedArray;
        try {
            this.assertCanAdd();
            rgba = readImage('ApngEncoder', image).data;
            validateFrameDelay(delayMs, 65535000);
            if (image.width !== this.width || image.height !== this.height)
                throw new MediaForgeError('ApngEncoder: the frame is not the size', 'INPUT');
        } catch (error) {
            return this.handledRejection(error);
        }
        if (this.optimizeFrames) {
            return this.trackFrame(() =>
                this.queueOptimizedFrame(() => new Uint8Array(rgba), delayMs, 'RGBA'),
            );
        }
        return this.trackFrame(() =>
            libraryPng(rgba, this.width, this.height)
                .then((png): ApngFrame => ({
                    png,
                    delay: delayMs,
                    x: 0,
                    y: 0,
                    width: this.width,
                    height: this.height,
                }))
                .catch((error): never => {
                    throw asEncodeError('ApngEncoder: RGBA frame encoding failed', error);
                }),
        );
    }

    /**
     * Waits for prior additions, encodes their call order, and rejects concurrent additions or
     * encodes.
     */
    async encode(): Promise<Uint8Array<ArrayBuffer>> {
        if (this.encoding) throw new EncodeError('ApngEncoder: encode already in progress');
        const batch = this.frames.slice();
        if (batch.length === 0) throw new EncodeError('ApngEncoder: no frames');
        this.encoding = true;
        try {
            const settled = await Promise.allSettled(batch.map(slot => slot.task));
            const failed = new Set<ApngFrameSlot>();
            let firstError: unknown;
            for (let i = 0; i < settled.length; i++) {
                const result = settled[i]!;
                if (result.status === 'rejected') {
                    failed.add(batch[i]!);
                    if (firstError === undefined) firstError = result.reason;
                }
            }

            if (failed.size > 0) {
                this.frames = this.frames.filter(slot => !failed.has(slot));
                throw asEncodeError('ApngEncoder: frame addition failed', firstError);
            }

            const frames = settled.map(
                result => (result as PromiseFulfilledResult<ApngFrame>).value,
            );
            const apng = this.encodeFrames(frames);
            this.frames.length = 0;
            this.previousRgba = null;
            this.optimizationTail = Promise.resolve();
            return apng;
        } finally {
            this.encoding = false;
        }
    }

    private assertCanAdd(): void {
        if (this.encoding)
            throw new EncodeError('ApngEncoder: cannot add a frame while encode is in progress');
    }

    private handledRejection(error: unknown): Promise<void> {
        const rejected = Promise.reject(asEncodeError('ApngEncoder: frame addition failed', error));
        rejected.catch(() => undefined);
        return rejected;
    }

    private trackFrame(createTask: () => Promise<ApngFrame>): Promise<void> {
        let resolveTask!: (frame: ApngFrame) => void;
        let rejectTask!: (error: unknown) => void;
        const task = new Promise<ApngFrame>((resolve, reject) => {
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
        } catch (error) {
            rejectTask(asEncodeError('ApngEncoder: frame addition failed', error));
        }
        return completion;
    }

    private queueOptimizedFrame(
        capture: () => Uint8Array,
        delay: number,
        kind: string,
    ): Promise<ApngFrame> {
        let rgba: Uint8Array | undefined;
        let captureError: unknown;
        const task = this.optimizationTail
            .then(async (): Promise<ApngFrame> => {
                if (!rgba) throw captureError;
                const region = this.frameRegion(rgba);
                const png = await libraryPng(region.rgba, region.width, region.height);
                this.previousRgba = rgba;
                return {
                    png,
                    delay,
                    x: region.x,
                    y: region.y,
                    width: region.width,
                    height: region.height,
                };
            })
            .catch((error): never => {
                throw asEncodeError(`ApngEncoder: ${kind} frame encoding failed`, error);
            });

        this.optimizationTail = task.then(
            () => undefined,
            () => undefined,
        );
        try {
            rgba = capture();
        } catch (error) {
            captureError = error;
        }

        return task;
    }

    private frameRegion(rgba: Uint8Array): {
        rgba: Uint8Array;
        x: number;
        y: number;
        width: number;
        height: number;
    } {
        const previous = this.previousRgba;
        if (!previous) return { rgba, x: 0, y: 0, width: this.width, height: this.height };
        let left = this.width,
            top = this.height,
            right = -1,
            bottom = -1;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const offset = (y * this.width + x) * 4;
                if (
                    rgba[offset] === previous[offset] &&
                    rgba[offset + 1] === previous[offset + 1] &&
                    rgba[offset + 2] === previous[offset + 2] &&
                    rgba[offset + 3] === previous[offset + 3]
                )
                    continue;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                bottom = y;
            }
        }

        if (right < 0) return { rgba: rgba.subarray(0, 4), x: 0, y: 0, width: 1, height: 1 };
        const width = right - left + 1,
            height = bottom - top + 1;
        if (width === this.width && height === this.height)
            return { rgba, x: 0, y: 0, width, height };
        const cropped = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const offset = ((top + y) * this.width + left) * 4;
            cropped.set(rgba.subarray(offset, offset + width * 4), y * width * 4);
        }

        return { rgba: cropped, x: left, y: top, width, height };
    }

    private encodeFrames(frames: ApngFrame[]): Uint8Array<ArrayBuffer> {
        // One frame is a still: a plain PNG, as ffmpeg writes it (its reader replays a one-frame
        // acTL endlessly).
        if (frames.length === 1) return frames[0]!.png;
        const firstChunks = parsePng(frames[0]!.png);
        const ihdr = firstChunks.find(chunk => chunk.type === 'IHDR');
        if (!ihdr) throw new EncodeError('ApngEncoder: encoded PNG frame has no IHDR chunk');

        const result: Uint8Array<ArrayBuffer>[] = [PNG_SIG, ihdr.raw];
        const actlData = new Uint8Array(8);
        const actlView = new DataView(actlData.buffer);
        actlView.setUint32(0, frames.length, false);
        actlView.setUint32(4, this.loopCount, false);
        result.push(pngChunk('acTL', actlData));

        let sequence = 0;
        let idealMs = 0;
        let emittedMs = 0;
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const frame = frames[frameIndex]!;
            idealMs += frame.delay;
            const delay = apngDelay(
                frame.delay === 0
                    ? 0
                    : Math.max(1000 / MAX_APNG_DELAY_COMPONENT, idealMs - emittedMs),
            );
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
        return concatBytes(result);
    }
}

export type GifDitherMode = 'floyd-steinberg' | 'none';
