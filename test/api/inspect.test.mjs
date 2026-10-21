import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, inspect } from 'mediaforgejs';
import { encodePng } from 'mediaforgejs/codecs';
import * as lite from 'mediaforgejs/lite';
import { greyAvi, movie } from '../helpers/api-fixtures.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';

// inspect(): the format and the tracks of an input, without decoding.

describe('inspect()', () => {
    test('reads the format and the tracks', async () => {
        const info = await inspect(waveFixture());
        assert.equal(info.format, 'wav');
        assert.equal(info.tracks[0].sampleRate, 8000);
    });

    test('is the method of a default MediaForge', async () => {
        const clip = new File([movie()], 'holiday clip.mp4', { type: 'video/mp4' });
        const info = await inspect(clip);
        assert.equal(info.format, 'mp4');
        const tracks = result => result.tracks.map(track => [track.id, track.type, track.codec]);
        assert.deepEqual(tracks(info), tracks(await new MediaForge().inspect(clip)));
    });

    test('takes a signal', async () => {
        const info = await new MediaForge().inspect(movie(), {
            signal: new AbortController().signal,
        });
        assert.equal(info.format, 'mp4');
    });

    test('reads still pictures', async () => {
        const png = new Blob([await encodePng({ data: new Uint8Array(64), width: 4, height: 4 })]);
        assert.equal((await inspect(png)).format, 'png');
    });

    test('an unknown option warns as in every call, and fails with INPUT when strict', async () => {
        const png = new Blob([await encodePng({ data: new Uint8Array(64), width: 4, height: 4 })]);
        for (const input of [waveFixture(), png]) {
            const heard = [];
            const info = await inspect(input, {
                maxIndexBytes: 1000,
                onWarning: warning => heard.push(warning.code),
            });
            assert.deepEqual(
                info.warnings.map(warning => warning.code),
                ['OPTION_UNKNOWN'],
            );
            assert.match(info.warnings[0].message, /^inspect options: maxIndexBytes is not a/);
            assert.deepEqual(heard, ['OPTION_UNKNOWN']);
        }
        await assert.rejects(
            inspect(waveFixture(), { validation: 'strict', optionPolicy: 'strict' }),
            error => error.code === 'INPUT' && /validation/.test(error.message),
        );
    });

    test('reading options go under open', async () => {
        const info = await inspect(waveFixture(), { open: { validation: 'strict' } });
        assert.deepEqual(info.warnings, []);
    });

    test('a container of a plugin not in use fails with PLUGIN naming it', async () => {
        const missing = await lite.inspect(new Blob([greyAvi()])).catch(error => error);
        assert.deepEqual([missing.code, missing.plugin], ['PLUGIN', 'avi']);
        assert.match(missing.hint, /Include the 'avi' plugin/);
        assert.match(missing.hint, /from 'mediaforgejs\/plugins'/);
    });
});
