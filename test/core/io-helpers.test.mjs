import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { distUrl } from '../helpers/dist-paths.mjs';

const io = path => import(distUrl(`esm/core/io/${path}.js`));
const abort = await io('abort');
const { createDeadline } = await io('deadline');
const { yieldEventLoop } = await io('event-loop');
const { withOutputLimit } = await io('sinks/output-sink');
const { PatchRecorder, createValidationSink, replayPatches } = await io('sinks/validation-sink');
const { assertSink, drainSink } = await io('sinks/sink-backpressure');
const { assertSourceBytes, sourceReadEnd } = await io('sources/source-read');

describe('io', () => {
    describe('abort signals', () => {
        test('awaitWithAbort passes the value or fails with ABORT when aborted', async () => {
            assert.equal(await abort.awaitWithAbort(Promise.resolve(3)), 3);
            const controller = new AbortController();
            const pending = abort.awaitWithAbort(new Promise(() => undefined), controller.signal);
            controller.abort();
            await assert.rejects(pending, { code: 'ABORT' });
            await assert.rejects(abort.awaitWithAbort(Promise.resolve(1), AbortSignal.abort()), {
                code: 'ABORT',
            });
        });

        test('an abort whose reason is a library error rejects with that error', async () => {
            const reason = new MediaForgeError('response timed out', 'IO');
            const controller = new AbortController();
            const pending = abort.awaitWithAbort(new Promise(() => undefined), controller.signal);
            controller.abort(reason);
            await assert.rejects(pending, error => error === reason);
            await assert.rejects(
                abort.awaitWithAbort(Promise.resolve(1), AbortSignal.abort(reason)),
                error => error === reason,
            );
        });

        test('checkSignal refuses what is not a signal and a fired one', () => {
            abort.checkSignal(undefined);
            abort.checkSignal(new AbortController().signal);
            assert.throws(() => abort.checkSignal({}), { code: 'INPUT' });
            assert.throws(() => abort.checkSignal(AbortSignal.abort()), { code: 'ABORT' });
            assert.equal(
                abort.isOptionalSignal({
                    aborted: false,
                    addEventListener() {},
                    removeEventListener() {},
                }),
                true,
            );
        });

        test('linked signals abort with the first of their sources, and detach', () => {
            const first = new AbortController();
            const second = new AbortController();
            const linked = abort.linkAbortSignals(first.signal, undefined, second.signal);
            second.abort('why');
            assert.deepEqual([linked.signal.aborted, linked.signal.reason], [true, 'why']);
            const detached = abort.linkAbortSignals(first.signal);
            detached.dispose();
            first.abort();
            assert.equal(detached.signal.aborted, false);
            assert.equal(abort.linkAbortSignals(AbortSignal.abort('early')).signal.reason, 'early');
        });
    });

    describe('yielding', () => {
        test('yieldEventLoop waits for a real task, not a timer', async () => {
            const timeout = globalThis.setTimeout;
            let otherWork = false;
            try {
                globalThis.setTimeout = () => {
                    throw new Error('yields must not wait for a timer');
                };
                setImmediate(() => (otherWork = true));
                await yieldEventLoop();
            } finally {
                globalThis.setTimeout = timeout;
            }
            assert.equal(otherWork, true);
        });

        test('yieldEventLoop avoids scheduler.yield, which starves codec callbacks', async () => {
            const scheduler = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
            let used = false;
            Object.defineProperty(globalThis, 'scheduler', {
                configurable: true,
                value: {
                    yield() {
                        used = true;
                        return new Promise(() => undefined);
                    },
                },
            });
            try {
                await yieldEventLoop();
            } finally {
                if (scheduler) Object.defineProperty(globalThis, 'scheduler', scheduler);
                else delete globalThis.scheduler;
            }
            assert.equal(used, false);
        });
    });

    describe('deadlines', () => {
        test('a deadline of zero has passed; a far one has not', () => {
            assert.equal(createDeadline(0)(), true);
            assert.equal(createDeadline(1e9)(), false);
        });
    });

    describe('sink checks', () => {
        test('a sink needs write() and close(); its other members are checked when present', () => {
            assertSink({ write() {}, async close() {} });
            for (const bad of [
                null,
                { write() {} },
                { write() {}, close() {}, drain: 1 },
                { write() {}, close() {}, copiesWrites: 'yes' },
            ])
                assert.throws(() => assertSink(bad), { code: 'INPUT' });
        });

        test('draining waits for the sink, or only checks the signal', async () => {
            let drained = 0;
            await drainSink({ drain: async () => drained++ });
            assert.equal(drained, 1);
            await assert.rejects(
                drainSink({}, AbortSignal.abort()),
                error => error.name === 'AbortError' || error.code === 'ABORT',
            );
        });

        test('an output limit refuses writes past it with OOM, before the sink sees them', () => {
            const target = new MemorySink();
            const limited = withOutputLimit(target, 4);
            limited.write(Uint8Array.of(1, 2, 3));
            assert.throws(() => limited.write(Uint8Array.of(4, 5)), { code: 'OOM' });
            assert.equal(target.size, 3);
            limited.patchAt(0, Uint8Array.of(9));
            assert.deepEqual(target.toUint8Array(), Uint8Array.of(9, 2, 3));
            assert.equal(
                withOutputLimit(target, Number.MAX_SAFE_INTEGER),
                target,
                'no limit, no wrapper',
            );
        });

        test('the validation sink refuses patches outside what was written', async () => {
            const sink = createValidationSink();
            sink.write(Uint8Array.of(1, 2));
            sink.patchAt(1, Uint8Array.of(3));
            assert.throws(() => sink.patchAt(1, Uint8Array.of(3, 4)), { code: 'MUX' });
            await sink.close();
            assert.throws(() => sink.write(Uint8Array.of(1)), {
                code: 'MUX',
                message: /already closed/,
            });
            assert.throws(() => createValidationSink(0), { code: 'INPUT' });
        });
    });

    describe('measured passes', () => {
        test('a replay applies the recorded patches to a forward-only sink', async () => {
            const recorder = new PatchRecorder();
            const write = sink => {
                sink.write(Uint8Array.of(0, 0, 0));
                sink.write(Uint8Array.of(4, 5));
                sink.patchAt(1, Uint8Array.of(8, 9));
            };
            write(recorder);
            const out = new MemorySink();
            const replay = replayPatches(
                { write: bytes => out.write(bytes), close: () => out.close() },
                recorder,
            );
            write(replay);
            await replay.close();
            assert.deepEqual(out.toUint8Array(), Uint8Array.of(0, 8, 9, 4, 5));
        });

        test('a pass that differs from the measured one fails with MUX', async () => {
            const recorder = new PatchRecorder();
            recorder.write(Uint8Array.of(1, 2));
            recorder.patchAt(0, Uint8Array.of(7));
            const replay = replayPatches({ write() {}, async close() {} }, recorder);
            replay.write(Uint8Array.of(1, 2));
            assert.throws(() => replay.patchAt(0, Uint8Array.of(6)), { code: 'MUX' });
            const short = replayPatches({ write() {}, async close() {} }, recorder);
            short.write(Uint8Array.of(1));
            await assert.rejects(short.close(), { code: 'MUX' });
            assert.throws(
                () => replayPatches({ write() {}, close() {} }, recorder).write(new Uint8Array(3)),
                { code: 'MUX' },
            );
        });
    });

    describe('source reads', () => {
        test('a read ends at the size; bad ranges fail with IO', () => {
            assert.equal(sourceReadEnd(5, 10, 8), 8);
            assert.equal(sourceReadEnd(5, 2, 8), 7);
            for (const [offset, length] of [
                [-1, 1],
                [1, -1],
                [0.5, 1],
                [Number.MAX_SAFE_INTEGER, 1],
            ])
                assert.throws(() => sourceReadEnd(offset, length, 8), { code: 'IO' });
        });

        test('a source must return exactly the bytes asked for', () => {
            assertSourceBytes(new Uint8Array(3), 3, 'Test');
            assert.throws(() => assertSourceBytes(new Uint8Array(2), 3, 'Test'), {
                code: 'IO',
                message: /Test read/,
            });
            assert.throws(() => assertSourceBytes(new Int8Array(3), 3, 'Test'), { code: 'IO' });
        });
    });
});
