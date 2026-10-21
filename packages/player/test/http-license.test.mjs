import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { MediaForgeError } from 'mediaforgejs';
import { createHttpLicenseCallback } from 'mediaforgejs-player';

describe('the HTTP license callback', () => {
    function request(signal = new AbortController().signal, message = Uint8Array.of(1, 2, 3)) {
        return {
            keySystem: 'org.example.test',
            sessionId: 'session-1',
            messageType: 'license-request',
            signal,
            message,
        };
    }
    function deferred() {
        let resolve;
        const promise = new Promise(yes => {
            resolve = yes;
        });
        return { promise, resolve };
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    async function bounded(promise, timeout = 150) {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve({ pending: true }), timeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    test('HTTP helper snapshots configuration and posts authenticated binary bytes', async () => {
        assert.equal(typeof createHttpLicenseCallback, 'function');
        const headers = new Headers({ Authorization: 'Bearer allowed' });
        const url = new URL('https://license.test/acquire');
        const counts = new Map();
        const options = {};
        const values = {
            url,
            headers,
            credentials: 'include',
            maxResponseBytes: 3,
            timeoutMs: 100,
            async fetch(input, init) {
                assert.equal(this, options);
                assert.equal(input, 'https://license.test/acquire');
                assert.equal(init.method, 'POST');
                assert.equal(init.credentials, 'include');
                assert.equal(init.headers.get('Authorization'), 'Bearer allowed');
                assert.equal(init.headers.get('Content-Type'), 'application/octet-stream');
                assert.deepEqual(init.body, Uint8Array.of(1, 2, 3));
                init.headers.set('Authorization', 'changed by fetch');
                return new Response(Uint8Array.of(4, 5, 6));
            },
        };
        for (const [key, value] of Object.entries(values))
            Object.defineProperty(options, key, {
                get() {
                    assert.equal(this, options);
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                    return value;
                },
            });
        const license = createHttpLicenseCallback(options);
        headers.set('Authorization', 'later');
        url.pathname = '/later';
        const original = request();
        const pending = license(original);
        original.message.fill(0);
        assert.deepEqual(await pending, Uint8Array.of(4, 5, 6));
        assert.deepEqual(await license(request()), Uint8Array.of(4, 5, 6));
        assert.deepEqual(Object.fromEntries(counts), {
            url: 1,
            fetch: 1,
            headers: 1,
            credentials: 1,
            maxResponseBytes: 1,
            timeoutMs: 1,
        });
    });

    test(
        'HTTP helper rejects non-success and unsolicited partial responses before ' + 'reading',
        async () => {
            for (const response of [
                new Response('not allowed', { status: 401 }),
                new Response('partial', { status: 206 }),
                new Response('partial', { headers: { 'Content-Range': 'bytes 0-6/99' } }),
            ]) {
                let cancelled = 0;
                let read = 0;
                const result = {
                    status: response.status,
                    ok: response.ok,
                    headers: response.headers,
                    body: {
                        cancel() {
                            cancelled++;
                            return Promise.reject(new Error('cancel failed'));
                        },
                        getReader() {
                            read++;
                            throw new Error('should not read');
                        },
                    },
                };
                const license = createHttpLicenseCallback({
                    url: 'https://license.test',
                    fetch: async () => result,
                });
                await assert.rejects(license(request()), error => error.code === 'IO');
                assert.equal(cancelled, 1);
                assert.equal(read, 0);
            }
        },
    );

    test('declared and streamed response bounds reject before copying oversized data', async () => {
        for (const headers of [{ 'Content-Length': '5' }, {}]) {
            let cancelled = 0;
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(Uint8Array.of(1, 2, 3, 4, 5));
                },
                cancel() {
                    cancelled++;
                },
            });
            const license = createHttpLicenseCallback({
                url: 'https://license.test',
                maxResponseBytes: 4,
                fetch: async () => new Response(body, { headers }),
            });
            await assert.rejects(license(request()), error => error.code === 'OOM');
            assert.equal(cancelled, 1);
        }
    });

    test('reader chunks are owned before the producer reuses the same byte storage', async () => {
        const shared = Uint8Array.of(1, 2);
        let reads = 0;
        let released = 0;
        const reader = {
            read() {
                reads++;
                if (reads === 1) return Promise.resolve({ done: false, value: shared });
                if (reads === 2) {
                    shared.set([3, 4]);
                    return Promise.resolve({ done: false, value: shared });
                }
                shared.fill(9);
                return Promise.resolve({ done: true });
            },
            cancel() {
                return Promise.resolve();
            },
            releaseLock() {
                released++;
            },
        };
        const license = createHttpLicenseCallback({
            url: 'https://license.test',
            fetch: async () => ({
                status: 200,
                ok: true,
                headers: new Headers(),
                body: {
                    getReader() {
                        return reader;
                    },
                },
            }),
        });
        assert.deepEqual(await license(request()), Uint8Array.of(1, 2, 3, 4));
        assert.equal(released, 1);
    });

    for (const phase of ['fetch', 'body']) {
        for (const reason of ['abort', 'timeout']) {
            test(`HTTP ${reason} bounds an uncooperative ${phase}`, async () => {
                const abort = new AbortController();
                const started = deferred();
                let cancelled = 0;
                let requestSignal;
                const body = {
                    getReader() {
                        return {
                            read() {
                                started.resolve();
                                return new Promise(() => {});
                            },
                            cancel() {
                                cancelled++;
                                return new Promise(() => {});
                            },
                            releaseLock() {},
                        };
                    },
                };
                const license = createHttpLicenseCallback({
                    url: 'https://license.test',
                    timeoutMs: reason === 'timeout' ? 15 : 1000,
                    fetch(_url, init) {
                        requestSignal = init.signal;
                        if (phase === 'fetch') {
                            started.resolve();
                            return new Promise(() => {});
                        }
                        return Promise.resolve({
                            status: 200,
                            ok: true,
                            headers: new Headers(),
                            body,
                        });
                    },
                });
                const pending = license(request(abort.signal)).then(
                    value => ({ value }),
                    error => ({ error }),
                );
                await started.promise;
                if (reason === 'abort') abort.abort();
                const result = await bounded(pending);
                assert.equal(result.error?.code, reason === 'abort' ? 'ABORT' : 'IO');
                assert.equal(requestSignal.aborted, true);
                assert.equal(cancelled, phase === 'body' ? 1 : 0);
            });
        }
    }

    test('a late fetch response is cancelled once after the request was aborted', async () => {
        const abort = new AbortController();
        const fetched = deferred();
        let cancelled = 0;
        const license = createHttpLicenseCallback({
            url: 'https://license.test',
            fetch: () => fetched.promise,
        });
        const pending = license(request(abort.signal));
        await tick();
        abort.abort();
        await assert.rejects(pending, error => error.code === 'ABORT');
        fetched.resolve({
            body: {
                cancel() {
                    cancelled++;
                    throw new Error('cancel failed');
                },
            },
        });
        await tick();
        assert.equal(cancelled, 1);
    });

    test(
        'HTTP helper validates bounds, URL, credentials, challenge, and empty ' + 'responses',
        async () => {
            for (const options of [
                { url: 'file:///license' },
                { url: '/relative' },
                { url: 'https://license.test', maxResponseBytes: 0 },
                { url: 'https://license.test', timeoutMs: 0 },
                { url: 'https://license.test', timeoutMs: 0x80000000 },
                { url: 'https://license.test', credentials: 'invalid' },
                { url: 'https://license.test', fetch: null },
            ]) {
                assert.throws(
                    () => createHttpLicenseCallback(options),
                    error => error.code === 'INPUT',
                );
            }
            const license = createHttpLicenseCallback({
                url: 'https://license.test',
                fetch: async () => new Response(null),
            });
            await assert.rejects(
                license(request(undefined, new Uint8Array())),
                error => error.code === 'IO',
            );
            await assert.rejects(license(request()), error => error.code === 'IO');
        },
    );

    test('HTTP header length mismatch rejects truncated identity responses', async () => {
        const license = createHttpLicenseCallback({
            url: 'https://license.test',
            fetch: async () =>
                new Response(Uint8Array.of(1, 2), { headers: { 'Content-Length': '3' } }),
        });
        await assert.rejects(license(request()), error => error.code === 'IO');
    });

    test('native HTTP POST delivers challenge and authorization to a real server', async () => {
        let received;
        const server = createServer(async (incoming, outgoing) => {
            const parts = [];
            for await (const part of incoming) parts.push(part);
            received = {
                method: incoming.method,
                authorization: incoming.headers.authorization,
                bytes: [...Buffer.concat(parts)],
            };
            outgoing.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': '3',
            });
            outgoing.end(Uint8Array.of(7, 8, 9));
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        try {
            const license = createHttpLicenseCallback({
                url: `http://127.0.0.1:${server.address().port}/license`,
                headers: { Authorization: 'Bearer test-token' },
            });
            assert.deepEqual(await license(request()), Uint8Array.of(7, 8, 9));
            assert.deepEqual(received, {
                method: 'POST',
                authorization: 'Bearer test-token',
                bytes: [1, 2, 3],
            });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('stream values are validated and consumed from one property read', async () => {
        let values = 0;
        let reads = 0;
        const reader = {
            async read() {
                if (++reads > 1) return { done: true };
                return {
                    done: false,
                    get value() {
                        return ++values === 1 ? Uint8Array.of(1, 2) : Uint8Array.of(8, 9);
                    },
                };
            },
            cancel() {},
            releaseLock() {},
        };
        const license = createHttpLicenseCallback({
            url: 'https://license.test',
            fetch: async () => ({
                status: 200,
                ok: true,
                headers: new Headers(),
                body: {
                    getReader() {
                        return reader;
                    },
                },
            }),
        });
        assert.deepEqual(await license(request()), Uint8Array.of(1, 2));
        assert.equal(values, 1);
    });

    for (const phase of ['fetch', 'read']) {
        for (const first of ['throw', 'abort', 'queued-abort']) {
            test(`HTTP ${phase} preserves first observed ${first} failure`, async () => {
                const abort = new AbortController();
                const primary = new MediaForgeError('first network failure', 'IO');
                const trigger = () => {
                    if (first === 'abort') abort.abort(new Error('first abort'));
                    else queueMicrotask(() => abort.abort(new Error('queued abort')));
                    if (first === 'queued-abort') return Promise.reject(primary);
                    throw primary;
                };
                const license = createHttpLicenseCallback({
                    url: 'https://license.test',
                    fetch() {
                        if (phase === 'fetch') return trigger();
                        return {
                            status: 200,
                            ok: true,
                            headers: new Headers(),
                            body: {
                                getReader() {
                                    return {
                                        read: trigger,
                                        cancel() {
                                            throw new Error('cleanup failed');
                                        },
                                        releaseLock() {
                                            throw new Error('release failed');
                                        },
                                    };
                                },
                            },
                        };
                    },
                });
                await assert.rejects(license(request(abort.signal)), error =>
                    first === 'throw' ? error === primary : error.code === 'ABORT',
                );
            });
        }
    }

    for (const phase of ['fetch', 'read']) {
        test(`HTTP ${phase} keeps a rejection observed before a queued abort`, async () => {
            const abort = new AbortController();
            const started = deferred();
            const primary = new MediaForgeError('earlier asynchronous failure', 'IO');
            let reject;
            const rejected = new Promise((_resolve, no) => {
                reject = no;
            });
            const license = createHttpLicenseCallback({
                url: 'https://license.test',
                fetch() {
                    if (phase === 'fetch') {
                        started.resolve();
                        return rejected;
                    }
                    return {
                        status: 200,
                        ok: true,
                        headers: new Headers(),
                        body: {
                            getReader() {
                                return {
                                    read() {
                                        started.resolve();
                                        return rejected;
                                    },
                                    cancel() {},
                                    releaseLock() {},
                                };
                            },
                        },
                    };
                },
            });
            const pending = license(request(abort.signal));
            await started.promise;
            reject(primary);
            queueMicrotask(() => abort.abort(new Error('later abort')));
            await assert.rejects(pending, error => error === primary);
        });
    }

    for (const phase of ['fetch', 'read']) {
        test(`HTTP deadline rejects synchronous ${phase} work that starves its timer`, async () => {
            // The work outlasts the deadline, which is long enough to pass only during it: the
            // callback checks the deadline before it fetches, so a few milliseconds of load could
            // end it before the fetch it means to time.
            const block = () => {
                const end = performance.now() + 400;
                while (performance.now() < end) {}
            };
            let cancelled = 0;
            let reads = 0;
            const license = createHttpLicenseCallback({
                url: 'https://license.test',
                timeoutMs: 200,
                fetch() {
                    if (phase === 'fetch') block();
                    return {
                        status: 200,
                        ok: true,
                        headers: new Headers(),
                        body: {
                            cancel() {
                                cancelled++;
                            },
                            getReader() {
                                return {
                                    read() {
                                        if (++reads > 1) return Promise.resolve({ done: true });
                                        if (phase === 'read') block();
                                        return Promise.resolve({
                                            done: false,
                                            value: Uint8Array.of(7),
                                        });
                                    },
                                    cancel() {
                                        cancelled++;
                                    },
                                    releaseLock() {},
                                };
                            },
                        },
                    };
                },
            });
            await assert.rejects(
                license(request()),
                error => error.code === 'IO' && /timed out/.test(error.message),
            );
            assert.equal(cancelled, 1);
        });
    }
});
