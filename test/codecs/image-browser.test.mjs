import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert } from 'mediaforgejs';
import {
    AnimatedWebpEncoder,
    decodeAnimatedWebp,
    encodeBmp,
    encodeIco,
    encodeJpeg,
    encodePng,
    encodeTiff,
    encodeWebP,
} from 'mediaforgejs/codecs';

// The image encoders where the host canvas encodes JPEG, WebP and opaque PNG, in a real browser
// (npm run test:browser): the picture in, the file out, as the browser reads it back.

const inBrowser = typeof document !== 'undefined';

/** A 48x32 picture: a red left half, a blue right half, `alpha` throughout. */
function halves(alpha = 255) {
    const data = new Uint8ClampedArray(48 * 32 * 4);
    for (let index = 0; index < 48 * 32; index++) {
        const left = index % 48 < 24;
        data.set([left ? 220 : 10, 20, left ? 10 : 220, alpha], index * 4);
    }
    return { data, width: 48, height: 32 };
}

/** The pixels the browser decodes from `bytes` of `type`. */
async function decoded(bytes, type) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** The largest and the mean difference of the channels of two RGBA pictures of one size. */
function differences(a, b) {
    let largest = 0;
    let sum = 0;
    for (let index = 0; index < a.length; index++) {
        const difference = Math.abs(a[index] - b[index]);
        largest = Math.max(largest, difference);
        sum += difference;
    }
    return { largest, mean: sum / a.length };
}

describe(
    'image encoders on a host canvas',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        // Lossless files read back exactly; the lossy ones within a few levels on average (their
        // largest error is at the sharp edge between the halves).
        for (const [name, encode, type, tolerance] of [
            ['PNG', encodePng, 'image/png', 0],
            ['JPEG', encodeJpeg, 'image/jpeg', 4],
            ['WebP', encodeWebP, 'image/webp', 4],
            ['BMP', encodeBmp, 'image/bmp', 0],
            ['TIFF', encodeTiff, 'image/tiff', -1],
        ])
            test(`${name} of a picture reads back as the picture`, async () => {
                const picture = halves();
                const bytes = await encode(picture, { quality: 0.95 });
                assert(bytes instanceof Uint8Array);
                if (tolerance < 0) return; // Chromium decodes no TIFF.
                const back = await decoded(bytes, type);
                assert.deepEqual([back.width, back.height], [48, 32]);
                const { largest, mean } = differences(back.data, picture.data);
                assert(tolerance ? mean <= tolerance : largest === 0, `${name}: ${mean}`);
            });

        test('a translucent PNG keeps its exact pixels', async () => {
            const picture = halves(100);
            const png = await encodePng(picture);
            const back = await decoded(png, 'image/png');
            // The browser's readback premultiplies; the file itself holds the exact values.
            assert(differences(back.data, picture.data).largest <= 2);
        });

        test('ICO holds a PNG of the picture scaled to at most 256', async () => {
            const data = new Uint8ClampedArray(640 * 320 * 4).fill(255);
            const icon = await encodeIco({ data, width: 640, height: 320 });
            assert.deepEqual([icon[6], icon[7]], [0, 128]);
            const png = icon.subarray(new DataView(icon.buffer).getUint32(18, true));
            const back = await decoded(png, 'image/png');
            assert.deepEqual([back.width, back.height], [256, 128]);
        });

        test('an animated WebP of two frames reads back as both', async () => {
            const encoder = new AnimatedWebpEncoder(48, 32, { loopCount: 2, quality: 0.9 });
            await encoder.addFrame(halves(), 100);
            const flipped = halves();
            flipped.data.reverse();
            await encoder.addFrame(flipped, 150);
            const animation = await decodeAnimatedWebp(await encoder.encode());
            assert.deepEqual(
                [animation.loopCount, animation.frames.map(frame => frame.delayMs)],
                [2, [100, 150]],
            );
        });

        for (const to of ['jpeg', 'webp', 'bmp', 'ico'])
            test(`a PNG converts to ${to} through the canvas`, async () => {
                const png = await encodePng(halves());
                const { blob } = await convert(new Blob([png], { type: 'image/png' }), { to });
                const type = {
                    jpeg: 'image/jpeg',
                    webp: 'image/webp',
                    bmp: 'image/bmp',
                    ico: 'image/x-icon',
                }[to];
                assert.equal(blob.type, type);
                assert(blob.size > 0);
            });
    },
);
