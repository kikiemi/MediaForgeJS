import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, inspect, open } from 'mediaforgejs';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { Mp4Demuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink, ReadableStreamSink } from 'mediaforgejs/io';
// How the API reads a target before any input is read; internal to the API.
import { resolveTarget } from '../../dist/esm/api/target.js';
import { OptionNormalizer } from '../../dist/esm/core/errors/option-policy.js';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';
import { aacMatroska, movie } from '../helpers/api-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';

// Options of every call: permissive by default (repairs and unknown keys are reported as
// warnings), strict with optionPolicy: 'strict' (they fail with INPUT); every setting is read once.

const codesOf = findings => findings.map(finding => finding.code);
const sorted = list => [...list].sort();
const inputError = error => error.code === 'INPUT';
const lenient = () => new OptionNormalizer();
const strict = () => new OptionNormalizer('strict');
/** The engine request a target resolves to. */
const request = (target, normalizer = lenient()) => {
    const resolved = resolveTarget(target, normalizer);
    return resolved.target?.request ?? resolved.package;
};

describe('api options', () => {
    describe('open options', () => {
        test('repairs and unknown keys are reported and kept with the input', async () => {
            const warnings = [];
            const media = await open(waveFixture(), {
                cacheBytes: '65536',
                readPageBytes: 0,
                unknownKey: 1,
                MAXSAMPLES: 100,
                validation: 'lenient',
                onWarning: warning => warnings.push(warning),
            });
            try {
                assert.equal(media.tracks[0].sampleRate, 8000);
                assert.deepEqual(sorted(codesOf(warnings)), [
                    'OPTION_IGNORED',
                    'OPTION_NORMALIZED',
                    'OPTION_NORMALIZED',
                    'OPTION_NORMALIZED',
                    'OPTION_UNKNOWN',
                ]);
                const messages = warnings.map(warning => warning.message).join('\n');
                for (const name of [
                    'cacheBytes',
                    'readPageBytes',
                    'unknownKey',
                    'MAXSAMPLES',
                    'validation',
                ])
                    assert.match(messages, new RegExp(name), name);
                assert.deepEqual(codesOf(media.warnings), codesOf(warnings));
            } finally {
                media.close();
            }
        });

        test('strict validation refuses what a lenient open repairs', async () => {
            for (const options of [
                { unknownKey: 1 },
                { cacheBytes: '1' },
                { maxSamples: 1.5 },
                { metadataPolicy: 'loud' },
            ])
                await assert.rejects(
                    open(waveFixture(), { ...options, validation: 'strict' }),
                    inputError,
                    JSON.stringify(options),
                );
        });

        test('each option is read once', async () => {
            let reads = 0;
            const media = await open(waveFixture(), {
                get cacheBytes() {
                    reads++;
                    return 0;
                },
            });
            media.close();
            assert.equal(reads, 1);
        });

        test('options that are no object fail with INPUT', async () => {
            for (const options of [null, [], 'strict'])
                await assert.rejects(open(waveFixture(), options), inputError);
        });

        test('an index over maxIndexBytes or maxSamples fails the open with OOM', async () => {
            const encoded = await encodeAacLc([new Float32Array(4096)], { sampleRate: 48000 });
            const adts = wrapAdts(encoded);
            const frames = encoded.frames.length;
            const bounded = await open(adts, { maxSamples: frames, maxIndexBytes: frames * 256 });
            let packets = 0;
            for await (const packet of bounded.packets()) packets += packet.data.length > 0;
            bounded.close();
            assert.equal(packets, frames);
            const oneSample = {
                formats: ['custom'],
                async read() {
                    const data = Uint8Array.of(1);
                    const sample = { offset: 0, size: 1, timestamp: 0, duration: 1, data };
                    const track = { id: 1, codec: 'mp3', duration: 1, sampleRate: 48000 };
                    const samples = [{ ...sample, isKeyframe: true }];
                    const audio = { ...track, channelCount: 1, width: 0, height: 0, samples };
                    return { duration: 1, videoTracks: [], audioTracks: [audio] };
                },
            };
            const custom = new MediaForge({
                plugins: { add: [{ name: 'custom', readers: [readerPart(oneSample)] }] },
            });
            for (const options of [{ maxIndexBytes: 9 }, { maxSamples: 1 }])
                await assert.rejects(open(adts, options), error => error.code === 'OOM');
            await assert.rejects(
                custom.open(Uint8Array.of(1), { format: 'custom', maxIndexBytes: 1 }),
                error => error.code === 'OOM',
            );
        });

        test('an unusable index budget is ignored, a fractional one rounded', async () => {
            const encoded = await encodeAacLc([new Float32Array(4096)], { sampleRate: 48000 });
            const adts = wrapAdts(encoded);
            const enough = encoded.frames.length * 256;
            for (const [value, code] of [
                [0, 'OPTION_IGNORED'],
                [-1, 'OPTION_IGNORED'],
                [Infinity, 'OPTION_IGNORED'],
                [enough + 0.5, 'OPTION_NORMALIZED'],
            ]) {
                const warnings = [];
                const media = await open(adts, {
                    maxIndexBytes: value,
                    onWarning: warning => warnings.push(warning),
                });
                media.close();
                assert.deepEqual(codesOf(warnings), [code], String(value));
                await assert.rejects(
                    open(adts, { maxIndexBytes: value, validation: 'strict' }),
                    inputError,
                );
            }
            const warnings = [];
            await assert.rejects(
                open(adts, { maxIndexBytes: 1.5, onWarning: warning => warnings.push(warning) }),
                error => error.code === 'OOM',
            );
            assert.deepEqual(codesOf(warnings), ['OPTION_NORMALIZED'], 'rounded, then enforced');
            const unset = await open(adts, { maxIndexBytes: null, onWarning: assert.fail });
            unset.close();
        });
    });

    describe('targets', () => {
        test('a container target copies the chosen tracks once each', () => {
            const remux = request({ to: 'matroska', trackIds: [1, 1, 'x'] });
            assert.deepEqual(
                [remux.operation, remux.format, remux.trackIds],
                ['remux', 'mkv', [1]],
            );
            assert.equal(request({ to: '.MKV' }).operation, 'remux');
        });

        test('an audio format makes an audio request; settings are repaired or dropped', () => {
            const inferred = request({ to: 'WAV' });
            assert.deepEqual([inferred.operation, inferred.format], ['audio', 'wav']);
            const audio = request({
                to: 'wav',
                audio: { sampleRate: '44100', channels: 9 },
                start: 5,
                end: 2,
            });
            assert.equal(audio.sampleRate, 44100);
            assert.equal(audio.channels, 8, 'channels beyond the eight-channel limit are lowered');
            assert.equal(audio.start, 5);
            assert.equal(audio.end, undefined, 'an end before the start is dropped');
            assert.equal('width' in audio, false);
            assert.equal(request({ to: 'wav', audio: { channels: 0 } }).channels, undefined);
        });

        test('a conversion request carries audio and video settings', () => {
            const converted = request({
                to: 'mp4',
                audio: { sampleRate: 44100 },
                video: { fps: '30' },
                trackIds: [],
            });
            assert.equal(converted.operation, 'convert');
            assert.equal(converted.audioSampleRate, 44100);
            assert.equal(converted.fps, 30);
            assert.equal(converted.trackIds, undefined);
        });

        test('findings name the option they repaired', () => {
            const normalizer = lenient();
            resolveTarget(
                { to: 'mp4', bogus: true, audio: { sampleRate: 44100 }, video: { width: '1.5' } },
                normalizer,
            );
            assert.deepEqual(
                normalizer.findings.map(finding => [finding.code, finding.option]),
                [
                    ['OPTION_UNKNOWN', 'bogus'],
                    ['OPTION_NORMALIZED', 'width'],
                    ['OPTION_NORMALIZED', 'width'],
                ],
            );
        });

        test('strictly, every repair fails with INPUT and a clean target passes', () => {
            for (const target of [
                { to: 'mkv', trackIds: [1, 1] },
                { to: 'mkv', bogus: 1 },
                { to: 'wav', audio: { channels: '2' } },
                { to: 'wav', audio: { channels: 9 } },
                { to: 'wav', start: 3, end: 1 },
                { to: 'mp4', video: { width: 8192, height: 8192 } },
                { to: 'mp4', video: { keyframeInterval: -1 } },
                { to: 'dash', container: 'ts' },
            ])
                assert.throws(() => request(target, strict()), inputError, JSON.stringify(target));
            const clean = strict();
            resolveTarget({ to: 'wav', audio: { channels: 2 }, start: 1, end: 3 }, clean);
            assert.deepEqual(clean.findings, []);
            assert.equal(request({ to: 'mp4', video: { width: 640 } }, strict()).width, 640);
        });

        test('a target without a known format fails with INPUT, lenient or not', () => {
            for (const target of [{ to: 'xyz' }, { to: 'mp3x' }, {}, { to: '' }])
                assert.throws(() => request(target), inputError, JSON.stringify(target));
        });

        test('package targets read their container and segment duration', () => {
            const hls = request({
                to: 'm3u8',
                container: 'MPEGTS',
                targetDuration: '4',
                trackIds: 1,
            });
            assert.deepEqual(
                [hls.format, hls.container, hls.targetDuration, hls.trackIds],
                ['hls', 'ts', 4, [1]],
            );
            const dash = request({ to: 'mpd', container: 'ts' });
            assert.equal(dash.format, 'dash');
            assert.equal(dash.container, undefined, 'transport stream segments are HLS only');
        });

        test('picture targets read the image settings and the size', () => {
            const normalizer = lenient();
            const picture = resolveTarget(
                {
                    to: 'JPG',
                    image: { quality: '0.8', dither: 'floyd-steinberg' },
                    video: { width: '640', height: 480.4 },
                    bogus: 1,
                },
                normalizer,
            );
            assert.equal(picture.format, 'jpeg');
            assert.deepEqual(
                [picture.image.quality, picture.image.width, picture.image.height],
                [0.8, 640, 480],
            );
            assert.equal(picture.image.dither, undefined, 'dithering applies to GIF only');
            assert.deepEqual(sorted(codesOf(normalizer.findings)), [
                'OPTION_IGNORED',
                'OPTION_NORMALIZED',
                'OPTION_NORMALIZED',
                'OPTION_NORMALIZED',
                'OPTION_UNKNOWN',
            ]);
        });

        test('a video target ignores image settings, caps the bitrate, drops odd codecs', () => {
            const video = resolveTarget(
                {
                    to: 'mp4',
                    image: { quality: 0.5 },
                    audio: { channels: '2' },
                    video: { bitrate: 10 ** 12, codec: 'not a codec' },
                },
                lenient(),
            );
            assert.equal(video.image, undefined);
            assert.equal(video.target.request.videoBitrate, 800_000_000);
            assert.equal(video.target.request.videoCodec, undefined, 'the format default stays');
            assert.equal(video.target.request.audioChannels, 2);
        });

        test('audio bitrates are bits per second, text with a unit included', () => {
            const normalizer = lenient();
            assert.equal(
                request({ to: 'mp3', audio: { bitrate: '160k' } }, normalizer).bitrate,
                160_000,
            );
            assert.deepEqual(normalizer.findings, []);
        });

        test('codec names and host encoder settings map onto the request', () => {
            const converted = request({
                to: 'mkv',
                video: {
                    codec: 'H264',
                    hardwareAcceleration: 'hardware',
                    latencyMode: 'live',
                    bitrateMode: 'vbr',
                },
                audio: { codec: 'aac' },
            });
            assert.deepEqual(
                [
                    converted.videoCodec,
                    converted.audioCodec,
                    converted.hardwareAcceleration,
                    converted.latencyMode,
                    converted.bitrateMode,
                ],
                ['avc1', 'mp4a.40.2', 'prefer-hardware', 'realtime', 'variable'],
            );
            assert.equal(
                request({ to: 'mkv', video: { codec: 'vp09.00.10.08' } }).videoCodec,
                'vp09.00.10.08',
            );
            const odd = lenient();
            assert.equal(
                request({ to: 'mkv', video: { latencyMode: 'instant' } }, odd).latencyMode,
                undefined,
            );
            assert.deepEqual(codesOf(odd.findings), ['OPTION_IGNORED']);
            assert.throws(
                () => request({ to: 'mkv', video: { bitrateMode: 'quantizer' } }, strict()),
                inputError,
            );
        });

        test('an unknown key names the option probably meant, when one is close', () => {
            const typo = lenient();
            resolveTarget({ to: 'mkv', video: { bitrat: 1 } }, typo);
            assert.match(typo.findings.at(-1).message, /did you mean bitrate\?/);
            const far = lenient();
            resolveTarget({ to: 'mkv', video: { colourfulness: 1 } }, far);
            assert.doesNotMatch(far.findings.at(-1).message, /did you mean/);
        });
    });

    describe('findings of a call', () => {
        test('check() and convert() report target repairs with their result', async () => {
            const media = await open(waveFixture());
            try {
                const support = await media.check({ to: 'AIFF', trackIds: [1, 1], bogus: 1 });
                assert.equal(support.supported, true);
                assert.equal(support.plan.format, 'aiff');
                assert.deepEqual(sorted(codesOf(support.warnings)), [
                    'OPTION_NORMALIZED',
                    'OPTION_UNKNOWN',
                ]);
                const readable = new ReadableStreamSink();
                const [written, chunks] = await Promise.all([
                    media.convert('aiff', { audio: { vbr: 'yes' }, sink: readable }),
                    Array.fromAsync(readable.stream),
                ]);
                assert.equal(new TextDecoder().decode(chunks[0].subarray(0, 4)), 'FORM');
                assert.ok(written.warnings.some(warning => warning.code === 'OPTION_NORMALIZED'));
            } finally {
                media.close();
            }
        });

        test('a strict input refuses repairs in check() and convert()', async () => {
            const media = await open(waveFixture(), { optionPolicy: 'strict' });
            try {
                for (const target of [
                    { to: 'aiff', trackIds: [1, 1] },
                    { to: 'aiff', audio: { channels: '2' } },
                ]) {
                    const support = await media.check(target);
                    assert.deepEqual([support.supported, support.code], [false, 'INPUT']);
                    await assert.rejects(media.convert(target), inputError);
                }
                assert.equal((await media.check('aiff')).supported, true);
            } finally {
                media.close();
            }
        });

        test('optionPolicy strict on a call refuses unknown keys and repairs', async () => {
            for (const target of [
                { to: 'mp4', bogus: 1 },
                { to: 'mp4', video: { width: '640' } },
            ]) {
                const refused = await check(waveFixture(), { ...target, optionPolicy: 'strict' });
                assert.equal(refused.code, 'INPUT', JSON.stringify(target));
            }
        });

        test('trackIds empty or repeated are repaired; an unknown id is unsupported', async () => {
            const input = new Blob([movie()]);
            const [video] = (await inspect(input)).tracks;
            for (const trackIds of [[], [video.id, video.id]]) {
                const support = await check(input, 'mkv', { trackIds });
                assert.equal(support.supported, true, JSON.stringify(trackIds));
                assert.ok(support.warnings.some(warning => warning.code.startsWith('OPTION_')));
            }
            assert.equal((await check(input, 'mkv', { trackIds: [999] })).supported, false);
        });

        test('one call failing on its target does not stop another', async () => {
            const [written, refused] = await Promise.allSettled([
                convert(waveFixture(), 'au'),
                convert(waveFixture(), 'nope'),
            ]);
            assert.equal(written.value.blob.type, 'audio/basic');
            assert.equal(refused.reason.code, 'INPUT');
        });
    });

    describe('codecPreference', () => {
        test('an unusable preference is ignored with a warning, or refused strictly', () => {
            const warnings = [];
            new MediaForge({
                codecPreference: 'bogus',
                onWarning: warning => warnings.push(warning),
            });
            assert.deepEqual(codesOf(warnings), ['OPTION_IGNORED']);
            assert.throws(
                () => new MediaForge({ codecPreference: 'bogus', optionPolicy: 'strict' }),
                inputError,
            );
        });

        test("'library' reads as 'builtin'; a value that is no name is dropped", async () => {
            assert.equal(
                request({ to: 'wav', codecPreference: 'library' }).codecPreference,
                'builtin',
            );
            assert.equal(request({ to: 'wav', codecPreference: 7 }).codecPreference, undefined);
            const media = await open(waveFixture(), {
                codecPreference: 'builtin',
                optionPolicy: 'strict',
            });
            media.close();
        });
    });

    describe('metadataPolicy', () => {
        // AAC whose edit list ends inside the last of six packets: Matroska cannot cut a block.
        const trimmed = () =>
            classicMp4({
                timescale: 44100,
                movieTimescale: 44100,
                sampleRate: 44100,
                timing: [[6, 1024]],
                edits: [[3000, 0]],
            }).bytes;

        test('a trailing trim Matroska cannot keep is reported; the copy goes on', async () => {
            const media = await open(trimmed());
            try {
                const support = await media.check('mkv', { copy: true });
                assert.equal(support.supported, true);
                assert.ok(codesOf(support.warnings).includes('MATROSKA_TAIL_TRIM_LOSS'));
                const copy = await inspect((await media.convert('mkv', { copy: true })).blob, {
                    sampleCounts: true,
                });
                assert.equal(copy.tracks[0].sampleCount, 6, 'every coded block is kept');
                const mp4 = new Uint8Array(
                    await (await media.convert('mp4', { copy: true })).blob.arrayBuffer(),
                );
                const exact = await new Mp4Demuxer().demux({
                    size: mp4.length,
                    read: (at, length) => mp4.slice(at, at + length),
                });
                assert.deepEqual(exact.audioTracks[0].editList.entries, [
                    { segmentDuration: 3000, mediaTime: 0 },
                ]);
            } finally {
                media.close();
            }
        });

        test('an unknown policy is refused strictly; leniently it warns as warn does', async () => {
            const input = await aacMatroska();
            await assert.rejects(
                open(input, { metadataPolicy: 'ignore', optionPolicy: 'strict' }),
                inputError,
            );
            const warnings = [];
            const lenient = await open(input, {
                metadataPolicy: 'ignore',
                onWarning: warning => warnings.push(warning),
            });
            lenient.close();
            assert.deepEqual(codesOf(warnings), ['OPTION_IGNORED']);
            for (const metadataPolicy of [null, undefined, 'warn', 'error'])
                (await open(input, { metadataPolicy })).close();
        });

        test('a policy inherited or hidden in the options is read once, from them', async () => {
            let reads = 0;
            const inherited = Object.create({
                get metadataPolicy() {
                    assert.equal(this, inherited);
                    reads++;
                    return 'error';
                },
            });
            const { blob } = await convert(await aacMatroska({ name: 'Main' }), 'm4a', {
                open: inherited,
            });
            assert.equal(reads, 1);
            assert.equal((await inspect(blob)).tracks[0].name, 'Main', 'M4A keeps the name');
            const hidden = {};
            Object.defineProperty(hidden, 'metadataPolicy', {
                get() {
                    assert.equal(this, hidden);
                    reads++;
                    return 'warn';
                },
            });
            (await open(await aacMatroska(), hidden)).close();
            assert.equal(reads, 2);
        });

        test("'error' refuses a WAV that loses a track name; the sink stays empty", async () => {
            const sink = new MemorySink();
            const refused = await convert(await aacMatroska({ name: 'Main' }), 'wav', {
                open: { metadataPolicy: 'error' },
                sink,
            }).catch(error => error);
            assert.equal(refused.code, 'FORMAT');
            assert.doesNotMatch(refused.message, /Unknown option/);
            assert.equal(sink.size, 0);
        });

        test("'error' refuses a picture of a named track before drawing it", async () => {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'vp8',
                        width: 2,
                        height: 2,
                        framerate: 25,
                        name: 'Main',
                    },
                },
                sink,
            );
            muxer.addVideoChunk({
                data: Uint8Array.of(0x10, 0, 0, 0x9d, 1, 0x2a, 2, 0, 2, 0),
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
                trackType: 'video',
            });
            await muxer.finalize();
            await assert.rejects(
                convert(sink.toBlob('video/x-matroska'), 'png', {
                    open: { metadataPolicy: 'error' },
                }),
                error => error.code === 'FORMAT' && /cannot keep/.test(error.message),
            );
        });

        test("'error' refuses an MP4 copy losing a language, which Matroska keeps", async () => {
            const silence = [new Float32Array(1024)];
            const [frame] = (await encodeAacLc(silence, { sampleRate: 48000 })).frames;
            const duration = 1024 / 48000;
            const track = {
                id: 1,
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                channelCount: 1,
                duration,
                language: 'x-private',
                codecConfig: Uint8Array.of(0x11, 0x88),
                samples: [
                    { offset: 0, size: frame.length, data: frame, timestamp: 0, duration },
                ].map(sample => ({ ...sample, isKeyframe: true })),
            };
            const reader = {
                formats: ['custom'],
                async read() {
                    return { duration, videoTracks: [], audioTracks: [track] };
                },
            };
            // Each validation keeps the metadata policy apart; check() tells no listener.
            for (const validation of ['strict', 'compatible']) {
                const heard = [];
                const media = await open(new Uint8Array(1), {
                    plugins: { add: [{ name: 'custom', readers: [readerPart(reader)] }] },
                    format: 'custom',
                    validation,
                    metadataPolicy: 'error',
                    onWarning: warning => heard.push(warning.code),
                });
                try {
                    const support = await media.check('mp4', { copy: true });
                    assert.deepEqual([support.supported, support.code], [false, 'FORMAT']);
                    assert.ok(codesOf(support.warnings).includes('MP4_LANGUAGE_LOSS'));
                    assert.deepEqual(heard, [], validation);
                    const sink = new MemorySink();
                    await assert.rejects(
                        media.convert({ to: 'mp4', copy: true, sink }),
                        error => error.code === 'FORMAT',
                    );
                    assert.equal(sink.size, 0);
                    assert.deepEqual(heard, ['MP4_LANGUAGE_LOSS'], validation);
                    assert.equal((await media.check('mkv', { copy: true })).supported, true);
                    const { blob } = await media.convert('mkv', { copy: true });
                    assert.equal((await inspect(blob)).tracks[0].language, 'x-private');
                } finally {
                    media.close();
                }
            }
        });

        test("metadataPolicy: 'error' turns the metadata loss into FORMAT", async () => {
            const media = await open(trimmed(), { metadataPolicy: 'error' });
            try {
                const support = await media.check('mkv', { copy: true });
                assert.deepEqual([support.supported, support.code], [false, 'FORMAT']);
                await assert.rejects(
                    media.convert('mkv', { copy: true }),
                    error => error.code === 'FORMAT',
                );
            } finally {
                media.close();
            }
        });
    });
});

describe('api options: reading options in each place', () => {
    // Reading options reach the input through open(), through convert() under `open`, and through
    // the MediaForge defaults under `open`.
    const places = {
        'open()': async (options, bytes) => (await open(bytes, options)).close(),
        'convert()': (options, bytes, format) =>
            convert(bytes, format, { copy: true, open: options }),
        'MediaForge defaults': (options, bytes, format) =>
            new MediaForge({ open: options }).convert(bytes, format, { copy: true }),
    };

    for (const [place, execute] of Object.entries(places)) {
        test(`${place}: inherited and hidden resource limits apply`, async () => {
            const mp4 = classicMp4({ count: 8 }).bytes;
            await assert.rejects(
                execute(Object.create({ maxSamples: 1 }), mp4, 'm4a'),
                error => error.code === 'OOM',
            );
            const hidden = {};
            Object.defineProperty(hidden, 'maxIndexBytes', { value: 1 });
            await assert.rejects(execute(hidden, mp4, 'm4a'), error => error.code === 'OOM');
        });

        test(`${place}: each reading option is read once`, async () => {
            const reads = {};
            const options = {};
            for (const key of ['signal', 'validation', 'metadataPolicy', 'maxWarnings'])
                Object.defineProperty(options, key, {
                    enumerable: true,
                    get() {
                        reads[key] = (reads[key] ?? 0) + 1;
                        return undefined;
                    },
                });
            await execute(options, waveFixture(), 'wav');
            assert.deepEqual(reads, {
                signal: 1,
                validation: 1,
                metadataPolicy: 1,
                maxWarnings: 1,
            });
        });
    }

    test('the common and target options of a call are read once', async () => {
        const reads = {};
        const options = {};
        for (const [key, value] of Object.entries({
            copy: true,
            onWarning: () => {},
            optionPolicy: 'lenient',
        }))
            Object.defineProperty(options, key, {
                enumerable: true,
                get() {
                    reads[key] = (reads[key] ?? 0) + 1;
                    return value;
                },
            });
        await convert(waveFixture(), 'wav', options);
        assert.deepEqual(reads, { copy: 1, onWarning: 1, optionPolicy: 1 });
    });

    test('a repaired input reports to the Media and the listener alike', async () => {
        const wave = waveFixture();
        // One byte past the RIFF chunk.
        const input = new Uint8Array(wave.length + 1);
        input.set(wave);
        const heard = [];
        const media = await open(
            input,
            Object.create({ onWarning: warning => heard.push(warning.code) }),
        );
        assert.deepEqual(codesOf(media.warnings), heard);
        assert.ok(heard.length > 0);
        media.close();
        await assert.rejects(
            open(input, { validation: 'strict' }),
            error => error.code === 'DEMUX' && /WAVE RIFF boundary/.test(error.message),
        );
    });
});
