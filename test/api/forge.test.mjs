import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { codes, greyAvi, movie, toneWav } from '../helpers/api-fixtures.mjs';

// MediaForge: the functions of mediaforgejs are the methods of a default instance; an instance
// holds defaults (plugins, policies, listeners) that its calls apply.

const inputError = error => error.code === 'INPUT';

describe('MediaForge', () => {
    test('options that are no object fail with INPUT', () => {
        assert.throws(() => new MediaForge(null), inputError);
    });

    test('a misspelled option policy is reported and lenient applies', () => {
        const warnings = [];
        new MediaForge({ optionPolicy: 'Strict', onWarning: warning => warnings.push(warning) });
        assert.deepEqual(codes(warnings), ['OPTION_IGNORED']);
    });

    test('an unusable codecPreference is dropped, or refused strictly', () => {
        assert.throws(
            () => new MediaForge({ codecPreference: 'fastest', optionPolicy: 'strict' }),
            inputError,
        );
        const warnings = [];
        new MediaForge({
            codecPreference: 'fastest',
            onWarning: warning => warnings.push(warning),
        });
        assert.deepEqual(codes(warnings), ['OPTION_IGNORED']);
    });

    test('methods take the per-call options of the functions', async () => {
        const forge = new MediaForge();
        const info = await forge.inspect(movie(), { signal: new AbortController().signal });
        assert.equal(info.format, 'mp4');
    });

    test('thumbnails default to PNG', async () => {
        assert.equal(
            (await new MediaForge().thumbnail(new Blob([greyAvi()]))).blob.type,
            'image/png',
        );
    });

    test('audio bitrates are bits per second in methods as in functions', async () => {
        const forge = new MediaForge();
        const bits = await forge.convert(toneWav(), 'mp3', { audio: { bitrate: 96000 } });
        const text = await forge.convert(toneWav(), 'mp3', { audio: { bitrate: '96k' } });
        assert.equal(bits.blob.size, text.blob.size);
    });
});
