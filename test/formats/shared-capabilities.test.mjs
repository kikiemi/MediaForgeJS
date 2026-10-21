import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// What each container holds, as the writers' shared table states it.
import {
    carriesRotation,
    carriesTrackMetadata,
    isIsoOutput,
} from '../../dist/esm/formats/shared/capabilities.js';
import { createWriters } from '../../dist/esm/formats/shared/contract.js';
import { CORE_FORMATS } from '../../dist/esm/formats/core-formats.js';

describe('formats/shared: what a container holds', () => {
    for (const [decide, yes, no] of [
        [
            carriesRotation,
            ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm'],
            ['ts', 'avi', 'flv', 'fmp4'],
        ],
        [
            carriesTrackMetadata,
            ['mkv', 'webm', 'mp4', 'mov', 'm4a', 'fmp4'],
            ['ts', 'avi', 'flv', 'ogg'],
        ],
        [isIsoOutput, ['mp4', 'mov', 'm4a', 'm4v', '3gp', 'fmp4'], ['mkv', 'webm', 'ts']],
    ])
        test(`${decide.name}: ${yes.join(', ')}; not ${no.join(', ')}`, () => {
            for (const format of yes) assert.equal(decide(format), true, format);
            for (const format of no) assert.equal(decide(format), false, format);
        });
});

describe('formats/shared: the writers of a composition', () => {
    test('a writer used before it loads names the format asked for', async () => {
        const writers = createWriters(CORE_FORMATS.writers, CORE_FORMATS.segments);
        // One part writes the audio files; a copy into WAV before it loads is about WAV.
        for (const format of ['wav', 'flac', 'mp3'])
            assert.throws(() => writers.audio.get(format)(), {
                code: 'FORMAT',
                message: `The ${format} writer is not loaded`,
            });
        assert.throws(() => writers.container.get('webm')(), {
            message: 'The webm writer is not loaded',
        });
        await writers.load('wav');
        assert.doesNotThrow(() => writers.audio.get('wav'));
    });
});
