import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, check, convert } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { opus } from 'mediaforgejs/plugins';
import { OPUS_FIXTURES } from '../helpers/opus-fixtures.mjs';
import {
    assertAudioDecoderContract,
    compareWithReference,
    pluginAudioDecoder,
    presentedAudio,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { waveSamples } from '../helpers/pcm.mjs';
import { webmClip } from '../helpers/webm-clip-fixture.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { OpusPacket, OpusMultistreamDecoder, opusPacketSamples } = await import(
    distUrl('esm/codecs/opus/decoder.js')
);
const { parseOpusHead } = await import(distUrl('esm/core/codec-config/audio/opus-head.js'));

const fixture = name => OPUS_FIXTURES.find(entry => entry.name === name);

/** The frames a fixture presents: an MP4 presents its edit list, which keeps the padding. */
const presentedFrames = entry =>
    entry.container === 'mp4' ? Math.round(entry.seconds * entry.sampleRate) : entry.frames;

const celt20 = 31 << 3;

describe('opus', () => {
    describe('decoding against the reference decoder', () => {
        for (const entry of OPUS_FIXTURES) {
            const exact = entry.name.startsWith('silk-');
            test(`${entry.name} ${exact ? 'matches exactly' : 'is above 70 dB'}`, async () => {
                const decoded = await presentedAudio(entry.bytes());
                assert.deepEqual(
                    [decoded.sampleRate, decoded.channels, decoded.planes[0].length],
                    [48000, entry.channels, presentedFrames(entry)],
                );
                const { snrDb, maxDifference } = compareWithReference(
                    decoded.planes,
                    entry.reference(),
                    entry.referenceStart,
                );
                if (exact) assert.equal(maxDifference, 0);
                else assert(snrDb > 70, `${snrDb} dB`);
            });
        }

        for (const name of [
            'celt-fb-audio-20ms-stereo',
            'hybrid-swb-voip-20ms-webm',
            'hybrid-swb-voip-20ms-mp4',
        ])
            test(`${name} converts to 16-bit WAV in full above 60 dB`, async () => {
                const entry = fixture(name);
                const samples = await waveSamples((await convert(entry.bytes(), 'wav')).blob);
                assert.equal(samples.length, presentedFrames(entry) * entry.channels);
                const planes = Array.from({ length: entry.channels }, (_, channel) =>
                    Float32Array.from(
                        { length: samples.length / entry.channels },
                        (_, index) => samples[index * entry.channels + channel] / 32768,
                    ),
                );
                const { snrDb } = compareWithReference(
                    planes,
                    entry.reference(),
                    entry.referenceStart,
                );
                assert(snrDb > 60, `${snrDb} dB`);
            });

        test('keeps the decoder contract through the opus plugin', async () => {
            const { track, packets } = await trackPackets(
                fixture('celt-fb-audio-20ms-stereo').bytes(),
            );
            assertAudioDecoderContract(await pluginAudioDecoder(opus, track), packets, 2);
        });
    });

    describe('packet loss', () => {
        /** Every block a plugin decoder yields for `steps`, packets or ['conceal', frames]. */
        async function decode(track, steps) {
            const decoder = await pluginAudioDecoder(opus, track);
            const units = steps.flatMap(step =>
                step instanceof Uint8Array
                    ? [...decoder.decode(step)]
                    : [...decoder.conceal(step[1])],
            );
            return units[0].map((_, channel) =>
                Float32Array.from(units.flatMap(unit => [...unit[channel]])),
            );
        }
        const rms = (plane, start, count) => {
            let energy = 0;
            for (let index = start; index < start + count; index++) energy += plane[index] ** 2;
            return Math.sqrt(energy / count);
        };

        test('conceals lost packets in place and resynchronizes after them', async () => {
            const { track, packets } = await trackPackets(
                fixture('celt-fb-audio-20ms-stereo').bytes(),
            );
            const intact = await decode(track, packets);
            const concealed = await decode(track, [
                ...packets.slice(0, 8),
                ['conceal', 1920],
                ...packets.slice(10),
            ]);
            assert.equal(concealed[0].length, intact[0].length, 'the loss keeps its place');
            const gap = 8 * 960;
            assert.deepEqual(concealed[0].subarray(0, gap), intact[0].subarray(0, gap));
            assert(rms(concealed[0], gap, 960) > rms(intact[0], gap - 960, 960) * 0.1);
            const tail = gap + 1920 * 3;
            const { snrDb } = compareWithReference(
                [concealed[0].subarray(tail), concealed[1].subarray(tail)],
                Float32Array.from(
                    { length: (intact[0].length - tail) * 2 },
                    (_, index) => intact[index & 1][tail + (index >> 1)],
                ),
                0,
            );
            assert(snrDb > 40, `${snrDb} dB after the loss`);
        });

        test('channels mapped to 255 stay silent when concealing', () => {
            const head = new Uint8Array(19 + 2 + 3);
            head.set([...'OpusHead'].map(char => char.charCodeAt(0)));
            head.set([1, 3, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 255, 2, 1, 0, 1, 255], 8);
            const layout = parseOpusHead(head, 3).layout;
            const decoder = new OpusMultistreamDecoder(layout);
            const planes = [
                new Float32Array(960),
                new Float32Array(960),
                new Float32Array(960).fill(1),
            ];
            assert.equal(decoder.conceal(planes, 960), 960);
            assert(planes[2].every(value => value === 0));
        });
    });

    describe('packets', () => {
        const packet = new OpusPacket();

        test('code 0 holds one frame', () => {
            packet.parse(Uint8Array.of(celt20, 1, 2, 3, 4, 5), 0, 6, false);
            assert.deepEqual(
                [packet.count, packet.sizes[0], packet.offsets[0], packet.frameSamples],
                [1, 5, 1, 960],
            );
        });

        test('code 1 holds two frames of equal size, so an odd payload is refused', () => {
            packet.parse(Uint8Array.of(celt20 | 1, 1, 2, 3, 4, 5, 6), 0, 7, false);
            assert.deepEqual(
                [packet.count, packet.sizes[0], packet.sizes[1], packet.offsets[1]],
                [2, 3, 3, 4],
            );
            assert.throws(() => packet.parse(Uint8Array.of(celt20 | 1, 1, 2, 3), 0, 4, false), {
                code: 'DECODE',
            });
        });

        test('code 2 states the first frame length in one or two bytes', () => {
            packet.parse(Uint8Array.of(celt20 | 2, 2, 9, 9, 7, 7, 7), 0, 7, false);
            assert.deepEqual([packet.count, packet.sizes[0], packet.sizes[1]], [2, 2, 3]);
            const long = new Uint8Array(3 + 256 + 1);
            long.set([celt20 | 2, 252, 1]);
            packet.parse(long, 0, long.length, false);
            assert.deepEqual([packet.sizes[0], packet.sizes[1]], [256, 1]);
        });

        test('code 3 excludes padding from CBR frames and reads VBR lengths', () => {
            packet.parse(Uint8Array.of(celt20 | 3, 0x40 | 2, 1, 8, 8, 9, 9, 0), 0, 8, false);
            assert.deepEqual([packet.count, packet.sizes[0], packet.sizes[1]], [2, 2, 2]);
            packet.parse(Uint8Array.of(celt20 | 3, 0x80 | 2, 1, 8, 9, 9), 0, 6, false);
            assert.deepEqual([packet.count, packet.sizes[0], packet.sizes[1]], [2, 1, 2]);
        });

        test('refuses zero frames and more than 120 ms with DECODE', () => {
            assert.throws(() => packet.parse(Uint8Array.of(celt20 | 3, 0), 0, 2, false), {
                code: 'DECODE',
            });
            const silk60 = 3 << 3;
            assert.throws(() => packet.parse(Uint8Array.of(silk60 | 3, 3, 1, 1, 1), 0, 5, false), {
                code: 'DECODE',
            });
        });

        test('counts the samples of a packet from its TOC', () => {
            assert.equal(opusPacketSamples(Uint8Array.of(celt20, 0)), 960);
            assert.equal(opusPacketSamples(Uint8Array.of((16 << 3) | 3, 6, 0, 0, 0, 0, 0, 0)), 720);
        });

        test('a self-delimited packet ends after its frames', () => {
            const selfDelimited = Uint8Array.of(celt20, 2, 1, 1, 7, 7, 7);
            packet.parse(selfDelimited, 0, selfDelimited.length, true);
            assert.deepEqual([packet.sizes[0], packet.packetLength], [2, 4]);
        });
    });

    describe('plugin', () => {
        test('capabilities list Opus decoding with the plugin and not without', async () => {
            assert((await capabilities()).audio.decode.includes('opus'));
            assert(!(await lite.capabilities()).audio.decode.includes('opus'));
        });

        test('without the plugin and a host decoder Opus names the opus plugin', async () => {
            const media = await lite.open(fixture('celt-fb-audio-20ms-stereo').bytes());
            try {
                await assert.rejects(
                    media.convert('wav', { copy: false }),
                    error => error.code === 'PLUGIN' && error.plugin === 'opus',
                );
            } finally {
                media.close();
            }
        });

        test('a WebM clip decodes in full through the plugin, without a host decoder', async () => {
            assert.equal(typeof globalThis.AudioDecoder, 'undefined');
            const core = await check(webmClip({ frames: 6 }), 'wav', { copy: false, plugins: [] });
            assert.deepEqual([core.supported, core.code], [false, 'PLUGIN']);
            const support = await check(webmClip({ frames: 6 }), 'wav', { copy: false });
            assert.equal(support.supported, true, support.reason);
            const { blob } = await convert(webmClip({ frames: 6 }), 'wav', { copy: false });
            assert.equal(
                (await waveSamples(blob)).length / 2,
                10 * 960 - 312,
                'ten 20 ms packets minus the CodecDelay',
            );
        });

        test('the default preference reaches the same samples without a host decoder', async () => {
            const bytes = fixture('celt-fb-audio-20ms-stereo').bytes();
            assert.deepEqual(
                (await presentedAudio(bytes, {})).planes,
                (await presentedAudio(bytes)).planes,
            );
        });
    });
});
