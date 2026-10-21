import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { hostVp8, patternClip } from '../helpers/pattern-clip.mjs';
import { PATTERN, maskedDifference, transformedPattern } from '../helpers/pattern.mjs';

// Pictures of video with the browser's VideoDecoder and canvas (npm run test:browser): frames()
// and thumbnail() against the pattern oracle, times on a clock that starts late, and what an
// image cannot hold.

const inBrowser = typeof document !== 'undefined';
const codes = result => result.warnings.map(warning => warning.code);

/** The RGBA of an image Blob, drawn on a canvas. */
async function imageRgba(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.buffer) };
}

describe(
    'pipeline/frames',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        const forge = new MediaForge();
        const strict = new MediaForge({ optionPolicy: 'strict' });
        let source;
        /** The pattern clip, or undefined after skipping `t` where the browser cannot make it. */
        const clip = async t => {
            if (!(await hostVp8())) {
                t.skip('the browser has no VP8 encoder, decoder or OffscreenCanvas');
                return undefined;
            }
            return (source ??= await patternClip());
        };

        test('turned, sized frames match the oracle and the PNG thumbnail', async t => {
            const input = await clip(t);
            if (!input) return;
            const settings = { rotate: 90, width: 120, height: 160 };
            const frames = [];
            for await (const frame of forge.frames(input, { times: [0.35, 0.05], ...settings }))
                frames.push(frame);
            assert.deepEqual(
                frames.map(frame => Math.round(frame.timestamp * 10)),
                [3, 0],
            );
            for (const frame of frames) {
                const expected = transformedPattern({ ...settings, fit: 'fill' });
                const difference = maskedDifference(frame.data, expected.rgba, expected.mask);
                assert.ok(difference < 8, `differs from the oracle by ${difference.toFixed(2)}`);
            }
            const png = await forge.thumbnail(input, { time: 0.35, to: 'png', ...settings });
            const drawn = await imageRgba(png.blob);
            assert.deepEqual([drawn.width, drawn.height], [120, 160]);
            assert.deepEqual(drawn.data, frames[0].data);
        });

        test('a JPEG thumbnail is drawn by the canvas encoder', async t => {
            const input = await clip(t);
            if (!input) return;
            const { blob } = await forge.thumbnail(input, { to: 'jpeg', quality: 0.8 });
            assert.equal(blob.type, 'image/jpeg');
            const drawn = await imageRgba(blob);
            assert.deepEqual([drawn.width, drawn.height], [PATTERN.width, PATTERN.height]);
        });

        test('times count from the start of a clip whose clock starts late', async t => {
            if (!(await clip(t))) return;
            // An MPEG-TS recording keeps such a clock. VideoFrame timestamps count from the start
            // too.
            const late = await patternClip({ start: 100 });
            const times = [];
            for await (const frame of forge.frames(late, {
                format: 'videoframe',
                times: [0.35, 0.05],
            })) {
                times.push(frame.timestamp);
                frame.close();
            }
            assert.deepEqual(times, [300000, 0]);
            const rgba = [];
            for await (const frame of forge.frames(late, { times: [0.35] })) rgba.push(frame);
            assert.equal(Math.round(rgba[0].timestamp * 10), 3);
            const drawn = await imageRgba((await forge.thumbnail(late, { time: 0.35 })).blob);
            assert.deepEqual(drawn.data, rgba[0].data);
        });

        test('HDR becomes SDR with HDR_TO_SDR; strict validation refuses it', async t => {
            if (!(await clip(t))) return;
            const pq = { primaries: 9, transfer: 16, matrix: 9, fullRange: false };
            const hdr = await patternClip({ colour: pq, frames: 5 });
            const thumbnail = await forge.thumbnail(hdr, { time: 0, to: 'png' });
            assert.ok(codes(thumbnail).includes('HDR_TO_SDR'), `${codes(thumbnail)}`);
            await assert.rejects(
                strict.thumbnail(hdr, { time: 0, to: 'png' }),
                error => error.code === 'FORMAT',
            );
        });

        test('transparency turns white in a JPEG with ALPHA_DROPPED; strict refuses', async () => {
            const canvas = new OffscreenCanvas(4, 2);
            const context = canvas.getContext('2d');
            context.fillStyle = '#f00';
            context.fillRect(0, 0, 2, 2);
            const png = await canvas.convertToBlob({ type: 'image/png' });
            const jpeg = await forge.convert(png, 'jpeg');
            assert.ok(codes(jpeg).includes('ALPHA_DROPPED'), `${codes(jpeg)}`);
            const drawn = await imageRgba(jpeg.blob);
            const corner = drawn.data.subarray((1 * 4 + 3) * 4, (1 * 4 + 3) * 4 + 3);
            assert.ok(Math.min(...corner) > 235, `transparency became ${[...corner]}`);
            await assert.rejects(strict.convert(png, 'jpeg'), error => error.code === 'FORMAT');
        });
    },
);
