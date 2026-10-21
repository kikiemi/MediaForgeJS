import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, convert } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { ac3 } from 'mediaforgejs/plugins';
import { AC3_FIXTURES } from '../helpers/ac3-fixtures.mjs';
import {
    assertAudioDecoderContract,
    assertSameChunks,
    compareWithReference,
    pluginAudioCodec,
    pluginAudioDecoder,
    presentedAudio,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { waveChunks, waveSamples } from '../helpers/pcm.mjs';

const fixture = name => AC3_FIXTURES.find(entry => entry.name === name);

/** Every plane a decoder yields for `packets`, joined per channel. */
function decodeJoined(decoder, packets) {
    const chunks = packets.flatMap(packet => [...decoder.decode(packet)]);
    return chunks[0].map((_, channel) =>
        Float32Array.from(chunks.flatMap(chunk => [...chunk[channel]])),
    );
}

describe('ac3', () => {
    describe('decoding against the reference decoder', () => {
        // The decoders agree to the level of the dither each draws for zero-bit mantissas.
        for (const entry of AC3_FIXTURES)
            test(`${entry.name} (${entry.container}) decodes at ffmpeg's level`, async () => {
                const decoded = await presentedAudio(entry.bytes());
                assert.equal(decoded.track.codec, entry.codec ?? 'ac-3');
                assert.deepEqual(
                    [decoded.sampleRate, decoded.channels, decoded.planes[0].length],
                    [entry.sampleRate, entry.channels, entry.frames],
                );
                const { snrDb, maxDifference } = compareWithReference(
                    decoded.planes,
                    entry.reference(),
                    entry.referenceStart,
                );
                assert(snrDb > 35, `${snrDb} dB`);
                assert(maxDifference < 0.03, `largest difference ${maxDifference}`);
            });

        test('keeps the decoder contract through the ac3 plugin', async () => {
            const { track, packets } = await trackPackets(fixture('5.1-48000-160k').bytes());
            assertAudioDecoderContract(await pluginAudioDecoder(ac3, track), packets, 6);
        });

        test('decodes after reset() as a new decoder does, dither included', async () => {
            // reset() used to keep the dither generator running, so a seek decoded differently.
            const { track, packets } = await trackPackets(fixture('7.1-48000-288k').bytes());
            const used = await pluginAudioDecoder(ac3, track);
            decodeJoined(used, packets);
            used.reset();
            const fresh = await pluginAudioDecoder(ac3, track);
            assertSameChunks(
                [decodeJoined(used, packets)],
                [decodeJoined(fresh, packets)],
                'reset',
            );
        });
    });

    describe('speakers', () => {
        // 2.1 is left, right and LFE; 4.0 (3/1) has a back centre; 5.1 side surrounds; 7.1 adds
        // the back pair of its dependent substream.
        for (const [name, mask] of [
            ['2.1-32000-96k', 0xb],
            ['4.0-44100-128k', 0x107],
            ['5.1-48000-160k', 0x60f],
            ['eac3-5.1-48000-192k', 0x60f],
            ['7.1-48000-288k', 0x63f],
        ])
            test(`${name} converts to WAV with mask 0x${mask.toString(16)}`, async () => {
                const entry = fixture(name);
                const { blob } = await convert(new Blob([entry.bytes()]), 'wav');
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const view = new DataView(bytes.buffer);
                const format = waveChunks(bytes).get('fmt ').at;
                assert.equal(view.getUint16(format, true), 0xfffe, 'WAVE_FORMAT_EXTENSIBLE');
                assert.equal(view.getUint32(format + 20, true), mask);
                assert.equal((await waveSamples(bytes)).length, entry.frames * entry.channels);
            });

        test('a switch from 2/0 to 3/2 with LFE folds into the declared stereo', async () => {
            // A track that declares its first frame's two channels (as an MP4 dac3 does) keeps
            // them: centre and surrounds fold in with ffmpeg's default weights, the LFE is
            // dropped, and one AUDIO_FORMAT_CHANGED warning says so.
            const stereo = fixture('stereo-48000-96k');
            const surround = fixture('5.1-48000-160k');
            const joined = await trackPackets(
                new Uint8Array([...stereo.bytes(), ...surround.bytes()]),
            );
            assert.equal(joined.track.channelCount, 6, 'a raw stream declares its most channels');
            const declared = {
                ...joined.track,
                channelCount: 2,
                codecConfig: (await trackPackets(stereo.bytes())).track.codecConfig,
            };
            const warnings = [];
            const codec = await pluginAudioCodec(ac3, declared);
            const planes = decodeJoined(
                codec.create(code => warnings.push(code)),
                joined.packets,
            );
            assert.deepEqual(warnings, ['AUDIO_FORMAT_CHANGED']);
            // From the second 5.1 frame on (the first starts its overlap afresh):
            // FL + FC/sqrt2 + SL/sqrt2.
            const reference = surround.reference();
            const folded = new Float32Array(reference.length / 3);
            for (let index = 0; index < reference.length / 6; index++)
                for (const [channel, front, side] of [
                    [0, 0, 4],
                    [1, 1, 5],
                ])
                    folded[index * 2 + channel] =
                        reference[index * 6 + front] +
                        Math.SQRT1_2 * (reference[index * 6 + 2] + reference[index * 6 + side]);
            const { snrDb } = compareWithReference(
                planes,
                folded,
                stereo.frames + surround.referenceStart,
            );
            assert(snrDb > 30, `${snrDb} dB`);
        });
    });

    describe('damage', () => {
        test('a frame cut short or without a sync word fails as DECODE', async () => {
            const entry = fixture('stereo-48000-96k');
            const { track } = await trackPackets(entry.bytes());
            const decoder = await pluginAudioDecoder(ac3, track);
            assert.throws(() => [...decoder.decode(entry.bytes().subarray(0, 300))], {
                code: 'DECODE',
            });
            assert.throws(() => [...decoder.decode(new Uint8Array(64))], { code: 'DECODE' });
        });

        test('E-AC-3 at a reduced sample rate (fscod 3) is refused as DECODE', async () => {
            const entry = fixture('7.1-48000-288k');
            const decoder = await pluginAudioDecoder(
                ac3,
                (await trackPackets(entry.bytes())).track,
            );
            const reduced = entry.bytes();
            reduced[4] |= 0xc0;
            assert.throws(() => [...decoder.decode(reduced)], {
                code: 'DECODE',
                message: /reduced sample rate/,
            });
        });

        test('a 7.1 access unit whose dependent frame is cut fails as DECODE', async () => {
            const entry = fixture('7.1-48000-288k');
            const decoder = await pluginAudioDecoder(
                ac3,
                (await trackPackets(entry.bytes())).track,
            );
            const bytes = entry.bytes();
            const independent = (((bytes[2] & 7) << 8) | bytes[3]) * 2 + 2;
            assert.throws(() => [...decoder.decode(bytes.subarray(0, independent + 100))], {
                code: 'DECODE',
            });
        });
    });

    describe('tracks', () => {
        test('refuses another codec (INPUT) and impossible channel counts (FORMAT)', async () => {
            const { track } = await trackPackets(fixture('stereo-48000-96k').bytes());
            await assert.rejects(pluginAudioCodec(ac3, { ...track, codec: 'dts' }), {
                code: 'INPUT',
            });
            for (const [codec, channelCount] of [
                ['ac-3', 0],
                ['ac-3', 7],
                ['ec-3', 9],
            ])
                await assert.rejects(pluginAudioCodec(ac3, { ...track, codec, channelCount }), {
                    code: 'FORMAT',
                });
        });

        test('a track without dac3 takes the default layout of its channel count', async () => {
            const { track } = await trackPackets(fixture('5.1-48000-160k').bytes());
            const codec = await pluginAudioCodec(ac3, { ...track, codecConfig: undefined });
            assert.equal(codec.channelMask, 0x3f, "WAVE's default 5.1");
            const stated = await pluginAudioCodec(ac3, track);
            assert.equal(stated.channelMask, 0x60f, 'the dac3 names side surrounds');
        });
    });

    describe('plugin', () => {
        test('capabilities list AC-3 and E-AC-3 with the plugin and not without', async () => {
            const core = (await lite.capabilities()).audio.decode;
            assert(!core.includes('ac-3') && !core.includes('ec-3'));
            const all = (await capabilities()).audio.decode;
            assert(all.includes('ac-3') && all.includes('ec-3'));
        });

        test('without the plugin and a host decoder AC-3 names the ac3 plugin', async () => {
            await assert.rejects(
                new lite.MediaForge().convert(
                    new Blob([fixture('stereo-48000-96k').bytes()]),
                    'wav',
                ),
                error => error.code === 'PLUGIN' && error.plugin === 'ac3',
            );
        });
    });
});
