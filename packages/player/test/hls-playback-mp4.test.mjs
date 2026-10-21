import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CmafWriter } from 'mediaforgejs/streaming';
// The package's reading of fMP4 units for MediaSource, which it does not export.
import {
    hlsPlaybackBytes,
    hlsPlaybackTiming,
    hlsPlaybackTracks,
} from '../dist/hls-playback-mp4.js';

// How HLS playback reads the tracks and the presentation of fMP4 units before it appends them.

describe('HLS playback: fMP4 timing', () => {
    test('a single forward edit (an Opus pre-skip) starts the presentation before zero', () => {
        // dOps: version 0, two channels, pre-skip 312, 48 kHz input, no gain, mapping family 0.
        const dops = Uint8Array.of(0, 2, 312 >> 8, 312 & 255, 0, 0, 0xbb, 0x80, 0, 0, 0);
        const writer = new CmafWriter({
            tracks: [
                {
                    id: 1,
                    type: 'audio',
                    codec: 'opus',
                    timescale: 48000,
                    sampleRate: 48000,
                    channelCount: 2,
                    codecConfig: dops,
                },
            ],
        });
        const tracks = hlsPlaybackTracks(writer.createInitSegment());
        assert.equal(tracks.get(1).editOffset, 312);
        for (let index = 0; index < 4; index++)
            writer.addSample({
                trackId: 1,
                data: Uint8Array.of(0x78, 0, 0),
                decodeTimestamp: index * 960,
                duration: 960,
                isKeyframe: true,
            });
        const timing = hlsPlaybackTiming(writer.flush().data, tracks);
        assert.equal(Math.round(timing.start * 48000), -312, 'the pre-skip is presented first');
        assert.equal(Math.round(timing.end * 48000), 4 * 960 - 312);
    });

    test('a unit is refused as mediaforgejs refuses an input', () => {
        // Bytes of another type (INPUT), a cut box (DEMUX), a second audio track (FORMAT) and more
        // boxes than a unit is inspected for (OOM).
        const opus = id => ({
            id,
            type: 'audio',
            codec: 'opus',
            timescale: 48000,
            sampleRate: 48000,
            channelCount: 2,
            codecConfig: Uint8Array.of(0, 2, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 0),
        });
        const init = new CmafWriter({ tracks: [opus(1)] }).createInitSegment();
        assert.throws(() => hlsPlaybackBytes([1, 2]), { code: 'INPUT' });
        assert.throws(() => hlsPlaybackTracks(init.subarray(0, init.length - 1)), {
            code: 'DEMUX',
        });
        assert.throws(
            () =>
                hlsPlaybackTracks(
                    new CmafWriter({ tracks: [opus(1), opus(2)] }).createInitSegment(),
                ),
            { code: 'FORMAT', message: /one video and one audio track/ },
        );
        const boxes = new Uint8Array(8 * 10001);
        for (let at = 0; at < boxes.length; at += 8)
            boxes.set([0, 0, 0, 8, 102, 114, 101, 101], at);
        assert.throws(() => hlsPlaybackTiming(boxes, hlsPlaybackTracks(init)), {
            code: 'OOM',
            message: /10000 boxes/,
        });
    });
});
