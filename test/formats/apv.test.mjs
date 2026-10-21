import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, convert, inspect, open } from 'mediaforgejs';
import { detectFormat } from 'mediaforgejs/formats';
import { apv } from 'mediaforgejs/plugins';
import { apvFrames, apvStream } from '../helpers/new-format-fixtures.mjs';
import { bytesOf } from '../helpers/read-media.mjs';

/** An ISO full box (version 0) of `type` around `body`. */
const isoFullBox = (type, body) => {
    const head = Buffer.alloc(12);
    head.writeUInt32BE(12 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};

// A raw stream of access units after their sizes: one intra-only track at 30 frames a second.
const EXPECTED = {
    codec: 'apv1.apvf33.apvl30.apvb2',
    width: 32,
    height: 16,
    duration: 0.1,
    sampleCount: 3,
};

async function described(bytes) {
    const info = await inspect(bytes, { sampleCounts: true });
    const [track] = info.tracks;
    return {
        format: info.format,
        ...Object.fromEntries(Object.keys(EXPECTED).map(key => [key, track[key]])),
    };
}

const output = async (bytes, to) => bytesOf(await convert(bytes, { to }));

/** The 'apvC' record that repeats the frame header of apvStream(). */
const APVC = isoFullBox(
    'apvC',
    Buffer.of(1, 1, 1, 1, 1, 33, 30, 2, 0, 0, 0, 32, 0, 0, 0, 16, 0x22, 0),
);

describe('apv', () => {
    test('detects a raw APV stream', () => {
        assert.equal(detectFormat(apvStream().raw), 'apv');
    });

    test('reads a raw stream as one intra-only track timed at 30 frames a second', async () => {
        assert.deepEqual(await described(apvStream().raw), { format: 'apv', ...EXPECTED });
    });

    test("copies into MP4 as an 'apv1' entry whose 'apvC' repeats the frame header", async () => {
        const mp4 = await output(apvStream().raw, 'mp4');
        assert.deepEqual(await described(mp4), { format: 'mp4', ...EXPECTED });
        assert.ok(Buffer.from(mp4).indexOf(APVC) > 0);
    });

    test('an MP4 copy writes back to the same raw stream', async () => {
        const { raw } = apvStream();
        assert.deepEqual(await output(await output(raw, 'mp4'), 'apv'), raw);
    });

    test('copies into QuickTime and into fragmented MP4', async () => {
        const { raw } = apvStream();
        assert.deepEqual(await described(await output(raw, 'mov')), { format: 'mov', ...EXPECTED });
        assert.ok(Buffer.from(await output(raw, 'fmp4')).indexOf(APVC) > 0);
    });

    test('WebM cannot hold APV: the copy fails with FORMAT naming apv1', async () => {
        await assert.rejects(
            convert(apvStream().raw, { to: 'webm' }),
            error => error.code === 'FORMAT' && /it cannot hold apv1/.test(error.message),
        );
    });

    test('the plugin decoder turns a DC level of 8k into a flat block of 512 + k', async () => {
        // At 10 bits 512, 520, 528, 536 and 536, 513, 512, 612, handed on rounded to 8 bits; chroma
        // stays neutral.
        const raw = apvFrames([
            [0, 64, 128, 192],
            [192, 8, 0, 800],
        ]);
        const part = apv.decoders.find(decoder => decoder.id === 'apv');
        const decoder = (await part.load())({ codec: EXPECTED.codec });
        const media = await open(raw);
        const corners = [];
        try {
            for await (const packet of media.packets()) {
                const [frame] = decoder.decode(packet);
                assert.equal(frame.format, 'I422');
                const [luma, cb] = frame.layout;
                const at = (x, y) => frame.data[luma.offset + y * luma.stride + x];
                corners.push([at(0, 0), at(15, 0), at(0, 15), at(15, 15), frame.data[cb.offset]]);
            }
        } finally {
            media.close();
        }
        assert.deepEqual(corners, [
            [128, 130, 132, 134, 128],
            [134, 128, 128, 153, 128],
        ]);
    });

    test('frames() reports once that 10-bit pictures are decoded to 8 bits', async () => {
        const raw = apvFrames([
            [0, 64, 128, 192],
            [192, 8, 0, 800],
        ]);
        const warnings = [];
        const forge = new MediaForge({ onWarning: warning => warnings.push(warning.code) });
        const frames = [];
        for await (const frame of forge.frames(new Blob([raw]))) frames.push(frame);
        assert.deepEqual(
            frames.map(frame => [frame.width, frame.height, frame.data[0] === frame.data[1]]),
            [
                [16, 16, true],
                [16, 16, true],
            ],
        );
        assert.deepEqual(warnings, ['VIDEO_PRECISION_REDUCED']);
    });

    test('the plugin decoder keeps the contract of a video decoder', async () => {
        const part = apv.decoders.find(decoder => decoder.id === 'apv');
        assert.equal(part.codecs(EXPECTED.codec), true);
        assert.equal(part.codecs(''), false);
        assert.equal(part.codecs('vp09.00.10.08'), false);
        const decoder = await (
            await part.load()
        )({
            codec: EXPECTED.codec,
            codedWidth: 64,
            codedHeight: 48,
            onWarning() {},
        });
        assert.deepEqual([...decoder.flush()], [], 'nothing to flush before any input');
        // Damaged or empty packets give the pictures they finish, or fail with DECODE.
        for (const data of [
            new Uint8Array(64).fill(0xff),
            Uint8Array.of(0, 0, 1, 0xb3, 1, 2),
            new Uint8Array(0),
        ]) {
            try {
                const frames = decoder.decode({ type: 'key', timestamp: 0, duration: 0.04, data });
                assert.ok(Array.isArray(frames));
            } catch (error) {
                assert.equal(error.code, 'DECODE');
            }
        }
        decoder.reset();
        assert.deepEqual([...decoder.flush()], [], 'reset() drops held pictures');
        decoder.close();
        decoder.close();
    });
});
