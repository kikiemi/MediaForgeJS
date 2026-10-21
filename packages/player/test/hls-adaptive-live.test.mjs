import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

describe('the HLS client: adaptive quality of a live master', () => {
    const master =
        '#EXTM3U\n' +
        '#EXT-X-INDEPENDENT-SEGMENTS\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e"\n' +
        'low.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.42e01e"\n' +
        'high.m3u8\n';
    /** The ISO date `ms` milliseconds after 2026-01-01. */
    const dateOf = ms => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
    function playlist(
        name,
        start,
        count,
        {
            offset = name === 'high' ? 100 : 0,
            date = true,
            dateShift = 0,
            end = false,
            discontinuityAt,
            duration = 2,
        } = {},
    ) {
        const discontinuities = discontinuityAt !== undefined && start > discontinuityAt ? 1 : 0;
        let text =
            '#EXTM3U\n' +
            '#EXT-X-TARGETDURATION:3\n' +
            `#EXT-X-MEDIA-SEQUENCE:${start + offset}\n` +
            `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuities}\n` +
            `#EXT-X-MAP:URI="${name}-init.mp4"\n`;
        for (let i = start; i < start + count; i++) {
            if (i === discontinuityAt) text += '#EXT-X-DISCONTINUITY\n';
            if (date && (i === start || i === discontinuityAt))
                text += `#EXT-X-PROGRAM-DATE-TIME:${dateOf(i * 2000 + dateShift)}\n`;
            text +=
                `#EXTINF:${typeof duration === 'function' ? duration(i) : duration},\n` +
                `${name}-${i}.m4s\n`;
        }
        return text + (end ? '#EXT-X-ENDLIST\n' : '');
    }
    async function runFixture(
        run,
        { lists, slow = 'high-2.m4s', adaptive, options = {}, resource } = {},
    ) {
        const old = globalThis.performance;
        let now = 0;
        const requested = [],
            counts = new Map(),
            changes = [];
        Object.defineProperty(globalThis, 'performance', {
            value: { now: () => now },
            configurable: true,
        });
        const client = new HlsClient({
            refreshIntervalMs: 1,
            adaptive: { upSwitchSegments: 2, onVariantChange: e => changes.push(e), ...adaptive },
            ...options,
            fetch: async (url, init) => {
                const name = new URL(url).pathname.slice(1);
                requested.push(name);
                const count = (counts.get(name) ?? 0) + 1;
                counts.set(name, count);
                if (name === 'master.m3u8') return new Response(master);
                if (name.endsWith('.m3u8'))
                    return new Response(await lists(name.slice(0, -5), count));
                if (resource) {
                    const result = await resource(name, init);
                    if (result) return result;
                }
                if (name.endsWith('-init.mp4'))
                    return new Response(Uint8Array.of(name.startsWith('high') ? 202 : 101));
                const match = /^(low|high)-(\d+)\.m4s$/.exec(name);
                assert(match, name);
                now += name === slow ? 1000 : 25;
                const data = new Uint8Array(12500);
                data[0] = Number(match[2]);
                data[1] = match[1] === 'high' ? 2 : 1;
                return new Response(data);
            },
        });
        try {
            await client.load('https://hls.test/master.m3u8');
            return await run(client, requested, changes, counts);
        } finally {
            client.close();
            Object.defineProperty(globalThis, 'performance', { value: old, configurable: true });
        }
    }
    test(
        'live sliding windows switch low-high-low using PDT with independent media sequence ' +
            'bases',
        async () => {
            await runFixture(
                async (client, requested, changes) => {
                    const output = [];
                    for await (const item of client.segments({ live: true, maxRefreshes: 2 }))
                        output.push(item);
                    assert.deepEqual(
                        output.map(v => v.data[0]),
                        [0, 1, 2, 3, 4, 5, 6],
                    );
                    assert.deepEqual(
                        output.slice(0, 4).map(v => v.data[1]),
                        [1, 1, 2, 1],
                    );
                    assert.deepEqual(
                        output.slice(0, 4).map(v => v.segment.sequence),
                        [0, 1, 102, 3],
                    );
                    assert.deepEqual(
                        output.slice(0, 4).map(v => v.initData?.[0]),
                        [101, undefined, 202, 101],
                    );
                    assert.deepEqual(
                        changes.slice(0, 3).map(e => [e.reason, e.sequence]),
                        [
                            ['initial', 0],
                            ['up', 102],
                            ['down', 3],
                        ],
                    );
                    assert.equal(requested.filter(x => /-\d+\.m4s$/.test(x)).length, 7);
                },
                {
                    lists: (name, count) =>
                        playlist(name, count === 1 ? 0 : 3, count === 1 ? 5 : 4, {
                            end: count > 1,
                            discontinuityAt: 4,
                        }),
                },
            );
        },
    );
    test(
        'a stale desired playlist is refreshed after the active live window ' + 'advances',
        async () => {
            await runFixture(
                async (client, requested, changes, counts) => {
                    const output = [];
                    for await (const item of client.segments({ live: true, maxRefreshes: 1 }))
                        output.push(item);
                    assert.deepEqual(
                        output.map(v => v.data[0]),
                        [0, 1, 2, 3, 4, 5, 6],
                    );
                    assert.deepEqual(
                        output.map(v => v.data[1]),
                        [1, 1, 1, 1, 1, 2, 2],
                    );
                    assert.equal(counts.get('high.m3u8'), 2);
                    assert.equal(changes.at(-1).sequence, 105);
                    assert(client.diagnostics.some(w => w.code === 'HLS_ADAPTIVE_ALIGNMENT'));
                },
                {
                    options: { refreshIntervalMs: 100 },
                    slow: '',
                    lists: (name, count) =>
                        name === 'high' && count === 1
                            ? playlist(name, 0, 2)
                            : playlist(name, count === 1 ? 0 : 3, count === 1 ? 5 : 4, {
                                  end: count > 1,
                              }),
                },
            );
        },
    );
    for (const [label, high, low = {}] of [
        [
            'equal media sequence numbers without timing anchors',
            { offset: 0, date: false },
            { date: false },
        ],
        ['half-segment PDT displacement', { dateShift: 1000 }],
        ['different discontinuity sequences', { discontinuityAt: 0 }],
        ['mismatched segment boundaries', { duration: i => (i === 2 ? 1.5 : 2) }],
    ])
        test(`unsafe live alignment continues current content: ${label}`, async () => {
            await runFixture(
                async client => {
                    const output = [];
                    for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                        output.push(item);
                    assert.deepEqual(
                        output.map(v => [v.data[0], v.data[1]]),
                        [
                            [0, 1],
                            [1, 1],
                            [2, 1],
                            [3, 1],
                            [4, 1],
                        ],
                    );
                    assert(client.diagnostics.some(w => w.code === 'HLS_ADAPTIVE_ALIGNMENT'));
                },
                { lists: name => playlist(name, 0, 5, name === 'high' ? high : low) },
            );
        });
    test('shared discontinuity boundary anchors live switching without PDT', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                    output.push(item);
                assert.deepEqual(
                    output.map(v => v.data[0]),
                    [0, 1, 2, 3, 4],
                );
                assert.deepEqual(
                    output.slice(0, 4).map(v => v.data[1]),
                    [1, 1, 2, 1],
                );
            },
            { lists: name => playlist(name, 0, 5, { date: false, discontinuityAt: 0 }) },
        );
    });
    test('candidate playlist failure leaves the current variant deliverable', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                    output.push(item);
                assert.deepEqual(
                    output.map(v => v.data[0]),
                    [0, 1, 2, 3, 4],
                );
                assert(output.every(v => v.data[1] === 1));
                assert(client.diagnostics.some(w => w.code === 'HLS_ADAPTIVE_UNAVAILABLE'));
            },
            {
                lists: name => {
                    if (name === 'high') throw new Error('offline');
                    return playlist(name, 0, 5);
                },
            },
        );
    });
    test('adaptive live polling respects idle and refresh bounds', async () => {
        await runFixture(
            async (client, requested, changes, counts) => {
                const iterator = client.segments({ live: true, maxIdleRefreshes: 2 });
                await iterator.next();
                await assert.rejects(
                    iterator.next(),
                    e => e.code === 'IO' && /maxIdleRefreshes/.test(e.message),
                );
                assert.equal(counts.get('low.m3u8'), 3);
            },
            { lists: name => playlist(name, 0, 1) },
        );
    });
    test('adaptive parts retains complete-segment fallback for live playlists', async () => {
        await runFixture(
            async (client, requested, changes) => {
                const output = [];
                for await (const unit of client.parts({ live: true, maxRefreshes: 0 }))
                    output.push(unit);
                assert(output.every(unit => unit.type === 'segment'));
                assert.deepEqual(
                    output.map(unit => unit.data[0]),
                    [0, 1, 2, 3, 4],
                );
                assert.deepEqual(
                    output.slice(0, 4).map(unit => unit.data[1]),
                    [1, 1, 2, 1],
                );
                assert(changes.every(event => event.partIndex === undefined));
                assert.equal(requested.filter(path => /-\d+\.m4s$/.test(path)).length, 5);
            },
            { lists: name => playlist(name, 0, 5) },
        );
    });
    test('abort while loading an uncooperative candidate cancels the pending next()', async () => {
        const controller = new AbortController();
        let entered;
        const entering = new Promise(resolve => {
            entered = resolve;
        });
        await runFixture(
            async (client, requested) => {
                const iterator = client.segments({ live: true, signal: controller.signal });
                await iterator.next();
                await iterator.next();
                const pending = iterator.next();
                await entering;
                controller.abort();
                await assert.rejects(pending, e => e.code === 'ABORT');
                assert.deepEqual(
                    requested.filter(x => /-\d+\.m4s$/.test(x)),
                    ['low-0.m4s', 'low-1.m4s'],
                );
            },
            {
                lists: name => {
                    if (name === 'high') {
                        entered();
                        return new Promise(() => {});
                    }
                    return playlist(name, 0, 5);
                },
            },
        );
    });
    test(
        'iterator return cancels a pending variant notification before candidate media ' + 'I/O',
        async () => {
            let entered;
            const entering = new Promise(resolve => {
                entered = resolve;
            });
            await runFixture(
                async (client, requested) => {
                    const iterator = client.segments({ live: true });
                    await iterator.next();
                    await iterator.next();
                    const pending = iterator.next();
                    await entering;
                    const rejection = assert.rejects(pending, e => e.code === 'ABORT');
                    assert.equal((await iterator.return()).done, true);
                    await rejection;
                    assert.deepEqual(
                        requested.filter(x => /-\d+\.m4s$/.test(x)),
                        ['low-0.m4s', 'low-1.m4s'],
                    );
                },
                {
                    adaptive: {
                        onVariantChange: e => {
                            if (e.reason !== 'initial') {
                                entered();
                                return new Promise(() => {});
                            }
                        },
                    },
                    lists: name => playlist(name, 0, 5),
                },
            );
        },
    );
    test('PDT anchors survive removal from an overlapping active playlist refresh', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 1 }))
                    output.push(item);
                assert.deepEqual(
                    output.map(v => v.data[0]),
                    [0, 1, 2, 3, 4, 5, 6],
                );
                assert.deepEqual(
                    output.map(v => v.data[1]),
                    [1, 1, 1, 1, 2, 2, 2],
                );
            },
            {
                adaptive: { upSwitchSegments: 4 },
                slow: '',
                lists: (name, count) =>
                    name === 'high'
                        ? playlist(name, 2, 5, { end: true })
                        : count === 1
                          ? playlist(name, 0, 3)
                          : playlist(name, 2, 5, { date: false, end: true }),
            },
        );
    });
    test('PDT UTC offsets are normalized before comparing matching segment starts', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                    output.push(item);
                assert.deepEqual(
                    output.slice(0, 3).map(v => v.data[1]),
                    [1, 1, 2],
                );
            },
            {
                lists: name =>
                    playlist(name, 0, 5).replace(
                        name === 'high' ? '2026-01-01T00:00:00.000Z' : 'unused',
                        '2026-01-01T09:00:00+09:00',
                    ),
            },
        );
    });
    test('conflicting PDT anchors within a discontinuity interval prevent switching', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                    output.push(item);
                assert(output.every(v => v.data[1] === 1));
            },
            {
                lists: name =>
                    name === 'low'
                        ? playlist(name, 0, 5)
                        : playlist(name, 0, 5).replace(
                              '#EXTINF:2,\nhigh-3',
                              '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10Z\n#EXTINF:2,\nhigh-3',
                          ),
            },
        );
    });
    test('an unavailable VOD upgrade must not interrupt deliverable current content', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments()) output.push(item);
                assert.deepEqual(
                    output.map(v => v.data[0]),
                    [0, 1, 2, 3, 4],
                );
                assert(output.every(v => v.data[1] === 1));
                assert(client.diagnostics.some(w => w.code === 'HLS_ADAPTIVE_UNAVAILABLE'));
            },
            {
                lists: name => {
                    if (name === 'high') throw new Error('candidate offline');
                    return playlist(name, 0, 5, { end: true });
                },
            },
        );
    });
    test(
        'candidate parser warning callback errors retain their exact failure ' + 'identity',
        async () => {
            const failure = new Error('warning callback failure');
            await runFixture(
                async client => {
                    const iterator = client.segments({ live: true });
                    await iterator.next();
                    await iterator.next();
                    await assert.rejects(iterator.next(), e => e === failure);
                },
                {
                    options: {
                        onWarning: () => {
                            throw failure;
                        },
                    },
                    lists: name =>
                        name === 'low'
                            ? playlist(name, 0, 5)
                            : playlist(name, 0, 5).replace('#EXTINF:2,', '#EXTINF:2'),
                },
            );
        },
    );
    test('an ended candidate cannot truncate still-published live content', async () => {
        await runFixture(
            async client => {
                const output = [];
                for await (const item of client.segments({ live: true, maxRefreshes: 0 }))
                    output.push(item);
                assert.deepEqual(
                    output.map(v => v.data[0]),
                    [0, 1, 2, 3, 4],
                );
                assert(output.every(v => v.data[1] === 1));
                assert(client.diagnostics.some(w => w.code === 'HLS_ADAPTIVE_ALIGNMENT'));
            },
            {
                slow: '',
                lists: name => playlist(name, 0, name === 'high' ? 3 : 5, { end: name === 'high' }),
            },
        );
    });
});
