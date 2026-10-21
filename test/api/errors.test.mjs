import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_CODES, MediaForgeError, check, convert, isMediaForgeError } from 'mediaforgejs';
// The hints for errors that no call raises here.
import { hintFor } from '../../dist/esm/api/hints.js';
import { movie } from '../helpers/api-fixtures.mjs';

// Failures: a code from ERROR_CODES, a short message and a hint saying what to do; check()
// returns the same code, reason and hint without writing anything.

const clip = () => new File([movie()], 'holiday clip.mp4', { type: 'video/mp4' });

describe('api errors', () => {
    test('the error codes', () => {
        assert.deepEqual([...ERROR_CODES].sort(), [
            'ABORT',
            'DECODE',
            'DEMUX',
            'ENCODE',
            'FORMAT',
            'INPUT',
            'IO',
            'MUX',
            'OOM',
            'OUTPUT',
            'PLUGIN',
        ]);
    });

    test('isMediaForgeError() tells the library errors and their codes', async () => {
        const packaged = await convert(clip(), 'hls').catch(error => error);
        assert.ok(isMediaForgeError(packaged));
        assert.ok(!isMediaForgeError(packaged, 'ABORT'));
        assert.ok(!isMediaForgeError(new Error('x')));
    });

    test('an unknown format says what was probably meant', async () => {
        await assert.rejects(convert(clip(), 'mkvv'), error => {
            assert.ok(isMediaForgeError(error, 'INPUT'));
            assert.match(error.message, /did you mean 'mkv'\?/);
            assert.match(error.hint, /mp4/);
            return true;
        });
    });

    test('a container that cannot hold the codecs suggests one; check() agrees', async () => {
        const thrown = await convert(clip(), 'webm').catch(error => error);
        assert.ok(thrown instanceof MediaForgeError);
        assert.equal(thrown.code, 'FORMAT');
        assert.match(thrown.hint, /mkv/);
        const verdict = await check(clip(), 'webm');
        assert.equal(verdict.supported, false);
        assert.deepEqual(
            [verdict.code, verdict.reason, verdict.hint],
            [thrown.code, thrown.message, thrown.hint],
        );
    });

    test('a missing host encoder is named, with a container to copy into', async () => {
        const failure = await convert(clip(), 'mp4', { video: { width: 16 } }).catch(
            error => error,
        );
        assert.equal(failure.code, 'ENCODE');
        assert.match(failure.message, /VideoEncoder/);
        assert.match(failure.hint, /mkv/);
        const support = await check(clip(), 'mp4', { video: { width: 16 } });
        assert.deepEqual([support.code, support.hint], [failure.code, failure.hint]);
    });

    test('a package target of convert() points to packageMedia()', async () => {
        const packaged = await convert(clip(), 'hls').catch(error => error);
        assert.match(packaged.hint, /packageMedia\(/);
    });

    test('OOM hints name the setting or the sink to use', async () => {
        const tooLarge = await convert(clip(), 'mkv', { maxBytes: 100 }).catch(error => error);
        assert.equal(tooLarge.code, 'OOM');
        assert.match(tooLarge.hint, /StreamSink\.fromPicker\(\) or FileSink/);
        const manySamples = await convert(clip(), 'mkv', { open: { maxSamples: 2 } }).catch(
            error => error,
        );
        assert.equal(manySamples.code, 'OOM');
        assert.match(manySamples.hint, /open\.maxSamples/);
        assert.match(hintFor('OOM', 'Packaging: package exceeds maxTotalBytes'), /onFile/);
    });

    test('an audio format from a video track says to choose an audio track', async () => {
        const silent = await convert(clip(), 'wav', { trackIds: [11] }).catch(error => error);
        assert.equal(silent.code, 'FORMAT');
        assert.match(silent.hint, /trackIds: \[id\]/);
    });
});
