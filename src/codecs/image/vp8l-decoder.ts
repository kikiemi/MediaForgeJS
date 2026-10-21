import { DemuxError } from '../../core/errors/errors';
import type { DecodedImage } from './rgba-image';

/** LSB-first bit reader over a VP8L bitstream; reading past the end throws. */
class BitReader {
    private position = 0;

    constructor(private readonly data: Uint8Array) {}

    read(count: number): number {
        let value = 0;
        for (let index = 0; index < count; index++) {
            const byte = this.position >> 3;
            if (byte >= this.data.length)
                throw new DemuxError('WebP lossless bitstream is truncated');
            value |= ((this.data[byte]! >> (this.position & 7)) & 1) << index;
            this.position++;
        }
        return value >>> 0;
    }

    /** One bit at a time; canonical VP8L codes are read most significant code bit first. */
    bit(): number {
        const byte = this.position >> 3;
        if (byte >= this.data.length) throw new DemuxError('WebP lossless bitstream is truncated');
        const value = (this.data[byte]! >> (this.position & 7)) & 1;
        this.position++;
        return value;
    }
}

/**
 * Canonical prefix code as a decoding table indexed by code bits; single-symbol codes consume no
 * bits.
 */
class PrefixCode {
    private readonly single: number;
    private readonly limits: Int32Array;
    private readonly offsets: Int32Array;
    private readonly symbols: Uint16Array;
    private readonly maxLength: number;

    constructor(lengths: Uint8Array) {
        let max = 0;
        let count = 0;
        let last = -1;
        for (let symbol = 0; symbol < lengths.length; symbol++) {
            const length = lengths[symbol]!;
            if (length > 15) throw new DemuxError('WebP prefix code length exceeds 15');
            if (length > 0) {
                count++;
                last = symbol;
                if (length > max) max = length;
            }
        }
        this.maxLength = max;
        this.limits = new Int32Array(17);
        this.offsets = new Int32Array(17);
        this.symbols = new Uint16Array(count);
        if (count <= 1) {
            this.single = last;
            return;
        }
        this.single = -1;
        const perLength = new Int32Array(17);
        for (let symbol = 0; symbol < lengths.length; symbol++) perLength[lengths[symbol]!]++;
        perLength[0] = 0;
        let code = 0;
        let offset = 0;
        for (let length = 1; length <= 16; length++) {
            code = (code + perLength[length - 1]!) << 1;
            this.limits[length] = code + perLength[length]!;
            this.offsets[length] = offset - code;
            offset += perLength[length]!;
        }
        if (code + perLength[16]! > 1 << 16)
            throw new DemuxError('WebP prefix code is over-subscribed');
        const next = new Int32Array(17);
        let cursor = 0;
        for (let length = 1; length <= 16; length++) {
            next[length] = cursor;
            cursor += perLength[length]!;
        }
        for (let symbol = 0; symbol < lengths.length; symbol++) {
            const length = lengths[symbol]!;
            if (length > 0) this.symbols[next[length]!++] = symbol;
        }
    }

    decode(bits: BitReader): number {
        if (this.single >= 0) return this.single;
        let code = 0;
        for (let length = 1; length <= this.maxLength; length++) {
            code = (code << 1) | bits.bit();
            if (code < this.limits[length]!) return this.symbols[code + this.offsets[length]!]!;
        }
        throw new DemuxError('WebP prefix code is invalid');
    }
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const MAX_PIXELS = 1 << 28;

/** Neighbourhood offsets (dx, dy) of the 120 special distance codes. */
const DISTANCE_MAP: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 1],
    [0, 2],
    [2, 0],
    [1, 2],
    [-1, 2],
    [2, 1],
    [-2, 1],
    [2, 2],
    [-2, 2],
    [0, 3],
    [3, 0],
    [1, 3],
    [-1, 3],
    [3, 1],
    [-3, 1],
    [2, 3],
    [-2, 3],
    [3, 2],
    [-3, 2],
    [0, 4],
    [4, 0],
    [1, 4],
    [-1, 4],
    [4, 1],
    [-4, 1],
    [3, 3],
    [-3, 3],
    [2, 4],
    [-2, 4],
    [4, 2],
    [-4, 2],
    [0, 5],
    [3, 4],
    [-3, 4],
    [4, 3],
    [-4, 3],
    [5, 0],
    [1, 5],
    [-1, 5],
    [5, 1],
    [-5, 1],
    [2, 5],
    [-2, 5],
    [5, 2],
    [-5, 2],
    [4, 4],
    [-4, 4],
    [3, 5],
    [-3, 5],
    [5, 3],
    [-5, 3],
    [0, 6],
    [6, 0],
    [1, 6],
    [-1, 6],
    [6, 1],
    [-6, 1],
    [2, 6],
    [-2, 6],
    [6, 2],
    [-6, 2],
    [4, 5],
    [-4, 5],
    [5, 4],
    [-5, 4],
    [3, 6],
    [-3, 6],
    [6, 3],
    [-6, 3],
    [0, 7],
    [7, 0],
    [1, 7],
    [-1, 7],
    [5, 5],
    [-5, 5],
    [7, 1],
    [-7, 1],
    [4, 6],
    [-4, 6],
    [6, 4],
    [-6, 4],
    [2, 7],
    [-2, 7],
    [7, 2],
    [-7, 2],
    [3, 7],
    [-3, 7],
    [7, 3],
    [-7, 3],
    [5, 6],
    [-5, 6],
    [6, 5],
    [-6, 5],
    [8, 0],
    [4, 7],
    [-4, 7],
    [7, 4],
    [-7, 4],
    [8, 1],
    [8, 2],
    [6, 6],
    [-6, 6],
    [8, 3],
    [5, 7],
    [-5, 7],
    [7, 5],
    [-7, 5],
    [8, 4],
    [6, 7],
    [-6, 7],
    [7, 6],
    [-7, 6],
    [8, 5],
    [7, 7],
    [-7, 7],
    [8, 6],
    [8, 7],
];

interface Transform {
    readonly type: number;
    readonly xsize: number;
    readonly bits: number;
    readonly data?: Uint32Array;
}

interface PrefixGroup {
    readonly green: PrefixCode;
    readonly red: PrefixCode;
    readonly blue: PrefixCode;
    readonly alpha: PrefixCode;
    readonly distance: PrefixCode;
}

function divRoundUp(value: number, bits: number): number {
    return (value + (1 << bits) - 1) >> bits;
}

function prefixValue(bits: BitReader, prefix: number): number {
    if (prefix < 4) return prefix + 1;
    const extraBits = (prefix - 2) >> 1;
    const offset = (2 + (prefix & 1)) << extraBits;
    return offset + bits.read(extraBits) + 1;
}

function readPrefixCode(bits: BitReader, alphabetSize: number): PrefixCode {
    const lengths = new Uint8Array(alphabetSize);
    if (bits.read(1)) {
        const symbols = bits.read(1) + 1;
        const first = bits.read(bits.read(1) ? 8 : 1);
        if (first >= alphabetSize)
            throw new DemuxError('WebP simple prefix code symbol is out of range');
        lengths[first] = 1;
        if (symbols === 2) {
            const second = bits.read(8);
            if (second >= alphabetSize)
                throw new DemuxError('WebP simple prefix code symbol is out of range');
            lengths[second] = 1;
        }
        return new PrefixCode(lengths);
    }
    const codeLengthLengths = new Uint8Array(19);
    const count = 4 + bits.read(4);
    for (let index = 0; index < count; index++)
        codeLengthLengths[CODE_LENGTH_ORDER[index]!] = bits.read(3);
    const codeLengthCode = new PrefixCode(codeLengthLengths);
    let maxSymbol = alphabetSize;
    if (bits.read(1)) {
        const lengthBits = 2 + 2 * bits.read(3);
        maxSymbol = 2 + bits.read(lengthBits);
        if (maxSymbol > alphabetSize)
            throw new DemuxError('WebP prefix code declares too many symbols');
    }
    let previous = 8;
    let symbol = 0;
    while (symbol < alphabetSize) {
        if (maxSymbol-- === 0) break;
        const length = codeLengthCode.decode(bits);
        if (length < 16) {
            lengths[symbol++] = length;
            if (length !== 0) previous = length;
        } else {
            const repeat =
                length === 16
                    ? 3 + bits.read(2)
                    : length === 17
                      ? 3 + bits.read(3)
                      : 11 + bits.read(7);
            if (symbol + repeat > alphabetSize)
                throw new DemuxError('WebP prefix code repeat overruns the alphabet');
            const value = length === 16 ? previous : 0;
            for (let index = 0; index < repeat; index++) lengths[symbol++] = value;
        }
    }
    return new PrefixCode(lengths);
}

function readPrefixGroup(bits: BitReader, colorCacheSize: number): PrefixGroup {
    return {
        green: readPrefixCode(bits, NUM_LITERAL_CODES + NUM_LENGTH_CODES + colorCacheSize),
        red: readPrefixCode(bits, NUM_LITERAL_CODES),
        blue: readPrefixCode(bits, NUM_LITERAL_CODES),
        alpha: readPrefixCode(bits, NUM_LITERAL_CODES),
        distance: readPrefixCode(bits, NUM_DISTANCE_CODES),
    };
}

/** Decodes one entropy-coded ARGB image (spatially coded image data or a transform sub-image). */
function readImageData(
    bits: BitReader,
    xsize: number,
    ysize: number,
    level0: boolean,
    transforms: Transform[],
): { pixels: Uint32Array; xsize: number } {
    let width = xsize;
    if (level0) {
        const seen = new Set<number>();
        while (bits.read(1)) {
            const type = bits.read(2);
            if (seen.has(type)) throw new DemuxError('WebP repeats a transform');
            seen.add(type);
            if (type === 0 || type === 1) {
                const sizeBits = bits.read(3) + 2;
                const sub = readImageData(
                    bits,
                    divRoundUp(width, sizeBits),
                    divRoundUp(ysize, sizeBits),
                    false,
                    [],
                );
                transforms.push({ type, xsize: width, bits: sizeBits, data: sub.pixels });
            } else if (type === 2) transforms.push({ type, xsize: width, bits: 0 });
            else {
                const colours = bits.read(8) + 1;
                const table = readImageData(bits, colours, 1, false, []).pixels;
                for (let index = 1; index < colours; index++) {
                    const previous = table[index - 1]!;
                    const delta = table[index]!;
                    table[index] =
                        ((((previous >>> 24) + (delta >>> 24)) & 0xff) << 24) |
                        ((((previous >>> 16) + (delta >>> 16)) & 0xff) << 16) |
                        ((((previous >>> 8) + (delta >>> 8)) & 0xff) << 8) |
                        ((previous + delta) & 0xff);
                }
                const widthBits = colours <= 2 ? 3 : colours <= 4 ? 2 : colours <= 16 ? 1 : 0;
                transforms.push({ type, xsize: width, bits: widthBits, data: table });
                width = divRoundUp(width, widthBits);
            }
        }
    }
    const colorCacheBits = bits.read(1) ? bits.read(4) : 0;
    if (colorCacheBits !== 0 && (colorCacheBits < 1 || colorCacheBits > 11))
        throw new DemuxError('WebP colour cache size is invalid');
    const colorCacheSize = colorCacheBits ? 1 << colorCacheBits : 0;
    let prefixBits = 0;
    let entropyImage: Uint32Array | undefined;
    let groupCount = 1;
    if (level0 && bits.read(1)) {
        prefixBits = bits.read(3) + 2;
        entropyImage = readImageData(
            bits,
            divRoundUp(width, prefixBits),
            divRoundUp(ysize, prefixBits),
            false,
            [],
        ).pixels;
        let max = 0;
        for (let index = 0; index < entropyImage.length; index++) {
            const group = (entropyImage[index]! >>> 8) & 0xffff;
            if (group > max) max = group;
        }
        groupCount = max + 1;
    }
    const groups: PrefixGroup[] = [];
    for (let group = 0; group < groupCount; group++)
        groups.push(readPrefixGroup(bits, colorCacheSize));
    const total = width * ysize;
    if (total > MAX_PIXELS) throw new DemuxError('WebP lossless image exceeds the pixel limit');
    const pixels = new Uint32Array(total);
    const cache = colorCacheSize ? new Uint32Array(colorCacheSize) : undefined;
    const cacheShift = 32 - colorCacheBits;
    const entropyWidth = prefixBits ? divRoundUp(width, prefixBits) : 0;
    let group = groups[0]!;
    let pos = 0;
    let x = 0;
    let y = 0;
    const insert = (argb: number): void => {
        if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> cacheShift] = argb;
    };
    while (pos < total) {
        if (entropyImage) {
            const meta = entropyImage[(y >> prefixBits) * entropyWidth + (x >> prefixBits)]!;
            group = groups[(meta >>> 8) & 0xffff]!;
        }
        const symbol = group.green.decode(bits);
        if (symbol < NUM_LITERAL_CODES) {
            const red = group.red.decode(bits);
            const blue = group.blue.decode(bits);
            const alpha = group.alpha.decode(bits);
            const argb = ((alpha << 24) | (red << 16) | (symbol << 8) | blue) >>> 0;
            pixels[pos++] = argb;
            insert(argb);
            if (++x === width) {
                x = 0;
                y++;
            }
        } else if (symbol < NUM_LITERAL_CODES + NUM_LENGTH_CODES) {
            const length = prefixValue(bits, symbol - NUM_LITERAL_CODES);
            const distanceCode = prefixValue(bits, group.distance.decode(bits));
            let distance: number;
            if (distanceCode > 120) distance = distanceCode - 120;
            else {
                const [dx, dy] = DISTANCE_MAP[distanceCode - 1]!;
                distance = Math.max(1, dx + dy * width);
            }
            if (distance > pos || pos + length > total)
                throw new DemuxError('WebP backward reference is out of range');
            for (let index = 0; index < length; index++) {
                const argb = pixels[pos - distance]!;
                pixels[pos++] = argb;
                insert(argb);
            }
            x += length;
            while (x >= width) {
                x -= width;
                y++;
            }
        } else {
            const index = symbol - NUM_LITERAL_CODES - NUM_LENGTH_CODES;
            if (!cache || index >= colorCacheSize)
                throw new DemuxError('WebP colour cache index is out of range');
            const argb = cache[index]!;
            pixels[pos++] = argb;
            insert(argb);
            if (++x === width) {
                x = 0;
                y++;
            }
        }
    }
    return { pixels, xsize: width };
}

function average2(a: number, b: number): number {
    return (
        (((((a >>> 24) + (b >>> 24)) >> 1) & 0xff) << 24) |
        (((((a >>> 16) & 0xff) + ((b >>> 16) & 0xff)) >> 1) << 16) |
        (((((a >>> 8) & 0xff) + ((b >>> 8) & 0xff)) >> 1) << 8) |
        (((a & 0xff) + (b & 0xff)) >> 1)
    );
}

function addPixels(a: number, b: number): number {
    return (
        ((((a >>> 24) + (b >>> 24)) & 0xff) << 24) |
        ((((a >>> 16) + (b >>> 16)) & 0xff) << 16) |
        ((((a >>> 8) + (b >>> 8)) & 0xff) << 8) |
        ((a + b) & 0xff)
    );
}

function clamp(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

function channel(pixel: number, shift: number): number {
    return (pixel >>> shift) & 0xff;
}

function select(left: number, top: number, topLeft: number): number {
    let predictLeft = 0;
    let predictTop = 0;
    for (const shift of [24, 16, 8, 0]) {
        const predicted = channel(left, shift) + channel(top, shift) - channel(topLeft, shift);
        predictLeft += Math.abs(predicted - channel(left, shift));
        predictTop += Math.abs(predicted - channel(top, shift));
    }
    return predictLeft < predictTop ? left : top;
}

function clampAddSubtractFull(a: number, b: number, c: number): number {
    let out = 0;
    for (const shift of [24, 16, 8, 0])
        out |= clamp(channel(a, shift) + channel(b, shift) - channel(c, shift)) << shift;
    return out;
}

function clampAddSubtractHalf(a: number, b: number): number {
    let out = 0;
    for (const shift of [24, 16, 8, 0]) {
        const ca = channel(a, shift);
        out |= clamp(ca + Math.trunc((ca - channel(b, shift)) / 2)) << shift;
    }
    return out;
}

function predict(mode: number, pixels: Uint32Array, pos: number, width: number): number {
    const left = pixels[pos - 1]!;
    const top = pixels[pos - width]!;
    const topLeft = pixels[pos - width - 1]!;
    const topRight = pixels[pos - width + 1]!;
    switch (mode) {
        case 0:
            return 0xff000000;
        case 1:
            return left;
        case 2:
            return top;
        case 3:
            return topRight;
        case 4:
            return topLeft;
        case 5:
            return average2(average2(left, topRight), top);
        case 6:
            return average2(left, topLeft);
        case 7:
            return average2(left, top);
        case 8:
            return average2(topLeft, top);
        case 9:
            return average2(top, topRight);
        case 10:
            return average2(average2(left, topLeft), average2(top, topRight));
        case 11:
            return select(left, top, topLeft);
        case 12:
            return clampAddSubtractFull(left, top, topLeft);
        case 13:
            return clampAddSubtractHalf(average2(left, top), topLeft);
        default:
            return 0xff000000;
    }
}

function colorTransformDelta(transform: number, colour: number): number {
    return (((transform << 24) >> 24) * ((colour << 24) >> 24)) >> 5;
}

function applyInverse(transform: Transform, pixels: Uint32Array, ysize: number): Uint32Array {
    const width = transform.xsize;
    if (transform.type === 0) {
        const blockWidth = divRoundUp(width, transform.bits);
        for (let pos = 0; pos < pixels.length; pos++) {
            const x = pos % width;
            const y = (pos - x) / width;
            let predicted: number;
            if (pos === 0) predicted = 0xff000000;
            else if (y === 0) predicted = pixels[pos - 1]!;
            else if (x === 0) predicted = pixels[pos - width]!;
            else {
                const mode =
                    (transform.data![
                        (y >> transform.bits) * blockWidth + (x >> transform.bits)
                    ]! >>>
                        8) &
                    0xf;
                predicted = predict(mode, pixels, pos, width);
            }
            pixels[pos] = addPixels(pixels[pos]!, predicted) >>> 0;
        }
        return pixels;
    }
    if (transform.type === 1) {
        const blockWidth = divRoundUp(width, transform.bits);
        for (let pos = 0; pos < pixels.length; pos++) {
            const x = pos % width;
            const y = (pos - x) / width;
            const element =
                transform.data![(y >> transform.bits) * blockWidth + (x >> transform.bits)]!;
            const greenToRed = element & 0xff;
            const greenToBlue = (element >>> 8) & 0xff;
            const redToBlue = (element >>> 16) & 0xff;
            const argb = pixels[pos]!;
            const green = (argb >>> 8) & 0xff;
            const red = ((argb >>> 16) + colorTransformDelta(greenToRed, green)) & 0xff;
            const blue =
                (argb +
                    colorTransformDelta(greenToBlue, green) +
                    colorTransformDelta(redToBlue, red)) &
                0xff;
            pixels[pos] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
        }
        return pixels;
    }
    if (transform.type === 2) {
        for (let pos = 0; pos < pixels.length; pos++) {
            const argb = pixels[pos]!;
            const green = (argb >>> 8) & 0xff;
            pixels[pos] =
                ((argb & 0xff00ff00) |
                    ((((argb >>> 16) + green) & 0xff) << 16) |
                    ((argb + green) & 0xff)) >>>
                0;
        }
        return pixels;
    }
    const table = transform.data!;
    const bits = transform.bits;
    const packedWidth = divRoundUp(width, bits);
    const out = new Uint32Array(width * ysize);
    const perPixel = 8 >> bits;
    const mask = (1 << perPixel) - 1;
    for (let y = 0; y < ysize; y++) {
        for (let x = 0; x < width; x++) {
            const packed = pixels[y * packedWidth + (x >> bits)]!;
            const index = ((packed >>> 8) >>> ((x & ((1 << bits) - 1)) * perPixel)) & mask;
            out[y * width + x] = index < table.length ? table[index]! : 0;
        }
    }
    return out;
}

/** A decoded VP8L picture, and whether it has an alpha channel. */
export interface Vp8lImage extends DecodedImage {
    readonly hasAlpha: boolean;
}

/** Decodes a VP8L chunk payload (the bytes after the 'VP8L' chunk header). */
export function decodeVp8l(data: Uint8Array): Vp8lImage {
    if (data.length < 5 || data[0] !== 0x2f)
        throw new DemuxError('WebP lossless signature is missing');
    const bits = new BitReader(data.subarray(1));
    const width = bits.read(14) + 1;
    const height = bits.read(14) + 1;
    const hasAlpha = bits.read(1) === 1;
    if (bits.read(3) !== 0) throw new DemuxError('WebP lossless version is not supported');
    const argb = decodeVp8lImageStream(bits, width, height);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < argb.length; index++) {
        const pixel = argb[index]!;
        rgba[index * 4] = (pixel >>> 16) & 0xff;
        rgba[index * 4 + 1] = (pixel >>> 8) & 0xff;
        rgba[index * 4 + 2] = pixel & 0xff;
        rgba[index * 4 + 3] = pixel >>> 24;
    }
    return { width, height, hasAlpha, data: rgba };
}

/**
 * Decodes a headerless VP8L image stream (ALPH chunks with lossless compression carry alpha in the
 * green channel).
 */
function decodeVp8lImageStream(bits: BitReader, width: number, height: number): Uint32Array {
    if (width * height > MAX_PIXELS)
        throw new DemuxError('WebP lossless image exceeds the pixel limit');
    const transforms: Transform[] = [];
    let { pixels } = readImageData(bits, width, height, true, transforms);
    for (let index = transforms.length - 1; index >= 0; index--)
        pixels = applyInverse(transforms[index]!, pixels, height);
    return pixels;
}

/**
 * Alpha plane of a VP8X image from its ALPH chunk payload; undefined for unsupported compression.
 */
export function decodeWebpAlpha(
    payload: Uint8Array,
    width: number,
    height: number,
): Uint8Array | undefined {
    if (payload.length < 1) return undefined;
    const compression = payload[0]! & 3;
    const filter = (payload[0]! >> 2) & 3;
    const plane = new Uint8Array(width * height);
    if (compression === 0) {
        if (payload.length < 1 + width * height) return undefined;
        plane.set(payload.subarray(1, 1 + width * height));
    } else if (compression === 1) {
        const argb = decodeVp8lImageStream(new BitReader(payload.subarray(1)), width, height);
        for (let index = 0; index < plane.length; index++)
            plane[index] = (argb[index]! >>> 8) & 0xff;
    } else return undefined;
    if (filter === 0) return plane;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = y * width + x;
            let predictor: number;
            if (x === 0 && y === 0) predictor = 0;
            else if (y === 0) predictor = plane[at - 1]!;
            else if (x === 0) predictor = plane[at - width]!;
            else if (filter === 1) predictor = plane[at - 1]!;
            else if (filter === 2) predictor = plane[at - width]!;
            else predictor = clamp(plane[at - 1]! + plane[at - width]! - plane[at - width - 1]!);
            plane[at] = (plane[at]! + predictor) & 0xff;
        }
    }
    return plane;
}
