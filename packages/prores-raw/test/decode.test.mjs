import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    makeProResRawPacket,
    proResRawFrames,
} from '../../../test/helpers/prores-raw-fixtures.mjs';

import * as raw from '../index.js';

describe('packages/prores-raw', () => {
    test('ProRes RAW decodes AC coefficients and camera metadata', () => {
        assert.equal(typeof raw.decodeProResRaw, 'function');
        const frame = raw.decodeProResRaw(proResRawFrames.aprn, { codec: 'aprn' });
        assert.equal(frame.width, 32);
        assert.equal(frame.height, 24);
        assert.equal(frame.stride, 32);
        assert.equal(frame.format, 'bayer-rggb16');
        assert.equal(frame.data.length, 32 * 24);
        assert.equal(frame.bitDepth, 16);
        assert.equal(frame.color.transfer, 'linear');
        assert.equal(frame.color.whiteBalance.red, 1.5);
        assert.equal(frame.color.whiteBalance.blue, 1.25);
        assert.equal(frame.color.blackLevel, 256);
        assert.equal(frame.color.whiteLevel, 65535);
        assert.deepEqual(frame.color.cameraToXYZD65, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        assert(new Set(frame.data).size > 4, 'actual AC coefficients must affect output');
    });

    test('RAW Bayer samples match the independent 16-bit upstream C transform', () => {
        assert.equal(
            bayerDigest(raw.decodeProResRaw(proResRawFrames.aprn)),
            '69a053f851bcab0f96cc07970d7217f8c089bc414cb6eefdb295708689b08578',
        );
        assert.equal(
            bayerDigest(raw.decodeProResRaw(proResRawFrames.aprh)),
            '4b9a7c6e378cb3070773b3be7fe1133cf41f0a51830f2018a3ad46447a02d756',
        );
        assert.equal(
            bayerDigest(
                raw.decodeProResRaw(
                    makeProResRawPacket({ curve: [0, 100, 200, 300, 1000, 4000, 16000, 32000] }),
                ),
            ),
            'ba6ca75d85f02a1fa3055631f1c93843c4c86ea2cac48dd5453a63d7ceb09159',
        );
    });

    test('RAW keeps the precision of saturated coefficients and of every AC codebook', () => {
        const packet = makeProResRawPacket({
            width: 274,
            height: 18,
            alignment: 4,
            detail: 'wide',
            quantization: Uint8Array.from({ length: 64 }, (_, i) => 1 + (i % 31)),
        });
        assert.equal(
            bayerDigest(raw.decodeProResRaw(packet)),
            'f03209e8ecae5764be7b3d59c3615d00df5c8b4207e359a3bfafd975de316725',
        );
    });

    test('RAW sparse adaptive run and length codebooks match the C oracle', () => {
        const packet = makeProResRawPacket({
            width: 274,
            height: 34,
            alignment: 4,
            detail: 'sparse',
        });
        assert.equal(
            bayerDigest(raw.decodeProResRaw(packet)),
            'ff42e58af79d6e5c90dc50aca3e82b40f46de9bd284c6223ef02844491bbe2ca',
        );
    });

    test('an empty or zero-terminated RAW component represents zero residuals', () => {
        const packet = makeProResRawPacket({ width: 16, height: 16 }).slice(0, 90);
        const view = new DataView(packet.buffer);
        view.setUint32(0, packet.length);
        view.setUint16(80, 8);
        packet.fill(0, 84);
        assert(raw.decodeProResRaw(packet).data.every(value => value === 4096));
    });

    test('RAW versions, cropped tile edges and all tile widths decode deterministically', () => {
        const golden = [
            '0a3bcda2f75d9569bc8f7eef34657fbc4ceb0bbfb780d3e61ff5640b3f2c79da',
            'c8c42a5215129d0069338c6c1b4258ef42f8f9d971113b8822a1046fc2223766',
            '94f149d3fe1559966bace6a6cc45e56916f8388c1db26bbd82c74b316ed402cd',
            'a35e8b2b609cc65ae9853d07b403cdfe4bd522eaa1d363b7df8b4641fad00003',
            'b61172f8ed5f9fa2ae9f55f514be1e812987615055c86403223b84b50b0328b9',
        ];
        for (const version of [0, 1])
            for (const alignment of [0, 1, 2, 3, 4]) {
                const packet = makeProResRawPacket({ width: 274, height: 18, alignment, version });
                const frame = raw.decodeProResRaw(packet);
                assert.equal(frame.data.length, 274 * 18);
                assert.deepEqual(frame.data, raw.decodeProResRaw(packet).data);
                assert.equal(bayerDigest(frame), golden[alignment]);
            }
    });

    test(
        'RAW decoder rejects malformed bounds and unsupported formats before allocating ' +
            'output',
        () => {
            const source = proResRawFrames.aprn;
            assert.throws(() => raw.decodeProResRaw(source, { maxPixels: 32 }), /pixel/i);
            assert.throws(() => raw.decodeProResRaw(source, { maxFrameBytes: 80 }), /size|byte/i);
            assert.throws(() => raw.decodeProResRaw(source, { maxTiles: 1 }), /tile/i);
            assert.throws(() => raw.decodeProResRaw(source, { codec: 'apch' }), /codec|profile/i);
            for (const [offset, value, message] of [
                [4, 0x69, /prrf/],
                [10, 1, /version/],
                [17, 31, /dimension/],
                [24, 1, /Bayer/],
                [79, 10, /alignment/],
            ]) {
                const packet = source.slice();
                packet[offset] = value;
                assert.throws(() => raw.decodeProResRaw(packet), message);
            }
            const table = 8 + new DataView(source.buffer).getUint16(8);
            const tile = table + 4;
            for (const offset of [table, tile, tile + 2, tile + 4, tile + 6]) {
                const packet = source.slice();
                packet[offset] = 255;
                assert.throws(() => raw.decodeProResRaw(packet), /tile|component/i);
            }
            assert.throws(() => raw.decodeProResRaw(source.slice(0, -1)), /size|truncated/i);
            const entropy = source.slice();
            new DataView(entropy.buffer).setUint16(tile + 2, 1);
            entropy[tile + 8] = 0x80; // A 13-bit first DC symbol cannot fit in one byte.
            assert.throws(() => raw.decodeProResRaw(entropy), /truncated.*entropy/i);
        },
    );

    test('RAW decoded data and metadata own their bytes, preserve vendor information', () => {
        const trailer = Uint8Array.of(0, 0, 0, 8, 0x65, 0x6f, 0x6d, 0x64, 0, 0);
        const curve = [0, 100, 200, 300, 1000, 4000, 16000, 32000];
        const packet = makeProResRawPacket({ curve, trailer });
        const frame = raw.decodeProResRaw(packet);
        packet.fill(0);
        assert.deepEqual(frame.color.linearizationCurve, curve);
        assert.deepEqual(frame.vendorMetadata, trailer);
        assert.equal(frame.vendor, 'TEST');
        assert.equal(frame.color.appliedWhiteBalance, false);
        assert.equal(frame.color.appliedColorMatrix, false);
    });

    test('RAW decode cancellation is explicit, including between async tile batches', async () => {
        const controller = new AbortController();
        controller.abort();
        assert.throws(
            () => raw.decodeProResRaw(proResRawFrames.aprn, { signal: controller.signal }),
            {
                name: 'AbortError',
            },
        );
        const running = new AbortController();
        const decoding = raw.decodeProResRawAsync(
            makeProResRawPacket({ width: 512, height: 512 }),
            {
                signal: running.signal,
                tilesPerYield: 1,
            },
        );
        setTimeout(() => running.abort(), 0);
        await assert.rejects(decoding, { name: 'AbortError' });
        const frame = await raw.decodeProResRawAsync(proResRawFrames.aprh);
        assert.deepEqual(frame.data, raw.decodeProResRaw(proResRawFrames.aprh).data);
    });

    test('async RAW decode snapshots the packet before yielding', async () => {
        const packet = proResRawFrames.aprn.slice();
        const pending = raw.decodeProResRawAsync(packet, { tilesPerYield: 1 });
        packet.fill(0);
        assert.deepEqual((await pending).data, raw.decodeProResRaw(proResRawFrames.aprn).data);
    });

    test('unknown camera calibration is preserved and marked invalid', () => {
        const packet = proResRawFrames.aprn.slice();
        new DataView(packet.buffer).setFloat32(28, NaN);
        const frame = raw.decodeProResRaw(packet);
        assert.equal(frame.color.valid, false);
        assert(Number.isNaN(frame.color.whiteBalance.red));
        assert.deepEqual(frame.rawHeader, packet.slice(8, 80));
    });

    // Golden digests come from unmodified entropy/IDCT functions from FFmpeg commit
    // faa7c882cb86334aa962340451e087c30e063d31, compiled into a private C test harness.
    function bayerDigest(frame) {
        const bytes = new Uint8Array(frame.data.length * 2);
        const view = new DataView(bytes.buffer);
        frame.data.forEach((value, i) => view.setUint16(i * 2, value, true));
        return createHash('sha256').update(bytes).digest('hex');
    }
});
