import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import {
    AnimatedGifEncoder,
    AnimatedWebpEncoder,
    ApngEncoder,
    RgbaResizer,
    decodeAnimatedWebp,
    decodeStillWebp,
    decodeVp8l,
    encodeBmp,
    encodeIco,
    encodeJpeg,
    encodePng,
    encodeTiff,
    encodeWebP,
} from 'mediaforgejs/codecs';
import { FIXTURES, STILL_LOSSLESS_RGBA } from '../helpers/new-format-fixtures.mjs';
import { tiff } from '../helpers/tiff-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { decodeTiff } = await import(distUrl('esm/codecs/image/tiff-decoder.js'));

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const ascii = (bytes, text) => Buffer.from(bytes).indexOf(text);

/** Runs `body` with host globals (OffscreenCanvas, ImageData) replaced, restoring them after. */
async function withGlobals(globals, body) {
    const saved = Object.keys(globals).map(name => [name, globalThis[name]]);
    Object.assign(globalThis, globals);
    try {
        return await body();
    } finally {
        for (const [name, value] of saved)
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
    }
}

class FakeImageData {
    constructor(data, width, height) {
        Object.assign(this, { data, width, height });
    }
}

/** A host canvas double that records what is drawn and returns `bytes` of the type asked. */
function fakeCanvas(bytes, drawn = []) {
    return class FakeCanvas {
        constructor(width, height) {
            Object.assign(this, { width, height });
        }
        getContext() {
            return { putImageData: image => drawn.push([...image.data]) };
        }
        async convertToBlob({ type }) {
            return new Blob([bytes], { type });
        }
    };
}

/** An APNG of two 2x1 frames with `alpha` in the first pixel, playing `loopCount` times. */
async function twoFrameApng(loopCount, alpha) {
    const frames = new ApngEncoder(2, 1, { loopCount });
    for (let index = 0; index < 2; index++)
        await frames.addFrame(
            { data: Uint8Array.of(255, 20, 10, alpha, 3, 70, 9 * index, 255), width: 2, height: 1 },
            100,
        );
    return frames.encode();
}

/** The values of a TIFF's first IFD: tag to its first value. */
function tiffTags(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const ifd = view.getUint32(4, true);
    const tags = new Map();
    for (let index = 0; index < view.getUint16(ifd, true); index++) {
        const at = ifd + 2 + index * 12;
        const short = view.getUint16(at + 2, true) === 3 && view.getUint32(at + 4, true) === 1;
        tags.set(
            view.getUint16(at, true),
            short ? view.getUint16(at + 8, true) : view.getUint32(at + 8, true),
        );
    }
    return tags;
}

describe('image', () => {
    describe('still encoders', () => {
        const picture = {
            data: Uint8ClampedArray.of(255, 20, 10, 128, 3, 70, 230, 0),
            width: 2,
            height: 1,
        };

        test('BMP keeps alpha in a 32-bit BITMAPV5 picture', async () => {
            const bmp = await encodeBmp(picture);
            assert(bmp instanceof Uint8Array);
            const view = new DataView(bmp.buffer);
            assert.deepEqual([view.getUint32(14, true), view.getUint16(28, true)], [124, 32]);
            const pixels = view.getUint32(10, true);
            assert.deepEqual([...bmp.slice(pixels, pixels + 8)], [10, 20, 255, 128, 230, 70, 3, 0]);
        });

        test('TIFF keeps alpha as unassociated extra samples', async () => {
            const bytes = await encodeTiff(picture);
            const tags = tiffTags(bytes);
            assert.deepEqual([tags.get(277), tags.get(338)], [4, 2]);
            assert.deepEqual(
                bytes.slice(tags.get(273), tags.get(273) + 8),
                new Uint8Array(picture.data),
            );
        });

        test('JPEG and WebP need the host and fail with ENCODE without it', async () => {
            const opaque = { ...picture, data: Uint8ClampedArray.of(1, 2, 3, 255, 4, 5, 6, 255) };
            for (const encode of [encodeJpeg, encodeWebP])
                await assert.rejects(encode(opaque), { code: 'ENCODE', hint: /encodePng/ });
            await assert.rejects(encodeJpeg(picture), {
                code: 'ENCODE',
                message: 'JPEG cannot keep transparency',
            });
        });

        test('JPEG and WebP draw the picture for the host at the quality asked', async () => {
            const drawn = [];
            const asked = [];
            class Canvas extends fakeCanvas(Uint8Array.of(7, 7), drawn) {
                async convertToBlob(options) {
                    asked.push(options);
                    return super.convertToBlob(options);
                }
            }
            const opaque = { data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 };
            await withGlobals({ OffscreenCanvas: Canvas, ImageData: FakeImageData }, async () => {
                assert.deepEqual(await encodeJpeg(opaque), Uint8Array.of(7, 7));
                assert.deepEqual(await encodeWebP(opaque, { quality: 3 }), Uint8Array.of(7, 7));
            });
            assert.deepEqual(drawn, [
                [1, 2, 3, 255],
                [1, 2, 3, 255],
            ]);
            assert.deepEqual(asked, [
                { type: 'image/jpeg', quality: 0.9 },
                { type: 'image/webp', quality: 1 },
            ]);
        });

        test('ICO keeps the shape, scaling the longest side down to 256', async () => {
            const icon = async (width, height) => {
                const data = new Uint8ClampedArray(width * height * 4).fill(200);
                const bytes = await encodeIco({ data, width, height });
                const png = bytes.subarray(new DataView(bytes.buffer).getUint32(18, true));
                const header = new DataView(png.buffer, png.byteOffset);
                return [
                    bytes[6] || 256,
                    bytes[7] || 256,
                    header.getUint32(16),
                    header.getUint32(20),
                ];
            };
            assert.deepEqual(await icon(64, 27), [64, 27, 64, 27]);
            assert.deepEqual(await icon(1280, 534), [256, 107, 256, 107]);
            assert.deepEqual(await icon(100, 500), [51, 256, 51, 256]);
        });

        test("a picture's PNG comes from the canvas only when every pixel is opaque", async () => {
            // A canvas keeps premultiplied alpha; the library's encoder writes the rest, and
            // anything the canvas fails at.
            const drawn = [];
            let blobType = 'image/png';
            class Canvas extends fakeCanvas(Uint8Array.of(1, 2, 3), drawn) {
                async convertToBlob() {
                    return new Blob([Uint8Array.of(1, 2, 3)], { type: blobType });
                }
            }
            const opaque = {
                data: Uint8Array.of(255, 20, 10, 255, 3, 70, 230, 255),
                width: 2,
                height: 1,
            };
            const translucent = {
                ...opaque,
                data: Uint8Array.of(255, 20, 10, 128, 3, 70, 230, 255),
            };
            const own = {
                opaque: await encodePng(opaque),
                translucent: await encodePng(translucent),
            };
            await withGlobals({ OffscreenCanvas: Canvas, ImageData: FakeImageData }, async () => {
                assert.deepEqual(await encodePng(opaque), Uint8Array.of(1, 2, 3));
                assert.deepEqual(drawn, [[...opaque.data]]);
                assert.deepEqual(await encodePng(translucent), own.translucent);
                assert.equal(drawn.length, 1, 'a translucent picture is not drawn on a canvas');
                blobType = 'image/jpeg';
                assert.deepEqual(
                    await encodePng(opaque),
                    own.opaque,
                    'a canvas that writes another type is not used',
                );
            });
        });

        test("without a host, PNG is the library's: signature, header and end", async () => {
            const png = await encodePng({ data: Uint8Array.of(1, 2, 3, 4), width: 1, height: 1 });
            assert.deepEqual(
                [...png.subarray(0, 8)],
                [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            );
            assert(ascii(png, 'IHDR') === 12 && ascii(png, 'IEND') > 0);
        });

        test('a decoded picture encodes as it is', async () => {
            const still = await decodeStillWebp(FIXTURES['still-lossless.webp'].bytes());
            const tags = tiffTags(await encodeTiff(still));
            assert.deepEqual([tags.get(256), tags.get(257)], [still.width, still.height]);
        });

        test('pictures that are not RGBA of their size fail with INPUT', async () => {
            for (const bad of [
                undefined,
                { data: [1, 2, 3, 4], width: 1, height: 1 },
                { data: new Uint8Array(3), width: 1, height: 1 },
                { data: new Uint8Array(4), width: 0, height: 1 },
            ])
                for (const encode of [encodePng, encodeBmp, encodeTiff, encodeIco, encodeJpeg])
                    await assert.rejects(encode(bad), { code: 'INPUT' });
        });

        test('an aborted signal stops each encoder with ABORT', async () => {
            const signal = AbortSignal.abort();
            for (const encode of [encodePng, encodeBmp, encodeTiff, encodeIco, encodeJpeg])
                await assert.rejects(encode(picture, { signal }), { code: 'ABORT' });
        });
    });

    describe('animation encoders', () => {
        const frame = data => ({ data, width: 2, height: 1 });

        test('a GIF frame with partial alpha is refused; opaque frames encode', async () => {
            const rgba = Uint8ClampedArray.of(255, 20, 10, 128, 3, 70, 230, 0);
            const gif = new AnimatedGifEncoder(2, 1);
            await assert.rejects(gif.addFrame(frame(rgba), 100), { code: 'ENCODE' });
            rgba[3] = 255;
            await gif.addFrame(frame(rgba), 100);
            const bytes = await gif.encode();
            assert(bytes instanceof Uint8Array);
            assert.equal(ascii(bytes, 'GIF89a'), 0);
        });

        test('loopCount counts plays alike in GIF, APNG and WebP; 0 loops forever', async () => {
            const opaque = Uint8ClampedArray.of(255, 20, 10, 255, 3, 70, 230, 255);
            const netscape = async loopCount => {
                const gif = new AnimatedGifEncoder(2, 1, { loopCount });
                await gif.addFrame(frame(opaque), 100);
                const bytes = await gif.encode();
                const at = ascii(bytes, 'NETSCAPE2.0');
                return at < 0 ? null : bytes[at + 13] | (bytes[at + 14] << 8);
            };
            // The NETSCAPE block counts repetitions after the first play.
            assert.deepEqual(
                [await netscape(0), await netscape(1), await netscape(3)],
                [0, null, 2],
            );
            const apng = await twoFrameApng(3, 255);
            const actl = ascii(apng, 'acTL');
            assert.equal(new DataView(apng.buffer).getUint32(actl + 8), 3);
            for (const Encoder of [AnimatedGifEncoder, ApngEncoder])
                assert.throws(() => new Encoder(2, 1, { loopCount: -1 }), { code: 'INPUT' });
        });

        test('a one-frame APNG is a plain PNG; two frames animate', async () => {
            // ffmpeg's reader loops an acTL of one frame endlessly; every reader shows a PNG still.
            const apng = async frames => {
                const encoder = new ApngEncoder(2, 1);
                for (let index = 0; index < frames; index++)
                    await encoder.addFrame(
                        frame(Uint8Array.of(255, 20, 10, 255, 3, 70, 230 - index, 255)),
                        100,
                    );
                return encoder.encode();
            };
            const still = await apng(1);
            assert.equal(ascii(still, 'PNG'), 1);
            assert.equal(ascii(still, 'acTL'), -1);
            assert(ascii(still, 'IDAT') > 0 && ascii(still, 'IEND') > 0);
            assert(ascii(await apng(2), 'acTL') > 0);
        });

        test('frames of another size fail with INPUT', async () => {
            const wrong = { data: new Uint8Array(4), width: 1, height: 1 };
            await assert.rejects(new AnimatedGifEncoder(2, 1).addFrame(wrong, 100), {
                code: 'INPUT',
            });
            await assert.rejects(new ApngEncoder(2, 1).addFrame(wrong, 100), { code: 'INPUT' });
            await assert.rejects(new AnimatedWebpEncoder(2, 1).addFrame(wrong, 100), {
                code: 'INPUT',
            });
        });

        test('animated WebP is supported where the host has OffscreenCanvas', async () => {
            assert.equal(
                await AnimatedWebpEncoder.supported(),
                typeof OffscreenCanvas === 'function',
            );
        });

        test('animated WebP frames fail with ENCODE without a canvas', async () => {
            const encoder = new AnimatedWebpEncoder(16, 12);
            const picture = { data: new Uint8ClampedArray(16 * 12 * 4), width: 16, height: 12 };
            await assert.rejects(encoder.addFrame(picture, 100), { code: 'ENCODE' });
        });

        test('a one-frame animated WebP is the still the host encoded', async () => {
            // ffmpeg reads no animated WebP, and every reader shows a still. Two frames animate.
            const stillWebp = FIXTURES['still-lossless.webp'].bytes();
            await withGlobals(
                { OffscreenCanvas: fakeCanvas(stillWebp), ImageData: FakeImageData },
                async () => {
                    const webpOf = async frames => {
                        const animated = new AnimatedWebpEncoder(16, 12);
                        const picture = {
                            data: new Uint8ClampedArray(16 * 12 * 4),
                            width: 16,
                            height: 12,
                        };
                        for (let index = 0; index < frames; index++)
                            await animated.addFrame(picture, 100);
                        return animated.encode();
                    };
                    const single = await webpOf(1);
                    assert.equal(ascii(single, 'ANIM'), -1);
                    assert.deepEqual(single, stillWebp);
                    assert(ascii(await webpOf(2), 'ANIM') > 0);
                },
            );
        });
    });

    describe('decoders', () => {
        test('VP8L decodes bit for bit as ffmpeg does', () => {
            const still = FIXTURES['still-lossless.webp'].bytes();
            const at = ascii(still, 'VP8L');
            const size = still[at + 4] | (still[at + 5] << 8) | (still[at + 6] << 16);
            const image = decodeVp8l(still.subarray(at + 8, at + 8 + size));
            assert.deepEqual([image.width, image.height], [16, 12]);
            assert.deepEqual([...image.data], [...STILL_LOSSLESS_RGBA.bytes()]);
        });

        test('an animated WebP decodes to its three frames of 200 ms', async () => {
            const animation = await decodeAnimatedWebp(FIXTURES['anim-lossless.webp'].bytes());
            assert.deepEqual(
                animation.frames.map(frame => [frame.delayMs, frame.data.length]),
                [0, 1, 2].map(() => [200, 16 * 12 * 4]),
            );
            assert.notEqual(md5(animation.frames[0].data), md5(animation.frames[2].data));
        });

        test('an animation over its pixel limit fails; a still is one frame', async () => {
            const bytes = FIXTURES['anim-lossless.webp'].bytes();
            // OOM, as every size limit (maxSamples, maxPacketBytes, maxBytes) fails.
            await assert.rejects(decodeAnimatedWebp(bytes, { maxTotalPixels: 16 * 12 * 2 }), {
                code: 'OOM',
                hint: 'Use at most 2 frames at 16×12.',
            });
            await assert.rejects(decodeAnimatedWebp(bytes, { maxTotalPixels: -1 }), {
                code: 'INPUT',
            });
            await assert.rejects(decodeAnimatedWebp(bytes, { signal: AbortSignal.abort() }), {
                code: 'ABORT',
            });
            const still = await decodeAnimatedWebp(FIXTURES['still-lossless.webp'].bytes());
            assert.deepEqual([still.frames.length, still.loopCount], [1, 1]);
            assert.deepEqual([...still.frames[0].data], [...STILL_LOSSLESS_RGBA.bytes()]);
            const decoded = await decodeStillWebp(FIXTURES['still-lossless.webp'].bytes());
            assert.deepEqual([...decoded.data], [...STILL_LOSSLESS_RGBA.bytes()]);
        });

        describe('TIFF without the host', () => {
            const [width, height] = [19, 11];
            const pattern = (samples, bits) =>
                Array.from({ length: width * height * samples }, (_, index) => {
                    const value =
                        (index * 37 + Math.floor(index / 7) * 11) % (1 << Math.min(bits, 8));
                    return bits === 16 ? Math.min(65535, value * 257 + (index % 3)) : value;
                });
            /** The RGBA a picture of `values` shows: 16-bit samples rounded to 8, gray spread. */
            const expected = (values, samples, bits) => {
                const rgba = new Uint8ClampedArray(width * height * 4);
                for (let pixel = 0; pixel < width * height; pixel++) {
                    const sample = part => {
                        const value = values[pixel * samples + part];
                        return bits === 16 ? Math.round(value / 257) : value;
                    };
                    const color =
                        samples > 2 ? [0, 1, 2].map(sample) : [sample(0), sample(0), sample(0)];
                    rgba.set(
                        [...color, samples === 2 || samples === 4 ? sample(samples - 1) : 255],
                        pixel * 4,
                    );
                }
                return rgba;
            };

            for (const samples of [1, 2, 3, 4])
                for (const bits of [8, 16])
                    test(`${samples} samples of ${bits} bits in every compression`, async () => {
                        // Strips and tiles, chunky and planar, with and without the predictor,
                        // either byte order.
                        for (const compression of [1, 5, 8, 32773])
                            for (const [layout, predictor, little] of [
                                ['strips', 1, true],
                                ['tiles', 2, false],
                                ['planar', 2, true],
                                ['strips', 2, false],
                            ]) {
                                const values = pattern(samples, bits);
                                const picture = await decodeTiff(
                                    tiff({
                                        width,
                                        height,
                                        samples,
                                        values,
                                        bits,
                                        compression,
                                        predictor,
                                        little,
                                        rows: 4,
                                        ...(layout === 'tiles' ? { tile: [16, 16] } : {}),
                                        planar: layout === 'planar',
                                        ...(samples % 2 === 0 ? { extra: 2 } : {}),
                                    }),
                                );
                                const name = `compression ${compression} ${layout}`;
                                assert.deepEqual(
                                    [picture.width, picture.height],
                                    [width, height],
                                    name,
                                );
                                assert.deepEqual(
                                    picture.data,
                                    expected(values, samples, bits),
                                    name,
                                );
                            }
                    });

            for (const bits of [4, 8])
                test(`${bits}-bit palette pictures take their 16-bit colours`, async () => {
                    const colors = 1 << bits;
                    const palette = Array.from(
                        { length: 3 * colors },
                        (_, index) => (index * 4099) % 65536,
                    );
                    const values = Array.from(
                        { length: width * height },
                        (_, index) => (index * 7) % colors,
                    );
                    const picture = await decodeTiff(
                        tiff({
                            width,
                            height,
                            samples: 1,
                            values,
                            bits,
                            photometric: 3,
                            palette,
                            compression: 5,
                        }),
                    );
                    for (let pixel = 0; pixel < width * height; pixel++)
                        assert.deepEqual(
                            [...picture.data.subarray(pixel * 4, pixel * 4 + 4)],
                            [0, 1, 2]
                                .map(part => palette[part * colors + values[pixel]] >> 8)
                                .concat(255),
                        );
                });

            test('bilevel pictures read both WhiteIsZero and BlackIsZero', async () => {
                const bilevel = Array.from({ length: width * height }, (_, index) =>
                    (index * 5) % 3 === 0 ? 1 : 0,
                );
                for (const photometric of [0, 1]) {
                    const picture = await decodeTiff(
                        tiff({
                            width,
                            height,
                            samples: 1,
                            values: bilevel,
                            bits: 1,
                            photometric,
                            compression: 32773,
                        }),
                    );
                    for (let pixel = 0; pixel < width * height; pixel++)
                        assert.equal(
                            picture.data[pixel * 4],
                            (photometric === 0 ? 1 - bilevel[pixel] : bilevel[pixel]) * 255,
                        );
                }
            });

            test('8-bit WhiteIsZero gray is inverted', async () => {
                const picture = await decodeTiff(
                    tiff({ width, height, samples: 1, values: pattern(1, 8), photometric: 0 }),
                );
                assert.equal(picture.data[4], 255 - pattern(1, 8)[1]);
            });

            test('premultiplied alpha is divided out', async () => {
                const picture = await decodeTiff(
                    tiff({ width: 1, height: 1, samples: 4, values: [50, 100, 0, 200], extra: 1 }),
                );
                assert.deepEqual([...picture.data], [64, 128, 0, 200]);
            });

            test('JPEG compression is left to the host', async () => {
                const jpeg = tiff({ width, height, samples: 3, values: pattern(3, 8) });
                const view = new DataView(jpeg.buffer);
                const ifd = view.getUint32(4, true);
                for (let entry = 0; entry < view.getUint16(ifd, true); entry++)
                    if (view.getUint16(ifd + 2 + entry * 12, true) === 259)
                        view.setUint16(ifd + 2 + entry * 12 + 8, 7, true);
                assert.equal(await decodeTiff(jpeg), undefined);
            });
        });
    });

    describe('resizing', () => {
        test('shrinking averages the whole source area under each pixel', () => {
            // One white column in four becomes a quarter grey, not the black or white of point
            // sampling.
            const stripes = new Uint8ClampedArray(64 * 8 * 4);
            for (let index = 0; index < 64 * 8; index++) {
                stripes.fill(index % 4 === 0 ? 255 : 0, index * 4, index * 4 + 3);
                stripes[index * 4 + 3] = 255;
            }
            for (const method of ['bilinear', 'lanczos3']) {
                const small = new RgbaResizer(64, 8, 16, 2, method).resize(stripes);
                // Away from the edges, where the window is cut off.
                for (let column = 2; column < 14; column++) {
                    assert(
                        Math.abs(small[column * 4] - 64) <= 2,
                        `${method} at ${column}: ${small[column * 4]}`,
                    );
                    assert.equal(small[column * 4 + 3], 255);
                }
            }
        });

        test('enlarging interpolates between two samples', () => {
            const ramp = Uint8ClampedArray.of(0, 0, 0, 255, 200, 200, 200, 255);
            const wide = new RgbaResizer(2, 1, 4, 1, 'bilinear').resize(ramp);
            assert.deepEqual(
                [...wide].filter((_, index) => index % 4 === 0),
                [0, 50, 150, 200],
            );
        });
    });

    // OOM, as every size limit (maxSamples, maxPacketBytes, the animation limit) fails.
    describe('size limits', () => {
        /** The head of a TIFF that declares `width`×`height` and holds nothing more. */
        const tiffHead = (width, height) => {
            const bytes = new Uint8Array(8 + 2 + 2 * 12 + 4);
            const view = new DataView(bytes.buffer);
            bytes.set([0x49, 0x49, 0x2a, 0]);
            view.setUint32(4, 8, true);
            view.setUint16(8, 2, true);
            for (const [index, [tag, value]] of [
                [256, width],
                [257, height],
            ].entries()) {
                view.setUint16(10 + index * 12, tag, true);
                view.setUint16(12 + index * 12, 4, true);
                view.setUint32(14 + index * 12, 1, true);
                view.setUint32(18 + index * 12, value, true);
            }
            return bytes;
        };
        const hint = 'Keep it within 8192×4320 pixels.';

        test('the encoders refuse a picture of more than 8192×4320 pixels', async () => {
            const huge = { data: new Uint8Array(4), width: 8193, height: 4320 };
            for (const encode of [
                encodePng,
                encodeBmp,
                encodeTiff,
                encodeIco,
                encodeJpeg,
                encodeWebP,
            ])
                await assert.rejects(encode(huge), { code: 'OOM', hint });
        });

        test('a resize to more than 8192×4320 pixels fails; a side past 16384 is FORMAT', () => {
            assert.throws(() => new RgbaResizer(16, 16, 8193, 4320), { code: 'OOM', hint });
            assert.doesNotThrow(() => new RgbaResizer(16, 16, 8192, 4320));
            assert.throws(() => new RgbaResizer(16, 16, 16385, 1), { code: 'FORMAT' });
        });

        test('a TIFF of more than 8192×4320 pixels is refused before it is read', async () => {
            await assert.rejects(decodeTiff(tiffHead(8193, 4320)), { code: 'OOM', hint });
            await assert.rejects(
                new MediaForge().convert(new Blob([tiffHead(8193, 4320)]), 'png'),
                {
                    code: 'OOM',
                },
            );
        });

        test('an image output sized past 8192×4320 pixels fails with OOM', async () => {
            // The lossless WebP decodes without the host; one side keeps its 4:3 shape.
            const still = new Blob([FIXTURES['still-lossless.webp'].bytes()]);
            await assert.rejects(
                new MediaForge().convert(still, 'png', { video: { width: 16000 } }),
                { code: 'OOM', message: /16000×12000/ },
            );
        });
    });

    describe('conversions', () => {
        const forge = new MediaForge();

        test('an animated WebP converts to a GIF of three frames', async () => {
            const { blob } = await forge.convert(
                new Blob([FIXTURES['anim-lossless.webp'].bytes()]),
                { to: 'gif' },
            );
            assert.equal(blob.type, 'image/gif');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let controls = 0;
            for (let index = 0; index + 3 < bytes.length; index++)
                if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 4)
                    controls++;
            assert.equal(controls, 3);
        });

        test('a still WebP converts to PNG', async () => {
            const { blob } = await forge.convert(
                new Blob([FIXTURES['still-lossless.webp'].bytes()]),
                { to: 'png' },
            );
            assert.equal(blob.type, 'image/png');
        });

        for (const [name, input, options, code] of [
            ['partial alpha', () => twoFrameApng(0, 100), {}, 'ALPHA_REDUCED'],
            ['70000 loops', () => twoFrameApng(70000, 255), {}, 'LOOP_COUNT_REDUCED'],
            ['120 fps', () => twoFrameApng(0, 255), { video: { fps: 120 } }, 'OPTION_NORMALIZED'],
        ])
            test(`GIF output takes ${name} with ${code}; strict refuses`, async () => {
                // GIF alpha is on or off, it loops at most 65536 times and plays at most 100 fps.
                const apng = await input();
                const result = await forge.convert(apng, { to: 'gif', ...options });
                assert.deepEqual(
                    result.warnings.map(warning => warning.code),
                    [code],
                );
                assert.equal(result.blob.type, 'image/gif');
                await assert.rejects(
                    forge.convert(apng, { to: 'gif', ...options, open: { validation: 'strict' } }),
                    {
                        code: 'FORMAT',
                    },
                );
            });

        for (const [file, to, code, pattern] of [
            ['still.avif', 'png', 'DECODE', /ImageDecoder/],
            ['still.jxl', 'png', 'DECODE', /ImageDecoder/],
            ['still-lossless.webp', 'avif', 'ENCODE', /AVIF pictures need OffscreenCanvas/],
            ['anim-lossless.webp', 'webp', 'ENCODE', /Animated WebP output needs the host/],
        ])
            test(`${file} to ${to} without the host fails with ${code} naming it`, async () => {
                await assert.rejects(
                    forge.convert(new Blob([FIXTURES[file].bytes()]), { to }),
                    error => {
                        assert.equal(error.code, code);
                        assert.match(error.message, pattern);
                        return true;
                    },
                );
            });
    });
});
