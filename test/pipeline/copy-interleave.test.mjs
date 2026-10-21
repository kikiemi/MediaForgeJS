import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// The interleaver and the byte holds have no public face.
import { releaseBytes, trackHolds } from '../../dist/esm/core/bytes/byte-holds.js';
import { Interleaver } from '../../dist/esm/pipeline/copy/interleave.js';

// Copied packets wait in the interleaver for an encoded lane after their reader has moved on.

describe('pipeline/copy: the interleaver', () => {
    test('a waiting packet keeps the bytes it views until it is delivered', () => {
        // A copy of H.264 into TS with re-encoded sound once delivered pictures whose pooled
        // buffer the reader had refilled.
        const pooled = new Uint8Array(8).fill(7);
        trackHolds(pooled.buffer, () => pooled.fill(0));
        const delivered = [];
        const interleaver = new Interleaver(
            2,
            (lane, chunk) => delivered.push([lane, [...chunk.data]]),
            { waitFor: pending => pending },
        );
        const chunk = (trackType, data, timestamp) => ({
            trackType,
            data,
            timestamp,
            duration: 0.02,
            isKeyframe: true,
        });
        // The sound lane holds nothing yet, so the picture waits.
        interleaver.push(0, chunk('video', pooled.subarray(0, 4), 0));
        // The reader moves on: without another hold its pool would refill the buffer now.
        releaseBytes(pooled);
        interleaver.push(1, chunk('audio', Uint8Array.of(1), 0.01));
        interleaver.end(0);
        interleaver.end(1);
        assert.deepEqual(delivered, [
            [0, [7, 7, 7, 7]],
            [1, [1]],
        ]);
        assert.deepEqual([...pooled], [0, 0, 0, 0, 0, 0, 0, 0], 'delivered, the buffer returns');
    });
});
