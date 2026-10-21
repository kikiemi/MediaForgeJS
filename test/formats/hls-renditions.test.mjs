import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getHlsRenditions, parseHlsPlaylist, selectHlsRendition } from 'mediaforgejs/streaming';

// The renditions of an HLS variant: those of its groups, and the one a viewer's languages, a name,
// channels or the forced flag select.

/** An EXT-X-MEDIA tag from its attributes. */
const media = attributes => `#EXT-X-MEDIA:${attributes.join(',')}`;

/** Audio in four languages and layouts (and another group), two subtitles and closed captions. */
const master = () =>
    parseHlsPlaylist(
        [
            '#EXTM3U',
            media([
                'TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en"',
                'AUTOSELECT=YES,DEFAULT=YES,URI="en.m3u8",CHANNELS="2"',
            ]),
            media([
                'TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja"',
                'AUTOSELECT=YES,URI="ja.m3u8",CHANNELS="2"',
            ]),
            media([
                'TYPE=AUDIO,GROUP-ID="a",NAME="English surround",LANGUAGE="en-GB"',
                'AUTOSELECT=YES,URI="surround.m3u8",CHANNELS="6"',
            ]),
            media([
                'TYPE=AUDIO,GROUP-ID="a",NAME="Commentary",LANGUAGE="ja"',
                'AUTOSELECT=NO,URI="comment.m3u8"',
            ]),
            media([
                'TYPE=AUDIO,GROUP-ID="b",NAME="Other group",LANGUAGE="ja"',
                'AUTOSELECT=YES,DEFAULT=YES,URI="other.m3u8"',
            ]),
            media([
                'TYPE=SUBTITLES,GROUP-ID="a",NAME="Full",LANGUAGE="en"',
                'AUTOSELECT=YES,DEFAULT=YES,URI="full.m3u8"',
            ]),
            media([
                'TYPE=SUBTITLES,GROUP-ID="a",NAME="Forced",LANGUAGE="en"',
                'AUTOSELECT=YES,FORCED=YES,URI="forced.m3u8"',
            ]),
            media([
                'TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC",LANGUAGE="en"',
                'AUTOSELECT=YES,INSTREAM-ID="CC1"',
            ]),
            '#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a",SUBTITLES="a",CLOSED-CAPTIONS="cc"',
            'video.m3u8',
            '',
        ].join('\n'),
        { baseUrl: 'https://example.test/master.m3u8' },
    );

describe('hls: renditions', () => {
    const playlist = master();
    const variant = playlist.variants[0];
    const audio = options => selectHlsRendition(playlist, variant, { type: 'AUDIO', ...options });

    test('a variant has the renditions of its own group', () => {
        assert.deepEqual(
            getHlsRenditions(playlist, variant, 'AUDIO').map(rendition => rendition.name),
            ['English', 'Japanese', 'English surround', 'Commentary'],
        );
    });

    test('without preferences the default rendition is selected', () => {
        assert.equal(audio().name, 'English');
    });

    for (const [languages, name] of [
        [['fr', 'JA-jp'], 'Japanese'],
        [['EN-gb'], 'English surround'],
        [['en-AU'], 'English'],
        [['ja', 'en'], 'Japanese'],
    ])
        test(`the languages ${languages.join(', ')} select ${name}`, () => {
            // Tags compare without case, and a region falls back to its language.
            assert.equal(audio({ languages }).name, name);
        });

    test('a name selects that rendition, and an absent name none', () => {
        assert.equal(audio({ name: 'Commentary' }).name, 'Commentary');
        assert.equal(audio({ name: 'absent', languages: ['ja'] }), undefined);
    });

    test('channels select the rendition of that layout, or none', () => {
        assert.equal(audio({ channels: '6' }).name, 'English surround');
        assert.equal(audio({ channels: '8' }), undefined);
    });

    test('the forced flag selects forced or full subtitles', () => {
        const subtitles = forced =>
            selectHlsRendition(playlist, variant, { type: 'SUBTITLES', forced }).name;
        assert.deepEqual([subtitles(true), subtitles(false)], ['Forced', 'Full']);
    });

    test('closed captions select their in-stream channel', () => {
        const captions = selectHlsRendition(playlist, variant, { type: 'CLOSED-CAPTIONS' });
        assert.equal(captions.instreamId, 'CC1');
    });

    test('a variant without the group has no rendition of it', () => {
        const none = { ...variant, closedCaptions: 'NONE' };
        assert.deepEqual(getHlsRenditions(playlist, none, 'CLOSED-CAPTIONS'), []);
        const silent = { ...variant, audio: undefined };
        assert.deepEqual(getHlsRenditions(playlist, silent, 'AUDIO'), []);
        assert.equal(selectHlsRendition(playlist, silent, { type: 'AUDIO' }), undefined);
    });

    test('renditions handed out are copies the caller may change', () => {
        const selected = audio();
        selected.name = 'Changed';
        selected.attributes.LANGUAGE = 'xx';
        assert.deepEqual([audio().name, audio().attributes.LANGUAGE], ['English', 'en']);
        const list = getHlsRenditions(playlist, variant, 'AUDIO');
        list[0].attributes.URI = 'wrong';
        list.pop();
        assert.equal(getHlsRenditions(playlist, variant, 'AUDIO').length, 4);
        assert.equal(audio().attributes.URI, 'en.m3u8');
    });

    test('a default rendition muxed into the variant has no URI', () => {
        const inband = {
            ...playlist,
            renditions: [{ type: 'AUDIO', groupId: 'a', name: 'Muxed', default: true }],
        };
        assert.equal(selectHlsRendition(inband, variant, { type: 'AUDIO' }).uri, undefined);
    });

    test('a rendition neither default nor autoselect is selected by name only', () => {
        const manual = {
            ...playlist,
            renditions: [{ type: 'AUDIO', groupId: 'a', name: 'Manual' }],
        };
        assert.equal(selectHlsRendition(manual, variant, { type: 'AUDIO' }), undefined);
        assert.equal(
            selectHlsRendition(manual, variant, { type: 'AUDIO', name: 'Manual' }).name,
            'Manual',
        );
    });

    test('malformed selections fail with INPUT and leave the playlist as it was', () => {
        const before = JSON.stringify(playlist);
        for (const bad of [
            null,
            [],
            { type: 'INVALID' },
            { type: 'AUDIO', languages: 'ja' },
            { type: 'AUDIO', languages: ['en_US'] },
            { type: 'AUDIO', forced: 1 },
            { type: 'AUDIO', name: '' },
            { type: 'AUDIO', channels: '' },
        ])
            assert.throws(() => selectHlsRendition(playlist, variant, bad), { code: 'INPUT' });
        assert.equal(JSON.stringify(playlist), before);
    });

    test('a media playlist has no renditions to ask for', () => {
        assert.throws(() => getHlsRenditions({ type: 'media' }, variant, 'AUDIO'), {
            code: 'INPUT',
        });
    });
});
