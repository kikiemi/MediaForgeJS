import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MediaForge, capabilities, encodeFrames, inspect } from 'mediaforgejs';
import { codes } from './helpers/api-fixtures.mjs';
import { installVideoCodecs } from './helpers/webcodecs-video-harness.mjs';

// encodeFrames(): an application's VideoFrames and AudioData encoded into a file, through
// WebCodecs doubles for the video and the built-in or a fake host encoder for the sound.

/** `count` 32x24 RGBA VideoFrames at 30 fps from 5 s, kept in `produced`. */
function videoFrames(count, produced = []) {
    return (async function* () {
        for (let index = 0; index < count; index++) {
            const frame = new VideoFrame(new Uint8Array(32 * 24 * 4), {
                format: 'RGBA',
                codedWidth: 32,
                codedHeight: 24,
                timestamp: 5_000_000 + (index * 1e6) / 30,
                duration: 1e6 / 30,
            });
            produced.push(frame);
            yield frame;
        }
    })();
}

describe('recording: encodeFrames() of video', () => {
    let host;
    before(() => {
        host = installVideoCodecs({
            encodeSupport: config => config.codec === 'vp8',
            evented: true,
        });
    });
    after(() => host.restore());

    test('capabilities() list the codecs the host encodes', async () => {
        assert.deepEqual((await capabilities({ to: 'webm' })).video.encode, ['vp8']);
        assert.equal((await capabilities()).video.encode.includes('vp9'), false);
        const realtime = await capabilities({
            hardwareAcceleration: 'prefer-hardware',
            latencyMode: 'realtime',
        });
        assert.equal(realtime.video.encode.includes('vp8'), true);
        assert.equal(realtime.audio.encode.includes('aac'), true, 'the library encodes AAC');
    });

    test("codec 'auto' takes the WebM codec the host encodes, as asked", async () => {
        const produced = [];
        const events = [];
        const plans = [];
        const result = await encodeFrames(videoFrames(40, produced), {
            to: 'webm',
            video: {
                codec: 'auto',
                fps: 30,
                bitrateMode: 'constant',
                hardwareAcceleration: 'prefer-software',
            },
            duration: 40 / 30,
            onProgress: event => events.push(event),
            onPlan: report => plans.push(report),
        });
        assert.deepEqual(
            [result.format, result.mimeType, result.filename],
            ['webm', 'video/webm', 'output.webm'],
        );
        assert.deepEqual(
            result.plan.tracks.map(track => [track.type, track.action, track.codec, track.encoder]),
            [['video', 'encode', 'vp8', 'webcodecs']],
        );
        assert.deepEqual(plans, [result.plan]);
        const config = host.encoderConfigs.at(-1);
        assert.deepEqual(
            [
                config.codec,
                config.width,
                config.height,
                config.bitrateMode,
                config.hardwareAcceleration,
                config.latencyMode,
            ],
            ['vp8', 32, 24, 'constant', 'prefer-software', 'quality'],
        );
        assert.equal(events.at(-1).fraction, 1);
        assert.ok(events.some(event => event.fraction > 0 && event.fraction < 1));
        assert.ok(
            produced.every(frame => frame.closed),
            'every frame handed over is closed',
        );
        host.assertClosed();
    });

    test('timestamps start at the first frame and the encoder queue stays bounded', async () => {
        const before = host.encoded.length;
        await encodeFrames(videoFrames(40), { to: 'webm' });
        const encoded = host.encoded.slice(before);
        assert.equal(encoded.length, 40);
        assert.equal(encoded[0].timestamp, 0);
        assert.ok(encoded.some(entry => entry.keyFrame));
        assert.ok(host.peakEncodeQueue <= 9, `queue ${host.peakEncodeQueue}`);
    });

    test('the file holds every frame over their duration', async () => {
        const result = await encodeFrames(videoFrames(40), { to: 'webm', duration: 40 / 30 });
        const written = await inspect(result.blob, { sampleCounts: true });
        assert.equal(written.format, 'webm');
        assert.deepEqual([written.tracks[0].codec, written.tracks[0].sampleCount], ['vp8', 40]);
        assert.ok(Math.abs(written.tracks[0].duration - 40 / 30) < 0.05);
    });

    test('a codec the host cannot encode, for MP4, fails with ENCODE and a hint', async () => {
        await assert.rejects(
            encodeFrames(videoFrames(2), { to: 'mp4', video: { codec: 'h264' } }),
            error => error.code === 'ENCODE' && /codec: 'auto'/.test(error.hint),
        );
        await assert.rejects(
            encodeFrames(videoFrames(2), { to: 'mp4' }),
            error => error.code === 'ENCODE' && /webm/.test(error.hint),
        );
    });

    test('a codec the host cannot encode is replaced and reported; stages run', async () => {
        let staged = 0;
        const counting = {
            type: 'video',
            name: 'count',
            create: () => ({
                type: 'video',
                name: 'count',
                process: (picture, emit) => (staged++, emit(picture)),
            }),
        };
        const replaced = await encodeFrames(videoFrames(3), {
            to: 'webm',
            video: { codec: 'vp9', stages: [counting] },
        });
        assert.deepEqual(codes(replaced.warnings), ['CODEC_SUBSTITUTED']);
        assert.deepEqual(
            replaced.plan.tracks.map(track => [track.codec, track.stages]),
            [['vp8', ['count']]],
        );
        assert.equal(staged, 3);
    });

    test('strictly, the replacement fails with ENCODE', async () => {
        await assert.rejects(
            encodeFrames(videoFrames(2), {
                to: 'webm',
                video: { codec: 'vp9' },
                optionPolicy: 'strict',
            }),
            error => error.code === 'ENCODE',
        );
    });

    test('no frames, or a container without a video encoder path, fail with INPUT', async () => {
        await assert.rejects(encodeFrames([], { to: 'webm' }), error => error.code === 'INPUT');
        await assert.rejects(
            encodeFrames(videoFrames(2), { to: 'avi' }),
            error => error.code === 'INPUT',
        );
    });

    test('options are read like convert()s, typos reported with the result', async () => {
        const typos = [];
        const typed = await encodeFrames(videoFrames(3), {
            to: 'webm',
            video: { fsp: 60, latencyMode: 'live' },
            onWarning: warning => typos.push(warning),
        });
        assert.equal(host.encoderConfigs.at(-1).latencyMode, 'realtime');
        assert.ok(
            typos.some(
                warning =>
                    warning.code === 'OPTION_UNKNOWN' && /did you mean fps\?/.test(warning.message),
            ),
        );
        assert.deepEqual(codes(typed.warnings), codes(typos));
    });

    test('a cancelled encode stops with ABORT and closes every frame', async () => {
        const produced = [];
        const stop = new AbortController();
        const cancelled = encodeFrames(
            (async function* () {
                yield* videoFrames(3, produced);
                stop.abort();
                yield* videoFrames(3, produced);
            })(),
            { to: 'webm', signal: stop.signal },
        );
        await assert.rejects(cancelled, error => error.code === 'ABORT');
        assert.ok(produced.every(frame => frame.closed));
        host.assertClosed();
    });
});

/** AudioData as the tests hand it over: planar float samples. */
class FakeAudioData {
    constructor({ sampleRate, planes, timestamp, numberOfFrames, numberOfChannels }) {
        Object.assign(this, { sampleRate, planes, timestamp, closed: false });
        this.numberOfFrames = planes ? planes[0].length : numberOfFrames;
        this.numberOfChannels = planes ? planes.length : numberOfChannels;
    }
    copyTo(destination, { planeIndex, format }) {
        assert.equal(format, 'f32-planar');
        assert.ok(!this.closed, 'copy from a closed AudioData');
        destination.set(this.planes[planeIndex]);
    }
    close() {
        this.closed = true;
    }
}

/** 24 blocks of 2048 stereo frames of a 440 Hz tone from 3 s, kept in `blocks`. */
function* sound(rate = 48000, blocks = []) {
    for (let block = 0; block < 24; block++) {
        const plane = Float32Array.from(
            { length: 2048 },
            (_, index) => 0.3 * Math.sin((2 * Math.PI * 440 * (block * 2048 + index)) / rate),
        );
        const data = new FakeAudioData({
            sampleRate: rate,
            planes: [plane, plane.slice()],
            timestamp: 3_000_000 + (block * 2048 * 1e6) / rate,
        });
        blocks.push(data);
        yield data;
    }
}

/** The samples a file presents, decoded to WAV. */
async function presentedFrames(blob) {
    const pcm = (await inspect((await new MediaForge().convert(blob, 'wav')).blob)).tracks[0];
    return { frames: Math.round(pcm.duration * pcm.sampleRate), track: pcm };
}

/** A host AudioEncoder that codes Opus only, stating a pre-skip of 312 in its first chunk. */
class FakeOpusEncoder {
    static async isConfigSupported(config) {
        return { supported: config.codec === 'opus', config };
    }
    constructor({ output }) {
        Object.assign(this, {
            output,
            state: 'unconfigured',
            encodeQueueSize: 0,
            frames: 0,
            sent: 0,
        });
    }
    configure(config) {
        this.state = 'configured';
        this.rate = config.sampleRate;
    }
    encode(audio) {
        // Opus codes 48 kHz: other input rates are resampled.
        this.frames += (audio.numberOfFrames * 48000) / this.rate;
        this.emit(this.frames + 312);
    }
    emit(until) {
        const head = Uint8Array.from([
            ...new TextEncoder().encode('OpusHead'),
            1,
            2,
            312 & 255,
            312 >> 8,
            0x80,
            0xbb,
            0,
            0,
            0,
            0,
            0,
        ]);
        for (; (this.sent + 1) * 960 <= until; this.sent++)
            this.output(
                {
                    byteLength: 3,
                    timestamp: this.sent * 20000,
                    duration: 20000,
                    copyTo: target => target.set([0xf8, 0xff, 0xfe]),
                },
                this.sent ? undefined : { decoderConfig: { description: head } },
            );
    }
    async flush() {
        this.emit(Math.ceil((this.frames + 312) / 960) * 960);
    }
    close() {
        this.state = 'closed';
    }
}

describe('recording: encodeFrames() of sound', () => {
    let saved;
    before(() => {
        saved = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
        globalThis.AudioData = FakeAudioData;
    });
    after(() => {
        if (saved) Object.defineProperty(globalThis, 'AudioData', saved);
        else delete globalThis.AudioData;
    });

    test('without a host AudioEncoder, MP4 takes the built-in AAC', async () => {
        const blocks = [];
        const recorded = await encodeFrames(
            { audio: sound(48000, blocks) },
            { to: 'mp4', audio: { bitrate: '96k' }, codecPreference: 'builtin' },
        );
        assert.deepEqual(codes(recorded.warnings), []);
        assert.deepEqual(
            recorded.plan.tracks.map(track => [track.type, track.codec, track.encoder]),
            [['audio', 'mp4a.40.2', 'builtin']],
        );
        assert.ok(blocks.every(block => block.closed));
        const tracks = (await inspect(recorded.blob)).tracks;
        assert.deepEqual(
            tracks.map(track => [track.type, track.codec, track.sampleRate, track.channelCount]),
            [['audio', 'mp4a.40.2', 48000, 2]],
        );
        assert.equal((await presentedFrames(recorded.blob)).frames, 24 * 2048);
    });

    test('Matroska declares the encoder delay first and the length at the end', async () => {
        const live = await encodeFrames(
            { audio: sound() },
            { to: 'mkv', codecPreference: 'builtin' },
        );
        assert.equal((await presentedFrames(live.blob)).frames, 24 * 2048);
    });

    for (const [to, codec, written] of [
        ['mkv', 'flac', 'flac'],
        ['mkv', 'mp3', 'mp3'],
        ['mp4', 'mp3', 'mp3'],
        ['mkv', 'mp2', 'mp2'],
    ])
        test(`${codec} sound is encoded into ${to} by the plugin's encoder`, async () => {
            const recorded = await encodeFrames({ audio: sound() }, { to, audio: { codec } });
            assert.deepEqual(
                recorded.plan.tracks.map(track => [track.codec, track.encoder]),
                [[codec, 'builtin']],
            );
            const [track] = (await inspect(recorded.blob)).tracks;
            assert.equal(track.codec, written);
            const { frames } = await presentedFrames(recorded.blob);
            assert.ok(Math.abs(frames - 24 * 2048) <= 1152, `${frames} frames`);
        });

    test('WebM needs a host Opus encoder; the hint names MP4', async () => {
        await assert.rejects(
            encodeFrames({ audio: sound() }, { to: 'webm' }),
            error => error.code === 'ENCODE' && /mp4/.test(error.hint),
        );
    });

    describe('with a host Opus encoder', () => {
        before(() => (globalThis.AudioEncoder = FakeOpusEncoder));
        after(() => delete globalThis.AudioEncoder);

        test('the track lasts what it presents, its pre-skip and padding hidden', async () => {
            const opus = await encodeFrames({ audio: sound() }, { to: 'webm' });
            const [track] = (await inspect(opus.blob)).tracks;
            assert.equal(track.codec, 'opus');
            assert.ok(Math.abs(track.duration - 1.024) < 1e-3, `${track.duration}`);
            // Segment Duration (0x4489, an 8-byte float in milliseconds).
            const bytes = new Uint8Array(await opus.blob.arrayBuffer());
            const at = bytes.findIndex(
                (value, index) => value === 0x44 && bytes[index + 1] === 0x89,
            );
            const segment = new DataView(bytes.buffer, at + 3, 8).getFloat64(0);
            assert.ok(Math.abs(segment - 1024) < 1, `Segment Duration ${segment} ms`);
            assert.equal((await presentedFrames(opus.blob)).frames, 24 * 2048);
        });

        test('44.1 kHz sound is encoded at 48 kHz and keeps its length', async () => {
            const resampled = await encodeFrames({ audio: sound(44100) }, { to: 'webm' });
            const { track } = await presentedFrames(resampled.blob);
            assert.equal(track.sampleRate, 48000);
            assert.ok(Math.abs(track.duration - (24 * 2048) / 44100) < 1e-3, `${track.duration}`);
        });

        test('Ogg Opus keeps the encoder pre-skip; the last granule ends the sound', async () => {
            const opus = await encodeFrames({ audio: sound() }, { to: 'webm' });
            const sourceWav = (await new MediaForge().convert(opus.blob, 'wav')).blob;
            const ogg = await new MediaForge().convert(sourceWav, { to: 'ogg' });
            assert.deepEqual(
                ogg.plan.tracks.map(track => [track.action, track.codec]),
                [['encode', 'opus']],
            );
            const bytes = new Uint8Array(await ogg.blob.arrayBuffer());
            const granules = [];
            for (let at = 0; at < bytes.length;) {
                const segments = bytes[at + 26];
                const lacing = bytes.subarray(at + 27, at + 27 + segments);
                const body = at + 27 + segments;
                if (!granules.length)
                    assert.equal(
                        new TextDecoder().decode(bytes.subarray(body, body + 8)),
                        'OpusHead',
                    );
                granules.push(new DataView(bytes.buffer, at + 6, 8).getBigInt64(0, true));
                at = body + lacing.reduce((sum, value) => sum + value, 0);
            }
            assert.equal(granules.at(-1), 312n + 24n * 2048n);
            assert.equal((await presentedFrames(ogg.blob)).frames, 24 * 2048);
        });
    });
});
