import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

// The HLS client on a plain VOD media playlist: what segments() and parts() hand out.

const PLAYLIST =
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:2,\npart.m4s\n' +
    '#EXT-X-ENDLIST\n';

/** A fetch that answers the playlist for .m3u8 URLs and three bytes for anything else. */
const fetch = async url =>
    new Response(String(url).endsWith('.m3u8') ? PLAYLIST : Uint8Array.of(1, 2, 3));

describe('the HLS client: a media playlist', () => {
    test('segments() yields each segment once with its bytes', async () => {
        const client = new HlsClient({ fetch });
        try {
            await client.load('https://example.test/video.m3u8');
            const segments = [];
            for await (const segment of client.segments()) segments.push(segment);
            assert.deepEqual(
                segments.map(segment => [segment.segment.uri, [...segment.data]]),
                [['https://example.test/part.m4s', [1, 2, 3]]],
            );
        } finally {
            client.close();
        }
    });

    test('parts() yields a playlist without parts as whole segments', async () => {
        const client = new HlsClient({ fetch });
        try {
            await client.load('https://example.test/video.m3u8');
            const units = [];
            for await (const unit of client.parts()) units.push([unit.type, [...unit.data]]);
            assert.deepEqual(units, [['segment', [1, 2, 3]]]);
        } finally {
            client.close();
        }
    });
});
