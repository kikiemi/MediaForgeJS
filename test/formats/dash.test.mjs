import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    iterateDashSegments,
    parseDashManifest,
    parseSidx,
    resolveDashManifest,
} from 'mediaforgejs/streaming';

// Reading a DASH MPD: its periods, representations and the segments each addresses (templates of
// a duration or a timeline, segment lists), their URLs resolved against the BaseURLs, and the
// limits a manifest is read within.

const BASE = 'https://example.test/a/video.mpd';

/** A static MPD of `body` lasting `duration`. */
const mpd = (body, duration = 'PT8S') =>
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ` +
    `mediaPresentationDuration="${duration}">${body}</MPD>`;

/** A period of one representation `id` of `segments` (a SegmentTemplate or SegmentList). */
const single = (id, segments) =>
    `<Period><AdaptationSet><Representation id="${id}">${segments}</Representation>` +
    `</AdaptationSet></Period>`;

/** Each segment of `representation` in `range` as [number, url, presentation time and length]. */
const segmentsOf = (representation, range) =>
    [...iterateDashSegments(representation, range)].map(segment => [
        Number(segment.number),
        segment.url,
        segment.presentationTime,
        segment.presentationDuration,
    ]);

const representations = manifest =>
    manifest.periods.flatMap(period => period.adaptationSets.flatMap(set => set.representations));

describe('formats/dash', () => {
    test('a template of a fixed duration numbers its segments to the end', () => {
        const manifest = parseDashManifest(
            mpd(single('a', '<SegmentTemplate duration="2" media="a-$Number$.m4s"/>'), 'PT4S'),
            { baseUrl: BASE },
        );
        assert.equal(manifest.duration, 4);
        const [representation] = representations(manifest);
        assert.deepEqual(segmentsOf(representation), [
            [1, 'https://example.test/a/a-1.m4s', 0, 2],
            [2, 'https://example.test/a/a-2.m4s', 2, 2],
        ]);
        assert.deepEqual(segmentsOf(representation, { start: 2, end: 4 }), [
            [2, 'https://example.test/a/a-2.m4s', 2, 2],
        ]);
    });

    test('a timeline repeats its entries and names segments by their time', () => {
        const manifest = parseDashManifest(
            mpd(
                single(
                    'v',
                    '<SegmentTemplate timescale="1000" media="v-$Time$.m4s" ' +
                        'initialization="v-init.mp4"><SegmentTimeline>' +
                        '<S t="0" d="2000" r="2"/><S d="1000"/>' +
                        '</SegmentTimeline></SegmentTemplate>',
                ),
            ),
            { baseUrl: BASE },
        );
        const [representation] = representations(manifest);
        assert.equal(representation.initialization.url, 'https://example.test/a/v-init.mp4');
        assert.deepEqual(
            [...iterateDashSegments(representation)].map(segment => [
                String(segment.time),
                String(segment.duration),
                segment.url,
            ]),
            [
                ['0', '2000', 'https://example.test/a/v-0.m4s'],
                ['2000', '2000', 'https://example.test/a/v-2000.m4s'],
                ['4000', '2000', 'https://example.test/a/v-4000.m4s'],
                ['6000', '1000', 'https://example.test/a/v-6000.m4s'],
            ],
        );
    });

    test('a repeat of -1 runs to the end, from the presentation time offset', () => {
        const manifest = parseDashManifest(
            mpd(
                single(
                    'a',
                    '<SegmentTemplate timescale="10" presentationTimeOffset="20" ' +
                        'media="a-$Time$.m4s"><SegmentTimeline><S t="20" d="20" r="-1"/>' +
                        '</SegmentTimeline></SegmentTemplate>',
                ),
                'PT6S',
            ),
            { baseUrl: BASE },
        );
        assert.deepEqual(segmentsOf(representations(manifest)[0]), [
            [1, 'https://example.test/a/a-20.m4s', 0, 2],
            [2, 'https://example.test/a/a-40.m4s', 2, 2],
            [3, 'https://example.test/a/a-60.m4s', 4, 2],
        ]);
    });

    test('periods follow each other, each numbering from its own start number', () => {
        const period = (id, start) =>
            `<Period id="${id}" duration="PT4S"><AdaptationSet><Representation id="${id}">` +
            `<SegmentTemplate duration="2" media="${id}-$Number%03d$.m4s"${start}/>` +
            `</Representation></AdaptationSet></Period>`;
        const manifest = parseDashManifest(
            mpd(period('p1', ' startNumber="5"') + period('p2', '')),
            { baseUrl: BASE },
        );
        assert.deepEqual(
            manifest.periods.map(each => [each.start, each.duration]),
            [
                [0, 4],
                [4, 4],
            ],
        );
        assert.deepEqual(
            representations(manifest).flatMap(each => segmentsOf(each)),
            [
                [5, 'https://example.test/a/p1-005.m4s', 0, 2],
                [6, 'https://example.test/a/p1-006.m4s', 2, 2],
                [1, 'https://example.test/a/p2-001.m4s', 4, 2],
                [2, 'https://example.test/a/p2-002.m4s', 6, 2],
            ],
        );
    });

    test('the BaseURLs of the MPD, period and representation resolve in turn', () => {
        const manifest = parseDashManifest(
            mpd(
                '<BaseURL>cdn/</BaseURL><Period><BaseURL>p/</BaseURL><AdaptationSet>' +
                    '<Representation id="r"><BaseURL>r/</BaseURL><SegmentList duration="4">' +
                    '<Initialization sourceURL="init.mp4"/><SegmentURL media="one.m4s"/>' +
                    '<SegmentURL media="two.m4s" mediaRange="100-199"/></SegmentList>' +
                    '</Representation></AdaptationSet></Period>',
            ),
            { baseUrl: BASE },
        );
        const [representation] = representations(manifest);
        assert.equal(representation.initialization.url, 'https://example.test/a/cdn/p/r/init.mp4');
        assert.deepEqual(
            [...iterateDashSegments(representation)].map(segment => [
                segment.url,
                segment.byteRange,
            ]),
            [
                ['https://example.test/a/cdn/p/r/one.m4s', undefined],
                ['https://example.test/a/cdn/p/r/two.m4s', { offset: 100, length: 100 }],
            ],
        );
    });

    test('a manifest is refused by one rule for each kind of refusal', () => {
        // Malformed (DEMUX), unsupported (FORMAT), an invalid option (INPUT), past a size limit
        // (OOM).
        const template = single('a', '<SegmentTemplate duration="2" media="a-$Number$.m4s"/>');
        assert.throws(() => parseDashManifest('hello'), { code: 'DEMUX', message: /XML/ });
        assert.throws(
            () =>
                parseDashManifest(
                    mpd(
                        single(
                            'a',
                            '<SegmentTemplate media="a-$Number$.m4s"><SegmentTimeline>' +
                                '<S d="0"/></SegmentTimeline></SegmentTemplate>',
                        ),
                    ),
                ),
            { code: 'DEMUX', message: /S@d must be positive/ },
        );
        assert.throws(
            () =>
                parseDashManifest(
                    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">${template}</MPD>`,
                ),
            { code: 'FORMAT', message: /only static MPDs/ },
        );
        assert.throws(() => parseDashManifest(mpd(template), { maxSegments: 0 }), {
            code: 'INPUT',
        });
        assert.throws(() => parseDashManifest(mpd(template), { baseUrl: 'https://a b/' }), {
            code: 'INPUT',
            message: /baseUrl/,
        });
    });

    test('segments past maxSegments reach a size limit, when read and when selected', () => {
        const xml = mpd(single('a', '<SegmentTemplate duration="2" media="a-$Number$.m4s"/>'));
        assert.throws(() => parseDashManifest(xml, { maxSegments: 3 }), {
            code: 'OOM',
            message: /exceeds maxSegments/,
        });
        const [representation] = representations(parseDashManifest(xml));
        assert.throws(() => [...iterateDashSegments(representation, { maxSegments: 2 })], {
            code: 'OOM',
            message: /selected segment count exceeds maxSegments/,
        });
    });
});

/** A sidx box of `references` ([size, duration] each) in `timescale` ticks, 32 + 12n bytes. */
function sidx(references, { version = 0, timescale = 1000 } = {}) {
    const bytes = new Uint8Array(32 + 12 * references.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes.set([0x73, 0x69, 0x64, 0x78], 4);
    view.setUint32(8, version << 24);
    view.setUint32(12, 1);
    view.setUint32(16, timescale);
    view.setUint16(30, references.length);
    for (const [index, [size, duration]] of references.entries()) {
        view.setUint32(32 + index * 12, size);
        view.setUint32(36 + index * 12, duration);
        view.setUint32(40 + index * 12, 0x90000000);
    }
    return bytes;
}

describe('formats/dash: indexes', () => {
    /** An MPD of one representation addressed by the sidx at bytes 100 to 155 of a.mp4. */
    const indexed = mpd(
        single(
            'a',
            '<BaseURL>a.mp4</BaseURL><SegmentBase indexRange="100-155" indexRangeExact="true"/>',
        ),
        'PT4S',
    );

    test('a SegmentBase index is read from its sidx through the caller', async () => {
        const asked = [];
        const manifest = await resolveDashManifest(indexed, {
            baseUrl: BASE,
            readIndex: async request => {
                asked.push([request.url, request.byteRange]);
                return sidx([
                    [1000, 2000],
                    [1200, 2000],
                ]);
            },
        });
        assert.deepEqual(asked, [['https://example.test/a/a.mp4', { offset: 100, length: 56 }]]);
        const [representation] = representations(manifest);
        assert.deepEqual(
            [...iterateDashSegments(representation)].map(segment => [
                segment.url,
                segment.byteRange,
                segment.presentationTime,
            ]),
            [
                ['https://example.test/a/a.mp4', { offset: 156, length: 1000 }, 0],
                ['https://example.test/a/a.mp4', { offset: 1156, length: 1200 }, 2],
            ],
        );
    });

    test('an index is refused by the same rule as the manifest', async () => {
        // Each index holds two references, the 56 bytes the MPD gives its range.
        const resolved = (index, options) =>
            resolveDashManifest(indexed, {
                baseUrl: BASE,
                readIndex: async () => index,
                ...options,
            });
        const two = () =>
            sidx([
                [1000, 2000],
                [1000, 2000],
            ]);
        const empty = two();
        empty.fill(0, 36, 40);
        await assert.rejects(resolved(empty), {
            code: 'DEMUX',
            message: /positive size and duration/,
        });
        const hierarchical = two();
        hierarchical[32] |= 0x80;
        await assert.rejects(resolved(hierarchical), { code: 'FORMAT', message: /hierarchical/ });
        await assert.rejects(resolved(two(), { readIndex: undefined }), {
            code: 'INPUT',
            message: /readIndex/,
        });
        await assert.rejects(resolved(two(), { maxIndexReferences: 1 }), {
            code: 'OOM',
            message: /maxReferences/,
        });
    });

    test('a sidx box is refused by the same rule', () => {
        const box = sidx([
            [1000, 2000],
            [1200, 2000],
        ]);
        assert.equal(parseSidx(box).references.length, 2);
        assert.throws(() => parseSidx(box.subarray(0, 40)), { code: 'DEMUX' });
        assert.throws(() => parseSidx(sidx([[1, 1]], { timescale: 0 })), {
            code: 'DEMUX',
            message: /timescale/,
        });
        assert.throws(() => parseSidx(sidx([[1, 1]], { version: 2 })), {
            code: 'FORMAT',
            message: /unsupported version/,
        });
        assert.throws(() => parseSidx(box, { maxReferences: 0 }), { code: 'INPUT' });
        assert.throws(() => parseSidx(box, { maxReferences: 1 }), {
            code: 'OOM',
            message: /maxReferences/,
        });
    });
});
