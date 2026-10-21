import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { codes } from '../helpers/api-fixtures.mjs';
import {
    editingFixture,
    seconds,
    toneLevel,
    tracksOf,
    wavSamples,
} from '../helpers/editing-fixtures.mjs';

// convert() with start, end and audio.mute: a range copied from the keyframe before it, presented
// from its start; consecutive ranges of an open input; the video alone.

const clipA = editingFixture('clip-a.mp4');
const clipC = editingFixture('clip-c.webm');
const music = editingFixture('music.mp3');

/**
 * A MediaForge whose warnings are collected. The x264 fixtures carry an edit list ending past
 * their media, which every open reports; that warning is left out.
 */
function setup() {
    const warnings = [];
    const forge = new MediaForge({
        onWarning: warning => warning.code !== 'MP4_EDIT_EXCEEDS_MEDIA' && warnings.push(warning),
    });
    const decodeToWav = async blob =>
        wavSamples(new Uint8Array(await (await forge.convert(blob, 'wav')).blob.arrayBuffer()));
    return { forge, warnings, decodeToWav };
}

describe('convert() ranges', () => {
    test('an MP4 range copies from the keyframe before it and an edit list hides it', async () => {
        const { forge, warnings, decodeToWav } = setup();
        const { blob } = await forge.convert(clipA, { to: 'mp4', start: 1.5, end: 2.5 });
        assert.deepEqual(codes(warnings), ['TRIM_SNAPPED', 'TRIM_SNAPPED']);
        assert.match(warnings[0].message, /keyframe at 1\.000 s; playback at 1\.5 s/);
        const [video, audio] = await tracksOf(blob);
        // From the keyframe at 1 s to the last picture shown before 2.5 s (2.52 and 2.60 decode
        // before 2.5 s but nothing shown refers to them), and the audio around the range.
        assert.deepEqual(
            [video.codec, video.sampleCount, audio.codec, audio.sampleCount],
            ['avc1.4d400a', 38, 'mp4a.40.2', 48],
        );
        assert.deepEqual([video.duration, audio.duration], [1, 1], 'both present one second');
        // The picture shown at 1.5 s (from 1.48 s) is presented from the start; 25 follow.
        const shown = video.times.filter(time => time > -0.04);
        assert.equal(shown.length, 26);
        assert.deepEqual(
            shown.slice(0, 3).map(time => Math.round(time * 100) / 100),
            [0, 0.02, 0.06],
        );
        const sound = await decodeToWav(blob);
        assert.ok(Math.abs(seconds(sound) - 1) < 0.002, `${seconds(sound)} s`);
        assert.ok(toneLevel(sound, 0.05, 0.95, 440).tone > 0.95, 'the copied audio keeps its tone');
    });

    test('a start inside the last picture presents that picture alone', async () => {
        const { forge } = setup();
        const [video] = await tracksOf(
            (await forge.convert(clipA, { to: 'mp4', start: 2.97 })).blob,
        );
        assert.deepEqual(
            video.times.filter(time => time > -0.04).map(time => Math.round(time * 100) / 100),
            [0],
        );
    });

    test('with re-encoded audio the range ends at its end, not at the last picture', async () => {
        const { forge, decodeToWav } = setup();
        const { blob } = await forge.convert(clipA, {
            to: 'mp4',
            start: 0.5,
            end: 1.5,
            audio: { bitrate: 64000 },
        });
        const [, encoded] = await tracksOf(blob);
        assert.equal(encoded.duration, 1, 'one second of AAC after its 1024 priming samples');
        assert.ok(Math.abs(seconds(await decodeToWav(blob)) - 1) < 0.002);
    });

    test('a container without edit lists starts at the keyframe, the sound with it', async () => {
        const { forge, warnings } = setup();
        const { blob } = await forge.convert(clipA, { to: 'mkv', start: 1.5, end: 2.5 });
        assert.deepEqual(codes(warnings), ['TRIM_SNAPPED', 'TRIM_SNAPPED']);
        assert.match(warnings[0].message, /copy and playback start at the keyframe/);
        const [video, audio] = await tracksOf(blob);
        // The audio packet at 0.981 s that the keyframe at 1 s falls in starts at zero; the
        // keyframe shows 19 ms later.
        assert.ok(Math.abs(audio.times[0]) < 0.002, `${audio.times[0]}`);
        assert.ok(Math.abs(video.times[0] - 0.019) < 0.002, `${video.times[0]}`);
    });

    test('VP9 copies from the keyframe before the start', async () => {
        const { forge } = setup();
        const [video] = await tracksOf(
            (await forge.convert(clipC, { to: 'webm', start: 0.7 })).blob,
        );
        assert.equal(video.sampleCount, 45, 'from the keyframe at 0.5 s: 45 of 60 pictures');
    });

    test('check() refuses a start past the end and drops an end before the start', async () => {
        const { forge } = setup();
        assert.equal(
            (await forge.check(clipA, { to: 'mp4', start: 2.9, end: 3.5 })).supported,
            true,
        );
        const past = await forge.check(clipA, { to: 'mp4', start: 5 });
        assert.deepEqual([past.supported, past.code], [false, 'INPUT']);
        const backwards = await forge.check(clipA, { to: 'mp4', start: 2, end: 1 });
        assert.ok(
            backwards.warnings.some(
                warning => warning.code === 'OPTION_IGNORED' && /end/.test(warning.message),
            ),
        );
    });

    test('consecutive ranges of an open input add up to it', async () => {
        const { forge, warnings, decodeToWav } = setup();
        const whole = await forge.open(clipA);
        const parts = [];
        try {
            for (const [start, end] of [
                [0, 1.2],
                [1.2, 2.2],
                [2.2, undefined],
            ])
                parts.push((await whole.convert({ start, end })).blob);
        } finally {
            whole.close();
        }
        // The second and third start off keyframes and packets.
        assert.deepEqual(codes(warnings), Array(4).fill('TRIM_SNAPPED'));
        const durations = [];
        for (const part of parts) {
            const tracks = await tracksOf(part);
            assert.equal(tracks.length, 2);
            assert.equal(tracks[0].duration, tracks[1].duration);
            durations.push(Math.round(seconds(await decodeToWav(part)) * 100) / 100);
        }
        assert.deepEqual(durations, [1.2, 1, 0.8]);
    });
});

describe('convert() audio.mute', () => {
    test('copies the video alone, into the same container or another', async () => {
        const { forge, warnings } = setup();
        const muted = (await forge.convert(clipA, { audio: { mute: true } })).blob;
        assert.equal(muted.type, 'video/mp4');
        assert.deepEqual(
            (await tracksOf(muted)).map(track => track.type),
            ['video'],
        );
        const { blob: mkv } = await forge.convert(clipA, { to: 'mkv', audio: { mute: true } });
        assert.deepEqual(
            (await tracksOf(mkv)).map(track => track.type),
            ['video'],
        );
        assert.deepEqual(codes(warnings), []);
    });

    test('muting sound alone fails with FORMAT; for an audio format it is ignored', async () => {
        const { forge } = setup();
        await assert.rejects(
            forge.convert(music, { to: 'mkv', audio: { mute: true } }),
            error => error.code === 'FORMAT',
        );
        const wav = await forge.check(clipA, { to: 'wav', audio: { mute: true } });
        assert.deepEqual(
            codes(wav.warnings).filter(code => code.startsWith('OPTION')),
            ['OPTION_IGNORED'],
        );
    });
});
