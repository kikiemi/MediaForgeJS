import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

describe('the HLS client: response bodies', () => {
    const list = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nunit\n#EXT-X-ENDLIST\n';
    async function withBody(body, run, options = {}) {
        const client = new HlsClient({
            ...options,
            fetch: async url =>
                url.endsWith('.m3u8')
                    ? new Response(list)
                    : { ok: true, status: 200, headers: new Headers(), body },
        });
        try {
            await client.load('https://fixture.test/media.m3u8');
            await run(client.parts());
        } finally {
            client.close();
        }
    }
    for (const stage of ['cancel', 'release'])
        test(`cleanup ${stage} preserves the first read failure and releases once`, async () => {
            const failure = new Error('read failed');
            let released = 0;
            let canceled = 0;
            await withBody(
                {
                    getReader() {
                        return {
                            read() {
                                return Promise.reject(failure);
                            },
                            cancel() {
                                canceled++;
                                if (stage === 'cancel') throw new Error('cleanup cancel');
                                return Promise.reject(new Error('cleanup rejection'));
                            },
                            releaseLock() {
                                released++;
                                if (stage === 'release') throw new Error('cleanup release');
                            },
                        };
                    },
                },
                async iterator => {
                    await assert.rejects(iterator.next(), error => error === failure);
                },
            );
            assert.equal(canceled, 1);
            assert.equal(released, 1);
        });
    test('cleanup failure after successful EOF does not discard downloaded bytes', async () => {
        let read = false;
        let released = 0;
        await withBody(
            {
                getReader() {
                    return {
                        async read() {
                            if (read) return { done: true };
                            read = true;
                            return { value: Uint8Array.of(7, 8) };
                        },
                        cancel() {
                            throw new Error('cancel after EOF');
                        },
                        releaseLock() {
                            released++;
                            throw new Error('release after EOF');
                        },
                    };
                },
            },
            async iterator => {
                const result = await iterator.next();
                assert.deepEqual(result.value.data, Uint8Array.of(7, 8));
                await iterator.return();
            },
        );
        assert.equal(released, 1);
    });
    test('late fetch cancellation does not create an unhandled rejection', async () => {
        const unhandled = [];
        const listen = error => unhandled.push(error);
        process.on('unhandledRejection', listen);
        const controller = new AbortController();
        let resolveFetch;
        let started;
        const fetching = new Promise(resolve => {
            started = resolve;
        });
        const client = new HlsClient({
            signal: controller.signal,
            fetch: async url => {
                if (url.endsWith('.m3u8')) return new Response(list);
                started();
                return new Promise(resolve => {
                    resolveFetch = resolve;
                });
            },
        });
        try {
            await client.load('https://fixture.test/media.m3u8');
            const pending = client.parts().next();
            await fetching;
            controller.abort();
            await assert.rejects(pending, error => error.code === 'ABORT');
            resolveFetch({
                body: {
                    cancel() {
                        throw new Error('late cancel');
                    },
                },
            });
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(unhandled, []);
        } finally {
            client.close();
            process.off('unhandledRejection', listen);
        }
    });
    for (const sizes of [[0, 3, 0], [1, 65535, 1, 65536, 2], Array(2048).fill(1)])
        test(`body snapshots reused input across ${sizes.length} chunks`, async () => {
            const shared = new Uint8Array(Math.max(...sizes));
            let index = 0;
            const expected = [];
            await withBody(
                {
                    getReader() {
                        return {
                            async read() {
                                if (index === sizes.length) {
                                    shared.fill(255);
                                    return { done: true };
                                }
                                const size = sizes[index];
                                shared.fill(index & 255);
                                const value = shared.subarray(0, size);
                                expected.push(new Uint8Array(value));
                                index++;
                                return { done: false, value };
                            },
                            cancel() {
                                return Promise.resolve();
                            },
                            releaseLock() {},
                        };
                    },
                },
                async iterator => {
                    const unit = (await iterator.next()).value;
                    assert.deepEqual(unit.data, new Uint8Array(Buffer.concat(expected)));
                    await iterator.return();
                },
            );
        });
    test('body exceeding limit rejects before delivery', async () => {
        let index = 0;
        await withBody(
            {
                getReader() {
                    return {
                        async read() {
                            return { value: new Uint8Array(++index === 1 ? 8 : 1) };
                        },
                        cancel() {
                            return Promise.resolve();
                        },
                        releaseLock() {},
                    };
                },
            },
            async iterator => {
                await assert.rejects(
                    iterator.next(),
                    error => error.code === 'OOM' && /limit/.test(error.message),
                );
            },
            { maxSegmentBytes: 8 },
        );
    });
    test('ready tiny chunks yield so timer-driven abort can stop downloading', async () => {
        const controller = new AbortController();
        let reads = 0;
        let timer;
        await withBody(
            {
                getReader() {
                    return {
                        async read() {
                            return ++reads > 100000 ? { done: true } : { value: Uint8Array.of(1) };
                        },
                        cancel() {
                            return Promise.resolve();
                        },
                        releaseLock() {},
                    };
                },
            },
            async iterator => {
                timer = setTimeout(() => controller.abort(), 0);
                try {
                    await assert.rejects(iterator.next(), error => error.code === 'ABORT');
                } finally {
                    clearTimeout(timer);
                }
            },
            { signal: controller.signal },
        );
        assert(reads < 100000);
    });
    for (const stage of ['cancel', 'release'])
        test(`cleanup ${stage} abort preserves an earlier failure`, async () => {
            const controller = new AbortController();
            const failure = new Error('original read failure');
            let canceled = 0,
                released = 0;
            await withBody(
                {
                    getReader() {
                        return {
                            async read() {
                                throw failure;
                            },
                            cancel() {
                                canceled++;
                                if (stage === 'cancel') controller.abort();
                                return Promise.resolve();
                            },
                            releaseLock() {
                                released++;
                                if (stage === 'release') controller.abort();
                            },
                        };
                    },
                },
                async iterator => {
                    await assert.rejects(iterator.next(), error => error === failure);
                },
                { signal: controller.signal },
            );
            assert.equal(canceled, 1);
            assert.equal(released, 1);
        });
    test('request deadline is checked with fewer than 256 ready chunks', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
        let clock = 0;
        let read = 0;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
        try {
            await withBody(
                {
                    getReader() {
                        return {
                            async read() {
                                clock += 3;
                                return ++read > 4 ? { done: true } : { value: Uint8Array.of(1) };
                            },
                            cancel() {
                                return Promise.resolve();
                            },
                            releaseLock() {},
                        };
                    },
                },
                async iterator => {
                    await assert.rejects(
                        iterator.next(),
                        error => error.code === 'IO' && /requestTimeoutMs/.test(error.message),
                    );
                },
                { requestTimeoutMs: 5 },
            );
            assert(read < 5);
        } finally {
            if (descriptor) Object.defineProperty(performance, 'now', descriptor);
            else delete performance.now;
        }
    });
});
