import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { MemorySink, ReadableStreamSink, StreamSink, WritableStreamSink } from 'mediaforgejs/io';

/** A PositionedWriter that records its writes into a growing array. */
function positionedWriter() {
    const bytes = [];
    const writes = [];
    return {
        bytes,
        writes,
        async write({ position, data }) {
            writes.push([position, data.byteLength]);
            new Uint8Array(data).forEach((byte, index) => (bytes[position + index] = byte));
        },
        async close() {
            writes.push('close');
        },
    };
}

describe('io', () => {
    describe('memory sink', () => {
        test('many tiny writes keep the heap bounded', () => {
            // One heap object per write would exhaust a 24 MB heap long before 400000 writes.
            const script = `
                const { MemorySink } = await import('mediaforgejs/io');
                const count = 400000;
                const sink = new MemorySink({ maxBytes: count * 8 });
                const packet = new Uint8Array(8);
                for (let index = 0; index < count; index++) {
                    packet.fill(index & 255);
                    sink.write(packet);
                }
                const output = sink.toUint8Array();
                if (sink.size !== count * 8 || output[8 * 1000] !== (1000 & 255)) process.exit(2);
            `;
            const child = spawnSync(
                process.execPath,
                ['--max-old-space-size=24', '--input-type=module', '-e', script],
                {
                    cwd: new URL('../..', import.meta.url),
                    encoding: 'utf8',
                    timeout: 60000,
                },
            );
            assert.equal(child.status, 0, child.error?.message ?? child.stderr);
        });

        test('writes are snapshots of their bytes, Buffer slices included', async () => {
            const sink = new MemorySink({ maxBytes: 100000 });
            const expected = [];
            for (let index = 0; index < 500; index++) {
                const packet = new Uint8Array(17).fill(index & 255);
                expected.push(...packet);
                sink.write(packet);
                packet.fill(255);
            }
            const backing = Buffer.from([0, 7, 8, 9, 0]);
            sink.write(backing.subarray(1, 4));
            expected.push(7, 8, 9);
            backing.fill(99);
            sink.write(new Uint8Array(0));
            await sink.close();
            assert.equal(sink.size, expected.length);
            assert.deepEqual(sink.toUint8Array(), Uint8Array.from(expected));
            assert.equal(
                sink.toBlob('application/octet-stream').size,
                expected.length,
                'no unused capacity',
            );
        });

        test('patches reach any written byte; returned results stay as they were', async () => {
            const sink = new MemorySink();
            const expected = Array.from({ length: 70000 }, (_, index) => index & 255);
            sink.write(Uint8Array.from(expected));
            const array = sink.toUint8Array();
            const blob = sink.toBlob('video/mp4');
            const patch = Uint8Array.of(10, 11, 12, 13, 14, 15, 16);
            for (const at of [4093, 8189, 16381, 32765, 65533, expected.length - patch.length]) {
                sink.patchAt(at, patch);
                expected.splice(at, patch.length, ...patch);
            }
            sink.patchAt(sink.size, new Uint8Array(0));
            sink.write(Uint8Array.of(31, 32));
            expected.push(31, 32);
            assert.deepEqual(sink.toUint8Array(), Uint8Array.from(expected));
            assert.deepEqual(
                new Uint8Array(await sink.toBlob('test/type').arrayBuffer()),
                Uint8Array.from(expected),
            );
            assert.equal(
                array[4093],
                4093 & 255,
                'an earlier array is independent of later patches',
            );
            assert.equal(
                new Uint8Array(await blob.arrayBuffer())[4093],
                4093 & 255,
                'and an earlier Blob',
            );
        });

        test('patches outside the written bytes fail with IO', () => {
            const sink = new MemorySink();
            sink.write(Uint8Array.of(1, 2));
            assert.throws(() => sink.patchAt(sink.size, Uint8Array.of(1)), { code: 'IO' });
            assert.throws(() => sink.patchAt(-1, new Uint8Array(0)), { code: 'IO' });
        });

        test('maxBytes refuses a write whole with OOM', () => {
            const limited = new MemorySink({ maxBytes: 3 });
            limited.write(Uint8Array.of(1));
            assert.throws(() => limited.write(Uint8Array.of(2, 3, 4)), { code: 'OOM' });
            assert.equal(limited.size, 1, 'nothing of it is appended');
            limited.write(Uint8Array.of(2, 3));
            assert.deepEqual(limited.toUint8Array(), Uint8Array.of(1, 2, 3));
            const empty = new MemorySink({ maxBytes: 0 });
            empty.write(new Uint8Array(0));
            assert.throws(() => empty.write(Uint8Array.of(1)), { code: 'OOM' });
            assert.equal(empty.toBlob('').size, 0);
        });

        test('Blob parts move written bytes out; patches still reach them', async () => {
            const plain = new MemorySink();
            const parted = new MemorySink({ blobPartBytes: 1000 });
            for (let index = 0; index < 300; index++) {
                const bytes = Uint8Array.from({ length: 37 }, (_, at) => (index * 11 + at) & 255);
                plain.write(bytes);
                parted.write(bytes);
            }
            for (const [offset, patch] of [
                [3, Uint8Array.of(1, 2, 3, 4)],
                [995, new Uint8Array(20).fill(7)],
                [11_090, Uint8Array.of(9, 9)],
            ]) {
                plain.patchAt(offset, patch);
                parted.patchAt(offset, patch);
            }
            assert.deepEqual(
                new Uint8Array(await parted.toBlob('video/mp4').arrayBuffer()),
                new Uint8Array(await plain.toBlob('video/mp4').arrayBuffer()),
            );
            assert.equal(parted.toBlob('video/mp4').type, 'video/mp4');
            assert.throws(
                () => parted.toUint8Array(),
                { code: 'IO' },
                'the bytes moved into Blob parts',
            );
            assert.throws(() => new MemorySink({ blobPartBytes: 0 }), { code: 'INPUT' });
        });
    });

    describe('stream sinks', () => {
        test('a StreamSink writes at positions and patches in place', async () => {
            const writer = positionedWriter();
            const sink = new StreamSink(writer);
            sink.write(Uint8Array.of(1, 2, 3));
            sink.write(Uint8Array.of(4, 5));
            sink.patchAt(1, Uint8Array.of(9));
            await sink.close();
            assert.deepEqual(writer.bytes, [1, 9, 3, 4, 5]);
            assert.equal(writer.writes.at(-1), 'close');
        });

        test('a WritableStreamSink delivers its writes in order', async () => {
            const received = [];
            const sink = new WritableStreamSink(
                new WritableStream({ write: chunk => received.push(...chunk) }),
            );
            sink.write(Uint8Array.of(1, 2));
            sink.write(Uint8Array.of(3));
            await sink.close();
            await sink.done;
            assert.deepEqual(received, [1, 2, 3]);
        });

        test("a WritableStreamSink's failure reaches the writer", async () => {
            const sink = new WritableStreamSink(
                new WritableStream({
                    write() {
                        throw new Error('disk full');
                    },
                }),
            );
            sink.write(Uint8Array.of(1));
            await assert.rejects(sink.close(), error =>
                /disk full/.test(error.message ?? String(error)),
            );
        });

        test('a ReadableStreamSink offers its writes as a stream', async () => {
            const sink = new ReadableStreamSink();
            const reading = (async () => {
                const parts = [];
                for await (const part of sink.stream) parts.push(...part);
                return parts;
            })();
            sink.write(Uint8Array.of(5, 6));
            await sink.drain();
            sink.write(Uint8Array.of(7));
            await sink.close();
            assert.deepEqual(await reading, [5, 6, 7]);
        });

        test('a ReadableStreamSink delivers a lone write at once and joins a burst', async () => {
            const sink = new ReadableStreamSink();
            const reader = sink.stream.getReader();
            sink.write(Uint8Array.of(1, 2, 3));
            assert.deepEqual((await reader.read()).value, Uint8Array.of(1, 2, 3));
            // A copy writes one packet at a time, awaiting drain() between them, all in one task.
            const expected = [];
            for (let index = 0; index < 3000; index++) {
                const packet = new Uint8Array(40).fill(index & 255);
                expected.push(...packet);
                sink.write(packet);
                await sink.drain();
                packet.fill(0);
            }
            const closing = sink.close();
            const chunks = [];
            for (let result = await reader.read(); !result.done; result = await reader.read())
                chunks.push(result.value);
            await closing;
            assert.deepEqual(
                new Uint8Array(chunks.flatMap(chunk => [...chunk])),
                Uint8Array.from(expected),
            );
            assert(chunks.length <= 4, `${chunks.length} chunks for 3000 writes`);
            assert(chunks.every(chunk => chunk.byteLength <= 64 * 1024));
        });

        test('cancelling the stream of a ReadableStreamSink aborts its signal', async () => {
            const sink = new ReadableStreamSink();
            await sink.stream.cancel(new Error('reader gone'));
            assert.equal(sink.signal.aborted, true);
        });

        test('a ReadableStreamSink refuses more than maxBytes with OOM', () => {
            const sink = new ReadableStreamSink({ maxBytes: 2 });
            assert.throws(() => sink.write(Uint8Array.of(1, 2, 3)), { code: 'OOM' });
        });
    });
});
