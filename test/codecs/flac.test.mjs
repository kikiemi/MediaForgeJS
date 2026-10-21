import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MediaForgeError, check, convert, open } from 'mediaforgejs';
import {
    decodeFlac,
    decodeFlacFrame,
    encodeFlac,
    flacSamplesToFloat,
    parseFlacStreamInfo,
} from 'mediaforgejs/codecs';
import * as lite from 'mediaforgejs/lite';
import { flac } from 'mediaforgejs/plugins';
import { flacFixture } from '../helpers/original-fixtures.mjs';
import {
    assertAudioDecoderContract,
    pluginAudioDecoder,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import {
    bytesOf,
    deinterleave,
    testSignal,
    toFloat,
    toInt16,
    waveChunks,
    waveSamples,
} from '../helpers/pcm.mjs';

const fixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/flac/${name}`, import.meta.url)));
const isCode = code => error => error.code === code;

/** Encodes interleaved 16-bit samples with the library's FLAC encoder. */
const encode = (samples, channels, rate = 48000) =>
    encodeFlac(deinterleave(toFloat(samples), channels), { sampleRate: rate });

/** Asserts that `samples` encode and decode back unchanged. */
async function assertRoundTrip(samples, channels, rate = 48000) {
    const decoded = await decodeFlac(await encode(samples, channels, rate));
    assert.deepEqual(
        [decoded.sampleRate, decoded.channels, decoded.bitsPerSample, decoded.sampleFrames],
        [rate, channels, 16, samples.length / channels],
    );
    for (let channel = 0; channel < channels; channel++) {
        const restored = toInt16(decoded.channelData[channel]);
        const expected = samples.filter((_, index) => index % channels === channel);
        assert.deepEqual(restored, expected, `channel ${channel}`);
    }
}

describe('flac', () => {
    describe('stream info', () => {
        test('reads rate, channels, depth and length from the head of a file', async () => {
            const file = await encode(testSignal(4096 * 5 + 123, 2), 2);
            const info = parseFlacStreamInfo(file.subarray(0, 42));
            assert.deepEqual(
                [info.sampleRate, info.channels, info.bitsPerSample, info.totalSamples],
                [48000, 2, 16, 4096 * 5 + 123],
            );
        });

        test('reads a bare STREAMINFO record and a dfLa payload alike', async () => {
            const file = await encode(testSignal(4096, 2), 2);
            const info = parseFlacStreamInfo(file.subarray(0, 42));
            assert.deepEqual(parseFlacStreamInfo(file.subarray(8, 42)), info);
            const dfLa = new Uint8Array(42);
            dfLa.set(file.subarray(4, 42), 4);
            assert.deepEqual(parseFlacStreamInfo(dfLa), info);
        });

        test('rejects a cut header with DECODE', async () => {
            const file = await encode(testSignal(4096, 2), 2);
            assert.throws(() => parseFlacStreamInfo(file.subarray(0, 20)), isCode('DECODE'));
        });
    });

    describe('decoding', () => {
        test('decodes a hand-written fixture to its samples', async () => {
            const decoded = await decodeFlac(flacFixture());
            assert.deepEqual(
                [decoded.sampleRate, decoded.channels, decoded.sampleFrames],
                [8000, 1, 48],
            );
            assert.deepEqual(
                [...toInt16(decoded.channelData[0])],
                [...Array(16).fill(1000), ...Array(16).fill(-1000), ...Array(16).fill(0)],
            );
        });

        test('decodes frames one by one, numbered from zero', async () => {
            const file = await encode(testSignal(4096 * 3, 2), 2);
            const info = parseFlacStreamInfo(file.subarray(0, 42));
            const first = decodeFlacFrame(file.subarray(42), { streamInfo: info });
            assert.deepEqual(
                [first.header.blockSize, first.channels.length, first.bitsPerSample],
                [4096, 2, 16],
            );
            const second = decodeFlacFrame(file.subarray(42 + first.byteLength), {
                streamInfo: info,
            });
            assert.equal(second.header.codedNumber, 1);
        });

        test('scales integer samples by 2^(bits - 1)', () => {
            assert.deepEqual(
                [...flacSamplesToFloat(Int32Array.of(-32768, 0, 16384), 16)],
                [-1, 0, 0.5],
            );
            assert.deepEqual(
                [...flacSamplesToFloat(Int32Array.of(-8388608, 4194304), 24)],
                [-1, 0.5],
            );
        });

        test(
            'decodes 24-bit LPC of orders 20 to 32 with 15-bit coefficients like the ' +
                'reference',
            async () => {
                // ffmpeg -f lavfi -i "aevalsrc=0.6*sin(2*PI*440*t)+0.3*sin(2*PI*1234*t)
                // +0.05*(random(0)-0.5):s=8000:d=0.06" -c:a flac -sample_fmt s32
                // -bits_per_raw_sample 24 -compression_level 12 -lpc_type cholesky
                // -max_prediction_order 32 -min_prediction_order 20 -lpc_coeff_precision 15
                // -frame_size 480 -bitexact, with only the STREAMINFO block kept; the digest is
                // that of ffmpeg's s32le decode.
                const decoded = await decodeFlac(fixture('lpc-order32-24bit.flac'));
                assert.deepEqual([decoded.bitsPerSample, decoded.sampleFrames], [24, 480]);
                const s32 = Int32Array.from(decoded.channelData[0], value => value * 2 ** 31);
                assert.equal(
                    createHash('sha256').update(new Uint8Array(s32.buffer)).digest('hex'),
                    '191a6ea7d22fcb7a3df8460b12b2abe1d0a01db74aaf2ff4331909a066f1a247',
                );
            },
        );

        test('decodes 5.1 like the reference and names the FLAC speaker layout', async () => {
            // ffmpeg -f lavfi -i sine=f=440:r=22050:d=0.1 -af "pan=5.1|c0=c0|c1=0.5*c0|c2=0.3*c0|
            // c3=0.1*c0|c4=0.7*c0|c5=0.2*c0" -c:a flac -f ogg; the digest is that of ffmpeg's
            // s16le decode.
            const wave = await bytesOf((await convert(fixture('flac-5.1.oga'), 'wav')).blob);
            const chunks = waveChunks(wave);
            const view = new DataView(wave.buffer);
            const fmt = chunks.get('fmt ').at;
            assert.equal(view.getUint16(fmt, true), 0xfffe, 'WAVE_FORMAT_EXTENSIBLE');
            assert.equal(view.getUint16(fmt + 2, true), 6);
            assert.equal(view.getUint32(fmt + 20, true), 0x3f, 'the 5.1 speaker mask');
            const data = chunks.get('data');
            assert.equal(
                createHash('sha256')
                    .update(wave.subarray(data.at, data.at + data.size))
                    .digest('hex'),
                '056da329f6288b2ae472cbe8377641eb41a80f64625c0140d5022d6075533c29',
            );
        });

        test('keeps the decoder contract through the flac plugin', async () => {
            const { track, packets } = await trackPackets(await encode(testSignal(4096 * 2, 1), 1));
            const decoder = await pluginAudioDecoder(flac, track);
            assertAudioDecoderContract(decoder, packets, 1);
        });
    });

    describe('damage', () => {
        test('reports a frame whose CRC does not match with DECODE naming the CRC', async () => {
            const file = await encode(testSignal(4096 * 2, 2), 2);
            const info = parseFlacStreamInfo(file.subarray(0, 42));
            const length = decodeFlacFrame(file.subarray(42), { streamInfo: info }).byteLength;
            const damaged = file.slice();
            damaged[42 + length - 1] ^= 0x55;
            await assert.rejects(
                decodeFlac(damaged),
                error => error.code === 'DECODE' && /CRC/.test(error.message),
            );
        });

        test('reports a cut frame and a stream without its marker with DECODE', async () => {
            const file = await encode(testSignal(4096 * 2, 2), 2);
            const streamInfo = parseFlacStreamInfo(file.subarray(0, 42));
            const length = decodeFlacFrame(file.subarray(42), { streamInfo }).byteLength;
            await assert.rejects(decodeFlac(file.subarray(0, 42 + length - 3)), isCode('DECODE'));
            await assert.rejects(decodeFlac(file.subarray(1)), isCode('DECODE'));
        });

        test('stops with ABORT when its signal is aborted, also between frames', async () => {
            const file = await encode(testSignal(4096 * 40, 1), 1);
            await assert.rejects(
                decodeFlac(file, { signal: AbortSignal.abort() }),
                isCode('ABORT'),
            );
            const controller = new AbortController();
            const decoding = decodeFlac(file, { signal: controller.signal });
            controller.abort();
            await assert.rejects(decoding, isCode('ABORT'));
        });
    });

    describe('encoding', () => {
        test('round trips stereo of several blocks and a partial one bit-exactly', async () => {
            await assertRoundTrip(testSignal(4096 * 5 + 123, 2), 2);
        });

        test('round trips mono bit-exactly', async () => {
            await assertRoundTrip(testSignal(4096 * 3, 1), 1);
        });

        test('round trips a stream shorter than one block', async () => {
            await assertRoundTrip(testSignal(17, 2), 2, 44100);
        });

        test('round trips at 96 kHz', async () => {
            await assertRoundTrip(testSignal(4096, 2, 7), 2, 96000);
        });

        test('stores the MD5 of the samples and opens strictly at its length', async () => {
            const signal = testSignal(8192, 1, 0x4d463430);
            const output = await encodeFlac([toFloat(signal)], { sampleRate: 8000 });
            const md5 = createHash('md5').update(new Uint8Array(signal.buffer)).digest('hex');
            assert.equal(Buffer.from(output.subarray(26, 42)).toString('hex'), md5);
            const media = await open(new Blob([output]), { validation: 'strict' });
            try {
                assert.deepEqual([media.tracks[0].duration, media.warnings], [1.024, []]);
            } finally {
                media.close();
            }
        });

        test('stops with its signal', async () => {
            const planes = [new Float32Array(48000), new Float32Array(48000)];
            await assert.rejects(
                encodeFlac(planes, { sampleRate: 48000, signal: AbortSignal.abort() }),
                isCode('ABORT'),
            );
        });

        test('reports progress block by block', async () => {
            const seen = [];
            await encodeFlac([new Float32Array(4096 * 2 + 1)], {
                sampleRate: 48000,
                onProgress: (done, total) => seen.push([done, total]),
            });
            assert.deepEqual(seen, [
                [1, 3],
                [2, 3],
                [3, 3],
            ]);
        });

        test('refuses an unusable sample rate with a library error', async () => {
            await assert.rejects(
                encodeFlac([new Float32Array(1024)], { sampleRate: -1 }),
                error => error instanceof MediaForgeError,
            );
        });
    });

    describe('plugin', () => {
        test('without the plugin FLAC does not decode and the flac plugin is named', async () => {
            const file = await encode(testSignal(4096, 2), 2);
            const result = await lite.check(file, 'wav', { copy: false });
            assert.deepEqual([result.supported, result.code], [false, 'PLUGIN']);
            assert.match(result.hint, /'flac' plugin/);
        });

        test('with the plugin a FLAC file converts to WAV within requantization', async () => {
            const samples = testSignal(4096 * 2 + 77, 2);
            const file = await encode(samples, 2);
            assert.equal((await check(file, 'wav', { copy: false })).supported, true);
            const restored = await waveSamples((await convert(file, 'wav')).blob);
            assert.equal(restored.length, samples.length);
            assert(restored.every((value, index) => Math.abs(value - samples[index]) <= 1));
        });

        test('with the plugin FLAC encodes at the requested rate and channels', async () => {
            const file = await encode(testSignal(4096 * 2, 2), 2);
            const media = await open(file);
            try {
                const result = await media.convert('flac', {
                    copy: false,
                    audio: { sampleRate: 44100, channels: 1 },
                });
                const decoded = await decodeFlac(await bytesOf(result.blob));
                assert.deepEqual([decoded.sampleRate, decoded.channels], [44100, 1]);
            } finally {
                media.close();
            }
        });
    });
});
