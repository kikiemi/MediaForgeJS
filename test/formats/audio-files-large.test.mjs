import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect, open } from 'mediaforgejs';
import { encodeFlac } from 'mediaforgejs/codecs';
import { concat, oggPage } from '../helpers/original-fixtures.mjs';

// Audio files of 4 MiB and more: described from their headers when these state the stream, read
// around a time by bisecting frame numbers or page granules, and indexed in a few bytes a frame.

/** A source of `bytes` that counts the bytes read from it. */
const counted = bytes => {
    const source = {
        size: bytes.length,
        bytesRead: 0,
        read(offset, length) {
            source.bytesRead += length;
            return Promise.resolve(bytes.slice(offset, offset + length));
        },
    };
    return source;
};
const withoutCounts = info => info.tracks.map(({ sampleCount, ...track }) => track);
const packetFields = packet => [packet.timestamp, packet.duration, packet.isKeyframe, packet.data];

/** `make()` once, on first use. */
const once = make => {
    let made;
    return () => (made ??= make());
};

// An MP3 of 4.2 MB: an Info frame with a LAME tag (576 samples of delay, 1000 of padding) stating
// 10100 frames and their bytes, then the 417-byte frames of 128 kb/s at 44.1 kHz.
const MP3_FRAMES = 10100;
const MP3_FRAME_BYTES = 417;
const mp3 = once(() => {
    const bytes = new Uint8Array(MP3_FRAME_BYTES * (MP3_FRAMES + 1));
    for (let index = 0; index <= MP3_FRAMES; index++)
        bytes.set([0xff, 0xfb, 0x90, 0x64], index * MP3_FRAME_BYTES);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('Info'), 36);
    view.setUint32(40, 3);
    view.setUint32(44, MP3_FRAMES);
    view.setUint32(48, bytes.length);
    bytes.set(new TextEncoder().encode('LAME3.100'), 52);
    bytes.set([(576 >> 4) & 0xff, ((576 & 15) << 4) | (1000 >> 8), 1000 & 0xff], 73);
    return bytes;
});

// A FLAC of 4.6 MB: 26 s of stereo noise, which does not compress.
const flac = once(async () => {
    const rate = 44100;
    const planes = [new Float32Array(rate * 26), new Float32Array(rate * 26)];
    let seed = 1;
    for (let index = 0; index < rate * 26 * 2; index++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        planes[index & 1][index >> 1] = seed / 2 ** 32 - 0.5;
    }
    const bytes = await encodeFlac(planes, { sampleRate: rate });
    assert.ok(bytes.length >= 4 * 1024 * 1024);
    return bytes;
});

/**
 * Ogg Opus of `count` 2.5 ms packets of 200 to 1,270 bytes in pages of up to 4 KiB, many going on
 * from one page into the next, as libogg lays them out.
 */
function opusStream(serial, count) {
    const text = value => new TextEncoder().encode(value);
    const pages = [
        oggPage([concat(text('OpusHead'), [1, 2, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0])], 0, {
            flags: 2,
            serial,
        }),
        oggPage([concat(text('OpusTags'), [2, 0, 0, 0], text('MF'), [0, 0, 0, 0])], 1, {
            serial,
        }),
    ];
    let [parts, size, continued, completed] = [[], 0, false, 0];
    const flush = (open, last) => {
        const flags = (continued ? 1 : 0) | (last ? 4 : 0);
        pages.push(oggPage(parts, pages.length, { flags, granule: completed * 120, serial, open }));
        [parts, size, continued] = [[], 0, open];
    };
    let seed = serial;
    for (let index = 0; index < count; index++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        let packet = new Uint8Array(200 + (seed % 1070)).fill(index & 255);
        packet[0] = 0x80;
        if (size + packet.length > 4096) {
            const part = Math.floor((4096 - size) / 255) * 255;
            parts.push(packet.subarray(0, part));
            packet = packet.subarray(part);
            flush(true, false);
        }
        parts.push(packet);
        size += packet.length;
        completed++;
        if (size > 3000 || index === count - 1) flush(false, index === count - 1);
    }
    return concat(...pages);
}

/**
 * Asserts that the packet at each of `times` reads from a third of `bytes` at most and equals the
 * packet a read of the whole input gives there.
 */
async function assertWindows(bytes, times) {
    const whole = await open(bytes);
    try {
        const id = whole.tracks[0].id;
        await whole.packets({ start: 0 }).next();
        for (const time of times) {
            const source = counted(bytes);
            const media = await open(source);
            try {
                const packet = await media.packetAt(id, time);
                assert.ok(source.bytesRead < bytes.length / 3, `${time} s: ${source.bytesRead}`);
                assert.deepEqual(
                    packetFields(packet),
                    packetFields(await whole.packetAt(id, time)),
                );
            } finally {
                media.close();
            }
        }
    } finally {
        whole.close();
    }
}

describe('audio files: large inputs', () => {
    describe('MP3', () => {
        test('is described from its Info frame, reading under 1 MiB', async () => {
            const source = counted(mp3());
            const described = await inspect(source);
            assert.equal(described.tracks[0].sampleCount, undefined);
            assert.equal(described.tracks[0].duration, (MP3_FRAMES * 1152) / 44100);
            assert.ok(source.bytesRead < 1024 * 1024, `${source.bytesRead} bytes`);
            const full = await inspect(mp3(), { sampleCounts: true });
            assert.equal(full.tracks[0].sampleCount, MP3_FRAMES);
            assert.deepEqual(withoutCounts(described), withoutCounts(full));
            assert.deepEqual(described.warnings, full.warnings);
        });

        test('cut short of what its Info frame states, is read whole', async () => {
            const cut = await inspect(mp3().subarray(0, mp3().length - 100));
            assert.equal(cut.tracks[0].sampleCount, MP3_FRAMES - 1);
            assert.equal(cut.warnings[0].code, 'AUDIO_TRUNCATED_TAIL');
        });

        test('holds its frames within an index budget of 16 bytes a frame', async () => {
            const media = await open(mp3(), { maxIndexBytes: MP3_FRAMES * 16 });
            try {
                const time = ((MP3_FRAMES - 1) * 1152) / 44100;
                const last = await media.packetAt(media.tracks[0].id, time);
                assert.deepEqual([last.data.length, last.timestamp], [MP3_FRAME_BYTES, time]);
            } finally {
                media.close();
            }
        });
    });

    describe('FLAC', () => {
        test('is described from STREAMINFO, reading under 1 MiB', async () => {
            const bytes = await flac();
            const source = counted(bytes);
            const described = await inspect(source);
            assert.equal(described.tracks[0].sampleCount, undefined);
            assert.equal(described.tracks[0].duration, 26);
            assert.ok(source.bytesRead < 1024 * 1024, `${source.bytesRead} bytes`);
            const full = await inspect(bytes, { sampleCounts: true });
            assert.deepEqual(withoutCounts(described), withoutCounts(full));
        });

        test('with bytes after it, is read whole', async () => {
            const bytes = await flac();
            const padded = new Uint8Array(bytes.length + 16).fill(0xaa);
            padded.set(bytes);
            const info = await inspect(padded);
            assert.equal(info.tracks[0].sampleCount, 279);
            assert.ok(info.warnings.length > 0);
        });

        test('is read around a time from a fraction of its bytes', async () => {
            await assertWindows(await flac(), [0.5, 9.3, 25.5]);
        });

        test('open() and packets() read it once, as its index gives the frames', async () => {
            const bytes = await flac();
            const source = counted(bytes);
            const media = await open(source);
            const streamed = [];
            for await (const packet of media.packets()) streamed.push(packetFields(packet));
            media.close();
            assert.ok(source.bytesRead < bytes.length * 1.2, `${source.bytesRead} bytes`);
            const whole = await open(bytes);
            const indexed = [];
            for await (const packet of whole.packets({ start: 0 }))
                indexed.push(packetFields(packet));
            whole.close();
            assert.deepEqual(streamed, indexed);
        });
    });

    describe('Ogg', () => {
        test('Opus of 4.6 MB is read around a time from a fraction of its bytes', async () => {
            const ogg = opusStream(7, 6000);
            assert.ok(ogg.length >= 4 * 1024 * 1024);
            await assertWindows(ogg, [0.2, 4.1, 7.77, 14.9]);
        });

        test('a chain of two streams is read whole: its tail is another stream', async () => {
            const chain = concat(opusStream(7, 3000), opusStream(8, 3000));
            const source = counted(chain);
            const media = await open(source);
            try {
                await media.packetAt(media.tracks[0].id, 10);
                assert.ok(source.bytesRead >= chain.length, `${source.bytesRead} bytes`);
            } finally {
                media.close();
            }
        });
    });

    test('WAV packets are placed by their position, in an index of a few numbers', async () => {
        // Ten seconds of 16-bit mono at 8 kHz within an index budget of 1000 bytes.
        const pcm = new Uint8Array(44 + 8000 * 2 * 10);
        const header = new DataView(pcm.buffer);
        pcm.set(new TextEncoder().encode('RIFF'), 0);
        header.setUint32(4, pcm.length - 8, true);
        pcm.set(new TextEncoder().encode('WAVEfmt '), 8);
        header.setUint32(16, 16, true);
        header.setUint16(20, 1, true);
        header.setUint16(22, 1, true);
        header.setUint32(24, 8000, true);
        header.setUint32(28, 16000, true);
        header.setUint16(32, 2, true);
        header.setUint16(34, 16, true);
        pcm.set(new TextEncoder().encode('data'), 36);
        header.setUint32(40, pcm.length - 44, true);
        const count = Math.ceil(80000 / 512);
        const { tracks } = await inspect(pcm, {
            sampleCounts: true,
            open: { maxIndexBytes: 1000 },
        });
        assert.equal(tracks[0].sampleCount, count);
        const media = await open(pcm, { maxIndexBytes: 1000 });
        try {
            const time = ((count - 1) * 512) / 8000;
            const tail = await media.packetAt(media.tracks[0].id, time);
            assert.deepEqual(
                [tail.timestamp, tail.data.length],
                [time, (80000 - (count - 1) * 512) * 2],
            );
        } finally {
            media.close();
        }
    });
});
