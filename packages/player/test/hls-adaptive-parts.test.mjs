import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

describe('the HLS client: adaptive switches of partial segments', () => {
    const master =
        '#EXTM3U\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e"\n' +
        'low.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.42e01e"\n' +
        'high.m3u8\n';
    function list(
        name,
        {
            start = 0,
            groups = 1,
            count = 4,
            trailing = true,
            end = false,
            date = true,
            shift = 0,
            discontinuity = false,
            independent = () => true,
            split = false,
            range = false,
            omitParts = false,
            delta = 0,
            key = false,
            noMap = false,
        } = {},
    ) {
        let text =
            '#EXTM3U\n' +
            '#EXT-X-TARGETDURATION:2\n' +
            '#EXT-X-PART-INF:PART-TARGET=0.5\n' +
            `#EXT-X-MEDIA-SEQUENCE:${start + (name === 'high' ? 100 : 0)}\n`;
        if (!noMap) text += `#EXT-X-MAP:URI="${name}-init.mp4"\n`;
        if (key) text += '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n';
        if (delta) text += `#EXT-X-SKIP:SKIPPED-SEGMENTS=${delta}\n`;
        for (let group = start + delta; group < start + groups; group++) {
            if (discontinuity && group === start) text += '#EXT-X-DISCONTINUITY\n';
            if (date && group === start + delta) {
                const programDate = new Date(Date.UTC(2026, 0, 1) + group * 2000 + shift);
                text += `#EXT-X-PROGRAM-DATE-TIME:${programDate.toISOString()}\n`;
            }
            const n = group === start + groups - 1 ? count : 4;
            let offset = 0;
            if (!omitParts)
                for (let part = 0; part < n; part++) {
                    const durations = split && part === 0 ? [0.25, 0.25] : [0.5];
                    for (const duration of durations) {
                        const suffix = durations.length > 1 ? `-${offset}` : '';
                        const uri = `${name}-${group}-${part}${suffix}.m4s`;
                        const flag = independent(group, part) ? 'YES' : 'NO';
                        const byteRange = range ? `,BYTERANGE="12500@${offset}"` : '';
                        text +=
                            `#EXT-X-PART:DURATION=${duration},URI="${uri}",INDEPENDENT=${flag}` +
                            `${byteRange}\n`;
                        offset += 12500;
                    }
                }
            if (!trailing || group < start + groups - 1)
                text += `#EXTINF:2,\n${name}-${group}.m4s\n`;
        }
        return text + (end ? '#EXT-X-ENDLIST\n' : '');
    }
    async function fixture(
        run,
        {
            lists = name => list(name),
            adaptive = {},
            slow = '',
            options = {},
            resource,
            masterText = master,
        } = {},
    ) {
        const old = globalThis.performance;
        let now = 0;
        const requested = [],
            changes = [],
            counts = new Map();
        Object.defineProperty(globalThis, 'performance', {
            value: { now: () => now },
            configurable: true,
        });
        const client = new HlsClient({
            adaptive: {
                upSwitchSegments: 1,
                onVariantChange: event => changes.push(event),
                ...adaptive,
            },
            refreshIntervalMs: 1,
            ...options,
            fetch: async (url, init) => {
                const name = new URL(url).pathname.slice(1);
                requested.push(name);
                const count = (counts.get(name) ?? 0) + 1;
                counts.set(name, count);
                if (name === 'master.m3u8') return new Response(masterText);
                if (name.endsWith('.m3u8'))
                    return new Response(await lists(name.slice(0, -5), count));
                if (resource) {
                    const response = await resource(name, init);
                    if (response) return response;
                }
                if (name.endsWith('-init.mp4'))
                    return new Response(Uint8Array.of(name.startsWith('high') ? 202 : 101));
                const match = /^(low|high)-(\d+)(?:-(\d+))?/.exec(name);
                assert(match, name);
                now += name === slow ? 2000 : 25;
                const bytes = new Uint8Array(12500);
                bytes[0] = +match[2] * 4 + +(match[3] ?? 0);
                bytes[1] = match[1] === 'high' ? 2 : 1;
                const range = init.headers?.Range;
                if (range) {
                    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
                    return new Response(bytes, {
                        status: 206,
                        headers: { 'Content-Range': `bytes ${a}-${b}/1000000` },
                    });
                }
                return new Response(bytes);
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
    async function collect(client, options) {
        const out = [];
        for await (const unit of client.parts(options)) out.push(unit);
        return out;
    }
    test(
        'published PARTs switch low-high-low within a parent and expose exact source ' +
            'boundary/init data',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(x => [x.data[0], x.data[1], x.sequence, x.partIndex]),
                        [
                            [0, 1, 0, 0],
                            [1, 2, 100, 1],
                            [2, 1, 0, 2],
                            [3, 2, 100, 3],
                        ],
                    );
                    assert.deepEqual(
                        out.map(x => x.initData?.[0]),
                        [101, 202, 101, 202],
                    );
                    assert.deepEqual(
                        out.map(x => x.variant.bandwidth),
                        [100000, 400000, 100000, 400000],
                    );
                    assert.deepEqual(
                        changes.map(x => [x.reason, x.sequence, x.partIndex]),
                        [
                            ['initial', 0, 0],
                            ['up', 100, 1],
                            ['down', 0, 2],
                            ['up', 100, 3],
                        ],
                    );
                    assert.equal(requests.filter(x => /-\d+-\d+/.test(x)).length, 4);
                },
                { slow: 'high-0-1.m4s' },
            );
        },
    );
    test(
        'alignment uses accumulated duration, allowing different cross-variant PART ' + 'indices',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3],
                    );
                    assert.deepEqual(
                        out.map(x => x.partIndex),
                        [0, 2, 3, 4],
                    );
                    assert.equal(changes[1].partIndex, 2);
                },
                { lists: name => list(name, { split: name === 'high' }) },
            );
        },
    );
    for (const [label, high, low = {}] of [
        ['no timeline anchors', { date: false }, { date: false }],
        ['different PDT', { shift: 250 }],
        ['different discontinuity', { discontinuity: true }],
        ['no independent target', { independent: () => false }],
        ['short ENDLIST', { count: 2, end: true }],
        ['unsupported encryption target', { key: true }],
    ])
        test(`unsafe PART candidates remain on current variant: ${label}`, async () => {
            await fixture(
                async client => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3],
                    );
                    assert(out.every(x => x.data[1] === 1));
                },
                { lists: name => list(name, name === 'high' ? high : low) },
            );
        });
    test(
        'a non-independent boundary does not suppress a later independent boundary in the same ' +
            'snapshot',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(x => x.data[1]),
                        [1, 1, 2, 2],
                    );
                    assert.equal(changes[1].partIndex, 2);
                },
                { lists: name => list(name, { independent: (g, p) => name === 'low' || p === 2 }) },
            );
        },
    );
    test('shared discontinuity anchors support PART switching without dates', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert.deepEqual(
                    out.map(x => x.data[1]),
                    [1, 2, 2, 2],
                );
            },
            { lists: name => list(name, { date: false, discontinuity: true }) },
        );
    });
    test(
        'published trailing PARTs complete across refresh and delta windows without duplicate ' +
            'complete segments',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const out = await collect(client, { live: true, maxRefreshes: 2 });
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3, 4, 5, 6, 7],
                    );
                    assert.equal(out.length, 8);
                    assert(!requests.includes('high-0.m4s'));
                },
                {
                    lists: (name, count) =>
                        list(
                            name,
                            count === 1
                                ? { count: 2 }
                                : {
                                      groups: 2,
                                      count: 4,
                                      trailing: false,
                                      end: true,
                                      delta: name === 'high' ? 0 : 0,
                                  },
                        ),
                },
            );
        },
    );
    test(
        'candidate stale snapshot is refreshed on live generation and retained parent anchor ' +
            'survives date removal',
        async () => {
            await fixture(
                async (client, requests, changes, counts) => {
                    const out = await collect(client, { live: true, maxRefreshes: 2 });
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3],
                    );
                    assert.equal(out[2].data[1], 2);
                    assert(counts.get('high.m3u8') >= 2);
                },
                {
                    options: { refreshIntervalMs: 10 },
                    lists: (name, count) =>
                        list(name, {
                            count: count === 1 ? 2 : 4,
                            date: count === 1,
                            end: count > 1,
                        }),
                },
            );
        },
    );
    test(
        'completed parent replacing consumed PART tags does not redownload its full ' + 'media',
        async () => {
            await fixture(
                async (client, requests) => {
                    const out = await collect(client, { live: true, maxRefreshes: 1 });
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3],
                    );
                    assert(!requests.some(x => /^(low|high)-0\.m4s/.test(x)));
                },
                {
                    lists: (name, count) =>
                        list(
                            name,
                            count === 1 ? {} : { omitParts: true, trailing: false, end: true },
                        ),
                },
            );
        },
    );
    test('missing remaining PARTs are diagnosed without duplicate complete bytes', async () => {
        await fixture(
            async (client, requests) => {
                const out = await collect(client, { live: true, maxRefreshes: 1 });
                assert.deepEqual(
                    out.map(x => x.data[0]),
                    [0, 1],
                );
                assert(client.diagnostics.some(x => x.code === 'HLS_PART_WINDOW'));
            },
            {
                lists: (name, count) =>
                    list(
                        name,
                        count === 1
                            ? { count: 2 }
                            : { omitParts: true, trailing: false, end: true },
                    ),
            },
        );
    });
    test(
        'byte-range PART requests survive switching and use each selected variant ' + 'range',
        async () => {
            await fixture(
                async client => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3],
                    );
                    assert(out.every(x => x.data.length === 12500));
                },
                { lists: name => list(name, { range: true }) },
            );
        },
    );
    test(
        'startSequence is local to initially selected variant and initial notification reports ' +
            'its PART',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const out = await collect(client, { startSequence: 1 });
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [4, 5, 6, 7],
                    );
                    assert.deepEqual([changes[0].sequence, changes[0].partIndex], [1, 0]);
                },
                { lists: name => list(name, { groups: 2 }) },
            );
        },
    );
    test('candidate fetch failure preserves current PART delivery', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert(out.every(x => x.data[1] === 1));
                assert.equal(out.length, 4);
                assert(client.diagnostics.some(x => x.code === 'HLS_ADAPTIVE_UNAVAILABLE'));
            },
            {
                lists: name => {
                    if (name === 'high') throw Error('offline');
                    return list(name);
                },
            },
        );
    });
    for (const failedResource of ['map', 'part'])
        test(
            `candidate ${failedResource} failure preserves current PARTs and ` + `initialization`,
            async () => {
                await fixture(
                    async (client, requests, changes) => {
                        const out = await collect(client);
                        assert.deepEqual(
                            out.map(unit => [unit.data[0], unit.data[1]]),
                            [
                                [0, 1],
                                [1, 1],
                                [2, 1],
                                [3, 1],
                            ],
                        );
                        assert.deepEqual(
                            out.map(unit => unit.initData?.[0]),
                            [101, undefined, undefined, undefined],
                        );
                        assert.deepEqual(
                            changes.map(event => event.reason),
                            ['initial'],
                        );
                        assert(
                            client.diagnostics.some(
                                warning => warning.code === 'HLS_ADAPTIVE_UNAVAILABLE',
                            ),
                        );
                    },
                    {
                        resource: name =>
                            name.startsWith('high-') &&
                            (failedResource === 'map'
                                ? name.endsWith('-init.mp4')
                                : name.endsWith('.m4s'))
                                ? new Response(null, { status: 404 })
                                : undefined,
                    },
                );
            },
        );
    for (const options of [{}, { live: true, maxRefreshes: 0 }])
        test(
            'PART iteration without refreshes retains all media when the candidate is behind: ' +
                `${JSON.stringify(options)}`,
            async () => {
                await fixture(
                    async client => {
                        const out = await collect(client, options);
                        assert.deepEqual(
                            out.map(unit => unit.data[0]),
                            [0, 1, 2, 3],
                        );
                    },
                    { lists: name => list(name, { count: name === 'high' ? 2 : 4 }) },
                );
            },
        );
    test(
        'a completed candidate parent cannot discard already-published trailing PARTs while ' +
            'polling',
        async () => {
            await fixture(
                async client => {
                    const out = await collect(client, { live: true, maxRefreshes: 1 });
                    assert.deepEqual(
                        out.map(unit => unit.data[0]),
                        [0, 1, 2, 3],
                    );
                },
                {
                    lists: name =>
                        name === 'high'
                            ? list(name, { count: 2, trailing: false }).replace(
                                  '#EXTINF:2,',
                                  '#EXTINF:1,',
                              )
                            : list(name),
                },
            );
        },
    );
    test(
        'a rejected PART switch callback preserves its original error and delivers no candidate ' +
            'bytes',
        async () => {
            const failure = new Error('PART callback failed');
            await fixture(
                async (client, requests) => {
                    const iterator = client.parts();
                    assert.equal((await iterator.next()).value.data[1], 1);
                    await assert.rejects(iterator.next(), error => error === failure);
                    assert(!requests.includes('low-0-1.m4s'));
                },
                {
                    adaptive: {
                        onVariantChange: event => {
                            if (event.reason === 'up') throw failure;
                        },
                    },
                },
            );
        },
    );
    test(
        'uncooperative PART switch callback cancels staged delivery without fetching current ' +
            'media again',
        async () => {
            let entered;
            const entering = new Promise(r => (entered = r));
            await fixture(
                async (client, requests) => {
                    const iterator = client.parts();
                    await iterator.next();
                    const pending = iterator.next();
                    await entering;
                    const rejected = assert.rejects(pending, e => e.code === 'ABORT');
                    assert.equal((await iterator.return()).done, true);
                    await rejected;
                    assert(requests.includes('high-init.mp4'));
                    assert(requests.includes('high-0-1.m4s'));
                    assert(!requests.includes('low-0-1.m4s'));
                },
                {
                    adaptive: {
                        onVariantChange: event => {
                            if (event.reason === 'up') {
                                entered();
                                return new Promise(() => {});
                            }
                        },
                    },
                },
            );
        },
    );
    test('uncooperative candidate fetch is aborted promptly', async () => {
        let entered;
        const entering = new Promise(r => (entered = r));
        const controller = new AbortController();
        await fixture(
            async (client, requests) => {
                const iterator = client.parts({ signal: controller.signal });
                await iterator.next();
                const pending = iterator.next();
                await entering;
                controller.abort();
                await assert.rejects(pending, e => e.code === 'ABORT');
                assert(!requests.includes('high-init.mp4'));
            },
            {
                lists: name => {
                    if (name === 'high') {
                        entered();
                        return new Promise(() => {});
                    }
                    return list(name);
                },
            },
        );
    });
    for (const stalledResource of ['high-init.mp4', 'high-0-1.m4s'])
        test(`abort cancels staged resource ${stalledResource} without fallback`, async () => {
            let entered;
            const entering = new Promise(resolve => {
                entered = resolve;
            });
            const controller = new AbortController();
            await fixture(
                async (client, requests, changes) => {
                    const iterator = client.parts({ signal: controller.signal });
                    await iterator.next();
                    const pending = iterator.next();
                    await entering;
                    controller.abort();
                    await assert.rejects(pending, error => error.code === 'ABORT');
                    assert(!requests.includes('low-0-1.m4s'));
                    assert.deepEqual(
                        changes.map(event => event.reason),
                        ['initial'],
                    );
                },
                {
                    resource: name => {
                        if (name === stalledResource) {
                            entered();
                            return new Promise(() => {});
                        }
                    },
                },
            );
        });
    test('unsupported source PART encryption rejection stays explicit', async () => {
        await fixture(
            async client => {
                await assert.rejects(
                    client.parts().next(),
                    e => e.code === 'FORMAT' && /unsupported encryption SAMPLE-AES/.test(e.message),
                );
            },
            { lists: name => list(name, { key: true }) },
        );
    });
    test('fixed PART delivery works without adaptive metadata', async () => {
        const client = new HlsClient({
            fetch: async url =>
                new Response(url.endsWith('.m3u8') ? list('low') : new Uint8Array(4)),
        });
        await client.load('https://hls.test/low.m3u8');
        const out = await collect(client);
        assert.equal(out.length, 4);
        assert(out.every(x => x.variant === undefined));
    });
    test(
        'delta refresh reconstructs completed history while advancing trailing parent ' + 'PARTs',
        async () => {
            await fixture(
                async (client, requests) => {
                    const out = await collect(client, { live: true, maxRefreshes: 1 });
                    assert.deepEqual(
                        out.map(x => x.data[0]),
                        [0, 1, 2, 3, 4, 5, 6, 7],
                    );
                    assert(out.every(x => x.type === 'part'));
                },
                {
                    lists: (name, count) =>
                        list(
                            name,
                            count === 1
                                ? { groups: 2, count: 2 }
                                : { groups: 2, count: 4, delta: 1, end: true, trailing: false },
                        ),
                },
            );
        },
    );
    test('sliding refresh preserves trailing parent time after PDT leaves its window', async () => {
        await fixture(
            async (client, requests) => {
                const out = await collect(client, { live: true, maxRefreshes: 1 });
                assert.deepEqual(
                    out.map(x => x.data[0]),
                    [0, 1, 2, 3, 4, 5, 6, 7],
                );
                assert.equal(out.at(-1).sequence, 101);
            },
            {
                lists: (name, count) =>
                    list(
                        name,
                        count === 1
                            ? { groups: 2, count: 2 }
                            : { start: 1, count: 4, end: true, date: false },
                    ),
            },
        );
    });
    test('changed published PART range/context is rejected across refresh', async () => {
        await fixture(
            async client => {
                const it = client.parts({ live: true, maxRefreshes: 1 });
                await it.next();
                await it.next();
                await assert.rejects(
                    it.next(),
                    e => e.code === 'DEMUX' && /existing PART/.test(e.message),
                );
            },
            { lists: (name, count) => list(name, { count: 2, range: count > 1 }) },
        );
    });
    test('PART duration mismatch prevents switching even when start time matches', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert(out.every(x => x.data[1] === 1));
            },
            {
                lists: name =>
                    name === 'high'
                        ? list(name).replaceAll('DURATION=0.5', 'DURATION=0.6')
                        : list(name),
            },
        );
    });
    test(
        'incomplete PART coverage in a completed candidate cannot discard current ' + 'media',
        async () => {
            await fixture(
                async client => {
                    const out = await collect(client);
                    assert(out.every(x => x.data[1] === 1));
                    assert.equal(out.length, 4);
                },
                {
                    lists: name =>
                        list(name, name === 'high' ? { count: 2, trailing: false, end: true } : {}),
                },
            );
        },
    );
    test('live PART polling honors idle bounds', async () => {
        await fixture(async client => {
            const it = client.parts({ live: true, maxIdleRefreshes: 2 });
            for (let i = 0; i < 4; i++) await it.next();
            await assert.rejects(
                it.next(),
                e => e.code === 'IO' && /maxIdleRefreshes/.test(e.message),
            );
        });
    });
    test('map is emitted again at a discontinuity even if its URI is unchanged', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert(out[0].initData);
                assert(out[4].initData);
                assert.equal(out[4].discontinuitySequence, 1);
            },
            {
                adaptive: { upSwitchSegments: 100 },
                lists: name =>
                    list(name, { groups: 2, trailing: false, end: true }).replace(
                        '#EXT-X-PART:DURATION=0.5,URI="' + name + '-1-0.m4s"',
                        '#EXT-X-DISCONTINUITY\n#EXT-X-PART:DURATION=0.5,URI="' + name + '-1-0.m4s"',
                    ),
            },
        );
    });
    test('PART alignment bounds by discontinuity before searching reset dates', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert.deepEqual(
                    out.map(unit => unit.data[0]),
                    [0, 1, 2, 3, 4, 5, 6, 7],
                );
                assert.equal(out[4].discontinuitySequence, 1);
                assert(out.some(unit => unit.data[1] === 2));
            },
            {
                lists: name =>
                    list(name, { groups: 2, trailing: false, end: true }).replace(
                        '#EXT-X-PART:DURATION=0.5,URI="' + name + '-1-0.m4s"',
                        '#EXT-X-DISCONTINUITY\n' +
                            '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n' +
                            '#EXT-X-PART:DURATION=0.5,URI="' +
                            name +
                            '-1-0.m4s"',
                    ),
            },
        );
    });
    test(
        'multiple candidate parents within the time tolerance do not pick an arbitrary ' + 'match',
        async () => {
            const tiny = name =>
                list(name, {
                    groups: name === 'high' ? 3 : 2,
                    count: 1,
                    trailing: false,
                    end: true,
                })
                    .replaceAll('DURATION=0.5', 'DURATION=0.0001')
                    .replaceAll('#EXTINF:2,', '#EXTINF:0.0004,');
            await fixture(
                async client => {
                    const out = await collect(client);
                    assert(out.every(unit => unit.data[1] === 1));
                    assert.equal(out.length, 5);
                },
                { lists: tiny },
            );
        },
    );

    test(
        'candidate future GAP must not drop media available on the current ' + 'rendition',
        async () => {
            await fixture(
                async client => {
                    const out = await collect(client);
                    assert.deepEqual(
                        out.map(unit => unit.data[0]),
                        [0, 1, 2, 3],
                    );
                },
                {
                    lists: name =>
                        name === 'high'
                            ? list(name).replace(
                                  'URI="high-0-2.m4s",INDEPENDENT=YES',
                                  'URI="high-0-2.m4s",INDEPENDENT=YES,GAP=YES',
                              )
                            : list(name),
                },
            );
        },
    );
    test(
        'initial PART event identifies the first downloaded PART after declared ' + 'gaps',
        async () => {
            await fixture(
                async (client, requests, changes) => {
                    const iterator = client.parts();
                    const first = (await iterator.next()).value;
                    assert.deepEqual(
                        [changes[0].sequence, changes[0].partIndex],
                        [first.sequence, first.partIndex],
                    );
                    await iterator.return();
                },
                {
                    lists: name =>
                        list(name).replace(
                            `URI="${name}-0-0.m4s",INDEPENDENT=YES`,
                            `URI="${name}-0-0.m4s",INDEPENDENT=YES,GAP=YES`,
                        ),
                },
            );
        },
    );
    test(
        'an initial parent GAP reports the next deliverable PART before its resource ' + 'request',
        async () => {
            const observed = [];
            await fixture(
                async (client, requests) => {
                    const first = (await client.parts().next()).value;
                    assert.deepEqual(observed, [[1, 0]]);
                    assert.equal(first.sequence, 1);
                    assert(!requests.includes('low-0-0.m4s'));
                },
                {
                    lists: name =>
                        list(name, { groups: 2 }).replace('#EXTINF:2,', '#EXT-X-GAP\n#EXTINF:2,'),
                    adaptive: {
                        onVariantChange: event => observed.push([event.sequence, event.partIndex]),
                    },
                    resource: name => {
                        if (name.endsWith('.mp4') || name.endsWith('.m4s'))
                            assert.equal(observed.length, 1);
                    },
                },
            );
        },
    );
    test('an all-GAP PART snapshot performs no media request or initial notification', async () => {
        await fixture(
            async (client, requests, changes) => {
                assert.deepEqual(await collect(client), []);
                assert.equal(changes.length, 0);
                assert(!requests.some(name => name.endsWith('.mp4') || name.endsWith('.m4s')));
            },
            { lists: name => list(name).replaceAll('INDEPENDENT=YES', 'INDEPENDENT=YES,GAP=YES') },
        );
    });
    test('candidate future parent GAP cannot discard current PART media', async () => {
        await fixture(
            async client => {
                const out = await collect(client);
                assert.deepEqual(
                    out.map(unit => unit.data[0]),
                    [0, 1, 2, 3, 4, 5, 6, 7],
                );
            },
            {
                lists: name =>
                    name === 'high'
                        ? list(name, { groups: 2 }).replace(
                              'URI="high-1-2.m4s",INDEPENDENT=YES',
                              'URI="high-1-2.m4s",INDEPENDENT=YES,GAP=YES',
                          )
                        : list(name, { groups: 2 }),
            },
        );
    });
    test('HLS options validate metadataPolicy and read an inherited getter once', () => {
        assert.throws(
            () => new HlsClient({ metadataPolicy: null }),
            error => error.code === 'INPUT',
        );
        let reads = 0;
        const options = Object.create({
            get metadataPolicy() {
                reads++;
                return 'error';
            },
        });
        new HlsClient(options).close();
        assert.equal(reads, 1);
    });
});
