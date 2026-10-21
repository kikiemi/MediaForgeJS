import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect, open } from 'mediaforgejs';
import { encodeFlac } from 'mediaforgejs/codecs';
import { FlacMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { concat, flacFixture, oggPage, seededBytes } from '../helpers/original-fixtures.mjs';
import { allPackets, bytesOf, copied, readMedia } from '../helpers/read-media.mjs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

const payloads = packets => packets.map(packet => packet.data);
const ascii = value => new TextEncoder().encode(value);

/** The fields of a FLAC frame header: strategy, coded number, block size and header length. */
function frameHeader(data) {
    const blockingStrategy = data[1] & 1;
    const sizeCode = data[2] >> 4;
    const rateCode = data[2] & 15;
    let at = 4;
    let codedNumber = data[at];
    let more = 0;
    if (codedNumber >= 0xc0) {
        more =
            codedNumber >= 0xfe
                ? 6
                : codedNumber >= 0xfc
                  ? 5
                  : codedNumber >= 0xf8
                    ? 4
                    : codedNumber >= 0xf0
                      ? 3
                      : codedNumber >= 0xe0
                        ? 2
                        : 1;
        codedNumber &= 0x3f >> (more - 1);
    }
    for (let index = 0; index < more; index++) codedNumber = codedNumber * 64 + (data[++at] & 0x3f);
    at++;
    let blockSize;
    if (sizeCode === 1) blockSize = 192;
    else if (sizeCode <= 5) blockSize = 576 << (sizeCode - 2);
    else if (sizeCode === 6) blockSize = data[at++] + 1;
    else if (sizeCode === 7) {
        blockSize = ((data[at] << 8) | data[at + 1]) + 1;
        at += 2;
    } else blockSize = 256 << (sizeCode - 8);
    if (rateCode === 12) at += 1;
    else if (rateCode === 13 || rateCode === 14) at += 2;
    return { blockingStrategy, codedNumber, blockSize, headerLen: at + 1 };
}

/** The bit-exact CRC of `bytes` of `width` bits. */
function crc(bytes, width, polynomial) {
    let value = 0;
    const top = 1 << (width - 1);
    const mask = (1 << width) - 1;
    for (const byte of bytes) {
        value ^= byte << (width - 8);
        for (let bit = 0; bit < 8; bit++)
            value = value & top ? ((value << 1) ^ polynomial) & mask : (value << 1) & mask;
    }
    return value;
}

/** The frames of flacFixture(): three constant mono frames of 16 samples at 8000 Hz. */
const fixtureFrames = native =>
    [0, 1, 2].map(index => native.subarray(42 + index * 12, 54 + index * 12));

/** The number of frames a WAVE holds. */
function waveFrames(wav, channels) {
    const data = Buffer.from(wav).indexOf('data');
    return new DataView(wav.buffer, wav.byteOffset).getUint32(data + 4, true) / (2 * channels);
}

describe('audio files: FLAC', () => {
    test('takes the title of its Vorbis comment', async () => {
        const { title, tracks } = await readMedia(fixtures['flac-blocks.flac']());
        assert.equal(title, 'Lossless');
        assert.equal(tracks[0].packets.length, 10);
    });

    test('counts the frames of a file in inspect()', async () => {
        const { tracks } = await inspect(flacFixture(), { sampleCounts: true });
        assert.deepEqual([tracks[0].codec, tracks[0].sampleCount], ['flac', 3]);
    });

    test('indexes its frames in typed arrays, not as a record each', async () => {
        const { mediaFileState, openFile } = await import('../helpers/engine.mjs');
        const file = await openFile(flacFixture());
        try {
            assert.ok(mediaFileState(file).tracks[0].sampleIndex);
        } finally {
            file.close();
        }
    });

    test('a cut last frame and the frame it runs into are dropped, marked incomplete', async () => {
        const source = fixtures['flac-blocks.flac']();
        const whole = await allPackets(source);
        const cut = source.subarray(0, source.length - whole[9].data.length - 10);
        const { tracks, warnings } = await readMedia(cut);
        assert.ok(warnings.includes('FLAC_TRUNCATED_TAIL'), `${warnings}`);
        assert.equal(tracks[0].track.incomplete, true);
        assert.deepEqual(payloads(tracks[0].packets), payloads(whole).slice(0, 8));
        await rejectsStrict(cut);
    });

    test('resynchronises after a damaged frame header, timed by the frame numbers', async () => {
        // The damaged header also hides the end of the frame before it, which can no longer be
        // CRC-verified, so both are dropped.
        const source = fixtures['flac-blocks.flac']();
        const whole = await allPackets(source);
        const sizes = whole.map(packet => packet.data.length);
        let position = source.length - sizes.reduce((sum, size) => sum + size, 0);
        for (let index = 0; index < 4; index++) position += sizes[index];
        const damaged = source.slice();
        damaged.fill(0, position + 4, position + 24);
        const { tracks, warnings } = await readMedia(damaged);
        assert.ok(warnings.includes('FLAC_RESYNCHRONIZED'), `${warnings}`);
        const kept = tracks[0].packets;
        assert.equal(kept.length, 8);
        assert.deepEqual(payloads(kept.slice(0, 3)), payloads(whole.slice(0, 3)));
        assert.deepEqual(payloads(kept.slice(3)), payloads(whole.slice(5)));
        assert.equal(kept[3].timestamp, whole[5].timestamp);
        await rejectsStrict(damaged);
    });

    test('skips an ID3v2 tag in front of the stream', async () => {
        const native = flacFixture();
        const id3 = concat(ascii('ID3'), [3, 0, 0, 0, 0, 0, 10], new Uint8Array(10));
        assert.deepEqual(payloads(await allPackets(concat(id3, native))), fixtureFrames(native));
    });

    test('reads FLAC that lost its head from its first whole frame, unless strict', async () => {
        // fLaC, STREAMINFO and part of a frame are lost; the first whole frame's header states the
        // rate, the channels and the depth.
        const native = flacFixture();
        const frames = fixtureFrames(native);
        const headless = native.slice(42 + 5);
        const { tracks, warnings } = await readMedia(headless);
        assert.deepEqual(warnings.slice(0, 1), ['FLAC_HEADERLESS']);
        assert.deepEqual(
            tracks[0].packets.map(packet => [Math.round(packet.timestamp * 8000), packet.data]),
            frames.slice(1).map((frame, index) => [16 * (index + 1), frame]),
        );
        assert.equal(waveFrames(await bytesOf(await convert(headless, { to: 'wav' })), 1), 32);
        await rejectsStrict(headless);
    });

    for (const blocking of ['fixed', 'variable'])
        test(`reads FLAC from a ${blocking}-blocking first frame`, async () => {
            // Only fLaC and STREAMINFO are lost; the frame headers start like MPEG-2 ADTS headers.
            const native = flacFixture({ variable: blocking === 'variable' });
            const { format, tracks, warnings } = await readMedia(native.subarray(42));
            assert.equal(format, 'flac');
            assert.deepEqual(warnings.slice(0, 1), ['FLAC_HEADERLESS']);
            assert.deepEqual(
                tracks[0].packets.map(packet => [packet.timestamp, packet.data]),
                fixtureFrames(native).map((frame, index) => [index * 0.002, frame]),
            );
        });

    test('a first whole frame past the sniffed prefix counts once the next agrees', async () => {
        // Large multichannel frames leave the first whole frame beyond the prefix detection reads.
        const native = flacFixture();
        const headless = native.slice(42 + 5);
        assert.deepEqual(
            payloads(await allPackets(concat(new Uint8Array(9000), headless))),
            payloads(await allPackets(headless)),
        );
    });

    test('native FLAC output numbers its frames anew, keeping their bodies', async () => {
        // Frames of a second chained Ogg link are numbered from zero again; each rewritten frame
        // keeps valid CRCs.
        const native = flacFixture();
        const frames = fixtureFrames(native);
        const sink = new MemorySink();
        const muxer = new FlacMuxer(sink, 8000, 1, 16, native.subarray(0, 42));
        [frames[0], frames[1], frames[0], frames[1]].forEach((data, index) =>
            muxer.addAudioChunk({
                trackType: 'audio',
                data,
                timestamp: index * 0.002,
                duration: 0.002,
                isKeyframe: true,
            }),
        );
        await muxer.finalize();
        const written = await allPackets(sink.toUint8Array());
        assert.deepEqual(
            written.map(packet => frameHeader(packet.data).codedNumber),
            [0, 1, 2, 3],
        );
        assert.deepEqual(
            written.map(packet => Math.round(packet.timestamp * 8000)),
            [0, 16, 32, 48],
        );
        assert.deepEqual(written[2].data.subarray(7, 10), frames[0].subarray(7, 10));
    });

    test('chained Ogg FLAC links ending in short blocks copy to variable blocking', async () => {
        // Fixed-blocking frame numbers would place the second link's frames a short block too
        // late; the copy declares block sizes 16 to 32 and numbers every frame by its first sample.
        const frame = (number, blockSize, sample) => {
            const prefix = [0xff, 0xf8, 0x64, 0x08, number, blockSize - 1];
            const body = [...prefix, crc(prefix, 8, 0x07), 0, (sample >> 8) & 0xff, sample & 0xff];
            const check = crc(body, 16, 0x8005);
            return Uint8Array.from([...body, check >> 8, check & 0xff]);
        };
        const streamInfo = flacFixture().slice(4, 42);
        streamInfo.set([0, 32, 0, 32], 4);
        const identification = concat(
            [0x7f],
            ascii('FLAC'),
            [1, 0, 0, 0],
            ascii('fLaC'),
            streamInfo,
        );
        const frames = [frame(0, 32, 1000), frame(1, 16, -1000)];
        const link = serial =>
            concat(
                oggPage([identification], 0, { flags: 2, serial }),
                oggPage(frames, 1, { flags: 4, granule: 48, serial }),
            );
        const chained = concat(link(1), link(2));
        assert.deepEqual((await readMedia(chained)).warnings, ['OGG_CHAINED_STREAMS']);
        const native = await copied(chained, 'flac');
        assert.deepEqual([...native.subarray(8, 12)], [0, 16, 0, 32]);
        const written = await allPackets(native);
        const headers = written.map(packet => frameHeader(packet.data));
        assert.deepEqual(
            headers.map(header => [header.blockingStrategy, header.codedNumber, header.blockSize]),
            [
                [1, 0, 32],
                [1, 32, 16],
                [1, 48, 32],
                [1, 80, 16],
            ],
        );
        assert.deepEqual(
            written.map(packet => Math.round(packet.timestamp * 8000)),
            [0, 32, 48, 80],
        );
        assert.deepEqual(
            written.map((packet, index) => packet.data.subarray(headers[index].headerLen, -2)),
            [...frames, ...frames].map(data => data.subarray(7, -2)),
        );
        assert.equal(waveFrames(await bytesOf(await convert(native, { to: 'wav' })), 1), 96);
    });

    describe('STREAMINFO of a copy', () => {
        // 8192 noise samples at 8 kHz, mono: STREAMINFO is bytes 8 to 42, its sample total ends at
        // byte 26 and its MD5 follows.
        const encoded = async () =>
            encodeFlac(
                [Float32Array.from(seededBytes(8192, 0x4d463430), byte => (byte - 128) / 128)],
                { sampleRate: 8000 },
            );

        test('a missing sample total is restored from the copied frames', async () => {
            // Ogg FLAC and streaming encoders write a total of 0.
            const original = await encoded();
            const unknownTotal = original.slice();
            unknownTotal[21] &= 0xf0;
            unknownTotal.fill(0, 22, 26);
            const copy = await copied(unknownTotal, 'flac');
            assert.deepEqual(copy.subarray(8, 42), original.subarray(8, 42));
        });

        test('a total the frames do not reach is corrected and the MD5 cleared', async () => {
            // As in a truncated file: the MD5 covered samples the copy does not have.
            const original = await encoded();
            const truncated = original.slice();
            new DataView(truncated.buffer).setUint32(22, 1_000_000);
            const copy = await copied(truncated, 'flac');
            assert.deepEqual(copy.subarray(8, 26), original.subarray(8, 26));
            assert.deepEqual(copy.subarray(26, 42), new Uint8Array(16));
        });
    });
});
