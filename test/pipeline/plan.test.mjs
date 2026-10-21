import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { check, convert, frames as decodeFrames, inspect, open } from 'mediaforgejs';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { AC3_FIXTURES } from '../helpers/ac3-fixtures.mjs';
import { codes, movie, reopen, toneWav, vp8Clip } from '../helpers/api-fixtures.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

/** The bytes of every packet of the first track of a file. */
async function allPackets(blob) {
    const media = await open(blob);
    try {
        const bytes = [];
        for await (const packet of media.packets({ trackIds: [media.tracks[0].id] }))
            bytes.push(...packet.data);
        return bytes;
    } finally {
        media.close();
    }
}

// The plan of a conversion: what each track undergoes (copy or encode), with which codec and
// encoder, decided on the input before anything is written.

const clip = () => new File([movie()], 'holiday clip.mp4', { type: 'video/mp4' });

describe('pipeline/plan', () => {
    describe('codecs', () => {
        test("a codec name that matches the source copies it ('h264' for H.264)", async () => {
            const renamed = await check(clip(), { to: 'mp4', video: { codec: 'h264' } });
            assert.deepEqual([renamed.supported, renamed.plan.action], [true, 'copy']);
        });

        test('an audio format plans its own codec', async () => {
            const good = await check(toneWav(), 'mp3');
            assert.deepEqual([good.supported, good.plan.tracks[0].codec], [true, 'mp3']);
        });

        test("codec 'auto' without a host video encoder copies, reported", async () => {
            const warnings = [];
            const autoCopy = await convert(clip(), 'mkv', {
                video: { codec: 'auto' },
                onWarning: warning => warnings.push(warning),
            });
            assert.equal(autoCopy.plan.action, 'copy');
            assert.ok(codes(warnings).includes('OPTION_NORMALIZED'));
        });

        test("codec 'auto' for MKV audio without host Opus takes the built-in AAC", async () => {
            const autoAudio = await convert(toneWav(), 'mkv', { audio: { codec: 'auto' } });
            assert.deepEqual(
                autoAudio.plan.tracks.map(track => [track.action, track.codec, track.encoder]),
                [['encode', 'mp4a.40.2', 'builtin']],
            );
            assert.match((await reopen(autoAudio.blob)).tracks[0].codec, /^mp4a/);
        });
    });
});

describe('pipeline/plan: host video encoders', () => {
    let host;
    before(() => {
        host = installVideoCodecs({ encodeSupport: config => config.codec.startsWith('vp09') });
    });
    after(() => host.restore());

    /** The movie's video track ids; Node has no Opus encoder, so only video is converted. */
    const pictures = async clip =>
        (await inspect(clip)).tracks.filter(track => track.type === 'video').map(track => track.id);

    test("codec 'auto' asks the host", async () => {
        const clip = movie();
        const chosen = [];
        await convert(clip, 'webm', {
            trackIds: await pictures(clip),
            video: { codec: 'auto' },
            onPlan: report => chosen.push(report),
        });
        assert.match(chosen[0].tracks.find(track => track.type === 'video').codec, /^vp09/);
    });

    test('a codec the host cannot encode is replaced, reported', async () => {
        const clip = movie();
        const ids = await pictures(clip);
        const substituted = await convert(clip, 'webm', { trackIds: ids, video: { codec: 'vp8' } });
        assert.deepEqual(
            substituted.warnings
                .filter(warning => warning.code === 'CODEC_SUBSTITUTED')
                .map(warning => warning.trackId),
            ids,
        );
        assert.match(substituted.plan.tracks[0].codec, /^vp09/);
        assert.match((await inspect(substituted.blob)).tracks[0].codec, /^vp09/);
    });

    test('strictly, the replacement fails with ENCODE naming the codec', async () => {
        const clip = movie();
        await assert.rejects(
            convert(clip, 'webm', {
                trackIds: await pictures(clip),
                video: { codec: 'vp8' },
                optionPolicy: 'strict',
            }),
            error => error.code === 'ENCODE' && /vp8/.test(error.message),
        );
    });

    test('VideoFrame output carries microsecond timestamps', async () => {
        const frames = [];
        for await (const frame of decodeFrames(movie(), {
            format: 'videoframe',
            times: [0, 0.2],
        })) {
            frames.push(frame.timestamp);
            frame.close();
        }
        assert.deepEqual(frames, [0, 200000]);
        host.assertClosed();
    });
});

describe('pipeline/plan: copy: false', () => {
    /** One second of stereo AAC-LC in ADTS. */
    const aac = async () => {
        const planes = [0, 1].map(channel =>
            Float32Array.from(
                { length: 24000 },
                (_, index) => 0.3 * Math.sin((index * 2 + channel) / 9),
            ),
        );
        return new Blob([wrapAdts(await encodeAacLc(planes, { sampleRate: 48000, bitrate: 160 }))]);
    };

    for (const to of ['mp4', 'mkv', 'm4a'])
        test(`${to}: every kept track is encoded again; the plans agree`, async () => {
            const input = await aac();
            const support = await check(input, { to, copy: false });
            assert.equal(support.supported, true, support.reason);
            let planned;
            const result = await convert(input, {
                to,
                copy: false,
                onPlan: report => (planned = report),
            });
            assert.deepEqual(support.plan, result.plan);
            assert.deepEqual(planned, result.plan);
            assert.equal(result.plan.action, 'reencode');
            assert.deepEqual(
                result.plan.tracks.map(track => [track.action, track.codec, track.encoder]),
                [['encode', 'mp4a.40.2', 'builtin']],
            );
            const copied = await convert(input, to);
            assert.equal(copied.plan.action, 'copy', 'without copy: false the track is copied');
            assert.notDeepEqual(await allPackets(result.blob), await allPackets(copied.blob));
            const [encoded, kept] = await Promise.all(
                [result.blob, copied.blob].map(blob => inspect(blob)),
            );
            assert.ok(Math.abs(encoded.tracks[0].duration - kept.tracks[0].duration) < 0.05);
        });

    test('a track the host cannot encode fails the target instead of being copied', async () => {
        const wav = new Blob([waveFixture()]);
        const refused = await check(wav, { to: 'webm', copy: false });
        assert.equal(refused.supported, false, 'WebM sound needs an Opus encoder');
        await assert.rejects(
            convert(wav, { to: 'webm', copy: false }),
            error => error.code === refused.code,
        );
        assert.equal((await check(wav, 'mkv')).plan.action, 'copy');
    });
});

describe('pipeline/plan: copy: true', () => {
    test('settings that need a re-encode fail with INPUT', async () => {
        const { blob: m4a } = await convert(toneWav(), 'm4a');
        const refused = await convert(m4a, 'mkv', {
            copy: true,
            audio: { bitrate: 96000 },
        }).catch(error => error);
        assert.equal(refused.code, 'INPUT');
    });

    test('an audio format that cannot take the track as it is fails, not re-encodes', async () => {
        const { blob: m4a } = await convert(toneWav(), 'm4a');
        const support = await check(m4a, 'mp3', { copy: true });
        assert.deepEqual([support.supported, support.code], [false, 'FORMAT']);
        const refused = await convert(m4a, 'mp3', { copy: true }).catch(error => error);
        assert.equal(refused.code, 'FORMAT');
        assert.match(refused.hint, /copy: true/);
        const encoded = await check(m4a, 'mp3');
        assert.deepEqual(
            encoded.plan.tracks.map(track => [track.action, track.codec]),
            [['encode', 'mp3']],
            'without copy: true the sound is encoded',
        );
    });

    test('an audio format that copies the track as it is copies it', async () => {
        const { blob: m4a } = await convert(toneWav(), 'm4a');
        const copied = await check(m4a, 'aac', { copy: true });
        assert.deepEqual(
            copied.plan.tracks.map(track => track.action),
            ['copy'],
        );
    });
});

describe('pipeline/plan: what the host video encoder is asked', () => {
    const names = [
        'VideoDecoder',
        'VideoEncoder',
        'VideoFrame',
        'EncodedVideoChunk',
        'OffscreenCanvas',
    ];
    let saved;
    /** Every configuration asked of the host encoder, which supports none. */
    let asked;
    before(() => {
        saved = new Map(
            names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
        );
        asked = [];
        Object.assign(globalThis, {
            VideoDecoder: class {
                static async isConfigSupported(config) {
                    return { supported: true, config };
                }
            },
            VideoEncoder: class {
                static async isConfigSupported(config) {
                    asked.push(config);
                    return { supported: false, config };
                }
                constructor() {
                    throw new Error('an unsupported encoder is never made');
                }
            },
            VideoFrame: class {},
            EncodedVideoChunk: class {},
            OffscreenCanvas: class {},
        });
    });
    after(() => {
        for (const [name, descriptor] of saved)
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
    });
    const of = prefix => asked.filter(config => config.codec.startsWith(prefix));

    test('the settings of the request, in WebCodecs terms', async () => {
        asked.length = 0;
        const target = {
            to: 'mkv',
            video: { width: 8, height: 8, codec: 'vp8', fps: 12, bitrate: 150000 },
        };
        const support = await check(await vp8Clip(), target);
        assert.deepEqual([support.supported, support.code], [false, 'ENCODE']);
        assert.deepEqual(of('vp8').at(-1), {
            codec: 'vp8',
            width: 8,
            height: 8,
            framerate: 12,
            bitrate: 150000,
            latencyMode: 'quality',
            hardwareAcceleration: 'no-preference',
        });
    });

    test('H.264 at 1080p 25 fps asks for level 4.0 in each profile, the sides even', async () => {
        asked.length = 0;
        const large = await check(await vp8Clip(), {
            to: 'mkv',
            video: { codec: 'avc1', width: 1920, height: 1081, fps: 25 },
        });
        assert.equal(large.code, 'ENCODE');
        assert.deepEqual(
            [...new Set(of('avc1').map(config => config.codec))],
            ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'],
        );
        const config = of('avc1').at(-1);
        assert.equal(config.height, 1082, 'odd sides are rounded to even');
        assert.ok(config.bitrate > 3_000_000 && config.bitrate < 7_000_000, `${config.bitrate}`);
        assert.ok(
            large.warnings.some(
                warning => warning.code === 'OPTION_NORMALIZED' && /1081/.test(warning.message),
            ),
        );
    });

    test('a named profile is kept, only its level raised', async () => {
        asked.length = 0;
        await check(await vp8Clip(), {
            to: 'mkv',
            video: { codec: 'avc1.4d401e', width: 1920, height: 1080 },
        });
        assert.deepEqual([...new Set(of('avc1').map(config => config.codec))], ['avc1.4d4028']);
    });

    test('an encoder whose support check throws counts as none', async () => {
        const encoder = globalThis.VideoEncoder;
        const original = encoder.isConfigSupported;
        encoder.isConfigSupported = async () => {
            throw new TypeError('Unknown native encoder configuration');
        };
        try {
            const target = { to: 'mkv', video: { width: 8, height: 8, codec: 'vp8' } };
            const rejected = await check(await vp8Clip(), target);
            assert.deepEqual([rejected.supported, rejected.code], [false, 'ENCODE']);
        } finally {
            encoder.isConfigSupported = original;
        }
    });
});

describe('pipeline/plan: audio codec names', () => {
    const g711 = () =>
        new Blob([readFileSync(new URL('../fixtures/pcm/g711-source.wav', import.meta.url))]);

    test('G.711 asked of a container without it is ignored and reported', async () => {
        const warnings = [];
        const { blob } = await convert(g711(), 'flac', {
            copy: false,
            audio: { codec: 'mu-law' },
            onWarning: warning => warnings.push(warning.code),
        });
        assert.ok(blob.size > 0);
        assert.ok(warnings.includes('OPTION_IGNORED'));
    });

    test("'pcm_mulaw' names mu-law: AU writes encoding 1", async () => {
        const { blob } = await convert(g711(), 'au', {
            copy: false,
            audio: { codec: 'pcm_mulaw' },
        });
        assert.equal(new DataView(await blob.arrayBuffer()).getUint32(12), 1);
    });

    test('strictly, G.711 asked of MP3 fails with INPUT', async () => {
        const target = { copy: false, audio: { codec: 'ulaw' }, optionPolicy: 'strict' };
        await assert.rejects(convert(g711(), 'mp3', target), error => error.code === 'INPUT');
    });

    describe('AC-3, which the library decodes but does not encode', () => {
        const ac3 = () =>
            new Blob([AC3_FIXTURES.find(entry => entry.name === 'stereo-48000-96k').bytes()]);

        for (const target of [
            { to: 'mp4', copy: false },
            { to: 'mov', copy: false },
            { to: 'm4a', audio: { bitrate: 96000 } },
            { to: 'ts', audio: { channels: 1 } },
        ])
            test(`a re-encode into ${target.to} naming no codec writes AAC`, async () => {
                const result = await convert(ac3(), target);
                assert.deepEqual(
                    result.plan.tracks.map(track => [track.action, track.codec]),
                    [['encode', 'mp4a.40.2']],
                );
                assert.equal((await inspect(result.blob)).tracks[0].codec, 'mp4a.40.2');
            });

        test('naming AC-3 for a re-encode fails, naming it', async () => {
            await assert.rejects(
                convert(ac3(), { to: 'mp4', audio: { codec: 'ac-3', bitrate: 96000 } }),
                /ac-3 audio can be copied but not encoded here/,
            );
        });
    });
});
