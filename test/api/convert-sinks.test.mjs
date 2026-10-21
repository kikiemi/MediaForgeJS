import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, convert, open } from 'mediaforgejs';
import { Mp4Demuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { hugeAudioMp4, sampleByte } from '../helpers/huge-sources.mjs';
import { classicMp4, fixtureSource } from '../helpers/mp4-fixture.mjs';
import { preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';

// Where convert() writes: the limits a Blob, a sink and check() share, and sinks that only go
// forward, which receive the file while the input is still read.

const oom = error => error.code === 'OOM';

/**
 * Copies `source` into `format` through a forward-only sink, and whether writing began before
 * the last read.
 */
async function forwardOnly(source, format) {
    const events = [];
    const traced = {
        size: source.size,
        async read(offset, length) {
            events.push('read');
            return source.read(offset, length);
        },
    };
    const parts = [];
    const sink = {
        write(bytes) {
            events.push('write');
            parts.push(bytes.slice());
        },
        async close() {},
    };
    await convert(traced, format, { copy: true, sink, open: { cacheBytes: 0 } });
    return {
        bytes: Buffer.concat(parts),
        early: events.indexOf('write') < events.lastIndexOf('read'),
    };
}

describe('convert() sinks and limits', () => {
    for (const copy of [true, false])
        test(`maxBytes holds for check(), a Blob, a sink and a Media (copy: ${copy})`, async () => {
            const options = { copy, maxBytes: 1, open: { cacheBytes: 0 } };
            const support = await check(waveFixture(), 'wav', options);
            assert.deepEqual([support.supported, support.code], [false, 'OOM']);
            await assert.rejects(convert(waveFixture(), 'wav', options), oom);
            await assert.rejects(
                convert(waveFixture(), 'wav', { ...options, sink: new MemorySink() }),
                oom,
            );
            const media = await open(waveFixture());
            try {
                const sink = new MemorySink();
                await assert.rejects(media.convert('wav', { copy, maxBytes: 1, sink }), oom);
                await media.convert('wav', { copy, sink: new MemorySink() });
            } finally {
                media.close();
            }
        });

    test('a sink takes the input limits a Blob takes, its options read once', async () => {
        const input = classicMp4({ count: 8 }).bytes;
        await assert.rejects(
            convert(input, 'm4a', { copy: true, sink: new MemorySink(), open: { maxSamples: 1 } }),
            oom,
        );
        const expected = new Uint8Array(
            await (await convert(waveFixture(), 'wav', { copy: true })).blob.arrayBuffer(),
        );
        const sink = new MemorySink();
        const reads = {};
        const reading = Object.create({
            get cacheBytes() {
                reads.cacheBytes = (reads.cacheBytes ?? 0) + 1;
                return 0;
            },
        });
        const options = Object.create({
            get open() {
                reads.open = (reads.open ?? 0) + 1;
                return reading;
            },
            get maxBytes() {
                reads.maxBytes = (reads.maxBytes ?? 0) + 1;
                return expected.length;
            },
        });
        Object.assign(options, { copy: true, sink });
        await convert(waveFixture(), 'wav', options);
        assert.deepEqual(sink.toUint8Array(), expected);
        assert.deepEqual(reads, { open: 1, cacheBytes: 1, maxBytes: 1 });
    });

    test('an aborted reading signal stops before any read or close', async () => {
        const controller = new AbortController();
        controller.abort();
        const input = waveFixture();
        let reads = 0;
        let closes = 0;
        const source = {
            size: input.length,
            async read(offset, length) {
                reads++;
                return input.slice(offset, offset + length);
            },
        };
        await assert.rejects(
            convert(source, 'wav', {
                copy: true,
                open: { signal: controller.signal },
                sink: { write() {}, close: async () => closes++ },
            }),
            error => error.code === 'ABORT',
        );
        assert.deepEqual([reads, closes], [0, 0]);
    });

    test('a sink has no default limit; check() is held to the one set', async () => {
        // 257 MiB of silence: over the size a Blob is built for.
        const payload = 257 * 1024 * 1024;
        const header = new Uint8Array(44);
        const text = new TextEncoder();
        header.set(text.encode('RIFF'), 0);
        header.set(text.encode('WAVEfmt '), 8);
        header.set(text.encode('data'), 36);
        const view = new DataView(header.buffer);
        view.setUint32(4, payload + 36, true);
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 48000, true);
        view.setUint32(28, 96000, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        view.setUint32(40, payload, true);
        const source = {
            size: header.length + payload,
            async read(offset, length) {
                const output = new Uint8Array(Math.min(length, this.size - offset));
                if (offset < header.length)
                    output.set(
                        header.subarray(offset, Math.min(header.length, offset + output.length)),
                    );
                return output;
            },
        };
        assert.equal((await check(source, 'wav', { copy: true })).supported, true);
        const media = await open(source);
        try {
            assert.equal((await media.check('wav', { copy: true })).supported, true);
            let written = 0;
            await media.convert('wav', {
                copy: true,
                sink: {
                    write: bytes => (written += bytes.length),
                    patchAt() {},
                    async close() {},
                },
            });
            assert.equal(written, payload + 44);
            const limited = await media.check('wav', { copy: true, maxBytes: 256 * 1024 * 1024 });
            assert.equal(limited.code, 'OOM');
        } finally {
            media.close();
        }
    });

    test('a forward-only sink gets MP4 and MOV while the input is read, past 4 GiB', async () => {
        const source = hugeAudioMp4({
            count: 40,
            sampleBytes: 256 * 1024,
            gapBytes: 4.5 * 2 ** 30,
        });
        for (const format of ['mp4', 'mov']) {
            const expected = Buffer.from(
                await (await convert(source, format, { copy: true })).blob.arrayBuffer(),
            );
            const { bytes, early } = await forwardOnly(source, format);
            assert.equal(Buffer.compare(bytes, expected), 0, `${format} as the Blob`);
            assert.ok(early, `${format} begins before the last read`);
            const { samples } = (await new Mp4Demuxer().demux(new Blob([bytes]))).audioTracks[0];
            assert.equal(samples.length, 40);
            for (const [index, sample] of samples.entries())
                assert.equal(bytes[sample.offset + 1], sampleByte(index, 1), `${format} ${index}`);
        }
    });

    test('a forward-only sink gets Matroska of two tracks cluster by cluster', async () => {
        const { bytes: input } = preservationFixture({
            tracks: [{ type: 'audio' }, { type: 'audio' }].map(track => ({
                ...track,
                packets: Array.from({ length: 400 }, (_, sample) =>
                    Buffer.of(0x21, sample & 255, sample >> 8, 0x7f),
                ),
            })),
        });
        const { bytes, early } = await forwardOnly(fixtureSource(input), 'mkv');
        assert.ok(early, 'clusters are written before the last read');
        const { blob } = await convert(input, 'mkv', { copy: true });
        const described = async data => {
            const media = await open(data);
            try {
                return media.tracks.map(track => [track.codec, track.duration]);
            } finally {
                media.close();
            }
        };
        assert.deepEqual(await described(new Blob([bytes])), await described(blob));
    });
});
