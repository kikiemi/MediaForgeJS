import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { MemorySink, ReadableStreamSink } from 'mediaforgejs/io';
import { packetOf, packetsOf } from '../helpers/media-packets.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';

// A re-encode of a 100 GB MP4 of which only the headers and the AAC packets exist: the packets
// past the 32-bit offsets are read where they are, the gap never, and failed or cancelled reads
// leave the borrowed source usable.

const SIZE = 100_000_000_000;

/** The sparse source, a compact MP4 of the same packets, and the AAC frames. */
async function sparse() {
    const aac = await encodeAacLc(
        [Float32Array.from({ length: 2048 }, (_, i) => Math.sin((i * Math.PI) / 24) / 8)],
        { sampleRate: 48000, bitrate: 64 },
    );
    const compact = classicMp4({
        co64: true,
        sizes: aac.frames.map(frame => frame.length),
        timescale: 48000,
        timing: [[aac.frames.length, 1024]],
    });
    for (const [index, frame] of aac.frames.entries())
        compact.bytes.set(frame, compact.sampleOffsets[index]);
    const movie = Buffer.from(compact.bytes.slice(compact.moovOffset));
    const payload = Buffer.concat(aac.frames);
    const packetOffset = SIZE - movie.length - payload.length;
    movie.writeBigUInt64BE(BigInt(packetOffset), movie.indexOf('co64') + 12);
    const header = Buffer.alloc(40);
    header.set(compact.bytes.subarray(0, 24));
    header.writeUInt32BE(1, 24);
    header.write('mdat', 28);
    header.writeBigUInt64BE(BigInt(packetOffset + payload.length - 24), 32);
    const ranges = [
        [0, header],
        [packetOffset, payload],
        [SIZE - movie.length, movie],
    ];
    const reads = [];
    const source = {
        size: SIZE,
        closes: 0,
        /** Changes or holds the bytes read at an offset, when set. */
        hook: undefined,
        async read(offset, length) {
            assert.equal(this, source, 'read() keeps its receiver');
            assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length));
            assert.ok(offset >= 0 && offset + length <= SIZE);
            assert.ok(length <= 1024 * 1024, 'small packets make no input-sized read');
            reads.push({ offset, length });
            const bytes = new Uint8Array(length);
            for (const [start, data] of ranges) {
                const from = Math.max(offset, start);
                const end = Math.min(offset + length, start + data.length);
                if (end > from) bytes.set(data.subarray(from - start, end - start), from - offset);
            }
            return source.hook ? source.hook(offset, bytes) : bytes;
        },
        close() {
            source.closes++;
        },
    };
    return { source, reads, packetOffset, compact, aac };
}

const resampled = { to: 'm4a', audio: { sampleRate: 24000 } };

describe('pipeline/transcode: a sparse input of 100 GB', () => {
    test('is re-encoded from its packets as a compact copy of it is', async () => {
        const { source, reads, packetOffset, compact, aac } = await sparse();
        const media = await open(source, { cacheBytes: 0 });
        try {
            assert.equal((await media.check(resampled)).supported, true, 'no size ceiling');
            const sink = new MemorySink();
            await media.convert({ ...resampled, sink });
            const output = await open(sink.toBlob('audio/mp4'));
            const expected = await open((await convert(compact.bytes, resampled)).blob);
            assert.equal(output.tracks[0].sampleRate, 24000);
            assert.deepEqual(
                (await packetsOf(output, 1)).map(packet => packet.data),
                (await packetsOf(expected, 1)).map(packet => packet.data),
            );
            output.close();
            expected.close();
            const decoded = await open((await convert(sink.toBlob('audio/mp4'), 'wav')).blob);
            assert.equal(decoded.tracks[0].sampleRate, 24000);
            const length = (aac.frames.length * 1024) / 48000;
            assert.ok(Math.abs(decoded.tracks[0].duration - length) < 1 / 24000);
            const first = await packetOf(decoded, decoded.tracks[0].id);
            assert.ok(
                first.data.some(byte => byte !== 0),
                'the sound is there',
            );
            decoded.close();
            assert.ok(
                reads.some(({ offset }) => offset === packetOffset),
                'packets read',
            );
            const total = reads.reduce((sum, { length: size }) => sum + size, 0);
            assert.ok(total < 8 * 1024 * 1024, `${total} bytes read`);
        } finally {
            media.close();
        }
        assert.equal(source.closes, 0);
    });

    test('is copied to a Blob and to a readable stream alike', async () => {
        const { source, aac } = await sparse();
        const streamed = new ReadableStreamSink();
        const [, fromStream] = await Promise.all([
            convert(source, 'm4a', { sink: streamed }),
            new Response(streamed.stream).blob(),
        ]);
        for (const output of [(await convert(source, 'm4a')).blob, fromStream]) {
            const media = await open(output);
            assert.equal(media.tracks[0].sampleRate, 48000);
            const packets = await packetsOf(media, media.tracks[0].id);
            for (const [index, frame] of aac.frames.entries())
                assert.deepEqual(packets[index].data, frame);
            media.close();
        }
    });

    test('a short read fails with IO and leaves the Media usable', async () => {
        const { source, packetOffset } = await sparse();
        const media = await open(source, { cacheBytes: 0 });
        try {
            source.hook = (offset, bytes) => (offset === packetOffset ? bytes.subarray(1) : bytes);
            assert.equal((await media.check(resampled)).code, 'IO');
            await assert.rejects(media.convert(resampled), error => error.code === 'IO');
            source.hook = undefined;
            assert.equal((await media.check(resampled)).supported, true);
        } finally {
            media.close();
        }
    });

    for (const [name, skip, run] of [
        [
            'an open Media',
            0,
            (media, _source, sink, signal) => media.convert({ ...resampled, sink, signal }),
        ],
        [
            'a call',
            // Opening reads the first packet for its shape; the call is held at the next read.
            1,
            (_media, source, sink, signal) =>
                convert(source, 'm4a', { sink, signal, open: { cacheBytes: 0 } }),
        ],
    ])
        test(`aborting ${name} ends it during a pending read, writing nothing after`, async () => {
            const { source, packetOffset } = await sparse();
            const media = await open(source, { cacheBytes: 0 });
            let seen = 0;
            let release;
            let started;
            const reading = new Promise(resolve => (started = resolve));
            source.hook = (offset, bytes) => {
                if (offset !== packetOffset || seen++ < skip) return bytes;
                started();
                return new Promise(resolve => (release = () => resolve(bytes)));
            };
            const cancellation = new AbortController();
            const sink = { writes: 0, closes: 0, aborts: 0 };
            const cancelled = run(
                media,
                source,
                {
                    write: () => sink.writes++,
                    patchAt() {},
                    close: async () => sink.closes++,
                    abort: async () => sink.aborts++,
                },
                cancellation.signal,
            );
            try {
                await reading;
                cancellation.abort();
                // The read stays pending until the conversion has ended.
                await assert.rejects(cancelled, error => error.code === 'ABORT');
                assert.deepEqual([sink.aborts, sink.closes], [1, 0]);
                const writes = sink.writes;
                release();
                source.hook = undefined;
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(sink.writes, writes, 'a late read writes nothing');
                assert.equal((await media.check(resampled)).supported, true);
            } finally {
                release?.();
                media.close();
            }
            assert.equal(source.closes, 0, 'the borrowed source stays open');
        });
});
