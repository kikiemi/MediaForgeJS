import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { check, convert, inspect } from 'mediaforgejs';
import { encodePng } from 'mediaforgejs/codecs';
import { greyAvi, pngRgba } from '../helpers/api-fixtures.mjs';
import { patternRgba } from '../helpers/pattern.mjs';
import { tiff } from '../helpers/tiff-fixtures.mjs';

// Still pictures converted to pictures: the host's decoder where it has one (createImageBitmap),
// the library's otherwise (PNG, GIF, TIFF, lossless WebP); in Node these tests run the library's.

/** The passes of Adam7: first column, first row, column step, row step. */
const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
];

/** Samples of one row at `depth` bits, packed high bit first; 16 bits big-endian. */
function packRow(samples, depth) {
    if (depth === 16) return samples.flatMap(value => [value >> 8, value & 255]);
    if (depth === 8) return samples;
    const bytes = new Array(Math.ceil((samples.length * depth) / 8)).fill(0);
    samples.forEach((value, index) => {
        const bit = index * depth;
        bytes[bit >> 3] |= value << (8 - depth - (bit & 7));
    });
    return bytes;
}

/** A PNG chunk with its CRC. */
function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
}

/**
 * A PNG of `samples` (each pixel's channels in order, at `depth` bits), unfiltered, interlaced with
 * Adam7 when asked.
 */
function pngOf({ width, height, colorType, depth, samples, interlace = false, palette, trns }) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    const rows = [];
    for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]])
        for (let y = y0; y < height; y += dy) {
            const row = [];
            for (let x = x0; x < width; x += dx)
                row.push(
                    ...samples.slice((y * width + x) * channels, (y * width + x + 1) * channels),
                );
            if (row.length) rows.push(0, ...packRow(row, depth));
        }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([depth, colorType, 0, 0, interlace ? 1 : 0], 8);
    return new Blob([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        ...(palette ? [chunk('PLTE', palette)] : []),
        ...(trns ? [chunk('tRNS', trns)] : []),
        chunk('IDAT', deflateSync(Buffer.from(rows))),
        chunk('IEND', []),
    ]);
}

/** The RGBA pixels of a converted PNG. */
const pixelsOf = async result => [...pngRgba(new Uint8Array(await result.blob.arrayBuffer())).rgba];

/** The heads of pictures only the host decodes, enough to be recognised. */
const HOST_DECODED = {
    jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1]),
    bmp: Uint8Array.from([66, 77, ...new Array(52).fill(0)]),
    ico: Uint8Array.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]),
};

/** A PNG of the 8x8 test pattern, by the library's encoder. */
const patternPng = async () =>
    new Blob([await encodePng({ data: patternRgba(8, 8, 2), width: 8, height: 8 })]);

describe('pipeline/frames: still pictures', () => {
    test('a PNG converts in Node by the library decoder to every format it writes', async () => {
        const source = await patternPng();
        assert.deepEqual(await pixelsOf(await convert(source, 'png')), [...patternRgba(8, 8, 2)]);
        const larger = await convert(source, { to: 'png', video: { width: 16 } });
        assert.equal(pngRgba(new Uint8Array(await larger.blob.arrayBuffer())).width, 16);
        // A still written as APNG is a plain PNG.
        for (const [to, read] of [
            ['gif', 'gif'],
            ['apng', 'png'],
            ['bmp', 'bmp'],
            ['tiff', 'tiff'],
            ['ico', 'ico'],
        ]) {
            const info = await inspect((await convert(source, to)).blob);
            assert.deepEqual([info.format, info.tracks[0].width], [read, 8], to);
        }
    });

    test('every PNG colour type and depth decodes, interlaced too', async () => {
        // 16-bit samples keep their high byte; a 16-bit tRNS key is compared at 16 bits.
        const [width, height] = [5, 3];
        const count = width * height;
        const index = Array.from({ length: count }, (_, i) => i);
        const cases = [
            {
                name: '1-bit grey',
                png: { colorType: 0, depth: 1, samples: index.map(i => i % 2) },
                rgba: index.flatMap(i => (i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
            },
            {
                name: '2-bit palette with tRNS, interlaced',
                png: {
                    colorType: 3,
                    depth: 2,
                    samples: index.map(i => i % 3),
                    palette: [10, 20, 30, 40, 50, 60, 70, 80, 90],
                    trns: [0, 128],
                    interlace: true,
                },
                rgba: index.flatMap(
                    i =>
                        [
                            [10, 20, 30, 0],
                            [40, 50, 60, 128],
                            [70, 80, 90, 255],
                        ][i % 3],
                ),
            },
            {
                name: '16-bit grey whose tRNS key is compared at 16 bits',
                png: {
                    colorType: 0,
                    depth: 16,
                    samples: index.map(i => (i % 2 ? 0x1234 : 0x1235)),
                    trns: [0x12, 0x34],
                },
                rgba: index.flatMap(i => [0x12, 0x12, 0x12, i % 2 ? 0 : 255]),
            },
            {
                name: '16-bit RGBA, interlaced',
                png: {
                    colorType: 6,
                    depth: 16,
                    samples: index.flatMap(i => [i * 4000, 0xff00, 0x80ff, 65535 - i * 4000]),
                    interlace: true,
                },
                rgba: index.flatMap(i => [(i * 4000) >> 8, 0xff, 0x80, (65535 - i * 4000) >> 8]),
            },
            {
                name: '8-bit grey and alpha, interlaced',
                png: {
                    colorType: 4,
                    depth: 8,
                    samples: index.flatMap(i => [i * 16, 255 - i]),
                    interlace: true,
                },
                rgba: index.flatMap(i => [i * 16, i * 16, i * 16, 255 - i]),
            },
        ];
        for (const { name, png, rgba } of cases) {
            const result = await convert(pngOf({ width, height, ...png }), 'png');
            assert.deepEqual(await pixelsOf(result), rgba, name);
        }
    });

    test("a GIF's first picture converts to a PNG in Node", async () => {
        const gif = (await convert(await patternPng(), 'gif')).blob;
        assert.deepEqual(await pixelsOf(await convert(gif, 'png')), [...patternRgba(8, 8, 2)]);
    });

    test('JPEG, BMP and ICO need a host decoder in Node: DECODE, naming the others', async () => {
        for (const [format, bytes] of Object.entries(HOST_DECODED))
            await assert.rejects(
                convert(new Blob([bytes]), 'png'),
                error =>
                    error.code === 'DECODE' &&
                    error.message === `${format} decoding needs the host createImageBitmap` &&
                    /PNG, GIF, TIFF/.test(error.hint),
                format,
            );
    });

    test('outputs only a host canvas writes fail in Node with ENCODE before decoding', async () => {
        // A JPEG input, which Node cannot decode either: the output is refused first.
        for (const to of ['jpeg', 'webp', 'avif', 'heif', 'jxl'])
            await assert.rejects(
                convert(new Blob([HOST_DECODED.jpeg]), to),
                error =>
                    error.code === 'ENCODE' &&
                    error.message === `${to.toUpperCase()} pictures need OffscreenCanvas` &&
                    /'png'/.test(error.hint),
                to,
            );
    });

    test('check() of a video picture in a stills-only format fails as convert()', async () => {
        const movie = new Blob([greyAvi()]);
        for (const to of ['bmp', 'avif']) {
            const refused = await convert(movie, to).catch(error => error);
            const report = await check(movie, to);
            assert.deepEqual(
                [report.supported, report.code, report.reason],
                [false, refused.code, refused.message],
                to,
            );
        }
    });

    test('a TIFF of LZW tiles with the horizontal predictor converts in Node', async () => {
        const [width, height] = [21, 9];
        const values = Array.from({ length: width * height * 4 }, (_, index) => (index * 29) % 256);
        const lzw = tiff({
            width,
            height,
            samples: 4,
            values,
            tile: [16, 16],
            extra: 2,
            compression: 5,
            predictor: 2,
        });
        const { blob } = await convert(new Blob([lzw]), 'png');
        assert.deepEqual(
            pngRgba(new Uint8Array(await blob.arrayBuffer())).rgba,
            Uint8Array.from(values),
        );
    });

    test('a JPEG-compressed TIFF needs the host and fails with DECODE', async () => {
        const [width, height] = [21, 9];
        const values = Array.from({ length: width * height * 4 }, (_, index) => (index * 29) % 256);
        const jpeg = tiff({ width, height, samples: 4, values, tile: [16, 16], extra: 2 });
        const view = new DataView(jpeg.buffer);
        const ifd = view.getUint32(4, true);
        // Compression (tag 259) 7: JPEG.
        for (let entry = ifd + 2; entry < ifd + 2 + view.getUint16(ifd, true) * 12; entry += 12)
            if (view.getUint16(entry, true) === 259) view.setUint16(entry + 8, 7, true);
        await assert.rejects(convert(new Blob([jpeg]), 'png'), error => error.code === 'DECODE');
    });
});
