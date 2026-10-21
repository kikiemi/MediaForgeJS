import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { capabilities, convert } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { alac } from 'mediaforgejs/plugins';
import {
    assertAudioDecoderContract,
    pluginAudioDecoder,
    presentedAudio,
    trackPackets,
} from '../helpers/codec-contract.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { AlacDecoder, parseAlacConfig } = await import(distUrl('esm/codecs/alac/decoder.js'));

// Fixtures and their digests come from FFmpeg 6.1.1; each digest is the SHA-256 of
// `ffmpeg -i <fixture> -f s16le -c:a pcm_s16le -` (s24le/pcm_s24le for the 24-bit fixture).
//   alac16.m4a: 440 and 660 Hz sines at 44.1 kHz, -sample_fmt s16p -frames:a 2
//   alac24.caf: a 440 Hz sine and pink noise at 48 kHz, -sample_fmt s32p
//   alac51.mkv: white noise, 300/500/700/60 Hz sines and pink noise joined as 5.1 at 44.1 kHz
//   alacnoise.m4a: full-scale white noise at 44.1 kHz (escape frames)
const fixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/alac/${name}`, import.meta.url)));
const FIXTURES = [
    ['alac16.m4a', 16, 2, 5292, '2bd8cc93b72fa1d99d7274d305d318d17e196087fa7d13121d95c6ce10e20443'],
    ['alac24.caf', 24, 2, 1920, '1e688b324240ecc310d78d04abe087185068b1a303d9d9eb97d347b3553ea9f9'],
    ['alac51.mkv', 16, 6, 1764, 'a17a0ab60be9b4e90ee8d95a258c1e359696292d24fe7679fe025e3395c78577'],
    [
        'alacnoise.m4a',
        16,
        1,
        2205,
        '37c21691a6d4f0cdabb9885028a680c995dc27f2b3f10cc100aea85c11f7d9e5',
    ],
];
const NOISE_DIGEST = FIXTURES[3][4];

/** The presented sound of `bytes` packed like FFmpeg's little-endian s16le or s24le output. */
async function decodedDigest(bytes, depth) {
    const { planes, track } = await presentedAudio(bytes);
    const width = depth / 8;
    const frames = planes[0].length;
    const out = Buffer.alloc(frames * planes.length * width);
    for (let frame = 0; frame < frames; frame++)
        for (let channel = 0; channel < planes.length; channel++)
            out.writeIntLE(
                Math.round(planes[channel][frame] * 2 ** (depth - 1)),
                (frame * planes.length + channel) * width,
                width,
            );
    return {
        codec: track.codec,
        channels: planes.length,
        frames,
        digest: createHash('sha256').update(out).digest('hex'),
    };
}

/** Big-endian bit writer for hand-built ALAC packets: [value, width] fields. */
function bits(fields) {
    const out = [];
    let accumulator = 0n;
    let count = 0;
    for (const [value, width] of fields) {
        accumulator = (accumulator << BigInt(width)) | BigInt.asUintN(width, BigInt(value));
        count += width;
        while (count >= 8) {
            out.push(Number((accumulator >> BigInt(count - 8)) & 0xffn));
            count -= 8;
        }
    }
    if (count) out.push(Number((accumulator << BigInt(8 - count)) & 0xffn));
    return new Uint8Array(out);
}

/** An ALACSpecificConfig ("magic cookie") with the default tuning at 44.1 kHz. */
function cookie(frameLength, bitDepth, channels) {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, frameLength);
    bytes.set([0, bitDepth, 40, 10, 14, channels], 4);
    view.setUint16(10, 255);
    view.setUint32(20, 44100);
    return bytes;
}

/** A channel pair element header: no shift, verbatim (escape) samples. */
const escapeHeader = partial => [
    [1, 3],
    [0, 4],
    [0, 12],
    [partial ? 1 : 0, 1],
    [0, 2],
    [1, 1],
];

describe('alac', () => {
    describe('decoding against FFmpeg', () => {
        for (const [name, depth, channels, frames, digest] of FIXTURES)
            test(`${name} (${depth}-bit, ${channels} channels) matches bit for bit`, async () => {
                assert.deepEqual(await decodedDigest(fixture(name), depth), {
                    codec: 'alac',
                    channels,
                    frames,
                    digest,
                });
            });

        test('the fixtures exercise escape elements and a final partial frame', async () => {
            const noise = await trackPackets(fixture('alacnoise.m4a'));
            assert(
                noise.packets.some(packet => (packet[2] >> 1) & 1),
                'escape (verbatim)',
            );
            const stereo = await trackPackets(fixture('alac16.m4a'));
            assert.equal((stereo.packets.at(-1)[2] >> 4) & 1, 1, 'a partial frame');
        });

        for (const format of ['wav', 'aiff', 'flac'])
            test(`full-scale 16-bit samples survive conversion to ${format}`, async () => {
                const { blob } = await convert(new Blob([fixture('alacnoise.m4a')]), format, {
                    copy: false,
                });
                const bytes = new Uint8Array(await blob.arrayBuffer());
                assert.equal((await decodedDigest(bytes, 16)).digest, NOISE_DIGEST);
            });

        test('keeps the decoder contract through the alac plugin', async () => {
            const { track, packets } = await trackPackets(fixture('alac51.mkv'));
            assertAudioDecoderContract(await pluginAudioDecoder(alac, track), packets, 6);
        });
    });

    describe('decoder', () => {
        for (const depth of [20, 32])
            test(`decodes ${depth}-bit escape pairs and a partial frame of three`, () => {
                // FFmpeg encodes neither depth, so the packets are built here.
                const low = -(2 ** (depth - 1));
                const high = 2 ** (depth - 1) - 1;
                const left = [low, high, 0, 1, -1, 12345, -54321, high - 7];
                const right = [high, low, -2, 3, 0, -99, 77, low + 5];
                const pairs = count =>
                    left.slice(0, count).flatMap((value, index) => [
                        [value, depth],
                        [right[index], depth],
                    ]);
                const decoder = new AlacDecoder(cookie(8, depth, 2));
                assert.equal(decoder.config.bitDepth, depth);
                const scale = value => Math.fround(value / 2 ** (depth - 1));
                const [l, r] = decoder.decode(bits([...escapeHeader(false), ...pairs(8), [7, 3]]));
                assert.deepEqual([...l], left.map(scale));
                assert.deepEqual([...r], right.map(scale));
                const [pl, pr] = decoder.decode(
                    bits([...escapeHeader(true), [3, 32], ...pairs(3), [7, 3]]),
                );
                assert.equal(pl.length, 3);
                assert.deepEqual([...pr], right.slice(0, 3).map(scale));
            });

        test('stereo decorrelation wraps to the bit depth as FFmpeg does', () => {
            // left = u + v - (mixRes * v >> mixBits) leaves the 16-bit range for u = v = 32767:
            // eight frames, each residual escaped as nine ones and 17 bits.
            const packet = bits([
                [1, 3],
                [0, 4],
                [0, 12],
                [0, 4],
                [1, 8],
                [1, 8],
                [0, 8],
                [0x80, 8],
                [0, 8],
                [0x80, 8],
                ...Array.from({ length: 16 }, () => [(0x1ff << 17) | 65534, 26]),
                [7, 3],
            ]);
            const [left, right] = new AlacDecoder(cookie(8, 16, 2)).decode(packet);
            assert.deepEqual([...left], new Array(8).fill(-16385 / 32768));
            assert.deepEqual([...right], new Array(8).fill(16384 / 32768));
        });

        test('an element the decoder does not know fails as DECODE', () => {
            const decoder = new AlacDecoder(cookie(8, 16, 1));
            assert.throws(
                () =>
                    decoder.decode(
                        bits([
                            [0, 3],
                            [0, 4],
                            [1, 12],
                        ]),
                    ),
                { code: 'DECODE' },
            );
        });
    });

    describe('configuration', () => {
        test('reads a cookie wrapped in CAF frma and alac atoms', () => {
            const wrapped = new Uint8Array(12 + 36);
            wrapped.set([
                0,
                0,
                0,
                12,
                ...Buffer.from('frmaalac'),
                0,
                0,
                0,
                36,
                ...Buffer.from('alac'),
            ]);
            wrapped.set(cookie(4096, 24, 2), 24);
            assert.equal(parseAlacConfig(wrapped).bitDepth, 24);
        });

        test('refuses a cookie shorter than 24 bytes with DECODE', () => {
            assert.throws(() => parseAlacConfig(new Uint8Array(23)), { code: 'DECODE' });
        });
    });

    describe('plugin', () => {
        test('capabilities list ALAC decoding with the plugin and not without', async () => {
            assert((await capabilities()).audio.decode.includes('alac'));
            assert(!(await lite.capabilities()).audio.decode.includes('alac'));
        });

        test('without the plugin and a host decoder ALAC names the alac plugin', async () => {
            await assert.rejects(
                new lite.MediaForge().convert(new Blob([fixture('alac16.m4a')]), 'wav'),
                error => error.code === 'PLUGIN' && error.plugin === 'alac',
            );
        });
    });
});
