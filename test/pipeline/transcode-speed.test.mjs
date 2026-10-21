import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { createMuxer, decodeAudio, open } from 'mediaforgejs/parts';
import { aac } from 'mediaforgejs/plugins';
// How the API reads a target; internal to the API.
import { resolveTarget } from '../../dist/esm/api/target.js';
import { warningOf } from '../../dist/esm/api/options/options.js';
import { OptionNormalizer } from '../../dist/esm/core/errors/option-policy.js';
import { codes } from '../helpers/api-fixtures.mjs';
import { rawPacket, rawPicture, rawVideoProvider } from '../helpers/raw-video-provider.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// Slow motion and frame rates through the one pipeline, on a lossless test codec so every picture
// can be compared: twenty 25 fps pictures of a moving texture with a cut after the tenth, over
// 0.8 s of a 440 Hz tone.

const [width, height, count, rate, sampleRate] = [32, 24, 20, 25, 48000];

/** A picture of a hashed texture, `shift` pixels along. */
function picture(seed, shift) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let h =
                Math.imul(x + shift, 0x27d4eb2d) ^
                Math.imul(y, 0x165667b1) ^
                Math.imul(seed, 0x9e3779b1);
            h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 24;
            data.set([h, (h * 3) & 255, 255 - h, 255], (y * width + x) * 4);
        }
    return data;
}

const source = Array.from({ length: count }, (_, k) =>
    k < 10 ? picture(1, 2 * k) : picture(2, -2 * k),
);
const { plugin } = rawVideoProvider();
const forge = new MediaForge({ plugins: { add: [plugin] } });

/** The input: the pictures and the tone as 16-bit PCM packets of 0.1 s, in Matroska. */
async function makeInput() {
    const sink = new MemorySink();
    const muxer = await createMuxer('mkv', sink, {
        video: { codec: 'vp8', width, height, framerate: rate },
        audio: { codec: 'pcm-s16le', sampleRate, channels: 1 },
    });
    const frames = Math.round((count / rate) * sampleRate);
    const tone = [];
    for (let at = 0; at < frames; at += 4800) {
        const data = new Uint8Array(2 * Math.min(4800, frames - at));
        const view = new DataView(data.buffer);
        for (let i = 0; i < data.length / 2; i++)
            view.setInt16(
                2 * i,
                Math.round(Math.sin((2 * Math.PI * 440 * (at + i)) / sampleRate) * 16000),
                true,
            );
        tone.push({
            data,
            timestamp: at / sampleRate,
            duration: data.length / 2 / sampleRate,
            isKeyframe: true,
            trackType: 'audio',
        });
    }
    for (let k = 0; k < count; k++) {
        await muxer.addVideo(rawPacket(source[k], width, height, k / rate, 1 / rate));
        if (k % 2 === 0 && tone[k / 2]) await muxer.addAudio(tone[k / 2]);
    }
    await muxer.finish();
    return sink.toBlob('video/x-matroska');
}

/** A Matroska target with the test codec and AAC sound. */
const mkv = (video, audio = {}) => ({
    to: 'mkv',
    video: { codec: 'vp8', ...video },
    audio: { codec: 'aac', ...audio },
});

/** The output's pictures in order, the seconds of its sound and the sound's strongest frequency. */
async function read(blob) {
    const media = await open(blob);
    const video = media.tracks.find(track => track.type === 'video');
    const audio = media.tracks.find(track => track.type === 'audio');
    const pictures = [];
    for await (const packet of media.packets({ trackIds: [video.id] }))
        pictures.push({ timestamp: packet.timestamp, data: rawPicture(packet) });
    pictures.sort((a, b) => a.timestamp - b.timestamp);
    let samples = new Float32Array(0);
    if (audio)
        for await (const [plane] of (await decodeAudio(media, audio.id)).chunks()) {
            const joined = new Float32Array(samples.length + plane.length);
            joined.set(samples);
            joined.set(plane, samples.length);
            samples = joined;
        }
    media.close();
    let peak = 0;
    let strongest = 0;
    const from = samples.length >> 2;
    const size = Math.min(8192, samples.length >> 1);
    for (let frequency = 100; frequency <= 1000 && size; frequency += 2) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < size; i++) {
            const angle = (2 * Math.PI * frequency * i) / sampleRate;
            const value = samples[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
            re += value * Math.cos(angle);
            im -= value * Math.sin(angle);
        }
        if (re * re + im * im > strongest) [strongest, peak] = [re * re + im * im, frequency];
    }
    return { pictures, seconds: samples.length / sampleRate, peak };
}

/** How a target resolves before any input is read. */
function plan(target, policy = 'lenient') {
    const normalizer = new OptionNormalizer(policy, 'target');
    const resolved = resolveTarget(target, normalizer);
    const request = resolved.target?.request ?? resolved.package;
    return { ...resolved, request, warnings: normalizer.findings.map(warningOf) };
}

describe('pipeline/transcode: speed and frame rate', () => {
    let input;
    before(async () => (input = await makeInput()));

    test('half speed keeps 25 fps: each picture twice, the sound stretched', async () => {
        const target = mkv({ speed: 0.5 });
        const checked = await forge.check(input, target);
        assert.ok(checked.supported, JSON.stringify(checked));
        // The plan covers the longest track: the sound runs on to the end of its last AAC frame.
        assert.ok(Math.abs(checked.plan.duration - 1.6) < 0.08, `${checked.plan.duration}`);
        assert.deepEqual(
            checked.plan.tracks.map(track => [track.type, track.action, track.fps, track.stages]),
            [
                ['video', 'encode', 25, ['speed', 'fps']],
                ['audio', 'encode', undefined, ['time-stretch']],
            ],
        );
        const { blob, plan: written } = await forge.convert(input, target);
        assert.deepEqual(written, checked.plan);
        const output = await read(blob);
        assert.equal(output.pictures.length, 2 * count);
        output.pictures.forEach((entry, n) =>
            assert.ok(Math.abs(entry.timestamp - n / rate) < 0.0011, `${n}`),
        );
        for (let k = 0; k < count; k++)
            assert.deepEqual(output.pictures[2 * k].data, source[k], `slot ${2 * k}`);
        assert.deepEqual(output.pictures[19].data, source[9], 'the last slot repeats picture 9');
        assert.ok(Math.abs(output.seconds - 1.6) < 0.025, `${output.seconds} s`);
        assert.ok(Math.abs(output.peak - 440) <= 4, `${output.peak} Hz`);
    });

    test("'shift-pitch' resamples the sound, an octave down at half speed", async () => {
        const shifted = await read(
            (await forge.convert(input, mkv({ speed: 0.5 }, { speed: 'shift-pitch' }))).blob,
        );
        assert.ok(Math.abs(shifted.peak - 220) <= 4, `${shifted.peak} Hz`);
        assert.ok(Math.abs(shifted.seconds - 1.6) < 0.025);
    });

    test("'mute' leaves the sound out", async () => {
        const muted = await forge.convert(input, {
            to: 'mkv',
            video: { codec: 'vp8', speed: 0.5 },
            audio: { speed: 'mute' },
        });
        assert.deepEqual(
            (await forge.inspect(muted.blob)).tracks.map(track => track.type),
            ['video'],
        );
    });

    test('double speed drops every other picture', async () => {
        const fast = await read((await forge.convert(input, mkv({ speed: 2 }))).blob);
        assert.deepEqual(
            fast.pictures.map(entry => entry.data),
            source.filter((_, k) => k % 2 === 0),
        );
        assert.ok(Math.abs(fast.seconds - 0.4) < 0.025);
    });

    test('a higher frame rate at speed 1 repeats the pictures and keeps the sound', async () => {
        const smooth = await read((await forge.convert(input, mkv({ fps: 50 }))).blob);
        assert.equal(smooth.pictures.length, 2 * count);
        for (let k = 0; k < count; k++) assert.deepEqual(smooth.pictures[2 * k].data, source[k]);
        assert.ok(Math.abs(smooth.seconds - 0.8) < 0.025);
        assert.ok(Math.abs(smooth.peak - 440) <= 4);
    });

    test('an edit clip with a speed runs the speed stages at its frame rate', async () => {
        const encoding = installVideoCodecs();
        try {
            const edited = await forge.edit(
                { clips: [{ input, speed: 0.5 }] },
                mkv({ codec: 'vp9' }),
            );
            assert.deepEqual(
                edited.plan.tracks.map(track => [track.type, track.fps, track.stages]),
                [
                    ['video', 25, ['speed', 'fps']],
                    ['audio', undefined, ['time-stretch']],
                ],
            );
            assert.equal(encoding.encoded.length, 2 * count);
            encoding.encoded.forEach((entry, n) =>
                assert.equal(entry.timestamp, Math.round((n * 1e6) / rate)),
            );
            encoding.assertClosed();
        } finally {
            encoding.restore();
        }
    });

    test('an edit in a codec the host cannot encode takes the next one it can', async () => {
        const vp9Only = installVideoCodecs({
            encodeSupport: config => config.codec.startsWith('vp09'),
        });
        try {
            const substituted = await forge.edit(
                { clips: [{ input, video: { fade: { in: 0.2 } } }] },
                mkv({ codec: 'av1' }),
            );
            assert.ok(substituted.warnings.some(warning => warning.code === 'CODEC_SUBSTITUTED'));
            assert.match(
                substituted.plan.tracks.find(track => track.type === 'video').codec,
                /^vp09/,
            );
            vp9Only.assertClosed();
        } finally {
            vp9Only.restore();
        }
    });

    test('a cut at a picture start shows it despite a rounding error', async () => {
        // Matroska stores 30 fps pictures at whole milliseconds: 0.267 s + 0.033 s is
        // 0.30000000000000004.
        const sink = new MemorySink();
        const muxer = await createMuxer('mkv', sink, {
            video: { codec: 'vp8', width, height, framerate: 30 },
        });
        for (let k = 0; k < 15; k++)
            await muxer.addVideo({
                ...rawPacket(source[k], width, height, k / 30, 1 / 30),
                isKeyframe: k === 0,
            });
        await muxer.finish();
        const cutting = installVideoCodecs();
        try {
            const cut = await forge.edit(
                { clips: [{ input: sink.toBlob('video/x-matroska'), start: 0.3, end: 0.5 }] },
                mkv({ codec: 'vp9', bitrate: 1_000_000 }),
            );
            assert.deepEqual(codes(cut.warnings), [], 'no picture is dropped at the cut');
            assert.deepEqual(
                cutting.encoded.map(entry => Math.round(entry.timestamp / 1000)),
                [0, 33, 67, 100, 133, 167],
            );
            cutting.assertClosed();
        } finally {
            cutting.restore();
        }
    });

    test('a speed needs no plugin', async () => {
        const bare = new lite.MediaForge({ plugins: [plugin, aac] });
        const plain = await read((await bare.convert(input, mkv({ speed: 0.5 }))).blob);
        assert.equal(plain.pictures.length, 2 * count);
    });
});

describe('pipeline/transcode: speed settings', () => {
    test('a speed and the audio speed reach the request', () => {
        const settings = plan({
            to: 'mp4',
            video: { speed: 0.5 },
            audio: { speed: 'shift-pitch' },
        });
        assert.deepEqual(
            [settings.request.speed, settings.request.audioSpeed],
            [0.5, 'shift-pitch'],
        );
    });

    test('a speed of 1 changes nothing; the audio speed applies only with another speed', () => {
        const ignored = plan({ to: 'mp4', video: { speed: 1 }, audio: { speed: 'mute' } });
        assert.deepEqual(
            [ignored.request.speed, ignored.request.audioSpeed, ignored.target.mute],
            [undefined, undefined, undefined],
        );
        assert.deepEqual(codes(ignored.warnings), ['OPTION_IGNORED']);
    });

    test('a speed out of range is lowered to 10, or refused strictly', () => {
        assert.throws(
            () => plan({ to: 'mp4', video: { speed: 50 } }, 'strict'),
            error => error.code === 'INPUT',
        );
        assert.equal(plan({ to: 'mp4', video: { speed: 50 } }).request.speed, 10);
    });
});
