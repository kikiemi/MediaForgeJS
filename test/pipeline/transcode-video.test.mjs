import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open } from 'mediaforgejs';
import { Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { annexB, avcc, idr, pps, sps } from '../helpers/avi-h264-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// Video re-encoded through the host's WebCodecs (doubles here) or a plugin decoder: the
// pictures' times and keyframes, the decoders tried in order, recovery from damage, crops, and
// how failures and cancellation end the work.

/** A 16x16 track of one-byte packets: `times` in presentation order, decoded every 0.04 s. */
const track = (times = [0, 0.04, 0.08]) => ({
    id: 1,
    codec: 'vp8',
    width: 16,
    height: 16,
    sampleRate: 0,
    channelCount: 0,
    duration: 0.12,
    samples: times.map((timestamp, index) => ({
        timestamp,
        decodeTimestamp: index * 0.04,
        duration: 0.04,
        isKeyframe: index === 0,
        offset: 0,
        size: 1,
        data: new Uint8Array([1]),
    })),
});

/** A 16x16 track of `count` pictures `step` apart (or at `times`), keyframes at `keys`. */
const frameTrack = ({ count = 3, step = 0.04, times, durations, keys = [0], codec = 'vp8' }) => {
    const starts = times ?? Array.from({ length: count }, (_, index) => index * step);
    return {
        id: 1,
        codec,
        width: 16,
        height: 16,
        sampleRate: 0,
        channelCount: 0,
        duration: starts.length * step,
        samples: starts.map((timestamp, index) => ({
            timestamp,
            decodeTimestamp: timestamp,
            duration: durations?.[index] ?? step,
            isKeyframe: keys.includes(index),
            offset: 0,
            size: 1,
            data: new Uint8Array([1]),
        })),
    };
};

/**
 * Re-encodes the video track `input`, read by a plugin reader, into `format` with `video`
 * settings, and reads back the written packets.
 */
async function transcode(input, { video = {}, format = 'mkv', plugins = [], ...options } = {}) {
    for (const sample of input.samples) if (sample.data) sample.size = sample.data.length;
    const reader = {
        formats: ['synthetic'],
        async read() {
            return { videoTracks: [input], audioTracks: [] };
        },
    };
    const { blob } = await convert(options.source ?? new Uint8Array(1024).fill(1), {
        to: format,
        video: { codec: 'vp8', bitrate: 200000, ...video },
        plugins: {
            add: [{ name: 'synthetic', readers: [readerPart(reader)] }, ...plugins],
            ...(options.exclude ? { exclude: options.exclude } : {}),
        },
        open: { format: 'synthetic', cacheBytes: 0 },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.codecPreference ? { codecPreference: options.codecPreference } : {}),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
        ...(options.optionPolicy ? { optionPolicy: options.optionPolicy } : {}),
    });
    const media = await open(blob);
    try {
        const packets = [];
        for await (const packet of media.packets())
            packets.push({
                timestamp: Math.round(packet.timestamp * 1e6) / 1e6,
                duration: Math.round(packet.duration * 1e6) / 1e6,
                isKeyframe: packet.isKeyframe,
            });
        return packets.sort((a, b) => a.timestamp - b.timestamp);
    } finally {
        media.close();
    }
}

/** A plugin decoder of 'mp4v.20.9' showing 16x16 I420 pictures whose luma is the first byte. */
function planarPlugin(log, { failAt, format = 'I420' } = {}) {
    return {
        name: 'planar',
        decoders: [
            {
                kind: 'video',
                id: 'planar',
                codecs: codec => codec === 'mp4v.20.9',
                load: async () => config => {
                    log.created.push(config);
                    return {
                        decode(chunk) {
                            if (chunk.timestamp === failAt) throw new Error('damaged picture');
                            log.decoded.push(chunk.timestamp);
                            const data = new Uint8Array(16 * 16 * 1.5).fill(128);
                            data.fill(chunk.data[0], 0, 256);
                            return [
                                {
                                    format,
                                    data,
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
                        reset() {
                            log.resets++;
                        },
                        close() {
                            log.closes++;
                        },
                    };
                },
            },
        ],
    };
}
const planarLog = () => ({ created: [], decoded: [], resets: 0, closes: 0 });
const keyIndices = frames => frames.flatMap((frame, index) => (frame.keyFrame ? [index] : []));

describe('pipeline/transcode: video', () => {
    test('a new frame rate gives each picture its new duration', async () => {
        const host = installVideoCodecs();
        try {
            const output = await transcode(track(), { video: { fps: 50 } });
            assert.deepEqual(
                output.map(chunk => [chunk.timestamp, chunk.duration]),
                [0, 0.02, 0.04, 0.06, 0.08, 0.1].map(time => [time, 0.02]),
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('Annex B H.264 without a decoder description is decoded as Annex B', async () => {
        const host = installVideoCodecs();
        try {
            const input = track([0]);
            input.codec = 'avc1.42000a';
            input.samples[0].data = annexB(sps, pps, idr);
            input.samples[0].nalUnitFormat = 'annexb';
            assert.equal((await transcode(input)).length, 1);
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('the decoder description probed is the one decoding uses', async () => {
        const host = installVideoCodecs({ requireDescription: true });
        try {
            const input = track([0]);
            input.codec = 'avc1.42000a';
            input.codecConfig = avcc();
            assert.equal((await transcode(input)).length, 1);
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('reordered pictures and the final flush keep every picture', async () => {
        const host = installVideoCodecs({ reorder: true });
        try {
            const output = await transcode(track([0, 0.12, 0.04, 0.08]));
            assert.deepEqual(
                output.map(chunk => chunk.timestamp),
                [0, 0.04, 0.08, 0.12],
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test(
        'a decoder lending few pictures at once is drained as it flushes, not deadlocked',
        { timeout: 10_000 },
        async () => {
            // GPU decoders hold back the next picture until one they lent is closed.
            const host = installVideoCodecs({ reorder: true, pool: 2 });
            try {
                const input = frameTrack({ count: 12 });
                const output = await transcode(input);
                assert.deepEqual(
                    output.map(chunk => chunk.timestamp),
                    input.samples.map(sample => Math.round(sample.timestamp * 1e6) / 1e6),
                );
                host.assertClosed();
            } finally {
                host.restore();
            }
        },
    );

    test('pictures a decoder never shows and varying times keep the others in place', async () => {
        const times = [0, 0.033, 0.1, 0.12, 0.25, 0.31];
        const durations = [0.033, 0.067, 0.02, 0.13, 0.06, 0.04];
        const host = installVideoCodecs({ hidden: new Set([100000]), reorder: true });
        try {
            const output = await transcode(frameTrack({ times, durations }));
            // The hidden picture leaves its place; every other keeps its own time.
            assert.deepEqual(
                output.map(chunk => chunk.timestamp),
                [0, 1, 3, 4, 5].map(index => times[index]),
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('keyframes follow time, and each codec flushes once, at the end', async () => {
        for (const [keyframeInterval, expected] of [
            [undefined, [0, 50]],
            [1, [0, 25, 50]],
            [0, Array.from({ length: 75 }, (_, index) => index)],
        ]) {
            const host = installVideoCodecs();
            try {
                const video = keyframeInterval === undefined ? {} : { keyframeInterval };
                const output = await transcode(frameTrack({ count: 75 }), { video });
                assert.equal(output.length, 75);
                assert.deepEqual(keyIndices(host.encoded), expected, `${keyframeInterval}`);
                assert.deepEqual(
                    output.flatMap((chunk, index) => (chunk.isKeyframe ? [index] : [])),
                    expected,
                    'the keyframes asked for are written',
                );
                assert.deepEqual([host.decoderFlushes, host.encoderFlushes], [1, 1]);
                host.assertClosed();
            } finally {
                host.restore();
            }
        }
    });
});

describe('pipeline/transcode: video failures', () => {
    test('an encoder failing as it works closes every frame and codec', async () => {
        const host = installVideoCodecs({ failEncode: true });
        try {
            await assert.rejects(
                transcode(track(Array.from({ length: 40 }, (_, index) => index * 0.04))),
                /Native encode failed|codec closed/i,
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a decoder configuration the host refuses is a DECODE error', async () => {
        const host = installVideoCodecs({ requireDescription: true });
        try {
            await assert.rejects(transcode(track()), error => error.code === 'DECODE');
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a decoder failing as it works is a DECODE error', async () => {
        const host = installVideoCodecs({ failDecode: true });
        try {
            await assert.rejects(
                transcode(track()),
                error => error.code === 'DECODE' && /Native decode failed/.test(error.message),
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('an abort ends a pending packet read and closes the codecs', async () => {
        const host = installVideoCodecs();
        const controller = new AbortController();
        try {
            const input = track();
            input.samples[0].data = undefined;
            const source = {
                size: 1024,
                read() {
                    controller.abort();
                    return new Promise(() => {});
                },
            };
            await assert.rejects(
                transcode(input, { source, signal: controller.signal }),
                error => error.code === 'ABORT',
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a long MP4 starts encoding having read a small part of its pictures', async () => {
        const sink = new MemorySink();
        const writer = new Mp4Muxer(
            {
                format: 'mp4',
                video: {
                    codec: 'avc1.42000a',
                    width: 16,
                    height: 16,
                    framerate: 25,
                    codecConfig: avcc(),
                },
            },
            sink,
        );
        for (let index = 0; index < 12000; index++)
            writer.addVideoChunk({
                data: Uint8Array.from({ length: 1024 }, (_, at) =>
                    at === 3 ? 1 : at === 4 ? 0x65 : 0,
                ),
                timestamp: index / 25,
                duration: 0.04,
                isKeyframe: true,
                trackType: 'video',
            });
        await writer.finalize();
        const bytes = sink.toUint8Array();
        // The movie box is at the end: count what is read after it.
        let packets = 0;
        const moov = Buffer.from(bytes).lastIndexOf('moov') - 4;
        const source = {
            size: bytes.length,
            async read(at, length) {
                if (at < moov) packets += Math.min(length, moov - at);
                return bytes.slice(at, at + length);
            },
        };
        const controller = new AbortController();
        const host = installVideoCodecs({ onEncode: () => controller.abort() });
        try {
            await assert.rejects(
                convert(source, {
                    to: 'mkv',
                    video: { codec: 'vp8' },
                    signal: controller.signal,
                    open: { maxIndexBytes: 12000 * 16, cacheBytes: 0 },
                }),
                error => error.code === 'ABORT',
            );
            assert.ok(packets < 1024 * 1024, `${packets} of 12 MB of pictures read`);
            // An abort settles at once; the codecs close as the work unwinds.
            for (let turn = 0; turn < 20; turn++)
                await new Promise(resolve => setImmediate(resolve));
            host.assertClosed();
        } finally {
            host.restore();
        }
    });
});

describe('pipeline/transcode: video decoders', () => {
    test('a plugin decoder backs up the host; its planes become VideoFrames', async () => {
        const input = frameTrack({ count: 3, codec: 'mp4v.20.9' });
        const log = planarLog();
        const host = installVideoCodecs({ decodeSupport: config => config.codec !== 'mp4v.20.9' });
        try {
            const output = await transcode(input, {
                plugins: [planarPlugin(log)],
                exclude: ['mpeg4'],
            });
            assert.equal(output.length, 3);
            assert.equal(host.decoders, 0, 'no host decoder for a configuration it refuses');
            assert.deepEqual(log.decoded, [0, 0.04, 0.08]);
            assert.equal(log.created[0].codec, 'mp4v.20.9');
            assert.equal(log.closes, 1);
            const [first, second] = host.bufferFrames;
            assert.equal(first.format, 'I420');
            assert.deepEqual(
                first.layout.map(plane => plane.offset),
                [0, 256, 320],
            );
            assert.deepEqual(first.visibleRect, { x: 0, y: 0, width: 16, height: 16 });
            assert.equal(second.timestamp, 40000, 'VideoFrame timestamps are microseconds');
            assert.deepEqual(
                first.colorSpace,
                {
                    primaries: 'smpte170m',
                    transfer: 'smpte170m',
                    matrix: 'smpte170m',
                    fullRange: false,
                },
                'pictures without a colour get the BT.601 colour RGBA conversion assumes',
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test("codecPreference 'builtin' leaves a host that takes the codec out", async () => {
        const log = planarLog();
        const host = installVideoCodecs();
        try {
            await transcode(frameTrack({ count: 3, codec: 'mp4v.20.9' }), {
                plugins: [planarPlugin(log)],
                exclude: ['mpeg4'],
                codecPreference: 'builtin',
            });
            assert.equal(host.decoders, 0);
            assert.equal(log.decoded.length, 3);
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('with neither the host nor the plugin, the error names the plugin', async () => {
        const host = installVideoCodecs({ decodeSupport: () => false });
        try {
            await assert.rejects(
                transcode(frameTrack({ count: 3, codec: 'mp4v.20.9' }), { exclude: ['mpeg4'] }),
                error =>
                    error.code === 'PLUGIN' &&
                    error.plugin === 'mpeg4' &&
                    /No video decoder for 'mp4v\.20\.9'/.test(error.message) &&
                    /VideoDecoder supports mp4v\.20\.9/.test(error.hint),
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a failing plugin decoder is reset and goes on from the next keyframe', async () => {
        const input = frameTrack({ count: 8, keys: [0, 5], codec: 'mp4v.20.9' });
        const log = planarLog();
        const host = installVideoCodecs({ decodeSupport: () => false });
        const warnings = [];
        try {
            const output = await transcode(input, {
                plugins: [planarPlugin(log, { failAt: 0.08 })],
                exclude: ['mpeg4'],
                onWarning: warning => warnings.push(warning),
            });
            assert.deepEqual(
                output.map(chunk => Math.round(chunk.timestamp * 1e6)),
                [0, 40000, 200000, 240000, 280000],
            );
            assert.equal(log.resets, 1);
            const dropped = warnings.map(warning => warning.message).join('\n');
            assert.match(
                dropped,
                /Dropped 3 video packet\(s\) from 0\.080 s to the keyframe at 0\.200 s/,
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('strictly, a failing plugin decoder ends the conversion with DECODE', async () => {
        const input = frameTrack({ count: 8, keys: [0, 5], codec: 'mp4v.20.9' });
        const host = installVideoCodecs({ decodeSupport: () => false });
        try {
            await assert.rejects(
                transcode(input, {
                    plugins: [planarPlugin(planarLog(), { failAt: 0.08 })],
                    exclude: ['mpeg4'],
                    optionPolicy: 'strict',
                }),
                error => error.code === 'DECODE' && /damaged picture/.test(error.message),
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('10-bit H.264 the host refuses is DECODE; 8-bit names the h264 plugin', async () => {
        const hex = text => Uint8Array.from(Buffer.from(text, 'hex'));
        // x264 High 10 and Main records (160x128), each with one SPS and one PPS.
        const high10 = hex(
            '016e000dffe1001c676e000da6cd94141fa6a0c0c0c80000030008000003019078a14cb00100046' +
                '8ef8fcbfdfafa00',
        );
        const main = hex(
            '014d400dffe1001a674d400deca0a0fd3506060640000003004000000c83c50a658001000568ebe3cb20',
        );
        const recorded = (codec, codecConfig) => {
            const input = { ...frameTrack({ count: 1, codec }), width: 160, height: 128 };
            const reader = {
                formats: ['recorded'],
                async read() {
                    return { videoTracks: [{ ...input, codecConfig }], audioTracks: [] };
                },
            };
            const forge = new lite.MediaForge({
                plugins: [{ name: 'recorded', readers: [readerPart(reader)] }],
                open: { format: 'recorded' },
            });
            return forge.thumbnail(new Uint8Array(16), { time: 0 });
        };
        const host = installVideoCodecs({ decodeSupport: () => false });
        try {
            await assert.rejects(
                recorded('avc1.6e000d', high10),
                error =>
                    error.code === 'DECODE' &&
                    error.plugin === undefined &&
                    /10-bit 4:2:0 H\.264 cannot be decoded here/.test(error.message) &&
                    /High 10/.test(error.hint),
            );
            await assert.rejects(
                recorded('avc1.4d400d', main),
                error =>
                    error.code === 'PLUGIN' &&
                    error.plugin === 'h264' &&
                    /'h264' plugin/.test(error.hint),
            );
        } finally {
            host.restore();
        }
    });
});

describe('pipeline/transcode: crops', () => {
    test('a crop on the chroma grid is a visible rectangle of the same frame', async () => {
        const host = installVideoCodecs();
        try {
            const output = await transcode(frameTrack({ count: 2 }), {
                video: { crop: { x: 2, y: 4, width: 8, height: 8 } },
            });
            assert.equal(output.length, 2);
            assert.equal(typeof OffscreenCanvas, 'undefined', 'no canvas to draw with');
            // The first picture encoded asks whether the host's encoders encode visible rectangles.
            const [, ...encoded] = host.encoded;
            assert.equal(encoded.length, 2);
            for (const frame of encoded) {
                assert.deepEqual(frame.visibleRect, { x: 2, y: 4, width: 8, height: 8 });
                assert.deepEqual([frame.displayWidth, frame.displayHeight], [8, 8]);
            }
            const [config] = host.encoderConfigs;
            assert.deepEqual([config.width, config.height], [8, 8]);
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('4:2:2 pictures are encoded as RGBA, which encoders take', async () => {
        const host = installVideoCodecs();
        try {
            await transcode(frameTrack({ count: 1, codec: 'mp4v.20.9' }), {
                plugins: [planarPlugin(planarLog(), { format: 'I422' })],
                exclude: ['mpeg4'],
                codecPreference: 'builtin',
            });
            assert.deepEqual(
                host.encoded.map(frame => frame.format),
                ['RGBA'],
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a crop off the chroma grid is cut from the pixels without a canvas', async () => {
        const host = installVideoCodecs({ pixels: true });
        try {
            const output = await transcode(frameTrack({ count: 2 }), {
                video: { crop: { x: 1, y: 4, width: 8, height: 8 } },
            });
            assert.equal(output.length, 2);
            assert.equal(typeof OffscreenCanvas, 'undefined', 'no canvas to draw with');
            assert.deepEqual(
                host.encoded.map(frame => [frame.format, frame.displayWidth, frame.displayHeight]),
                [
                    ['RGBA', 8, 8],
                    ['RGBA', 8, 8],
                ],
            );
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('pictures of non-square pixels need a canvas to change: ENCODE without one', async () => {
        const host = installVideoCodecs({ pixels: true });
        try {
            const wide = { ...frameTrack({ count: 2 }), pixelAspectRatioNum: 2 };
            await assert.rejects(
                transcode(
                    { ...wide, pixelAspectRatioDen: 1 },
                    { video: { crop: { x: 1, y: 4, width: 8, height: 8 } } },
                ),
                error => error.code === 'ENCODE' && /non-square pixels/.test(error.message),
            );
            assert.equal(host.decoders, 0, 'refused before decoding');
        } finally {
            host.restore();
        }
    });
});
