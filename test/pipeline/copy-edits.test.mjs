import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open } from 'mediaforgejs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { reorderedMp4 } from '../helpers/reordered-video.mjs';
import { assertSameTimes, laterEdit, opusMp4, presented } from '../helpers/mp4-edits.mjs';

// The edits a fragmented MP4 copy writes: each track's own edit presents it from its first picture
// or sound, the copy's first presented packet lands at zero, trimmed or not, and what the input's
// edit list hid stays hidden.

/** The presentation times of the video packets of `blob`, in milliseconds, in decode order. */
async function shownMilliseconds(blob) {
    const media = await open(blob);
    try {
        const times = [];
        for await (const packet of media.packets()) times.push(Math.round(packet.timestamp * 1000));
        return times;
    } finally {
        media.close();
    }
}

describe('fragmented MP4 copies of reordered video', () => {
    test('a whole copy presents its first picture at zero', async () => {
        const times = await shownMilliseconds((await convert(await reorderedMp4(), 'fmp4')).blob);
        assert.equal(Math.min(...times), 0);
    });

    test('a range presents its first keyframe at zero, not a reorder delay later', async () => {
        const { blob } = await convert(await reorderedMp4(), { to: 'fmp4', start: 1.05, end: 2 });
        const times = await shownMilliseconds(blob);
        assert.equal(Math.min(...times), 0);
        assert.deepEqual(
            [...times].sort((a, b) => a - b).slice(0, 3),
            [0, 100, 200],
            'the pictures from the keyframe at 1 s, one every 100 ms',
        );
    });

    test("pictures the input's edit hid stay before zero, as in the input", async () => {
        const input = await laterEdit(await reorderedMp4(), 0.5);
        const { times } = await presented(input);
        assertSameTimes((await presented((await convert(input, 'fmp4')).blob)).times, times);
    });
});

describe('fragmented MP4 copies of AAC', () => {
    // 48 frames of 1024 samples at 48 kHz: 1024 samples of priming, then one second presented.
    const primed = () =>
        new Blob([
            classicMp4({
                timescale: 48000,
                movieTimescale: 1000,
                sampleRate: 48000,
                count: 48,
                timing: [[48, 1024]],
                edits: [[1000, 1024]],
            }).bytes,
        ]);

    test("a whole copy keeps the input's edit, priming and presented length", async () => {
        const { blob, warnings } = await convert(primed(), 'fmp4');
        assert.deepEqual(warnings, []);
        const { times, duration } = await presented(blob);
        assert.ok(Math.abs(times[0] + 1024 / 48000) < 1e-6, `first at ${times[0]} s`);
        assert.equal(duration, 1);
    });

    test("a range lasts as long as the range, not as the input's edit", async () => {
        const { blob } = await convert(primed(), { to: 'fmp4', start: 0.5, end: 0.75 });
        const { duration } = await presented(blob);
        // Whole frames: up to one more at either end.
        assert.ok(duration > 0.25 - 1e-6 && duration < 0.25 + 2048 / 48000, `duration ${duration}`);
    });
});

describe('fragmented MP4 copies of Opus', () => {
    test('a track whose MP4 edit starts past its pre-skip presents from that edit', async () => {
        const input = await laterEdit(await opusMp4(), 0.25);
        const source = await presented(input);
        const { blob, warnings } = await convert(input, 'fmp4');
        const output = await presented(blob);
        assertSameTimes(output.times, source.times);
        assert.ok(Math.abs(output.duration - 0.25) < 0.001, `duration ${output.duration}`);
        assert.deepEqual(
            warnings.map(warning => warning.code),
            [],
            'the pre-skip keeps the window',
        );
    });

    test('a track whose edit starts at its pre-skip is copied without a warning', async () => {
        const { warnings } = await convert(await opusMp4(), 'fmp4');
        assert.deepEqual(
            warnings.map(warning => warning.code),
            [],
        );
    });
});
