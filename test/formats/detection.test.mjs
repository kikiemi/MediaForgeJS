import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectFormat, detectSourceFormat } from 'mediaforgejs/formats';
import { BufferSource } from 'mediaforgejs/io';
import { mpegAudioFixture } from '../helpers/original-fixtures.mjs';

// Telling an input's format from its bytes: ISO BMFF brands, RIFF forms, MP4 boxes before the
// movie, ID3v2 tags before the audio and the run-in before an MXF header partition.

/** An ISO BMFF box of `type` holding `parts`. */
function box(type, ...parts) {
    const body = Buffer.concat(parts.map(part => Buffer.from(part)));
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(out.length);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    return out;
}

const MOOV = box('moov', box('mvhd', Buffer.alloc(100)));
const ftyp = (major, ...compatible) =>
    box(
        'ftyp',
        Buffer.from(major, 'latin1'),
        Buffer.alloc(4),
        ...compatible.map(brand => Buffer.from(brand, 'latin1')),
    );

/** A RIFF file of `form` with an empty body. */
function riff(form) {
    const bytes = Buffer.alloc(64);
    bytes.write('RIFF');
    bytes.writeUInt32LE(56, 4);
    bytes.write(form, 8, 'latin1');
    return bytes;
}

/** An ID3v2.4 tag of `size` bytes of padding. */
function id3(size) {
    const header = Buffer.alloc(10);
    header.write('ID3');
    header[3] = 4;
    for (const [index, shift] of [21, 14, 7, 0].entries())
        header[6 + index] = (size >> shift) & 127;
    return Buffer.concat([header, Buffer.alloc(size)]);
}

/** The formats detectFormat() and detectSourceFormat() tell for `bytes`. */
async function detected(bytes) {
    const input = new Uint8Array(bytes);
    return [detectFormat(input), await detectSourceFormat(new BufferSource(input))];
}

describe('formats/detection', () => {
    for (const [brands, format] of [
        [['qt  '], 'mov'],
        [['3gp4'], '3gp'],
        [['M4A '], 'm4a'],
        [['isom', 'iso2'], 'mp4'],
        [['heic'], 'heif'],
        [['mp42', 'heic'], 'heif'],
        [['mif1', 'avif'], 'avif'],
        [['jxl '], 'jxl'],
    ])
        test(`the ftyp brands ${brands.join(', ')} tell ${format}`, async () => {
            assert.deepEqual(await detected(Buffer.concat([ftyp(...brands), MOOV])), [
                format,
                format,
            ]);
        });

    for (const [form, format] of [
        ['WAVE', 'wav'],
        ['WEBP', 'webp'],
        ['AVI ', 'avi'],
        ['AVI\x19', 'avi'],
    ])
        test(`the RIFF form '${form}' tells ${format}`, async () => {
            assert.deepEqual(await detected(riff(form)), [format, format]);
        });

    test('MP4 boxes before the movie, and no ftyp, tell mp4', async () => {
        for (const head of [
            [box('free', Buffer.alloc(16))],
            [box('wide'), box('mdat', Buffer.alloc(32))],
        ])
            assert.deepEqual(await detected(Buffer.concat([...head, MOOV])), ['mp4', 'mp4']);
    });

    test('an ID3v2 tag before MP3 frames is passed over, whatever its length', async () => {
        for (const size of [300, 20000])
            assert.deepEqual(await detected(Buffer.concat([id3(size), mpegAudioFixture(3)])), [
                'mp3',
                'mp3',
            ]);
        const damaged = id3(10);
        damaged[6] = 0x80;
        await assert.rejects(detectSourceFormat(new BufferSource(new Uint8Array(damaged))), {
            code: 'DEMUX',
            message: /syncsafe/,
        });
    });

    test('an MXF header partition is found after a run-in of up to 64 KiB', async () => {
        const key = [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02, 0x01, 0x01];
        const mxf = runIn =>
            Buffer.concat([
                Buffer.alloc(runIn, 0x20),
                Buffer.from([...key, 2, 4, 0]),
                Buffer.alloc(200),
            ]);
        for (const runIn of [0, 1000]) assert.deepEqual(await detected(mxf(runIn)), ['mxf', 'mxf']);
        await assert.rejects(detected(mxf(70000)), { code: 'DEMUX', message: /Unable to detect/ });
    });

    test('bytes of no format fail with DEMUX', async () => {
        assert.throws(() => detectFormat(new Uint8Array(100).fill(7)), { code: 'DEMUX' });
        assert.throws(() => detectFormat(new Uint8Array(riff('XXXX'))), { code: 'DEMUX' });
    });
});
