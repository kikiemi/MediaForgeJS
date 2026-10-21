import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MediaForgeError, convert, open } from 'mediaforgejs';
import {
    AacLcDecoder,
    createAudioTrackSource,
    decodeAacFrames,
    encodeAacLc,
    sliceAdtsFrames,
    wrapAdts,
} from 'mediaforgejs/codecs';
import * as lite from 'mediaforgejs/lite';
import { aac } from 'mediaforgejs/plugins';
import {
    assertAudioDecoderContract,
    pluginAudioDecoder,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { analyze, chirp, toneShare } from '../helpers/codec-quality.mjs';
import { bytesOf, waveChunks } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { createAacDecoder } = await import(distUrl('esm/codecs/aac/decoder.js'));

const fixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/aac/${name}`, import.meta.url)));

/** The raw access units of an ADTS stream (headers without CRC). */
function adtsPayloads(bytes) {
    const payloads = [];
    for (let at = 0; at + 7 <= bytes.length;) {
        const length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
        payloads.push(bytes.subarray(at + 7, at + length));
        at += length;
    }
    return payloads;
}

/** Format tag, speaker mask and 16-bit planes of a WAVE file. */
function wavePlanes(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = waveChunks(bytes);
    const fmt = chunks.get('fmt ').at;
    const channels = view.getUint16(fmt + 2, true);
    const data = chunks.get('data');
    const frames = data.size / 2 / channels;
    return {
        tag: view.getUint16(fmt, true),
        mask: view.getUint16(fmt, true) === 0xfffe ? view.getUint32(fmt + 20, true) : undefined,
        planes: Array.from({ length: channels }, (_, channel) =>
            Float64Array.from({ length: frames }, (_, frame) =>
                view.getInt16(data.at + (frame * channels + channel) * 2, true),
            ),
        ),
    };
}

const toWave = async input => wavePlanes(await bytesOf((await convert(input, 'wav')).blob));

/** Every block a packet decoder yields for `packets`, joined per channel. */
function decodeJoined(decoder, packets) {
    const units = packets.flatMap(packet => [...decoder.decode(packet)]);
    return units[0].map((_, channel) => {
        const plane = new Float32Array(units.reduce((sum, unit) => sum + unit[channel].length, 0));
        let at = 0;
        for (const unit of units) {
            plane.set(unit[channel], at);
            at += unit[channel].length;
        }
        return plane;
    });
}

// Hand-built ADTS streams decoded by the reference decoder: RMS per block of `block` samples and
// [frame, ...channel samples] spot checks of its float output. The first two are 22.05 kHz mono
// AAC-LC cores (sparse lines, pulses, PNS bands) with implicit SBR (two FIXFIX envelopes, varying
// inverse filtering, noise floors, added sinusoids), the second with 20-band IID/ICC parametric
// stereo; the third is channel configuration 7 with one tone line per channel.
const REFERENCES = {
    'he-aac-sbr.aac': {
        label: 'HE-AAC (SBR)',
        rate: 44100,
        block: 512,
        frames: 12288,
        rms: Array(2).fill([
            0.03347, 0.04749, 0.11124, 0.15242, 0.20082, 0.23901, 0.17384, 0.16473, 0.20621,
            0.19493, 0.20524, 0.2652, 0.15982, 0.18118, 0.15558, 0.18566, 0.23189, 0.18723, 0.21206,
            0.28429, 0.23519, 0.16174, 0.12322, 0.12562,
        ]),
        spots: [
            [519, 0.004176, 0.004176],
            [1543, -0.106196, -0.106196],
            [2567, 0.037877, 0.037877],
            [3591, 0.042042, 0.042042],
            [4615, -0.0942, -0.0942],
            [5639, 0.140757, 0.140757],
            [6663, 0.080852, 0.080852],
            [7687, -0.187139, -0.187139],
            [8711, 0.1303, 0.1303],
            [9735, -0.124156, -0.124156],
            [10759, -0.239088, -0.239088],
            [11783, -0.024369, -0.024369],
        ],
    },
    'he-aac-ps.aac': {
        label: 'HE-AAC v2 (SBR and parametric stereo)',
        rate: 44100,
        block: 512,
        frames: 12288,
        rms: [
            [
                0.00050269, 0.0022866, 0.0097354, 0.017167, 0.035887, 0.04629, 0.060161, 0.070635,
                0.089743, 0.089565, 0.10204, 0.10376, 0.11416, 0.10307, 0.12346, 0.13492, 0.15053,
                0.13595, 0.16781, 0.1609, 0.13043, 0.10807, 0.078018, 0.062066,
            ],
            [
                0.0041506, 0.019068, 0.063228, 0.08299, 0.14576, 0.14267, 0.15051, 0.14745, 0.15091,
                0.13719, 0.14152, 0.12477, 0.12585, 0.10849, 0.10542, 0.10476, 0.091362, 0.082218,
                0.086186, 0.068173, 0.057956, 0.071087, 0.085766, 0.12305,
            ],
        ],
        spots: [
            [519, -0.000382, -0.000876],
            [1543, -0.011784, -0.046026],
            [2567, -0.011747, -0.020164],
            [3591, -0.054752, -0.16718],
            [4615, 0.063915, -0.020342],
            [5639, 0.009165, 0.028065],
            [6663, -0.027167, 0.064978],
            [7687, -0.009362, -0.044787],
            [8711, 0.135993, 0.085605],
            [9735, -0.014186, -0.007635],
            [10759, -0.112023, -0.049581],
            [11783, 0.029426, 0.013205],
        ],
    },
    'aac-7.1.aac': {
        label: 'AAC 7.1',
        rate: 48000,
        block: 1024,
        frames: 3072,
        rms: [
            [0.061894, 0.088388, 0.088388],
            [0.062092, 0.088388, 0.088388],
            [0.061318, 0.088388, 0.088388],
            [0.058386, 0.088388, 0.088388],
            [0.062294, 0.088388, 0.088388],
            [0.062323, 0.088388, 0.088388],
            [0.062193, 0.088388, 0.088388],
            [0.062253, 0.088388, 0.088388],
        ],
        spots: [
            [
                391, -0.012876, 0.025371, -0.000054, 0.056379, -0.056183, 0.063071, -0.03701,
                0.047397,
            ],
            [
                1159, -0.114276, 0.121617, 0.103074, 0.124868, -0.118691, 0.109509, -0.124849,
                0.123863,
            ],
            [
                1927, -0.114276, 0.121617, 0.103074, 0.00575, -0.118691, 0.109509, -0.124849,
                0.123863,
            ],
            [
                2695, -0.114276, 0.121617, 0.103074, -0.124868, -0.118691, 0.109509, -0.124849,
                0.123863,
            ],
        ],
    },
};

function assertDecodedLike(planes, reference) {
    assert.equal(planes.length, reference.rms.length, 'channel count');
    planes.forEach((plane, channel) => {
        assert.equal(plane.length, reference.frames, 'frames');
        reference.rms[channel].forEach((expected, block) => {
            let sum = 0;
            for (
                let index = block * reference.block;
                index < (block + 1) * reference.block;
                index++
            )
                sum += plane[index] ** 2;
            const actual = Math.sqrt(sum / reference.block);
            assert(
                Math.abs(actual - expected) <= expected * 1e-3 + 1e-6,
                `channel ${channel} block ${block}: RMS ${actual}, reference ${expected}`,
            );
        });
        for (const [frame, ...samples] of reference.spots)
            assert(
                Math.abs(plane[frame] - samples[channel]) < 2e-5,
                `channel ${channel} sample ${frame}: ${plane[frame]} vs ${samples[channel]}`,
            );
    });
}

/** A whole AudioSpecificConfig from a string of bits, spaces ignored. */
const configBits = bits => {
    const digits = bits.replace(/ /g, '');
    return Uint8Array.from({ length: Math.ceil(digits.length / 8) }, (_, index) =>
        parseInt(digits.slice(index * 8, index * 8 + 8).padEnd(8, '0'), 2),
    );
};

describe('aac', () => {
    describe('decoding', () => {
        test('decodes 5.1 in WAVE speaker order, a tone per channel', async () => {
            // Six tones joined as 5.1 by the reference encoder: FL 600 Hz, FR 800, FC 400,
            // LFE 100, BL 1000 and BR 1200 Hz.
            const tones = [600, 800, 400, 100, 1000, 1200];
            const wave = await toWave(fixture('aac-5.1.aac'));
            assert.deepEqual([wave.planes.length, wave.tag, wave.mask], [6, 0xfffe, 0x3f]);
            tones.forEach((frequency, channel) => {
                const plane = wave.planes[channel].subarray(2048);
                assert(toneShare(plane, frequency) > 0.7, `channel ${channel}: ${frequency} Hz`);
                for (const other of tones)
                    if (other !== frequency) assert(toneShare(plane, other) < 0.01);
            });
        });

        test('decodes short windows with TNS within one step of the reference', async () => {
            // A 400 Hz tone ending in silence: its end switches to short windows with TNS filters
            // shorter than the band count. The reference holds samples 8192..11775.
            const wave = await toWave(fixture('tns.aac'));
            const reference = Buffer.from(fixture('tns-reference-8192.s16le'));
            assert.equal(wave.planes[0].length, 16384);
            let worst = 0;
            for (let index = 0; index < reference.length / 2; index++)
                worst = Math.max(
                    worst,
                    Math.abs(wave.planes[0][8192 + index] - reference.readInt16LE(index * 2)),
                );
            assert(worst <= 1, `largest difference ${worst}`);
        });

        for (const [name, reference] of Object.entries(REFERENCES))
            test(
                `decodes ${reference.label} like the reference through the aac ` + `plugin`,
                async () => {
                    const decoder = await pluginAudioDecoder(aac, {
                        codec: 'mp4a.40.2',
                        codecConfig:
                            name === 'aac-7.1.aac'
                                ? Uint8Array.of(0x11, 0xb8)
                                : Uint8Array.of(0x13, 0x88),
                        sampleRate: reference.rate,
                        channelCount: reference.rms.length,
                    });
                    assertDecodedLike(
                        decodeJoined(decoder, adtsPayloads(fixture(name))),
                        reference,
                    );
                },
            );

        test('converts 7.1 to WAVE with the 7.1 mask and the reference samples', async () => {
            const reference = REFERENCES['aac-7.1.aac'];
            const wave = await toWave(fixture('aac-7.1.aac'));
            assert.equal(wave.mask, 0x63f, 'FL FR FC LFE BL BR SL SR');
            for (const [frame, ...samples] of reference.spots)
                samples.forEach((sample, channel) =>
                    assert(Math.abs(wave.planes[channel][frame] / 32768 - sample) < 1e-4),
                );
        });

        test('an input reports the decoded rate and channels of implicit HE-AAC', async () => {
            for (const name of ['he-aac-sbr.aac', 'he-aac-ps.aac']) {
                const media = await open(fixture(name));
                try {
                    assert.deepEqual(
                        [media.tracks[0].sampleRate, media.tracks[0].channelCount],
                        [44100, 2],
                    );
                } finally {
                    media.close();
                }
            }
        });

        test('keeps the decoder contract through the aac plugin', async () => {
            const { track, packets } = await trackPackets(fixture('aac-5.1.aac'));
            assertAudioDecoderContract(await pluginAudioDecoder(aac, track), packets, 6);
        });

        test('drops the encoder delay after a leading libfaac fill element', async () => {
            const marker = Buffer.from('de0200006c69626661616320312e323801c0', 'hex');
            const audio = Buffer.from('01540685a00000800380', 'hex');
            const decoder = createAacDecoder(Uint8Array.of(0x13, 0x88));
            const first = decoder.decodeFrame(marker);
            assert.equal(first[0]?.length ?? 0, 0, 'the marker frame carries no audio');
            assert.equal(decoder.leadingSkip, 1024);
            decoder.decodeFrame(audio);
        });

        test('drops the output of a frame marked by a libfaac fill element after the first', () => {
            // A stream concatenated after encoding: the marked frame's output is its encoder delay;
            // the decoder state carries on.
            const config = Uint8Array.of(0x11, 0xb0);
            const frames = adtsPayloads(fixture('aac-5.1.aac'));
            const reference = createAacDecoder(config);
            const plain = frames.map(frame => reference.decodeFrame(frame));
            const probe = createAacDecoder(config);
            frames.slice(0, 4).forEach(frame => probe.decodeFrame(frame));
            const bits = [];
            const push = (value, width) => {
                for (let bit = width - 1; bit >= 0; bit--) bits.push((value >> bit) & 1);
            };
            for (let bit = 0; bit < probe.lastBitsConsumed - 3; bit++)
                bits.push((frames[3][bit >> 3] >> (7 - (bit & 7))) & 1);
            // A 15-byte fill element: EXT_FILL, 13 bits, 'libfaac 1.28', 7 padding bits; then END.
            push(6, 3);
            push(15, 4);
            push(1, 8);
            push(0, 4);
            push(0, 13);
            for (const char of 'libfaac 1.28') push(char.charCodeAt(0), 8);
            push(0, 7);
            push(7, 3);
            while (bits.length % 8) bits.push(0);
            const marked = Uint8Array.from({ length: bits.length / 8 }, (_, index) =>
                bits.slice(index * 8, index * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0),
            );
            const decoder = createAacDecoder(config);
            const spliced = frames.map((frame, index) =>
                decoder.decodeFrame(index === 3 ? marked : frame),
            );
            assert.deepEqual(spliced.slice(0, 3), plain.slice(0, 3));
            assert.deepEqual(
                spliced[3].map(plane => plane.length),
                plain[3].map(() => 0),
            );
            assert.deepEqual(spliced.slice(4), plain.slice(4));
        });
    });

    describe('configuration', () => {
        // audioObjectType, samplingFrequencyIndex, channelConfiguration, [extension index, core
        // type], GASpecificConfig, [syncExtensionType 0x2b7, SBR, sbrPresentFlag, extension
        // index, [0x548, psPresentFlag]]; the output rate, from SBR when it is present.
        for (const [bits, rate] of [
            ['00101 0111 0001 0100 00010 000', 44100],
            ['11101 0111 0001 0100 00010 000', 44100],
            ['00010 0110 0010 000 01010110111 00101 1 0011', 48000],
            ['00010 0111 0001 000 01010110111 00101 1 0100 10101001000 0', 44100],
            ['00010 0011 0010 000 01010110111 00101 1 0011', 48000],
            ['00101 0111 0001 0100 00010 100', 22050],
            ['00010 0111 0001 000', 22050],
        ])
            test(`decodes config ${bits} at ${rate} Hz`, () => {
                assert.equal(createAacDecoder(configBits(bits)).sampleRate, rate);
            });

        for (const [bits, pattern] of [
            ['00100 0100 0010 000', /audio object type 4 is not supported/],
            ['00011 0100 0010 000', /audio object type 3 is not supported/],
            ['10111 0100 0010 000', /audio object type 23 is not supported/],
            ['11101 0001 0110 101', /MP3onMP4 audio \(object type 34\)/],
        ])
            test(`refuses config ${bits} with DECODE naming what it holds`, () => {
                assert.throws(
                    () => createAacDecoder(configBits(bits)),
                    error => error.code === 'DECODE' && pattern.test(error.message),
                );
            });

        test('the AAC-LC decoder refuses rates and channel counts AAC does not have', () => {
            assert.throws(
                () => new AacLcDecoder(12345, 2),
                error => error.code === 'DECODE',
            );
            assert.throws(
                () => new AacLcDecoder(48000, 0),
                error => error.code === 'DECODE',
            );
            assert.throws(
                () => new AacLcDecoder(48000, 9),
                error => error.code === 'DECODE',
            );
        });
    });

    describe('plugin', () => {
        test('the decoder without SBR tools reports a stream that uses SBR', () => {
            const decoder = createAacDecoder(Uint8Array.of(0x13, 0x88));
            assert.throws(
                () =>
                    adtsPayloads(fixture('he-aac-sbr.aac')).forEach(unit =>
                        decoder.decodeFrame(unit),
                    ),
                error => error.code === 'DECODE' && /no SBR tools/.test(error.message),
            );
        });

        test(
            'without the plugin HE-AAC keeps its shape and its conversion names the aac ' +
                'plugin',
            async () => {
                const media = await lite.open(fixture('he-aac-sbr.aac'));
                try {
                    assert.deepEqual(
                        [media.tracks[0].sampleRate, media.tracks[0].channelCount],
                        [44100, 2],
                    );
                    await assert.rejects(
                        media.convert('wav', { copy: false }),
                        error => error.code === 'PLUGIN' && error.plugin === 'aac',
                    );
                } finally {
                    media.close();
                }
            },
        );

        test('explicit HE-AAC with no decoder names the aac plugin', async () => {
            // Object type 5, a 24 kHz core, stereo, 48 kHz output; Node has no host decoder.
            const track = {
                codec: 'mp4a.40.5',
                codecConfig: Uint8Array.of(0x2b, 0x11, 0x88, 0x00),
                sampleRate: 48000,
                channelCount: 2,
                width: 0,
                height: 0,
                duration: 0.1,
                samples: [
                    {
                        offset: 0,
                        size: 4,
                        data: new Uint8Array(4),
                        isKeyframe: true,
                        timestamp: 0,
                        duration: 0.1,
                    },
                ],
            };
            await assert.rejects(
                (async () => {
                    const source = createAudioTrackSource(track, async () => new Uint8Array(0));
                    for await (const _ of source.chunks());
                })(),
                error =>
                    error.code === 'PLUGIN' &&
                    error.plugin === 'aac' &&
                    /'aac' plugin/.test(error.hint),
            );
        });
    });

    describe('encoding', () => {
        for (const [rate, channels, kbps, minSnr] of [
            [48000, 2, 128, 55],
            [48000, 2, 64, 45],
            [44100, 2, 192, 60],
            [48000, 1, 96, 60],
            [24000, 1, 48, 50],
            [16000, 2, 48, 40],
            [8000, 1, 24, 35],
            [96000, 2, 256, 60],
        ])
            test(
                `${rate} Hz ${channels} ch ${kbps} kbps decodes one frame late at its level ` +
                    `above ${minSnr} dB`,
                async () => {
                    const frames = Math.max(rate, 16384);
                    const planes = Array.from({ length: channels }, (_, channel) =>
                        chirp(frames, rate, channel === 1),
                    );
                    const encoded = await encodeAacLc(planes, { sampleRate: rate, bitrate: kbps });
                    const decoded = await decodeAacFrames(encoded);
                    assert.deepEqual(
                        [decoded.sampleRate, decoded.channels, decoded.channelData.length],
                        [rate, channels, channels],
                    );
                    assert.equal(decoded.sampleFrames, decoded.channelData[0].length);
                    assert.equal(
                        decoded.channelData[0].length % 1024,
                        0,
                        'whole 1024-sample frames',
                    );
                    for (let channel = 0; channel < channels; channel++) {
                        const metrics = analyze(planes[channel], decoded.channelData[channel]);
                        assert.equal(metrics.delay, 1024);
                        assert(metrics.snr > minSnr, `${metrics.snr} dB`);
                        assert(Math.abs(metrics.level - 1) < 0.01, `level ${metrics.level}`);
                        assert(metrics.peak <= 0.31, `peak ${metrics.peak}`);
                    }
                    if (channels === 2)
                        assert(analyze(planes[0], decoded.channelData[1]).snr < 3, 'not swapped');
                },
            );

        test('writes one priming frame; ADTS wraps and slices the frames back', async () => {
            const encoded = await encodeAacLc([chirp(48000, 48000), chirp(48000, 48000, true)], {
                sampleRate: 48000,
            });
            assert.equal(encoded.samplesPerFrame, 1024);
            assert.equal(encoded.frames.length, Math.ceil((48000 + 1024) / 1024));
            assert.deepEqual(sliceAdtsFrames(wrapAdts(encoded)), encoded.frames);
        });

        test('silence stays silent', async () => {
            const silence = [new Float32Array(48000), new Float32Array(48000)];
            const decoded = await decodeAacFrames(
                await encodeAacLc(silence, { sampleRate: 48000 }),
            );
            assert(
                decoded.channelData.every(plane => plane.every(value => Math.abs(value) < 1e-6)),
            );
        });

        test('full scale keeps above 60 dB and within the sample range', async () => {
            const loud = [chirp(48000, 48000, false, 0.999), chirp(48000, 48000, true, 0.999)];
            const decoded = await decodeAacFrames(
                await encodeAacLc(loud, { sampleRate: 48000, bitrate: 256 }),
            );
            const metrics = analyze(loud[0], decoded.channelData[0]);
            assert(metrics.snr > 60);
            assert(metrics.peak <= 1);
        });

        test('frames short inputs into whole frames after the priming one', async () => {
            for (const [samples, frames] of [
                [1, 2],
                [100, 2],
                [1151, 3],
                [1152, 3],
                [1153, 3],
                [4097, 6],
            ]) {
                const planes = [new Float32Array(samples), new Float32Array(samples)];
                const encoded = await encodeAacLc(planes, { sampleRate: 48000 });
                assert.equal(encoded.frames.length, frames, `${samples} samples`);
            }
        });

        test('the bitrate is bits per second, text with a unit, or kbit/s below 1000', async () => {
            const planes = [chirp(8192, 48000)];
            const frames = async bitrate =>
                (await encodeAacLc(planes, { sampleRate: 48000, bitrate })).frames;
            const expected = await frames(96);
            for (const bitrate of [96_000, '96k', '96 kbps'])
                assert.deepEqual(await frames(bitrate), expected, String(bitrate));
            assert.deepEqual(await frames(undefined), await frames(128), 'default 128 kbit/s');
        });

        test('reports progress frame by frame up to the frames expected', async () => {
            const seen = [];
            await encodeAacLc([new Float32Array(4096)], {
                sampleRate: 48000,
                onProgress: (done, total) => seen.push([done, total]),
            });
            assert.deepEqual(seen, [
                [1, 5],
                [2, 5],
                [3, 5],
                [4, 5],
                [5, 5],
            ]);
        });

        test('refuses an empty input and a bad rate with a library error', async () => {
            await assert.rejects(
                encodeAacLc([new Float32Array(0)], { sampleRate: 48000 }),
                /empty input/,
            );
            await assert.rejects(
                encodeAacLc([new Float32Array(1024)], { sampleRate: 0 }),
                error => error instanceof MediaForgeError,
            );
        });

        test('planes that are missing or differ in length fail with INPUT', async () => {
            for (const planes of [
                [],
                new Float32Array(1024),
                [new Float32Array(1024), new Float32Array(1023)],
                [new Float64Array(1024)],
            ])
                await assert.rejects(encodeAacLc(planes, { sampleRate: 48000 }), {
                    code: 'INPUT',
                });
            await assert.rejects(encodeAacLc([new Float32Array(1024)], 48000), { code: 'INPUT' });
        });

        test('stops with its signal', async () => {
            const planes = [new Float32Array(96000), new Float32Array(96000)];
            await assert.rejects(
                encodeAacLc(planes, { sampleRate: 48000, signal: AbortSignal.abort() }),
                { code: 'ABORT' },
            );
            const encoded = await encodeAacLc(planes, { sampleRate: 48000 });
            await assert.rejects(decodeAacFrames(encoded, { signal: AbortSignal.abort() }), {
                code: 'ABORT',
            });
        });

        test('a decode reports progress and stops when aborted between frames', async () => {
            const encoded = await encodeAacLc([new Float32Array(48000)], { sampleRate: 48000 });
            const controller = new AbortController();
            const seen = [];
            const decoding = decodeAacFrames(encoded, {
                signal: controller.signal,
                onProgress: (done, total) => {
                    seen.push(total);
                    if (done === 10) controller.abort();
                },
            });
            await assert.rejects(decoding, { code: 'ABORT' });
            assert(seen.length < encoded.frames.length);
            assert(seen.every(total => total === encoded.frames.length));
        });
    });
});
