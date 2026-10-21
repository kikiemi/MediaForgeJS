import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, createPlayer, play } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';

// play() and createPlayer() of mediaforgejs alone: the player plugin is the package
// mediaforgejs-player, so without it every stream fails with PLUGIN naming that package, before a
// request. Playback itself is tested in packages/player/test.

/** A media element as far as play() looks at it before playback. */
const element = () => ({ play: () => Promise.resolve() });

/** A fetch that records its calls and answers a manifest. */
function recordingFetch() {
    const calls = [];
    const fetch = async url => {
        calls.push(String(url));
        return new Response('#EXTM3U\n');
    };
    return { calls, fetch };
}

const isMissingPlayer = error =>
    error.code === 'PLUGIN' && error.plugin === 'player' && /mediaforgejs-player/.test(error.hint);

describe('play() and createPlayer() without the player plugin', () => {
    for (const url of [
        'https://media.test/stream.mpd',
        'https://media.test/channel.m3u8',
        'https://media.test/channel',
    ])
        test(`play('${url.slice(19)}') fails with PLUGIN naming mediaforgejs-player`, async () => {
            const { calls, fetch } = recordingFetch();
            await assert.rejects(play(url, element(), { fetch }).finished, isMissingPlayer);
            assert.deepEqual(calls, [], 'no request');
        });

    test('the lite entry and a MediaForge fail the same way', async () => {
        const { fetch } = recordingFetch();
        for (const forge of [new lite.MediaForge(), new MediaForge()])
            await assert.rejects(
                forge.play('https://media.test/stream.mpd', element(), { fetch }).finished,
                isMissingPlayer,
            );
    });

    test('the message names the protocol of the URL', async () => {
        await assert.rejects(play('https://media.test/a.mpd', element()).finished, {
            message: 'No player of DASH streams is in use',
        });
        await assert.rejects(play('https://media.test/a', element()).finished, {
            message: 'No player of HLS or DASH streams is in use',
        });
    });

    test('createPlayer() loads fail with PLUGIN, each stream on its own', async () => {
        const player = createPlayer(element());
        const first = player.load('https://media.test/a.m3u8');
        const second = player.load('https://media.test/b.m3u8');
        await assert.rejects(first.finished, error => ['PLUGIN', 'ABORT'].includes(error.code));
        await assert.rejects(second.finished, isMissingPlayer);
    });
});

describe('play() arguments', () => {
    test('an empty URL fails with INPUT before playback', () => {
        assert.throws(
            () => play('', element()),
            error => error.code === 'INPUT',
        );
    });

    test('an unknown option warns as in every call, and fails with INPUT when strict', async () => {
        const warnings = [];
        const playback = play('https://media.test/a.mpd', element(), {
            bufferAhaed: 30,
            onWarning: warning => warnings.push(warning),
        });
        await assert.rejects(playback.finished, isMissingPlayer);
        assert.deepEqual(
            warnings.map(warning => warning.code),
            ['OPTION_UNKNOWN'],
        );
        assert.match(
            warnings[0].message,
            /^play options: bufferAhaed .* did you mean bufferAhead\?/,
        );
        const strict = play('https://media.test/a.mpd', element(), {
            bufferAhaed: 30,
            optionPolicy: 'strict',
        });
        await assert.rejects(
            strict.finished,
            error => error.code === 'INPUT' && /bufferAhaed/.test(error.message),
        );
    });

    test("a load's own options are read by the same rule", async () => {
        const warnings = [];
        const player = createPlayer(element(), { onWarning: warning => warnings.push(warning) });
        const playback = player.load('https://media.test/a.mpd', { Live: true, liev: true });
        await assert.rejects(playback.finished, isMissingPlayer);
        assert.deepEqual(
            warnings.map(warning => warning.code),
            ['OPTION_NORMALIZED', 'OPTION_UNKNOWN'],
        );
    });

    test('the audio and subtitles choices are read by the same rule', async () => {
        const warnings = [];
        const playback = play('https://media.test/a.m3u8', element(), {
            audio: { lang: 'ja' },
            subtitles: 'en',
            onWarning: warning => warnings.push(warning),
        });
        await assert.rejects(playback.finished, isMissingPlayer);
        assert.deepEqual(
            warnings.map(warning => [warning.code, warning.message.split(' ')[2]]),
            [
                ['OPTION_UNKNOWN', 'lang'],
                ['OPTION_IGNORED', 'subtitles'],
            ],
        );
        for (const audio of [{ lang: 'ja' }, { language: [3] }, 'ja'])
            await assert.rejects(
                play('https://media.test/a.m3u8', element(), { audio, optionPolicy: 'strict' })
                    .finished,
                error => error.code === 'INPUT',
            );
    });

    test('something that is not a media element fails with INPUT', () => {
        assert.throws(
            () => play('https://media.test/a.mpd', {}),
            error => error.code === 'INPUT',
        );
        assert.throws(
            () => createPlayer(undefined),
            error => error.code === 'INPUT',
        );
    });
});
