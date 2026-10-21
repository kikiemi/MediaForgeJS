import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, convert } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { vorbis } from 'mediaforgejs/plugins';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';
import {
    assertAudioDecoderContract,
    compareWithReference,
    pluginAudioCodec,
    pluginAudioDecoder,
    presentedAudio,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { withUnusedCodebook } from '../helpers/vorbis-setup.mjs';
import { waveSamples } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { VorbisDecoder, splitVorbisHeaders } = await import(distUrl('esm/codecs/vorbis/decoder.js'));
const { vorbisCodecConfig } = await import(
    distUrl('esm/core/codec-config/audio/vorbis-headers.js')
);

const fixture = name => VORBIS_FIXTURES.find(entry => entry.name === name);

/** Every frame a decoder outputs for `packets`, two planes interleaved per packet. */
function decodeAll(decoder, packets) {
    const out = [new Float32Array(1024), new Float32Array(1024)];
    const decoded = [];
    for (const packet of packets) {
        const frames = decoder.decode(packet, out);
        decoded.push(out[0].slice(0, frames), out[1].slice(0, frames));
    }
    return decoded;
}

const stereo = await trackPackets(fixture('stereo-48000-q2').bytes());

describe('vorbis', () => {
    describe('decoding against the reference decoder', () => {
        for (const entry of VORBIS_FIXTURES)
            test(`${entry.name} presents the reference length above 100 dB`, async () => {
                const decoded = await presentedAudio(entry.bytes());
                assert.deepEqual(
                    [decoded.sampleRate, decoded.channels],
                    [entry.sampleRate, entry.channels],
                );
                const drift = decoded.planes[0].length - entry.frames;
                if (entry.container === 'mkv')
                    // Matroska blocks are timed in milliseconds; the trim follows them.
                    assert(drift >= 0 && drift < entry.sampleRate * 0.005, `${drift} frames`);
                else assert.equal(drift, 0);
                const { snrDb } = compareWithReference(
                    decoded.planes,
                    entry.reference(),
                    entry.referenceStart,
                );
                assert(snrDb > 100, `${snrDb} dB`);
            });

        for (const name of ['mono-44100-q0', 'stereo-48000-q2-mkv'])
            test(`${name} converts to 16-bit WAV in full above 60 dB`, async () => {
                const entry = fixture(name);
                const samples = await waveSamples((await convert(entry.bytes(), 'wav')).blob);
                assert(samples.length >= entry.frames * entry.channels);
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

        test('keeps the decoder contract through the vorbis plugin', async () => {
            const decoder = await pluginAudioDecoder(vorbis, stereo.track);
            assertAudioDecoderContract(decoder, stereo.packets, 2);
        });

        test("the first packet's coded duration is the lead the codec never outputs", async () => {
            const codec = await pluginAudioCodec(vorbis, {
                ...stereo.track,
                samples: stereo.samples,
            });
            assert.equal(codec.unoutputLead, 128);
            assert.equal(codec.channelMask, 0x3);
        });

        test('refuses a track whose headers disagree with it with FORMAT', async () => {
            for (const track of [
                { ...stereo.track, codecConfig: undefined },
                { ...stereo.track, channelCount: 1 },
                { ...stereo.track, sampleRate: 44100 },
            ])
                await assert.rejects(pluginAudioCodec(vorbis, track), { code: 'FORMAT' });
        });
    });

    describe('decoder', () => {
        test('reads its shape and block sizes from the three headers', () => {
            assert.equal(splitVorbisHeaders(stereo.track.codecConfig).length, 3);
            const decoder = new VorbisDecoder(stereo.track.codecConfig);
            assert.deepEqual(
                [decoder.channels, decoder.sampleRate, decoder.blockSizes],
                [2, 48000, [256, 2048]],
            );
        });

        test('the first packet only primes the overlap-add', () => {
            const decoder = new VorbisDecoder(stereo.track.codecConfig);
            const [first, second] = stereo.packets;
            assert.equal(decoder.packetFrames(first), 0);
            const out = [new Float32Array(1024), new Float32Array(1024)];
            assert.equal(decoder.decode(first, out), 0);
            assert.equal(decoder.packetFrames(second), (256 + decoder.packetBlockSize(second)) / 4);
        });

        test('reset() restarts the stream exactly, as a chained stream needs', () => {
            const decoder = new VorbisDecoder(stereo.track.codecConfig);
            const first = decodeAll(decoder, stereo.packets);
            decoder.reset();
            assert.deepEqual(decodeAll(decoder, stereo.packets), first);
        });

        test('a decoder rebuilt from the same headers decodes identically', () => {
            const first = decodeAll(new VorbisDecoder(stereo.track.codecConfig), stereo.packets);
            const again = decodeAll(new VorbisDecoder(stereo.track.codecConfig), stereo.packets);
            assert.deepEqual(again, first);
        });

        test('an unused empty codebook in the setup changes nothing', () => {
            const headers = splitVorbisHeaders(stereo.track.codecConfig);
            const extended = vorbisCodecConfig([
                headers[0],
                headers[1],
                withUnusedCodebook(headers[2]),
            ]);
            assert.deepEqual(
                decodeAll(new VorbisDecoder(extended), stereo.packets),
                decodeAll(new VorbisDecoder(stereo.track.codecConfig), stereo.packets),
            );
        });

        test('refuses header packets as audio, cut headers and bad lacing with DECODE', () => {
            const headers = splitVorbisHeaders(stereo.track.codecConfig);
            const decoder = new VorbisDecoder(stereo.track.codecConfig);
            const out = [new Float32Array(1024), new Float32Array(1024)];
            assert.throws(() => decoder.decode(headers[0], out), { code: 'DECODE' });
            assert.throws(() => new VorbisDecoder(stereo.track.codecConfig.subarray(0, 200)), {
                code: 'DECODE',
            });
            assert.throws(() => new VorbisDecoder(Uint8Array.of(2, 30, 40)), { code: 'DECODE' });
        });
    });

    describe('plugin', () => {
        test('capabilities list Vorbis decoding with the plugin and not without', async () => {
            assert((await capabilities()).audio.decode.includes('vorbis'));
            assert(!(await lite.capabilities()).audio.decode.includes('vorbis'));
        });

        test('without the plugin and a host decoder Vorbis names the vorbis plugin', async () => {
            const media = await lite.open(fixture('stereo-48000-q2').bytes());
            try {
                await assert.rejects(
                    media.convert('wav', { copy: false }),
                    error => error.code === 'PLUGIN' && error.plugin === 'vorbis',
                );
            } finally {
                media.close();
            }
        });

        test('the default preference reaches the same samples without a host decoder', async () => {
            const bytes = fixture('stereo-48000-q2').bytes();
            assert.deepEqual(
                (await presentedAudio(bytes, {})).planes,
                (await presentedAudio(bytes)).planes,
            );
        });
    });
});
