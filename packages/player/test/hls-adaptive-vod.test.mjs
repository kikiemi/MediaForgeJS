import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AdaptiveQualityController, HlsClient } from 'mediaforgejs-player';

describe('the HLS client: adaptive quality of a VOD master', () => {
    const codecs = 'avc1.42e01e,mp4a.40.2';

    function fixture({
        count = 8,
        highDurations,
        highSequence = 0,
        highCodecs = codecs,
        independent = true,
        highDiscontinuity = false,
        highDate,
        lowDate,
        endList = true,
        highAudio,
        lowAudio,
    } = {}) {
        const audioOf = group => (group ? `,AUDIO="${group}"` : '');
        const master =
            '#EXTM3U\n' +
            (independent ? '#EXT-X-INDEPENDENT-SEGMENTS\n' : '') +
            `#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="${codecs}"${audioOf(lowAudio)}\n` +
            'low.m3u8\n' +
            `#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="${highCodecs}"${audioOf(highAudio)}\n` +
            'high.m3u8\n';
        const playlists = new Map([['/master.m3u8', master]]);
        for (const name of ['low', 'high']) {
            const date = name === 'low' ? lowDate : highDate;
            const entries = Array.from(
                { length: count },
                (_, index) =>
                    (name === 'high' && highDiscontinuity && index === 3
                        ? '#EXT-X-DISCONTINUITY\n'
                        : '') +
                    (index === 0 && date ? `#EXT-X-PROGRAM-DATE-TIME:${date}\n` : '') +
                    `#EXTINF:${name === 'high' ? (highDurations?.[index] ?? 2) : 2},\n` +
                    `${name}-${index}.m4s\n`,
            ).join('');
            playlists.set(
                `/${name}.m3u8`,
                '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
                    `#EXT-X-MEDIA-SEQUENCE:${name === 'high' ? highSequence : 0}\n` +
                    `#EXT-X-MAP:URI="${name}-init.mp4"\n` +
                    entries +
                    (endList ? '#EXT-X-ENDLIST\n' : ''),
            );
        }
        return { playlists };
    }

    async function withClient(
        f,
        run,
        { adaptive = true, slowSegment = 'high-3.m4s', signal, playable } = {},
    ) {
        const originalPerformance = globalThis.performance;
        let time = 0;
        const requested = [];
        Object.defineProperty(globalThis, 'performance', {
            value: { now: () => time },
            configurable: true,
        });
        const client = new HlsClient({
            signal,
            adaptive,
            playable,
            fetch: async url => {
                const path = new URL(url).pathname;
                requested.push(path);
                if (f.playlists.has(path)) return new Response(f.playlists.get(path));
                if (path.endsWith('-init.mp4'))
                    return new Response(Uint8Array.of(path.includes('high') ? 202 : 101));
                const match = /^\/(low|high)-(\d+)\.m4s$/.exec(path);
                assert(match, `unexpected resource ${path}`);
                time += path.endsWith(slowSegment) ? 1000 : 25;
                const bytes = new Uint8Array(12500);
                bytes[0] = Number(match[2]);
                bytes[1] = match[1] === 'high' ? 2 : 1;
                return new Response(bytes);
            },
        });
        try {
            await client.load('https://example.test/master.m3u8');
            return await run(client, requested);
        } finally {
            client.close();
            Object.defineProperty(globalThis, 'performance', {
                value: originalPerformance,
                configurable: true,
            });
        }
    }

    test(
        'adaptive VOD switches after sustained throughput, drops promptly, and preserves every ' +
            'segment byte',
        async () => {
            const changes = [];
            await withClient(
                fixture(),
                async (client, requested) => {
                    const output = [];
                    for await (const unit of client.segments()) output.push(unit);
                    assert.deepEqual(
                        output.map(unit => [unit.data[0], unit.data[1]]),
                        [
                            [0, 1],
                            [1, 1],
                            [2, 1],
                            [3, 2],
                            [4, 1],
                            [5, 1],
                            [6, 1],
                            [7, 2],
                        ],
                    );
                    assert.deepEqual(
                        output.map(unit => unit.segment.sequence),
                        [0, 1, 2, 3, 4, 5, 6, 7],
                    );
                    assert.deepEqual(
                        output.map(unit => unit.initData?.[0]),
                        [101, undefined, undefined, 202, 101, undefined, undefined, 202],
                    );
                    assert.deepEqual(
                        changes.map(event => [event.reason, event.sequence]),
                        [
                            ['initial', 0],
                            ['up', 3],
                            ['down', 4],
                            ['up', 7],
                        ],
                    );
                    assert.equal(requested.filter(path => /-\d+\.m4s$/.test(path)).length, 8);
                    assert(
                        output.every(
                            unit =>
                                unit.data.byteLength === 12500 &&
                                unit.variant.bandwidth === (unit.data[1] === 1 ? 100000 : 400000),
                        ),
                    );
                },
                { adaptive: { onVariantChange: event => changes.push(event) } },
            );
        },
    );

    test('fixed default still requires explicit master selection', async () => {
        await withClient(
            fixture(),
            client => assert.rejects(client.segments().next(), error => error.code === 'INPUT'),
            { adaptive: false },
        );
    });

    test('the variant to start on is chosen once, as the playlist loads', async () => {
        const started = async options =>
            withClient(
                fixture(),
                async (client, requested) => {
                    const variant = client.variant?.uri.replace('https://example.test', '');
                    if (client.playlist.type === 'master' && options.adaptive)
                        await client.segments().next();
                    return { variant, first: requested.find(path => /-\d+\.m4s$/.test(path)) };
                },
                options,
            );
        // Adaptive quality starts low before any measurement; the first segment is that variant's.
        assert.deepEqual(await started({ adaptive: true }), {
            variant: '/low.m3u8',
            first: '/low-0.m4s',
        });
        assert.deepEqual(await started({ adaptive: false }), {
            variant: '/high.m3u8',
            first: undefined,
        });
        // Among the variants the caller plays, or any when it plays none.
        const lowOnly = variant => variant.uri.endsWith('/low.m3u8');
        assert.equal((await started({ adaptive: false, playable: lowOnly })).variant, '/low.m3u8');
        assert.equal(
            (await started({ adaptive: false, playable: () => false })).variant,
            '/high.m3u8',
        );
        await assert.rejects(
            started({ adaptive: false, playable: () => 'yes' }),
            error => error.code === 'INPUT',
        );
    });

    test('loading the variant to start on keeps it; another playlist leaves none', async () => {
        await withClient(
            fixture(),
            async client => {
                await client.load(client.variant.uri);
                assert.equal(client.variant?.uri, 'https://example.test/high.m3u8');
                await client.load('https://example.test/low.m3u8');
                assert.equal(client.variant, undefined);
            },
            { adaptive: false },
        );
    });

    test('with switchGroups, adaptive VOD also switches to variants of other groups', async () => {
        await withClient(
            fixture({ lowAudio: 'stereo', highAudio: 'surround' }),
            async client => {
                const quality = [];
                for await (const unit of client.segments()) quality.push(unit.data[1]);
                assert.deepEqual(quality, [1, 1, 1, 2, 1, 1, 1, 2]);
            },
            { adaptive: { switchGroups: true } },
        );
    });

    test('with switchCodecs, adaptive VOD switches to other codecs of the same kinds', async () => {
        const quality = async (highCodecs, adaptive) =>
            withClient(
                fixture({ highCodecs }),
                async client => {
                    const seen = [];
                    for await (const unit of client.segments()) seen.push(unit.data[1]);
                    return seen;
                },
                { adaptive },
            );
        assert.deepEqual(
            await quality('hev1.1.6.L93.B0,mp4a.40.2', { switchCodecs: true }),
            [1, 1, 1, 2, 1, 1, 1, 2],
        );
        // Not to a variant without a picture, nor without the option.
        assert.deepEqual(
            await quality('mp4a.40.2', { switchCodecs: true }),
            [1, 1, 1, 1, 1, 1, 1, 1],
        );
        assert.deepEqual(await quality('hev1.1.6.L93.B0,mp4a.40.2', {}), [1, 1, 1, 1, 1, 1, 1, 1]);
        assert.throws(() => new HlsClient({ adaptive: { switchCodecs: 'yes' } }), {
            code: 'INPUT',
        });
    });

    for (const [name, options] of [
        ['unequal cumulative boundaries', { highDurations: [2.5, 1.5, 2, 2, 2, 2, 2, 2] }],
        ['different media sequences', { highSequence: 10 }],
        ['different discontinuities', { highDiscontinuity: true }],
        [
            'conflicting clock anchors',
            { lowDate: '2026-01-01T00:00:00Z', highDate: '2026-01-01T00:00:02Z' },
        ],
        ['different codecs', { highCodecs: 'hev1.1.6.L93.B0,mp4a.40.2' }],
        ['different audio groups', { lowAudio: 'stereo', highAudio: 'surround' }],
        ['no independent-segment guarantee', { independent: false }],
    ])
        test(`adaptive VOD does not switch with ${name}`, async () => {
            await withClient(fixture(options), async client => {
                const quality = [];
                for await (const unit of client.segments()) quality.push(unit.data[1]);
                assert.deepEqual(quality, [1, 1, 1, 1, 1, 1, 1, 1]);
            });
        });

    test('adaptive parts retains complete-segment fallback for VOD playlists', async () => {
        await withClient(fixture(), async (client, requested) => {
            const output = [];
            for await (const unit of client.parts()) output.push(unit);
            assert(output.every(unit => unit.type === 'segment'));
            assert.deepEqual(
                output.map(unit => [unit.data[0], unit.data[1]]),
                [
                    [0, 1],
                    [1, 1],
                    [2, 1],
                    [3, 2],
                    [4, 1],
                    [5, 1],
                    [6, 1],
                    [7, 2],
                ],
            );
            assert.equal(requested.filter(path => path.endsWith('.m4s')).length, 8);
        });
    });

    test(
        'invalid adaptive configuration fails before fetch and reads inherited getters ' + 'once',
        async () => {
            for (const adaptive of [
                null,
                1,
                [],
                { initialBandwidth: NaN },
                { initialBandwidth: 0 },
                { bandwidthSafetyFactor: 0 },
                { bandwidthSafetyFactor: 1.1 },
                { upSwitchSegments: 0 },
                { upSwitchSegments: 1.5 },
                { onVariantChange: true },
            ]) {
                assert.throws(
                    () =>
                        new HlsClient({
                            adaptive,
                            fetch: async () => {
                                throw new Error('unexpected fetch');
                            },
                        }),
                    error => error.code === 'INPUT',
                );
            }
            let reads = 0;
            const options = Object.create({
                get initialBandwidth() {
                    reads++;
                    return 1000000;
                },
            });
            await withClient(
                fixture({ count: 1 }),
                async client => {
                    const first = await client.segments().next();
                    assert.equal(first.value.data[1], 2);
                },
                { adaptive: options },
            );
            assert.equal(reads, 1);
        },
    );

    test(
        'an aborted or failing variant callback cannot yield data or conceal the original ' +
            'error',
        async () => {
            const controller = new AbortController();
            await withClient(
                fixture(),
                async client => {
                    await assert.rejects(client.segments().next(), error => error.code === 'ABORT');
                },
                {
                    signal: controller.signal,
                    adaptive: { onVariantChange: () => controller.abort() },
                },
            );
            const failure = new Error('callback rejected');
            await withClient(
                fixture(),
                async client => {
                    await assert.rejects(client.segments().next(), error => error === failure);
                },
                {
                    adaptive: {
                        onVariantChange: async () => {
                            throw failure;
                        },
                    },
                },
            );
        },
    );

    test(
        'return() cancels a stalled asynchronous switch callback and releases client ' + 'state',
        async () => {
            let entered;
            const ready = new Promise(resolve => {
                entered = resolve;
            });
            await withClient(
                fixture(),
                async client => {
                    const iterator = client.segments();
                    const pending = iterator.next();
                    const rejected = assert.rejects(pending, error => error.code === 'ABORT');
                    await ready;
                    await iterator.return();
                    await rejected;
                    await client.load('https://example.test/low.m3u8');
                },
                {
                    adaptive: {
                        onVariantChange: () => {
                            entered();
                            return new Promise(() => {});
                        },
                    },
                },
            );
        },
    );

    test('the bandwidth policy requires the current bandwidth to be a choice', async () => {
        const quality = new AdaptiveQualityController({ initialBandwidth: 1000000 });
        assert.throws(
            () => quality.selectBandwidth([100000, 400000], 200000),
            error => error.code === 'INPUT',
        );
        assert.equal(quality.selectBandwidth([100000, 400000]), 400000);
        const slowStart = new AdaptiveQualityController();
        assert.equal(slowStart.selectBandwidth([400000, 100000]), 100000);
        slowStart.addSample(12500, 25);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 100000), 100000);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 100000), 100000);
        slowStart.addSample(12500, 25);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 100000), 100000);
        slowStart.addSample(12500, 25);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 100000), 400000);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 100000), 400000);
        slowStart.addSample(12500, 1000);
        assert.equal(slowStart.selectBandwidth([100000, 400000], 400000), 100000);
        assert(Number.isFinite(slowStart.bandwidthEstimate));
    });

    test(
        'bandwidth policy rejects sparse choices and invalid samples instead of returning an ' +
            'invalid bandwidth',
        async () => {
            const quality = new AdaptiveQualityController();
            for (const choices of [[], [0], [NaN], new Array(1)]) {
                assert.throws(
                    () => quality.selectBandwidth(choices),
                    error => error.code === 'INPUT',
                );
            }
            for (const [bytes, milliseconds] of [
                [-1, 1],
                [1.5, 1],
                [1, -1],
                [1, Infinity],
                [1, NaN],
            ]) {
                assert.throws(
                    () => quality.addSample(bytes, milliseconds),
                    error => error.code === 'INPUT',
                );
            }
            quality.addSample(0, 100);
            quality.addSample(100, 0);
            assert.equal(quality.bandwidthEstimate, undefined);
            assert.equal(quality.selectBandwidth([100000, 400000]), 100000);
        },
    );
});
