import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRetryFetch } from 'mediaforgejs/io';
import { bounded, deferred, pause } from '../helpers/settle.mjs';

describe('io', () => {
    describe('createRetryFetch', () => {
        test('retries only selected statuses and cancels discarded bodies', async () => {
            for (const status of [408, 429, 500, 502, 503, 504]) {
                let calls = 0;
                let cancelled = 0;
                const fetcher = createRetryFetch({
                    baseDelayMs: 0,
                    fetch: async () =>
                        ++calls < 3
                            ? new Response(
                                  new ReadableStream({
                                      cancel() {
                                          cancelled++;
                                          throw new Error('cleanup');
                                      },
                                  }),
                                  { status },
                              )
                            : new Response('ready'),
                });
                assert.equal(await (await fetcher('https://media.test/a')).text(), 'ready');
                assert.equal(calls, 3);
                assert.equal(cancelled, 2);
            }
            let calls = 0;
            const fetcher = createRetryFetch({
                baseDelayMs: 0,
                fetch: async () => {
                    calls++;
                    return new Response('missing', { status: 404 });
                },
            });
            assert.equal((await fetcher('https://media.test/a')).status, 404);
            assert.equal(calls, 1);
        });

        test('retries network TypeError but preserves other errors and limits', async () => {
            let calls = 0;
            const failure = new TypeError('network unavailable');
            const fetcher = createRetryFetch({
                maxRetries: 2,
                baseDelayMs: 0,
                fetch: async () => {
                    calls++;
                    throw failure;
                },
            });
            await assert.rejects(fetcher('https://media.test/a'), error => error === failure);
            assert.equal(calls, 3);
            const plain = new Error('application failure');
            calls = 0;
            const once = createRetryFetch({
                baseDelayMs: 0,
                fetch: async () => {
                    calls++;
                    throw plain;
                },
            });
            await assert.rejects(once('https://media.test/a'), error => error === plain);
            assert.equal(calls, 1);
        });

        test('does not replay POST or a GET body', async () => {
            for (const init of [
                { method: 'POST', body: 'challenge' },
                { method: 'GET', body: 'unsupported' },
            ]) {
                let calls = 0;
                const fetcher = createRetryFetch({
                    baseDelayMs: 0,
                    fetch: async () => {
                        calls++;
                        return new Response('busy', { status: 503 });
                    },
                });
                assert.equal((await fetcher('https://media.test/a', init)).status, 503);
                assert.equal(calls, 1);
            }
        });

        test('preserves Request headers credentials method and abort signal', async () => {
            const controller = new AbortController();
            const request = new Request('https://media.test/a', {
                method: 'HEAD',
                headers: { Authorization: 'token', Range: 'bytes=0-1' },
                credentials: 'include',
                signal: controller.signal,
            });
            let calls = 0;
            const options = {
                baseDelayMs: 0,
                fetch(input, init) {
                    assert.equal(this, options);
                    const sent = new Request(input, init);
                    assert.equal(sent.method, 'HEAD');
                    assert.equal(sent.credentials, 'include');
                    assert.equal(sent.headers.get('Authorization'), 'token');
                    assert.equal(sent.headers.get('Range'), 'bytes=0-1');
                    if (++calls === 1) return Promise.resolve(new Response(null, { status: 503 }));
                    return new Promise(() => {});
                },
            };
            const pending = createRetryFetch(options)(request);
            // The abort comes once the retry is in flight.
            for (let wait = 0; calls < 2 && wait < 1000; wait++) await pause(1);
            controller.abort();
            await assert.rejects(
                bounded(pending),
                error => error.name === 'AbortError' || error.code === 'ABORT',
            );
            assert.equal(calls, 2);
        });

        test('honors inherited RequestInit properties without replaying POST', async () => {
            let calls = 0;
            let reads = 0;
            const controller = new AbortController();
            const inherited = {
                get method() {
                    reads++;
                    return 'POST';
                },
                credentials: 'include',
                signal: controller.signal,
                headers: { Authorization: 'inherited' },
            };
            const fetcher = createRetryFetch({
                baseDelayMs: 0,
                fetch: async (_input, init) => {
                    calls++;
                    assert.equal(init.method, 'POST');
                    assert.equal(init.credentials, 'include');
                    assert.equal(init.signal, controller.signal);
                    assert.equal(init.headers.get('Authorization'), 'inherited');
                    return new Response('busy', { status: 503 });
                },
            });
            assert.equal(
                (await fetcher('https://media.test/a', Object.create(inherited))).status,
                503,
            );
            assert.equal(calls, 1);
            assert.equal(reads, 1);
        });

        test('snapshots configuration and request headers across retries', async () => {
            let calls = 0;
            let getterCalls = 0;
            const headers = new Headers({ Authorization: 'original' });
            const options = {
                baseDelayMs: 0,
                get maxRetries() {
                    getterCalls++;
                    return 1;
                },
                fetch: async (_url, init) => {
                    assert.equal(new Headers(init.headers).get('Authorization'), 'original');
                    headers.set('Authorization', 'changed');
                    init.headers.set('Authorization', 'custom-fetch-mutation');
                    return ++calls === 1
                        ? new Response('busy', { status: 503 })
                        : new Response('ok');
                },
            };
            const fetcher = createRetryFetch(options);
            assert.equal(await (await fetcher('https://media.test/a', { headers })).text(), 'ok');
            assert.equal(getterCalls, 1);
            assert.equal(calls, 2);
        });

        test('honors Retry-After and returns response when delay exceeds cap', async () => {
            for (const retryAfter of ['10', new Date(Date.now() + 60000).toUTCString()]) {
                let calls = 0;
                let cancelled = 0;
                const fetcher = createRetryFetch({
                    baseDelayMs: 0,
                    maxDelayMs: 10,
                    fetch: async () => {
                        calls++;
                        return new Response(
                            new ReadableStream({
                                cancel() {
                                    cancelled++;
                                },
                            }),
                            { status: 429, headers: { 'Retry-After': retryAfter } },
                        );
                    },
                });
                const response = await fetcher('https://media.test/a');
                assert.equal(calls, 1);
                assert.equal(cancelled, 0);
                await response.body.cancel();
            }
            let calls = 0;
            const fetcher = createRetryFetch({
                baseDelayMs: 0,
                fetch: async () =>
                    ++calls === 1
                        ? new Response('busy', { status: 503, headers: { 'Retry-After': '0' } })
                        : new Response('ok'),
            });
            assert.equal(await (await fetcher('https://media.test/a')).text(), 'ok');
            assert.equal(calls, 2);
        });

        test('ignores non-HTTP Retry-After dates and accepts HTTP date forms', async () => {
            for (const [retryAfter, attempts] of [
                ['2035-09-24', 2],
                ['2035-09-24T08:49:37Z', 2],
                ['Mon, 24 Sep 2035 08:49:37 GMT', 1],
                ['Monday, 24-Sep-35 08:49:37 GMT', 1],
                ['Mon Sep 24 08:49:37 2035', 1],
            ]) {
                let calls = 0;
                const fetcher = createRetryFetch({
                    baseDelayMs: 0,
                    maxDelayMs: 10,
                    fetch: async () =>
                        ++calls === 1
                            ? new Response('busy', {
                                  status: 503,
                                  headers: { 'Retry-After': retryAfter },
                              })
                            : new Response('ok'),
                });
                await fetcher('https://media.test/a');
                assert.equal(calls, attempts);
            }
        });

        test('preserves immediate native request body ownership', async () => {
            const request = new Request('data:text/plain,ok', {
                method: 'POST',
                body: 'challenge',
            });
            const pending = createRetryFetch({ maxRetries: 0 })(request);
            try {
                assert.equal(request.bodyUsed, true);
            } finally {
                await pending;
            }
        });

        test('aborts hung custom fetch and cancels its late response', async () => {
            const controller = new AbortController();
            const pendingFetch = deferred();
            let cancelled = 0;
            let calls = 0;
            const fetcher = createRetryFetch({
                fetch: () => {
                    calls++;
                    return pendingFetch.promise;
                },
            });
            const pending = fetcher('https://media.test/a', { signal: controller.signal });
            await pause(0);
            controller.abort();
            await assert.rejects(
                bounded(pending),
                error => error.name === 'AbortError' || error.code === 'ABORT',
            );
            pendingFetch.resolve(
                new Response(
                    new ReadableStream({
                        cancel() {
                            cancelled++;
                        },
                    }),
                ),
            );
            await pause(0);
            assert.equal(cancelled, 1);
            assert.equal(calls, 1);
        });

        test('cancels a response when abort races settled headers', async () => {
            for (const depth of [0, 1, 2, 3]) {
                const controller = new AbortController();
                const pendingFetch = deferred();
                let cancelled = 0;
                const pending = createRetryFetch({ fetch: () => pendingFetch.promise })(
                    'https://media.test/a',
                    {
                        signal: controller.signal,
                    },
                );
                await pause(0);
                pendingFetch.resolve(
                    new Response(
                        new ReadableStream({
                            cancel() {
                                cancelled++;
                            },
                        }),
                    ),
                );
                const abortAfter = count =>
                    count ? queueMicrotask(() => abortAfter(count - 1)) : controller.abort();
                abortAfter(depth);
                await assert.rejects(
                    bounded(pending),
                    error => error.name === 'AbortError' || error.code === 'ABORT',
                );
                assert.equal(cancelled, 1);
            }
        });

        test('aborts during backoff and skips pre-aborted requests', async () => {
            const controller = new AbortController();
            let calls = 0;
            let cancelled = 0;
            // The backoff is long enough that no load delays the abort past it: the abort ends it.
            const fetcher = createRetryFetch({
                baseDelayMs: 10000,
                fetch: async () => {
                    calls++;
                    return new Response(
                        new ReadableStream({
                            cancel() {
                                cancelled++;
                            },
                        }),
                        { status: 503 },
                    );
                },
            });
            const pending = fetcher('https://media.test/a', { signal: controller.signal });
            // The 503 body is cancelled as the backoff starts.
            for (let wait = 0; cancelled === 0 && wait < 1000; wait++) await pause(1);
            controller.abort();
            await assert.rejects(
                bounded(pending),
                error => error.name === 'AbortError' || error.code === 'ABORT',
            );
            assert.equal(calls, 1);
            assert.equal(cancelled, 1);
            await assert.rejects(
                fetcher('https://media.test/a', { signal: controller.signal }),
                error => error.name === 'AbortError',
            );
            assert.equal(calls, 1);
        });

        test('does not retry a response body failure', async () => {
            let calls = 0;
            const failure = new TypeError('body failed');
            const fetcher = createRetryFetch({
                baseDelayMs: 0,
                fetch: async () => {
                    calls++;
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(failure);
                            },
                        }),
                    );
                },
            });
            const response = await fetcher('https://media.test/a');
            await assert.rejects(response.arrayBuffer(), error => error === failure);
            assert.equal(calls, 1);
        });

        test('rejects malformed successful callback results without looping', async () => {
            for (const value of [undefined, null, false, 0, {}, { status: 503 }]) {
                const controller = new AbortController();
                let calls = 0;
                const fetcher = createRetryFetch({
                    maxRetries: 0,
                    baseDelayMs: 0,
                    fetch: async () => {
                        calls++;
                        return value;
                    },
                });
                const pending = fetcher('https://media.test/a', { signal: controller.signal });
                try {
                    await assert.rejects(bounded(pending), error => error.code === 'IO');
                } finally {
                    controller.abort();
                    await pending.catch(() => {});
                }
                assert.equal(calls, 1);
            }
        });

        test('refuses bounds and a fetch that are invalid with INPUT', async () => {
            for (const invalid of [
                { maxRetries: -1 },
                { maxRetries: 11 },
                { maxRetries: 1.5 },
                { maxRetries: null },
                { baseDelayMs: -1 },
                { baseDelayMs: NaN },
                { maxDelayMs: 0x80000000 },
                { fetch: null },
            ]) {
                assert.throws(
                    () => createRetryFetch(invalid),
                    error =>
                        error.code === 'INPUT' &&
                        /must be an integer from 0|requires a fetch function/.test(error.message),
                );
            }
        });
    });
});
