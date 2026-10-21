import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError } from 'mediaforgejs';
import { allPlugins } from 'mediaforgejs/plugins';
import { MemorySink } from 'mediaforgejs/io';
import { movie, toneWav } from '../helpers/api-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';
import { readerPart } from '../helpers/parts.mjs';
// The engine is the feature's own code: what open() returns runs on it.
const { Engine } = await import(distUrl('esm/pipeline/engine.js'));
const { executeWithSink } = await import(distUrl('esm/pipeline/execution.js'));
const { composePlugins } = await import(distUrl('esm/pipeline/plugins/plugin.js'));
const { PLUGIN_CATALOG } = await import(distUrl('esm/plugins/catalog.js'));

// The engine of a composition: the plugins' parts with the core's, the code of the operations that
// loads once, and every operation on an opened input — probe, check, write, toBlob, package —
// with how it reports, delivers warnings and gives up its sink.

const engineOf = (plugins = allPlugins, preference) =>
    new Engine(composePlugins(plugins), PLUGIN_CATALOG, preference);
const inputError = error => error instanceof MediaForgeError && error.code === 'INPUT';

/** A sink that records its bytes and the reason it was aborted with. */
function recordingSink(fail) {
    const memory = new MemorySink();
    const sink = {
        aborted: undefined,
        writes: 0,
        write(data) {
            if (fail && ++sink.writes === fail.at) throw fail.error;
            memory.write(data);
        },
        close: () => memory.close(),
        abort(reason) {
            sink.aborted = reason;
        },
        bytes: () => memory.toUint8Array(),
    };
    return sink;
}

describe('pipeline: the engine', () => {
    describe('composition', () => {
        test("the plugins' readers go ahead of the core's for the same format", async () => {
            const custom = {
                name: 'custom-wav',
                readers: [
                    readerPart({
                        formats: ['wav'],
                        async read() {
                            return {
                                videoTracks: [],
                                audioTracks: [
                                    {
                                        id: 7,
                                        codec: 'pcm-s16le',
                                        sampleRate: 8000,
                                        channelCount: 1,
                                        duration: 0,
                                        samples: [],
                                    },
                                ],
                            };
                        },
                    }),
                ],
            };
            const file = await engineOf([custom]).open(toneWav(), { format: 'wav' });
            try {
                assert.deepEqual(
                    file.tracks.map(track => track.id),
                    [7],
                );
            } finally {
                file.close();
            }
        });

        test("the software video decoders are the core's, then the plugins'", () => {
            const bare = engineOf([]);
            const full = engineOf();
            assert.ok(Object.isFrozen(full.videoDecoders));
            assert.deepEqual(
                full.videoDecoders.slice(0, bare.videoDecoders.length).map(codec => codec.id),
                bare.videoDecoders.map(codec => codec.id),
            );
            assert.ok(full.videoDecoders.length > bare.videoDecoders.length);
            assert.equal(bare.codecPreference, 'webcodecs');
            assert.equal(engineOf([], 'builtin').codecPreference, 'builtin');
        });
    });

    describe('loading the operations', () => {
        test('the conversion runner needs prepare(); every caller shares one load', async () => {
            const engine = engineOf([]);
            assert.throws(() => engine.runner, inputError);
            const first = engine.prepare();
            assert.equal(engine.prepare(), first);
            await first;
            assert.equal(typeof engine.runner.probe, 'function');
            const environment = await engine.timelineEnvironment();
            assert.equal(environment.videoDecoders, engine.videoDecoders);
            assert.equal(environment.codecPreference, engine.codecPreference);
        });
    });

    describe('operations on an opened input', () => {
        const opened = async (engine, input = toneWav()) => engine.open(input);

        test('probe() answers an impossible copy with why; plan() throws the same', async () => {
            const engine = engineOf();
            const file = await opened(engine);
            try {
                // A copy is planned with its writer loaded; before, the answer says so.
                const early = engine.probe(file, { operation: 'remux', format: 'wav' });
                assert.deepEqual([early.supported, early.code], [false, 'FORMAT']);
                assert.match(early.reason, /not loaded/);
                await engine.loadWriter('mp3');
                await engine.loadWriter('wav');
                const request = { operation: 'remux', format: 'mp3' };
                const support = engine.probe(file, request);
                assert.equal(support.supported, false);
                assert.equal(support.code, 'FORMAT');
                assert.doesNotMatch(support.reason, /not loaded/);
                assert.throws(
                    () => engine.plan(file, request),
                    error => error.code === 'FORMAT' && error.message === support.reason,
                );
                const copy = engine.probe(file, { operation: 'remux', format: 'wav' });
                assert.deepEqual(
                    copy.plan.tracks.map(track => track.action),
                    ['copy'],
                );
            } finally {
                file.close();
            }
        });

        test('check() runs the whole operation with no output and no callback', async () => {
            const engine = engineOf();
            const file = await opened(engine);
            try {
                let calls = 0;
                for (const request of [
                    { operation: 'remux', format: 'wav' },
                    { operation: 'convert', format: 'mkv', audioCodec: 'flac' },
                ]) {
                    const support = await engine.check(file, {
                        ...request,
                        onProgress: () => calls++,
                    });
                    assert.equal(support.supported, true, request.format);
                }
                assert.equal(calls, 0);
            } finally {
                file.close();
            }
        });

        test('toBlob() types the output by its format and stops at maxBytes', async () => {
            const engine = engineOf();
            const file = await opened(engine);
            try {
                const blob = await engine.toBlob(file, { operation: 'remux', format: 'wav' });
                assert.equal(blob.type, 'audio/wav');
                await assert.rejects(
                    engine.toBlob(file, { operation: 'remux', format: 'wav' }, { maxBytes: 100 }),
                    error => error instanceof MediaForgeError,
                );
            } finally {
                file.close();
            }
        });

        test('a failing sink is aborted with its failure, which ends the write', async () => {
            const engine = engineOf();
            const file = await opened(engine);
            try {
                const failure = new Error('the disk is full');
                const sink = recordingSink({ at: 2, error: failure });
                await assert.rejects(
                    engine.write(file, sink, { operation: 'convert', format: 'mkv' }),
                    error => error === failure,
                );
                assert.equal(sink.aborted, failure);
            } finally {
                file.close();
            }
        });

        test('package() collects the HLS files by name', async () => {
            const engine = engineOf();
            const file = await opened(engine, movie());
            try {
                const files = await engine.packageToMap(file, {
                    operation: 'package',
                    format: 'hls',
                });
                for (const name of ['master.m3u8', 'index.m3u8', 'init.mp4'])
                    assert.ok(files.has(name), name);
                assert.ok([...files.values()].some(entry => entry.kind === 'segment'));
            } finally {
                file.close();
            }
        });
    });

    describe('running into a sink', () => {
        test('an aborted signal stops the work before it starts and aborts the sink', async () => {
            const sink = recordingSink();
            let ran = false;
            await assert.rejects(
                executeWithSink(sink, [AbortSignal.abort()], async () => {
                    ran = true;
                }),
                error => error.code === 'ABORT',
            );
            assert.equal(ran, false);
            assert.equal(sink.aborted?.code, 'ABORT');
        });

        test("the work's result comes back once the sink has closed", async () => {
            const sink = recordingSink();
            const result = await executeWithSink(sink, [], async output => {
                output.write(Uint8Array.of(1, 2, 3));
                await output.close();
                return 'done';
            });
            assert.equal(result, 'done');
            assert.deepEqual([...sink.bytes()], [1, 2, 3]);
            assert.equal(sink.aborted, undefined);
        });
    });
});
