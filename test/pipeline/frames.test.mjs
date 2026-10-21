import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { avi, createPicture, h264, mpeg4 } from 'mediaforgejs/plugins';
// The frame index has no public face.
import { indexedFrames } from '../../dist/esm/pipeline/frames/frame-index.js';
import {
    PICTURE,
    codes,
    patternDecoderPlugin,
    patternPicture,
    pngRgba,
    vp8Clip,
} from '../helpers/api-fixtures.mjs';
import { avcc, aviH264, idr, lengthPrefixed, predicted } from '../helpers/avi-h264-fixtures.mjs';
import {
    PICTURE_B,
    mpeg2Gop,
    mpegSequence,
    programStream,
} from '../helpers/mpeg-video-fixtures.mjs';
import { SHORT_HEADER_FIXTURE } from '../helpers/mpeg4-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { maskedDifference, patternRgba, transformedPattern } from '../helpers/pattern.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// frames() and thumbnail(): which pictures a request decodes and shows, from where decoding
// starts, and how they are cropped, turned, scaled and shown upright, through a plugin decoder
// that shows a known pattern.

const { width, height, block } = PICTURE;
const times = frames => frames.map(frame => Math.round(frame.timestamp * 10) / 10);

function setup() {
    const { plugin, decoded } = patternDecoderPlugin();
    const warnings = [];
    const forge = new MediaForge({
        plugins: { add: [plugin] },
        onWarning: warning => warnings.push(warning),
    });
    const collect = async (input, options) => {
        const frames = [];
        for await (const frame of forge.frames(input, options)) frames.push(frame);
        return frames;
    };
    return { forge, decoded, warnings, collect };
}

describe('pipeline/frames', () => {
    describe('which pictures', () => {
        test('every picture by default, converted from I420 to RGBA', async () => {
            const { collect } = setup();
            const all = await collect(await vp8Clip());
            assert.deepEqual(times(all), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
            const identity = transformedPattern({
                sourceWidth: width,
                sourceHeight: height,
                block,
                width,
                height,
            });
            assert.ok(maskedDifference(all[0].data, identity.rgba, identity.mask) < 3);
        });

        test('requested times keep their order', async () => {
            const { collect } = setup();
            assert.deepEqual(
                times(await collect(await vp8Clip(), { times: [0.35, 0.05, 0.9] })),
                [0.3, 0, 0.9],
            );
        });

        test('a time a rounding error before a picture shows that picture', async () => {
            const { collect } = setup();
            // 0.3 - 0.1 is 0.19999999999999998.
            assert.deepEqual(times(await collect(await vp8Clip(), { times: [0.3 - 0.1] })), [0.2]);
        });

        test('every and maxFrames step through the input', async () => {
            const { collect } = setup();
            assert.deepEqual(
                times(await collect(await vp8Clip(), { every: 0.25, maxFrames: 3 })),
                [0, 0.2, 0.5],
            );
        });

        test('times before the first decodable picture show that picture once', async () => {
            const { collect } = setup();
            const lateKey = await vp8Clip({ keyframe: index => index === 5 });
            assert.deepEqual(times(await collect(lateKey, { every: 0.25 })), [0.5, 0.7]);
        });

        test('a last sync sample without a picture gives way to the keyframe', async () => {
            const { collect } = setup();
            const ended = await vp8Clip({
                keyframe: index => index % 5 === 0 || index === 9,
                payload: index => Uint8Array.of(index === 9 ? 0xff : index),
            });
            assert.deepEqual(times(await collect(ended, { times: [0.95, 0.3] })), [0.8, 0.3]);
        });

        test('a later time starts decoding at the keyframe before it', async () => {
            const { collect, decoded } = setup();
            await collect(await vp8Clip(), { times: [0.75] });
            assert.deepEqual(decoded, [0.5, 0.6, 0.7, 0.8]);
        });
    });

    describe('large inputs', () => {
        /** 400 s of 4 KiB VP8 pictures (16 MB) in Matroska with Cues, and its bytes read. */
        async function largeSource() {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: { id: 1, type: 'video', codec: 'vp8', width, height, framerate: 10 },
                },
                sink,
            );
            for (let index = 0; index < 4000; index++)
                muxer.addVideoChunk({
                    data: new Uint8Array(4096),
                    timestamp: index / 10,
                    duration: 0.1,
                    isKeyframe: index % 10 === 0,
                    trackType: 'video',
                });
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            const source = {
                size: bytes.length,
                async read(offset, length) {
                    source.bytesRead += length;
                    return bytes.slice(offset, offset + length);
                },
                bytesRead: 0,
            };
            return source;
        }

        test('times of a large Matroska file read a window placed by its Cues', async () => {
            const { collect } = setup();
            const source = await largeSource();
            assert.deepEqual(times(await collect(source, { times: [200.05, 201] })), [200, 201]);
            assert.ok(source.bytesRead < source.size / 2, `${source.bytesRead} of ${source.size}`);
        });

        test('an edit whose clips all end reads only to after the last one', async () => {
            const { forge } = setup();
            const source = await largeSource();
            const edited = await forge.edit(
                { clips: [{ input: source, start: 30, end: 40 }] },
                'mkv',
            );
            assert.ok(source.bytesRead < source.size / 2, `${source.bytesRead} of ${source.size}`);
            const clip = await forge.inspect(edited.blob, { sampleCounts: true });
            assert.equal(clip.tracks[0].sampleCount, 100);
        });
    });

    describe('picture settings', () => {
        test('crop, rotation, flip and fit match the oracle', async () => {
            const { collect } = setup();
            const input = await vp8Clip();
            for (const settings of [
                { crop: { x: 8, y: 8, width: 32, height: 24 }, rotate: 90, flip: 'horizontal' },
                { rotate: 180, flip: 'vertical' },
                { width: 32, height: 32, fit: 'contain' },
                { width: 32, height: 32, fit: 'cover' },
                {
                    crop: { x: 16, y: 0, width: 32, height: 48 },
                    rotate: 270,
                    width: 24,
                    height: 16,
                },
            ]) {
                const label = JSON.stringify(settings);
                const [frame] = await collect(input, { ...settings, times: [0.2] });
                const oriented = settings.rotate === 90 || settings.rotate === 270;
                const area = settings.crop ?? { width, height };
                const expected = transformedPattern({
                    sourceWidth: width,
                    sourceHeight: height,
                    block,
                    ...settings,
                    width: settings.width ?? (oriented ? area.height : area.width),
                    height: settings.height ?? (oriented ? area.width : area.height),
                });
                assert.equal(frame.data.length, expected.rgba.length, label);
                const difference = maskedDifference(frame.data, expected.rgba, expected.mask);
                assert.ok(difference < 3, `${label} differs by ${difference}`);
            }
        });

        test('the display rotation of the track is applied', async () => {
            const { collect } = setup();
            const [upright] = await collect(await vp8Clip({ rotation: 90 }), { times: [0] });
            assert.deepEqual([upright.width, upright.height], [height, width]);
            const turned = transformedPattern({
                sourceWidth: width,
                sourceHeight: height,
                block,
                upright: 270,
                width: height,
                height: width,
            });
            assert.ok(maskedDifference(upright.data, turned.rgba, turned.mask) < 3);
        });

        test('pixels twice as wide as tall are shown at their display shape', async () => {
            const { collect } = setup();
            const anamorphic = await vp8Clip({
                display: { pixelAspectRatioNum: 2, pixelAspectRatioDen: 1 },
            });
            const wide = [
                ...(await collect(anamorphic, { times: [0] })),
                ...(await collect(anamorphic, { times: [0], width: 64 })),
            ];
            assert.deepEqual(
                wide.map(frame => [frame.width, frame.height]),
                [
                    [2 * width, height],
                    [64, 24],
                ],
            );
        });

        test('settings that do not go together are ignored and reported', async () => {
            const { collect, warnings } = setup();
            await collect(await vp8Clip(), { times: [0], every: 1, fit: 'cover', width: 20 });
            assert.deepEqual(codes(warnings), ['OPTION_IGNORED', 'OPTION_IGNORED']);
        });

        test('pictures of a new size are scaled to the track size or the one asked', async () => {
            // MPEG-2 in a program stream whose second sequence header doubles the size and
            // changes the aspect ratio.
            const first = mpeg2Gop();
            const second = mpeg2Gop({
                start: 90000 + 7 * 3600,
                sequence: mpegSequence({ profile: 0x48, width: 64, height: 32, aspect: 3 }),
            });
            const entries = [...first, ...second].map(unit => ({
                streamId: 0xe0,
                payload: unit.data,
                pts: unit.pts,
                dts: unit.type === PICTURE_B ? undefined : unit.dts,
                scr: unit.dts - 900,
            }));
            const input = new Blob([programStream(entries)]);
            const forge = new MediaForge({ onWarning: () => {} });
            const sizes = async options => {
                const frames = [];
                for await (const frame of forge.frames(input, options)) frames.push(frame);
                return frames.map(frame => [frame.width, frame.height, frame.data.length]);
            };
            const expected = (width, height) =>
                Array.from({ length: 14 }, () => [width, height, width * height * 4]);
            assert.deepEqual(await sizes(), expected(32, 16));
            assert.deepEqual(await sizes({ width: 16 }), expected(16, 8));
        });
    });

    describe('thumbnail()', () => {
        test('a PNG holds the picture frames() extracts, losslessly', async () => {
            const { forge, collect } = setup();
            const input = await vp8Clip();
            const { blob } = await forge.thumbnail(input, {
                time: 0.5,
                to: 'png',
                width: 32,
                height: 24,
            });
            assert.equal(blob.type, 'image/png');
            const image = pngRgba(new Uint8Array(await blob.arrayBuffer()));
            assert.deepEqual([image.width, image.height], [32, 24]);
            const [same] = await collect(input, { times: [0.5], width: 32, height: 24 });
            assert.deepEqual(image.rgba, same.data);
        });

        test('a JPEG without OffscreenCanvas fails with ENCODE', async () => {
            const { forge } = setup();
            await assert.rejects(
                forge.thumbnail(await vp8Clip(), { to: 'jpeg' }),
                error => error.code === 'ENCODE',
            );
        });

        test('without a decoder for the codec it fails with DECODE naming the codec', async () => {
            await assert.rejects(
                new lite.MediaForge().thumbnail(await vp8Clip(), { to: 'png' }),
                error =>
                    error.code === 'DECODE' && /No video decoder for 'vp8'/.test(error.message),
            );
        });
    });

    describe('an open input', () => {
        test('frames in progress hold the input until they end', async () => {
            const { forge } = setup();
            const media = await forge.open(await vp8Clip());
            try {
                const iterator = media.frames({ times: [0, 0.5] });
                await iterator.next();
                assert.match((await media.check('mkv', { copy: true })).reason, /in progress/);
                await iterator.return();
                assert.equal((await media.check('mkv', { copy: true })).supported, true);
            } finally {
                media.close();
            }
        });
    });
});

/** A stage that inverts the colours, and how many of it were created and closed. */
function invertStage() {
    const life = { created: 0, closed: 0 };
    const stage = {
        type: 'video',
        name: 'invert',
        create() {
            life.created++;
            return {
                type: 'video',
                name: 'invert',
                async process(picture, emit) {
                    const data = (await picture.rgba()).slice();
                    for (let at = 0; at < data.length; at++)
                        if (at % 4 !== 3) data[at] = 255 - data[at];
                    const { width, height, timestamp, duration } = picture;
                    emit(createPicture({ data, width, height, timestamp, duration }));
                    picture.close();
                },
                close: () => life.closed++,
            };
        },
    };
    return { stage, life };
}

/** A stage that keeps every `factor`-th pixel of each row and column, declaring the size. */
const shrink = {
    type: 'video',
    name: 'shrink',
    create: ({ factor }) => ({
        type: 'video',
        name: 'shrink',
        configure: input => ({
            ...input,
            width: input.width / factor,
            height: input.height / factor,
        }),
        async process(picture, emit) {
            const source = await picture.rgba();
            const [width, height] = [picture.width / factor, picture.height / factor];
            const data = new Uint8Array(width * height * 4);
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const from = (y * factor * picture.width + x * factor) * 4;
                    data.set(source.subarray(from, from + 4), (y * width + x) * 4);
                }
            const { timestamp, duration } = picture;
            emit(createPicture({ data, width, height, timestamp, duration }));
            picture.close();
        },
    }),
};

describe('pipeline/frames: stages', () => {
    test('frames() runs each picture through a stage and closes the stages', async () => {
        const { collect } = setup();
        const input = await vp8Clip();
        const { stage, life } = invertStage();
        const [plain] = await collect(input, { times: [0.2] });
        const [inverted] = await collect(input, { times: [0.2], stages: [stage] });
        assert.deepEqual(
            inverted.data,
            plain.data.map((value, at) => (at % 4 === 3 ? value : 255 - value)),
        );
        assert.equal(life.closed, life.created);
    });

    test("a plugin's stage is named with its options, and changes the declared size", async () => {
        const { plugin } = patternDecoderPlugin();
        const staged = new MediaForge({
            plugins: { add: [plugin, { name: 'shrink', stages: [shrink] }] },
        });
        const input = await vp8Clip();
        const small = [];
        for await (const frame of staged.frames(input, {
            times: [0.2],
            stages: [{ name: 'shrink', options: { factor: 2 } }],
        }))
            small.push(frame);
        assert.deepEqual([small[0].width, small[0].height], [width / 2, height / 2]);
        const plain = [];
        for await (const frame of staged.frames(input, { times: [0.2] })) plain.push(frame);
        assert.deepEqual(small[0].data.subarray(0, 4), plain[0].data.subarray(0, 4));
    });

    test('an unknown stage name fails with INPUT, the hint naming the stages in use', async () => {
        const { plugin } = patternDecoderPlugin();
        const staged = new MediaForge({
            plugins: { add: [plugin, { name: 'shrink', stages: [shrink] }] },
        });
        await assert.rejects(
            staged.convert(await vp8Clip(), { to: 'mkv', video: { stages: ['blur'] } }),
            error =>
                error.code === 'INPUT' &&
                /No video stage is named "blur"/.test(error.message) &&
                /'shrink'/.test(error.hint),
        );
    });

    test('a picture of another size than the stage declared is refused', async () => {
        const { collect } = setup();
        const lying = {
            type: 'video',
            name: 'lying',
            create: () => ({
                ...shrink.create({ factor: 2 }),
                name: 'lying',
                configure: undefined,
            }),
        };
        await assert.rejects(
            collect(await vp8Clip(), { times: [0.2], stages: [lying] }),
            error =>
                error.code === 'INPUT' && /emitted a picture of another size/.test(error.message),
        );
    });

    test('thumbnail() and a picture target run the stages too', async () => {
        const { forge, collect } = setup();
        const input = await vp8Clip();
        const { stage } = invertStage();
        const [inverted] = await collect(input, { times: [0.2], stages: [stage] });
        const { blob: thumb } = await forge.thumbnail(input, {
            time: 0.2,
            to: 'png',
            stages: [stage],
        });
        assert.deepEqual(pngRgba(new Uint8Array(await thumb.arrayBuffer())).rgba, inverted.data);
        const { blob: picture } = await forge.convert(input, {
            to: 'png',
            start: 0.2,
            video: { stages: [stage] },
        });
        assert.deepEqual(pngRgba(new Uint8Array(await picture.arrayBuffer())).rgba, inverted.data);
    });
});

describe('pipeline/frames: uncompressed video', () => {
    const [w, h, b] = [32, 16, 8];
    const rgba = patternRgba(w, h, b);
    const i420 = patternPicture(w, h, b);
    const chroma = w * h;
    const bottomUpBgr = new Uint8Array(w * h * 3);
    const bgrx = new Uint8Array(w * h * 4);
    const yuy2 = new Uint8Array(w * h * 2);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const [red, green, blue] = rgba.subarray((y * w + x) * 4);
            bottomUpBgr.set([blue, green, red], ((h - 1 - y) * w + x) * 3);
            bgrx.set([blue, green, red, 0], (y * w + x) * 4);
            const at = (y >> 1) * (w / 2) + (x >> 1);
            const pair = y * w * 2 + (x & ~1) * 2;
            yuy2[pair + (x & 1) * 2] = i420[y * w + x];
            yuy2[pair + 1] = i420[chroma + at];
            yuy2[pair + 3] = i420[chroma * 1.25 + at];
        }
    // The core unpacks uncompressed video; the avi plugin reads the container.
    const forge = new lite.MediaForge({ plugins: [avi] });
    const aviOf = (fourcc, frame, bitmap = {}, packets = [frame, frame]) =>
        aviH264({ fourcc, extra: new Uint8Array(0), packets, width: w, height: h, ...bitmap });

    test('the core decodes uncompressed video', async () => {
        assert.ok((await forge.capabilities()).video.decoders.includes('uncompressed'));
    });

    for (const [fourcc, frame, codec, exact, bitmap] of [
        ['BI_RGB', bottomUpBgr, 'raw.BGR24.flip', true, {}],
        ['BI_RGB', bgrx, 'raw.BGRX', true, { height: -h, bitCount: 32 }],
        ['I420', i420, 'raw.I420', false, {}],
        ['YUY2', yuy2, 'raw.YUY2', false, { bitCount: 16 }],
    ])
        test(`${codec}: every frame is a keyframe and shows the picture`, async () => {
            const input = aviOf(fourcc, frame, bitmap);
            assert.equal((await forge.inspect(input)).tracks[0].codec, codec);
            const frames = [];
            for await (const picture of forge.frames(input)) frames.push(picture);
            assert.deepEqual(
                frames.map(picture => picture.timestamp),
                [0, 0.04],
            );
            if (exact) assert.deepEqual(frames[0].data, rgba, 'pixels are copied exactly');
            else {
                const expected = transformedPattern({
                    sourceWidth: w,
                    sourceHeight: h,
                    block: b,
                    width: w,
                    height: h,
                });
                assert.ok(maskedDifference(frames[0].data, expected.rgba, expected.mask) < 3);
            }
        });

    test('a picture target of a video input is its first picture', async () => {
        const still = aviOf('BI_RGB', bgrx, { height: -h, bitCount: 32 });
        const { blob } = await forge.convert(new Blob([still]), 'png');
        assert.deepEqual(pngRgba(new Uint8Array(await blob.arrayBuffer())).rgba, rgba);
    });

    test('a frame shorter than its picture fails with DECODE', async () => {
        const short = aviOf('I420', i420, {}, [i420.subarray(1)]);
        await assert.rejects(
            forge.thumbnail(short, { to: 'png' }),
            error => error.code === 'DECODE',
        );
    });
});

describe('pipeline/frames: seeking', () => {
    test('H.263 listing every picture as sync starts at an intra header', async () => {
        // QuickTime H.263 tracks list predicted pictures as sync samples.
        const stream = SHORT_HEADER_FIXTURE.bytes();
        const starts = [];
        for (let index = 0; index + 2 < stream.length; index++)
            if (
                stream[index] === 0 &&
                stream[index + 1] === 0 &&
                (stream[index + 2] & 0xfc) === 0x80
            )
                starts.push(index);
        const samples = starts.map((start, index) => ({
            data: stream.slice(start, starts[index + 1] ?? stream.length),
            offset: 0,
            size: (starts[index + 1] ?? stream.length) - start,
            timestamp: index / 25,
            duration: 0.04,
            isKeyframe: true,
        }));
        const demuxer = {
            formats: ['h263-es'],
            async read() {
                const track = { id: 1, codec: 's263', width: 128, height: 96, sampleRate: 0 };
                return {
                    audioTracks: [],
                    videoTracks: [
                        { ...track, channelCount: 0, duration: samples.length / 25, samples },
                    ],
                };
            },
        };
        const decoded = [];
        const [builtin] = mpeg4.decoders;
        const counting = {
            name: 'mpeg4',
            description: mpeg4.description,
            decoders: [
                {
                    ...builtin,
                    async load() {
                        const create = await builtin.load();
                        return async config =>
                            new Proxy(await create(config), {
                                get(target, key) {
                                    if (key === 'decode')
                                        return chunk => (
                                            decoded.push(Math.round(chunk.timestamp * 25)),
                                            target.decode(chunk)
                                        );
                                    const value = target[key];
                                    return typeof value === 'function' ? value.bind(target) : value;
                                },
                            });
                    },
                },
            ],
        };
        const reader = { name: 'h263-es', readers: [readerPart(demuxer)] };
        const forge = new lite.MediaForge({
            plugins: [reader, counting],
            open: { format: 'h263-es' },
        });
        const { blob } = await forge.thumbnail(stream, { time: 0.09, to: 'png' });
        assert.deepEqual(
            [...new Uint8Array(await blob.arrayBuffer()).subarray(16, 24)],
            [0, 0, 0, 128, 0, 0, 0, 96],
        );
        assert.deepEqual(
            decoded.slice(0, 3),
            [0, 1, 2],
            'decoding starts at the intra picture, once',
        );
    });

    test('a keyframe is read for its type only where the codec header says it', async () => {
        const read = [];
        const file = {
            async readPacket(id, index) {
                read.push(index);
                return { data: new Uint8Array(8) };
            },
        };
        const frames = codec =>
            indexedFrames(
                file,
                { description: { id: 1 }, info: { codec, samples: [] } },
                new AbortController().signal,
            );
        for (const codec of ['avc1.64001f', 'vp09.00.10.08', 'av01.0.04M.08'])
            assert.equal(await frames(codec).intra(5), true);
        assert.deepEqual(read, []);
        await frames('s263').intra(5);
        await frames('mp4v.20.9').intra(6);
        assert.deepEqual(read, [5, 6]);
    });
});

describe('pipeline/frames: the input clock', () => {
    test('MPEG-TS times count from the input start, as convert() does', async () => {
        // A recording whose clock starts at 100 s shows its picture at 2 s for time 2.
        const sink = new MemorySink();
        const muxer = new TsMuxer(
            {
                format: 'ts',
                mode: 'standard',
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'avc1.42c00a',
                    codecConfig: avcc(),
                    width: 64,
                    height: 48,
                },
            },
            sink,
        );
        for (let index = 0; index < 100; index++)
            muxer.addVideoChunk({
                trackType: 'video',
                data: lengthPrefixed(4, index % 25 ? predicted : idr),
                timestamp: 100 + index / 25,
                duration: 1 / 25,
                isKeyframe: index % 25 === 0,
            });
        await muxer.finalize();
        const decoded = [];
        const clock = {
            name: 'clock',
            decoders: [
                {
                    kind: 'video',
                    id: 'clock',
                    codecs: codec => codec.startsWith('avc1'),
                    load: async () => () => ({
                        decode(chunk) {
                            decoded.push(chunk.timestamp);
                            return [
                                {
                                    format: 'I420',
                                    data: new Uint8Array(16 * 16 * 1.5),
                                    layout: [
                                        { offset: 0, stride: 16 },
                                        { offset: 256, stride: 8 },
                                        { offset: 320, stride: 8 },
                                    ],
                                    codedWidth: 16,
                                    codedHeight: 16,
                                    visibleRect: { x: 0, y: 0, width: 16, height: 16 },
                                    displayWidth: 16,
                                    displayHeight: 16,
                                    timestamp: chunk.timestamp,
                                    duration: chunk.duration,
                                    keyFrame: chunk.isKeyframe,
                                },
                            ];
                        },
                        flush: () => [],
                        reset() {},
                        close() {},
                    }),
                },
            ],
        };
        const forge = new lite.MediaForge({ plugins: [clock] });
        const input = sink.toBlob();
        const shown = [];
        for await (const frame of forge.frames(input, { times: [2, 0.5] }))
            shown.push(Math.round(frame.timestamp * 100) / 100);
        assert.deepEqual(shown, [2, 0.48]);
        // The picture at 3.1 s decodes from the keyframe at 3 s: three pictures, not one.
        decoded.length = 0;
        await forge.thumbnail(input, { time: 3.1 });
        assert.ok(decoded.length >= 3, `thumbnail decoded ${decoded.length} pictures`);
    });
});

describe('pipeline/frames: H.264 seeks', () => {
    test('a seek skips unreferenced pictures before the one shown, same pictures', async () => {
        const clip = new Blob([
            await readFile(new URL('../fixtures/editing/clip-a.mp4', import.meta.url)),
        ]);
        let decodes = 0;
        const counting = {
            name: 'counted-h264',
            decoders: h264.decoders.map(part => ({
                ...part,
                load: async () => {
                    const create = await part.load();
                    return async config => {
                        const decoder = await create(config);
                        const decode = decoder.decode.bind(decoder);
                        decoder.decode = packet => {
                            decodes++;
                            return decode(packet);
                        };
                        return decoder;
                    };
                },
            })),
        };
        const forge = new MediaForge({ plugins: { exclude: ['h264'], add: [counting] } });
        const every = [];
        for await (const frame of forge.frames(clip)) every.push(frame);
        assert.equal(decodes, every.length, 'every picture decodes once without a time');
        decodes = 0;
        const times = [0.98, 2.5];
        const sought = [];
        for await (const frame of forge.frames(clip, { times })) sought.push(frame);
        for (const [index, time] of times.entries()) {
            const expected = every.filter(frame => frame.timestamp <= time + 1e-6).at(-1);
            assert.equal(sought[index].timestamp, expected.timestamp, `picture at ${time} s`);
            assert.deepEqual(sought[index].data, expected.data, `pixels at ${time} s`);
        }
        // The two B pictures of each group are no references: 32 pictures decode, not 44.
        assert.ok(decodes > 0 && decodes <= 36, `two seeks decoded ${decodes} pictures`);
    });
});

describe('pipeline/frames: host decoders', () => {
    /** A 16x16 VP8 track of `count` one-byte pictures 0.1 s apart, the first a keyframe. */
    const track = count => ({
        id: 1,
        codec: 'vp8',
        width: 16,
        height: 16,
        sampleRate: 0,
        channelCount: 0,
        duration: count * 0.1,
        samples: Array.from({ length: count }, (_, index) => ({
            timestamp: index * 0.1,
            decodeTimestamp: index * 0.1,
            duration: 0.1,
            isKeyframe: index === 0,
            offset: 0,
            size: 1,
            data: new Uint8Array([1]),
        })),
    });

    test(
        'a decoder lending few pictures at once flushes as they are taken, not deadlocked',
        { timeout: 10_000 },
        async () => {
            // GPU decoders hold back the next picture until one they lent is closed.
            const host = installVideoCodecs({ reorder: true, pixels: true, pool: 2 });
            try {
                const reader = {
                    formats: ['synthetic'],
                    async read() {
                        return { videoTracks: [track(12)], audioTracks: [] };
                    },
                };
                const forge = new lite.MediaForge({
                    plugins: [{ name: 'synthetic', readers: [readerPart(reader)] }],
                    open: { format: 'synthetic' },
                });
                const input = new Uint8Array(16);
                const collect = async options => {
                    const frames = [];
                    for await (const frame of forge.frames(input, options)) frames.push(frame);
                    return times(frames);
                };
                assert.deepEqual(
                    await collect(),
                    Array.from({ length: 12 }, (_, index) => index / 10),
                );
                // Seeking back flushes the decoder again while pictures of the last flush wait.
                assert.deepEqual(await collect({ times: [1, 0.3] }), [1, 0.3]);
                const { blob } = await forge.thumbnail(input, { time: 0.5, to: 'png' });
                assert.equal(blob.type, 'image/png');
                host.assertClosed();
            } finally {
                host.restore();
            }
        },
    );

    test('pictures of a video with alpha come without it, reported, not silently', async () => {
        const host = installVideoCodecs({ pixels: true });
        try {
            const reader = {
                formats: ['synthetic'],
                async read() {
                    return { videoTracks: [{ ...track(2), alphaMode: true }], audioTracks: [] };
                },
            };
            const forge = policy =>
                new lite.MediaForge({
                    plugins: [{ name: 'synthetic', readers: [readerPart(reader)] }],
                    open: { format: 'synthetic' },
                    ...(policy ? { optionPolicy: policy } : {}),
                });
            const input = new Uint8Array(16);
            for (const result of [
                await forge().thumbnail(input, { to: 'png' }),
                await forge().convert(input, 'png'),
            ])
                assert.deepEqual(
                    result.warnings.map(warning => [warning.code, warning.trackId]),
                    [['ALPHA_DROPPED', 1]],
                );
            await assert.rejects(forge('strict').thumbnail(input, { to: 'png' }), {
                code: 'FORMAT',
            });
            host.assertClosed();
        } finally {
            host.restore();
        }
    });
});
