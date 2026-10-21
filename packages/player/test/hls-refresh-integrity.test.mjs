import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

// A live playlist refresh must repeat what it announced before (segments, keys, maps, PARTs)
// while its window slides.

describe('the HLS client: live playlist refreshes', () => {
    const header =
        '#EXTM3U\n' +
        '#EXT-X-TARGETDURATION:2\n' +
        '#EXT-X-MEDIA-SEQUENCE:10\n' +
        '#EXT-X-PART-INF:PART-TARGET=1\n';
    const key = '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x01\n';
    const map = '#EXT-X-MAP:URI="init",BYTERANGE="16@0"\n';
    const body =
        '#EXT-X-PART:DURATION=1,URI="part",BYTERANGE="16@0",INDEPENDENT=YES\n' +
        '#EXT-X-PART:DURATION=1,URI="part",BYTERANGE="16@16"\n' +
        '#EXTINF:2,\n' +
        '#EXT-X-BYTERANGE:32@0\n' +
        'segment\n';
    const trailing = '#EXT-X-PART:DURATION=1,URI="next",BYTERANGE="16@32",INDEPENDENT=YES\n';
    const original = header + key + map + body + trailing;
    const cases = [
        ['unchanged', original, true],
        ['segment URI', original.replace('\nsegment\n', '\nchanged\n'), false],
        ['segment duration', original.replace('EXTINF:2,', 'EXTINF:1,'), false],
        ['segment range offset', original.replace('32@0', '32@1'), false],
        ['segment range length', original.replace('32@0', '31@0'), false],
        ['key URI', original.replace('URI="key"', 'URI="other"'), false],
        ['key IV', original.replace('IV=0x01', 'IV=0x02'), false],
        ['key method', original.replace('METHOD=AES-128', 'METHOD=SAMPLE-AES'), false],
        ['key format', original.replace('IV=0x01', 'IV=0x01,KEYFORMAT="example"'), false],
        [
            'key format versions',
            original.replace('IV=0x01', 'IV=0x01,KEYFORMATVERSIONS="2"'),
            false,
        ],
        ['map URI', original.replace('URI="init"', 'URI="different"'), false],
        ['map range', original.replace('BYTERANGE="16@0"', 'BYTERANGE="16@1"'), false],
        ['PART URI', original.replace('URI="next"', 'URI="other"'), false],
        [
            'PART duration',
            original.replace('DURATION=1,URI="next"', 'DURATION=0.5,URI="next"'),
            false,
        ],
        [
            'PART independence',
            original.replace(
                'URI="next",BYTERANGE="16@32",INDEPENDENT=YES',
                'URI="next",BYTERANGE="16@32",INDEPENDENT=NO',
            ),
            false,
        ],
        ['PART range', original.replace('16@32', '16@33'), false],
        ['PART GAP', original.replace('URI="next"', 'GAP=YES,URI="next"'), false],
        ['removed trailing PART', header + key + map + body, false],
        [
            'removed old completed PARTs',
            header + key + map + '#EXTINF:2,\n#EXT-X-BYTERANGE:32@0\nsegment\n' + trailing,
            true,
        ],
        [
            'completed trailing PART context',
            header + key + map + body + trailing + '#EXTINF:2,\ncomplete\n',
            true,
        ],
        ['slide window', header.replace('SEQUENCE:10', 'SEQUENCE:11') + key + map + trailing, true],
    ];
    for (const [name, after, valid] of cases)
        test(
            valid
                ? `a refresh that keeps what was announced (${name}) is accepted`
                : `a refresh that changes an announced ${name} is malformed (DEMUX)`,
            async () => {
                let requests = 0;
                const client = new HlsClient({
                    refreshIntervalMs: 1,
                    fetch: async () => new Response(++requests === 1 ? original : after),
                });
                try {
                    await client.load('https://refresh.test/main.m3u8');
                    const run = async () => {
                        for await (const unit of client.parts({
                            live: true,
                            startSequence: 12,
                            maxRefreshes: 1,
                        }))
                            assert.fail(`No media should be requested (${unit.type})`);
                    };
                    if (valid) await run();
                    else await assert.rejects(run(), error => error.code === 'DEMUX');
                    assert.equal(requests, 2);
                } finally {
                    client.close();
                }
            },
        );
});
