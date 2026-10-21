import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, capabilities, encodeFrames, frames, inspect } from 'mediaforgejs';

// The host's WebCodecs through the library, in a real browser (npm run test:browser): what the
// lite entry, which has no codecs of its own for these, can do with the browser's.

const inBrowser = typeof document !== 'undefined';
const lite = () => new MediaForge({ plugins: [] });
const internal = path => import(`/dist/esm/${path}.js`);

/** The samples of a WAV file: 16-bit PCM, interleaved. */
async function waveSamples(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let at = 12;
    while (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'data')
        at += 8 + view.getUint32(at + 4, true);
    return new Int16Array(bytes.slice(at + 8, at + 8 + view.getUint32(at + 4, true)).buffer);
}

/** Counts the AudioDecoder configurations made while `run` runs. */
async function hostAudioDecoders(run) {
    const configure = AudioDecoder.prototype.configure;
    let count = 0;
    AudioDecoder.prototype.configure = function (config) {
        count++;
        return configure.call(this, config);
    };
    try {
        await run();
    } finally {
        AudioDecoder.prototype.configure = configure;
    }
    return count;
}

/** Whether the host encodes `config` with VideoEncoder (or AudioEncoder for an audio config). */
async function hostEncodes(config) {
    const Encoder = config.numberOfChannels ? globalThis.AudioEncoder : globalThis.VideoEncoder;
    return !!Encoder && (await Encoder.isConfigSupported(config)).supported === true;
}

/** `count` frames of a 64x48 canvas, 30 per second, each filled with its own grey. */
function canvasFrames(count) {
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    return Array.from({ length: count }, (_, index) => {
        context.fillStyle = `rgb(${index * 20}, ${index * 20}, ${index * 20})`;
        context.fillRect(0, 0, 64, 48);
        return new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / 30) });
    });
}

/** A WAV file of 16-bit stereo PCM at 48 kHz: a tenth of a second of a 440 Hz tone. */
function waveFixture() {
    const frameCount = 4800;
    const bytes = new Uint8Array(44 + frameCount * 4);
    const view = new DataView(bytes.buffer);
    const text = (at, value) =>
        [...value].forEach((char, i) => (bytes[at + i] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frameCount * 4, true);
    for (let i = 0; i < frameCount; i++) {
        const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
        view.setInt16(44 + i * 4, sample, true);
        view.setInt16(46 + i * 4, sample, true);
    }
    return bytes;
}

describe(
    'codecs/webcodecs',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        test('application frames encode to a VP9 WebM with the host encoder', async t => {
            if (!(await hostEncodes({ codec: 'vp09.00.10.08', width: 64, height: 48 })))
                return t.skip('the browser has no VP9 encoder');
            const result = await encodeFrames(canvasFrames(10), {
                to: 'webm',
                video: { codec: 'vp9' },
            });
            const info = await inspect(result.blob);
            assert.equal(info.format, 'webm');
            assert.deepEqual(
                info.tracks.map(track => [track.type, track.codec.slice(0, 4)]),
                [['video', 'vp09']],
            );
        });

        test('the pictures of a VP9 WebM decode with the host decoder in their order', async t => {
            if (!(await hostEncodes({ codec: 'vp09.00.10.08', width: 64, height: 48 })))
                return t.skip('the browser has no VP9 encoder');
            const encoded = await encodeFrames(canvasFrames(10), {
                to: 'webm',
                video: { codec: 'vp9' },
            });
            const greys = [];
            for await (const frame of frames(encoded.blob)) greys.push(frame.data[0]);
            assert.equal(greys.length, 10);
            for (let i = 1; i < greys.length; i++)
                assert(greys[i] > greys[i - 1], `frame ${i} is lighter`);
        });

        test('a WAV file converts to Opus in WebM with the host encoder alone', async t => {
            const config = {
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 96000,
            };
            if (!(await hostEncodes(config))) return t.skip('the browser has no Opus encoder');
            const result = await lite().convert(new Blob([waveFixture()]), 'webm');
            const info = await inspect(result.blob);
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['opus'],
            );
        });

        test('Opus the host wrote decodes with the host decoder alone, in full', async t => {
            const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
            if (!(await hostEncodes(config))) return t.skip('the browser has no Opus encoder');
            if (!(await lite().capabilities()).audio.decode.includes('opus'))
                return t.skip('the browser has no Opus decoder');
            const { blob: webm } = await lite().convert(new Blob([waveFixture()]), 'webm');
            const samples = await waveSamples((await lite().convert(webm, 'wav')).blob);
            assert.equal(samples.length, 4800 * 2, 'the length of the source');
            let level = 0;
            for (const sample of samples.subarray(2000, 8000)) level = Math.max(level, sample);
            assert(Math.abs(level - 8000) < 800, `the tone keeps its level (${level})`);
        });

        test('FLAC the library wrote decodes exactly with the host decoder', async t => {
            if (!(await lite().capabilities()).audio.decode.includes('flac'))
                return t.skip('the browser has no FLAC decoder');
            const source = waveFixture();
            const { blob: flac } = await new MediaForge().convert(new Blob([source]), 'flac');
            let samples;
            const decoders = await hostAudioDecoders(async () => {
                samples = await waveSamples((await lite().convert(flac, 'wav')).blob);
            });
            assert.equal(decoders > 0, true, 'the host decoded');
            assert.deepEqual(samples, new Int16Array(source.slice(44).buffer));
        });
    },
);

describe(
    'codecs/webcodecs audio routes',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        test('linear PCM is read by the library, never handed to the host', async () => {
            const decoders = await hostAudioDecoders(() =>
                new MediaForge().convert(new Blob([waveFixture()]), 'flac'),
            );
            assert.equal(decoders, 0);
        });

        test('the host decodes compressed audio unless builtin is preferred', async t => {
            if (!(await capabilities()).audio.decode.includes('flac'))
                return t.skip('no FLAC decoding');
            const { blob: flac } = await new MediaForge().convert(
                new Blob([waveFixture()]),
                'flac',
            );
            const host = (await lite().capabilities()).audio.decode.includes('flac');
            const preferred = await hostAudioDecoders(() => new MediaForge().convert(flac, 'wav'));
            assert.equal(preferred > 0, host, 'the host decodes what it supports');
            const builtin = await hostAudioDecoders(() =>
                new MediaForge({ codecPreference: 'builtin' }).convert(flac, 'wav'),
            );
            assert.equal(builtin, 0, 'the builtin preference keeps the library decoder');
        });
    },
);

describe(
    'codecs/webcodecs AudioData',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        /** A stereo AudioData of `format` holding `samples` (interleaved unless planar). */
        const audioData = (format, samples) =>
            new AudioData({
                format,
                sampleRate: 48000,
                numberOfChannels: 2,
                numberOfFrames: samples.length / 2,
                timestamp: 0,
                data: samples,
            });

        test('integer samples are copied exactly, scaled by a power of two', async () => {
            const { copyAudioPlanes } = await internal('codecs/webcodecs/audio-data');
            const cases = [
                ['s16', Int16Array.of(32767, -32768, 1, -1, 20000, 0), [32767, 1, 20000], 15],
                [
                    's16-planar',
                    Int16Array.of(32767, 1, 20000, -32768, -1, 0),
                    [32767, 1, 20000],
                    15,
                ],
                [
                    's32-planar',
                    Int32Array.of(2 ** 30, 3, -5, 7, 0, -(2 ** 31)),
                    [2 ** 30, 3, -5],
                    31,
                ],
                ['u8', Uint8Array.of(255, 0, 128, 129, 1, 254), [127, 0, -127], 7],
            ];
            for (const [format, samples, left, bits] of cases) {
                const data = audioData(format, samples);
                const planes = [new Float32Array(3), new Float32Array(3)];
                copyAudioPlanes(data, planes, 0);
                data.close();
                assert.deepEqual(
                    [...planes[0]],
                    left.map(value => Math.fround(value / 2 ** bits)),
                    format,
                );
            }
        });

        test('integer AudioData reaches the host encoder as its exact samples', async t => {
            const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
            if (!(await hostEncodes(config))) return t.skip('the browser has no Opus encoder');
            const samples = Int16Array.from(
                { length: 1920 * 4 },
                (_, at) => ((at * 7919) % 65536) - 32768,
            );
            async function* sound() {
                for (let block = 0; block < 4; block++)
                    yield new AudioData({
                        format: 's16',
                        sampleRate: 48000,
                        numberOfChannels: 2,
                        numberOfFrames: 960,
                        timestamp: (block * 960 * 1e6) / 48000,
                        data: samples.slice(block * 1920, (block + 1) * 1920),
                    });
            }
            // The host's own float copy of s16 divides positive samples by 32767 in Chromium.
            const given = [];
            const encode = AudioEncoder.prototype.encode;
            AudioEncoder.prototype.encode = function (audio) {
                const plane = new Float32Array(audio.numberOfFrames);
                audio.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
                given.push(...plane);
                return encode.call(this, audio);
            };
            try {
                await encodeFrames({ audio: sound() }, { to: 'webm', audio: { codec: 'opus' } });
            } finally {
                AudioEncoder.prototype.encode = encode;
            }
            const expected = samples.filter((_, at) => at % 2 === 0);
            assert.deepEqual(
                given.slice(0, expected.length),
                [...expected].map(value => Math.fround(value / 32768)),
            );
        });
    },
);
