import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, open } from 'mediaforgejs';
import { detectFormat } from 'mediaforgejs/formats';
import { join } from '../helpers/avi-h264-fixtures.mjs';
import { FIXTURES, assertReadsAsRecorded } from '../helpers/recorded-fixtures.mjs';
import { readMedia } from '../helpers/read-media.mjs';

/** `value` as an unsigned LEB128 number. */
function leb128(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 0x80;
        bytes.push(byte);
    } while (value > 0);
    return Uint8Array.from(bytes);
}

/** The OBUs of a low-overhead temporal unit: where each header, payload and end lie. */
function obus(data) {
    const units = [];
    for (let at = 0; at < data.length;) {
        const headerLength = 1 + ((data[at] >> 2) & 1);
        let size = 0;
        let shift = 0;
        let payloadStart = at + headerLength;
        for (;;) {
            const byte = data[payloadStart++];
            size += (byte & 0x7f) * 2 ** shift;
            shift += 7;
            if (!(byte & 0x80)) break;
        }
        units.push({ start: at, headerLength, payloadStart, end: payloadStart + size });
        at = payloadStart + size;
    }
    return units;
}

/**
 * A temporal unit as AV1 Annex B: OBUs without size fields, each unit and frame
 * length-delimited.
 */
function annexBUnit(data) {
    const units = obus(data).map(obu => {
        const header = data.slice(obu.start, obu.start + obu.headerLength);
        header[0] &= ~0x02;
        const bytes = join(header, data.subarray(obu.payloadStart, obu.end));
        return join(leb128(bytes.length), bytes);
    });
    const frame = join(...units);
    const unit = join(leb128(frame.length), frame);
    return join(leb128(unit.length), unit);
}

/** An IVF file of AV1 temporal units `units`. */
function ivf(units) {
    const header = Buffer.alloc(32);
    header.write('DKIF', 0);
    header.writeUInt16LE(32, 6);
    header.write('AV01', 8);
    header.writeUInt16LE(240, 12);
    header.writeUInt16LE(100, 14);
    header.writeUInt32LE(24, 16);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(units.length, 24);
    const parts = [header];
    units.forEach((unit, index) => {
        const frame = Buffer.alloc(12);
        frame.writeUInt32LE(unit.length, 0);
        frame.writeUInt32LE(index, 4);
        parts.push(frame, Buffer.from(unit));
    });
    return new Uint8Array(Buffer.concat(parts));
}

describe('ivf', () => {
    for (const file of ['av1.ivf', 'av1.obu'])
        test(`reads ${file} as recorded: packet times, keyframes and payloads`, () =>
            assertReadsAsRecorded(file));

    for (const [file, code] of [
        ['av1.ivf', 'IVF_TRUNCATED'],
        ['av1.obu', 'AV1_TRUNCATED'],
    ])
        test(`keeps the whole frames of ${file} cut at nine tenths, as incomplete`, async () => {
            const bytes = FIXTURES[file].bytes();
            const part = bytes.subarray(0, Math.floor(bytes.length * 0.9));
            const { tracks, warnings } = await readMedia(part);
            assert.ok(warnings.includes(code), `${warnings}`);
            assert.ok(tracks.every(entry => entry.track.incomplete));
            assert.equal(tracks[0].packets.length, 3);
            await assert.rejects(
                open(part, { validation: 'strict' }),
                error => error.code === 'DEMUX',
            );
        });

    test('detects and reads AV1 Annex B as it reads the low-overhead stream', async () => {
        const source = await readMedia(FIXTURES['av1.obu'].bytes());
        const [{ track, packets }] = source.tracks;
        const annexB = join(...packets.map(packet => annexBUnit(packet.data)));
        assert.equal(detectFormat(annexB.subarray(0, 64)), 'obu');
        const read = await readMedia(annexB);
        assert.equal(read.format, 'obu');
        assert.equal(read.tracks[0].track.codec, track.codec);
        assert.deepEqual(
            read.tracks[0].packets.map(packet => [packet.isKeyframe, packet.data]),
            packets.map(packet => [packet.isKeyframe, packet.data]),
        );
    });

    test('a frame shown from a slot an inter frame refreshed is no keyframe', async () => {
        // The frame headers of FFmpeg's fate/av1/decode_model.ivf (shortened payloads). The second
        // unit's first frame is padded past 4 KiB, so the later frames that refresh the reference
        // slots lie beyond it; the third unit shows one of those slots.
        const hex = text => Uint8Array.from(Buffer.from(text, 'hex'));
        const obu = (type, payload) => [(type << 3) | 2, ...leb128(payload.length), ...payload];
        const delimiter = [0x12, 0x00];
        const sequence = hex('040000000400000061780000000a530000035f915f90bbb77e33efe601');
        const frames = [
            '100000800c0c000006000800000800de70ad37ed8d8b5e8cf3636482234a1b97a3bae6ec8f9e1d18',
            '2010f005000a72e7e0680100000300081040042101000200dd2ea92418866740ffa049cc9ec0f745',
            '2808f00a000a72e7e0c800820003000810010440020309c000ff50e228b9d3fff5931a9634bd7c46',
            '2804900c800a7e67e0c8000022000040080001827000e08746b927bc27fd9ee7b3f8c90128b7997a',
            '28029010400a77e7e0d000080002104000001c00db353488b142d9c22abd10ee6e00b22af50a6f9b',
            '300400880a08053973f08400040001002000a0009a6e58b62e0c3688908e0c7702b916748fbf959b',
        ].map(hex);
        const padded = new Uint8Array(4855);
        padded.set(frames[1]);
        const { tracks } = await readMedia(
            ivf([
                [...delimiter, ...obu(1, sequence), ...obu(6, frames[0])],
                [...delimiter, ...obu(6, padded), ...frames.slice(2).flatMap(f => obu(6, f))],
                [...delimiter, 0x1a, 0x02, 0xc0, 0x06],
            ]),
        );
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.isKeyframe),
            [true, false, false],
        );
    });

    test('capabilities read ivf and obu, write ivf, and copy AV1 into ivf', async () => {
        const reported = await capabilities();
        for (const format of ['ivf', 'obu'])
            assert.ok(reported.containers.read.includes(format), format);
        assert.ok(reported.containers.write.includes('ivf'));
        assert.ok(reported.videoCopy.ivf.includes('av01'));
    });
});
