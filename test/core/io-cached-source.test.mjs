import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect, open } from 'mediaforgejs';
import { BlobSource, CachedSource } from 'mediaforgejs/io';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { pcmBenchmarkFixture } from '../helpers/workflow-benchmark-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

// The page cache over a source, and how a Blob is read in slices: what each read fetches from the
// source and what it hands back.

const { readCachedSource, borrowedReads } = await import(
    distUrl('esm/core/io/sources/cached-source.js')
);
const { ChunkReader } = await import(distUrl('esm/core/io/sources/chunk-reader.js'));

const KiB = 1024;
const MiB = 1024 * KiB;

/** A source of `data` that counts its reads in `reads` ([offset, count]). */
function countingSource(data) {
    const reads = [];
    return {
        reads,
        size: data.length,
        async read(offset, count) {
            reads.push([offset, count]);
            return data.slice(offset, offset + count);
        },
    };
}

/**
 * A Blob of `size` bytes whose slices record [start, length] in `slices` (in KiB, or in `unit`)
 * and hold `byteAt(position)`.
 */
function recordingBlob(size, byteAt, unit = KiB) {
    const slices = [];
    const buffers = new Set();
    const blob = {
        size,
        slice(start, end) {
            slices.push([start / unit, (end - start) / unit]);
            return {
                async arrayBuffer() {
                    const bytes = new Uint8Array(end - start);
                    for (let at = 0; at < bytes.length; at++) bytes[at] = byteAt(start + at);
                    buffers.add(bytes.buffer);
                    return bytes.buffer;
                },
            };
        },
    };
    return { blob, slices, buffers };
}

/** Asserts that `bytes` are the bytes at `at` of a recordingBlob of `(position) % 251`. */
const sameAt = (bytes, at) =>
    assert.deepEqual(
        bytes,
        Uint8Array.from({ length: bytes.length }, (_, index) => (at + index) % 251),
    );

describe('core/io: cached sources', () => {
    describe('the page cache', () => {
        const data = Uint8Array.from({ length: 32 }, (_, i) => i);

        test('a cached range reads synchronously as a copy of its own', async () => {
            const source = countingSource(data);
            const cache = new CachedSource(source, { pageBytes: 8, maxBytes: 16 });
            assert.equal(readCachedSource(cache, 2, 3), undefined);
            await cache.read(2, 3);
            const first = readCachedSource(cache, 2, 3);
            assert.deepEqual(first, Uint8Array.of(2, 3, 4));
            first.fill(99);
            assert.deepEqual(readCachedSource(cache, 2, 3), Uint8Array.of(2, 3, 4));
            assert.equal(source.reads.length, 1);
        });

        test('a range across pages the cache lacks reads nothing synchronously', async () => {
            const cache = new CachedSource(countingSource(data), { pageBytes: 8, maxBytes: 16 });
            await cache.read(2, 3);
            assert.equal(readCachedSource(cache, 7, 2), undefined);
        });

        test('clear() forgets the pages, and a range past the end is cut there', async () => {
            const cache = new CachedSource(countingSource(data), { pageBytes: 8, maxBytes: 16 });
            await cache.read(2, 3);
            cache.clear();
            assert.equal(readCachedSource(cache, 2, 3), undefined);
            await cache.read(31, 4);
            assert.deepEqual(readCachedSource(cache, 31, 4), Uint8Array.of(31));
        });

        test('a negative offset fails with IO', () => {
            const cache = new CachedSource(countingSource(data));
            assert.throws(
                () => readCachedSource(cache, -1, 2),
                error => error.code === 'IO' && /non-negative safe integers/.test(error.message),
            );
        });

        test('an overridden read() is always the one that answers', async () => {
            const cache = new CachedSource(countingSource(data), { pageBytes: 8, maxBytes: 16 });
            await cache.read(2, 3);
            const original = cache.read;
            cache.read = async function (offset, count) {
                return (await original.call(this, offset, count)).fill(80);
            };
            assert.equal(readCachedSource(cache, 2, 3), undefined);
            assert.deepEqual(await cache.read(2, 3), Uint8Array.of(80, 80, 80));
        });

        test('a subclass that reads otherwise is not read from the cache', async () => {
            class CustomCache extends CachedSource {
                async read(offset, count) {
                    return new Uint8Array(count).fill(77);
                }
            }
            assert.equal(readCachedSource(new CustomCache(countingSource(data)), 2, 3), undefined);
        });

        test('a read() patched on the prototype is the one that answers', async () => {
            const intrinsic = CachedSource.prototype.read;
            CachedSource.prototype.read = async function (offset, count) {
                return (await intrinsic.call(this, offset, count)).fill(42);
            };
            try {
                const patched = new CachedSource(countingSource(data));
                await patched.read(0, 8);
                assert.equal(readCachedSource(patched, 0, 2), undefined);
                assert.deepEqual(await patched.read(0, 2), Uint8Array.of(42, 42));
            } finally {
                CachedSource.prototype.read = intrinsic;
            }
        });

        test('a read inside a multi-page read in flight gets its own bytes', async () => {
            const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
            let release;
            const gate = new Promise(resolve => (release = resolve));
            const cache = new CachedSource(
                {
                    size: bytes.length,
                    async read(offset, count) {
                        await gate;
                        return bytes.slice(offset, offset + count);
                    },
                },
                { pageBytes: 16, maxBytes: 256 },
            );
            const reads = Promise.all([cache.read(0, 64), cache.read(40, 8)]);
            release();
            const [whole, inner] = await reads;
            assert.deepEqual(whole, bytes.subarray(0, 64));
            assert.deepEqual(inner, bytes.subarray(40, 48));
        });

        test('a read that starts inside a page fetches every page it reaches at once', async () => {
            const page = 64 * KiB;
            const bytes = Uint8Array.from({ length: 16 * page }, (_, i) => (i * 13) & 255);
            const source = countingSource(bytes);
            const cache = new CachedSource(source);
            const start = 3 * page + 1000;
            const length = 5 * page;
            assert.deepEqual(
                await cache.read(start, length),
                bytes.subarray(start, start + length),
            );
            assert.deepEqual(source.reads, [[3 * page, 6 * page]]);
            assert.deepEqual(
                await cache.read(start + length - 10, 10),
                bytes.subarray(start + length - 10, start + length),
            );
            assert.equal(source.reads.length, 1);
        });

        test('reads of a MiB or more pass the cache by', async () => {
            const cache = new CachedSource({
                size: 64 * MiB,
                read: async (offset, count) => new Uint8Array(count),
            });
            assert.equal((await cache.read(8 * MiB, MiB)).length, MiB);
            assert.equal(cache.cachedBytes, 0);
        });
    });

    describe('Blob reads', () => {
        const fill = position => Math.floor(position / (64 * KiB)) & 255;

        test('a read after a jump fetches a window of 256 KiB', async () => {
            const { blob, slices } = recordingBlob(64 * MiB, fill, 1);
            const source = new BlobSource(blob);
            for (const offset of [0, 20 * MiB, 40 * MiB])
                assert.equal((await source.read(offset, 16))[0], fill(offset));
            assert.deepEqual(
                slices.map(([, length]) => length),
                [256 * KiB, 256 * KiB, 256 * KiB],
            );
        });

        test('reading on from a window fetches twice its read-ahead, up to 4 MiB', async () => {
            const { blob, slices } = recordingBlob(64 * MiB, fill, 1);
            const source = new BlobSource(blob);
            await source.read(40 * MiB, 16);
            for (let offset = 40 * MiB + 256 * KiB, count = 0; count < 5; count++) {
                await source.read(offset, 16);
                offset += slices.at(-1)[1];
            }
            assert.deepEqual(
                slices.slice(1).map(([, length]) => length),
                [512 * KiB, MiB, 2 * MiB, 4 * MiB, 4 * MiB],
            );
        });

        test('a read past the window of a jump fetches only the bytes it lacks', async () => {
            const { blob, slices } = recordingBlob(64 * MiB, fill, 1);
            const source = new BlobSource(blob);
            await source.read(60 * MiB, 16);
            await source.read(60 * MiB + 200 * KiB, 900 * KiB);
            assert.deepEqual(
                slices.map(([, length]) => length),
                [256 * KiB, 844 * KiB],
            );
        });

        test('a pass in whole windows reads the next window ahead, and read() copies', async () => {
            const { blob, slices, buffers } = recordingBlob(16 * MiB, fill, MiB);
            const source = new BlobSource(blob);
            for (let offset = 0; offset <= 6 * MiB; offset += MiB) await source.read(offset, MiB);
            assert.deepEqual(slices.at(-1), [9, 4]);
            const copy = await source.read(6 * MiB + 5, 64 * KiB);
            assert.equal(buffers.has(copy.buffer), false);
            assert.equal(copy[0], fill(6 * MiB));
        });

        test('passes and chunk scans borrow views of the windows read', async () => {
            const { blob, buffers } = recordingBlob(16 * MiB, fill, MiB);
            const pass = borrowedReads(new CachedSource(new BlobSource(blob)));
            for (let offset = 0; offset < blob.size; offset += 256 * KiB) {
                const bytes = await pass.read(offset + 3, 1000);
                assert.equal(buffers.has(bytes.buffer), true);
                assert.equal(bytes[0], fill(offset));
            }
            const chunks = new ChunkReader(new CachedSource(new BlobSource(blob)));
            const chunk = await chunks.bytes(10 * MiB + 7, 16);
            assert.equal(buffers.has(chunk.buffer), true);
            assert.equal(chunk[0], fill(10 * MiB));
        });

        describe('the slice rule', () => {
            const size = 24609735;
            const byteAt = position => position % 251;

            test('the head and the end of a Blob are a slice each, back from the end', async () => {
                const { blob, slices } = recordingBlob(size, byteAt);
                const source = new BlobSource(blob);
                const read = async (at, count) => sameAt(await source.read(at, count), at);
                // As a Matroska probe reads them: the head, the end and the page before it.
                await read(0, 4096);
                await read(24608479, 1256);
                await read(24576000, 33735);
                assert.deepEqual(slices, [
                    [0, 256],
                    [23744, (size - 23744 * KiB) / KiB],
                ]);
            });

            test('reads asked together are one slice, without the bytes held', async () => {
                const { blob, slices } = recordingBlob(size, byteAt);
                const source = new BlobSource(blob);
                const read = async (at, count) => sameAt(await source.read(at, count), at);
                await read(0, 4096);
                await read(24608479, 1256);
                await Promise.all([read(0, MiB), read(MiB, MiB), read(2 * MiB, 256 * KiB)]);
                assert.deepEqual(slices.at(-1), [256, 2048]);
                // The tail read in parts stops where the end window starts.
                await Promise.all([
                    read(22158249, MiB),
                    read(23206825, MiB),
                    read(24255401, size - 24255401),
                ]);
                assert.deepEqual(slices.at(-1), [21632, 23744 - 21632]);
                // The head, the tail and the end are all still held.
                const before = slices.length;
                await read(1000, 2 * MiB);
                await read(23000 * KiB, 1500 * KiB);
                assert.equal(slices.length, before);
            });

            test('a walk over headers 330 KiB apart reads windows doubling to 4 MiB', async () => {
                const { blob, slices } = recordingBlob(60 * MiB, byteAt);
                const walker = new BlobSource(blob);
                for (let at = 0; at + 4096 < 60 * MiB; at += 330 * KiB)
                    sameAt(await walker.read(at, 4096), at);
                assert.deepEqual(
                    slices.slice(0, 6).map(([, length]) => length),
                    [256, 512, 1024, 2048, 4096, 4096],
                );
                assert.equal(slices.length, 18);
            });
        });
    });

    describe('borrowed reads in file order', () => {
        const data = Uint8Array.from({ length: 10 * MiB }, (_, i) => i & 255);
        /** A pass over a cache of `data` whose source reads are recorded in KiB. */
        const passOver = (end, bytes = data) => {
            const requested = [];
            const cache = new CachedSource({
                size: bytes.length,
                async read(offset, count) {
                    requested.push([offset / KiB, count / KiB]);
                    return bytes.slice(offset, offset + count);
                },
            });
            return { pass: borrowedReads(cache, end), requested };
        };

        test('spans double to 1 MiB, the next is read ahead, and a jump starts again', async () => {
            const { pass, requested } = passOver();
            const check = async (offset, length, reads) => {
                assert.deepEqual(
                    await pass.read(offset, length),
                    data.subarray(offset, offset + length),
                );
                assert.deepEqual(requested.splice(0), reads);
            };
            await check(0, 100, [[0, 256]]);
            await check(256 * KiB + 7, 100, [[256, 512]]);
            await check(768 * KiB + 9, 100, [[768, 1024]]);
            await check(1280 * KiB, 100, [[1792, 1024]]);
            await check(1792 * KiB + 5, 100, []);
            await check(2304 * KiB + 5, 100, [[2816, 1024]]);
            await check(7168 * KiB + 1, 10, [[7168, 256]]);
            await check(9216 * KiB, 300000, [[9216, 320]]);
        });

        test('a pass that ends with a window reads nothing past it', async () => {
            const { pass, requested } = passOver(MiB + 1000);
            assert.deepEqual(
                await pass.read(8192 * KiB, 100),
                data.subarray(8192 * KiB, 8192 * KiB + 100),
            );
            requested.length = 0;
            assert.deepEqual(await pass.read(9, 100), data.subarray(9, 109));
            assert.deepEqual(await pass.read(MiB + 7, 100), data.subarray(MiB + 7, MiB + 107));
            assert.deepEqual(requested, [
                [0, 256],
                [1024, 1000 / KiB],
            ]);
            // A read that runs past the end goes through the cache.
            assert.deepEqual(await pass.read(MiB + 990, 20), data.subarray(MiB + 990, MiB + 1010));
            assert.deepEqual(
                requested.map(([offset]) => offset),
                [0, 1024, 1024],
            );
        });

        test('borrows that the spans serve still read the next span ahead', async () => {
            const bytes = Uint8Array.from({ length: 6 * MiB }, (_, i) => (i * 7) & 255);
            const { pass, requested } = passOver(undefined, bytes);
            const settled = () => new Promise(resolve => setImmediate(resolve));
            const offsets = () => requested.map(([offset]) => offset);
            await pass.read(0, 10);
            await pass.read(256 * KiB, 10);
            await pass.read(768 * KiB, 10);
            await settled();
            assert.deepEqual(offsets(), [0, 256, 768]);
            assert.deepEqual(
                pass.borrow(1280 * KiB + 5, 3),
                bytes.subarray(1280 * KiB + 5, 1280 * KiB + 8),
            );
            await settled();
            assert.deepEqual(offsets(), [0, 256, 768, 1792]);
            assert.deepEqual(
                pass.borrow(1792 * KiB, 4),
                bytes.subarray(1792 * KiB, 1792 * KiB + 4),
            );
            assert.deepEqual(
                pass.borrow(2304 * KiB, 4),
                bytes.subarray(2304 * KiB, 2304 * KiB + 4),
            );
            await settled();
            assert.deepEqual(offsets(), [0, 256, 768, 1792, 2816]);
        });
    });

    describe('reads of an opened input', () => {
        test('inspect() of a Blob reads its first window once', async () => {
            const starts = [];
            class CountingBlob extends Blob {
                slice(start, end) {
                    starts.push([start, end]);
                    return super.slice(start, end);
                }
            }
            const info = await inspect(new CountingBlob([classicMp4().bytes]));
            assert.equal(info.format, 'mp4');
            assert.deepEqual(
                starts.filter(([start]) => start === 0),
                [[0, 256 * KiB]],
            );
        });

        test('inspect() and open() of a small Source read it once', async () => {
            const source = countingSource(classicMp4().bytes);
            assert.equal((await inspect(source)).format, 'mp4');
            assert.deepEqual(
                source.reads.splice(0).map(([offset]) => offset),
                [0],
            );
            const media = await open(source);
            media.close();
            assert.deepEqual(
                source.reads.map(([offset]) => offset),
                [0],
            );
        });

        test('a WAV Source of 4 MiB is opened from its first page', async () => {
            const source = countingSource(pcmBenchmarkFixture(MiB));
            assert.equal((await inspect(source)).format, 'wav');
            assert.deepEqual(source.reads.splice(0), [[0, 64 * KiB]]);
            const media = await open(source);
            media.close();
            assert.deepEqual(source.reads, [[0, 64 * KiB]]);
        });
    });
});
