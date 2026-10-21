import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError, convert } from 'mediaforgejs';
import { decodeMp3, encodeMp2, encodeMp3, parseMp3FrameHeader } from 'mediaforgejs/codecs';
import { mpegAudio } from 'mediaforgejs/plugins';
import { decodeChunks, pluginAudioDecoder, trackPackets } from '../helpers/codec-contract.mjs';
import { toneSignal } from '../helpers/mp3-fixtures.mjs';
import { bytesOf, seededRandom } from '../helpers/pcm.mjs';
import { analyze, chirp, snrDb } from '../helpers/codec-quality.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { StreamingMp3Encoder } = await import(distUrl('esm/codecs/mpeg-audio/mp3-encoder.js'));

/** The samples of an MP2 stream, every frame decoded by the mpegAudio plugin. */
async function mp2Decode(stream) {
    const { track, packets } = await trackPackets(stream);
    const chunks = decodeChunks(await pluginAudioDecoder(mpegAudio, track), packets);
    const channelData = Array.from({ length: track.channelCount }, (_, channel) => {
        const plane = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk[0].length, 0));
        let at = 0;
        for (const chunk of chunks) {
            plane.set(chunk[channel], at);
            at += chunk[channel].length;
        }
        return plane;
    });
    return { sampleRate: track.sampleRate, channelData };
}

/** A float WAVE file of mono `samples`. */
function floatWave(samples, rate) {
    const wav = new Uint8Array(44 + samples.length * 4);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    view.setUint32(4, 36 + samples.length * 4, true);
    wav.set(new TextEncoder().encode('WAVEfmt '), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 32, true);
    wav.set(new TextEncoder().encode('data'), 36);
    view.setUint32(40, samples.length * 4, true);
    new Float32Array(wav.buffer, 44).set(samples);
    return new Blob([wav]);
}

/** Granules of each frame of a mono MP3: [short, mixed] counts from the side information. */
function blockTypes(mp3, rate) {
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    let short = 0;
    let mixed = 0;
    for (let at = 0; at + 4 < mp3.length;) {
        if (mp3[at] !== 0xff || (mp3[at + 1] & 0xe0) !== 0xe0) {
            at++;
            continue;
        }
        let bit = (at + 4 + (mp3[at + 1] & 1 ? 0 : 2)) * 8;
        const read = count => {
            let value = 0;
            for (let index = 0; index < count; index++, bit++)
                value = (value << 1) | ((mp3[bit >> 3] >> (7 - (bit & 7))) & 1);
            return value;
        };
        read(9 + 5 + 4);
        for (let granule = 0; granule < 2; granule++) {
            read(12 + 9 + 8 + 4);
            if (read(1)) {
                if (read(2) === 2) short++;
                mixed += read(1);
                read(10 + 9);
            } else read(15 + 4 + 3);
            read(3);
        }
        at += Math.floor((144000 * bitrates[mp3[at + 2] >> 4]) / rate) + ((mp3[at + 2] >> 1) & 1);
    }
    return { short, mixed };
}

describe('mpeg-audio encoding', () => {
    describe('MP3', () => {
        for (const [rate, channels, mode, options] of [
            [48000, 2, '128 kbps', undefined],
            [44100, 1, '64 kbps', undefined],
            [32000, 2, '320 kbps', undefined],
            [48000, 2, 'VBR', { vbr: true }],
        ])
            test(`${rate} Hz ${channels} ch ${mode} decodes to the input length`, async () => {
                const kbps = Number.parseInt(mode) || 128;
                const tone = toneSignal(rate, channels, rate * 2 + 371);
                const decoded = await decodeMp3(
                    await encodeMp3(tone, { sampleRate: rate, bitrate: kbps, ...options }),
                );
                assert.deepEqual(
                    [decoded.sampleRate, decoded.channels, decoded.sampleFrames],
                    [rate, channels, tone[0].length],
                    'the Info frame trims the delay and padding',
                );
                const trimmed = decoded.frames * 1152 - decoded.sampleFrames;
                assert(trimmed >= 528 + 529 && trimmed < 528 + 529 + 1152);
                for (let channel = 0; channel < channels; channel++)
                    assert(snrDb(tone[channel], decoded.channelData[channel]) > 30);
                if (channels === 2)
                    assert(snrDb(tone[0], decoded.channelData[1]) < 3, 'not swapped');
                for (const plane of decoded.channelData)
                    assert(plane.every(value => value >= -1 && value <= 1));
            });

        for (const [rate, channels, kbps] of [
            [48000, 2, 128],
            [44100, 2, 320],
            [48000, 1, 64],
            [32000, 2, 96],
        ])
            test(
                `${rate} Hz ${channels} ch ${kbps} kbps writes an Info frame and constant-size ` +
                    `frames`,
                async () => {
                    const frames = rate;
                    const bytes = await encodeMp3(
                        Array.from({ length: channels }, () => chirp(frames, rate)),
                        { sampleRate: rate, bitrate: kbps },
                    );
                    const audioFrames = Math.ceil(frames / 1152) + 1;
                    const frameBytes = Math.floor((144 * kbps * 1000) / rate);
                    assert(bytes.length >= (audioFrames + 1) * frameBytes);
                    assert(bytes.length <= (audioFrames + 1) * (frameBytes + 1));
                    const header = parseMp3FrameHeader(bytes, 0);
                    assert.deepEqual([header.sampleRate, header.channels], [rate, channels]);
                    assert.equal((await decodeMp3(bytes)).sampleFrames, frames);
                },
            );

        test('frames short inputs into whole frames', async () => {
            for (const [samples, frames] of [
                [1, 3],
                [100, 3],
                [1151, 3],
                [1152, 3],
                [1153, 4],
                [4097, 6],
            ]) {
                const planes = [new Float32Array(samples), new Float32Array(samples)];
                const mp3 = await encodeMp3(planes, { sampleRate: 48000 });
                assert.equal(mp3.length, frames * 384, `${samples} samples`);
            }
        });

        test('the bitrate is bits per second, text with a unit, or kbit/s below 1000', async () => {
            const planes = [chirp(4608, 48000)];
            const mp3 = bitrate => encodeMp3(planes, { sampleRate: 48000, bitrate });
            const expected = await mp3(192);
            const info = parseMp3FrameHeader(expected, 0);
            assert.equal(parseMp3FrameHeader(expected, info.frameLength).frameLength, 576);
            for (const bitrate of [192_000, '192k', '0.192M'])
                assert.deepEqual(await mp3(bitrate), expected, String(bitrate));
            assert.deepEqual(await mp3('loud'), await mp3(undefined), 'unusable: the default');
        });

        test('a whole-file encode weighs attacks against the whole input', async () => {
            // Clicks in a quiet first second are attacks against the level so far, not against a
            // loud second half; a conversion, which streams, cannot know the second half yet.
            const rate = 44100;
            const random = seededRandom(3);
            const plane = Float32Array.from({ length: 2 * rate }, (_, index) => {
                if (index >= rate) return 0.8 * (random() * 2 - 1);
                const click = index % 4410 < 32 ? 0.25 * (random() * 2 - 1) : 0;
                return 0.05 * Math.sin((2 * Math.PI * 330 * index) / rate) + click;
            });
            const whole = await encodeMp3([plane], { sampleRate: rate });
            const streaming = new StreamingMp3Encoder(rate, 1, 128);
            streaming.pushPlanar([plane]);
            const { infoFrame, audio } = streaming.finishOutput();
            const quietHalf = bytes => bytes.subarray(0, bytes.length / 2);
            const shortBlocks = bytes => blockTypes(quietHalf(bytes), rate).short;
            assert.equal(whole.length, infoFrame.length + audio.length);
            assert(shortBlocks(audio) > 0, 'the streaming encoder switches on the clicks');
            assert(shortBlocks(whole) < shortBlocks(audio));
        });

        test('reports progress frame by frame up to the frames expected', async () => {
            const seen = [];
            await encodeMp3([new Float32Array(1152 * 3)], {
                sampleRate: 48000,
                onProgress: (done, total) => seen.push([done, total]),
            });
            assert.deepEqual(seen, [
                [1, 4],
                [2, 4],
                [3, 4],
                [4, 4],
            ]);
        });

        test(
            'never mixes short and long blocks: a tone under clicks keeps the band below 1 ' +
                'kHz',
            async () => {
                // The long subbands of a mixed block do not overlap-add with the start and stop
                // windows around them, which left a fixed error below 1.4 kHz at every bitrate.
                const rate = 44100;
                const frames = 2 * rate;
                const random = seededRandom(3);
                const samples = Float32Array.from({ length: frames }, (_, index) => {
                    const click = index % 8820 < 64 ? 0.3 * (random() * 2 - 1) : 0;
                    return 0.4 * Math.sin((2 * Math.PI * 330 * index) / rate) + click;
                });
                const mp3 = await bytesOf(
                    (
                        await convert(floatWave(samples, rate), {
                            to: 'mp3',
                            audio: { bitrate: 256_000 },
                        })
                    ).blob,
                );
                const { short, mixed } = blockTypes(mp3, rate);
                assert(short > 0, 'the clicks switch to short blocks');
                assert.equal(mixed, 0);
                const decoded = (await decodeMp3(mp3)).channelData[0];
                const lowPass = signal => {
                    const out = new Float64Array(frames);
                    const k = 1 - Math.exp((-2 * Math.PI * 1000) / rate);
                    let first = 0;
                    let second = 0;
                    for (let index = 0; index < frames; index++) {
                        first += k * (signal(index) - first);
                        second += k * (first - second);
                        out[index] = second;
                    }
                    return out;
                };
                const low = lowPass(index => samples[index]);
                const error = lowPass(index => decoded[index] - samples[index]);
                let signal = 0;
                let noise = 0;
                for (let index = rate / 4; index < frames - rate / 4; index++) {
                    signal += low[index] ** 2;
                    noise += error[index] ** 2;
                }
                assert(10 * Math.log10(signal / noise) > 50);
            },
        );

        test('quantizes short windows with subblock gain at their level, not louder', async () => {
            // A subblock gain of s rebuilds a short window 2^-2s smaller, so its lines quantize
            // x^(3/4) times 2^1.5s; quantized as if times 2^2s, the quieter windows came back too
            // loud and the bed before a loud burst carried an error near its own level.
            const rate = 44100;
            const samples = Float32Array.from(
                { length: rate },
                (_, index) =>
                    0.1 * Math.sin((2 * Math.PI * 440 * index) / rate) +
                    0.033 * Math.sin((2 * Math.PI * 1500 * index) / rate),
            );
            const bursts = [];
            for (let at = 6000; at + 2000 < rate; at += 6151) {
                bursts.push(at);
                for (let index = 0; index < 1500; index++)
                    samples[at + index] += 0.8 * Math.sin((2 * Math.PI * 3000 * index) / rate);
            }
            for (const kbps of [128, 256]) {
                const mp3 = await encodeMp3([samples], { sampleRate: rate, bitrate: kbps });
                const decoded = (await decodeMp3(mp3)).channelData[0];
                for (const at of bursts) {
                    let signal = 0;
                    let noise = 0;
                    for (let index = at - 353; index < at - 44; index++) {
                        signal += samples[index] ** 2;
                        noise += (decoded[index] - samples[index]) ** 2;
                    }
                    assert(10 * Math.log10(noise / signal) < -30, `${kbps} kbps, burst at ${at}`);
                }
            }
        });

        test('codes short granules near transients no coarser than steady ones', async () => {
            // The granules of a frame share one global gain (short ones a fixed offset coarser).
            const rate = 44100;
            const frames = 2 * rate;
            const random = seededRandom(3);
            const planes = [new Float32Array(frames), new Float32Array(frames)];
            for (let index = 0; index < frames; index++) {
                const phase = index % 4410;
                const burst = phase < 400 ? 0.5 * Math.exp(-phase / 100) : 0;
                for (let channel = 0; channel < 2; channel++)
                    planes[channel][index] =
                        0.4 * Math.sin((2 * Math.PI * (330 + 110 * channel) * index) / rate) +
                        burst * (random() * 2 - 1) +
                        0.03 * (random() * 2 - 1);
            }
            const mp3 = await encodeMp3(planes, { sampleRate: rate, bitrate: 320 });
            const decoded = (await decodeMp3(mp3)).channelData;
            let signal = 0;
            let noise = 0;
            for (let index = rate / 4; index < frames - rate / 4; index++) {
                const phase = index % 4410;
                if (phase >= 1000 && phase <= 3410) continue;
                for (let channel = 0; channel < 2; channel++) {
                    const value = planes[channel][index];
                    signal += value ** 2;
                    noise += (decoded[channel][index] - value) ** 2;
                }
            }
            assert(10 * Math.log10(signal / noise) > 35.5);
        });

        test('a conversion keeps the level of a source whose peaks exceed full scale', async () => {
            const rate = 44100;
            const samples = Float32Array.from({ length: 2 * rate }, (_, index) => {
                const level = index >= rate && index < rate + 2205 ? 1.3 : 0.25;
                return level * Math.sin((2 * Math.PI * 1000 * index) / rate);
            });
            const mp3 = await convert(floatWave(samples, rate), 'mp3');
            const plane = (await decodeMp3(await bytesOf(mp3.blob))).channelData[0];
            let energy = 0;
            for (let index = rate / 4; index < (3 * rate) / 4; index++) energy += plane[index] ** 2;
            const level = 20 * Math.log10(Math.sqrt(energy / (rate / 2)) / (0.25 / Math.SQRT2));
            assert(Math.abs(level) < 0.2, `${level} dB`);
        });

        test('refuses an empty input and an unsupported rate with a library error', async () => {
            await assert.rejects(
                encodeMp3([new Float32Array(0)], { sampleRate: 48000 }),
                /empty input/,
            );
            await assert.rejects(
                encodeMp3([new Float32Array(1152)], { sampleRate: 12345 }),
                error => error instanceof MediaForgeError,
            );
        });

        test('stops with its signal, also between blocks', async () => {
            const planes = [new Float32Array(96000), new Float32Array(96000)];
            await assert.rejects(
                encodeMp3(planes, { sampleRate: 48000, signal: AbortSignal.abort() }),
                { code: 'ABORT' },
            );
            const controller = new AbortController();
            const encoding = encodeMp3(planes, { sampleRate: 48000, signal: controller.signal });
            controller.abort();
            await assert.rejects(encoding, { code: 'ABORT' });
        });
    });

    describe('MP2', () => {
        for (const [rate, channels, kbps, minSnr] of [
            [48000, 2, 192, 60],
            [44100, 2, 128, 60],
            [32000, 1, 96, 60],
            [48000, 1, 64, 60],
            [48000, 2, 64, 35],
        ])
            test(
                `${rate} Hz ${channels} ch ${kbps} kbps decodes 481 samples late at its level ` +
                    `above ${minSnr} dB`,
                async () => {
                    const frames = Math.max(rate, 16384);
                    const planes = Array.from({ length: channels }, (_, channel) =>
                        chirp(frames, rate, channel === 1),
                    );
                    const decoded = await mp2Decode(
                        await encodeMp2(planes, { sampleRate: rate, bitrate: kbps }),
                    );
                    assert.deepEqual(
                        [decoded.sampleRate, decoded.channelData.length],
                        [rate, channels],
                    );
                    for (let channel = 0; channel < channels; channel++) {
                        const metrics = analyze(planes[channel], decoded.channelData[channel]);
                        assert.equal(metrics.delay, 481);
                        assert(metrics.snr > minSnr, `${metrics.snr} dB`);
                        assert(Math.abs(metrics.level - 1) < 0.01, `level ${metrics.level}`);
                        assert(metrics.peak <= 0.31, `peak ${metrics.peak}`);
                    }
                    if (channels === 2)
                        assert(analyze(planes[0], decoded.channelData[1]).snr < 3, 'not swapped');
                },
            );

        test('silence decodes to exact silence', async () => {
            const silence = [new Float32Array(48000), new Float32Array(48000)];
            const decoded = await mp2Decode(await encodeMp2(silence, { sampleRate: 48000 }));
            assert(decoded.channelData.every(plane => plane.every(value => value === 0)));
        });

        test('full scale keeps above 60 dB and within the sample range', async () => {
            const loud = [chirp(48000, 48000, false, 0.999), chirp(48000, 48000, true, 0.999)];
            const decoded = await mp2Decode(
                await encodeMp2(loud, { sampleRate: 48000, bitrate: 384 }),
            );
            const metrics = analyze(loud[0], decoded.channelData[0]);
            assert(metrics.snr > 60);
            assert(metrics.peak <= 1);
        });

        test('frames short inputs into whole frames', async () => {
            for (const [samples, frames] of [
                [1, 1],
                [1152, 1],
                [1153, 2],
                [4097, 4],
            ]) {
                const planes = [new Float32Array(samples), new Float32Array(samples)];
                const mp2 = await encodeMp2(planes, { sampleRate: 48000 });
                assert.equal(mp2.length, frames * 576, `${samples} samples`);
                assert.equal((await mp2Decode(mp2)).channelData[0].length, frames * 1152);
            }
        });

        test('a conversion keeps the level of a source whose peaks exceed full scale', async () => {
            const rate = 44100;
            const samples = Float32Array.from({ length: 2 * rate }, (_, index) => {
                const level = index >= rate && index < rate + 2205 ? 1.3 : 0.25;
                return level * Math.sin((2 * Math.PI * 1000 * index) / rate);
            });
            const plane = (await mp2Decode((await convert(floatWave(samples, rate), 'mp2')).blob))
                .channelData[0];
            let energy = 0;
            for (let index = rate / 4; index < (3 * rate) / 4; index++)
                energy += plane[index + 481] ** 2;
            const level = 20 * Math.log10(Math.sqrt(energy / (rate / 2)) / (0.25 / Math.SQRT2));
            assert(Math.abs(level) < 0.2, `${level} dB`);
        });

        test('refuses an empty input, an unsupported rate and nine channels', async () => {
            await assert.rejects(
                encodeMp2([new Float32Array(0)], { sampleRate: 48000 }),
                /empty input/,
            );
            await assert.rejects(
                encodeMp2([new Float32Array(4096)], { sampleRate: 22050, bitrate: 64 }),
                /sample rate/,
            );
            const nine = Array.from({ length: 9 }, () => new Float32Array(1152));
            await assert.rejects(
                encodeMp2(nine, { sampleRate: 48000 }),
                error => error instanceof MediaForgeError,
            );
        });

        test('reports progress and stops with its signal', async () => {
            const seen = [];
            await encodeMp2([new Float32Array(1152 * 2)], {
                sampleRate: 48000,
                onProgress: (done, total) => seen.push([done, total]),
            });
            assert.deepEqual(seen, [
                [1, 2],
                [2, 2],
            ]);
            const planes = [new Float32Array(96000), new Float32Array(96000)];
            await assert.rejects(
                encodeMp2(planes, { sampleRate: 48000, signal: AbortSignal.abort() }),
                { code: 'ABORT' },
            );
        });
    });
});
