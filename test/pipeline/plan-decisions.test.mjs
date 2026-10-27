import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, convert, edit, open, packageMedia } from 'mediaforgejs';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
// The plan's own decisions about targets and pictures, which have no public face.
import { sameContainer } from '../../dist/esm/pipeline/plan/conversion.js';
import { reshapesVideo } from '../../dist/esm/pipeline/plan/conversion-plan.js';
import { encodableVideoCodec } from '../../dist/esm/pipeline/plan/codec-choice.js';
import {
    FRAME_ENCODE_FORMATS,
    audioFormatCodec,
} from '../../dist/esm/pipeline/plan/format-policy.js';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { mpegAudioFixture, waveFixture } from '../helpers/original-fixtures.mjs';
import { webmClip } from '../helpers/webm-clip-fixture.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// Copy or re-encode, per track, as check() reports it before any work. Node has no WebCodecs, so
// every encode here is the library's own.

const tone = [0, 1].map(channel =>
    Float32Array.from(
        { length: 48000 / 4 },
        (_, index) => 0.3 * Math.sin((index * 2 + channel) / 10),
    ),
);
const inputs = {
    adts: async () => new Blob([wrapAdts(await encodeAacLc(tone, { sampleRate: 48000 }))]),
    'aac.mp4': async () => new Blob([classicMp4().bytes]),
    webm: async () => new Blob([webmClip()]),
    wav: async () => new Blob([waveFixture()]),
    mp3: async () => new Blob([mpegAudioFixture(3)]),
};
const copy = (type, codec) => [type, 'copy', codec, '-'];
const encode = (type, codec) => [type, 'encode', codec, 'builtin'];
const vp9 = copy('video', 'vp09.00.10.08');

/** [input, target, the plan's action or the failure's code, the tracks' lanes] */
const PLANS = [
    ['adts', 'mp4', 'copy', [copy('audio', 'mp4a.40.2')]],
    ['adts', 'm4a', 'copy', [copy('audio', 'mp4a.40.2')]],
    ['adts', 'mkv', 'copy', [copy('audio', 'mp4a.40.2')]],
    ['adts', 'aac', 'copy', [copy('audio', 'mp4a.40.2')]],
    ['adts', 'wav', 'reencode', [encode('audio', 'pcm-s16')]],
    ['adts', 'mp3', 'reencode', [encode('audio', 'mp3')]],
    ['adts', 'flac', 'reencode', [encode('audio', 'flac')]],
    ['adts', { to: 'mp4', audio: { bitrate: '96k' } }, 'reencode', [encode('audio', 'mp4a.40.2')]],
    [
        'adts',
        { to: 'mp4', audio: { sampleRate: 44100 } },
        'reencode',
        [encode('audio', 'mp4a.40.2')],
    ],
    ['adts', { to: 'mkv', audio: { codec: 'mp3' } }, 'reencode', [encode('audio', 'mp3')]],
    ['adts', { to: 'mp4', copy: false }, 'reencode', [encode('audio', 'mp4a.40.2')]],
    ['adts', { to: 'mkv', copy: false }, 'reencode', [encode('audio', 'mp4a.40.2')]],
    ['adts', { to: 'aac', copy: false }, 'reencode', [encode('audio', 'mp4a.40.2')]],
    // The MP3 fixture copies but does not decode.
    ['mp3', { to: 'mp4', copy: false }, 'DECODE'],
    ['wav', { to: 'mkv', copy: false }, 'reencode', [encode('audio', 'pcm')]],
    ['wav', 'mov', 'copy', [copy('audio', 'pcm-s16le')]],
    ['wav', { to: 'mp4', audio: { codec: 'pcm' } }, 'copy', [copy('audio', 'pcm-s16le')]],
    ['wav', { to: 'wav', copy: false }, 'reencode', [encode('audio', 'pcm-s16')]],
    ['webm', { to: 'webm', copy: false }, 'DECODE'],
    // Ogg takes FLAC where no host Opus encoder is (CODEC_SUBSTITUTED); it writes no Vorbis.
    ['adts', 'ogg', 'reencode', [encode('audio', 'flac')]],
    ['adts', { to: 'ogg', optionPolicy: 'strict' }, 'FORMAT'],
    ['adts', { to: 'ogg', audio: { codec: 'flac' } }, 'reencode', [encode('audio', 'flac')]],
    ['adts', { to: 'ogg', audio: { codec: 'vorbis' } }, 'FORMAT'],
    // Vorbis is the host's to encode: WebM holds nothing else the library encodes.
    ['adts', { to: 'webm', audio: { codec: 'vorbis' } }, 'ENCODE'],
    ['wav', { to: 'mkv', audio: { codec: 'opus' } }, 'reencode', [encode('audio', 'mp4a.40.2')]],
    ['wav', { to: 'webm', copy: false }, 'ENCODE'],
    // 'opus' names its codec: Opus is copied, other audio needs an Opus encoder and is never
    // replaced.
    ['webm', 'opus', 'copy', [copy('audio', 'opus')]],
    ['adts', 'opus', 'ENCODE'],
    ['wav', { to: 'opus', audio: { codec: 'flac' } }, 'ENCODE'],
    ['wav', { to: 'opus', copy: true }, 'FORMAT'],
    ['wav', { to: 'opus', copy: false }, 'ENCODE'],
    ['adts', { to: 'mp4', copy: true, audio: { bitrate: '96k' } }, 'INPUT'],
    ['aac.mp4', 'mov', 'copy', [copy('audio', 'mp4a.40.2')]],
    ['webm', 'mkv', 'copy', [vp9, copy('audio', 'opus')]],
    ['webm', 'webm', 'copy', [vp9, copy('audio', 'opus')]],
    ['webm', 'mp4', 'copy', [vp9, copy('audio', 'opus')]],
    ['webm', { to: 'webm', audio: { mute: true } }, 'copy', [vp9]],
    ['webm', { to: 'mkv', video: { width: 16 } }, 'DECODE'],
    ['wav', 'mkv', 'copy', [copy('audio', 'pcm-s16le')]],
    ['wav', 'flac', 'reencode', [encode('audio', 'flac')]],
    ['wav', 'mp4', 'reencode', [encode('audio', 'mp4a.40.2')]],
    ['mp3', 'mp4', 'copy', [copy('audio', 'mp3')]],
    ['mp3', 'mp3', 'copy', [copy('audio', 'mp3')]],
];

/** The plan's action and each track's lane, or the code check() fails with. */
async function planned(input, target) {
    const support = await check(await inputs[input](), target).catch(error => error);
    if (support instanceof Error) return [support.code];
    if (!support.supported) return [support.code];
    const lanes = support.plan.tracks.map(track => [
        track.type,
        track.action,
        track.codec,
        track.encoder ?? '-',
    ]);
    return [support.plan.action, lanes];
}

/** The plan's action and each track's type, lane and codec family. */
const shape = report => [
    report.action,
    ...report.tracks.map(track => `${track.type}:${track.action}:${track.codec.split('.')[0]}`),
];

describe('pipeline/plan: copy or re-encode', () => {
    for (const [input, target, action, tracks] of PLANS)
        test(`${input} to ${JSON.stringify(target)}: ${action}`, async () => {
            assert.deepEqual(await planned(input, target), tracks ? [action, tracks] : [action]);
        });

    test('a codec taken in place of the one asked is reported once', async () => {
        for (const [input, target] of [
            ['adts', 'ogg'],
            ['wav', { to: 'mkv', audio: { codec: 'opus' } }],
        ]) {
            const support = await check(await inputs[input](), target);
            const substituted = support.warnings.filter(
                warning => warning.code === 'CODEC_SUBSTITUTED',
            );
            assert.equal(substituted.length, 1, JSON.stringify(target));
        }
    });

    test('opus output of other audio names the missing encoder, substituting nothing', async () => {
        const support = await check(await inputs.adts(), 'opus');
        assert.deepEqual(
            [support.supported, support.code, support.warnings],
            [false, 'ENCODE', []],
        );
        assert.match(support.reason, /opus output holds Opus audio only, which this host cannot/);
        assert.match(support.hint, /Convert to 'ogg'/);
    });
});

describe('pipeline/plan: what a target asks of the pictures and the container', () => {
    test('a change of pixels rules out a copy; a rotation the container stores does not', () => {
        const track = { info: { width: 64, height: 48 } };
        for (const [request, reshapes] of [
            [{ format: 'mp4' }, false],
            [{ format: 'mp4', width: 64, height: 48 }, false],
            [{ format: 'mp4', width: 32 }, true],
            [{ format: 'mp4', crop: { left: 2 } }, true],
            [{ format: 'mkv', flip: 'horizontal' }, true],
            [{ format: 'mp4', rotate: 90 }, false],
            [{ format: 'webm', rotate: 180 }, false],
            [{ format: 'ts', rotate: 90 }, true],
            [{ format: 'avi', rotate: 270 }, true],
        ])
            assert.equal(reshapesVideo(request, track), reshapes, JSON.stringify(request));
    });

    test('a size is of the picture shown: a quarter turn is not a copy at the stored width', () => {
        const track = { info: { width: 64, height: 48 } };
        const turned = { info: { width: 64, height: 48, rotation: 90 } };
        for (const [request, source, reshapes] of [
            [{ format: 'mp4', rotate: 90, width: 64 }, track, true],
            [{ format: 'mp4', rotate: 90, width: 48, height: 64 }, track, false],
            [{ format: 'mp4', width: 64 }, turned, true],
            [{ format: 'mp4', width: 48 }, turned, false],
            [{ format: 'mp4', rotate: 90, width: 64, height: 48 }, turned, false],
            [{ format: 'mp4', width: 64, autoRotate: false }, turned, false],
        ])
            assert.equal(reshapesVideo(request, source), reshapes, JSON.stringify(request));
    });

    test('a profile the host cannot encode takes another of its codec first', async () => {
        // Chromium encodes H.264 High and HEVC, not 4:4:4 H.264.
        const host = installVideoCodecs({
            encodeSupport: config => /^(?:avc1\.64|hvc1)/.test(config.codec),
        });
        try {
            const query = { width: 640, height: 360 };
            const choice = await encodableVideoCodec('avc1.f4001e', 'mp4', query);
            assert.equal(choice.substituted, true);
            assert.match(choice.codec, /^avc1\.64/);
            // A profile the request names is kept: another codec stands in for it.
            const named = { ...query, explicit: true };
            assert.match((await encodableVideoCodec('avc1.f4001e', 'mp4', named)).codec, /^hvc1/);
        } finally {
            host.restore();
        }
    });

    test('the container a range keeps, the codec of an audio format, the video formats', () => {
        assert.deepEqual(['mov', 'mkv', 'mxf', 'png'].map(sameContainer), [
            'mov',
            'mkv',
            'mp4',
            'mp4',
        ]);
        assert.deepEqual(['aac', 'wav', 'flac', 'mp4'].map(audioFormatCodec), [
            'mp4a.40.2',
            'pcm-s16',
            'flac',
            undefined,
        ]);
        assert.deepEqual([...FRAME_ENCODE_FORMATS], ['mp4', 'mov', 'm4v', 'webm', 'mkv']);
    });
});

describe('pipeline/plan: one plan per operation', () => {
    const clip = () => new Blob([webmClip({ frames: 30 })]);
    const wav = () => new Blob([waveFixture()]);

    /** The plan of convert(), checked to be the one check() and onPlan report. */
    async function planOf(input, target) {
        const checked = await check(input, target);
        assert.ok(checked.supported, checked.reason);
        let reported;
        const result = await convert(input, { ...target, onPlan: plan => (reported = plan) });
        assert.deepEqual(checked.plan, result.plan, 'check() plans as convert() does');
        assert.deepEqual(reported, result.plan, 'onPlan receives the plan');
        return result.plan;
    }

    for (const [name, input, target, expected] of [
        ['a copy', clip, { to: 'mkv' }, ['copy', 'video:copy:vp09', 'audio:copy:opus']],
        [
            'a range',
            clip,
            { to: 'webm', start: 0.5, end: 0.8 },
            ['copy', 'video:copy:vp09', 'audio:copy:opus'],
        ],
        ['a muted copy', clip, { to: 'webm', audio: { mute: true } }, ['copy', 'video:copy:vp09']],
        ['an audio container', clip, { to: 'ogg' }, ['copy', 'audio:copy:opus']],
        ['an audio file', wav, { to: 'flac' }, ['reencode', 'audio:encode:flac']],
        ['an audio re-encode', wav, { to: 'm4a' }, ['reencode', 'audio:encode:mp4a']],
    ])
        test(`check(), onPlan and the result agree on ${name}`, async () => {
            assert.deepEqual(shape(await planOf(input(), target)), expected);
        });

    test('the plan of a range lasts as long as the range', async () => {
        const plan = await planOf(clip(), { to: 'webm', start: 0.5, end: 0.8 });
        assert.ok(Math.abs(plan.duration - 0.3) < 1e-9);
    });

    test('packageMedia() and edit() report their plans the same way', async () => {
        const packaged = await check(clip(), 'hls');
        assert.deepEqual(shape(packaged.plan), ['package', 'video:copy:vp09', 'audio:copy:opus']);
        assert.deepEqual((await packageMedia(clip(), 'hls')).plan, packaged.plan);
        const joined = await edit({ clips: [{ input: wav() }, { input: wav() }] }, { to: 'wav' });
        assert.deepEqual(shape(joined.plan), ['reencode', 'audio:encode:pcm-s16']);
    });

    describe('with a host video encoder', () => {
        test('a video re-encode copies the sound beside it, keeping their offset', async () => {
            const host = installVideoCodecs();
            try {
                const target = { to: 'webm', video: { codec: 'vp8' } };
                assert.deepEqual(shape(await planOf(clip(), target)), [
                    'reencode',
                    'video:encode:vp8',
                    'audio:copy:opus',
                ]);
                // The Opus starts 6.5 ms before the pictures (its CodecDelay); the re-encoded
                // pictures stay 6.5 ms after the copied sound.
                const lead = async blob => {
                    const media = await open(blob);
                    const first = {};
                    for await (const packet of media.packets())
                        first[packet.trackId] = Math.min(
                            first[packet.trackId] ?? Infinity,
                            packet.timestamp,
                        );
                    media.close();
                    return first[1] - first[2];
                };
                assert.ok(Math.abs((await lead(clip())) - 0.0065) < 1e-6);
                const reencoded = await convert(clip(), target);
                const offset = await lead(reencoded.blob);
                assert.ok(Math.abs(offset - 0.0065) < 0.0015, `${offset} s`);
                assert.deepEqual(shape((await check(clip(), 'png')).plan), ['image']);
                host.assertClosed();
            } finally {
                host.restore();
            }
        });

        test('a range of re-encoded video re-encodes its sound too', async () => {
            const host = installVideoCodecs();
            // A host AudioEncoder that only answers support checks lets the plan form.
            globalThis.AudioData = class {};
            globalThis.AudioEncoder = class {
                static async isConfigSupported(config) {
                    return { supported: true, config };
                }
            };
            let ranged;
            try {
                await convert(clip(), {
                    to: 'webm',
                    start: 0.5,
                    end: 0.8,
                    video: { codec: 'vp8' },
                    onPlan: plan => (ranged = plan),
                }).catch(() => undefined);
            } finally {
                delete globalThis.AudioEncoder;
                delete globalThis.AudioData;
                host.restore();
            }
            assert.deepEqual(shape(ranged), ['reencode', 'video:encode:vp8', 'audio:encode:opus']);
        });
    });
});
