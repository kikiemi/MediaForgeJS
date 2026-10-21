import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    parseSrt,
    parseSubtitles,
    parseWebVtt,
    writeSrt,
    writeSubtitles,
} from 'mediaforgejs/formats';

// Subtitle documents written in another format read back with their cues: WebVTT into SRT, ASS
// and TTML, overlapping cues and text outside ASCII included.

const document = parseWebVtt(
    'WEBVTT\n\nA\n00:00.000 --> 00:02.000\n字幕\n\nB\n00:01.000 --> 00:03.000\nOverlap\n',
);

describe('formats/text: converting subtitle documents', () => {
    test('WebVTT written as SRT reads back as its cues', () => {
        assert.deepEqual(
            parseSrt(writeSrt(document)).cues.map(cue => [cue.startTime, cue.endTime, cue.text]),
            [
                [0, 2, '字幕'],
                [1, 3, 'Overlap'],
            ],
        );
    });

    for (const format of ['ass', 'ttml'])
        test(`WebVTT written as ${format} reads back as its cues`, () => {
            const converted = parseSubtitles(writeSubtitles(document, format));
            assert.deepEqual(
                converted.cues.map(cue => [cue.startTime, cue.endTime, cue.text]),
                [
                    [0, 2, '字幕'],
                    [1, 3, 'Overlap'],
                ],
            );
        });

    test('a document is refused as a media input is', () => {
        // Malformed (DEMUX), unsupported (FORMAT), an invalid option (INPUT), past a size limit
        // (OOM).
        const ttml = (attributes = '', body = '<p begin="0s" end="1s">A</p>') =>
            `<tt xmlns="http://www.w3.org/ns/ttml" ${attributes}>` +
            `<body><div>${body}</div></body></tt>`;
        assert.equal(parseSubtitles(ttml()).cues.length, 1);
        assert.throws(() => parseSubtitles('no cues here'), {
            code: 'DEMUX',
            message: /could not be detected/,
        });
        assert.throws(() => parseSubtitles('<tt><body'), { code: 'DEMUX', message: /XML/ });
        assert.throws(() => parseSubtitles(ttml('', '<p begin="later" end="1s">A</p>')), {
            code: 'DEMUX',
            message: /Invalid TTML begin/,
        });
        assert.throws(
            () =>
                parseSubtitles(
                    ttml('xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="smpte"'),
                ),
            { code: 'FORMAT', message: /media time base/ },
        );
        assert.throws(() => parseSubtitles(ttml(), { maxCues: 0 }), { code: 'INPUT' });
        assert.throws(() => parseWebVtt(writeSubtitles(document, 'webvtt'), { maxCues: 1 }), {
            code: 'OOM',
            message: /maxCues/,
        });
        assert.throws(() => writeSrt(document, { maxBytes: 20 }), {
            code: 'OOM',
            message: /maxBytes/,
        });
    });
});
