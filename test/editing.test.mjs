import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, convert, edit, inspect } from 'mediaforgejs';
import { codes } from './helpers/api-fixtures.mjs';
import {
    editingFixture,
    seconds,
    toneLevel,
    tracksOf,
    wavSamples,
} from './helpers/editing-fixtures.mjs';
import { preservationFixture } from './helpers/mp4-preservation-fixture.mjs';
import { waveFixture } from './helpers/original-fixtures.mjs';
import { installVideoCodecs } from './helpers/webcodecs-video-harness.mjs';

// edit(): clips joined as packets where they can be, re-encoded where they cannot; sound
// trimmed, faded, mixed and limited; and the settings of a project. Node has no WebCodecs, so
// the H.264 and MP3 inputs decode through the plugins of the default entry.

const clipA = editingFixture('clip-a.mp4');
const clipB = editingFixture('clip-b.mp4');
const clipM = editingFixture('clip-m4v.mp4');
const music = editingFixture('music.mp3');

/**
 * A MediaForge whose warnings are collected. The x264 fixtures carry an edit list ending past
 * their media, which every open reports; that warning is left out.
 */
function setup(options = {}) {
    const warnings = [];
    const forge = new MediaForge({
        ...options,
        onWarning: warning => warning.code !== 'MP4_EDIT_EXCEEDS_MEDIA' && warnings.push(warning),
    });
    const toWav = async blob => new Uint8Array(await blob.arrayBuffer());
    const decodeToWav = async blob =>
        wavSamples(await toWav((await forge.convert(blob, 'wav')).blob));
    return { forge, warnings, decodeToWav };
}

describe('editing', () => {
    describe('joining clips', () => {
        test('clips of one codec are copied and play through the join without a gap', async () => {
            const { forge, warnings, decodeToWav } = setup();
            const plans = [];
            const result = await forge.edit(
                { clips: [{ input: clipA }, { input: clipB }] },
                { to: 'mp4', onPlan: plan => plans.push(plan) },
            );
            assert.deepEqual(codes(warnings), [], 'each clip starts at a keyframe');
            assert.deepEqual(plans, [result.plan], 'onPlan has the plan before the file');
            assert.deepEqual(
                [
                    result.plan.action,
                    ...result.plan.tracks.map(track => [track.type, track.action]),
                ],
                ['copy', ['video', 'copy'], ['audio', 'copy']],
            );
            assert.ok(Math.abs(result.plan.duration - 5) < 0.01);
            const [video, audio] = await tracksOf(result.blob);
            assert.equal(video.sampleCount, 125, 'every picture of both clips');
            assert.ok(audio.sampleCount >= 233 && audio.sampleCount <= 237, `${audio.sampleCount}`);
            assert.ok(Math.abs(video.duration - 5) < 0.001, `3 s + 2 s: ${video.duration}`);
            const steps = new Set(
                video.times
                    .slice(1)
                    .map((time, index) => Math.round((time - video.times[index]) * 1000)),
            );
            assert.deepEqual([...steps], [40], 'a picture every 40 ms across the join');
            const sound = await decodeToWav(result.blob);
            assert.ok(toneLevel(sound, 0.5, 2.5, 440).tone > 0.95, 'the first clip at 440 Hz');
            assert.ok(toneLevel(sound, 3.5, 4.8, 880).tone > 0.95, 'the second at 880 Hz');
        });

        test('a clip cut off a keyframe after another must be re-encoded', async () => {
            const { forge, warnings } = setup();
            const project = {
                clips: [
                    { input: clipA, end: 1 },
                    { input: clipB, start: 0.5 },
                ],
            };
            await assert.rejects(
                forge.edit(project, 'mp4'),
                error => error.code === 'ENCODE' && /VideoEncoder/.test(error.message),
            );
            const reencoded = warnings.find(warning => warning.code === 'EDIT_REENCODED');
            assert.match(reencoded.message, /0\.5 s, which is not a keyframe/);
        });

        test('clips whose parameter sets differ are re-encoded, the difference named', async () => {
            const { forge, warnings } = setup();
            // The last byte of clip-b's first PPS in its avcC.
            const other = clipB.slice();
            const u16 = at => (other[at] << 8) | other[at + 1];
            const avcC = Buffer.from(other).indexOf('avcC') + 4;
            const pps = avcC + 8 + u16(avcC + 6) + 1;
            other[pps + 1 + u16(pps)] ^= 1;
            await assert.rejects(
                forge.edit({ clips: [{ input: clipA }, { input: other }] }, 'mp4'),
                error => error.code === 'ENCODE',
            );
            assert.match(
                warnings.find(warning => warning.code === 'EDIT_REENCODED').message,
                /clips\[1\] differs from the first clip in codec configuration$/,
            );
        });

        test('no clips, an input that is no file or a start past a clip is INPUT', async () => {
            const { forge } = setup();
            for (const clips of [[], [{ input: 5 }], [{ input: clipA, start: 4 }]])
                await assert.rejects(
                    forge.edit({ clips }, 'mp4'),
                    error => error.code === 'INPUT',
                    JSON.stringify(clips),
                );
        });

        test("each clip's first video and audio are kept; the others are reported", async () => {
            const { forge } = setup();
            const tracks = [
                { type: 'video' },
                { type: 'audio' },
                { type: 'subtitle', codec: 'tx3g' },
            ];
            const input = new Blob([preservationFixture({ tracks }).bytes]);
            const result = await forge.edit({ clips: [{ input }] }, 'mp4');
            assert.ok(
                result.warnings.some(
                    warning =>
                        warning.code === 'TARGET_TRACKS_DROPPED' &&
                        /1 subtitle/.test(warning.message),
                ),
            );
            assert.deepEqual(
                (await tracksOf(result.blob)).map(track => track.type),
                ['video', 'audio'],
            );
        });
    });

    describe('sound', () => {
        test('audio.replace keeps the pictures and encodes the new sound under them', async () => {
            const { forge, decodeToWav } = setup();
            const { blob } = await forge.convert(clipA, { audio: { replace: music } });
            const [video, audio] = await tracksOf(blob);
            // AAC frames for 3 s at the music's rate, and the encoder's flush.
            assert.deepEqual(
                [video.codec, video.sampleCount, audio.codec, audio.sampleCount],
                ['avc1.4d400a', 75, 'mp4a.40.2', Math.ceil((3 * 44100) / 1024) + 1],
            );
            const sound = await decodeToWav(blob);
            assert.deepEqual([sound.channels, sound.sampleRate], [1, 44100], "the music's layout");
            assert.ok(toneLevel(sound, 0.2, 2.8, 220).tone > 0.95, 'the music sounds');
            assert.ok(toneLevel(sound, 0.2, 2.8, 440).tone < 0.05, 'the clip does not');
        });

        test('clips are trimmed, faded and attenuated; music loops from its offset', async () => {
            const { forge, decodeToWav } = setup();
            const { blob } = await forge.edit(
                {
                    clips: [
                        { input: clipA, start: 0.5, end: 2, audio: { fade: { in: 0.5 } } },
                        { input: clipB, end: 1, audio: { volume: 0.25 } },
                    ],
                    audio: [{ input: music, start: 3.5, offset: 1, loop: true, volume: 0.5 }],
                },
                { to: 'mp4', audio: { sampleRate: 48000, channels: 2 } },
            );
            const [video, audio] = await tracksOf(blob);
            assert.deepEqual([video.codec, audio.codec], ['avc1.4d400a', 'mp4a.40.2']);
            const sound = await decodeToWav(blob);
            assert.deepEqual([sound.sampleRate, sound.channels], [48000, 2]);
            // 1.5 s and 1 s, each ending with its last picture in range.
            assert.ok(Math.abs(seconds(sound) - 2.5) < 0.01, `${seconds(sound)} s`);
            const early = toneLevel(sound, 0, 0.1, 440);
            const late = toneLevel(sound, 0.4, 0.5, 440);
            assert.ok(early.rms < late.rms * 0.35, 'the fade-in starts quiet');
            assert.ok(late.tone > 0.9);
            assert.ok(toneLevel(sound, 0.6, 0.95, 220).tone < 0.05, 'no music before its offset');
            const both = toneLevel(sound, 1.1, 1.5, 220);
            assert.ok(both.tone > 0.3 && both.tone < 0.9, `music and clip share: ${both.tone}`);
            const second = toneLevel(sound, 1.7, 2.5, 880);
            assert.ok(second.tone > 0.1, `the second clip at a quarter: ${second.tone}`);
            assert.ok(second.rms < toneLevel(sound, 0.6, 0.9, 440).rms, 'quieter than the first');
            assert.ok(toneLevel(sound, 2.1, 2.5, 220).tone > 0.2, 'the music loops to the end');
            assert.ok(sound.samples.every(sample => sample >= -1 && sample <= 1));
        });

        test('a mix louder than full scale is limited, keeping its shape', async () => {
            const { forge } = setup();
            // The clip's 440 Hz sine over itself at volume 12 sums far past full scale.
            const { blob } = await forge.edit(
                {
                    clips: [{ input: clipA, start: 0.5, end: 2, audio: { volume: 12 } }],
                    audio: [{ input: clipA, start: 0.5, volume: 12 }],
                },
                { to: 'wav', audio: { sampleRate: 48000, channels: 1 } },
            );
            const sound = wavSamples(new Uint8Array(await blob.arrayBuffer()));
            const steady = toneLevel(sound, 0.3, 1.4, 440);
            assert.ok(steady.tone > 0.999, `still a sine: ${steady.tone}`);
            assert.ok(steady.rms > 0.6, `still loud: ${steady.rms}`);
            let flat = 0;
            for (let index = 2; index < sound.samples.length; index++)
                if (
                    sound.samples
                        .slice(index - 2, index + 1)
                        .every(value => Math.abs(value) > 0.9999)
                )
                    flat++;
            assert.equal(flat, 0, 'no three samples in a row at full scale');
        });

        for (const [speed, pitch, stage] of [
            [undefined, 880, 'time-stretch'],
            ['shift-pitch', 1760, 'resample'],
        ])
            test(`double speed into WAV ${speed ? 'shifts' : 'keeps'} the pitch`, async () => {
                const { forge } = setup();
                const { blob, plan } = await forge.edit(
                    {
                        clips: [
                            { input: clipA, start: 1, end: 2 },
                            { input: clipB, speed: 2, audio: { volume: 1, speed } },
                        ],
                    },
                    'wav',
                );
                assert.deepEqual(
                    plan.tracks.map(track => [track.type, track.action, track.codec, track.stages]),
                    [['audio', 'encode', 'pcm-s16', [stage]]],
                );
                const sound = wavSamples(new Uint8Array(await blob.arrayBuffer()));
                assert.equal(sound.sampleRate, 48000);
                assert.ok(Math.abs(seconds(sound) - 2) < 0.001, 'one second, then two at double');
                assert.ok(toneLevel(sound, 0.1, 0.9, 440).tone > 0.95);
                assert.ok(toneLevel(sound, 1.1, 1.9, pitch).tone > 0.9, `at ${pitch} Hz`);
            });

        test('an edit into MP3 encodes the sound of the clips', async () => {
            const { forge, decodeToWav } = setup();
            const { blob } = await forge.edit(
                { clips: [{ input: clipM }] },
                {
                    to: 'mp3',
                    audio: { bitrate: 64 },
                },
            );
            assert.equal(blob.type, 'audio/mpeg');
            assert.ok(toneLevel(await decodeToWav(blob), 0.2, 1.8, 550).tone > 0.9);
        });

        test('an edit into an audio file takes the settings a conversion takes', async () => {
            // 8 kHz is not an MP3 rate.
            const input = waveFixture();
            for (const run of [
                edit({ clips: [{ input }] }, { to: 'mp3' }),
                convert(input, { to: 'mp3' }),
            ]) {
                const result = await run;
                assert.ok(
                    result.warnings.some(
                        warning =>
                            warning.code === 'OPTION_NORMALIZED' &&
                            /sampleRate/.test(warning.message),
                    ),
                );
                assert.equal((await inspect(result.blob)).tracks[0].sampleRate, 32000);
            }
        });

        test('Ogg without an Opus encoder takes FLAC, reported as convert() does', async () => {
            const { forge, warnings, decodeToWav } = setup();
            const { blob, plan } = await forge.edit({ clips: [{ input: music, end: 1 }] }, 'ogg');
            assert.deepEqual(
                plan.tracks.map(track => [track.action, track.codec]),
                [['encode', 'flac']],
            );
            assert.ok(codes(warnings).includes('CODEC_SUBSTITUTED'));
            assert.ok(toneLevel(await decodeToWav(blob), 0.1, 0.9, 220).tone > 0.9);
        });

        test("an 'opus' target without an Opus encoder fails, naming the gap", async () => {
            const { forge } = setup();
            await assert.rejects(forge.edit({ clips: [{ input: music, end: 1 }] }, 'opus'), {
                code: 'ENCODE',
                message: /holds Opus audio only, which this host cannot encode/,
            });
        });
    });

    describe('re-encoded video', () => {
        test('clips at their speeds continue one frame grid through the host encoder', async () => {
            const { forge } = setup();
            const host = installVideoCodecs();
            try {
                const { blob } = await forge.edit(
                    {
                        clips: [
                            { input: clipM, start: 0.5, end: 1.5, speed: 2 },
                            { input: clipM, start: 1, end: 1.4 },
                        ],
                        fps: 25,
                    },
                    { to: 'mkv', video: { codec: 'vp8' }, audio: { codec: 'aac' } },
                );
                const times = host.encoded.map(frame => frame.timestamp / 1e6);
                assert.equal(times.length, 13 + 10, 'half a second at double speed, then 0.4 s');
                assert.deepEqual(times.slice(0, 3), [0, 0.04, 0.08]);
                assert.deepEqual(times.slice(11, 14), [0.44, 0.48, 0.52], 'the grid goes on');
                assert.deepEqual(
                    host.encoded.filter(frame => frame.keyFrame).map(frame => frame.timestamp),
                    [0],
                    'one keyframe per two seconds',
                );
                const [video, audio] = await tracksOf(blob);
                assert.deepEqual(
                    [video.codec, video.sampleCount, audio.codec, audio.sampleCount],
                    ['vp8', 23, 'mp4a.40.2', Math.ceil((0.9 * 48000) / 1024) + 1],
                );
                host.assertClosed();
            } finally {
                host.restore();
            }
        });

        test('without host codecs a turned clip names the missing VideoEncoder', async () => {
            const { forge } = setup();
            await assert.rejects(
                forge.edit({ clips: [{ input: clipM, video: { rotate: 90 } }] }, 'mkv'),
                error => error.code === 'ENCODE' && /VideoEncoder/.test(error.message),
            );
        });
    });

    describe('project settings', () => {
        test('settings out of range are repaired and reported', async () => {
            const { forge, warnings } = setup();
            const failure = await forge
                .edit(
                    {
                        clips: [
                            {
                                input: clipA,
                                end: 1,
                                speed: '1',
                                audio: { volume: 20, fade: { in: -1 } },
                                video: { rotate: 45 },
                            },
                        ],
                        overlays: [],
                        music: [],
                    },
                    { to: 'mp4', video: { bitrate: 500 } },
                )
                .catch(error => error);
            // The repaired project re-encodes, which needs a host encoder.
            assert.equal(failure.code, 'ENCODE');
            assert.deepEqual(
                codes(warnings).filter(code => code.startsWith('OPTION')),
                Array(6).fill('OPTION_NORMALIZED'),
            );
        });

        test('strictly, a repair fails with INPUT', async () => {
            const { forge } = setup({ optionPolicy: 'strict' });
            await assert.rejects(
                forge.edit({ clips: [{ input: clipA, speed: '1' }] }, 'mp4'),
                error => error.code === 'INPUT',
            );
        });

        test('a picture target or an unknown overlay fails with INPUT', async () => {
            const { forge } = setup();
            await assert.rejects(
                forge.edit({ clips: [{ input: clipA }] }, 'png'),
                error => error.code === 'INPUT',
            );
            await assert.rejects(
                forge.edit({ clips: [{ input: clipA }], overlays: [{ kind: 'shape' }] }, 'mp4'),
                error => error.code === 'INPUT',
            );
        });
    });
});
