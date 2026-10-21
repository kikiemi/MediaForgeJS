import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import * as text from 'mediaforgejs/formats';

// Text subtitles: the chunks a muxer takes for a time window, editSubtitles() cutting and shifting
// cues, and what the writers keep or report.

const cues = [
    { startTime: 0, endTime: 1, text: 'before' },
    { startTime: 1, endTime: 3, text: 'inside' },
    { startTime: 4, endTime: 5, text: 'after' },
];

describe('formats/text: subtitle chunks', () => {
    for (const codec of ['wvtt', 'text/webvtt', 'text/utf8'])
        test(`${codec} chunks keep to the window asked for`, () => {
            const chunks = text.toSubtitleChunks(cues, codec, { startTime: 2, endTime: 2.5 });
            assert.deepEqual(
                chunks.map(chunk => [chunk.timestamp, chunk.duration]),
                [[2, 0.5]],
            );
            assert.deepEqual(text.toSubtitleChunks(cues, codec, { startTime: 2, endTime: 2 }), []);
            for (const options of [
                { startTime: NaN },
                { endTime: -1 },
                { startTime: 2, endTime: 1 },
            ])
                assert.throws(
                    () => text.toSubtitleChunks(cues, codec, options),
                    error => error.code === 'INPUT',
                );
        });

    test('WebVTT chunks escape the literal text of TTML and ASS', () => {
        const source = 'A <b>literal</b> & B';
        const documents = [
            text.parseTtml(
                '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">A ' +
                    '&lt;b&gt;literal&lt;/b&gt; &amp; B</p></div></body></tt>',
            ),
            text.parseAss(
                '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:00.00,0:00:01.00,A ' +
                    '<b>literal</b> & B\n',
            ),
        ];
        for (const document of documents) {
            const expected = text.parseWebVtt(text.writeWebVtt(document)).cues[0].text;
            assert.equal(
                text.decodeWebVttSample(text.toSubtitleChunks(document)[0].data).cues[0].text,
                expected,
            );
            assert.equal(
                text.decodeWebVttBlock(text.toSubtitleChunks(document, 'text/webvtt')[0].data).text,
                expected,
            );
            assert.equal(
                new TextDecoder().decode(text.toSubtitleChunks(document, 'text/utf8')[0].data),
                source,
            );
        }
        const markup = text.parseWebVtt('WEBVTT\n\n00:00.000 --> 00:01.000\n<b>bold</b> &amp; B\n');
        assert.equal(
            text.decodeWebVttSample(text.toSubtitleChunks(markup)[0].data).cues[0].text,
            markup.cues[0].text,
        );
    });

    test('the byte budget holds before escaping many cues, in 64 MB of heap', () => {
        const entry = import.meta.resolve('mediaforgejs/formats');
        for (const codec of ['wvtt', 'text/webvtt']) {
            const child = spawnSync(
                process.execPath,
                [
                    '--max-old-space-size=64',
                    '--input-type=module',
                    '--eval',
                    `
                import assert from 'node:assert/strict';
                import { toSubtitleChunks } from ${JSON.stringify(entry)};
                const payload = '&'.repeat(10000);
                const cues = Array.from({ length: 10000 }, () => ({
                    startTime: 0, endTime: 1, text: payload,
                }));
                const document = { format: 'ttml', diagnostics: [], cues };
                const codec = ${JSON.stringify(codec)};
                assert.throws(
                    () => toSubtitleChunks(document, codec, { maxBytes: 1 }),
                    error => error.code === 'INPUT',
                );
                const window = { startTime: 2, endTime: 3, maxBytes: 8 };
                const outside = toSubtitleChunks(document, codec, window);
                assert.equal(outside.length, ${codec === 'wvtt' ? 1 : 0});
            `,
                ],
                { encoding: 'utf8' },
            );
            assert.equal(child.status, 0, `${codec}: ${child.error?.message ?? child.stderr}`);
        }
    });
});

describe('formats/text: writers', () => {
    test('WebVTT leaves out NOTE identifiers, reported, and keeps the captions', () => {
        for (const id of ['NOTE', 'NOTE label', 'NOTE\tlabel'])
            for (const validation of ['compatible', 'strict']) {
                const warnings = [];
                const output = text.writeWebVtt([{ ...cues[0], id }], {
                    validation,
                    onWarning: warning => warnings.push(warning),
                });
                assert.deepEqual(text.parseWebVtt(output).cues, [cues[0]]);
                assert.equal(warnings[0].code, 'SUBTITLE_ID_LOSS');
                assert.throws(
                    () =>
                        text.writeWebVtt([{ ...cues[0], id }], {
                            validation,
                            metadataPolicy: 'error',
                        }),
                    error => error.code === 'FORMAT',
                );
            }
        const cue = { ...cues[0], id: 'NOTE-label' };
        assert.deepEqual(text.parseWebVtt(text.writeWebVtt([cue])).cues, [cue]);
        const sample = text.encodeWebVttSample([{ text: 'caption', id: 'NOTE' }]);
        assert.equal(text.decodeWebVttSample(sample).cues[0].id, 'NOTE');
    });

    test('a cue shorter than the time unit is lengthened, or refused strictly', () => {
        for (const [write, parse, unit, end] of [
            [text.writeSrt, text.parseSrt, 0.001, 1.0004],
            [text.writeWebVtt, text.parseWebVtt, 0.001, 1.0004],
            [text.writeAss, text.parseAss, 0.01, 1.004],
            [text.writeTtml, text.parseTtml, 1e-9, 1 + 1e-10],
        ]) {
            const blink = [{ startTime: 1, endTime: end, text: 'blink' }];
            const warnings = [];
            const [cue] = parse(
                write(blink, { onWarning: warning => warnings.push(warning) }),
            ).cues;
            assert.equal(cue.startTime, 1, write.name);
            assert.ok(Math.abs(cue.endTime - 1 - unit) < 1e-12, `${write.name} ${cue.endTime}`);
            assert.deepEqual(
                warnings.map(warning => warning.code),
                ['CUE_LENGTHENED'],
            );
            assert.throws(
                () => write(blink, { validation: 'strict' }),
                error => error.code === 'INPUT',
            );
        }
    });
});

describe('formats/text: editSubtitles()', () => {
    test('cuts overlapping cues, shifts them and keeps their order and blocks', () => {
        const document = text.parseWebVtt(
            'WEBVTT custom\n\nNOTE metadata\n\nold\n00:00.000 --> ' +
                '00:01.000\nbefore\n\nA\n00:01.000 --> 00:04.000\nfirst\n\nB\n00:02.000 --> ' +
                '00:05.000\noverlap\n\nC\n00:06.000 --> 00:07.000\nafter\n',
        );
        const original = structuredClone(document);
        const edited = text.editSubtitles(document, { startTime: 2.5, endTime: 4.5, offset: -2.5 });
        assert.deepEqual(
            edited.cues.map(cue => [cue.id, cue.startTime, cue.endTime]),
            [
                ['A', 0, 1.5],
                ['B', 0, 2],
            ],
        );
        assert.deepEqual(edited.blocks, [
            document.blocks[0],
            { type: 'cue', cueIndex: 0 },
            { type: 'cue', cueIndex: 1 },
        ]);
        assert.equal(edited.header, 'custom');
        assert.deepEqual(text.parseWebVtt(text.writeWebVtt(edited)).cues, edited.cues);
        assert.deepEqual(document, original, 'the document edited stays as it was');
        assert.notEqual(edited.cues[0], document.cues[1]);
        assert.deepEqual(text.editSubtitles(document, { startTime: 5, endTime: 6 }).cues, []);
        assert.deepEqual(text.editSubtitles(document, { startTime: 2, endTime: 2 }).cues, []);
        const reordered = {
            ...document,
            cues: [document.cues[2], document.cues[1]],
            blocks: undefined,
        };
        assert.deepEqual(
            text
                .editSubtitles(reordered, { offset: 1 })
                .cues.map(cue => [cue.id, cue.startTime, cue.endTime]),
            [
                ['B', 3, 6],
                ['A', 2, 5],
            ],
        );
    });

    test('ranges and the times they give are checked: INPUT', () => {
        const document = { format: 'srt', cues, diagnostics: [] };
        for (const options of [
            null,
            [],
            { startTime: -1 },
            { startTime: NaN },
            { endTime: Infinity },
            { startTime: 2, endTime: 1 },
            { offset: Infinity },
            { offset: -1 },
        ])
            assert.throws(
                () => text.editSubtitles(document, options),
                error => error.code === 'INPUT',
                JSON.stringify(options),
            );
        const empty = { ...document, cues: [{ startTime: 1, endTime: 1, text: 'bad' }] };
        assert.throws(
            () => text.editSubtitles(empty, {}),
            error => error.code === 'INPUT',
        );
        assert.deepEqual(text.editSubtitles({ format: 'srt', cues: [], diagnostics: [] }).cues, []);
        assert.deepEqual(text.editSubtitles(document, { startTime: 10 }).cues, []);
    });

    test('edits that would change timing inside a cue are refused', () => {
        const mapped = text.parseWebVtt(
            'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:90000\n\n00:00.000 --> ' +
                '00:04.000\ncaption\n',
        );
        assert.deepEqual(
            text.editSubtitles(mapped, { startTime: 1, endTime: 3 }).timestampMap,
            mapped.timestampMap,
        );
        assert.throws(() => text.editSubtitles(mapped, { offset: 1 }), /timestamp map/i);
        const timed = text.parseWebVtt(
            'WEBVTT\n\n00:00.000 --> 00:04.000\nfirst <00:02.000>second\n',
        );
        assert.throws(() => text.editSubtitles(timed, { offset: 1 }), /inline timestamp/i);
        assert.throws(() => text.editSubtitles(timed, { startTime: 1 }), /inline timestamp/i);
        assert.deepEqual(text.editSubtitles(timed).cues, timed.cues);
        const ass = text.parseAss(
            '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:00.00,0:00:04.00,{\\k100}karaoke\n',
        );
        assert.deepEqual(
            text
                .parseAss(text.writeAss(text.editSubtitles(ass, { offset: 1 })))
                .cues.map(cue => [cue.startTime, cue.endTime, cue.text]),
            [[1, 5, 'karaoke']],
        );
        assert.throws(() => text.editSubtitles(ass, { startTime: 1 }), /timed ASS/i);
        for (const rawText of [
            '{\\t(0,500,\\fs30)}x',
            '{\\move(0,0,10,10)}x',
            '{\\fad(100,100)}x',
            '{\\fade(0,255,0,0,100,200,300)}x',
            '{\\kt100}x',
        ]) {
            const timedAss = {
                ...ass,
                cues: [
                    { ...ass.cues[0], text: 'x', ass: { ...ass.cues[0].ass, text: 'x', rawText } },
                ],
            };
            assert.throws(() => text.editSubtitles(timedAss, { endTime: 2 }), /timed ASS/i);
        }
        for (const Effect of ['Banner;10;0', 'Scroll up;0;100;10']) {
            const fields = { ...ass.cues[0].ass, rawText: 'karaoke', fields: { Effect } };
            const animated = { ...ass, cues: [{ ...ass.cues[0], ass: fields }] };
            assert.throws(() => text.editSubtitles(animated, { startTime: 1 }), /timed ASS/i);
            assert.equal(text.editSubtitles(animated, { offset: 1 }).cues[0].startTime, 1);
        }
        const raw = text.parseSrt('00:00:04,000 --> malformed\nstale\n');
        assert.throws(() => text.editSubtitles(raw, { endTime: 2 }), /raw subtitle block/i);
    });

    test('nested ASS braces are scanned without blowing up', { timeout: 20_000 }, () => {
        const source =
            '[Events]\nFormat: Start, End, Text\nDialogue: 0:00:00.00,0:00:04.00,' +
            '{'.repeat(500000) +
            '}text\n';
        const edited = text.editSubtitles(text.parseAss(source), { startTime: 1 });
        assert.deepEqual([edited.cues[0].startTime, edited.cues[0].text], [1, 'text']);
    });
});
