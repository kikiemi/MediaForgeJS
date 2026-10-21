import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { createRetryFetch } from 'mediaforgejs/io';
import { HlsClient } from 'mediaforgejs-player';

// The HLS client over a real local HTTP server that answers the first request of each resource
// with 503 and Retry-After: 0.

describe('the HLS client over HTTP', () => {
    let server;
    let base;
    let bytes;
    const calls = [];
    before(async () => {
        const pcm = Float32Array.from({ length: 8192 }, (_, index) => Math.sin(index / 16) * 0.1);
        bytes = wrapAdts(await encodeAacLc([pcm], { sampleRate: 48000, bitrate: 64 }));
        const served = new Set();
        server = createServer((request, response) => {
            calls.push(request.url);
            if (!served.has(request.url)) {
                served.add(request.url);
                response.writeHead(503, { 'Retry-After': '0' });
                response.end('busy');
            } else if (request.url === '/vod.m3u8') {
                response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                response.end(
                    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.aac\n#EXT-X-ENDLIST\n',
                );
            } else if (request.url === '/segment.aac') {
                response.writeHead(200, {
                    'Content-Type': 'audio/aac',
                    'Content-Length': bytes.length,
                });
                response.end(bytes);
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server?.close());

    test('loads a playlist and its segment through a retrying fetch', async () => {
        const client = new HlsClient({
            fetch: createRetryFetch({ maxRetries: 1, baseDelayMs: 0 }),
            requestTimeoutMs: 2000,
        });
        try {
            await client.load(`${base}/vod.m3u8`);
            const units = [];
            for await (const unit of client.segments()) units.push(unit);
            assert.equal(units.length, 1);
            assert.deepEqual(units[0].data, bytes);
        } finally {
            client.close();
        }
        for (const path of ['/vod.m3u8', '/segment.aac'])
            assert.ok(calls.filter(call => call === path).length >= 2, `${path} retried`);
    });
});
