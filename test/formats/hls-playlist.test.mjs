import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseHlsPlaylist, serializeHlsPlaylist } from 'mediaforgejs/streaming';

// An HLS media playlist read and written: its segments numbered from the media sequence, their URIs
// resolved against the playlist's, and what a playlist written from it reads back as.

const TEXT =
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:4\n' +
    '#EXTINF:2,\npart.m4s\n#EXTINF:1.5,\nnext.m4s\n#EXT-X-ENDLIST\n';
const BASE = 'https://example.test/v/video.m3u8';

/** The segments of a playlist as [sequence, duration, uri]. */
const segmentsOf = playlist =>
    playlist.segments.map(segment => [segment.sequence, segment.duration, segment.uri]);

describe('formats/hls: media playlists', () => {
    test('segments are numbered from the media sequence, their URIs resolved', () => {
        const playlist = parseHlsPlaylist(TEXT, { baseUrl: BASE });
        assert.deepEqual(
            [playlist.type, playlist.targetDuration, playlist.endList],
            ['media', 2, true],
        );
        assert.deepEqual(segmentsOf(playlist), [
            [4, 2, 'https://example.test/v/part.m4s'],
            [5, 1.5, 'https://example.test/v/next.m4s'],
        ]);
        assert.deepEqual(playlist.diagnostics, []);
    });

    test('a playlist written from one read reads back as it', () => {
        const playlist = parseHlsPlaylist(TEXT, { baseUrl: BASE });
        const again = parseHlsPlaylist(serializeHlsPlaylist(playlist));
        assert.deepEqual(
            [again.type, again.targetDuration, again.mediaSequence, again.endList],
            ['media', 2, 4, true],
        );
        assert.deepEqual(segmentsOf(again), segmentsOf(playlist));
    });

    test('a playlist is refused by one rule for each kind of refusal', () => {
        // Malformed (DEMUX), unsupported (FORMAT), an invalid option (INPUT), past a size limit
        // (OOM).
        assert.throws(() => parseHlsPlaylist('#EXT-X-TARGETDURATION:2\n'), {
            code: 'DEMUX',
            message: /#EXTM3U/,
        });
        assert.throws(() => parseHlsPlaylist(TEXT.replace('#EXTINF:2,', '#EXTINF:two,')), {
            code: 'DEMUX',
            message: /EXTINF duration/,
        });
        assert.throws(() => parseHlsPlaylist(TEXT.replace('part.m4s', '{$name}.m4s')), {
            code: 'FORMAT',
            message: /variable substitution/,
        });
        assert.throws(() => parseHlsPlaylist(TEXT.replace(':4\n', ':9007199254740993\n')), {
            code: 'FORMAT',
            message: /safe integer/,
        });
        assert.throws(() => parseHlsPlaylist(TEXT, { baseUrl: 'v/video.m3u8' }), {
            code: 'INPUT',
            message: /baseUrl/,
        });
        assert.throws(() => parseHlsPlaylist(TEXT, { maxPlaylistEntries: 1 }), {
            code: 'OOM',
            message: /entry limit/,
        });
    });

    test('a playlist HLS cannot state is not written', () => {
        const playlist = parseHlsPlaylist(TEXT, { baseUrl: BASE });
        const titled = { ...playlist, segments: [{ ...playlist.segments[0], title: 'a\nb' }] };
        assert.throws(() => serializeHlsPlaylist(titled), {
            code: 'FORMAT',
            message: /control character/,
        });
        const unnamed = { ...playlist, segments: [{ ...playlist.segments[0], uri: '' }] };
        assert.throws(() => serializeHlsPlaylist(unnamed), {
            code: 'FORMAT',
            message: /segment URI/,
        });
    });
});
