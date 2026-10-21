import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { assertPixels, type DecodedImage } from './rgba-image';
import { inflateBounded } from '../../core/io/inflate';

/**
 * Baseline TIFF pictures decoded without the host: the first image of a file, uncompressed,
 * PackBits, LZW or Deflate, in strips or tiles, chunky or planar, with the horizontal predictor;
 * bilevel, 8- and 16-bit gray, palette, RGB, and gray or RGB with alpha. Other pictures (JPEG or
 * CCITT compression, CMYK, YCbCr, floating-point samples, BigTIFF) are left to the host.
 */

/** A picture this decoder leaves to the host. */
class Unsupported extends Error {}

function unsupported(): never {
    throw new Unsupported();
}

function damaged(what: string): never {
    throw new MediaForgeError(`TIFF ${what}`, 'DECODE');
}

/** PackBits runs: a count n copies n + 1 bytes, -n repeats the next byte n + 1 times. */
function unpackBits(data: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let read = 0, written = 0; read < data.length && written < size;) {
        const count = (data[read++]! << 24) >> 24;
        if (count >= 0) {
            const run = data.subarray(read, Math.min(read + count + 1, read + size - written));
            out.set(run, written);
            written += run.length;
            read += count + 1;
        } else if (count !== -128) {
            const end = Math.min(written + 1 - count, size);
            out.fill(data[read++] ?? 0, written, end);
            written = end;
        }
    }
    return out;
}

/**
 * TIFF LZW: codes of 9 to 12 bits, most significant bit first, 256 clearing the table and 257
 * ending the strip; the code width grows one code early, as every TIFF writer does.
 */
function unpackLzw(data: Uint8Array, size: number): Uint8Array {
    if (data[0] === 0 && data[1]! & 1) unsupported(); // Old-style (LSB first) LZW.
    const out = new Uint8Array(size);
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const lengths = new Uint16Array(4096).fill(1, 0, 256);
    for (let code = 0; code < 256; code++) suffix[code] = first[code] = code;
    let next = 258;
    let width = 9;
    let previous = -1;
    let written = 0;
    let buffer = 0;
    let bits = 0;
    for (let read = 0; written < size;) {
        while (bits < width && read < data.length) {
            buffer = ((buffer << 8) | data[read++]!) >>> 0;
            bits += 8;
        }
        if (bits < width) break;
        bits -= width;
        const code = (buffer >>> bits) & ((1 << width) - 1);
        buffer &= (1 << bits) - 1;
        if (code === 257) break;
        if (code === 256) {
            next = 258;
            width = 9;
            previous = -1;
            continue;
        }
        let entry = code;
        if (previous >= 0 && next < 4096) {
            // The new entry: the previous string and the first byte of this one (or of itself).
            if (code > next) damaged('LZW code is out of order');
            prefix[next] = previous;
            first[next] = first[previous]!;
            suffix[next] = first[code === next ? previous : code]!;
            lengths[next] = lengths[previous]! + 1;
            if (code === next) entry = next;
            next++;
        } else if (code > 255 && code >= next) damaged('LZW code is out of order');

        // The string of `entry`, written back to front from its last byte.
        const length = lengths[entry]!;
        for (let at = entry, end = written + length; end > written; at = prefix[at]!)
            if (--end < size) out[end] = suffix[at]!;
        written += length;
        previous = entry;
        if (next + 1 >= 1 << width && width < 12) width++;
    }
    return out;
}

/** The picture of `bytes`, or undefined when its kind is left to the host. */
export async function decodeTiff(
    bytes: Uint8Array,
    signal?: AbortSignal,
): Promise<DecodedImage | undefined> {
    try {
        return await decode(bytes, signal);
    } catch (error) {
        if (error instanceof Unsupported) return undefined;
        throw error;
    }
}

async function decode(bytes: Uint8Array, signal?: AbortSignal): Promise<DecodedImage> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 0x49;
    if (bytes.length < 8 || bytes[0] !== bytes[1] || (!little && bytes[0] !== 0x4d))
        damaged('byte order mark is missing');
    const u16 = (at: number): number => view.getUint16(at, little);
    const u32 = (at: number): number => view.getUint32(at, little);
    if (u16(2) !== 42) unsupported(); // BigTIFF (43) or not classic TIFF.

    // The first directory: each field's values (BYTE, SHORT or LONG) by tag.
    const fields = new Map<number, number[]>();
    const directory = u32(4);
    if (directory + 2 > bytes.length) damaged('directory lies past the end');
    const entries = u16(directory);
    if (directory + 2 + entries * 12 > bytes.length) damaged('directory is cut');
    for (let index = 0; index < entries; index++) {
        const entry = directory + 2 + index * 12;
        const type = u16(entry + 2);
        const count = u32(entry + 4);
        const unit = [0, 1, 0, 2, 4][type] ?? 0;
        if (!unit || count > 0x100000) continue;
        const from = unit * count <= 4 ? entry + 8 : u32(entry + 8);
        if (from + unit * count > bytes.length) damaged('field lies past the end');
        fields.set(
            u16(entry),
            Array.from({ length: count }, (_, item) => {
                const at = from + item * unit;
                return unit === 1 ? bytes[at]! : unit === 2 ? u16(at) : u32(at);
            }),
        );
    }
    const field = (tag: number, fallback?: number): number => {
        const value = fields.get(tag)?.[0] ?? fallback;
        return value ?? damaged(`field ${tag} is missing`);
    };

    const width = field(256);
    const height = field(257);
    if (!width || !height) damaged('picture is empty');
    assertPixels('TIFF', width, height);
    const samples = field(277, 1);
    const bitList = fields.get(258) ?? [1];
    const bits = bitList[0]!;
    const compression = field(259, 1);
    const photometric = field(262, samples > 2 ? 2 : 1);
    const predictor = field(317, 1);
    const color = photometric === 2 ? 3 : 1;
    const palette = fields.get(320);
    if (
        bitList.some(value => value !== bits) ||
        ![1, 5, 8, 32946, 32773].includes(compression) ||
        photometric > 3 ||
        (fields.get(339) ?? [1]).some(format => format !== 1) ||
        predictor > 2 ||
        samples < color ||
        samples > color + 1 ||
        !(photometric === 3
            ? bits === 4 || bits === 8
            : bits === 1
              ? samples === 1
              : bits % 8 === 0) ||
        bits > 16
    )
        unsupported();
    if (photometric === 3 && !(palette && palette.length >= 3 << bits)) damaged('palette is cut');

    // Unassociated alpha unless the extra sample says premultiplied (1) or not alpha (0).
    const extra = samples > color ? field(338, 2) : 0;

    // Strips are tiles as wide as the picture; planar pictures repeat them per sample.
    const tiled = fields.has(322);
    const tileWidth = tiled ? field(322) : width;
    const tileHeight = tiled ? field(323) : Math.min(field(278, height), height);
    const offsets = fields.get(tiled ? 324 : 273) ?? damaged('picture data is missing');
    const counts = fields.get(tiled ? 325 : 279);
    const planar = field(284, 1) === 2 && samples > 1;
    const across = Math.ceil(width / tileWidth);
    const tiles = across * Math.ceil(height / tileHeight);
    if (!tileWidth || !tileHeight || offsets.length < tiles * (planar ? samples : 1))
        damaged('tile layout is invalid');
    const tileSamples = planar ? 1 : samples;
    const rowBytes = Math.ceil((tileWidth * tileSamples * bits) / 8);
    const tileBytes = rowBytes * tileHeight;

    // Every sample of the picture, chunky, at its own size (16-bit as two bytes, 1-bit in rows).
    const step = bits >> 3 || 1;
    const pictureRow = bits < 8 ? Math.ceil((width * bits) / 8) : width * samples * step;
    const picture = new Uint8Array(pictureRow * height);
    for (let index = 0; index < tiles * (planar ? samples : 1); index++) {
        throwIfAborted(signal);
        const offset = offsets[index]!;
        if (offset >= bytes.length) damaged('picture data lies past the end');
        const raw = bytes.subarray(offset, offset + (counts?.[index] ?? bytes.length));
        const data =
            compression === 1
                ? raw
                : compression === 32773
                  ? unpackBits(raw, tileBytes)
                  : compression === 5
                    ? unpackLzw(raw, tileBytes)
                    : await inflateBounded([raw], tileBytes + 64, 'TIFF Deflate data', signal);
        if (predictor === 2) {
            if (bits < 8) unsupported();
            const stride = tileSamples * step;
            for (let row = 0; row + rowBytes <= data.length; row += rowBytes)
                for (let at = row + stride; at < row + rowBytes; at += step) {
                    if (step === 1) data[at] = data[at]! + data[at - stride]!;
                    else {
                        const value = view16(data, at, little) + view16(data, at - stride, little);
                        data[at + (little ? 0 : 1)] = value;
                        data[at + (little ? 1 : 0)] = value >> 8;
                    }
                }
        }
        const plane = Math.floor(index / tiles);
        const tile = index % tiles;
        const x0 = (tile % across) * tileWidth;
        const y0 = Math.floor(tile / across) * tileHeight;
        const columns = Math.min(tileWidth, width - x0);
        for (let row = 0; row < tileHeight && y0 + row < height; row++) {
            const from = row * rowBytes;
            const to = (y0 + row) * pictureRow;
            if (bits < 8) {
                if ((x0 * bits) % 8) unsupported();
                const length = Math.ceil((columns * bits) / 8);
                picture.set(data.subarray(from, from + length), to + (x0 * bits) / 8);
            } else if (!planar) {
                const length = columns * samples * step;
                picture.set(data.subarray(from, from + length), to + x0 * samples * step);
            } else
                for (let x = 0; x < columns; x++)
                    for (let byte = 0; byte < step; byte++)
                        picture[to + ((x0 + x) * samples + plane) * step + byte] =
                            data[from + x * step + byte] ?? 0;
        }
    }

    // RGBA: 16-bit samples rounded to 8 bits, gray inverted for WhiteIsZero, palette colours,
    // premultiplied colours divided by their alpha.
    const rgba = new Uint8ClampedArray(width * height * 4);
    const sample = (at: number): number =>
        step === 1 ? picture[at]! : Math.round(view16(picture, at, little) / 257);
    const value = new Int32Array(4);
    for (let y = 0, out = 0; y < height; y++)
        for (let x = 0; x < width; x++, out += 4) {
            const at = y * pictureRow + (bits < 8 ? (x * bits) >> 3 : x * samples * step);
            const index =
                bits < 8
                    ? (picture[at]! >> (8 - bits - ((x * bits) & 7))) & ((1 << bits) - 1)
                    : picture[at]!;
            value[3] = 255;
            if (photometric === 3)
                for (let part = 0; part < 3; part++)
                    value[part] = palette![(part << bits) + index]! >> 8;
            else if (bits === 1) value[0] = value[1] = value[2] = index * 255;
            else if (color === 3)
                for (let part = 0; part < samples; part++) value[part] = sample(at + part * step);
            else {
                value[0] = value[1] = value[2] = sample(at);
                if (samples > 1) value[3] = sample(at + step);
            }
            if (photometric === 0)
                for (let part = 0; part < 3; part++) value[part] = 255 - value[part]!;
            const alpha = extra ? value[3]! : 255;
            for (let part = 0; part < 3; part++)
                rgba[out + part] =
                    extra === 1 && alpha ? (value[part]! * 255) / alpha : value[part]!;
            rgba[out + 3] = alpha;
        }
    return { width, height, data: rgba };
}

/** A 16-bit sample in the file's byte order. */
function view16(data: Uint8Array, at: number, little: boolean): number {
    return little ? data[at]! | (data[at + 1]! << 8) : (data[at]! << 8) | data[at + 1]!;
}
