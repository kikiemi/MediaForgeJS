import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frames, thumbnail } from 'mediaforgejs';
import { greyAvi } from '../helpers/api-fixtures.mjs';

// thumbnail() and frames() as functions: their results and progress; what pictures they show is
// tested in test/pipeline/frames.test.mjs.

describe('thumbnail() and frames()', () => {
    test('a thumbnail is a PNG named after the input', async () => {
        const poster = await thumbnail(new Blob([greyAvi()]), { time: 0 });
        assert.deepEqual([poster.mimeType, poster.filename], ['image/png', 'output.png']);
    });

    test('frames() yields RGBA pictures and reports decoding progress to 1', async () => {
        const events = [];
        const sizes = [];
        for await (const frame of frames(new Blob([greyAvi()]), {
            onProgress: event => events.push(event),
        }))
            sizes.push([frame.width, frame.height, frame.data.length]);
        assert.ok(sizes.length > 0);
        assert.ok(sizes.every(([width, height, length]) => length === width * height * 4));
        assert.equal(events.at(-1).fraction, 1);
        assert.ok(events.every(event => event.stage === 'decode'));
    });

    test('VideoFrame output without WebCodecs fails with DECODE, hinting rgba', async () => {
        await assert.rejects(
            (async () => {
                for await (const frame of frames(new Blob([greyAvi()]), { format: 'videoframe' }))
                    void frame;
            })(),
            error => error.code === 'DECODE' && /rgba/.test(error.hint),
        );
    });
});
