import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distUrl } from '../helpers/dist-paths.mjs';

const model = path => import(distUrl(`esm/core/model/${path}.js`));
const window = await model('audio-window');
const layout = await model('channel-layout');

/** The (left, right) weights of each plane of a layout folded to stereo. */
const stereo = (channels, mask) => {
    const [left, right] = layout.mixWeights(channels, mask, 2, undefined);
    return { left, right };
};
const { videoEncoderCodecs } = await model('codec-level');
const names = await model('codec-names');
const strings = await model('codec-strings');
const { decodeTime, secondsToTicks } = await model('media-time');
const decoders = await model('decoder-codecs');
const tags = await model('media-tags');
const { sampleClockTolerance } = await model('sample-clock');
const index = await model('sample-index');

const HD = { width: 1920, height: 1080, framerate: 30, bitrate: 5e6 };

describe('model', () => {
    describe('presentation windows', () => {
        test('an edit in media units becomes samples at a rate, rounded', () => {
            const track = { editPresentationDurationUnits: 1001, timescale: 30000 };
            assert.equal(window.editPresentationSamples(track, 48000, 10000, 'Audio'), 1602);
            assert.equal(
                window.editPresentationSamples(track, 48000, 1000, 'Audio'),
                1000,
                'at most what is coded',
            );
        });

        test('an edit in seconds is used without media units; no edit is FORMAT', () => {
            assert.equal(
                window.editPresentationSamples(
                    { editPresentationDurationSeconds: 0.5 },
                    8000,
                    9999,
                    'A',
                ),
                4000,
            );
            assert.throws(() => window.editPresentationSamples({}, 8000, 10, 'A'), {
                code: 'FORMAT',
                message: 'A has no presentation edit',
            });
            assert.throws(
                () =>
                    window.editPresentationSamples(
                        { editPresentationDurationSeconds: 1 },
                        1.5,
                        10,
                        'A',
                    ),
                { code: 'FORMAT' },
            );
        });

        test('a head and valid window must fit the coded samples', () => {
            window.assertPresentationWindow('A', 10, 2, 8);
            assert.throws(() => window.assertPresentationWindow('A', 10, 3, 8), {
                code: 'FORMAT',
                message: /runs past its 10 encoded samples/,
            });
            assert.throws(() => window.assertPresentationWindow('A', 10, 0, 0), { code: 'FORMAT' });
        });

        test('an applied edit list presents its window; otherwise all is presented', () => {
            const edited = {
                editList: [],
                presentationTimestampsIncludeEdits: true,
                editLeadTimeSeconds: 1,
                editPresentationDurationSeconds: 2,
            };
            const span = window.editPresentationWindow(edited);
            assert.deepEqual(span, { start: 1, end: 3 });
            assert.deepEqual(
                [0.9999995, 1, 2.999, 2.9999995].map(time =>
                    window.insidePresentationWindow(span, time),
                ),
                [true, true, true, false],
                'to a microsecond',
            );
            assert.deepEqual(window.editPresentationWindow({}), {
                start: -Infinity,
                end: Infinity,
            });
        });
    });

    describe('channel layouts', () => {
        test('default masks follow WAVE for one to eight channels', () => {
            assert.deepEqual([1, 2, 6, 8].map(layout.defaultChannelMask), [0x4, 0x3, 0x3f, 0x63f]);
            assert.equal(layout.defaultChannelMask(9), undefined);
        });

        test('a mask counts only when it names one speaker per plane', () => {
            assert.equal(layout.layoutMask(6, 0x60f), 0x60f);
            assert.equal(layout.layoutMask(6, 0x3), 0x3f, 'two speakers for six planes');
            assert.equal(layout.layoutMask(2, 0), 0x3);
            assert.equal(layout.layoutMask(2, 0x80000003), 0x3, 'three speakers for two planes');
        });

        test('folds 5.1 to stereo with BS.775 weights, dropping LFE', () => {
            const { left, right } = stereo(6, 0x3f);
            const h = Math.SQRT1_2;
            assert.deepEqual([...left], [1, 0, h, 0, h, 0]);
            assert.deepEqual([...right], [0, 1, h, 0, 0, h]);
        });

        test('a mask that does not fit folds as the default layout', () => {
            const { left } = stereo(3, 0x3);
            assert.deepEqual([...left], [1, 0, Math.SQRT1_2], 'L R C');
        });

        test('planes without a known speaker fold in at one half', () => {
            const { left, right } = stereo(9, undefined);
            assert.deepEqual([...left], Array(9).fill(0.5));
            assert.deepEqual([...right], Array(9).fill(0.5));
        });

        test('every WAVE speaker folds to stereo with its BS.775 weights', () => {
            const h = Math.SQRT1_2;
            // FL FR FC LFE BL BR FLC FRC BC SL SR TC TFL TFC TFR TBL TBC TBR
            const expected = [
                [1, 0],
                [0, 1],
                [h, h],
                [0, 0],
                [h, 0],
                [0, h],
                [1, 0],
                [0, 1],
                [0.5, 0.5],
                [h, 0],
                [0, h],
                [0.5, 0.5],
                [h, 0],
                [0.5, 0.5],
                [0, h],
                [h, 0],
                [0.5, 0.5],
                [0, h],
            ];
            expected.forEach(([l, r], bit) => {
                const { left, right } = stereo(1, 1 << bit);
                assert.deepEqual([left[0], right[0]], [l, r], `speaker bit ${bit}`);
            });
        });

        test('7.1 plays on 5.1 with each side in the back of its side', () => {
            const rows = layout.mixWeights(8, 0x63f, 6, 0x3f).map(row => [...row]);
            assert.deepEqual(rows, [
                [1, 0, 0, 0, 0, 0, 0, 0],
                [0, 1, 0, 0, 0, 0, 0, 0],
                [0, 0, 1, 0, 0, 0, 0, 0],
                [0, 0, 0, 1, 0, 0, 0, 0],
                [0, 0, 0, 0, 1, 0, 1, 0],
                [0, 0, 0, 0, 0, 1, 0, 1],
            ]);
        });

        test('a speaker folds into the first alternative the output has; LFE is dropped', () => {
            assert.deepEqual(layout.speakerFold(layout.SL, 0x3f), [layout.BL, 1]);
            assert.deepEqual(layout.speakerFold(layout.SL, 0x7), [layout.FL, Math.SQRT1_2]);
            assert.deepEqual(layout.speakerFold(layout.FC, 0x3), [0x3, Math.SQRT1_2]);
            assert.equal(layout.speakerFold(layout.LFE, 0x3), undefined);
            assert.deepEqual(layout.speakerFold(0, 0x4), [layout.FC, Math.SQRT1_2]);
            assert.deepEqual(layout.maskSpeakers(0x3f), [1, 2, 4, 8, 16, 32]);
        });

        test('element and Vorbis orders are permutations of their planes', () => {
            for (const orders of [layout.ELEMENT_ORDER, layout.VORBIS_ORDER])
                orders.forEach((order, channels) =>
                    assert.deepEqual([...order].sort(), [...Array(channels + 1).keys()]),
                );
            assert.deepEqual(layout.VORBIS_ORDER[5], [0, 2, 1, 4, 5, 3], 'L C R Ls Rs LFE');
            assert.deepEqual(layout.ELEMENT_ORDER[5], [2, 0, 1, 4, 5, 3], 'C L R Ls Rs LFE');
        });
    });

    describe('codec names and strings', () => {
        test('everyday names map to codec strings; others pass through', () => {
            assert.deepEqual(
                ['H.264', 'hevc', ' VP9 ', 'av1', 'theora'].map(names.canonicalVideoCodec),
                ['avc1', 'hvc1', 'vp09', 'av01', 'theora'],
            );
            assert.deepEqual(['aac', 'E-AC-3', 'µ-law', 'opus'].map(names.canonicalAudioCodec), [
                'mp4a.40.2',
                'ec-3',
                'ulaw',
                'opus',
            ]);
        });

        test('codec strings have everyday display names', () => {
            assert.deepEqual(
                [
                    'avc1.640028',
                    'hev1.1.6.L93.B0',
                    'vp09.00.10.08',
                    'av01.0.04M.08',
                    'mp4a.40.5',
                    'mp4a.6B',
                    'opus',
                ].map(names.codecDisplayName),
                ['h264', 'hevc', 'vp9', 'av1', 'aac', 'mp3', 'opus'],
            );
        });

        test('folds the family to lower case and keeps the rest', () => {
            assert.equal(names.foldCodecString('AVC1.64001F'), 'avc1.64001F');
            assert.equal(names.foldCodecString('OPUS'), 'opus');
        });

        test('accepts complete, consistent codec strings only', () => {
            for (const good of [
                'avc1.42e01e',
                'vp09.02.10.10',
                'av01.0.04M.08',
                'av01.2.12H.12',
                'hvc1.1.6.L93.B0',
                'vp8',
            ])
                assert.equal(names.isCodecString('video', good), true, good);
            for (const bad of [
                'avc1.42e01',
                'vp09.00.10.10',
                'vp09.00.99.08',
                'av01.0.04H.08',
                'av01.0.04M.12',
                'h264',
            ])
                assert.equal(names.isCodecString('video', bad), false, bad);
            assert.equal(names.isCodecString('audio', 'mp4a.40.2'), true);
            assert.equal(names.isCodecString('audio', 'wma'), false);
        });

        test('families, object types and kinds of codec strings', () => {
            assert.deepEqual(
                ['mp4v.20.9', 'mp4v.61', 'mp4v.6a', 'mp4v.40'].map(strings.mpegVideoFamily),
                ['mpeg4v', 'mpeg2v', 'mpeg1v', null],
            );
            assert.deepEqual(
                ['aac', 'avc3.64001f', 'hev1.x', 'vp9', 'mp4a.40.2'].map(strings.codecFamily),
                ['mp4a', 'avc', 'hev1', 'vp09', 'mp4a'],
            );
            assert.deepEqual(
                ['mp4a.40.42', 'mp4a.40.2', 'mp4a.6B'].map(strings.mp4aAudioObjectType),
                [42, 2, null],
            );
            assert.equal(
                strings.audioHasKeyframes('mp4a.40.42'),
                true,
                'USAC has independent frames',
            );
            assert.deepEqual(['mp2', 'mp1', 'opus'].map(strings.webCodecsAudioCodec), [
                'mp3',
                'mp3',
                'opus',
            ]);
            assert.deepEqual(
                [
                    strings.isDtsCodec('dtsl'),
                    strings.isPcmCodec('pcm-s24le'),
                    strings.isProResCodec('apch'),
                    strings.isHevcCodec('dvh1.08.06'),
                ],
                [true, true, true, true],
            );
        });

        test('the built-in video decoders name the strings they take', () => {
            assert.equal(decoders.isH264Codec('avc1.42E01E'), true);
            assert.equal(decoders.isH264Codec('avc2'), false);
            assert.equal(decoders.isMpeg12VideoCodec('mp4v.6A'), true);
            assert.equal(decoders.isMpeg12VideoCodec('mp4v.66'), false);
            assert.equal(decoders.isMpeg4VisualCodec('s263'), true);
            assert.equal(decoders.isMpeg4VisualCodec(42), false);
        });
    });

    describe('encoder codec levels', () => {
        test('AVC tries High, Main and Baseline at the level the output needs', () => {
            assert.deepEqual(videoEncoderCodecs('avc1', HD, false), [
                'avc1.640028',
                'avc1.4d0028',
                'avc1.42e028',
            ]);
        });

        test('an explicit profile is kept and only a level too low is raised', () => {
            assert.deepEqual(videoEncoderCodecs('avc1.64000a', HD, true), ['avc1.640028']);
            assert.deepEqual(videoEncoderCodecs('avc1.640033', HD, true), ['avc1.640033']);
        });

        test('10-bit sources ask for 10-bit profiles', () => {
            assert.deepEqual(videoEncoderCodecs('hvc1', { ...HD, bitDepth: 10 }, false), [
                videoEncoderCodecs('hvc1', HD, false)[1],
            ]);
            assert.match(
                videoEncoderCodecs('vp09', { ...HD, bitDepth: 10 }, false)[0],
                /^vp09\.02\.\d{2}\.10$/,
            );
            assert.match(
                videoEncoderCodecs('av01', { ...HD, bitDepth: 10 }, false)[0],
                /^av01\.0\.\d{2}M\.10$/,
            );
        });

        test('other codecs are asked for as named', () => {
            assert.deepEqual(videoEncoderCodecs('vp8', HD, false), ['vp8']);
        });
    });

    describe('times and tags', () => {
        test('decode time falls back to presentation time', () => {
            assert.equal(decodeTime({ timestamp: 2, decodeTimestamp: 1 }), 1);
            assert.equal(decodeTime({ timestamp: 2 }), 2);
        });

        test('a time is whole ticks within its field, else MUX', () => {
            assert.equal(secondsToTicks(1.5, 90000, 'PTS'), 135000);
            // Halves go up, as Math.round; floor and ceil are asked for.
            assert.equal(secondsToTicks(0.5, 5, 'time'), 3);
            assert.equal(secondsToTicks(-0.5, 5, 'time'), -2);
            assert.equal(secondsToTicks(0.0029, 1000, 'time', { rounding: 'floor' }), 2);
            assert.equal(secondsToTicks(0.0021, 1000, 'time', { rounding: 'ceil' }), 3);
            for (const [seconds, options] of [
                [NaN, {}],
                [Infinity, {}],
                [2 ** 53, {}],
                [-0.01, { min: 0 }],
                [4294967.296, { max: 0xffffffff }],
            ])
                assert.throws(() => secondsToTicks(seconds, 1000, 'FLV timestamp', options), {
                    code: 'MUX',
                    message: /^FLV timestamp is outside the exact integer range/,
                });
            assert.equal(
                secondsToTicks(4294967.295, 1000, 'time', { max: 0xffffffff }),
                0xffffffff,
            );
        });

        test('a coarse timestamp clock widens the sample tolerance', () => {
            assert.equal(sampleClockTolerance({ sampleRate: 48000 }), 0.5);
            assert(
                Math.abs(
                    sampleClockTolerance({ sampleRate: 48000, timestampResolutionSeconds: 0.001 }) -
                        48,
                ) < 1e-6,
            );
            assert.throws(
                () => sampleClockTolerance({ sampleRate: 48000, timestampResolutionSeconds: 0 }),
                { code: 'DEMUX' },
            );
        });

        test('tags drop empty values and sort chapters', () => {
            assert.equal(tags.mediaTags([{ key: 'title', value: ' ' }]), undefined);
            const made = tags.mediaTags(
                [{ key: 'title', value: 'T' }],
                [{ start: 5 }, { start: 1 }],
            );
            assert.deepEqual(
                made.chapters.map(chapter => chapter.start),
                [1, 5],
            );
            assert.equal(tags.mediaTag(made, 'title'), 'T');
            assert.equal(tags.hasMediaTags(undefined), false);
        });

        test('open chapters end at the next one, the last at the file end', () => {
            const ended = tags.withChapterEnds(
                { entries: [], chapters: [{ start: 0 }, { start: 4, end: 6 }, { start: 8 }] },
                10,
            );
            assert.deepEqual(
                ended.chapters.map(chapter => chapter.end),
                [4, 6, 10],
            );
        });

        test('names what a writer that keeps less loses', () => {
            const lost = tags.lostTagParts(
                {
                    entries: [
                        { key: 'title', value: 'T' },
                        { key: 'isrc', value: 'X' },
                    ],
                    chapters: [{ start: 0 }],
                    pictures: [{ mimeType: 'image/png', data: new Uint8Array(1) }],
                },
                {
                    entries: key => tags.COMMON_TAG_KEYS.has(key),
                    pictures: type => type === 'image/jpeg',
                },
            );
            assert.deepEqual(lost, ['tags (isrc)', 'chapters', 'pictures']);
        });
    });

    describe('sample indexes', () => {
        test('a packed index returns the samples it was given, in seconds', () => {
            const packed = new index.PackedSampleIndex(1000, 0.5);
            packed.push(100, 10, 0, 20, 40, true, false);
            packed.push(110, 30, 40, 0, 0, false, true);
            packed.finish();
            assert.deepEqual(packed.get(0), {
                offset: 100,
                size: 10,
                timestamp: 0.52,
                decodeTimestamp: 0.5,
                compositionTimeOffset: 0.02,
                duration: 0.04,
                isKeyframe: true,
            });
            assert.equal(packed.get(1).leadingDiscard, true);
            assert.equal(packed.get(1).duration, 0.04, 'a zero duration takes the previous one');
            assert.deepEqual(
                [
                    packed.length,
                    packed.maxSampleSize,
                    packed.allKeyframes,
                    packed.presentationSorted,
                    packed.byteLength,
                ],
                [2, 30, false, true, 74],
            );
        });

        test('trailing samples decoding at or after a time can be dropped', () => {
            const packed = new index.PackedSampleIndex(10, 0);
            for (let at = 0; at < 5; at++) packed.push(at, 1, at, 0, 1, true, false);
            assert.equal(packed.dropFrom(3), 2);
            assert.equal(packed.length, 3);
        });

        test('a compact index stands for track.samples until they are read', () => {
            const packed = new index.PackedSampleIndex(1, 0);
            for (let at = 0; at < 3; at++) packed.push(at * 10, 10, at, 0, 1, at === 0, false);
            packed.finish();
            const track = {};
            index.bindCompactSampleIndex(track, packed);
            assert.equal(index.sampleCount(track), 3);
            assert.equal(index.sampleAt(track, 2).offset, 20);
            assert.equal(index.sampleAt(track, 3), undefined);
            assert.equal(track.samples.length, 3, 'reading samples builds the array');
            assert.equal(index.getCompactSampleIndex(track), undefined, 'and drops the index');
        });

        test('skipping leading samples shifts the view and its summary', () => {
            const packed = new index.PackedSampleIndex(1, 0);
            packed.push(0, 1, 0, 0, 1, false, false);
            packed.push(1, 1, 1, 0, 1, true, false);
            packed.finish();
            const view = index.skipLeadingSamples(packed, 1);
            assert.deepEqual(
                [view.length, view.allKeyframes, view.firstPresentation, view.get(0).offset],
                [1, true, 1, 1],
            );
        });

        for (const sealed of [false, true])
            test(`a bound index builds samples once${sealed ? ', on a sealed track' : ''}`, () => {
                const compact = {
                    length: 2,
                    get: at => ({ offset: at, size: 1, timestamp: at, duration: 1 }),
                };
                const track = {
                    id: 1,
                    codec: 'opus',
                    duration: 2,
                    samples: [],
                    codecConfig: undefined,
                };
                if (sealed) Object.preventExtensions(track);
                let reserved = 0;
                index.bindCompactSampleIndex(track, compact, () => reserved++);
                assert.equal(index.getCompactSampleIndex(track), compact);
                assert.deepEqual(Object.keys(track), [
                    'id',
                    'codec',
                    'duration',
                    'samples',
                    'codecConfig',
                ]);
                const copy = { ...track };
                assert.equal(reserved, 1);
                assert.deepEqual(
                    copy.samples.map(sample => sample.offset),
                    [0, 1],
                );
                assert.equal(index.getCompactSampleIndex(track), undefined);
                assert.equal(track.samples, copy.samples);
                assert.equal(Object.getOwnPropertyDescriptor(track, 'samples').writable, true);
                // An index released for the file's reads still builds the samples.
                const other = { id: 2, codec: 'opus', duration: 2, samples: [] };
                if (sealed) Object.preventExtensions(other);
                index.bindCompactSampleIndex(other, compact);
                index.releaseSampleIndex(other);
                assert.equal(index.getCompactSampleIndex(other), undefined);
                assert.equal(other.samples.length, 2);
            });

        test('plain sample arrays are read as they are', () => {
            const track = { samples: [{ offset: 7 }] };
            assert.deepEqual([index.sampleCount(track), index.sampleAt(track, 0).offset], [1, 7]);
        });

        test('sample bytes come inline, from a bound packet reader or the range', async () => {
            const source = { size: 8, read: async (offset, size) => Uint8Array.of(offset, size) };
            const track = {};
            const packets = { read: async (_source, sample) => Uint8Array.of(sample.packetSkip) };
            index.bindPacketizedReader(track, packets);
            const read = async (sample, of = track) => [
                ...(await index.readSampleBytes(of, sample, source)),
            ];
            assert.deepEqual(await read({ data: Uint8Array.of(9), offset: 1, size: 1 }), [9]);
            assert.deepEqual(await read({ offset: 2, size: 3, packetSkip: 5 }), [5]);
            assert.deepEqual(await read({ offset: 2, size: 3 }), [2, 3]);
            assert.deepEqual(
                await read({ offset: 2, size: 3, packetSkip: 5 }, {}),
                [2, 3],
                'no reader bound to the track',
            );
        });
    });
});
