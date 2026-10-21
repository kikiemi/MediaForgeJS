import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, check, convert, open, packageMedia } from 'mediaforgejs';
import { BufferSource, MemorySink } from 'mediaforgejs/io';
import { Mp4Demuxer, TsMuxer, WebMDemuxer, WebMMuxer } from 'mediaforgejs/formats';
import { CmafWriter } from 'mediaforgejs/streaming';
import {
    annexB,
    aud,
    avcc,
    idr,
    join as joinBytes,
    pps,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { opusHead as opusHeadOf, parseMatroska } from '../helpers/multitrack-pcm-fixtures.mjs';
import { preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { mpegAudioFixture } from '../helpers/original-fixtures.mjs';
import { opusPacket, vp8Interframe, vp8Keyframe, webmClip } from '../helpers/webm-clip-fixture.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';
import {
    audioShape,
    blockGroup,
    cluster,
    element,
    float,
    info,
    join,
    matroskaFile,
    opusHead,
    simpleBlock,
    simpleTag,
    string,
    trackEntry,
    tracks,
    uint,
    videoShape,
} from '../helpers/matroska.mjs';
import { allPackets, bytesOf, readAll } from '../helpers/read-media.mjs';
import { decodeFlacFrame, encodeMp3, parseFlacStreamInfo } from 'mediaforgejs/codecs';
import { testSignal, waveFile, waveSamples } from '../helpers/pcm.mjs';
import { AviDemuxer } from 'mediaforgejs/formats';
import {
    aviPcmFixture,
    matroskaFixture,
    trackPackets,
    trackSpecs,
} from '../helpers/multitrack-pcm-fixtures.mjs';

const { readMatroskaTrackTitles, mergeMatroskaTrackTitles } = await import(
    distUrl('esm/formats/matroska/track-titles.js')
);

const milliseconds = seconds => Math.round(seconds * 1000) + 0;
const copiedTo = async (input, to, options = {}) =>
    bytesOf(await convert(input, { to, copy: true, onWarning() {}, ...options }));
const demuxed = async bytes => new WebMDemuxer().demux(new BufferSource(bytes));
const VP9_FRAME = Uint8Array.of(0x82, 0x49, 0x83, 0x42);
const OPUS_FRAME = Uint8Array.of(0x80, 0);
const BASE = { format: 'mkv', mode: 'standard', maxFragmentDuration: 2, autoSync: true };

/** The elements of `data` from `start` to `end`: their IDs and the spans of their bodies. */
function elements(data, start = 0, end = data.length) {
    const result = [];
    for (let p = start; p < end;) {
        let length = 1;
        while (!(data[p] & (0x80 >> (length - 1)))) length++;
        let id = 0;
        for (let i = 0; i < length; i++) id = id * 256 + data[p++];
        length = 1;
        while (!(data[p] & (0x80 >> (length - 1)))) length++;
        let size = data[p++] & (0xff >> length);
        for (let i = 1; i < length; i++) size = size * 256 + data[p++];
        result.push({ id, start: p, end: p + size });
        p += size;
    }
    return result;
}
/** The numbers of the Video element of the first track of `data`, by element ID. */
function videoFields(data) {
    let found = elements(data);
    for (const id of [0x18538067, 0x1654ae6b, 0xae, 0xe0]) {
        const element = found.find(item => item.id === id);
        assert.ok(element, `element ${id.toString(16)}`);
        found = elements(data, element.start, element.end);
    }
    return Object.fromEntries(
        found.map(item => [
            item.id,
            data.subarray(item.start, item.end).reduce((n, b) => n * 256 + b, 0),
        ]),
    );
}

/** An Opus track entry of `number` with a UID of its number past 2^60, and `children`. */
/** Whether `bytes` start with the EBML element `id`, of four bytes. */
const isElement = (bytes, id) =>
    bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === id;

/**
 * The packets (objects with a trackType and data bytes) `object` reaches through its properties,
 * arrays, Maps and Sets: what a muxer holds.
 */
function heldPackets(object) {
    const seen = new Set();
    const stack = [object];
    let packets = 0;
    while (stack.length) {
        const value = stack.pop();
        if (value === null || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (ArrayBuffer.isView(value)) continue;
        if ('trackType' in value && ArrayBuffer.isView(value.data)) packets++;
        if (value instanceof Map) for (const entry of value) stack.push(...entry);
        else if (value instanceof Set) stack.push(...value);
        for (const key of Object.getOwnPropertyNames(value)) {
            const field = Object.getOwnPropertyDescriptor(value, key);
            if ('value' in field) stack.push(field.value);
        }
    }
    return packets;
}

const opusEntry = (number, ...children) =>
    trackEntry(
        number,
        2,
        'A_OPUS',
        uint(0x73c5, BigInt(number) + (1n << 60n)),
        audioShape(1, 48000),
        element(0x63a2, opusHead(1)),
        ...children,
    );

describe('matroska: writing', () => {
    describe('the muxer', () => {
        const video = {
            id: 1,
            type: 'video',
            codec: 'vp09.00.10.08',
            width: 160,
            height: 96,
            framerate: 25,
        };
        const picture = {
            trackType: 'video',
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
            data: VP9_FRAME,
        };

        for (const [shape, expected] of [
            [
                {
                    displayWidth: 213.3333282470703,
                    displayHeight: 96,
                    pixelAspectRatioNum: 4,
                    pixelAspectRatioDen: 3,
                },
                [20, 9, 3],
            ],
            [
                {
                    displayWidth: 170.6666717529297,
                    displayHeight: 96,
                    pixelAspectRatioNum: 16,
                    pixelAspectRatioDen: 15,
                },
                [16, 9, 3],
            ],
            [{ pixelAspectRatioNum: 4, pixelAspectRatioDen: 3 }, [20, 9, 3]],
            [{ pixelAspectRatioNum: 16, pixelAspectRatioDen: 15 }, [16, 9, 3]],
            [{ pixelAspectRatioNum: 2, pixelAspectRatioDen: 1 }, [320, 96, 0]],
            [
                {
                    displayWidth: 120.5,
                    displayHeight: 96,
                    pixelAspectRatioNum: 4,
                    pixelAspectRatioDen: 3,
                },
                [241, 192, 3],
            ],
            [
                {
                    displayWidth: 240,
                    displayHeight: 96,
                    pixelAspectRatioNum: 4,
                    pixelAspectRatioDen: 3,
                },
                [240, 96, 0],
            ],
            [{ displayWidth: 170.5, displayHeight: 96 }, [341, 192, 3]],
            [{ displayWidth: 240 }, [240, 96, 0]],
        ])
            test(`writes the display of ${JSON.stringify(shape)} in lowest terms`, async () => {
                // DisplayWidth, DisplayHeight and DisplayUnit (3: an aspect ratio).
                const sink = new MemorySink();
                const muxer = new WebMMuxer({ ...BASE, video: { ...video, ...shape } }, sink);
                muxer.addVideoChunk(picture);
                await muxer.finalize();
                const fields = videoFields(sink.toUint8Array());
                assert.deepEqual([fields[0x54b0], fields[0x54ba], fields[0x54b2]], expected);
            });

        test('a video configuration it cannot state fails, writing nothing', () => {
            for (const shape of [
                { width: 0 },
                { width: -1 },
                { width: NaN },
                { width: 1.5 },
                { height: Infinity },
                { displayWidth: NaN },
                { displayHeight: 0 },
                { displayWidth: Infinity },
                { displayWidth: -2 },
                { pixelAspectRatioNum: 0, pixelAspectRatioDen: 1 },
                { pixelAspectRatioNum: 4 },
                { pixelAspectRatioNum: 4, pixelAspectRatioDen: 1.5 },
                { framerate: NaN },
                { framerate: 1e-100 },
                { rotation: Infinity },
                { codec: 'unknown' },
                { name: 42 },
                { commentary: 1 },
                { default: 0 },
            ]) {
                const sink = new MemorySink();
                assert.throws(
                    () => new WebMMuxer({ ...BASE, video: { ...video, ...shape } }, sink),
                    { code: 'FORMAT' },
                    JSON.stringify(shape),
                );
                assert.equal(sink.size, 0);
            }
        });

        test('other configurations it cannot state fail with FORMAT', () => {
            const audio = {
                id: 2,
                type: 'audio',
                codec: 'opus',
                sampleRate: 48000,
                channelCount: 2,
            };
            for (const config of [
                { audio: { ...audio, sampleRate: NaN } },
                { audio: { ...audio, channelCount: 1.5 } },
                { video, videoColour: { primaries: -1, matrix: 1, transfer: 1, fullRange: false } },
                { video, videoColour: { primaries: 1, matrix: 1, transfer: 1, fullRange: 0 } },
                { subtitleTracks: [{ codec: 'unknown' }] },
                { extraAudioTracks: [{ ...audio, codec: 'unknown' }] },
            ])
                assert.throws(() => new WebMMuxer({ ...BASE, ...config }, new MemorySink()), {
                    code: 'FORMAT',
                });
        });

        test('reads each field of its configuration once', async () => {
            const inherited = Object.create(video);
            let widths = 0;
            Object.defineProperty(inherited, 'width', {
                get() {
                    assert.equal(this, inherited);
                    widths++;
                    return 160;
                },
            });
            const muxer = new WebMMuxer({ ...BASE, video: inherited }, new MemorySink());
            assert.equal(widths, 1);
            muxer.addVideoChunk(picture);
            await muxer.finalize();
            assert.equal(widths, 1);
        });

        test('a configuration due with the first picture writes no early header', async () => {
            const h264 = { ...video, codec: 'avc1.42c00b' };
            const picture264 = { ...picture, data: Uint8Array.of(0, 0, 0, 1, 0x65) };
            const sink = new MemorySink();
            const fragmented = new WebMMuxer({ ...BASE, mode: 'fragmented', video: h264 }, sink);
            assert.throws(() => fragmented.addVideoChunk(picture264), /codec config/);
            assert.equal(sink.size, 0);
            const dynamic = new WebMMuxer({ ...BASE, video: h264 }, new MemorySink());
            dynamic.addVideoChunk(picture264, Uint8Array.of(1, 0x42, 0, 0xb, 0xff));
            await dynamic.finalize();
        });

        test('fragmented: sound before Annex B H.264 waits for its avcC, not FORMAT', async () => {
            // An encoder writing Annex B gives its parameter sets with its first keyframe only.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    ...BASE,
                    mode: 'fragmented',
                    video: { ...video, codec: 'avc1.42000a' },
                    audio: {
                        id: 2,
                        type: 'audio',
                        codec: 'opus',
                        sampleRate: 48000,
                        channelCount: 2,
                        codecConfig: opusHeadOf(2),
                    },
                },
                sink,
            );
            const sound = {
                trackType: 'audio',
                duration: 0.02,
                isKeyframe: true,
                data: OPUS_FRAME,
            };
            muxer.addAudioChunk({ ...sound, timestamp: 0 });
            assert.equal(sink.size, 0, 'the header waits for the picture');
            muxer.addVideoChunk({
                ...picture,
                timestamp: 0.0065,
                data: annexB(aud, sps, pps, idr),
            });
            muxer.addAudioChunk({ ...sound, timestamp: 0.02 });
            await muxer.finalize();
            const { videoTracks, audioTracks } = await demuxed(sink.toUint8Array());
            assert.deepEqual(videoTracks[0].codecConfig, avcc());
            assert.equal(audioTracks[0].samples.length, 2);
        });

        const ROUTED = 32;
        const FRAMES = 203;
        const routedTracks = Array.from({ length: ROUTED }, (_, index) => ({
            id: index === 0 ? 7 : 129 + (index - 1) * 97,
            type: 'audio',
            codec: 'opus',
            sampleRate: 48000,
            channelCount: 2,
            codecConfig: opusHeadOf(2),
            primingSamples: 48 + index,
            validSamples: FRAMES * 960 - (48 + index) - (120 + index),
        }));
        const routedPacket = (track, frame) => Uint8Array.of(0xf8, track, frame & 255, frame >>> 8);

        for (const mode of ['standard', 'fragmented'])
            test(`${mode}: 32 sparse audio IDs keep their routing and their trims`, async () => {
                const sink = new MemorySink();
                const muxer = new WebMMuxer(
                    {
                        format: 'mkv',
                        mode,
                        autoSync: false,
                        maxFragmentDuration: 2,
                        audio: routedTracks[0],
                        extraAudioTracks: routedTracks.slice(1),
                    },
                    sink,
                );
                for (let frame = 0; frame < FRAMES; frame++)
                    for (let index = ROUTED - 1; index >= 0; index--) {
                        const chunk = {
                            trackType: 'audio',
                            data: routedPacket(index, frame),
                            timestamp: frame * 0.02,
                            duration: 0.02,
                            isKeyframe: true,
                        };
                        if (index === 0) muxer.addAudioChunk(chunk);
                        else muxer.addExtraAudioChunk(index - 1, chunk);
                    }
                await muxer.finalize();
                const late = {
                    trackType: 'audio',
                    data: routedPacket(0, 0),
                    timestamp: 0,
                    duration: 0.02,
                    isKeyframe: true,
                };
                assert.throws(() => muxer.addAudioChunk(late), /finalized/);
                await assert.rejects(muxer.finalize(), /finalized/);
                const output = sink.toUint8Array();
                const parsed = parseMatroska(output);
                assert.equal(parsed.tracks.length, ROUTED);
                assert.equal(parsed.packets.length, FRAMES * ROUTED);
                for (const [index, track] of routedTracks.entries()) {
                    const packets = parsed.packets.filter(packet => packet.id === track.id);
                    assert.deepEqual(
                        packets.map(packet => [...packet.data]),
                        Array.from({ length: FRAMES }, (_, frame) => [
                            ...routedPacket(index, frame),
                        ]),
                    );
                    // The priming as negative DiscardPadding first, the padding after the last.
                    assert.equal(
                        packets[0].discard,
                        -Math.round((track.primingSamples * 1e9) / 48000),
                    );
                    assert.equal(packets.at(-1).discard, Math.round(((120 + index) * 1e9) / 48000));
                    assert.ok(packets.slice(1, -1).every(packet => packet.discard === 0));
                }
                const read = await demuxed(output);
                assert.ok(read.audioTracks.every(track => track.samples.length === FRAMES));
            });

        test('copied tracks are listed in the order of their source IDs', async () => {
            const sink = new MemorySink();
            const audio = id => ({
                id,
                type: 'audio',
                codec: 'opus',
                sampleRate: 48000,
                channelCount: 2,
                codecConfig: opusHeadOf(2),
            });
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    autoSync: false,
                    audio: audio(1),
                    extraAudioTracks: [audio(2)],
                    subtitleTracks: [{ id: 3, type: 'subtitle', codec: 'text/utf8' }],
                },
                sink,
            );
            const chunk = trackType => ({
                trackType,
                data:
                    trackType === 'subtitle'
                        ? new TextEncoder().encode('cue')
                        : Uint8Array.of(0xf8),
                timestamp: 0,
                duration: 0.02,
                isKeyframe: true,
            });
            muxer.addAudioChunk(chunk('audio'));
            muxer.addExtraAudioChunk(0, chunk('audio'));
            muxer.addSubtitleChunk(chunk('subtitle'));
            await muxer.finalize();
            // The second audio track stays before the subtitle track.
            assert.deepEqual(
                parseMatroska(sink.toUint8Array()).tracks.map(track => track.id),
                [1, 2, 3],
            );
        });

        for (const failure of [false, true])
            test(`a ${failure ? 'failed' : 'finished'} muxer lets its packets go`, async () => {
                // Standard output is written as clusters complete: the muxer holds the packets of
                // the cluster it fills, and none once finalize() has settled. The failing sink
                // takes the header and fails at the first Cluster.
                const muxer = new WebMMuxer(
                    {
                        format: 'mkv',
                        mode: 'standard',
                        autoSync: false,
                        maxFragmentDuration: 2,
                        audio: {
                            type: 'audio',
                            codec: 'opus',
                            sampleRate: 48000,
                            channelCount: 2,
                            codecConfig: opusHeadOf(2),
                        },
                        subtitleTracks: [{ type: 'subtitle', codec: 'text/utf8' }],
                    },
                    {
                        write(bytes) {
                            if (failure && isElement(bytes, 0x1f43b675))
                                throw new Error('Sink failed');
                        },
                        close() {},
                    },
                );
                const write = async () => {
                    for (let index = 0; index < 4000; index++) {
                        muxer.addAudioChunk({
                            trackType: 'audio',
                            data: Uint8Array.of(0xf8, 0, index & 255),
                            timestamp: index * 0.02,
                            duration: 0.02,
                            isKeyframe: true,
                        });
                        muxer.addSubtitleChunk({
                            trackType: 'subtitle',
                            data: new TextEncoder().encode(`Caption ${index}`),
                            timestamp: index * 0.02,
                            duration: 0.02,
                            isKeyframe: true,
                        });
                        if (index === 50) assert.ok(heldPackets(muxer) > 0, 'the cluster it fills');
                    }
                };
                if (failure) {
                    await assert.rejects(write(), /Sink failed/);
                    assert.ok(heldPackets(muxer) > 0, 'the cluster that failed is still held');
                    await assert.rejects(muxer.finalize(), /Sink failed/);
                } else {
                    await write();
                    await muxer.finalize();
                }
                assert.equal(heldPackets(muxer), 0);
            });

        test('a muxer owns the alpha bytes it is handed', async () => {
            const borrowed = Buffer.from([9, 8, 7]);
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'webm',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'vp09.00.10.08',
                        width: 2,
                        height: 2,
                        framerate: 25,
                        alphaMode: true,
                    },
                },
                sink,
            );
            muxer.addVideoChunk({
                trackType: 'video',
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
                data: VP9_FRAME,
                alphaData: borrowed,
            });
            borrowed.fill(0);
            await muxer.finalize();
            const [packet] = await allPackets(sink.toUint8Array());
            assert.deepEqual(packet.alphaData, Uint8Array.of(9, 8, 7));
        });

        test('a BCP 47 language is written with a Language element too', async () => {
            // Readers of Language alone would otherwise assume English.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    ...BASE,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'vp8',
                        width: 16,
                        height: 16,
                        framerate: 25,
                        language: 'es-419',
                    },
                },
                sink,
            );
            muxer.addVideoChunk({
                trackType: 'video',
                data: Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a, 16, 0, 16, 0, 0, 0, 0, 0),
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
            });
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            const hex = Buffer.from(bytes).toString('hex');
            assert.ok(hex.includes(`22b59c83${Buffer.from('spa').toString('hex')}`), 'Language');
            assert.ok(
                hex.includes(`22b59d86${Buffer.from('es-419').toString('hex')}`),
                'LanguageBCP47',
            );
            assert.equal((await readAll(bytes)).tracks[0].language, 'es-419');
        });

        test('VfW VC-1 blocks are stamped in decode order and read back reordered', async () => {
            // VC-1 in VfW mode keeps AVI's timing: block times are decode times. Reading presents
            // the pictures in the MPEG reordering model from their picture types, and MPEG-TS
            // carries the sequence header without the size byte that leads the VfW configuration.
            const headers = Uint8Array.from(
                Buffer.from(
                    '0000010fdbfe3bf21bca3bf886f180c909a5b8d707fc0000010e1adffcefc86c40',
                    'hex',
                ),
            );
            const config = joinBytes([headers.length], headers);
            const frame = first => joinBytes([first], new Uint8Array(15).fill(0x55));
            // An interlaced sequence of progressive frames: FCM 0, then PTYPE 110 (I), 0 (P) or
            // 10 (B).
            const frames = [
                [0x60, 0, 0.08],
                [0x40, 0.04, 0.04],
                [0x00, 0.08, 0.16],
                [0x40, 0.12, 0.12],
                [0x00, 0.16, 0.2],
            ];
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'vc1',
                        width: 32,
                        height: 16,
                        codecConfig: config,
                        framerate: 25,
                    },
                },
                sink,
            );
            for (const [first, decodeTimestamp, timestamp] of frames)
                muxer.addVideoChunk(
                    {
                        trackType: 'video',
                        data: frame(first),
                        timestamp,
                        decodeTimestamp,
                        duration: 0.04,
                        isKeyframe: first === 0x60,
                    },
                    config,
                );
            await muxer.finalize();
            const mkv = sink.toUint8Array();
            // Each frame follows its block header: track number 0x81, the signed 16-bit block time
            // and the flags.
            const blockTimes = [];
            const body = Buffer.from(mkv);
            const filler = Buffer.alloc(15, 0x55);
            for (let at = body.indexOf(filler); at >= 0; at = body.indexOf(filler, at + 15))
                if (body[at - 5] === 0x81) blockTimes.push(body.readInt16BE(at - 4));
            assert.deepEqual(
                blockTimes.map(time => time - blockTimes[0]),
                [0, 40, 80, 120, 160],
            );
            const read = await readAll(mkv);
            const origin = read.packets[0].decodeTimestamp;
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.timestamp - origin)),
                [80, 40, 160, 120, 200],
            );
            const ts = Buffer.from(await copiedTo(mkv, 'ts'));
            assert.notEqual(ts.indexOf(Buffer.from([0, 0, 1, 0x0f])), -1);
            assert.equal(ts.indexOf(Buffer.from([headers.length, 0, 0, 1, 0x0f])), -1);
        });

        test('video written ahead of host-encoded Opus leaves room for its OpusHead', async () => {
            // The streamed header waits for the OpusHead and the window of the pre-skip; another
            // pre-skip cannot follow the header.
            const build = preSkip => {
                const sink = new MemorySink();
                const muxer = new WebMMuxer(
                    {
                        format: 'webm',
                        mode: 'fragmented',
                        maxFragmentDuration: 2,
                        autoSync: true,
                        video: {
                            id: 1,
                            type: 'video',
                            codec: 'vp8',
                            width: 16,
                            height: 16,
                            framerate: 25,
                        },
                        audio: {
                            id: 2,
                            type: 'audio',
                            codec: 'opus',
                            sampleRate: 48000,
                            channelCount: 2,
                        },
                    },
                    sink,
                );
                for (let index = 0; index < 25; index++)
                    muxer.addVideoChunk({
                        data: index ? vp8Interframe : vp8Keyframe,
                        timestamp: index / 25,
                        duration: 0.04,
                        isKeyframe: index === 0,
                        trackType: 'video',
                    });
                const head = Uint8Array.of(
                    ...new TextEncoder().encode('OpusHead'),
                    1,
                    2,
                    preSkip & 255,
                    preSkip >> 8,
                    0x44,
                    0xac,
                    0,
                    0,
                    0,
                    0,
                    0,
                );
                muxer.setAudioPriming(preSkip, 48000);
                for (let index = 0; index < 51; index++)
                    muxer.addAudioChunk(
                        {
                            data: opusPacket,
                            timestamp: index * 0.02,
                            duration: 0.02,
                            isKeyframe: true,
                            trackType: 'audio',
                        },
                        index === 0 ? head : undefined,
                    );
                return { muxer, sink };
            };
            const { muxer, sink } = build(312);
            await muxer.finalize();
            const read = await demuxed(sink.toUint8Array());
            const [audio] = read.audioTracks;
            assert.equal(audio.samples.length, 51);
            assert.ok(Math.abs(audio.matroskaCodecDelaySeconds - 0.0065) < 1e-6);
            assert.equal(audio.opusTrailingPaddingSamples, 51 * 960 - 312 - 48000);
            assert.throws(() => build(356), { code: 'MUX' });
        });

        test('re-encoded video keeps a copied Opus window ahead of the header', async () => {
            const codecs = installVideoCodecs();
            try {
                const input = webmClip({ codecId: 'V_VP8', frames: 12, keyframeInterval: 6 });
                const { blob } = await convert(input, 'webm', {
                    video: { codec: 'vp8', bitrate: 300000 },
                });
                const read = await demuxed(await bytesOf(blob));
                assert.equal(read.audioTracks[0].samples.length, 20);
                assert.ok(Math.abs(read.audioTracks[0].matroskaCodecDelaySeconds - 0.0065) < 1e-6);
                assert.equal(read.videoTracks[0].samples.length, 12);
            } finally {
                codecs.restore();
            }
        });
    });

    describe('track titles', () => {
        test('a name and a title apart use explicit 64-bit TrackUID targets', () => {
            const uid = 0xfffffffffffffff0n;
            const titled = [
                { matroskaTrackUid: uid, title: '主音声 🎵' },
                { matroskaTrackUid: 2n, title: '' },
            ];
            const bytes = mergeMatroskaTrackTitles(undefined, titled);
            assert.deepEqual(
                [...readMatroskaTrackTitles(bytes)],
                [
                    [uid, '主音声 🎵'],
                    [2n, ''],
                ],
            );
            assert.ok(new TextDecoder().decode(bytes).includes('TITLE'));
            assert.deepEqual(mergeMatroskaTrackTitles(bytes, titled), bytes);
            assert.deepEqual(
                [
                    ...readMatroskaTrackTitles(
                        mergeMatroskaTrackTitles(bytes, [{ matroskaTrackUid: 3n, title: '追加' }]),
                    ),
                ],
                [
                    [uid, '主音声 🎵'],
                    [2n, ''],
                    [3n, '追加'],
                ],
            );
        });

        test('conflicting or malformed title targets cannot change metadata silently', () => {
            const bytes = mergeMatroskaTrackTitles(undefined, [
                { matroskaTrackUid: 1n, title: 'original' },
            ]);
            assert.throws(
                () => mergeMatroskaTrackTitles(bytes, [{ matroskaTrackUid: 1n, title: 'changed' }]),
                /conflict/i,
            );
            const invalid = reason => error =>
                error.code === 'FORMAT' && reason.test(error.message);
            assert.throws(
                () =>
                    mergeMatroskaTrackTitles(undefined, [{ matroskaTrackUid: 0n, title: 'zero' }]),
                invalid(/Invalid Matroska track title or UID/),
            );
            assert.throws(
                () =>
                    mergeMatroskaTrackTitles(undefined, [
                        { matroskaTrackUid: 1n, title: 'nul\0text' },
                    ]),
                invalid(/Invalid Matroska track title or UID/),
            );
            assert.throws(
                () => mergeMatroskaTrackTitles(bytes.subarray(0, bytes.length - 1), []),
                invalid(/Invalid Matroska title metadata/),
            );
        });

        test('the movie title and distinct track titles go to MKV and back to MP4', async () => {
            // Under metadataPolicy 'error', nothing of them is lost.
            const fixture = preservationFixture({
                title: '映画 🎬',
                tracks: [{ type: 'audio', name: 'Name', title: '題名', default: true }],
            });
            const input = await open(fixture.bytes, { metadataPolicy: 'error' });
            let mkv;
            try {
                mkv = await open((await input.convert('mkv', { copy: true })).blob, {
                    metadataPolicy: 'error',
                });
                const back = await readAll((await mkv.convert('mp4', { copy: true })).blob);
                assert.equal(back.title, '映画 🎬');
                assert.deepEqual(
                    [back.tracks[0].name, back.tracks[0].title, back.tracks[0].default],
                    ['Name', '題名', true],
                );
            } finally {
                input.close();
                mkv?.close();
            }
        });
    });

    describe('copies of Matroska', () => {
        const tagsOf = (...tags) => element(0x1254c367, ...tags);
        const globalTag = element(
            0x7373,
            element(0x63c0),
            simpleTag('ARTIST', '芸術家'),
            simpleTag('COMMENT', 'Global comment'),
        );
        const scopedTag = element(
            0x7373,
            element(0x63c0, uint(0x63c5, 1n + (1n << 60n))),
            simpleTag('COMMENT', 'Track comment'),
        );
        /** Video, two Opus tracks and WebVTT, all named, with `extra` after the Tracks. */
        const namedFile = (extra = tagsOf(globalTag)) =>
            matroskaFile([
                info(string(0x7ba9, '作品の題名')),
                tracks(
                    trackEntry(
                        1,
                        1,
                        'V_VP9',
                        uint(0x73c5, 1n + (1n << 60n)),
                        string(0x536e, '主映像'),
                        uint(0x55af, 0),
                        videoShape(2, 2),
                    ),
                    opusEntry(2, string(0x536e, 'Director commentary'), uint(0x55af, 1)),
                    opusEntry(3, string(0x536e, 'Main audio'), uint(0x55af, 0)),
                    trackEntry(
                        4,
                        17,
                        'D_WEBVTT/SUBTITLES',
                        uint(0x73c5, 4n + (1n << 60n)),
                        string(0x536e, '字幕'),
                        uint(0x55af, 1),
                    ),
                ),
                extra,
                cluster(
                    0,
                    simpleBlock(1, 0, VP9_FRAME),
                    simpleBlock(2, 0, OPUS_FRAME),
                    simpleBlock(3, 0, OPUS_FRAME),
                    blockGroup(4, 0, [10, 10, 65], uint(0x9b, 1000)),
                ),
            ]);
        const NAMED = [
            ['主映像', false],
            ['Director commentary', true],
            ['Main audio', false],
            ['字幕', true],
        ];

        for (const format of ['mkv', 'webm'])
            test(`${format} keeps the title, the tags, names and commentary flags`, async () => {
                const input = namedFile();
                assert.equal((await check(input, { to: format, copy: true })).supported, true);
                const output = await copiedTo(input, format);
                const decoded = await demuxed(output);
                assert.equal(decoded.matroskaPassThrough.title, '作品の題名');
                assert.deepEqual(decoded.matroskaPassThrough.tags, tagsOf(globalTag));
                const read = await readAll(output);
                assert.deepEqual(
                    read.tracks.map(track => [track.name, track.commentary]),
                    NAMED,
                );
                // An unknown language is written as und, never as the default eng.
                assert.deepEqual(
                    read.tracks.map(track => track.language),
                    ['und', 'und', 'und', 'und'],
                );
            });

        test('a WebM copy of one track keeps the file metadata and its name', async () => {
            const decoded = await demuxed(await copiedTo(namedFile(), 'webm', { trackIds: [2] }));
            assert.equal(decoded.matroskaPassThrough.title, '作品の題名');
            assert.deepEqual(decoded.matroskaPassThrough.tags, tagsOf(globalTag));
            assert.deepEqual(
                [decoded.audioTracks[0].name, decoded.audioTracks[0].commentary],
                ['Director commentary', true],
            );
        });

        test('a tag of a track goes to Matroska with every track copied', async () => {
            const input = namedFile(tagsOf(globalTag, scopedTag));
            const support = await check(input, { to: 'mkv', copy: true });
            assert.ok(!support.warnings.some(w => w.code === 'MATROSKA_METADATA_LOSS'));
            const decoded = await demuxed(await copiedTo(input, 'mkv'));
            assert.deepEqual(decoded.matroskaPassThrough.tags, tagsOf(globalTag, scopedTag));
        });

        test('a tag of a track left out is lost with a warning, also when strict', async () => {
            const input = namedFile(tagsOf(globalTag, scopedTag));
            const support = await check(input, { to: 'mkv', copy: true, trackIds: [2, 3, 4] });
            assert.equal(support.supported, true);
            const result = await convert(input, {
                to: 'mkv',
                copy: true,
                trackIds: [2, 3, 4],
                open: { validation: 'strict' },
                onWarning() {},
            });
            assert.ok(result.warnings.some(w => w.code === 'MATROSKA_METADATA_LOSS'));
            assert.deepEqual(
                (await demuxed(await bytesOf(result))).matroskaPassThrough.tags,
                tagsOf(globalTag),
            );
            const mp4 = await check(input, { to: 'mp4', copy: true, trackIds: [1, 2] });
            assert.ok(mp4.warnings.some(w => w.code === 'MATROSKA_METADATA_LOSS'));
        });

        test('WebM has no chapters: a copy leaves them out with a warning', async () => {
            const input = namedFile(join(tagsOf(globalTag), element(0x1043a770)));
            const support = await check(input, { to: 'webm', copy: true });
            assert.ok(support.warnings.some(w => /chapters/.test(w.message)));
            const decoded = await demuxed(await copiedTo(input, 'webm'));
            assert.equal(decoded.matroskaPassThrough.title, '作品の題名');
            assert.deepEqual(decoded.matroskaPassThrough.tags, tagsOf(globalTag));
            assert.equal(decoded.matroskaPassThrough.chapters, undefined);
        });

        test('the common tags of the file move into the MP4 item list', async () => {
            // ARTIST and COMMENT have MP4 items; names and commentary are not reported lost.
            const input = namedFile();
            const support = await check(input, { to: 'mp4', copy: true, trackIds: [1, 2] });
            assert.ok(!support.warnings.some(w => /METADATA_LOSS/.test(w.code)));
            assert.ok(!support.warnings.some(w => /name|commentary/i.test(w.message)));
            const mp4 = await new Mp4Demuxer().demux(
                new BufferSource(await copiedTo(input, 'mp4', { trackIds: [1, 2] })),
            );
            assert.equal(mp4.title, '作品の題名');
            assert.deepEqual(
                mp4.tags.entries.filter(entry => entry.key !== 'title'),
                [
                    { key: 'artist', value: '芸術家' },
                    { key: 'comment', value: 'Global comment' },
                ],
            );
        });

        test('colour, HDR mastering and the field order survive MKV, WebM and MP4', async () => {
            // WebM has no FieldOrder or accessibility flags, MP4 no hearing-impaired flag on
            // sound: those losses are reported.
            const mastering = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329, 1000, 0.01];
            const colour = element(
                0x55b0,
                uint(0x55b1, 9),
                uint(0x55ba, 16),
                uint(0x55bb, 9),
                uint(0x55bc, 1000),
                uint(0x55bd, 400),
                element(0x55d0, ...mastering.map((value, index) => float(0x55d1 + index, value))),
            );
            const hdr = matroskaFile([
                tracks(
                    trackEntry(
                        1,
                        1,
                        'V_VP9',
                        videoShape(2, 2, uint(0x9a, 1), uint(0x9d, 6), colour),
                    ),
                    opusEntry(2, uint(0x55ab, 1)),
                ),
                cluster(0, simpleBlock(1, 0, VP9_FRAME), simpleBlock(2, 0, OPUS_FRAME)),
            ]);
            const expected = (await demuxed(hdr)).videoTracks[0].colour;
            const mkv = await demuxed(await copiedTo(hdr, 'mkv'));
            assert.deepEqual(mkv.videoTracks[0].colour, expected);
            assert.equal(mkv.videoTracks[0].fieldOrder, 'bb');
            assert.deepEqual(mkv.audioTracks[0].dispositions, { hearingImpaired: true });
            const webm = await convert(hdr, { to: 'webm', copy: true, onWarning() {} });
            assert.ok(
                webm.warnings.some(
                    w => w.code === 'TRACK_DISPOSITION_LOSS' && /hearingImpaired/.test(w.message),
                ),
            );
            const webmCopy = await demuxed(await bytesOf(webm));
            assert.deepEqual(webmCopy.videoTracks[0].colour, expected);
            assert.equal(webmCopy.audioTracks[0].dispositions, undefined);
            const mp4 = await convert(hdr, { to: 'mp4', copy: true, onWarning() {} });
            assert.ok(mp4.warnings.some(w => w.code === 'TRACK_DISPOSITION_LOSS'));
            const written = (await new Mp4Demuxer().demux(new BufferSource(await bytesOf(mp4))))
                .videoTracks[0];
            const near = (actual, wanted) =>
                assert.ok(Math.abs(actual - wanted) <= 1e-4, `${actual} vs ${wanted}`);
            assert.deepEqual(
                [written.colour.primaries, written.colour.transfer, written.colour.matrix],
                [9, 16, 9],
            );
            assert.deepEqual(written.colour.contentLight, expected.contentLight);
            for (const key of ['red', 'green', 'blue', 'whitePoint'])
                expected.mastering[key].forEach((value, index) =>
                    near(written.colour.mastering[key][index], value),
                );
            near(written.colour.mastering.maxLuminance, 1000);
            near(written.colour.mastering.minLuminance, 0.01);
            assert.equal(written.fieldOrder, 'bb');
        });

        describe('dispositions', () => {
            const dispositions = matroskaFile([
                tracks(
                    opusEntry(1, uint(0x88, 0), uint(0x55aa, 0)),
                    opusEntry(2, uint(0x88, 1)),
                    trackEntry(3, 17, 'S_TEXT/UTF8', uint(0x88, 0), uint(0x55aa, 1)),
                ),
                cluster(
                    0,
                    simpleBlock(1, 0, OPUS_FRAME),
                    simpleBlock(2, 0, OPUS_FRAME),
                    blockGroup(3, 0, [65], uint(0x9b, 1000)),
                ),
            ]);
            const flagsOf = async bytes =>
                (await readAll(bytes)).tracks.map(track => [track.default, track.forced]);
            const EXPECTED = [
                [false, false],
                [true, false],
                [false, true],
            ];

            test('a Matroska copy keeps the default sound and the forced subtitles', async () => {
                assert.deepEqual(await flagsOf(await copiedTo(dispositions, 'mkv')), EXPECTED);
                assert.deepEqual(
                    await flagsOf(await bytesOf(await convert(dispositions, 'mkv'))),
                    EXPECTED,
                );
            });

            test('an MP4 copy of the sound keeps its flags, also when strict', async () => {
                const result = await convert(dispositions, {
                    to: 'mp4',
                    copy: true,
                    trackIds: [1, 2],
                    open: { validation: 'strict' },
                });
                assert.deepEqual(await flagsOf(await bytesOf(result)), EXPECTED.slice(0, 2));
                assert.ok(!result.warnings.some(w => w.code === 'TRACK_DISPOSITION_LOSS'));
                const packaged = await packageMedia(dispositions, 'hls', { trackIds: [1, 2] });
                assert.ok(!packaged.warnings.some(w => w.code === 'TRACK_DISPOSITION_LOSS'));
            });

            test('MP4 marks only subtitles forced: a forced sound loses it, reported', async () => {
                const forcedAudio = matroskaFile([
                    tracks(opusEntry(1, uint(0x55aa, 1))),
                    cluster(0, simpleBlock(1, 0, OPUS_FRAME)),
                ]);
                const copy = await convert(forcedAudio, 'mp4');
                assert.ok(
                    copy.warnings.some(
                        w => w.code === 'TRACK_DISPOSITION_LOSS' && /forced/.test(w.message),
                    ),
                );
                assert.deepEqual(await flagsOf(await bytesOf(copy)), [[true, false]]);
            });
        });

        describe('alpha', () => {
            const ALPHA = [9, 8, 7];
            const alphaFile = (codecId = 'V_VP9', frame = VP9_FRAME) =>
                matroskaFile([
                    tracks(
                        trackEntry(
                            1,
                            1,
                            codecId,
                            uint(0x73c5, 1n + (1n << 60n)),
                            videoShape(2, 2, uint(0x53c0, 1)),
                        ),
                    ),
                    cluster(
                        0,
                        blockGroup(
                            1,
                            0,
                            frame,
                            uint(0x9b, 40),
                            element(0x75a1, element(0xa6, uint(0xee, 1), element(0xa5, ALPHA))),
                        ),
                    ),
                ]);
            const strictly = { open: { validation: 'strict' } };

            for (const format of ['mkv', 'webm'])
                test(`${format} keeps the alpha channel`, async () => {
                    const read = await readAll(await copiedTo(alphaFile(), format));
                    assert.equal(read.tracks[0].alphaMode, true);
                    assert.deepEqual(read.packets[0].alphaData, Uint8Array.from(ALPHA));
                });

            test('MP4 copies the colour pictures without their alpha, reported', async () => {
                const result = await convert(alphaFile(), {
                    to: 'mp4',
                    copy: true,
                    onWarning() {},
                });
                assert.ok(result.warnings.some(w => w.code === 'ALPHA_DROPPED'));
                const read = await readAll(await bytesOf(result));
                assert.ok(!read.tracks[0].alphaMode);
                assert.deepEqual(read.packets[0].data, VP9_FRAME);
                assert.equal(read.packets[0].alphaData, undefined);
                const packaged = await packageMedia(alphaFile(), 'hls');
                assert.ok(packaged.files.size > 0);
            });

            test('strict validation refuses to lose the alpha channel', async () => {
                await assert.rejects(convert(alphaFile(), 'mp4', strictly), {
                    code: 'FORMAT',
                    message:
                        'mp4 cannot copy or re-encode these tracks (it cannot keep the alpha ' +
                        'channel)',
                });
                await assert.rejects(packageMedia(alphaFile(), 'hls', strictly), /alpha/i);
                await assert.rejects(
                    convert(alphaFile(), 'webm', { video: { width: 4 }, ...strictly }),
                    /alpha/i,
                );
            });

            test('VP8 with alpha names why MP4 can neither copy nor re-encode it', async () => {
                const vp8 = alphaFile(
                    'V_VP8',
                    Uint8Array.of(0x50, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0),
                );
                await assert.rejects(convert(vp8, 'mp4', strictly), {
                    code: 'FORMAT',
                    message:
                        'mp4 cannot copy these tracks (it cannot hold vp8) or re-encode them (it ' +
                        'cannot keep the alpha channel)',
                    cause:
                        "copy: mp4 cannot mux video codec 'vp8'; re-encode: mp4 cannot keep " +
                        'the alpha channel',
                });
            });

            test('a CMAF writer refuses alpha data', () => {
                const writer = new CmafWriter({
                    tracks: [{ id: 1, type: 'subtitle', codec: 'wvtt', timescale: 1000 }],
                });
                assert.throws(
                    () =>
                        writer.addChunk(1, {
                            trackType: 'subtitle',
                            timestamp: 0,
                            duration: 1,
                            isKeyframe: true,
                            data: Uint8Array.of(0, 0, 0, 8, 118, 116, 116, 101),
                            alphaData: Uint8Array.of(2),
                        }),
                    /alpha/i,
                );
            });
        });

        describe('MPEG audio', () => {
            const frameDuration = layer => (layer === 1 ? 384 : 1152) / 44100;
            /** Asserts the payloads and times of `actual` against `expected`, frames of `layer`. */
            const assertFrames = (actual, expected, layer) => {
                assert.equal(actual.length, expected.length);
                actual.forEach((packet, i) => {
                    assert.deepEqual(packet.data, expected[i].data, `packet ${i}`);
                    assert.ok(Math.abs(packet.timestamp - expected[i].timestamp) <= 0.000501);
                    assert.ok(Math.abs(packet.duration - frameDuration(layer)) < 1e-10);
                });
            };

            for (const layer of [1, 2])
                test(`raw layer ${layer} audio goes into Matroska and back as it was`, async () => {
                    const original = mpegAudioFixture(layer);
                    assert.equal(
                        (await check(original, { to: 'mkv', copy: true })).supported,
                        true,
                    );
                    const mkv = await copiedTo(original, 'mkv');
                    assert.ok(Buffer.from(mkv).includes(Buffer.from(`A_MPEG/L${layer}`)));
                    const read = await readAll(mkv);
                    assert.deepEqual(
                        [
                            read.tracks[0].codec,
                            read.tracks[0].sampleRate,
                            read.tracks[0].channelCount,
                        ],
                        [`mp${layer}`, 44100, 1],
                    );
                    assertFrames(read.packets, await allPackets(original), layer);
                    assert.deepEqual(await copiedTo(mkv, `mp${layer}`), original);
                });

            test('two MPEG audio tracks from TS keep languages, frames and times', async () => {
                const inputs = await Promise.all(
                    [1, 2].map(layer => readAll(mpegAudioFixture(layer))),
                );
                const sink = new MemorySink();
                const tracksOut = inputs.map((read, i) => ({
                    ...read.tracks[0],
                    id: i + 4,
                    language: i ? 'jpn' : 'eng',
                }));
                const muxer = new TsMuxer(
                    {
                        format: 'ts',
                        mode: 'standard',
                        maxFragmentDuration: 2,
                        autoSync: true,
                        audio: tracksOut[0],
                        extraAudioTracks: [tracksOut[1]],
                    },
                    sink,
                );
                const stream = inputs.flatMap((read, i) =>
                    read.packets.map(packet => ({ i, packet })),
                );
                stream.sort((a, b) => a.packet.timestamp - b.packet.timestamp);
                for (const { i, packet } of stream)
                    if (i === 0) muxer.addAudioChunk(packet);
                    else muxer.addExtraAudioChunk(0, packet);
                await muxer.finalize();
                const ts = sink.toUint8Array();
                const tsRead = await readAll(ts);
                assert.deepEqual(
                    tsRead.tracks.map(track => [track.codec, track.language]),
                    [
                        ['mp1', 'eng'],
                        ['mp2', 'jpn'],
                    ],
                );
                assert.equal((await check(ts, { to: 'mkv', copy: true })).supported, true);
                const mkv = await readAll(await copiedTo(ts, 'mkv'));
                assert.equal(mkv.tracks.length, 2);
                for (let i = 0; i < 2; i++) {
                    const track = mkv.tracks[i];
                    assert.deepEqual(
                        [track.codec, track.language],
                        [`mp${i + 1}`, i ? 'jpn' : 'eng'],
                    );
                    assertFrames(
                        mkv.packets.filter(packet => packet.trackId === track.id),
                        tsRead.packets.filter(packet => packet.trackId === tsRead.tracks[i].id),
                        i + 1,
                    );
                }
            });
        });
    });

    describe('audio decoded from Matroska', () => {
        /** The samples of `a` that differ from those of `b` by more than one step. */
        const mismatches = (a, b) => a.filter((value, index) => Math.abs(value - b[index]) > 1);

        test('FLAC copied into Matroska decodes to the samples it was coded from', async () => {
            const samples = testSignal(4096 * 2 + 77, 2);
            const flac = await bytesOf(await convert(waveFile(samples, 48000, 2), 'flac'));
            const mkv = await copiedTo(flac, 'mkv');
            const decoded = await waveSamples((await convert(mkv, 'wav')).blob);
            assert.equal(decoded.length, samples.length);
            assert.equal(mismatches(decoded, samples).length, 0);
        });

        test('joined files keep each DiscardPadding, trimming that block alone', async () => {
            // FFmpeg's concat demuxer writes them so: a positive DiscardPadding before the last
            // block trims that block, as FFmpeg reads it. The packet states the samples it drops,
            // decoding drops them, a copy into Matroska keeps them.
            const samples = testSignal(4096 * 6, 2, 21);
            const flac = await bytesOf(await convert(waveFile(samples, 32000, 2), 'flac'));
            const info = parseFlacStreamInfo(flac.subarray(0, 42));
            const frames = [];
            for (let at = 42; at < flac.length;) {
                const { byteLength } = decodeFlacFrame(flac.subarray(at), { streamInfo: info });
                frames.push(flac.subarray(at, at + byteLength));
                at += byteLength;
            }
            // The third frame (128 ms) keeps 98 ms: its last 960 samples (30 ms) are padding.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    audio: {
                        codec: 'flac',
                        codecConfig: flac.subarray(0, 42),
                        sampleRate: 32000,
                        channelCount: 2,
                    },
                },
                sink,
            );
            frames.forEach((data, index) =>
                muxer.addAudioChunk({
                    data,
                    timestamp: index * 0.128 - (index > 2 ? 0.03 : 0),
                    duration: 0.128,
                    isKeyframe: true,
                    trackType: 'audio',
                    ...(index === 2 ? { trailingDiscard: 960 } : {}),
                }),
            );
            await muxer.finalize();
            const joined = sink.toUint8Array();
            const discards = async bytes =>
                (await allPackets(bytes)).flatMap((packet, index) =>
                    packet.trailingDiscard ? [[index, packet.trailingDiscard]] : [],
                );
            assert.deepEqual(await discards(joined), [[2, 960]]);
            const expected = Int16Array.from([
                ...samples.subarray(0, (4096 * 3 - 960) * 2),
                ...samples.subarray(4096 * 3 * 2),
            ]);
            const decoded = await waveSamples((await convert(joined, 'wav')).blob);
            assert.equal(decoded.length, expected.length, 'the padding is not decoded');
            assert.equal(mismatches(decoded, expected).length, 0);
            assert.deepEqual(await discards(await copiedTo(joined, 'mkv')), [[2, 960]]);
        });

        test('MP3 copied into Matroska keeps its priming and padding', async () => {
            const rate = 44100;
            const frames = rate + 555;
            const planes = [new Float32Array(frames), new Float32Array(frames)];
            for (let index = 0; index < frames; index++)
                for (let channel = 0; channel < 2; channel++)
                    planes[channel][index] =
                        0.4 * Math.sin((2 * Math.PI * (channel ? 660 : 440) * index) / rate);
            const mp3 = await encodeMp3(planes, { sampleRate: rate, bitrate: 96 });
            const raw = await waveSamples((await convert(mp3, 'wav')).blob);
            assert.equal(raw.length, frames * 2, 'raw MP3 decodes to its gapless length');
            const mkv = await copiedTo(mp3, 'mkv');
            assert.equal((await readAll(mkv)).tracks[0].codec, 'mp3');
            const decoded = await waveSamples((await convert(mkv, 'wav')).blob);
            assert.equal(decoded.length, raw.length);
            assert.equal(mismatches(decoded, raw).length, 0);
        });
    });

    test('capabilities list the codecs MKV copies that nothing decodes', async () => {
        const { copyOnly, videoCopy, audioCopy } = await capabilities();
        for (const codec of ['theora', 'vvc1', 'dvh1'])
            assert.ok(copyOnly.video.includes(codec), codec);
        assert.ok(copyOnly.audio.includes('speex'));
        for (const codec of ['theora', 'vvc1', 'av01'])
            assert.ok(videoCopy.mkv.includes(codec), codec);
        // Speex is read only.
        assert.ok(!audioCopy.mkv.includes('speex'));
    });

    describe('several tracks of a type, and PCM', () => {
        // Two video and two audio tracks of fixed TrackNumbers and UIDs, names, languages and flags
        // (multitrack-pcm-fixtures.mjs), copied or written track by track.
        const bytesOf = async sink => new Uint8Array(await sink.toBlob().arrayBuffer());

        const config = (mode = 'standard') => {
            const video = track => ({
                id: track.id,
                matroskaTrackUid: track.uid,
                type: 'video',
                codec: 'vp8',
                width: track.width,
                height: track.height,
                framerate: 50,
                name: track.name,
                language: track.language,
                default: track.default,
                forced: track.forced,
            });
            const audio = track => ({
                id: track.id,
                matroskaTrackUid: track.uid,
                type: 'audio',
                codec: 'opus',
                sampleRate: 48000,
                channelCount: track.channels,
                codecConfig: opusHeadOf(track.channels),
                name: track.name,
                language: track.language,
                default: track.default,
                forced: track.forced,
            });
            return {
                format: 'mkv',
                mode,
                maxFragmentDuration: 2,
                autoSync: true,
                video: video(trackSpecs[0]),
                audio: audio(trackSpecs[1]),
                extraVideoTracks: [video(trackSpecs[2])],
                extraAudioTracks: [audio(trackSpecs[3])],
            };
        };
        const put = (muxer, packet) => {
            if (packet.id === 7) muxer.addVideoChunk(packet);
            else if (packet.id === 129) muxer.addExtraVideoChunk(0, packet);
            else if (packet.id === 33) muxer.addAudioChunk(packet);
            else muxer.addExtraAudioChunk(0, packet);
        };
        const verifyTracks = parsed => {
            assert.equal(parsed.tracks.length, 4);
            for (const spec of trackSpecs) {
                const found = parsed.tracks.find(track => track.id === spec.id);
                assert(found, `TrackNumber ${spec.id} must remain distinct and stable`);
                for (const key of ['uid', 'codec', 'name', 'language', 'default', 'forced'])
                    assert.deepEqual(found[key], spec[key], `${spec.id}.${key}`);
                for (const key of spec.type === 'video' ? ['width', 'height'] : ['channels'])
                    assert.equal(found[key], spec[key]);
                assert.deepEqual(
                    parsed.packets
                        .filter(packet => packet.id === spec.id)
                        .map(packet => [...packet.data]),
                    trackPackets
                        .filter(packet => packet.id === spec.id)
                        .map(packet => [...packet.data]),
                );
            }
        };

        test('two video and two audio tracks keep numbers, bytes and flags in a copy', async () => {
            const original = matroskaFixture();
            verifyTracks(parseMatroska(original));
            const media = await open(original);
            try {
                const support = await media.check('mkv', { copy: true });
                assert.equal(support.supported, true, support.reason);
                verifyTracks(
                    parseMatroska(
                        new Uint8Array(
                            await (await media.convert('mkv', { copy: true })).blob.arrayBuffer(),
                        ),
                    ),
                );
            } finally {
                media.close();
            }
        });

        for (const mode of ['standard', 'fragmented'])
            test(`direct ${mode} Matroska keeps interleaved tracks independent`, async () => {
                const sink = new MemorySink();
                const muxer = new WebMMuxer(config(mode), sink);
                for (const packet of [...trackPackets].sort(
                    (a, b) => a.timestamp - b.timestamp || b.id - a.id,
                ))
                    put(muxer, packet);
                await muxer.finalize();
                const bytes = await bytesOf(sink);
                const parsed = parseMatroska(bytes);
                verifyTracks(parsed);
                assert.equal(parsed.fragmented, mode === 'fragmented');
                assert.equal(parsed.cues, mode === 'standard');
                const restored = await new WebMDemuxer().demux(new Blob([bytes]));
                assert.equal(restored.videoTracks.length, 2);
                assert.equal(restored.audioTracks.length, 2);
            });

        for (const mode of ['standard', 'fragmented'])
            for (const missingId of [129, 201])
                test(`a ${mode} file refuses extra track ${missingId} if empty`, async () => {
                    const muxer = new WebMMuxer(config(mode), new MemorySink());
                    put(
                        muxer,
                        trackPackets.find(packet => packet.id === 7),
                    );
                    put(
                        muxer,
                        trackPackets.find(packet => packet.id === 33),
                    );
                    put(
                        muxer,
                        trackPackets.find(packet => packet.id === (missingId === 129 ? 201 : 129)),
                    );
                    await assert.rejects(muxer.finalize(), /no .*chunks|without .*packets/i);
                });

        test(
            'extra video snapshots codec configuration, colour and display metadata ' +
                'independently',
            async () => {
                const cfg = config();
                cfg.video.codec = 'avc1.42c00b';
                cfg.video.codecConfig = Uint8Array.of(1, 0x42, 0, 0xb, 0xff);
                const extra = cfg.extraVideoTracks[0];
                extra.codec = 'avc1.640028';
                extra.codecConfig = Uint8Array.of(1, 0x64, 0, 0x28, 0xff);
                extra.colour = { primaries: 9, transfer: 16, matrix: 9, fullRange: true };
                extra.displayWidth = 64;
                const sink = new MemorySink();
                const muxer = new WebMMuxer(cfg, sink);
                extra.codecConfig.fill(0);
                extra.colour.primaries = 1;
                extra.width = 999;
                for (const packet of trackPackets)
                    put(
                        muxer,
                        packet.trackType === 'video'
                            ? { ...packet, data: Uint8Array.of(0, 0, 0, 2, 0x65, packet.id) }
                            : packet,
                    );
                await muxer.finalize();
                const parsed = parseMatroska(await bytesOf(sink));
                assert.deepEqual(
                    [...parsed.tracks.find(track => track.id === 7).codecPrivate],
                    [1, 0x42, 0, 0xb, 0xff],
                );
                const output = parsed.tracks.find(track => track.id === 129);
                assert.deepEqual([...output.codecPrivate], [1, 0x64, 0, 0x28, 0xff]);
                assert.deepEqual(output.colour, [
                    [0x55b9, 2],
                    [0x55b1, 9],
                    [0x55ba, 16],
                    [0x55bb, 9],
                ]);
                assert.equal(output.width, 32);
            },
        );

        test('each cue names a track present in the sparse cluster it points to', async () => {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(config(), sink);
            for (const id of [7, 129, 33, 201])
                put(
                    muxer,
                    trackPackets.find(packet => packet.id === id),
                );
            for (const timestamp of [3, 6])
                put(muxer, { ...trackPackets.find(packet => packet.id === 129), timestamp });
            await muxer.finalize();
            const parsed = parseMatroska(await bytesOf(sink));
            assert.equal(parsed.cuePoints.length, 3);
            for (const point of parsed.cuePoints) {
                const cluster = parsed.clusters.find(item => item.offset === point.offset);
                assert(cluster, 'CueClusterPosition must address a complete Cluster');
                assert(
                    cluster.tracks.includes(point.track),
                    'CueTrack must identify a packet in the referenced Cluster',
                );
            }
        });

        test('sparse extra audio in fragments trims its padding from its last packet', async () => {
            const cfg = config('fragmented');
            cfg.extraAudioTracks[0].validSamples = 480;
            const sink = new MemorySink();
            const muxer = new WebMMuxer(cfg, sink);
            for (const id of [201, 129, 33, 7])
                put(
                    muxer,
                    trackPackets.find(packet => packet.id === id),
                );
            for (const timestamp of [3, 6, 9]) put(muxer, { ...trackPackets[0], timestamp });
            await muxer.finalize();
            const parsed = parseMatroska(await bytesOf(sink));
            const sparse = parsed.packets.filter(packet => packet.id === 201);
            assert.equal(sparse.length, 1);
            assert.equal(sparse[0].discard, 10000000);
            assert.equal(parsed.packets.filter(packet => packet.discard).length, 1);
            assert.equal(
                (await new WebMDemuxer().demux(new Blob([await bytesOf(sink)]))).audioTracks.length,
                2,
            );
        });

        for (const [bits, floating, codecId, codec] of [
            [8, false, 'A_PCM/INT/LIT', 'pcm-u8'],
            [16, false, 'A_PCM/INT/LIT', 'pcm-s16le'],
            [24, false, 'A_PCM/INT/LIT', 'pcm-s24le'],
            [32, false, 'A_PCM/INT/LIT', 'pcm-s32le'],
            [32, true, 'A_PCM/FLOAT/IEEE', 'pcm-f32le'],
            [64, true, 'A_PCM/FLOAT/IEEE', 'pcm-f64le'],
        ]) {
            test(`AVI ${codec} copies into MKV with its encoding and channel frames`, async () => {
                const fixture = aviPcmFixture({ bits, float: floating });
                const source = new Blob([fixture.bytes]);
                const demuxed = await new AviDemuxer().demux(source);
                assert.equal(demuxed.audioTracks[0].codec, codec);
                const media = await open(fixture.bytes);
                try {
                    const support = await media.check('mkv', { copy: true });
                    assert.equal(support.supported, true, support.reason);
                    const output = new Uint8Array(
                        await (await media.convert('mkv', { copy: true })).blob.arrayBuffer(),
                    );
                    const parsed = parseMatroska(output);
                    assert.equal(parsed.tracks[0].codec, codecId);
                    assert.equal(parsed.tracks[0].bits, bits);
                    assert.equal(parsed.tracks[0].channels, 2);
                    assert.equal(parsed.tracks[0].codecPrivate, undefined);
                    assert.deepEqual(
                        join(...parsed.packets.map(packet => packet.data)),
                        join(...fixture.packets),
                    );
                    const restored = await new WebMDemuxer().demux(new Blob([output]));
                    assert.equal(restored.audioTracks[0].codec, codec);
                } finally {
                    media.close();
                }
            });
        }

        test(
            'Matroska PCM validates byte order, channel count, bit depth and complete ' + 'blocks',
            async () => {
                for (const codec of ['pcm-s8', 'pcm-f32be', 'pcm-f64be'])
                    assert.throws(
                        () =>
                            new WebMMuxer(
                                {
                                    format: 'mkv',
                                    mode: 'standard',
                                    maxFragmentDuration: 2,
                                    autoSync: true,
                                    audio: {
                                        id: 1,
                                        type: 'audio',
                                        codec,
                                        sampleRate: 8000,
                                        channelCount: 1,
                                    },
                                },
                                new MemorySink(),
                            ),
                        error =>
                            error.code === 'FORMAT' &&
                            /Matroska PCM cannot preserve/.test(error.message),
                    );
                for (const [codecId, bits, channels, data, reason] of [
                    ['A_PCM/INT/LIT', 12, 1, [0, 0], /explicit BitDepth/],
                    ['A_PCM/INT/LIT', 16, 0, [0, 0], /invalid Channels/],
                    ['A_PCM/INT/LIT', 16, 2, [0, 0, 0], /complete channel frames/],
                    ['A_PCM/FLOAT/IEEE', 16, 1, [0, 0], /explicit BitDepth/],
                ])
                    await assert.rejects(
                        new WebMDemuxer().demux(
                            new Blob([
                                matroskaFixture({
                                    pcm: { codec: codecId, bits, channels, sampleRate: 8000 },
                                    packets: [{ id: 1, timestamp: 0, data }],
                                }),
                            ]),
                        ),
                        error => error.code === 'DEMUX' && reason.test(error.message),
                    );
                const output = new MemorySink();
                const muxer = new WebMMuxer(
                    {
                        format: 'mkv',
                        mode: 'standard',
                        maxFragmentDuration: 2,
                        autoSync: true,
                        audio: {
                            id: 1,
                            type: 'audio',
                            codec: 'pcm-s16be',
                            sampleRate: 8000,
                            channelCount: 2,
                        },
                    },
                    output,
                );
                assert.throws(
                    () =>
                        muxer.addAudioChunk({
                            trackType: 'audio',
                            timestamp: 0,
                            duration: 0.001,
                            isKeyframe: true,
                            data: Uint8Array.of(1, 2, 3),
                        }),
                    /complete|align|frame/i,
                );
                muxer.addAudioChunk({
                    trackType: 'audio',
                    timestamp: 0,
                    duration: 1 / 8000,
                    isKeyframe: true,
                    data: Uint8Array.of(0x80, 0, 0x40, 0),
                });
                await muxer.finalize();
                assert.equal(parseMatroska(await bytesOf(output)).tracks[0].codec, 'A_PCM/INT/BIG');
            },
        );
    });
});
