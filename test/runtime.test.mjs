import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { convert, open, packageMedia } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { FileSource as DenoFileSource } from 'mediaforgejs/runtime/deno';
import { FileSink, FileSource, writePackageToDirectory } from 'mediaforgejs/runtime/node';
import { movie } from './helpers/api-fixtures.mjs';
import { waveFile, waveFormatEx } from './helpers/sync-audio-fixtures.mjs';

// The file sources and sinks of the Node and Deno runtimes, and packages written into a directory.

/** A temporary directory for `run`, removed after it. */
async function inDirectory(run) {
    const directory = await mkdtemp(join(tmpdir(), 'mediaforge-runtime-'));
    try {
        return await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** A file handle double that writes into `file` a task later; `writes` gets each write's size. */
function slowHandle(file, writes = []) {
    return {
        stat: async () => ({ size: 0, isFile: () => true }),
        truncate: async () => {},
        close: async () => {},
        async write(bytes, offset, length, position) {
            await new Promise(resolve => setImmediate(resolve));
            file.set(bytes.subarray(offset, offset + length), position);
            writes.push(length);
            return { bytesWritten: length };
        },
    };
}

for (const [runtime, Source] of [
    ['Node', FileSource],
    ['Deno', DenoFileSource],
])
    describe(`runtime: ${runtime} file sources`, () => {
        test('an aborted signal stops before the file system is touched', async () => {
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                Source.open('missing-file', { signal: controller.signal }),
                error => error.code === 'ABORT',
            );
            await assert.rejects(
                Source.open('missing-file', { signal: {} }),
                error => error.code === 'INPUT',
            );
        });

        test('an abort while reading the size releases the owned handle', async () => {
            const controller = new AbortController();
            let started;
            const ready = new Promise(resolve => (started = resolve));
            let closes = 0;
            const handle = {
                stat() {
                    started();
                    return new Promise(() => {});
                },
                close() {
                    closes++;
                    return Promise.resolve();
                },
            };
            const pending = Source.from(handle, { signal: controller.signal, closeHandle: true });
            await ready;
            controller.abort();
            await assert.rejects(pending, error => error.code === 'ABORT');
            assert.equal(closes, 1);
        });
    });

describe('runtime: Node files', () => {
    test('a file sink keeps patches; a source closes once and then refuses reads', async () => {
        await inDirectory(async directory => {
            const path = join(directory, 'output.bin');
            await writeFile(path, new Uint8Array(32));
            const sink = await FileSink.open(path, { highWaterMark: 8 });
            sink.write(Uint8Array.of(1, 2, 3, 4));
            sink.patchAt(1, Uint8Array.of(9, 8));
            await sink.close();
            await sink.close();
            assert.deepEqual(new Uint8Array(await readFile(path)), Uint8Array.of(1, 9, 8, 4));
            const source = await FileSource.open(path);
            assert.deepEqual(await source.read(1, 2), Uint8Array.of(9, 8));
            await source.close();
            await source.close();
            await assert.rejects(source.read(0, 1), error => error.code === 'ABORT');
        });
    });

    test('a copy written to a file reads back through a file source', async () => {
        await inDirectory(async directory => {
            const path = join(directory, 'copy.mp4');
            await convert(movie(), 'mp4', { copy: true, sink: await FileSink.open(path) });
            const packets = async input => {
                const media = await open(input);
                const sizes = [];
                for await (const packet of media.packets()) sizes.push(packet.data.length);
                media.close();
                return sizes;
            };
            const source = await FileSource.open(path);
            try {
                assert.deepEqual(await packets(source), await packets(movie()));
            } finally {
                await source.close();
            }
        });
    });

    test('small appends arriving while a write is in flight are written together', async () => {
        // A copy writes each packet and awaits drain() after it.
        const file = new Uint8Array(4000 * 100);
        const writes = [];
        const sink = await FileSink.from(slowHandle(file, writes));
        const expected = new Uint8Array(file.length);
        for (let index = 0; index < 4000; index++) {
            const packet = new Uint8Array(100).fill(index & 255);
            expected.set(packet, index * 100);
            sink.write(packet);
            await sink.drain();
            if (index % 50 === 49) await new Promise(resolve => setImmediate(resolve));
        }
        await sink.close();
        assert.deepEqual(file, expected);
        assert.ok(writes.length <= 200, `${writes.length} file writes for 4000 appends`);
        assert.ok(Math.max(...writes) <= 64 * 1024);
    });

    test('each batch is filled before it is written', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const file = new Uint8Array(100 * 2000);
        const writes = [];
        const handle = {
            ...slowHandle(file),
            async write(bytes, offset, length, position) {
                await gate;
                file.set(bytes.subarray(offset, offset + length), position);
                writes.push(length);
                return { bytesWritten: length };
            },
        };
        const sink = await FileSink.from(handle);
        const expected = new Uint8Array(file.length);
        for (let index = 0; index < 2000; index++) {
            const packet = new Uint8Array(100).fill(index & 255);
            expected.set(packet, index * 100);
            sink.write(packet);
        }
        release();
        await sink.close();
        assert.deepEqual(file, expected);
        assert.deepEqual(writes, [65536, 65536, 65536, 200000 - 3 * 65536]);
    });

    test('a copy into a file sink calls drain() only when the sink would wait', async () => {
        const wave = waveFile(
            waveFormatEx(1),
            Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, index) => (index * 31) & 255),
        );
        const input = () => ({
            size: wave.length,
            read: async (offset, length) => wave.slice(offset, offset + length),
        });
        const file = new Uint8Array(wave.length + 4096);
        let length = 0;
        const handle = {
            ...slowHandle(file),
            async write(bytes, offset, count, position) {
                await new Promise(resolve => setImmediate(resolve));
                file.set(bytes.subarray(offset, offset + count), position);
                length = Math.max(length, position + count);
                return { bytesWritten: count };
            },
        };
        const sink = await FileSink.from(handle);
        let drains = 0;
        const drain = sink.drain.bind(sink);
        sink.drain = () => {
            drains++;
            return drain();
        };
        await convert(input(), 'wav', { sink });
        const memory = new MemorySink();
        await convert(input(), 'wav', { sink: memory });
        assert.deepEqual(file.subarray(0, length), memory.toUint8Array());
        const media = await open(input());
        let packets = 0;
        for await (const packet of media.packets()) packets += packet.data.length > 0;
        media.close();
        assert.ok(drains * 4 < packets, `${drains} drain() calls for ${packets} packets`);
    });

    test('bytes queued behind a write reach the file when it ends, without drain()', async () => {
        let written = 0;
        const handle = {
            ...slowHandle(new Uint8Array(64)),
            async write(bytes, offset, length) {
                await new Promise(resolve => setImmediate(resolve));
                written += length;
                return { bytesWritten: length };
            },
        };
        const sink = await FileSink.from(handle);
        sink.write(new Uint8Array(10));
        await sink.drain();
        sink.write(new Uint8Array(20));
        await sink.drain();
        for (let turn = 0; turn < 10 && written < 30; turn++)
            await new Promise(resolve => setImmediate(resolve));
        assert.equal(written, 30);
        await sink.close();
    });

    test(
        'an abort does not wait for a close held up by pending I/O',
        { timeout: 10_000 },
        async () => {
            const controller = new AbortController();
            let release;
            const closing = new Promise(resolve => (release = resolve));
            let started;
            const ready = new Promise(resolve => (started = resolve));
            let closes = 0;
            const source = FileSource.from(
                {
                    stat() {
                        started();
                        return new Promise(() => {});
                    },
                    close() {
                        closes++;
                        return closing;
                    },
                },
                { signal: controller.signal, closeHandle: true },
            );
            await ready;
            controller.abort();
            try {
                // The close is still pending: the abort settles without it.
                await assert.rejects(source, error => error.code === 'ABORT');
                assert.equal(closes, 1);
            } finally {
                release();
            }
        },
    );
});

describe('runtime: packages in a directory', () => {
    const tsPackage = async () =>
        (await packageMedia(movie(), 'hls', { container: 'ts', targetDuration: 0.16 })).files;

    test('every file of a package is written by its name', async () => {
        const files = [...(await tsPackage()).values()];
        await inDirectory(async directory => {
            const result = await writePackageToDirectory(files, directory);
            assert.equal(result.files.length, files.length);
            assert.equal(
                result.bytesWritten,
                files.reduce((sum, file) => sum + file.data.length, 0),
            );
            assert.deepEqual(
                (await readdir(directory)).sort(),
                files.map(file => file.name).sort(),
            );
            const segment = files.find(file => file.name.endsWith('.ts'));
            assert.deepEqual(
                new Uint8Array(await readFile(join(directory, segment.name))),
                segment.data,
            );
        });
    });

    test('an existing file fails with IO unless overwrite is set', async () => {
        const files = [...(await tsPackage()).values()];
        await inDirectory(async directory => {
            await writePackageToDirectory(files, directory);
            await assert.rejects(
                writePackageToDirectory(files, directory),
                error => error.code === 'IO',
            );
            const again = await writePackageToDirectory(files, directory, { overwrite: true });
            assert.equal(again.files.length, files.length);
        });
    });

    test('a name that leaves the directory or enters another fails with IO', async () => {
        await inDirectory(async directory => {
            for (const name of ['../escape.m3u8', 'a/b.m3u8'])
                await assert.rejects(
                    writePackageToDirectory([{ name, data: new Uint8Array(1) }], directory),
                    error => error.code === 'IO',
                    name,
                );
        });
    });
});
