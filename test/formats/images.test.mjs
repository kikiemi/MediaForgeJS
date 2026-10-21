import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, inspect } from 'mediaforgejs';
import { encodePng } from 'mediaforgejs/codecs';

const u16le = value => [value & 255, value >> 8];
const u32le = value => [value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24];
const u16be = value => [value >> 8, value & 255];
const u32be = value => [value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255];

/** A GIF of `version` ('87a' or '89a') with a logical screen of `width` x `height`. */
const gif = (width, height, version = '89a') =>
    Uint8Array.from([
        ...Buffer.from(`GIF${version}`),
        ...u16le(width),
        ...u16le(height),
        0,
        0,
        0,
        0x3b,
    ]);

/** A BMP with a BITMAPINFOHEADER of `width` x `height` (negative: stored top-down). */
const bmp = (width, height) =>
    Uint8Array.from([
        ...Buffer.from('BM'),
        ...u32le(58),
        ...u32le(0),
        ...u32le(54),
        ...u32le(40),
        ...u32le(width),
        ...u32le(height >>> 0),
        ...u16le(1),
        ...u16le(24),
        ...new Array(24).fill(0),
        0,
        0,
        0,
        0,
    ]);

/** A BMP with an OS/2 BITMAPCOREHEADER of `width` x `height`. */
const bmpCore = (width, height) =>
    Uint8Array.from([
        ...Buffer.from('BM'),
        ...u32le(30),
        ...u32le(0),
        ...u32le(26),
        ...u32le(12),
        ...u16le(width),
        ...u16le(height),
        ...u16le(1),
        ...u16le(24),
        0,
        0,
        0,
        0,
    ]);

/** An ICO directory of pictures `sizes` ([width, height], 256 written as 0). */
const ico = sizes =>
    Uint8Array.from([
        0,
        0,
        1,
        0,
        ...u16le(sizes.length),
        ...sizes.flatMap(([width, height]) => [
            width & 255,
            height & 255,
            0,
            0,
            ...u16le(1),
            ...u16le(32),
            ...u32le(40),
            ...u32le(6 + 16 * sizes.length),
        ]),
        ...new Array(40).fill(0),
    ]);

/** A TIFF of `width` x `height` in either byte order, the width a SHORT and the height a LONG. */
function tiff(width, height, littleEndian) {
    const u16 = littleEndian ? u16le : u16be;
    const u32 = littleEndian ? u32le : u32be;
    const entry = (tag, type, value) => [
        ...u16(tag),
        ...u16(type),
        ...u32(1),
        ...(type === 3 ? [...u16(value), 0, 0] : u32(value)),
    ];
    return Uint8Array.from([
        ...(littleEndian ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a]),
        ...u32(8),
        ...u16(2),
        ...entry(256, 3, width),
        ...entry(257, 4, height),
        ...u32(0),
    ]);
}

/** A JPEG of `width` x `height` whose start-of-frame marker `sof` follows an APP0 segment. */
const jpeg = (width, height, sof = 0xc0) =>
    Uint8Array.from([
        0xff,
        0xd8,
        0xff,
        0xe0,
        ...u16be(16),
        ...Buffer.from('JFIF\0'),
        1,
        1,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        0xff,
        sof,
        ...u16be(17),
        8,
        ...u16be(height),
        ...u16be(width),
        3,
        1,
        0x22,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
        0xff,
        0xd9,
    ]);

/** The format and the size inspect() reports for `bytes`. */
async function described(bytes) {
    const { format, tracks } = await inspect(bytes);
    return [format, tracks[0].width, tracks[0].height];
}

describe('images', () => {
    test('reads the size of a PNG from its IHDR chunk', async () => {
        const png = await encodePng({ data: new Uint8Array(16 * 12 * 4), width: 16, height: 12 });
        assert.deepEqual(await described(png), ['png', 16, 12]);
    });

    test('reads the logical screen size of GIF87a and GIF89a', async () => {
        assert.deepEqual(await described(gif(40, 30, '89a')), ['gif', 40, 30]);
        assert.deepEqual(await described(gif(7, 300, '87a')), ['gif', 7, 300]);
    });

    test('reads a BMP stored bottom-up or top-down at its height', async () => {
        assert.deepEqual(await described(bmp(20, 10)), ['bmp', 20, 10]);
        assert.deepEqual(await described(bmp(20, -10)), ['bmp', 20, 10]);
    });

    test('reads a BMP with an OS/2 core header', async () => {
        assert.deepEqual(await described(bmpCore(33, 17)), ['bmp', 33, 17]);
    });

    test('reads an icon as its largest picture, a zero size meaning 256', async () => {
        assert.deepEqual(
            (
                await described(
                    ico([
                        [16, 16],
                        [0, 0],
                        [48, 48],
                    ]),
                )
            ).slice(1),
            [256, 256],
        );
    });

    test('reads the width and length tags of a TIFF in either byte order', async () => {
        assert.deepEqual((await described(tiff(64, 48, true))).slice(1), [64, 48]);
        assert.deepEqual((await described(tiff(64, 48, false))).slice(1), [64, 48]);
    });

    test('reads the size of a JPEG from a baseline or progressive start of frame', async () => {
        assert.deepEqual(await described(jpeg(320, 240)), ['jpeg', 320, 240]);
        assert.deepEqual(await described(jpeg(17, 9, 0xc2)), ['jpeg', 17, 9]);
    });

    test('a JPEG whose header ends before its start of frame reports no size', async () => {
        const [, width, height] = await described(jpeg(320, 240).subarray(0, 22));
        assert.deepEqual([width, height], [undefined, undefined]);
    });

    test('capabilities list in Node the image formats the library decodes and writes', async () => {
        // Node has no canvas and no image decoder: the formats only a host handles are left out,
        // though inspect() reads their sizes as above.
        const reported = await capabilities();
        assert.deepEqual(reported.imageRead, ['apng', 'gif', 'png', 'tiff', 'webp']);
        assert.deepEqual(reported.images, ['apng', 'bmp', 'gif', 'ico', 'png', 'tiff']);
    });
});
