import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, convert } from 'mediaforgejs';
import {
    StreamingMp3Decoder,
    decodeMp3,
    encodeMp3,
    isMp3InfoFrame,
    parseMp3FrameHeader,
} from 'mediaforgejs/codecs';
import * as lite from 'mediaforgejs/lite';
import { mpegAudio } from 'mediaforgejs/plugins';
import { MP3_FIXTURES, toneSignal } from '../helpers/mp3-fixtures.mjs';
import {
    assertAudioDecoderContract,
    pluginAudioDecoder,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { bytesOf, tone, toInt16, waveFile, waveSamples } from '../helpers/pcm.mjs';
import { snrDb } from '../helpers/codec-quality.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { MpegSynthesisFilterbank } = await import(
    distUrl('esm/codecs/mpeg-audio/layer12-decoder.js')
);
const { SYNTHESIS_WINDOW } = await import(distUrl('esm/codecs/mpeg-audio/layer12-tables.js'));

const isCode = code => error => error.code === code;

const concat = parts => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

/** The frames of a raw MP3 stream, without ID3 tags and its Xing/Info frame. */
function framesOf(bytes) {
    const list = [];
    let offset = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
        offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] === 0x54 && bytes[offset + 1] === 0x41 && bytes[offset + 2] === 0x47)
            break;
        const header = parseMp3FrameHeader(bytes, offset);
        if (!header || offset + header.frameLength > bytes.length) break;
        const frame = bytes.subarray(offset, offset + header.frameLength);
        if (!(list.length === 0 && isMp3InfoFrame(frame))) list.push(frame);
        offset += header.frameLength;
    }
    return list;
}

/** CRC-16 (polynomial 0x8005, initial 0xffff), bit by bit. */
function mpegCrc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

/**
 * A frame (main_data_begin 0) declared one bitrate index higher, with room for a CRC-16 it then
 * carries; its side information and audio data stay byte-identical.
 */
function protectFrame(frame) {
    const header = parseMp3FrameHeader(frame, 0);
    const start = new Uint8Array(frame.subarray(0, 4));
    start[1] &= 0xfe;
    start[2] = (start[2] & 0x0f) + ((start[2] >> 4) + 1) * 16;
    start[2] &= 0xfd;
    const protectedFrame = new Uint8Array(parseMp3FrameHeader(start, 0).frameLength);
    protectedFrame.set(start);
    protectedFrame.set(frame.subarray(4), 6);
    const crc = mpegCrc16([
        ...protectedFrame.subarray(2, 4),
        ...protectedFrame.subarray(6, 6 + header.sideInfoLength),
    ]);
    protectedFrame[4] = crc >> 8;
    protectedFrame[5] = crc & 0xff;
    return protectedFrame;
}

const mainDataBegin = frame => (frame[4] << 1) | (frame[5] >> 7);

/** One second of the library's 48 kHz stereo 128 kbps MP3 of the fixtures' tones. */
const stream = await encodeMp3(toneSignal(48000, 2, 48000), { sampleRate: 48000 });
const frames = framesOf(stream);

describe('mpeg-audio decoding', () => {
    describe('MP3 against the reference decoder', () => {
        for (const fixture of MP3_FIXTURES)
            test(`${fixture.name} decodes within 1e-4 of the reference at its length`, async () => {
                const decoded = await decodeMp3(fixture.bytes());
                assert.deepEqual(
                    [decoded.sampleRate, decoded.channels, decoded.sampleFrames],
                    [fixture.sampleRate, fixture.channels, fixture.sampleFrames],
                );
                const reference = new Int16Array(fixture.reference().buffer);
                let worst = 0;
                for (let index = 0; index < fixture.referenceFrames; index++)
                    for (let channel = 0; channel < fixture.channels; channel++) {
                        const expected = reference[index * fixture.channels + channel] / 32768;
                        const actual = decoded.channelData[channel][fixture.referenceStart + index];
                        worst = Math.max(worst, Math.abs(expected - actual));
                    }
                assert(worst < 1e-4, `${worst} from the reference`);
            });

        test('the streaming decoder outputs whole coded frames past the trimmed length', () => {
            for (const fixture of MP3_FIXTURES) {
                const decoder = new StreamingMp3Decoder();
                let coded = 0;
                for (const frame of framesOf(fixture.bytes()))
                    coded += decoder.pushFrame(frame)[0].length;
                assert.deepEqual(
                    [decoder.sampleRate, decoder.channels],
                    [fixture.sampleRate, fixture.channels],
                );
                assert.equal(coded % (fixture.sampleRate >= 32000 ? 1152 : 576), 0);
                assert(coded > fixture.sampleFrames, fixture.name);
            }
        });
    });

    describe('MP3 syntax', () => {
        test('a CRC-protected frame decodes like the same frame without CRC', async () => {
            const protectedFrame = protectFrame(frames[0]);
            assert.equal(parseMp3FrameHeader(protectedFrame, 0).crc, true);
            const expected = new StreamingMp3Decoder().pushFrame(frames[0]);
            assert(expected[0].some(value => value !== 0));
            assert.deepEqual(new StreamingMp3Decoder().pushFrame(protectedFrame), expected);
            assert.equal((await decodeMp3(protectedFrame)).frames, 1);
        });

        test('MPEG-2 intensity position 1 puts left 2^-0.25 below right', () => {
            // 22.05 kHz joint stereo with intensity only: the right channel codes no lines and
            // every intensity position is 1, the largest value of its 1-bit scalefactors.
            const fields = [
                [0xfff380, 24],
                [0x50, 8],
                [0, 8],
                [0, 2],
                ...[
                    [9, 2, 196, 0, 1],
                    [21, 0, 0, 86, 0],
                ].flatMap(([part23, bigValues, gain, compress, table]) => [
                    [part23, 12],
                    [bigValues, 9],
                    [gain, 8],
                    [compress, 9],
                    [0, 1],
                    [table, 5],
                    [0, 5],
                    [0, 5],
                    [15, 4],
                    [7, 3],
                    [0, 1],
                    [0, 1],
                ]),
                [0b010, 3],
                [0b0010, 4],
                [(1 << 21) - 1, 21],
            ];
            const bits = fields
                .map(([value, width]) => value.toString(2).padStart(width, '0'))
                .join('');
            const frame = new Uint8Array(208);
            for (let bit = 0; bit < bits.length; bit++)
                frame[bit >> 3] |= Number(bits[bit]) << (7 - (bit & 7));
            const decoder = new StreamingMp3Decoder();
            const [left, right] = [0, 1, 2].map(() => decoder.pushFrame(frame)).at(-1);
            assert(right.some(value => Math.abs(value) > 1e-4));
            for (let index = 0; index < left.length; index++)
                assert(Math.abs(left[index] - right[index] * 2 ** -0.25) < 1e-6);
        });

        test('a granule with its main data before the stream is silent', () => {
            const cut = frames.findIndex((frame, index) => {
                if (index === 0 || mainDataBegin(frame) === 0) return false;
                return new StreamingMp3Decoder()
                    .pushFrame(frame)[0]
                    .subarray(576)
                    .some(value => value !== 0);
            });
            assert(cut > 0);
            const planes = new StreamingMp3Decoder().pushFrame(frames[cut]);
            assert(planes[0].subarray(0, 576).every(value => value === 0));
        });

        test('both channels of a granule without its main data are silent together', () => {
            for (const frame of frames.slice(1)) {
                if (mainDataBegin(frame) === 0) continue;
                const [left, right] = new StreamingMp3Decoder().pushFrame(frame);
                const silent = plane => plane.subarray(0, 576).every(value => value === 0);
                assert.equal(silent(left), silent(right));
            }
        });

        test('the synthesis filterbank equals the standard direct matrixing and windowing', () => {
            // ISO/IEC 11172-3: V[i] = sum over k of cos((16 + i)(2k + 1)pi/64) x[k], with and
            // without trailing zero subbands.
            const bank = new MpegSynthesisFilterbank();
            const v = new Float64Array(1024);
            const out = new Float32Array(32);
            let seed = 7;
            const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.4;
            let worst = 0;
            for (let block = 0; block < 64; block++) {
                const x = new Float64Array(32);
                for (let k = 0; k < [32, 12, 20, 0][block % 4]; k++) x[k] = random();
                bank.run(x, out, 0);
                v.copyWithin(64, 0, 960);
                for (let i = 0; i < 64; i++) {
                    v[i] = 0;
                    for (let k = 0; k < 32; k++)
                        v[i] += Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64) * x[k];
                }
                for (let j = 0; j < 32; j++) {
                    let sample = 0;
                    for (let i = 0; i < 8; i++)
                        sample +=
                            v[128 * i + j] * SYNTHESIS_WINDOW[64 * i + j] +
                            v[128 * i + 96 + j] * SYNTHESIS_WINDOW[64 * i + 32 + j];
                    worst = Math.max(worst, Math.abs(out[j] - Math.max(-1, Math.min(1, sample))));
                }
            }
            assert(worst < 1e-6, `${worst}`);
        });
    });

    describe('MP3 damage', () => {
        test('drops a truncated final frame and decodes the rest unchanged', async () => {
            const whole = await decodeMp3(stream);
            const partial = await decodeMp3(stream.subarray(0, stream.length - 100));
            assert.equal(partial.frames, whole.frames - 1);
            assert(
                snrDb(
                    whole.channelData[0].subarray(0, partial.sampleFrames),
                    partial.channelData[0],
                ) > 100,
            );
        });

        test('skips garbage between frames', async () => {
            const garbage = Uint8Array.from(
                { length: 777 },
                (_, index) => (index * 89 + 13) & 0xff,
            );
            const resynchronized = await decodeMp3(
                concat([garbage, ...frames.slice(0, 5), garbage, ...frames.slice(5)]),
            );
            assert.equal(resynchronized.frames, frames.length);
            assert(Number.isFinite(resynchronized.channelData[0][1000]));
        });

        test('reports garbage alone and an empty input with DECODE', async () => {
            const garbage = Uint8Array.from(
                { length: 777 },
                (_, index) => (index * 89 + 13) & 0xff,
            );
            await assert.rejects(decodeMp3(garbage), isCode('DECODE'));
            await assert.rejects(decodeMp3(new Uint8Array(0)), isCode('DECODE'));
        });

        test('stops with ABORT when its signal is aborted, also between frames', async () => {
            await assert.rejects(
                decodeMp3(stream, { signal: AbortSignal.abort() }),
                isCode('ABORT'),
            );
            const long = concat([stream, stream, stream]);
            const controller = new AbortController();
            const decoding = decodeMp3(long, { signal: controller.signal });
            controller.abort();
            await assert.rejects(decoding, isCode('ABORT'));
        });

        test('reports free-format frames with DECODE naming them', async () => {
            const freeFormat = frames[0].slice();
            freeFormat[2] &= 0x0f;
            await assert.rejects(
                decodeMp3(concat([freeFormat, ...frames.slice(1)])),
                error => error.code === 'DECODE' && /free-format/.test(error.message),
            );
            assert.throws(() => parseMp3FrameHeader(freeFormat, 0), isCode('DECODE'));
        });

        test('reports a frame whose CRC does not match with DECODE naming the CRC', async () => {
            const damaged = protectFrame(frames[0]);
            damaged[9] ^= 0x10;
            assert.throws(
                () => new StreamingMp3Decoder().pushFrame(damaged),
                error => error.code === 'DECODE' && /CRC/.test(error.message),
            );
            await assert.rejects(decodeMp3(damaged), isCode('DECODE'));
        });

        test(
            'the streaming decoder reports cut frames, garbage and a format change with ' +
                'DECODE',
            async () => {
                const decoder = new StreamingMp3Decoder();
                for (let index = 0; index < 4; index++) decoder.pushFrame(frames[index]);
                assert.throws(
                    () => decoder.pushFrame(frames[4].subarray(0, frames[4].length - 1)),
                    isCode('DECODE'),
                );
                assert.throws(
                    () => decoder.pushFrame(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7)),
                    isCode('DECODE'),
                );
                const other = framesOf(
                    await encodeMp3(toneSignal(44100, 2, 4096), { sampleRate: 44100 }),
                )[0];
                assert.throws(
                    () => decoder.pushFrame(other),
                    error =>
                        error.code === 'DECODE' && /format changes mid-stream/.test(error.message),
                );
            },
        );

        test('corrupt main data decodes to finite samples or fails with DECODE', () => {
            const noisy = frames[6].slice();
            for (let index = 40; index < noisy.length; index++) noisy[index] = (index * 131) & 0xff;
            try {
                const planes = new StreamingMp3Decoder().pushFrame(noisy);
                assert(planes.every(plane => plane.every(Number.isFinite)));
            } catch (error) {
                assert.equal(error.code, 'DECODE');
            }
        });
    });

    describe('through the mpegAudio plugin', () => {
        const track = { codec: 'mp3', sampleRate: 48000, channelCount: 2 };

        test('keeps the decoder contract', async () => {
            const { track: mp3, packets } = await trackPackets(stream);
            assertAudioDecoderContract(await pluginAudioDecoder(mpegAudio, mp3), packets, 2);
        });

        test('decodes a packet of several frames like the frames one by one', async () => {
            const single = await pluginAudioDecoder(mpegAudio, track);
            const packed = await pluginAudioDecoder(mpegAudio, track);
            const separate = frames.slice(0, 6).flatMap(frame => [...single.decode(frame)]);
            const grouped = [frames.slice(0, 2), frames.slice(2, 3), frames.slice(3, 6)].flatMap(
                group => [...packed.decode(concat(group))],
            );
            assert.equal(grouped.length, 6);
            assert.deepEqual(grouped, separate);
        });

        test('reports a packet whose second frame is cut with DECODE', async () => {
            const decoder = await pluginAudioDecoder(mpegAudio, track);
            assert.throws(
                () => [...decoder.decode(concat([frames[6], frames[7].subarray(0, 50)]))],
                isCode('DECODE'),
            );
        });

        test(
            'converts frames that switch rate and channels back to the track shape, warning ' +
                'once',
            async () => {
                const warnings = [];
                const decoder = await pluginAudioDecoder(mpegAudio, track, code =>
                    warnings.push(code),
                );
                const low = framesOf(
                    await encodeMp3(toneSignal(32000, 1, 16000), {
                        sampleRate: 32000,
                        bitrate: 48,
                    }),
                );
                const units = [...frames.slice(0, 10), ...low].flatMap(frame => [
                    ...decoder.decode(frame),
                ]);
                units.push(...(decoder.flush?.() ?? []));
                assert(units.every(planes => planes.length === 2));
                const left = units.reduce((sum, planes) => sum + planes[0].length, 0);
                assert.equal(
                    left,
                    10 * 1152 + low.length * 1728,
                    '32 kHz frames last as long at 48 kHz',
                );
                assert.deepEqual(warnings, ['AUDIO_FORMAT_CHANGED']);
                const tail = units.slice(10);
                for (const [l, r] of tail) assert.deepEqual(l, r, 'mono frames fill both channels');
            },
        );

        test('stereo frames in a mono track become the mean of their sides', async () => {
            // The fold of the host decoder's output (downmixChannels), whatever decodes the track.
            const mono = await pluginAudioDecoder(mpegAudio, { ...track, channelCount: 1 });
            const plain = new StreamingMp3Decoder();
            for (const frame of frames.slice(0, 4)) {
                const [[folded]] = [...mono.decode(frame)];
                const [left, right] = plain.pushFrame(frame);
                const mean = left.map((value, index) => Math.fround((value + right[index]) / 2));
                assert.deepEqual(folded, mean);
            }
        });

        test('MP2 in Matroska decodes as its raw frames despite millisecond times', async () => {
            // At 44.1 kHz a frame lasts 26.12 ms, which Matroska's clock rounds every time.
            const wave = waveFile(toInt16(tone(48000, 2, 16384)), 48000, 2);
            const options = { audio: { sampleRate: 44100 } };
            const mp2 = (await convert(new Blob([wave]), 'mp2', options)).blob;
            const mkv = (await convert(mp2, 'mkv', { copy: true })).blob;
            const support = await check(mkv, 'wav');
            assert.equal(support.supported, true, support.reason);
            assert.deepEqual(
                await bytesOf((await convert(mkv, 'wav')).blob),
                await bytesOf((await convert(mp2, 'wav')).blob),
            );
        });
    });

    describe('plugin', () => {
        test('without the plugin MP3 does not decode and mpegAudio is named', async () => {
            const result = await lite.check(stream, 'wav', { copy: false });
            assert.deepEqual([result.supported, result.code], [false, 'PLUGIN']);
            assert.match(result.hint, /'mpegAudio' plugin/);
        });

        test('with the plugin a raw MP3 converts to WAV of its gapless length', async () => {
            assert.equal((await check(stream, 'wav', { copy: false })).supported, true);
            const restored = await waveSamples(
                (await convert(new Blob([stream], { type: 'audio/mpeg' }), 'wav')).blob,
            );
            assert.equal(restored.length, 48000 * 2);
            const left = Float32Array.from(
                { length: 48000 },
                (_, index) => restored[index * 2] / 32768,
            );
            assert(snrDb(toneSignal(48000, 2, 48000)[0], left) > 30);
        });
    });
});
