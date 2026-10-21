import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { parseImageInfo } from 'mediaforgejs/codecs';
import { FIXTURES, auxiliaryPictures, gainMapPictures } from '../helpers/new-format-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { riffChunk, webpFile } = await import(distUrl('esm/core/codec-config/image-info.js'));
const { jpegGainMap, jpegStatesGainMap } = await import(
    distUrl('esm/core/codec-config/gain-map.js')
);

const formatOf = file => file.slice(file.lastIndexOf('.') + 1);

/** What parseImageInfo reads from each image fixture without decoding it. */
const EXPECTED = {
    'still-lossless.webp': { width: 16, height: 12, animated: false, frameCount: 1, codec: 'vp8l' },
    'still-lossy.webp': { width: 16, height: 12, animated: false, frameCount: 1, codec: 'vp8' },
    'anim-lossless.webp': {
        width: 16,
        height: 12,
        animated: true,
        frameCount: 3,
        durationMs: 600,
        loopCount: 0,
        codec: 'vp8l',
    },
    'still.avif': {
        width: 16,
        height: 12,
        animated: false,
        frameCount: 1,
        codec: 'av01.0.00M.08',
        bitDepth: 8,
    },
    'anim.avif': {
        width: 16,
        height: 12,
        animated: true,
        frameCount: 3,
        durationMs: 600,
        loopCount: 0,
        codec: 'av01.0.00M.08',
    },
    'still.jxl': {
        width: 16,
        height: 12,
        animated: false,
        frameCount: 1,
        codec: 'jxl',
        bitDepth: 8,
        hasAlpha: false,
    },
    // A 16-bit picture's header clears modular_16_bit_buffer_sufficient, one bit before the extra
    // channels that state the alpha.
    'alpha16.jxl': {
        width: 16,
        height: 12,
        animated: false,
        frameCount: 1,
        codec: 'jxl',
        bitDepth: 16,
        hasAlpha: true,
    },
};

describe('codec-config', () => {
    describe('image info', () => {
        for (const [file, expected] of Object.entries(EXPECTED))
            test(`${file}: size, frames and codec without decoding`, () => {
                const info = parseImageInfo(FIXTURES[file].bytes(), formatOf(file));
                for (const [key, value] of Object.entries(expected))
                    assert.equal(info[key], value, key);
            });

        for (const [file, expected] of Object.entries(EXPECTED))
            test(`inspect() of ${file} reports the same track`, async () => {
                const inspection = await new MediaForge().inspect(FIXTURES[file].bytes());
                const [track] = inspection.tracks;
                assert.equal(inspection.format, formatOf(file));
                assert.deepEqual(
                    [track.codec, track.width, track.sampleCount],
                    [expected.codec, 16, expected.frameCount],
                );
                if (expected.durationMs)
                    assert(Math.abs(track.duration - expected.durationMs / 1000) < 2e-3);
            });

        test('refuses a format it has no reader for with DEMUX', () => {
            assert.throws(() => parseImageInfo(new Uint8Array(16), 'png'), { code: 'DEMUX' });
        });

        test('reads a WebP written from RIFF chunks', () => {
            const still = FIXTURES['still-lossless.webp'].bytes();
            const at = Buffer.from(still).indexOf('VP8L');
            const size = still[at + 4] | (still[at + 5] << 8) | (still[at + 6] << 16);
            const rebuilt = webpFile([riffChunk('VP8L', still.subarray(at + 8, at + 8 + size))]);
            const info = parseImageInfo(rebuilt, 'webp');
            assert.deepEqual([info.width, info.height, info.codec], [16, 12, 'vp8l']);
        });

        test('AVIF and HEIF alpha is an auxiliary image of the whole alpha URN', () => {
            // Of the primary, or of the tiles of a grid primary; depth is not alpha.
            const { named, grid } = auxiliaryPictures();
            const alpha = bytes => parseImageInfo(bytes, 'avif').hasAlpha;
            assert.equal(alpha(named('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha')), true);
            assert.equal(alpha(named('urn:mpeg:hevc:2015:auxid:1')), true);
            assert.equal(alpha(named('urn:mpeg:hevc:2015:auxid:2')), false);
            assert.equal(alpha(grid), true);
        });

        test('JPEG XL fields after a preview stored in eighths are read where it ends', () => {
            // The preview height codes as U32(16, 32, 1 + u(5), 33 + u(9)).
            const bits = [];
            // Each [value, bit count] field, least significant bit first.
            const put = (...fields) => {
                for (const [value, count] of fields)
                    for (let index = 0; index < count; index++) bits.push((value >> index) & 1);
            };
            // A SizeHeader in eighths: height 16, ratio code 0, width 24.
            put([1, 1], [1, 5], [0, 3], [2, 5]);
            // ImageMetadata with extra fields: orientation 1, no intrinsic size.
            put([0, 1], [1, 1], [0, 3], [0, 1]);
            // A preview in eighths: height 16 * 8 (selector 0), width by the ratio 1:1.
            put([1, 1], [1, 1], [0, 2], [1, 3]);
            // An animation at 100 ticks a second, 5 loops, no timecodes.
            put([1, 1], [0, 2], [0, 2], [1, 2], [5, 3], [0, 1]);
            // 8-bit integer samples, 16-bit buffers suffice, one extra channel: a default (alpha).
            put([0, 1], [0, 2], [1, 1], [1, 2], [1, 1]);
            const bytes = new Uint8Array(16);
            bytes.set([0xff, 0x0a]);
            bits.forEach((bit, index) => (bytes[2 + (index >> 3)] |= bit << (index & 7)));
            const info = parseImageInfo(bytes, 'jxl');
            assert.deepEqual(
                [
                    info.width,
                    info.height,
                    info.animated,
                    info.loopCount,
                    info.bitDepth,
                    info.hasAlpha,
                ],
                [24, 16, true, 5, 8, true],
            );
        });
    });

    describe('gain maps', () => {
        const { ultraHdr, avif, heic } = gainMapPictures();

        test('an Ultra HDR JPEG states its gain map and where it is', () => {
            assert.equal(jpegStatesGainMap(ultraHdr), true);
            assert.deepEqual(jpegGainMap(ultraHdr), { width: 8, height: 4, headroom: 2.5 });
        });

        test('a JPEG without the hdrgm XMP has no gain map', () => {
            const plain = FIXTURES['still-lossless.webp'].bytes();
            assert.equal(jpegGainMap(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)), undefined);
            assert.equal(jpegStatesGainMap(plain), false);
        });

        for (const [name, bytes, gainMap] of [
            ['an Ultra HDR JPEG', ultraHdr, { width: 8, height: 4, headroom: 2.5 }],
            ['an AVIF', avif, { width: 8, height: 4, headroom: 1.5 }],
            ['an Apple HEIC', heic, { width: 8, height: 4 }],
        ]) {
            test(`inspect() reports the gain map of ${name}`, async () => {
                const [track] = (await new MediaForge().inspect(bytes)).tracks;
                assert.deepEqual([track.width, track.height, track.gainMap], [16, 8, gainMap]);
            });

            test(`strict validation refuses dropping the gain map of ${name}`, async () => {
                // Image outputs re-encode the picture without it.
                await assert.rejects(
                    new MediaForge().convert(bytes, { to: 'png', open: { validation: 'strict' } }),
                    { code: 'FORMAT', message: /gain map/ },
                );
            });
        }
    });
});
