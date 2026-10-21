import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPicture, createVideoStages, frameRate } from 'mediaforgejs/parts';
import { distUrl } from '../helpers/dist-paths.mjs';

const { frameRateStage } = await import(distUrl('esm/stages/video.js'));

const INFO = { width: 1, height: 1 };

/** A 1 × 1 picture whose red value names it. */
const picture = (name, timestamp, duration = 0.04, keyframe = false) =>
    createPicture({
        data: Uint8Array.of(name, 0, 0, 255),
        width: 1,
        height: 1,
        timestamp,
        duration,
        keyframe,
    });

/** What `stages` show for `pictures`: [name, slot timestamp in µs, keyframe] each. */
async function shown(stages, pictures, info = INFO) {
    const chain = createVideoStages(stages, info);
    const output = [];
    try {
        for (const input of pictures) output.push(...(await chain.push(input)));
        output.push(...(await chain.flush()));
        const result = [];
        for (const item of output) {
            result.push([(await item.rgba())[0], Math.round(item.timestamp * 1e6), item.keyframe]);
            item.close();
        }
        return result;
    } finally {
        chain.close();
    }
}

const names = rows => rows.map(([name]) => name);

describe('stages', () => {
    describe('frame rate', () => {
        test('a lower source rate repeats each picture on the slots it covers', async () => {
            const input = [0, 1, 2].map(k => picture(k, k / 10, 0.1));
            const rows = await shown([frameRate(30)], input);
            assert.deepEqual(names(rows), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
            assert.deepEqual(
                rows.map(([, at]) => at),
                [0, 33333, 66667, 100000, 133333, 166667, 200000, 233333, 266667],
            );
        });

        test('a higher source rate drops pictures; a slot shows the latest begun', async () => {
            const input = [0, 1, 2, 3, 4, 5].map(k => picture(k, k / 30, 1 / 30));
            assert.deepEqual(names(await shown([frameRate(10)], input)), [0, 3, 5]);
        });

        test('a picture less than a quarter slot late still takes its slot', async () => {
            const input = [picture(0, 0, 0.1), picture(1, 0.12, 0.1), picture(2, 0.23, 0.1)];
            assert.deepEqual(names(await shown([frameRate(10)], input)), [0, 1, 1, 2]);
        });

        test('the grid starts at the first picture', async () => {
            const rows = await shown([frameRate(10)], [picture(0, 5, 0.1), picture(1, 5.1, 0.1)]);
            assert.deepEqual(
                rows.map(([, at]) => at),
                [5000000, 5100000],
            );
        });

        test('a keyframe request goes with the first slot of its picture', async () => {
            const input = [picture(0, 0, 0.1, true), picture(1, 0.1, 0.1, true)];
            assert.deepEqual(
                (await shown([frameRate(20)], input)).map(([, , keyframe]) => keyframe),
                [true, false, true, false],
            );
        });

        test('an end ends the slots there', async () => {
            const input = [picture(0, 0, 0.1)];
            assert.equal((await shown([frameRateStage(10, 0.45)], input)).length, 5);
            assert.equal((await shown([frameRateStage(10)], input)).length, 1);
        });

        test('the stream it emits has its rate', () => {
            const chain = createVideoStages([frameRate(24)], { ...INFO, fps: 30 });
            assert.equal(chain.output.fps, 24);
            chain.close();
        });

        test('a rate that is not positive fails with INPUT', () => {
            for (const fps of [0, -1, Number.NaN])
                assert.throws(() => frameRate(fps), { code: 'INPUT' });
        });
    });
});
