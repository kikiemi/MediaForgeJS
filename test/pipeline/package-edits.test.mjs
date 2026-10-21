import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packageMedia } from 'mediaforgejs';
import { reorderedMp4 } from '../helpers/reordered-video.mjs';
import { assertSameTimes, laterEdit, opusMp4, presented } from '../helpers/mp4-edits.mjs';

// HLS and DASH packages of MP4 inputs whose own edit list hides their first samples: the package
// starts where the input's presentation starts, and what the edit hid stays hidden, as in a
// fragmented MP4 copy.

/** The init segment and media segments of an HLS package of `input`, as one fragmented MP4. */
async function packaged(input) {
    const { files } = await packageMedia(input, 'hls', { targetDuration: 1 });
    const parts = [...files.values()];
    return new Blob([
        parts.find(file => file.kind === 'init').data,
        ...parts.filter(file => file.kind === 'segment').map(file => file.data),
    ]);
}

describe('packages of MP4 inputs whose edit list hides their start', () => {
    test("pictures the input's edit hid stay before zero, as in the input", async () => {
        const input = await laterEdit(await reorderedMp4(), 0.5);
        const { times } = await presented(input);
        assert.equal(times.filter(time => time < -1e-6).length, 5, 'five pictures hidden');
        assertSameTimes((await presented(await packaged(input))).times, times);
    });

    test('an Opus track whose edit starts past its pre-skip plays from that edit', async () => {
        const input = await laterEdit(await opusMp4(), 0.25);
        const source = await presented(input);
        const output = await presented(await packaged(input));
        assertSameTimes(output.times, source.times);
        assert.ok(Math.abs(output.duration - 0.25) < 0.001, `duration ${output.duration}`);
    });
});
