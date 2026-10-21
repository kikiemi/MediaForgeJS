import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect } from 'mediaforgejs';
import { detectFormat } from 'mediaforgejs/formats';
import { iamfSequence } from '../helpers/new-format-fixtures.mjs';
import { bytesOf } from '../helpers/read-media.mjs';

/** An ISO box of `type` around `parts`. */
const isoBox = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};

// A raw IA sequence: a sequence header, an LPCM codec config, a stereo audio element and a mix
// presentation, then temporal units of one audio frame each.
const EXPECTED = {
    codec: 'iamf.000.000.ipcm',
    sampleRate: 48000,
    channelCount: 2,
    duration: 24 / 48000,
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

/** The 'iacb' box an MP4 holds the sequence's descriptors in. */
const iacbOf = descriptors => isoBox('iacb', Buffer.of(1, descriptors.length), descriptors);

describe('iamf', () => {
    test('detects a raw IA sequence', () => {
        assert.equal(detectFormat(iamfSequence().raw), 'iamf');
    });

    test('reads a raw IA sequence as one track configured by its descriptors', async () => {
        assert.deepEqual(await described(iamfSequence().raw), { format: 'iamf', ...EXPECTED });
    });

    test("copies into MP4 as an 'iamf' sample entry, the descriptors in 'iacb'", async () => {
        const { descriptors, raw } = iamfSequence();
        const mp4 = await output(raw, 'mp4');
        assert.deepEqual(await described(mp4), { format: 'mp4', ...EXPECTED });
        assert.ok(Buffer.from(mp4).indexOf(iacbOf(descriptors)) > 0);
    });

    test('an MP4 copy writes back to the same raw IA sequence', async () => {
        const { raw } = iamfSequence();
        assert.deepEqual(await output(await output(raw, 'mp4'), 'iamf'), raw);
    });

    test("copies into fragmented MP4 with the descriptors in 'iacb'", async () => {
        const { descriptors, raw } = iamfSequence();
        assert.ok(Buffer.from(await output(raw, 'fmp4')).indexOf(iacbOf(descriptors)) > 0);
    });

    test('nothing decodes IAMF: extracting audio fails with DECODE naming it', async () => {
        await assert.rejects(
            convert(iamfSequence().raw, { to: 'wav' }),
            error => error.code === 'DECODE' && /IAMF/.test(error.message),
        );
    });
});
