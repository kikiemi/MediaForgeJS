import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// The copy's decision about priming has no public face.
import { hasSourceAudioPriming } from '../../dist/esm/pipeline/copy/copied-track.js';

// When a copied audio track starts with samples a player discards.

const sample = timestamp => ({ offset: 0, size: 1, timestamp, duration: 0.02, isKeyframe: true });

describe('pipeline/copy: priming', () => {
    for (const [label, track, primed] of [
        ['MP3 with an encoder delay', { codec: 'mp3', audioPrimingSamples: 1105 }, true],
        ['MP3 without one', { codec: 'mp3', audioPrimingSamples: 0 }, false],
        ['AAC with an encoder delay', { codec: 'mp4a.40.2', audioPrimingSamples: 2112 }, true],
        [
            'Vorbis whose edit list holds the delay',
            { codec: 'vorbis', audioPrimingSamples: 128, editList: [{}] },
            false,
        ],
        ['AAC whose edit starts late', { codec: 'mp4a.40.2', editMediaTimeSeconds: 0.0213 }, true],
        ['AAC whose first packet is early', { codec: 'mp4a.40.2', first: -0.02 }, true],
        ['AAC that starts at zero', { codec: 'mp4a.40.2' }, false],
        [
            'Opus whose codec delay places it early',
            { codec: 'opus', matroskaCodecDelaySeconds: 0.0065, first: -0.0065 },
            false,
        ],
    ])
        test(`${label} is ${primed ? '' : 'not '}primed`, () => {
            const { first = 0, ...info } = track;
            assert.equal(hasSourceAudioPriming({ ...info, samples: [sample(first)] }), primed);
        });
});
