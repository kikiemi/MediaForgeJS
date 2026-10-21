import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { readerPart } from '../helpers/parts.mjs';
import { allPackets, readMedia } from '../helpers/read-media.mjs';

// What a copy does with metadata its target cannot keep: under the default policy it warns and
// copies; under metadataPolicy 'error' check() says so and the copy fails with FORMAT before it
// writes anything. What the target can keep, it keeps.

const FRAME = (await encodeAacLc([new Float32Array(1024)], { sampleRate: 48000, bitrate: 64 }))
    .frames[0];
const AAC = {
    id: 1,
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    channelCount: 1,
    width: 0,
    height: 0,
    duration: 1024 / 48000,
    codecConfig: Uint8Array.of(0x11, 0x88),
    samples: [
        {
            offset: 0,
            size: FRAME.length,
            data: FRAME,
            timestamp: 0,
            duration: 1024 / 48000,
            isKeyframe: true,
        },
    ],
};

/** A plugin whose reader of `format` returns one AAC track with `track` fields and `extra`. */
const reading = (format, track = {}, extra = {}) => ({
    name: 'fixture',
    readers: [
        readerPart({
            formats: [format],
            read: async () => ({
                duration: 1024 / 48000,
                videoTracks: [],
                audioTracks: [{ ...AAC, ...track }],
                ...extra,
            }),
        }),
    ],
});

/**
 * Opens one AAC track whose private-use language MP4 cannot store, named '日本語', with a
 * Matroska title, through a plugin reader, with `options` (whose inherited fields count too).
 */
const openPrivate = (options = {}) =>
    open(
        new Uint8Array(1),
        Object.assign(options, {
            format: 'custom',
            plugins: {
                add: [
                    reading(
                        'custom',
                        { language: 'x-private', name: '日本語', default: true, forced: false },
                        { matroskaPassThrough: { title: 'Title' } },
                    ),
                ],
            },
        }),
    );

/** One AAC frame in Matroska, its track given `fields`. */
async function matroskaAac(fields = {}) {
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            audio: {
                id: 1,
                type: 'audio',
                codec: AAC.codec,
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: AAC.codecConfig,
                ...fields,
            },
        },
        sink,
    );
    muxer.addAudioChunk({
        data: FRAME,
        timestamp: 0,
        duration: 1024 / 48000,
        isKeyframe: true,
        trackType: 'audio',
    });
    await muxer.finalize();
    return sink.toBlob('video/x-matroska');
}

describe('copy: metadata', () => {
    describe('a language MP4 cannot store', () => {
        for (const validation of ['strict', 'compatible'])
            test(`with policy 'error' fails check and copy alike (${validation})`, async () => {
                const warnings = [];
                let reads = 0;
                // The policy is read once, when the file opens.
                const options = Object.create({
                    get metadataPolicy() {
                        reads++;
                        return 'error';
                    },
                });
                Object.assign(options, {
                    validation,
                    onWarning: warning => warnings.push(warning),
                });
                const media = await openPrivate(options);
                try {
                    assert.equal(reads, 1);
                    const plan = await media.check('mp4', { copy: true });
                    assert.deepEqual([plan.supported, plan.code], [false, 'FORMAT']);
                    assert.ok(plan.warnings.some(({ code }) => code === 'MP4_LANGUAGE_LOSS'));
                    assert.equal(warnings.length, 0, 'a check notifies no listener');
                    const sink = new MemorySink();
                    await assert.rejects(media.convert('mp4', { copy: true, sink }), {
                        code: 'FORMAT',
                    });
                    assert.equal(sink.size, 0);
                    assert.equal(warnings.length, 1);
                    assert.equal((await media.check('mkv', { copy: true })).supported, true);
                    assert.ok((await media.convert('mkv', { copy: true })).blob.size > 0);
                } finally {
                    media.close();
                }
            });

        test('by default is reported once and the copy goes on', async () => {
            const warnings = [];
            const media = await openPrivate({
                validation: 'strict',
                onWarning: warning => warnings.push(warning),
            });
            try {
                const plan = await media.check('mp4', { copy: true });
                assert.equal(plan.supported, true, JSON.stringify(plan));
                assert.equal(warnings.length, 0);
                const codes = plan.warnings.map(warning => warning.code);
                assert.ok(codes.includes('MP4_LANGUAGE_LOSS'));
                // The title and the name MP4 keeps.
                assert.ok(!codes.includes('MATROSKA_METADATA_LOSS'));
                assert.ok(!codes.includes('TRACK_DISPOSITION_LOSS'));
                const sink = new MemorySink();
                await media.convert('mp4', { copy: true, sink });
                assert.ok(sink.size > 0);
                assert.equal(warnings.length, 1);
                const [packet] = await allPackets(sink.toUint8Array());
                assert.deepEqual(packet.data, FRAME);
            } finally {
                media.close();
            }
        });
    });

    describe("into M4A with policy 'error'", () => {
        const input = () => matroskaAac();
        for (const [label, track, extra, keptOf, kept] of [
            [
                'a Matroska title',
                {},
                { matroskaPassThrough: { title: 'Title' } },
                read => read.title,
                'Title',
            ],
            ['a track name', { name: 'Main' }, {}, read => read.tracks[0].track.name, 'Main'],
            [
                'a BCP 47 language',
                { language: 'ja-JP' },
                {},
                read => read.tracks[0].track.language,
                'ja-JP',
            ],
        ])
            test(`${label} is kept`, async () => {
                const sink = new MemorySink();
                await convert(await input(), 'm4a', {
                    plugins: { add: [reading('mkv', track, extra)] },
                    open: { metadataPolicy: 'error' },
                    sink,
                });
                assert.equal(keptOf(await readMedia(sink.toUint8Array())), kept);
            });

        test('unsupported Matroska metadata fails before anything is written', async () => {
            const sink = new MemorySink();
            await assert.rejects(
                convert(await input(), 'm4a', {
                    plugins: { add: [reading('mkv', {}, { matroskaUnsupportedTags: true })] },
                    open: { metadataPolicy: 'error' },
                    sink,
                }),
                error => error.code === 'FORMAT' && !/Unknown option/.test(error.message),
            );
            assert.equal(sink.size, 0);
        });
    });

    test("a copy into MP4 with policy 'error' keeps the track name", async () => {
        const sink = new MemorySink();
        await convert(await matroskaAac({ name: 'Main' }), 'mp4', {
            open: { metadataPolicy: 'error' },
            sink,
        });
        assert.equal((await readMedia(sink.toUint8Array())).tracks[0].track.name, 'Main');
    });

    test("policy 'warn' keeps converting", async () => {
        const { blob } = await convert(await matroskaAac({ name: 'Main' }), 'm4a', {
            open: { metadataPolicy: 'warn' },
        });
        assert.ok(blob.size > 0);
    });

    test("a Matroska copy with policy 'error' keeps name, language and flags", async () => {
        const source = await matroskaAac({ name: 'Main', default: false, language: 'ja-JP' });
        const { blob } = await convert(source, 'mkv', { open: { metadataPolicy: 'error' } });
        const fields = async input =>
            (await readMedia(input)).tracks.map(({ track }) => [
                track.name,
                track.language,
                track.default,
            ]);
        assert.deepEqual(await fields(blob), await fields(source));
    });

    test("malformed optional metadata is copied around, or fails under 'error'", async () => {
        // A FlagDefault of 2.
        const bytes = new Uint8Array(await (await matroskaAac({ default: false })).arrayBuffer());
        const at = bytes.findIndex(
            (value, index) => value === 0x88 && bytes[index + 1] === 0x81 && bytes[index + 2] === 0,
        );
        assert.ok(at >= 0);
        bytes[at + 2] = 2;
        const source = new Blob([bytes]);
        assert.ok((await convert(source, 'mkv')).blob.size > 0);
        await assert.rejects(
            convert(source, 'mkv', { open: Object.create({ metadataPolicy: 'error' }) }),
            { code: 'FORMAT' },
        );
    });
});
