import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { editingFixture } from '../helpers/editing-fixtures.mjs';

// Animations and contact sheets of video, decoded by the library's decoders.

const clip = editingFixture('clip-m4v.mp4');
const forge = new MediaForge({ onWarning: () => {} });

describe('pipeline/frames: animations', () => {
    test('a GIF of half a second at 5 fps holds three pictures of the size asked', async () => {
        const { blob } = await forge.convert(clip, {
            to: 'gif',
            start: 1,
            end: 1.5,
            video: { fps: 5, width: 32, height: 24 },
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
        assert.deepEqual([bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8)], [32, 24]);
        let images = 0;
        // An image descriptor after a graphic control extension.
        for (let at = 8; at < bytes.length; at++)
            if (bytes[at] === 0x2c && bytes[at - 8] === 0x21 && bytes[at - 7] === 0xf9) images++;
        assert.equal(images, 3);
    });

    test('an APNG of 0.4 s at 10 fps holds four pictures', async () => {
        const { blob } = await forge.convert(clip, { to: 'apng', end: 0.4, video: { fps: 10 } });
        const png = new Uint8Array(await blob.arrayBuffer());
        assert.equal(String.fromCharCode(...png.subarray(37, 41)), 'acTL');
        assert.equal(new DataView(png.buffer).getUint32(41), 4);
    });

    test('an animation of a backwards range fails with INPUT', async () => {
        await assert.rejects(
            forge.convert(clip, { to: 'gif', start: 1, end: 0.5 }),
            error => error.code === 'INPUT',
        );
    });
});

describe('pipeline/frames: contact sheets', () => {
    const pictures = async options => {
        const frames = [];
        for await (const frame of forge.frames(clip, options)) frames.push(frame);
        return frames;
    };

    test('pictures at the centres of four equal slices, at the size asked', async () => {
        const { duration } = (await forge.inspect(clip)).tracks.find(
            track => track.type === 'video',
        );
        const thumbs = await pictures({
            times: Array.from({ length: 4 }, (_, index) => ((index + 0.5) * duration) / 4),
            width: 16,
            height: 12,
        });
        assert.deepEqual(
            thumbs.map(frame => [frame.timestamp, frame.width, frame.height, frame.data.length]),
            [0.24, 0.72, 1.24, 1.72].map(time => [time, 16, 12, 16 * 12 * 4]),
        );
    });

    test('a picture every half second', async () => {
        assert.deepEqual(
            (await pictures({ every: 0.5 })).map(frame => frame.timestamp),
            [0, 0.48, 1, 1.48],
        );
    });
});
