import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { HttpSource, createRetryFetch } from 'mediaforgejs/io';
import { seededRandom, testSignal, waveFile } from '../helpers/pcm.mjs';
import { bounded, deferred, pause } from '../helpers/settle.mjs';

const random = seededRandom(1);
const RESOURCE = Uint8Array.from({ length: 1000 }, () => Math.floor(random() * 256));

/**
 * A local HTTP server answering with `respond(request, response, calls)`, the requests it saw
 * (path, Range, If-Match, Authorization) and its base URL.
 */
async function serve(respond) {
    const calls = [];
    const server = createServer((request, response) => {
        calls.push({
            path: request.url,
            range: request.headers.range,
            match: request.headers['if-match'],
            auth: request.headers.authorization,
        });
        respond(request, response, calls);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        async close() {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

/** Answers a Range request for `bytes` with 206 and `headers`, or the whole with 200. */
function sendRange(request, response, bytes, headers = { ETag: '"stable"' }) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) {
        response.writeHead(200, { 'Content-Length': bytes.length, ...headers });
        response.end(bytes);
        return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Content-Length': end - start + 1,
        ...headers,
    });
    response.end(bytes.subarray(start, end + 1));
}

/** Runs `body` with an HttpSource of a local server's `/resource`, closing both after. */
async function withSource(respond, options, body) {
    const server = await serve(respond);
    let source;
    try {
        source = await HttpSource.open(`${server.base}/resource`, {
            requestTimeoutMs: 5000,
            ...options,
        });
        await body(source, server.calls);
    } finally {
        await source?.close();
        await server.close();
    }
}

/** The byte count each request of `calls` asked for. */
const requested = calls =>
    calls.map(call => {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(call.range);
        return Number(end) - Number(start) + 1;
    });

// Deadlines a test means to pass are a few hundred milliseconds rather than a few: the source
// checks its deadline against the clock before it fetches, so on a loaded machine a 10 ms one can
// expire before the mock fetch is even called. Deadlines a test does not mean to reach are far
// away.
const DEADLINE_MS = 200;
const NEVER_MS = 60000;
const range = (body = Uint8Array.of(7), start = 0, end = 0, size = 2) =>
    new Response(body, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"stable"' },
    });

describe('io', () => {
    describe('HttpSource against a local server', () => {
        test('reads a resource exactly in requests of maxResponseBytes', async () => {
            await withSource(
                (request, response) => sendRange(request, response, RESOURCE),
                { maxResponseBytes: 256 },
                async (source, calls) => {
                    assert.equal(source.size, RESOURCE.length);
                    assert.deepEqual(await source.read(0, RESOURCE.length), RESOURCE);
                    assert.deepEqual(await source.read(300, 20), RESOURCE.subarray(300, 320));
                    assert.equal(calls[0].range, 'bytes=0-0', 'one byte probes the size');
                    assert(requested(calls).every(count => count <= 256));
                    assert.deepEqual(requested(calls.slice(1, 5)), [256, 256, 256, 232]);
                },
            );
        });

        test('calls the global fetch on globalThis, which browsers require', async () => {
            const hostFetch = globalThis.fetch;
            // Browsers throw "Illegal invocation" when fetch runs on another object.
            globalThis.fetch = function (...args) {
                if (this !== globalThis) throw new TypeError('Illegal invocation');
                return hostFetch(...args);
            };
            try {
                await withSource(
                    (request, response) => sendRange(request, response, RESOURCE),
                    {},
                    async source =>
                        assert.deepEqual(await source.read(0, 16), RESOURCE.subarray(0, 16)),
                );
            } finally {
                globalThis.fetch = hostFetch;
            }
        });

        test('retries a 503 with Retry-After through createRetryFetch', async () => {
            const served = new Set();
            await withSource(
                (request, response) => {
                    const identity = `${request.url} ${request.headers.range}`;
                    if (served.has(identity)) return sendRange(request, response, RESOURCE);
                    served.add(identity);
                    response.writeHead(503, { 'Retry-After': '0' });
                    response.end('busy');
                },
                {
                    fetch: createRetryFetch({ maxRetries: 1, baseDelayMs: 0 }),
                    maxResponseBytes: 512,
                },
                async (source, calls) => {
                    assert.deepEqual(await source.read(0, RESOURCE.length), RESOURCE);
                    const attempts = new Map();
                    for (const call of calls)
                        attempts.set(call.range, (attempts.get(call.range) ?? 0) + 1);
                    assert.deepEqual(
                        [...attempts.values()],
                        [2, 2, 2],
                        'each range is asked twice',
                    );
                },
            );
        });

        test("sends the caller's headers on every request", async () => {
            await withSource(
                (request, response) => sendRange(request, response, RESOURCE),
                { headers: { Authorization: 'Bearer test-token' }, maxResponseBytes: 400 },
                async (source, calls) => {
                    await source.read(0, RESOURCE.length);
                    assert(calls.length > 1);
                    assert(calls.every(call => call.auth === 'Bearer test-token'));
                },
            );
        });

        test('sends the strong ETag as If-Match with every range after the probe', async () => {
            await withSource(
                (request, response) => sendRange(request, response, RESOURCE),
                { requireValidator: true, maxResponseBytes: 400 },
                async (source, calls) => {
                    await source.read(0, RESOURCE.length);
                    assert.equal(calls[0].match, undefined);
                    assert(calls.slice(1).every(call => call.match === '"stable"'));
                },
            );
        });

        test('requireValidator refuses a resource without a strong ETag', async () => {
            const server = await serve((request, response) =>
                sendRange(request, response, RESOURCE, { ETag: 'W/"weak"' }),
            );
            try {
                await assert.rejects(
                    HttpSource.open(`${server.base}/resource`, { requireValidator: true }),
                    { code: 'IO', message: /strong ETag/ },
                );
            } finally {
                await server.close();
            }
        });

        test('without a validator it reads and warns HTTP_UNVALIDATED', async () => {
            await withSource(
                (request, response) => sendRange(request, response, RESOURCE, {}),
                {},
                async source => {
                    assert.deepEqual(await source.read(10, 5), RESOURCE.subarray(10, 15));
                    assert.deepEqual(
                        source.warnings.map(warning => warning.code),
                        ['HTTP_UNVALIDATED'],
                    );
                },
            );
        });

        test('a resource that changes between ranges fails as IO from then on', async () => {
            let version = 0;
            await withSource(
                (request, response) =>
                    sendRange(request, response, RESOURCE, { ETag: `"v${version++ < 2 ? 1 : 2}"` }),
                { maxResponseBytes: 400 },
                async source => {
                    await source.read(0, 10);
                    await assert.rejects(source.read(0, RESOURCE.length), {
                        code: 'IO',
                        message: /identity changed/,
                    });
                    await assert.rejects(source.read(0, 1), { code: 'IO' }, 'the failure stays');
                },
            );
        });

        test('a server that ignores Range is read whole only as a buffer', async () => {
            const server = await serve((request, response) => {
                response.writeHead(200, { 'Content-Length': RESOURCE.length });
                response.end(RESOURCE);
            });
            try {
                const url = `${server.base}/resource`;
                await assert.rejects(HttpSource.open(url), {
                    code: 'IO',
                    message: /ignored the Range/,
                });
                await assert.rejects(HttpSource.open(url, { fallback: 'buffer', maxBytes: 999 }), {
                    code: 'OOM',
                });
                const source = await HttpSource.open(url, { fallback: 'buffer', maxBytes: 1000 });
                try {
                    assert.deepEqual(await source.read(0, RESOURCE.length), RESOURCE);
                } finally {
                    await source.close();
                }
            } finally {
                await server.close();
            }
        });

        test('open() reads media from an HttpSource', async () => {
            const wave = waveFile(testSignal(800, 2), 8000, 2);
            await withSource(
                (request, response) => sendRange(request, response, wave),
                { maxResponseBytes: 512 },
                async source => {
                    const media = await open(source);
                    try {
                        assert.deepEqual(
                            media.tracks.map(track => [
                                track.codec,
                                track.sampleRate,
                                track.channelCount,
                            ]),
                            [['pcm-s16le', 8000, 2]],
                        );
                        const { blob } = await media.convert('wav');
                        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), wave);
                    } finally {
                        media.close();
                    }
                },
            );
        });
    });

    describe('HttpSource with a scripted fetch', () => {
        for (const stage of ['headers', 'body', 'buffer'])
            test(`deadline includes ${stage}`, async () => {
                const controller = new AbortController();
                const waiting = deferred();
                let cancelled = 0;
                const body = new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                });
                const response = stage === 'buffer' ? new Response(body) : range(body);
                const pending = HttpSource.open('https://media.test/a', {
                    requestTimeoutMs: DEADLINE_MS,
                    signal: controller.signal,
                    fallback: 'buffer',
                    maxBytes: 2,
                    fetch: () =>
                        stage === 'headers' ? waiting.promise : Promise.resolve(response),
                });
                try {
                    await assert.rejects(
                        bounded(pending),
                        error =>
                            error.code === 'IO' && /timed out|requestTimeoutMs/.test(error.message),
                    );
                    if (stage === 'headers') {
                        waiting.resolve(response);
                        await pause(0);
                    }
                    assert.equal(cancelled, 1);
                    assert.equal(body.locked, false);
                } finally {
                    controller.abort();
                    waiting.resolve(response);
                    await pending.catch(() => {});
                }
            });

        test('rejects repeated empty chunks without starving cancellation', async () => {
            let pulls = 0;
            let cancelled = 0;
            const body = new ReadableStream({
                pull(controller) {
                    if (++pulls <= 4096) controller.enqueue(new Uint8Array(0));
                    else {
                        controller.enqueue(Uint8Array.of(7));
                        controller.close();
                    }
                },
                cancel() {
                    cancelled++;
                },
            });
            await assert.rejects(
                HttpSource.open('https://media.test/a', { fetch: async () => range(body) }),
                error => error.code === 'IO',
            );
            assert(pulls <= 1027);
            assert.equal(cancelled, 1);
        });

        test('rejects a response that blocks past its deadline', async () => {
            await assert.rejects(
                HttpSource.open('https://media.test/a', {
                    requestTimeoutMs: 5,
                    fetch: async () => {
                        const until = performance.now() + 12;
                        while (performance.now() < until) {}
                        return range();
                    },
                }),
                error => error.code === 'IO',
            );
        });

        test('refuses an invalid deadline with INPUT before fetching', async () => {
            for (const requestTimeoutMs of [0, -1, 1.5, Infinity, NaN, null, 0x80000000]) {
                let calls = 0;
                await assert.rejects(
                    HttpSource.open('https://media.test/a', {
                        requestTimeoutMs,
                        fetch: async () => {
                            calls++;
                            return range();
                        },
                    }),
                    error => error.code === 'INPUT',
                );
                assert.equal(calls, 0);
            }
        });

        test('keeps successful range reads and abort behavior', async () => {
            const seen = [];
            const source = await HttpSource.open('https://media.test/a', {
                maxResponseBytes: 1,
                requestTimeoutMs: NEVER_MS,
                fetch: async (_url, init) => {
                    const requested = init.headers.get('Range');
                    seen.push(requested);
                    return requested === 'bytes=1-1' ? range(Uint8Array.of(8), 1, 1) : range();
                },
            });
            assert.deepEqual(await source.read(0, 2), Uint8Array.of(7, 8));
            assert.deepEqual(seen, ['bytes=0-0', 'bytes=0-0', 'bytes=1-1']);
            await source.close();
            await assert.rejects(source.read(0, 1), error => error.code === 'ABORT');
        });

        test('read timeout remains the terminal source error', async () => {
            let requests = 0;
            let cancelled = 0;
            const source = await HttpSource.open('https://media.test/a', {
                requestTimeoutMs: DEADLINE_MS,
                fetch: async () =>
                    ++requests === 1
                        ? range()
                        : range(
                              new ReadableStream({
                                  cancel() {
                                      cancelled++;
                                  },
                              }),
                          ),
            });
            let failure;
            await assert.rejects(bounded(source.read(0, 1)), error => {
                failure = error;
                return error.code === 'IO';
            });
            await assert.rejects(source.read(0, 1), error => error === failure);
            assert.equal(cancelled, 1);
            assert.equal(requests, 2);
        });

        test('yields while consuming many nonempty chunks so timers can abort', async () => {
            const controller = new AbortController();
            let requests = 0;
            let pulls = 0;
            let cancelled = 0;
            const source = await HttpSource.open('https://media.test/a', {
                signal: controller.signal,
                requestTimeoutMs: NEVER_MS,
                fetch: async () =>
                    ++requests === 1
                        ? range(Uint8Array.of(7), 0, 0, 100000)
                        : range(
                              new ReadableStream({
                                  pull(stream) {
                                      if (++pulls <= 100000) stream.enqueue(Uint8Array.of(7));
                                      else stream.close();
                                  },
                                  cancel() {
                                      cancelled++;
                                  },
                              }),
                              0,
                              99999,
                              100000,
                          ),
            });
            const timer = setTimeout(() => controller.abort(), 0);
            try {
                await assert.rejects(
                    bounded(source.read(0, 100000)),
                    error => error.code === 'ABORT',
                );
            } finally {
                clearTimeout(timer);
                await source.close();
            }
            assert(pulls < 100000);
            assert.equal(cancelled, 1);
        });

        for (const cleanup of ['abort', 'deadline', 'invalid-chunk'])
            test(`preserves primary failure during ${cleanup} cleanup`, async () => {
                const controller = new AbortController();
                const response = new Response(
                    new ReadableStream({
                        start(stream) {
                            if (cleanup === 'invalid-chunk') stream.enqueue('invalid bytes');
                        },
                        cancel() {
                            if (cleanup !== 'deadline') controller.abort();
                            else {
                                // The deadline passes while the response is cancelled.
                                const until = performance.now() + 2 * DEADLINE_MS;
                                while (performance.now() < until) {}
                            }
                        },
                    }),
                    cleanup === 'invalid-chunk'
                        ? {
                              status: 206,
                              headers: { 'Content-Range': 'bytes 0-0/2', ETag: '"stable"' },
                          }
                        : { status: 400 },
                );
                await assert.rejects(
                    HttpSource.open('https://media.test/a', {
                        signal: controller.signal,
                        requestTimeoutMs: cleanup === 'deadline' ? DEADLINE_MS : NEVER_MS,
                        fetch: async () => response,
                    }),
                    error =>
                        error.code === 'IO' &&
                        (cleanup === 'invalid-chunk'
                            ? /attached Uint8Array/.test(error.message)
                            : /status 400/.test(error.message)),
                );
            });
    });
});
