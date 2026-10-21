import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCipheriv, webcrypto } from 'node:crypto';
import { HlsClient } from 'mediaforgejs-player';
import { parseHlsPlaylist, serializeHlsPlaylist } from 'mediaforgejs/streaming';

describe('the HLS client: protected resources', () => {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    const key = (uri, format = 'test-xor', method = 'SAMPLE-AES', extra = '') =>
        `#EXT-X-KEY:METHOD=${method},URI="${uri}",KEYFORMAT="${format}"${extra}\n`;
    const media = (body, end = true) =>
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-PART-INF:PART-TARGET=0.5\n' +
        body +
        (end ? '#EXT-X-ENDLIST\n' : '');
    const segment = (uri = 'unit') => `#EXTINF:1,\n${uri}\n`;
    const formats = value => value.keys?.map(item => [item.keyFormat ?? 'identity', item.uri]);
    async function fixture(text, options, run, resources = {}) {
        const requests = [];
        const client = new HlsClient({
            ...options,
            fetch: async (url, init) => {
                requests.push(url);
                const name = new URL(url).pathname.slice(1);
                if (name === 'media.m3u8')
                    return new Response(typeof text === 'function' ? text() : text);
                assert(name in resources, `Unexpected HTTP resource: ${name}`);
                return new Response(resources[name]);
            },
        });
        try {
            await client.load('https://fixture.test/media.m3u8');
            await run(client, requests);
        } finally {
            client.close();
        }
    }
    const collect = async iterator => {
        const units = [];
        for await (const unit of iterator) units.push(unit);
        return units;
    };
    const xorHandler = {
        supports(context) {
            return context.key.keyFormat === 'test-xor';
        },
        async decrypt(request) {
            const bytes = await request.loadKey();
            return request.data.map(value => value ^ bytes[0]);
        },
    };
    test(
        'KEYFORMAT alternatives survive replacement, MAP/PART snapshots, NONE, and ' +
            'serialization',
        () => {
            const text = media(
                key('a') +
                    key('b', 'other') +
                    '#EXT-X-MAP:URI="init"\n#EXT-X-PART:DURATION=0.5,URI="p"\n' +
                    segment('a') +
                    key('new-a') +
                    segment('b') +
                    '#EXT-X-KEY:METHOD=NONE\n' +
                    segment('clear'),
            );
            const parsed = parseHlsPlaylist(text);
            assert.deepEqual(formats(parsed.segments[0]), [
                ['test-xor', 'a'],
                ['other', 'b'],
            ]);
            assert.deepEqual(formats(parsed.segments[0].map), [
                ['test-xor', 'a'],
                ['other', 'b'],
            ]);
            assert.deepEqual(formats(parsed.segments[0].parts[0]), [
                ['test-xor', 'a'],
                ['other', 'b'],
            ]);
            assert.deepEqual(formats(parsed.segments[1]), [
                ['other', 'b'],
                ['test-xor', 'new-a'],
            ]);
            assert.equal(parsed.segments[0].key.uri, 'b');
            assert.equal(parsed.segments[1].key.uri, 'new-a');
            assert.equal(parsed.segments[2].key, undefined);
            assert(!parsed.segments[2].keys?.length);
            const roundtrip = parseHlsPlaylist(serializeHlsPlaylist(parsed));
            assert.deepEqual(roundtrip.segments.map(formats), parsed.segments.map(formats));
            assert.deepEqual(
                roundtrip.segments.map(item => formats(item.map)),
                parsed.segments.map(item => formats(item.map)),
            );
        },
    );
    test('delta inherits all alternatives and replaces only a declared KEYFORMAT', () => {
        const previousPlaylist = parseHlsPlaylist(
            media(key('a') + key('b', 'other') + segment('zero'), false),
        );
        const next = parseHlsPlaylist(
            media(key('new-a') + '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n' + segment('one')),
            {
                previousPlaylist,
            },
        );
        assert.deepEqual(formats(next.segments[1]), [
            ['other', 'b'],
            ['test-xor', 'new-a'],
        ]);
        const clear = parseHlsPlaylist(
            media('#EXT-X-KEY:METHOD=NONE\n#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n' + segment('one')),
            { previousPlaylist },
        );
        assert.equal(clear.segments[1].key, undefined);
    });
    test(
        'active KEYFORMAT alternatives are bounded while replacements and NONE release ' +
            'capacity',
        () => {
            const alternatives = Array.from(
                { length: 64 },
                (_, index) => key(`key${index}`, `format${index}`) + segment(`unit${index}`),
            ).join('');
            const full = parseHlsPlaylist(media(alternatives));
            assert.equal(full.segments.at(-1).keys.length, 64);
            assert.throws(
                () =>
                    parseHlsPlaylist(
                        media(alternatives + key('excess', 'format64') + segment('excess')),
                    ),
                error => error.code === 'OOM' && /KEYFORMAT.*limit/.test(error.message),
            );
            const replaced = parseHlsPlaylist(
                media(
                    alternatives +
                        key('updated', 'format0') +
                        segment('updated') +
                        '#EXT-X-KEY:METHOD=NONE\n' +
                        key('new', 'new-format') +
                        segment('new'),
                ),
            );
            assert.equal(replaced.segments.at(-2).keys.length, 64);
            assert.deepEqual(formats(replaced.segments.at(-1)), [['new-format', 'new']]);
            assert.throws(
                () =>
                    parseHlsPlaylist(
                        media(
                            key('excess', 'format64') +
                                '#EXT-X-SKIP:SKIPPED-SEGMENTS=64\n' +
                                segment('excess'),
                        ),
                        { previousPlaylist: full },
                    ),
                error => error.code === 'OOM' && /KEYFORMAT.*limit/.test(error.message),
            );
        },
    );
    test(
        'refresh rejects a changed alternative even when the legacy key is ' + 'unchanged',
        async () => {
            let refresh = false;
            await fixture(
                () => media(key(refresh ? 'changed' : 'a') + key('b', 'other') + segment(), false),
                {},
                async client => {
                    refresh = true;
                    await assert.rejects(client.refresh(), error => error.code === 'DEMUX');
                },
            );
        },
    );
    test('handler decrypts MAP, PART, and complete segment with key copies', async () => {
        const calls = [];
        const shared = Uint8Array.of(3);
        let loads = 0;
        const handler = {
            ...xorHandler,
            async decrypt(request) {
                calls.push([request.kind, request.sequence, request.partIndex]);
                const first = await request.loadKey();
                first[0] = 99;
                return xorHandler.decrypt(request);
            },
        };
        const text = media(
            key('app:key') +
                '#EXT-X-MAP:URI="init"\n#EXT-X-PART:DURATION=0.5,URI="part"\n' +
                segment('first') +
                segment('second'),
        );
        await fixture(
            text,
            {
                encryptionHandlers: [handler],
                keyLoader: () => {
                    loads++;
                    return shared;
                },
            },
            async client => {
                const units = await collect(client.parts());
                assert.deepEqual(
                    units.map(unit => [...unit.data]),
                    [[4], [5]],
                );
                assert.deepEqual([...units[0].initData], [6]);
                assert.equal(units[1].initData, undefined);
                assert.equal(units[0].encryption, undefined);
            },
            { init: Uint8Array.of(5), part: Uint8Array.of(7), second: Uint8Array.of(6) },
        );
        assert.deepEqual(calls, [
            ['map', 0, undefined],
            ['part', 0, 0],
            ['segment', 1, undefined],
        ]);
        assert.equal(loads, 1);
        assert.deepEqual([...shared], [3]);
    });
    test(
        'handler priority spans alternatives and retained encryption reaches both iterator ' +
            'APIs',
        async () => {
            const seen = [];
            const handlers = ['preferred', 'fallback'].map(format => ({
                supports(context) {
                    seen.push([format, context.key.keyFormat]);
                    return context.key.keyFormat === format;
                },
                decrypt(request) {
                    return request.data;
                },
                retainsEncryption: true,
            }));
            const text = media(key('f', 'fallback') + key('p', 'preferred') + segment());
            await fixture(
                text,
                { encryptionHandlers: handlers },
                async client => {
                    for (const iterator of [client.segments(), client.parts()]) {
                        const units = await collect(iterator);
                        assert.equal(units[0].encryption.uri, 'https://fixture.test/p');
                        assert.deepEqual([...units[0].data], [7]);
                    }
                },
                { unit: Uint8Array.of(7) },
            );
            assert(seen.every(([handler]) => handler === 'preferred'));
        },
    );
    test('handler can select an alternative preceding unsupported legacy metadata', async () => {
        await fixture(
            media(key('app:key') + key('unsupported', 'other') + segment()),
            {
                encryptionHandlers: [xorHandler],
                keyLoader: () => Uint8Array.of(3),
            },
            async client => assert.deepEqual([...(await client.segments().next()).value.data], [4]),
            { unit: Uint8Array.of(7) },
        );
    });
    test(
        'MAP identity includes all alternatives and re-fetches a changed map ' + 'context',
        async () => {
            const text = media(
                key('a') +
                    key('b', 'other') +
                    '#EXT-X-MAP:URI="init"\n' +
                    segment('one') +
                    key('changed') +
                    key('b', 'other') +
                    '#EXT-X-MAP:URI="init"\n' +
                    segment('two'),
            );
            await fixture(
                text,
                {
                    encryptionHandlers: [xorHandler],
                    keyLoader: context =>
                        Uint8Array.of(context.key.uri.endsWith('/changed') ? 2 : 3),
                },
                async (client, requests) => {
                    const units = await collect(client.segments());
                    assert.deepEqual(
                        units.map(unit => [...unit.initData]),
                        [[6], [7]],
                    );
                    assert.equal(requests.filter(uri => uri.endsWith('/init')).length, 2);
                },
                { init: Uint8Array.of(5), one: Uint8Array.of(7), two: Uint8Array.of(7) },
            );
        },
    );
    test(
        'retained map-only encryption is reported and incompatible map/media systems ' + 'reject',
        async () => {
            const retaining = {
                supports: () => true,
                decrypt: request => request.data,
                retainsEncryption: true,
            };
            await fixture(
                media(
                    key('map-key') + '#EXT-X-MAP:URI="init"\n#EXT-X-KEY:METHOD=NONE\n' + segment(),
                ),
                { encryptionHandlers: [retaining] },
                async client => {
                    const unit = (await client.segments().next()).value;
                    assert.equal(unit.encryption.uri, 'https://fixture.test/map-key');
                    assert.deepEqual([...unit.initData], [2]);
                    assert.deepEqual([...unit.data], [3]);
                },
                { init: Uint8Array.of(2), unit: Uint8Array.of(3) },
            );
            await fixture(
                media(
                    key('map-key') +
                        '#EXT-X-MAP:URI="init"\n#EXT-X-KEY:METHOD=NONE\n' +
                        key('media-key', 'different-system') +
                        segment(),
                ),
                { encryptionHandlers: [retaining] },
                async client =>
                    assert.rejects(
                        client.segments().next(),
                        error => error.code === 'FORMAT' && /init map/.test(error.message),
                    ),
                { init: Uint8Array.of(2), unit: Uint8Array.of(3) },
            );
        },
    );
    test('delta MAP declarations inherit the alternatives active at their declaration', () => {
        const previousPlaylist = parseHlsPlaylist(
            media(
                key('a') + key('b', 'other') + '#EXT-X-MAP:URI="old-init"\n' + segment('zero'),
                false,
            ),
        );
        const next = parseHlsPlaylist(
            media(
                key('new-a') +
                    '#EXT-X-MAP:URI="new-init"\n' +
                    key('new-b', 'other') +
                    '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n' +
                    segment('one'),
            ),
            { previousPlaylist },
        );
        assert.deepEqual(formats(next.segments[1].map), [
            ['other', 'b'],
            ['test-xor', 'new-a'],
        ]);
        assert.deepEqual(formats(next.segments[1]), [
            ['test-xor', 'new-a'],
            ['other', 'new-b'],
        ]);
    });
    test('custom application key URI feeds builtin AES-128 fallback', async () => {
        const raw = Buffer.alloc(16, 17);
        const iv = Buffer.alloc(16);
        const cipher = createCipheriv('aes-128-cbc', raw, iv);
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from('expected plaintext')),
            cipher.final(),
        ]);
        await fixture(
            media(key('app:key', 'identity', 'AES-128') + key('drm', 'unknown') + segment()),
            { keyLoader: () => raw },
            async client =>
                assert.equal(
                    new TextDecoder().decode((await client.segments().next()).value.data),
                    'expected plaintext',
                ),
            { unit: ciphertext },
        );
    });
    test('completed raw keys obey LRU capacity and zero disables reuse', async () => {
        for (const [maxCachedKeys, expected] of [
            [2, ['a', 'b', 'c', 'b']],
            [0, ['a', 'b', 'a', 'c', 'a', 'b']],
        ]) {
            const loaded = [];
            const text = media(
                ['a', 'b', 'a', 'c', 'a', 'b']
                    .map((uri, index) => key(uri) + segment(`unit${index}`))
                    .join(''),
            );
            await fixture(
                text,
                {
                    encryptionHandlers: [xorHandler],
                    maxCachedKeys,
                    keyLoader: context => {
                        loaded.push(context.key.uri.split('/').at(-1));
                        return Uint8Array.of(3);
                    },
                },
                async client => assert.equal((await collect(client.segments())).length, 6),
                Object.fromEntries(
                    Array.from({ length: 6 }, (_, index) => [`unit${index}`, Uint8Array.of(7)]),
                ),
            );
            assert.deepEqual(loaded, expected);
        }
    });
    test('disabling the cache permits AES key rotation at the same URI', async () => {
        const rawKeys = [Buffer.alloc(16, 1), Buffer.alloc(16, 2)];
        const resources = {};
        for (let index = 0; index < rawKeys.length; index++) {
            const iv = Buffer.alloc(16);
            iv[15] = index;
            const cipher = createCipheriv('aes-128-cbc', rawKeys[index], iv);
            resources[`unit${index}`] = Buffer.concat([
                cipher.update(Buffer.from([4 + index])),
                cipher.final(),
            ]);
        }
        let loads = 0;
        await fixture(
            media(key('app:key', 'identity', 'AES-128') + segment('unit0') + segment('unit1')),
            { maxCachedKeys: 0, keyLoader: () => rawKeys[loads++] },
            async client => {
                const units = await collect(client.segments());
                assert.deepEqual(
                    units.map(unit => [...unit.data]),
                    [[4], [5]],
                );
            },
            resources,
        );
        assert.equal(loads, 2);
    });
    test(
        'default HTTP key loading is bounded and imported AES keys expire with raw LRU ' +
            'eviction',
        async () => {
            await fixture(
                media(key('key') + segment()),
                { encryptionHandlers: [xorHandler], maxKeyBytes: 2 },
                async client =>
                    assert.rejects(
                        client.parts().next(),
                        error => error.code === 'OOM' && /byte limit/.test(error.message),
                    ),
                { unit: Uint8Array.of(7), key: Uint8Array.of(1, 2, 3) },
            );
            const names = ['a', 'b', 'a'];
            const keys = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
            const resources = {};
            for (let index = 0; index < names.length; index++) {
                const iv = Buffer.alloc(16);
                iv[15] = index;
                const cipher = createCipheriv('aes-128-cbc', keys[index], iv);
                resources[`unit${index}`] = Buffer.concat([
                    cipher.update(Buffer.from([index + 4])),
                    cipher.final(),
                ]);
            }
            let loads = 0;
            await fixture(
                media(
                    names
                        .map(
                            (name, index) =>
                                key(name, 'identity', 'AES-128') + segment(`unit${index}`),
                        )
                        .join(''),
                ),
                { maxCachedKeys: 1, keyLoader: () => keys[loads++] },
                async client =>
                    assert.deepEqual(
                        (await collect(client.segments())).map(unit => [...unit.data]),
                        [[4], [5], [6]],
                    ),
                resources,
            );
            assert.equal(loads, 3);
        },
    );
    test('option and hook getters snapshot once with their original receiver', async () => {
        let supportReads = 0,
            decryptReads = 0,
            retainReads = 0,
            optionReads = 0,
            loaderReads = 0;
        const handler = {
            marker: 4,
            get supports() {
                supportReads++;
                return function (context) {
                    assert.equal(this.marker, 4);
                    return true;
                };
            },
            get decrypt() {
                decryptReads++;
                return async function (request) {
                    assert.equal(this.marker, 4);
                    return await request.loadKey();
                };
            },
            get retainsEncryption() {
                retainReads++;
                return false;
            },
        };
        const options = Object.create({
            marker: 9,
            get encryptionHandlers() {
                optionReads++;
                assert.equal(this.marker, 9);
                return [handler];
            },
            get keyLoader() {
                loaderReads++;
                return function () {
                    assert.equal(this.marker, 9);
                    return Uint8Array.of(6);
                };
            },
        });
        const client = new HlsClient(
            Object.defineProperty(options, 'fetch', {
                value: async url =>
                    new Response(
                        url.endsWith('.m3u8')
                            ? media(key('app:key') + segment())
                            : Uint8Array.of(7),
                    ),
            }),
        );
        try {
            await client.load('https://fixture.test/media.m3u8');
            assert.deepEqual([...(await client.segments().next()).value.data], [6]);
        } finally {
            client.close();
        }
        assert.deepEqual(
            [supportReads, decryptReads, retainReads, optionReads, loaderReads],
            [1, 1, 1, 1, 1],
        );
    });
    test('synchronous key bytes are copied before their owner can reuse the buffer', async () => {
        const shared = Uint8Array.of(3);
        await fixture(
            media(key('app:key') + segment()),
            {
                encryptionHandlers: [xorHandler],
                keyLoader() {
                    queueMicrotask(() => {
                        shared[0] = 0;
                    });
                    return shared;
                },
            },
            async client => assert.deepEqual([...(await client.segments().next()).value.data], [4]),
            { unit: Uint8Array.of(7) },
        );
        assert.equal(shared[0], 0);
    });
    test(
        'handler metadata mutation cannot redirect loadKey or alter playlist ' + 'metadata',
        async () => {
            const handler = {
                supports: () => true,
                async decrypt(request) {
                    request.key.uri = 'app:changed';
                    request.map.key.uri = 'app:map-changed';
                    return request.loadKey();
                },
            };
            await fixture(
                media(key('app:key') + '#EXT-X-MAP:URI="init"\n' + segment()),
                {
                    encryptionHandlers: [handler],
                    keyLoader(context) {
                        assert.equal(context.key.uri, 'app:key');
                        return Uint8Array.of(4);
                    },
                },
                async client => {
                    assert.deepEqual([...(await client.segments().next()).value.data], [4]);
                    assert.equal(client.playlist.segments[0].key.uri, 'app:key');
                    assert.equal(client.playlist.segments[0].map.key.uri, 'app:key');
                },
                { unit: Uint8Array.of(7), init: Uint8Array.of(5) },
            );
        },
    );
    test('invalid new options reject at construction', () => {
        for (const options of [
            { encryptionHandlers: {} },
            { encryptionHandlers: [null] },
            { encryptionHandlers: [{ supports() {}, decrypt: 1 }] },
            { encryptionHandlers: [{ supports() {}, decrypt() {}, retainsEncryption: 'yes' }] },
            { keyLoader: 1 },
            { maxKeyBytes: 0 },
            { maxCachedKeys: -1 },
            { maxCachedKeys: 0.5 },
            { fetch: 1 },
        ]) {
            assert.throws(
                () => new HlsClient(options),
                error => error.code === 'INPUT',
            );
        }
        // A host without fetch is one the client does not run on (FORMAT), unless one is passed.
        const fetch = globalThis.fetch;
        delete globalThis.fetch;
        try {
            assert.throws(() => new HlsClient(), { code: 'FORMAT', message: /no fetch/ });
        } finally {
            globalThis.fetch = fetch;
        }
    });
    // A handler's result of the wrong kind is INPUT, bytes of the wrong type are IO (as a response
    // stream's) and bytes past their limit OOM.
    for (const [name, options, code, message] of [
        [
            'non-boolean supports',
            { encryptionHandlers: [{ supports: () => ({}), decrypt: request => request.data }] },
            'INPUT',
            /supports.*boolean/,
        ],
        [
            'wrong output type',
            { encryptionHandlers: [{ supports: () => true, decrypt: () => new Uint16Array(1) }] },
            'IO',
            /Uint8Array/,
        ],
        [
            'oversized output',
            {
                maxSegmentBytes: 2,
                encryptionHandlers: [{ supports: () => true, decrypt: () => new Uint8Array(3) }],
            },
            'OOM',
            /byte limit/,
        ],
        ['wrong key type', { keyLoader: () => new Uint16Array(1) }, 'IO', /Uint8Array/],
        [
            'oversized key',
            { maxKeyBytes: 2, keyLoader: () => new Uint8Array(3) },
            'OOM',
            /byte limit/,
        ],
    ])
        test(`${name} rejects before delivery`, async () => {
            await fixture(
                media(key('app:key') + segment()),
                { encryptionHandlers: [xorHandler], ...options },
                async client =>
                    assert.rejects(
                        client.segments().next(),
                        error => error.code === code && message.test(error.message),
                    ),
                { unit: Uint8Array.of(7) },
            );
        });
    for (const stage of ['decrypt', 'keyLoader'])
        test(`${stage} deadline and abort release uncooperative promises`, async () => {
            for (const abort of [false, true]) {
                let entered;
                const started = new Promise(resolve => {
                    entered = resolve;
                });
                const controller = new AbortController();
                const never = () => {
                    entered();
                    return new Promise(() => {});
                };
                const options = {
                    encryptionHandlers: [
                        stage === 'decrypt' ? { supports: () => true, decrypt: never } : xorHandler,
                    ],
                    keyLoader: stage === 'keyLoader' ? never : undefined,
                    requestTimeoutMs: abort ? 1000 : 15,
                    signal: controller.signal,
                };
                await fixture(
                    media(key('app:key') + segment()),
                    options,
                    async client => {
                        const pending = client.segments().next();
                        await Promise.race([
                            started,
                            pending.then(() => {
                                throw new Error('unexpected delivery');
                            }),
                        ]);
                        if (abort) controller.abort();
                        await assert.rejects(
                            pending,
                            error => error.code === (abort ? 'ABORT' : 'IO'),
                        );
                    },
                    { unit: Uint8Array.of(7) },
                );
            }
        });
    test('callback rejection preserves the first error without stringifying it', async () => {
        const failure = {
            toString() {
                throw new Error('must not stringify');
            },
        };
        await fixture(
            media(key('app:key') + segment()),
            {
                encryptionHandlers: [
                    { supports: () => true, decrypt: () => Promise.reject(failure) },
                ],
            },
            async client => assert.rejects(client.segments().next(), error => error === failure),
            { unit: Uint8Array.of(7) },
        );
    });
    test('iterator return aborts a waiting hook and late failures remain observed', async () => {
        let entered, rejectLate;
        const started = new Promise(resolve => {
            entered = resolve;
        });
        const unhandled = [];
        const listener = error => unhandled.push(error);
        process.on('unhandledRejection', listener);
        try {
            await fixture(
                media(key('app:key') + segment()),
                {
                    encryptionHandlers: [
                        {
                            supports: () => true,
                            decrypt(request) {
                                entered(request.signal);
                                return new Promise((_resolve, reject) => {
                                    rejectLate = reject;
                                });
                            },
                        },
                    ],
                },
                async client => {
                    const iterator = client.parts();
                    const pending = iterator.next();
                    const signal = await started;
                    const returned = iterator.return();
                    await assert.rejects(pending, error => error.code === 'ABORT');
                    assert.deepEqual(await returned, { done: true, value: undefined });
                    assert.equal(signal.aborted, true);
                    rejectLate(new Error('late'));
                    await new Promise(resolve => setImmediate(resolve));
                    assert.deepEqual(unhandled, []);
                },
                { unit: Uint8Array.of(7) },
            );
        } finally {
            process.off('unhandledRejection', listener);
        }
    });
    test('unknown encryption rejects before fetching or delivering media', async () => {
        await fixture(media(key('unknown') + segment()), {}, async (client, requests) => {
            await assert.rejects(client.segments().next(), error => error.code === 'FORMAT');
            assert.equal(requests.length, 1);
        });
    });
});
