import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
// How the API reads a target before any input is read; internal to the API.
import { OPERATION_TARGETS, resolveTarget, targetClassOf } from '../../dist/esm/api/target.js';
import { warningOf } from '../../dist/esm/api/options/options.js';
import { OptionNormalizer } from '../../dist/esm/core/errors/option-policy.js';
import { codes } from '../helpers/api-fixtures.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';

// What a target asks for: its kind (copy, audio file, conversion, picture, package), its format,
// the engine request, and the findings about settings that do not apply to it.

const inputError = error => error.code === 'INPUT';

/** How a target resolves before any input is read: kind, format, request and findings. */
function plan(target, policy = 'lenient') {
    const normalizer = new OptionNormalizer(policy, 'target');
    const resolved = resolveTarget(target, normalizer);
    const request = resolved.target?.request ?? resolved.package;
    return { ...resolved, request, warnings: normalizer.findings.map(warningOf) };
}

describe('api targets', () => {
    test('a target resolves to its kind and format; settings that do not apply', () => {
        const plans = [
            [{ to: 'MKV' }, 'remux', 'mkv', []],
            [{ format: 'mp4' }, 'remux', 'mp4', ['OPTION_NORMALIZED']],
            [{ to: '.mp4', trackIds: [1] }, 'remux', 'mp4', []],
            [
                { to: 'wav', audio: { sampleRate: 44100, bitrate: 128 } },
                'audio',
                'wav',
                ['OPTION_NORMALIZED'],
            ],
            [{ to: 'mp3', audio: { bitrate: 128000 } }, 'audio', 'mp3', []],
            [{ to: 'mp3', audio: { codec: 'aac' } }, 'audio', 'mp3', ['OPTION_IGNORED']],
            [{ to: 'aac', audio: { codec: 'mp4a.40.2' } }, 'audio', 'aac', []],
            [{ to: 'm4a', audio: { codec: 'vorbis' } }, 'convert', 'm4a', ['OPTION_IGNORED']],
            [{ to: 'm4a', audio: { codec: 'opus' } }, 'convert', 'm4a', []],
            [{ to: 'm4a', audio: { codec: 'flac' } }, 'convert', 'm4a', []],
            [{ to: 'm4a', audio: { codec: 'mp3' } }, 'convert', 'm4a', []],
            [
                { to: 'png', image: { quality: 0.5 }, video: { width: 10 } },
                'image',
                'png',
                ['OPTION_IGNORED'],
            ],
            [{ to: 'jpg', audio: { channels: 1 } }, 'image', 'jpeg', ['OPTION_IGNORED']],
            [{ to: 'hls', container: 'ts', targetDuration: 2 }, 'package', 'hls', []],
            [{ to: 'hls', start: 1, end: 2 }, 'package', 'hls', ['OPTION_IGNORED']],
            [{ to: 'dash', video: { width: 1 } }, 'package', 'dash', ['OPTION_IGNORED']],
            [{ to: 'mp4', video: { width: 320 } }, 'convert', 'mp4', []],
            [
                { to: 'mp4', copy: false, audio: { vbr: true } },
                'convert',
                'mp4',
                ['OPTION_IGNORED'],
            ],
            [{ to: 'mp4', start: 1 }, 'remux', 'mp4', []],
            [{ to: 'mp4', start: 2, end: 1 }, 'remux', 'mp4', ['OPTION_IGNORED']],
            [
                { to: 'flac', video: { width: 1 }, trackIds: [2, 3] },
                'audio',
                'flac',
                ['OPTION_IGNORED', 'OPTION_NORMALIZED'],
            ],
            [
                { to: 'mp4', container: 'ts', image: { quality: 1 } },
                'remux',
                'mp4',
                ['OPTION_IGNORED', 'OPTION_IGNORED'],
            ],
        ];
        for (const [target, kind, format, expected] of plans) {
            const label = JSON.stringify(target);
            const resolved = plan(target);
            assert.deepEqual([resolved.kind, resolved.format], [kind, format], label);
            assert.deepEqual(codes(resolved.warnings), expected, label);
            if (kind !== 'image') assert.equal(resolved.request.format, format, label);
        }
    });

    test('the requests carry the settings that apply', () => {
        assert.equal(plan({ to: 'wav', audio: { bitrate: 128 } }).request.bitrate, 128_000);
        assert.equal(plan({ to: 'mp3', audio: { bitrate: 128000 } }).request.bitrate, 128_000);
        assert.equal(plan({ to: 'mp4', video: { bitrate: 2500 } }).request.videoBitrate, 2_500_000);
        assert.equal(plan({ to: 'flac', trackIds: [2, 3] }).request.trackId, 2);
        assert.equal(
            plan({ to: 'png', image: { quality: 0.5 }, video: { width: 10 } }).image.width,
            10,
        );
        assert.equal(plan({ to: 'hls', container: 'ts' }).request.container, 'ts');
    });

    test('strictly, a range backwards or an old key fails; a container range passes', () => {
        assert.throws(() => plan({ to: 'mp4', start: 2, end: 1 }, 'strict'), inputError);
        assert.equal(plan({ to: 'mp4', start: 1 }, 'strict').request.start, 1);
        assert.throws(() => plan({ format: 'mp4' }, 'strict'), inputError);
        assert.equal(plan({ to: 'mp4' }, 'strict').kind, 'remux');
    });

    test('a target that is no object or names no format fails check() with INPUT', async () => {
        for (const target of [null, [], { to: '' }, { to: 42 }]) {
            const refused = await new MediaForge().check(waveFixture(), target);
            assert.equal(refused.code, 'INPUT', JSON.stringify(target));
        }
    });

    test('a target without `to` keeps the input container', async () => {
        assert.equal((await new MediaForge().check(waveFixture(), {})).plan.format, 'wav');
    });

    test('picture transforms are repaired to the nearest meaning and reported', () => {
        const plans = [
            [
                {
                    to: 'mp4',
                    video: { crop: { x: 0, y: 0, width: 64, height: 48 }, rotate: 90, flip: 'h' },
                },
                ['OPTION_NORMALIZED'],
            ],
            [{ to: 'mp4', video: { rotate: 45 } }, ['OPTION_NORMALIZED']],
            [{ to: 'mp4', video: { width: 320, fit: 'contain' } }, ['OPTION_IGNORED']],
            [
                { to: 'mp4', video: { crop: { width: 0, height: 10 } } },
                ['OPTION_IGNORED', 'OPTION_IGNORED'],
            ],
            [{ to: 'mp4', video: { width: 320, height: 240, fit: 'zoom' } }, ['OPTION_IGNORED']],
            [{ to: 'png', video: { rotate: 90, keyframeInterval: 1 } }, ['OPTION_IGNORED']],
        ];
        for (const [target, expected] of plans)
            assert.deepEqual(codes(plan(target).warnings), expected, JSON.stringify(target));
        const repaired = plan({
            to: 'mp4',
            video: { rotate: -90, flip: 'mirror', width: 64, height: 64, fit: 'pad' },
        });
        assert.deepEqual(
            [repaired.request.rotate, repaired.request.flip, repaired.request.fit],
            [270, 'horizontal', 'contain'],
        );
        assert.equal(
            plan({ to: 'mp4', video: { width: 320, fit: 'cover' } }).request.fit,
            undefined,
        );
    });

    test('strictly, a rotation that is no quarter turn fails; a quarter turn passes', () => {
        assert.throws(() => plan({ to: 'mp4', video: { rotate: 45 } }, 'strict'), inputError);
        assert.equal(plan({ to: 'mp4', video: { rotate: 180 } }, 'strict').request.rotate, 180);
    });

    test('still pictures carry their drawing settings', () => {
        const drawing = plan({
            to: 'jpg',
            image: { quality: 0.9, fit: 'inside' },
            video: { width: 64, height: 32 },
        });
        assert.deepEqual(
            [
                drawing.kind,
                drawing.format,
                drawing.image.quality,
                drawing.image.fit,
                drawing.image.width,
                drawing.image.height,
            ],
            ['image', 'jpeg', 0.9, 'inside', 64, 32],
        );
    });
});

describe('api targets: the classes each operation takes', () => {
    test('every public operation declares its target classes, each with its formats', async () => {
        const forge = await import('mediaforgejs');
        const operations = Object.keys(forge)
            .filter(
                name =>
                    typeof forge[name] === 'function' &&
                    typeof forge.MediaForge.prototype[name] === 'function',
            )
            .sort();
        assert.deepEqual(Object.keys(OPERATION_TARGETS).sort(), operations);
        for (const [operation, classes] of Object.entries(OPERATION_TARGETS)) {
            assert.ok(Object.keys(classes).length, `${operation} declares a class`);
            for (const [targetClass, formats] of Object.entries(classes)) {
                assert.equal(targetClass === 'none', !formats.length, operation);
                for (const format of formats)
                    assert.equal(targetClassOf(format), targetClass, `${operation} ${format}`);
            }
        }
        // A target of each format resolves to the kind of its class.
        for (const [targetClass, formats] of Object.entries(OPERATION_TARGETS.check))
            for (const format of formats) {
                const { kind } = plan({ to: format });
                assert.equal(
                    kind === 'remux' || kind === 'convert' ? 'container' : kind,
                    targetClass,
                    format,
                );
            }
    });

    test('an operation refuses the target classes it does not take, with INPUT', async () => {
        const forge = new MediaForge();
        const wave = waveFixture();
        await assert.rejects(forge.convert(wave, 'hls'), inputError);
        await assert.rejects(forge.packageMedia(wave, 'mp4'), inputError);
        await assert.rejects(forge.edit({ clips: [{ input: wave }] }, 'png'), inputError);
    });
});

describe('api targets: keys, bitrates and codec names', () => {
    test('misspelled keys are reported and do not turn a copy into a conversion', () => {
        const misspelled = plan({ to: 'mp4', bitrat: 5, video: { widht: 3 } });
        assert.deepEqual(codes(misspelled.warnings), ['OPTION_UNKNOWN', 'OPTION_UNKNOWN']);
        assert.equal(misspelled.kind, 'remux');
    });

    test('an unknown format is refused before any work', () => {
        assert.throws(() => plan({ to: 'xyz' }), inputError);
    });

    test('an unknown key names the option probably meant', () => {
        assert.match(
            plan({ to: 'mp4', video: { bitrat: 1 } }).warnings[0].message,
            /did you mean bitrate\?/,
        );
    });

    test('bitrates read text with a unit; ambiguous numbers are reported once', () => {
        assert.equal(
            plan({ to: 'mp4', video: { bitrate: '2.5M' } }).request.videoBitrate,
            2_500_000,
        );
        assert.equal(
            plan({ to: 'mp4', video: { bitrate: '800 kbps' } }).request.videoBitrate,
            800_000,
        );
        assert.equal(plan({ to: 'mp3', audio: { bitrate: '0.128M' } }).request.bitrate, 128_000);
        const video = plan({ to: 'mp4', video: { bitrate: 50000 } });
        assert.equal(video.request.videoBitrate, 50000);
        assert.deepEqual(codes(video.warnings), ['OPTION_NORMALIZED']);
        const audio = plan({ to: 'mp3', audio: { bitrate: 5000 } });
        assert.equal(audio.request.bitrate, 5000, 'read as bits per second');
        assert.ok(codes(audio.warnings).includes('OPTION_NORMALIZED'));
        assert.deepEqual(codes(plan({ to: 'mp4', video: { bitrate: 'fast' } }).warnings), [
            'OPTION_IGNORED',
        ]);
    });

    test('strictly, a kbit/s reading of a bitrate fails', () => {
        assert.throws(() => plan({ to: 'mp3', audio: { bitrate: 192 } }, 'strict'), inputError);
    });

    test('everyday codec names map onto codec strings', () => {
        assert.equal(plan({ to: 'mp4', video: { codec: 'h264' } }).request.videoCodec, 'avc1');
        assert.equal(plan({ to: 'mkv', video: { codec: 'HEVC' } }).request.videoCodec, 'hvc1');
        assert.equal(
            plan({ to: 'webm', video: { codec: 'vp9' }, audio: { codec: 'aac' } }).request
                .audioCodec,
            'mp4a.40.2',
        );
    });

    test('codecPreference names map onto the policy', () => {
        assert.equal(
            plan({ to: 'wav', codecPreference: 'builtin' }).request.codecPreference,
            'builtin',
        );
        assert.equal(
            plan({ to: 'mp4', video: { width: 8 }, codecPreference: 'library' }).request
                .codecPreference,
            'builtin',
        );
    });

    test('host encoder settings map onto WebCodecs values', () => {
        const { request } = plan({
            to: 'mp4',
            video: {
                width: 64,
                hardwareAcceleration: 'gpu',
                latencyMode: 'realtime',
                bitrateMode: 'cbr',
            },
        });
        assert.deepEqual(
            [request.hardwareAcceleration, request.latencyMode, request.bitrateMode],
            ['prefer-hardware', 'realtime', 'constant'],
        );
    });

    test('picture targets keep the geometry used for pictures from video', () => {
        const images = plan({
            to: 'png',
            video: { crop: { x: 0, y: 0, width: 2, height: 2 }, rotate: 90 },
        });
        assert.deepEqual(codes(images.warnings), []);
    });
});
