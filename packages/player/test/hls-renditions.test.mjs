import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseHlsPlaylist, selectHlsRendition } from 'mediaforgejs/streaming';
import { HlsClient } from 'mediaforgejs-player';

// The HLS client plays what the rendition selection of mediaforgejs/streaming chose.

describe('the HLS client: alternative renditions', () => {
    test('loads the media playlist of the rendition selectHlsRendition chose', async () => {
        const master = parseHlsPlaylist(
            '#EXTM3U\n' +
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",' +
                'AUTOSELECT=YES,DEFAULT=YES,URI="en.m3u8"\n' +
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",' +
                'AUTOSELECT=YES,URI="ja.m3u8"\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"\nvideo.m3u8\n',
            { baseUrl: 'https://example.test/master.m3u8' },
        );
        const rendition = selectHlsRendition(master, master.variants[0], {
            type: 'AUDIO',
            languages: ['ja'],
        });
        const seen = [];
        const client = new HlsClient({
            fetch: async url => {
                seen.push(String(url));
                return new Response(
                    String(url).endsWith('.m3u8')
                        ? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.aac\n#EXT-X-ENDLIST\n'
                        : Uint8Array.of(1, 2, 3),
                );
            },
        });
        try {
            await client.load(rendition.uri);
            for await (const unit of client.segments())
                assert.deepEqual(unit.data, Uint8Array.of(1, 2, 3));
        } finally {
            client.close();
        }
        assert.deepEqual(seen, ['https://example.test/ja.m3u8', 'https://example.test/a.aac']);
    });
});
