import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    BlobSource,
    BufferSource,
    ConcatSource,
    RangeSource,
    StreamSource,
    sourceToReadableStream,
} from 'mediaforgejs/io';
import { distUrl } from '../helpers/dist-paths.mjs';

const { ChunkReader, CHUNK_BYTES, FIRST_CHUNK_BYTES } = await import(
    distUrl('esm/core/io/sources/chunk-reader.js')
);

const BYTES = Uint8Array.from({ length: 100 }, (_, index) => index);

async function* chunksOf(...parts) {
    for (const part of parts) yield Uint8Array.from(part);
}

async function readAll(stream) {
    const parts = [];
    for await (const part of stream) parts.push(...part);
    return Uint8Array.from(parts);
}

describe('io', () => {
    describe('memory and Blob sources', () => {
        test('a BufferSource reads ranges, clipped at the end', async () => {
            const source = new BufferSource(BYTES);
            assert.equal(source.size, 100);
            assert.deepEqual(await source.read(10, 3), Uint8Array.of(10, 11, 12));
            assert.deepEqual(await source.read(98, 10), Uint8Array.of(98, 99));
            assert.equal((await source.read(100, 4)).length, 0);
        });

        test('a BufferSource copies its input unless told not to', async () => {
            const input = BYTES.slice();
            const copied = new BufferSource(input);
            const shared = new BufferSource(input, { copy: false });
            input[0] = 77;
            assert.equal((await copied.read(0, 1))[0], 0);
            assert.equal((await shared.read(0, 1))[0], 77);
        });

        test('a BufferSource reads into a caller buffer', async () => {
            const target = new Uint8Array(4);
            await new BufferSource(BYTES).readInto(20, target);
            assert.deepEqual(target, Uint8Array.of(20, 21, 22, 23));
        });

        test('a view of a larger buffer reads only its bytes', async () => {
            const source = new BufferSource(new DataView(BYTES.buffer, 50, 10));
            assert.equal(source.size, 10);
            assert.deepEqual(await source.read(0, 2), Uint8Array.of(50, 51));
        });

        test('a BlobSource reads ranges of a Blob', async () => {
            const source = new BlobSource(new Blob([BYTES]));
            assert.equal(source.size, 100);
            assert.deepEqual(await source.read(97, 10), Uint8Array.of(97, 98, 99));
        });

        test('reads at negative or fractional offsets are refused with IO', async () => {
            const source = new BufferSource(BYTES);
            for (const [offset, length] of [
                [-1, 1],
                [0.5, 1],
                [0, -1],
            ])
                await assert.rejects(source.read(offset, length), {
                    code: 'IO',
                    message: /non-negative safe integers/,
                });
        });
    });

    describe('ranges and concatenations', () => {
        test('a RangeSource reads a window of another source', async () => {
            const range = new RangeSource(new BufferSource(BYTES), 40, 10);
            assert.equal(range.size, 10);
            assert.deepEqual(await range.read(8, 5), Uint8Array.of(48, 49));
        });

        test('a ConcatSource reads across the sources it joins', async () => {
            const joined = new ConcatSource([
                new BufferSource(BYTES.subarray(0, 3)),
                new BufferSource(BYTES.subarray(3, 6)),
            ]);
            assert.equal(joined.size, 6);
            assert.deepEqual(await joined.read(1, 4), Uint8Array.of(1, 2, 3, 4));
        });

        test('ranges of one source join in the order given', async () => {
            const joined = ConcatSource.fromRanges(new BufferSource(BYTES), [
                { offset: 90, length: 2 },
                { offset: 10, length: 2 },
                { offset: 98 },
            ]);
            assert.deepEqual(
                await joined.read(0, joined.size),
                Uint8Array.of(90, 91, 10, 11, 98, 99),
            );
        });
    });

    describe('stream sources', () => {
        test('a stream is held in memory and read at random', async () => {
            const source = await StreamSource.from(chunksOf([1, 2], [3], [4, 5, 6]), {
                retention: 'memory',
                maxBytes: 16,
            });
            assert.equal(source.size, 6);
            assert.deepEqual(await source.read(1, 4), Uint8Array.of(2, 3, 4, 5));
        });

        test('a ReadableStream works as well as an async iterable', async () => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(Uint8Array.of(9, 8));
                    controller.close();
                },
            });
            const source = await StreamSource.from(stream, { retention: 'memory', maxBytes: 2 });
            assert.deepEqual(await source.read(0, 2), Uint8Array.of(9, 8));
        });

        test("a Blob's stream is read back whole at exactly maxBytes", async () => {
            const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => (index * 31) & 0xff);
            const source = await StreamSource.from(new Blob([bytes]).stream(), {
                retention: 'memory',
                maxBytes: bytes.length,
            });
            assert.equal(source.size, bytes.length);
            assert.deepEqual(await source.read(0, bytes.length), bytes);
        });

        test('a stream past maxBytes is refused with OOM', async () => {
            await assert.rejects(
                StreamSource.from(chunksOf([1, 2, 3]), { retention: 'memory', maxBytes: 2 }),
                { code: 'OOM' },
            );
        });

        test('a stream of endless empty chunks is refused with IO', async () => {
            async function* empty() {
                for (;;) yield new Uint8Array(0);
            }
            await assert.rejects(
                StreamSource.from(empty(), {
                    retention: 'memory',
                    maxBytes: 8,
                    maxEmptyChunks: 10,
                }),
                { code: 'IO', message: /no byte progress/ },
            );
        });

        test('an aborted signal stops reading the stream with ABORT', async () => {
            await assert.rejects(
                StreamSource.from(chunksOf([1]), {
                    retention: 'memory',
                    maxBytes: 8,
                    signal: AbortSignal.abort(),
                }),
                { code: 'ABORT' },
            );
        });
    });

    describe('sources as streams', () => {
        test('a source reads out as a stream in chunks, reporting progress', async () => {
            const progress = [];
            const stream = sourceToReadableStream(new BufferSource(BYTES), {
                chunkBytes: 32,
                onProgress: (read, total) => progress.push([read, total]),
            });
            assert.deepEqual(await readAll(stream), BYTES);
            assert.deepEqual(progress, [
                [32, 100],
                [64, 100],
                [96, 100],
                [100, 100],
            ]);
        });

        test('an aborted signal ends the stream with ABORT', async () => {
            const stream = sourceToReadableStream(new BufferSource(BYTES), {
                signal: AbortSignal.abort(),
            });
            await assert.rejects(readAll(stream), { code: 'ABORT' });
        });
    });

    describe('chunk reader', () => {
        const pages = () => {
            const bytes = new Uint8Array(CHUNK_BYTES * 4 + 32);
            for (let page = 0; page < 5; page++)
                bytes.fill(page + 1, page * CHUNK_BYTES, (page + 1) * CHUNK_BYTES);
            return bytes;
        };

        test('keeps three pages, a hit promoting its page', async () => {
            const bytes = pages();
            const reads = [];
            const reader = new ChunkReader({
                size: bytes.length,
                async read(at, length) {
                    reads.push(at / CHUNK_BYTES);
                    return bytes.subarray(at, at + length);
                },
            });
            for (const page of [0, 1, 2, 0, 3, 2, 1]) await reader.bytes(page * CHUNK_BYTES, 2);
            assert.deepEqual(reads, [0, 1, 2, 3, 1]);
        });

        test('cached pages are snapshots; returned views outlive eviction', async () => {
            const bytes = pages();
            const reader = new ChunkReader({
                size: bytes.length,
                read: async (at, length) => bytes.subarray(at, at + length),
            });
            const retained = await reader.bytes(0, 2);
            bytes[0] = 99;
            assert.deepEqual(
                await reader.bytes(0, 2),
                Uint8Array.of(1, 1),
                'not the borrowed storage',
            );
            for (const page of [1, 2, 3]) await reader.bytes(page * CHUNK_BYTES, 2);
            assert.deepEqual(retained, Uint8Array.of(1, 1));
        });

        test('reads across pages and clips at the end', async () => {
            const bytes = pages();
            const reader = new ChunkReader({
                size: bytes.length,
                read: async (at, length) => bytes.subarray(at, at + length),
            });
            assert.deepEqual(await reader.bytes(CHUNK_BYTES - 2, 4), Uint8Array.of(1, 1, 2, 2));
            assert.deepEqual(await reader.bytes(bytes.length - 2, 10), Uint8Array.of(5, 5));
            assert.equal((await reader.bytes(bytes.length, 10)).length, 0);
        });

        test('refuses negative offsets and NaN lengths with DEMUX', async () => {
            const reader = new ChunkReader({ size: 8, read: async () => new Uint8Array(8) });
            await assert.rejects(reader.bytes(-1, 1), { code: 'DEMUX' });
            await assert.rejects(reader.bytes(0, NaN), { code: 'DEMUX' });
        });

        test('concurrent reads of one page share one source read', async () => {
            let sourceReads = 0;
            let release;
            const reader = new ChunkReader({
                size: 8,
                read() {
                    sourceReads++;
                    return new Promise(resolve => (release = resolve));
                },
            });
            const first = reader.bytes(0, 4);
            const second = reader.bytes(2, 4);
            await Promise.resolve();
            assert.equal(sourceReads, 1);
            release(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
            assert.deepEqual(await first, Uint8Array.of(0, 1, 2, 3));
            assert.deepEqual(await second, Uint8Array.of(2, 3, 4, 5));
        });

        test('a failed read does not poison the page', async () => {
            let attempts = 0;
            const failure = new Error('source failed');
            const reader = new ChunkReader({
                size: 2,
                async read() {
                    if (++attempts === 1) throw failure;
                    return Uint8Array.of(3, 4);
                },
            });
            await assert.rejects(reader.bytes(0, 2), error => error === failure);
            assert.deepEqual(await reader.bytes(0, 2), Uint8Array.of(3, 4));
        });

        test('a scan starts at one page and doubles while it goes on', async () => {
            // A miss away from the scan reads only the page it falls in.
            const KiB = 1024;
            const scanned = [];
            const reader = new ChunkReader(
                {
                    size: 4 * CHUNK_BYTES,
                    async read(at, length) {
                        scanned.push([at / KiB, length / KiB]);
                        return new Uint8Array(length);
                    },
                },
                CHUNK_BYTES,
                false,
                FIRST_CHUNK_BYTES,
            );
            for (const at of [
                10,
                64 * KiB,
                192 * KiB,
                448 * KiB,
                960 * KiB,
                1984 * KiB,
                3008 * KiB,
            ])
                await reader.bytes(at, 16);
            await reader.bytes(100 * KiB, 16);
            await reader.bytes(4032 * KiB + 7, 16);
            assert.deepEqual(scanned, [
                [0, 64],
                [64, 128],
                [192, 256],
                [448, 512],
                [960, 1024],
                [1984, 1024],
                [3008, 1024],
                [64, 64],
                [4032, 64],
            ]);
        });
    });
});
