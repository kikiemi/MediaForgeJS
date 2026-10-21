import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, open } from 'mediaforgejs';
import { FIXTURES, assertReadsAsRecorded } from '../helpers/recorded-fixtures.mjs';
import { readMedia } from '../helpers/read-media.mjs';

describe('mxf', () => {
    for (const file of ['h264.mxf', 'mpeg2.mxf', 'pcm24.mxf'])
        test(`reads ${file} as recorded: tracks, packet times, keyframes and payloads`, () =>
            assertReadsAsRecorded(file));

    test('derives an H.264 configuration from the stream and says so', async () => {
        const { tracks, warnings } = await readMedia(FIXTURES['h264.mxf'].bytes());
        assert.deepEqual(warnings, ['VIDEO_CONFIG_DERIVED']);
        assert.match(tracks[0].track.codec, /^avc1/);
        assert.ok(tracks[0].track.codecConfig.length > 0);
    });

    test('keeps the whole packets of a file cut at nine tenths, marked incomplete', async () => {
        const bytes = FIXTURES['mpeg2.mxf'].bytes();
        const part = bytes.subarray(0, Math.floor(bytes.length * 0.9));
        const { tracks, warnings } = await readMedia(part);
        assert.ok(warnings.includes('MXF_TRUNCATED'), `${warnings}`);
        assert.ok(tracks.every(entry => entry.track.incomplete));
        assert.equal(
            tracks.reduce((sum, entry) => sum + entry.packets.length, 0),
            5,
        );
        await assert.rejects(open(part, { validation: 'strict' }), error => error.code === 'DEMUX');
    });

    test('capabilities read mxf but do not write it', async () => {
        const reported = await capabilities();
        assert.ok(reported.containers.read.includes('mxf'));
        assert.ok(!reported.containers.write.includes('mxf'));
    });
});
