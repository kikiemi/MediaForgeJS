import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { h264 } from 'mediaforgejs/plugins';
import { Bits, idr, join, nal, pps, sps } from '../helpers/avi-h264-fixtures.mjs';
import {
    BASELINE_FIXTURE,
    CROPPED_FIXTURE,
    FIELD_SLICES_FIXTURE,
    HIGH_FIXTURE,
    INTERLACED_FIXTURE,
    MAIN_FIXTURE,
    annexB,
    annexBPackets,
    avcC,
    avccPackets,
    concat,
    frameMd5,
    lengthPrefixed,
    pictures,
} from '../helpers/h264-fixtures.mjs';
import { assertVideoDecoderContract } from '../helpers/codec-contract.mjs';
import { seededRandom } from '../helpers/pcm.mjs';
import { h264Mp4, videoMp4 } from '../helpers/video-mp4.mjs';

// The decoder as the plugin gives it: create(config) resolves once its kernels are ready.
const createDecoder = await h264.decoders.find(part => part.id === 'h264').load();

const FRAME_RATE = 25;
const FIXTURES = [
    BASELINE_FIXTURE,
    MAIN_FIXTURE,
    HIGH_FIXTURE,
    INTERLACED_FIXTURE,
    CROPPED_FIXTURE,
];
const SMPTE170M = {
    primaries: 'smpte170m',
    transfer: 'smpte170m',
    matrix: 'smpte170m',
    fullRange: false,
};

const chunkOf = (data, index) => ({
    data,
    timestamp: index / FRAME_RATE,
    duration: 1 / FRAME_RATE,
    isKeyframe: index === 0,
    trackType: 'video',
});

/** A decoder whose diagnostics go to `warnings`. */
const create = (config, warnings = []) =>
    createDecoder({ ...config, onWarning: warnings.push.bind(warnings) });

/** Every frame of `packets` decoded and flushed, with the diagnostics as `warnings`. */
async function decodeAll(config, packets, order = packets.map((_, index) => index)) {
    const warnings = [];
    const decoder = await create(config, warnings);
    const frames = [];
    packets.forEach((data, index) => frames.push(...decoder.decode(chunkOf(data, order[index]))));
    frames.push(...decoder.flush());
    decoder.close();
    return Object.assign(frames, { warnings });
}

/** Luma samples of the 12x12 interior (away from filtered edges) of macroblock (x, y). */
function lumaInterior(frame, x, y) {
    const { offset, stride } = frame.layout[0];
    const rows = [];
    for (let row = y * 16; row < y * 16 + 12; row++) {
        const start = offset + row * stride + x * 16;
        rows.push(Array.from(frame.data.subarray(start, start + 12)));
    }
    return rows;
}

const has = (warnings, text) => warnings.some(warning => warning.includes(text));
const isParameterSet = unit => (unit[0] & 31) === 7 || (unit[0] & 31) === 8;

/** seq_parameter_set_data of `profile` with the fields of `bits` (7.3.2.1.1). */
const highSps = (profile, bits) => nal(0x67, concat(Uint8Array.of(profile, 0, 30), bits.bytes()));

describe('h264', () => {
    describe('configuration', () => {
        test('supports avc1 and avc3 codec strings, nothing else', () => {
            for (const name of [
                'avc1',
                'avc3',
                'avc1.42E01E',
                'avc1.640028',
                'AVC1.4D401F',
                'avc3.64001f',
            ])
                assert.equal(h264.decoders[0].codecs(name), true, name);
            for (const other of ['avc1.42E01', 'hvc1.1.6.L93.B0', 'mp4v.20.9', 'avc2', '', 'h264'])
                assert.equal(h264.decoders[0].codecs(other), false, other);
        });

        test('refuses High 10 with its reason', async () => {
            const sps10 = highSps(
                110,
                new Bits()
                    .ue(0)
                    .ue(1)
                    .ue(2)
                    .ue(2)
                    .uint(0, 1)
                    .uint(0, 1)
                    .ue(0)
                    .ue(0)
                    .ue(0)
                    .ue(1)
                    .uint(0, 1)
                    .ue(3)
                    .ue(2)
                    .uint(1, 1)
                    .uint(1, 1)
                    .uint(0, 1)
                    .uint(0, 1),
            );
            const pps10 = nal(
                0x68,
                new Bits()
                    .ue(0)
                    .ue(0)
                    .uint(0, 2)
                    .ue(0)
                    .ue(0)
                    .ue(0)
                    .uint(0, 3)
                    .se(0)
                    .se(0)
                    .se(0)
                    .uint(0, 3)
                    .bytes(),
            );
            await assert.rejects(
                createDecoder({ codec: 'avc1.6E001E', description: avcC([sps10, pps10]) }),
                {
                    code: 'DECODE',
                    message: /10-bit/,
                },
            );
        });

        test('refuses flexible macroblock ordering at configuration', async () => {
            // pic_parameter_set_rbsp with num_slice_groups_minus1 1 and slice_group_map_type 6.
            const fmo = nal(
                0x68,
                new Bits()
                    .ue(1)
                    .ue(0)
                    .uint(0, 2)
                    .ue(1)
                    .ue(6)
                    .ue(11)
                    .uint(0, 12)
                    .ue(0)
                    .ue(0)
                    .uint(0, 3)
                    .se(0)
                    .se(0)
                    .se(0)
                    .uint(0, 3)
                    .bytes(),
            );
            const baseline = pictures(BASELINE_FIXTURE.bytes())[0].filter(
                unit => (unit[0] & 31) === 7,
            );
            await assert.rejects(
                createDecoder({
                    codec: BASELINE_FIXTURE.codec,
                    description: avcC([...baseline, fmo]),
                }),
                {
                    code: 'DECODE',
                    message: /slice groups/,
                },
            );
        });

        test('refuses a configuration that is neither avcC nor Annex B', async () => {
            await assert.rejects(
                createDecoder({ codec: 'avc1', description: Uint8Array.of(7, 7, 7) }),
                { code: 'DECODE' },
            );
        });

        test('a changed per-packet configuration applies from its packet on', async () => {
            // A track with several sample descriptions replaces the parameter sets mid-stream.
            const configured = [HIGH_FIXTURE, BASELINE_FIXTURE].map(avccPackets);
            const decoder = await create({
                codec: HIGH_FIXTURE.codec,
                description: configured[0].description,
            });
            const frames = [];
            let index = 0;
            for (const { description, packets } of configured)
                for (const data of packets)
                    frames.push(
                        ...decoder.decode({
                            ...chunkOf(data, index++),
                            codecConfig: description.slice(),
                        }),
                    );
            frames.push(...decoder.flush());
            decoder.close();
            assert.deepEqual(frames.map(frameMd5), [HIGH_FIXTURE.md5, BASELINE_FIXTURE.md5].flat());
        });

        test('an MP4 whose sample descriptions change the size decodes each picture', async () => {
            // Two IDR pictures, 32 and 16 pixels wide, each with its own sample description.
            const narrow = nal(
                0x67,
                join(
                    [66, 0, 10],
                    new Bits()
                        .ue(0)
                        .ue(0)
                        .ue(2)
                        .ue(1)
                        .uint(0, 1)
                        .ue(0)
                        .ue(0)
                        .uint(1, 1)
                        .uint(1, 1)
                        .uint(0, 2)
                        .bytes(),
                ),
            );
            const picture = new Bits()
                .ue(0)
                .ue(2)
                .ue(0)
                .uint(0, 4)
                .ue(0)
                .uint(0, 2)
                .ue(0)
                .ue(1)
                .ue(25)
                .align();
            for (let sample = 0; sample < 256; sample++) picture.uint(64, 8);
            for (let sample = 0; sample < 128; sample++) picture.uint(128, 8);
            const config = parameterSet => avcC([parameterSet, pps]);
            const mp4 = await videoMp4({
                codec: 'avc1.42000a',
                width: 32,
                height: 16,
                codecConfig: config(sps),
                codecConfigChanges: true,
                pictures: [
                    { data: lengthPrefixed([idr]), key: true, order: 0, codecConfig: config(sps) },
                    {
                        data: lengthPrefixed([nal(0x65, picture.bytes())]),
                        key: true,
                        order: 1,
                        codecConfig: config(narrow),
                    },
                ],
            });
            const media = await open(mp4);
            const [track] = media.tracks;
            const decoder = await create({ codec: track.codec, description: track.codecConfig });
            const widths = [];
            try {
                for await (const packet of media.packets())
                    for (const frame of decoder.decode(packet)) widths.push(frame.codedWidth);
                for (const frame of decoder.flush()) widths.push(frame.codedWidth);
            } finally {
                decoder.close();
                media.close();
            }
            assert.deepEqual(widths, [32, 16]);
        });

        test('a container size inside the picture crops it at the bottom', async () => {
            // As FFmpeg applies it to a parameter set without a top or left crop.
            const packets = annexBPackets(BASELINE_FIXTURE);
            const full = await decodeAll({ codec: BASELINE_FIXTURE.codec }, packets);
            const cropped = await decodeAll(
                { codec: BASELINE_FIXTURE.codec, codedWidth: 64, codedHeight: 40 },
                packets,
            );
            assert.deepEqual(
                cropped.map(frame => [frame.visibleRect, frame.displayWidth, frame.displayHeight]),
                full.map(() => [{ x: 0, y: 0, width: 64, height: 40 }, 64, 40]),
            );
            assert.deepEqual(
                cropped.map(frame => frame.data),
                full.map(frame => frame.data),
            );
        });

        for (const [codedWidth, codedHeight] of [
            [64, 30],
            [80, 48],
            [0, 40],
        ])
            test(`container size ${codedWidth}x${codedHeight} does not crop`, async () => {
                const frames = await decodeAll(
                    { codec: BASELINE_FIXTURE.codec, codedWidth, codedHeight },
                    annexBPackets(BASELINE_FIXTURE),
                );
                for (const frame of frames)
                    assert.deepEqual(frame.visibleRect, { x: 0, y: 0, width: 64, height: 48 });
            });
    });

    describe('decoding against ffmpeg', () => {
        for (const fixture of FIXTURES)
            test(`${fixture.name} decodes exactly with its frame layout and metadata`, async () => {
                const frames = await decodeAll(
                    { codec: fixture.codec },
                    annexBPackets(fixture),
                    fixture.order,
                );
                assert.deepEqual(frames.warnings, []);
                assert.deepEqual(frames.map(frameMd5), fixture.md5);
                const codedWidth = Math.ceil(fixture.width / 16) * 16;
                const codedHeight = Math.ceil(fixture.height / 16) * 16;
                const lumaSize = codedWidth * codedHeight;
                frames.forEach((frame, index) => {
                    assert.equal(frame.format, 'I420');
                    assert.deepEqual(
                        [
                            frame.codedWidth,
                            frame.codedHeight,
                            frame.displayWidth,
                            frame.displayHeight,
                        ],
                        [codedWidth, codedHeight, fixture.displayWidth, fixture.height],
                    );
                    assert.deepEqual(frame.visibleRect, {
                        x: 0,
                        y: 0,
                        width: fixture.width,
                        height: fixture.height,
                    });
                    assert.equal(frame.data.length, (lumaSize * 3) / 2);
                    assert.deepEqual(
                        frame.layout.map(plane => ({ ...plane })),
                        [
                            { offset: 0, stride: codedWidth },
                            { offset: lumaSize, stride: codedWidth / 2 },
                            { offset: (lumaSize * 5) / 4, stride: codedWidth / 2 },
                        ],
                    );
                    assert.deepEqual(
                        [frame.timestamp, frame.duration, frame.keyFrame, frame.interlaced],
                        [index / FRAME_RATE, 1 / FRAME_RATE, index === 0, fixture.interlaced],
                        'presentation order with the time of their own packet',
                    );
                    assert.deepEqual(frame.colorSpace, fixture.colorSpace ?? SMPTE170M);
                });
                assert(
                    frames.every(
                        frame => frames.filter(other => other.data === frame.data).length === 1,
                    ),
                    'every frame owns its buffer',
                );
            });

        for (const fixture of FIXTURES)
            test(`${fixture.name} length-prefixed with an avcC decodes the same`, async () => {
                const { description, packets } = avccPackets(fixture);
                const frames = await decodeAll(
                    { codec: fixture.codec, description },
                    packets,
                    fixture.order,
                );
                assert.deepEqual(frames.map(frameMd5), fixture.md5);
            });

        test('field slices with per-slice deblocking decode as the JM decoder does', async () => {
            // Field pictures of two slices each, filtered with disable_deblocking_filter_idc 2.
            const packets = annexBPackets(FIELD_SLICES_FIXTURE);
            assert.equal(packets.length, 6);
            const frames = await decodeAll(
                { codec: FIELD_SLICES_FIXTURE.codec },
                packets,
                [0, 0, 2, 2, 1, 1],
            );
            assert.deepEqual(frames.warnings, []);
            assert.deepEqual(frames.map(frameMd5), FIELD_SLICES_FIXTURE.md5);
            assert(frames.every(frame => frame.interlaced === 'top-field-first'));
            assert.deepEqual(
                frames.map(frame => frame.timestamp * FRAME_RATE),
                [0, 1, 2],
                'the time of the first field',
            );
        });

        test('a new resolution mid-stream releases the pictures of the old one', async () => {
            const switched = [HIGH_FIXTURE, INTERLACED_FIXTURE, BASELINE_FIXTURE];
            const frames = await decodeAll(
                { codec: HIGH_FIXTURE.codec },
                switched.flatMap(annexBPackets),
            );
            assert.deepEqual(
                frames.map(frameMd5),
                switched.flatMap(fixture => fixture.md5),
            );
        });

        test('keeps the video decoder contract', async () => {
            assertVideoDecoderContract(await create({ codec: 'avc1.42E01E' }));
        });
    });

    describe('reordering', () => {
        test('a B-pyramid leaves in presentation order; flush returns the rest', async () => {
            const packets = annexBPackets(MAIN_FIXTURE);
            const decoder = await create({ codec: MAIN_FIXTURE.codec });
            const shown = packets.flatMap((data, index) =>
                decoder
                    .decode(chunkOf(data, MAIN_FIXTURE.order[index]))
                    .map(frame => frame.timestamp * FRAME_RATE),
            );
            const flushed = decoder.flush().map(frame => frame.timestamp * FRAME_RATE);
            assert.deepEqual(
                [...shown, ...flushed].map(Math.round),
                MAIN_FIXTURE.order.map((_, index) => index),
            );
            assert(
                flushed.length > 0 && flushed.length <= 3,
                'flush returns only the pictures still held',
            );
            assert.deepEqual(decoder.flush(), [], 'a second flush has nothing left');
            decoder.close();
            assert.throws(
                () => decoder.decode(chunkOf(packets[0], 0)),
                { code: 'DECODE' },
                'after close',
            );
        });

        test('after reset() P pictures wait for the next IDR picture', async () => {
            const packets = annexBPackets(BASELINE_FIXTURE);
            const warnings = [];
            const decoder = await create({ codec: BASELINE_FIXTURE.codec }, warnings);
            decoder.decode(chunkOf(packets[0], 0));
            decoder.reset();
            assert.deepEqual(
                packets.slice(1).flatMap((data, index) => decoder.decode(chunkOf(data, index + 1))),
                [],
            );
            assert(has(warnings, 'waiting for an IDR'));
            const resumed = [
                ...packets.flatMap((data, index) => decoder.decode(chunkOf(data, index))),
                ...decoder.flush(),
            ];
            assert.deepEqual(resumed.map(frameMd5), BASELINE_FIXTURE.md5);
            decoder.close();
        });

        test('a recovery point SEI starts output without an IDR picture', async () => {
            // A P picture whose references were never received (D.2.8).
            const packets = annexBPackets(BASELINE_FIXTURE);
            const units = pictures(BASELINE_FIXTURE.bytes());
            const recoveryPoint = nal(
                0x06,
                new Bits().uint(6, 8).uint(1, 8).ue(0).uint(1, 1).uint(0, 1).uint(0, 2).bytes(),
            );
            const decoder = await create({ codec: BASELINE_FIXTURE.codec });
            const frames = [
                ...decoder.decode(
                    chunkOf(
                        annexB([...units[0].filter(isParameterSet), recoveryPoint, ...units[2]]),
                        2,
                    ),
                ),
                ...packets
                    .slice(3)
                    .flatMap((data, index) => decoder.decode(chunkOf(data, index + 3))),
                ...decoder.flush(),
            ];
            assert.deepEqual(
                frames.map(frame => Math.round(frame.timestamp * FRAME_RATE)),
                [2, 3, 4, 5],
            );
            decoder.close();
        });
    });

    describe('reference pictures', () => {
        // Hand-built Main profile streams of I_PCM macroblocks: 32x16 frames or 32x32 field pairs,
        // 4-bit frame_num, 5-bit POC LSB, two reference frames, and a VUI limiting the DPB to two
        // frames with two reordered.
        const parameterSets = ({ fields = false } = {}) => {
            const bits = new Bits().ue(0).ue(0).ue(0).ue(1).ue(2).uint(0, 1).ue(1).ue(0);
            if (fields) bits.uint(0, 2);
            else bits.uint(1, 1);
            bits.uint(1, 1)
                .uint(0, 1)
                .uint(1, 1)
                .uint(0, 8)
                .uint(1, 1)
                .uint(1, 1)
                .ue(0)
                .ue(0)
                .ue(16)
                .ue(16)
                .ue(2)
                .ue(2);
            return [nal(0x67, join([77, 0, 10], bits.bytes())), pps];
        };
        /** An I slice of two I_PCM macroblocks of luma `value`, as a frame or the `field`. */
        const pcmPicture = ({ idr: isIdr = false, ref = true, frameNum, poc, value, field }) => {
            const bits = new Bits().ue(0).ue(2).ue(0).uint(frameNum, 4);
            if (field) bits.uint(1, 1).uint(field === 'bottom' ? 1 : 0, 1);
            if (isIdr) bits.ue(0);
            bits.uint(poc, 5);
            if (ref) bits.uint(0, isIdr ? 2 : 1);
            bits.se(0).ue(1);
            for (let macroblock = 0; macroblock < 2; macroblock++) {
                bits.ue(25).align();
                for (let sample = 0; sample < 384; sample++)
                    bits.uint(sample < 256 ? value : 128, 8);
            }
            return nal((ref ? 0x40 : 0) | (isIdr ? 5 : 1), bits.bytes());
        };
        /** A P slice with both macroblocks skipped: a copy of the first picture of list 0. */
        const skipped = ({ frameNum, poc }) =>
            nal(
                0x41,
                new Bits()
                    .ue(0)
                    .ue(0)
                    .ue(0)
                    .uint(frameNum, 4)
                    .uint(poc, 5)
                    .uint(0, 3)
                    .se(0)
                    .ue(1)
                    .ue(2)
                    .bytes(),
            );
        /** Presentation position and the first two luma lines of every output frame. */
        const run = async list => {
            const decoder = await create({ codec: 'avc1.4D000A' });
            const frames = [];
            for (const [units, position] of list)
                frames.push(...decoder.decode(chunkOf(annexB(units), position)));
            frames.push(...decoder.flush());
            decoder.close();
            return frames.map(frame => [
                Math.round(frame.timestamp * FRAME_RATE),
                frame.data[0],
                frame.data[frame.layout[0].stride],
            ]);
        };
        const pair = (frameNum, poc, value, isIdr = false) => [
            pcmPicture({ idr: isIdr, frameNum, poc, value, field: 'top' }),
            pcmPicture({ frameNum, poc: poc + 1, value: value + 10, field: 'bottom' }),
        ];
        const lone = (frameNum, value) => [
            pcmPicture({ frameNum, poc: frameNum * 2, value, field: 'top' }),
        ];

        test('a full DPB of waiting references outputs a preceding non-reference', async () => {
            // Two reference frames fill the DPB while both wait for output; a later non-reference
            // picture that precedes the second is output directly (C.4.5.3) instead of bumping
            // that reference frame ahead of it.
            const frames = await run([
                [
                    [...parameterSets(), pcmPicture({ idr: true, frameNum: 0, poc: 0, value: 40 })],
                    0,
                ],
                [[pcmPicture({ frameNum: 1, poc: 8, value: 80 })], 4],
                [[pcmPicture({ frameNum: 2, poc: 4, value: 120 })], 2],
                [[pcmPicture({ ref: false, frameNum: 3, poc: 2, value: 160 })], 1],
                [[pcmPicture({ ref: false, frameNum: 3, poc: 6, value: 200 })], 3],
                [[skipped({ frameNum: 3, poc: 10 })], 5],
            ]);
            assert.deepEqual(
                frames,
                [40, 160, 120, 200, 80, 120].map((value, position) => [position, value, value]),
            );
        });

        test('unpaired fields show only from the third of a run, lines doubled', async () => {
            // As FFmpeg decodes with one thread: an unpaired field stays a reference.
            const frames = await run([
                [[...parameterSets({ fields: true }), ...pair(0, 0, 40, true)], 0],
                [lone(1, 80), 1],
                [pair(2, 4, 120), 2],
                [lone(3, 160), 3],
                [lone(4, 200), 4],
                [lone(5, 220), 5],
            ]);
            assert.deepEqual(frames, [
                [0, 40, 50],
                [2, 120, 130],
                [5, 220, 220],
            ]);
        });

        test('a first field cut by the end of the stream is not shown', async () => {
            const frames = await run([
                [[...parameterSets({ fields: true }), ...pair(0, 0, 40, true)], 0],
                [pair(1, 2, 80), 1],
                [lone(2, 120), 2],
            ]);
            assert.deepEqual(frames, [
                [0, 40, 50],
                [1, 80, 90],
            ]);
        });
    });

    describe('damage', () => {
        test('a truncated picture is concealed after its intact macroblocks', async () => {
            // The second coded picture (a P picture shown third) loses the last third of its data.
            const packets = annexBPackets(HIGH_FIXTURE);
            const intact = await decodeAll(
                { codec: HIGH_FIXTURE.codec },
                packets,
                HIGH_FIXTURE.order,
            );
            const damaged = packets.slice();
            damaged[1] = packets[1].subarray(
                0,
                packets[1].length - Math.floor(packets[1].length / 3),
            );
            const frames = await decodeAll(
                { codec: HIGH_FIXTURE.codec },
                damaged,
                HIGH_FIXTURE.order,
            );
            assert.equal(frames.length, packets.length);
            assert(has(frames.warnings, 'concealed'));
            assert.deepEqual(lumaInterior(frames[3], 0, 0), lumaInterior(intact[3], 0, 0));
            assert.deepEqual(
                frames[0].data,
                intact[0].data,
                'pictures before the damage are intact',
            );
        });

        test('a lost reference picture is concealed and decoding continues', async () => {
            const packets = annexBPackets(MAIN_FIXTURE);
            const frames = await decodeAll(
                { codec: MAIN_FIXTURE.codec },
                packets.filter((_, index) => index !== 1),
                MAIN_FIXTURE.order.filter((_, index) => index !== 1),
            );
            assert.equal(frames.length, packets.length - 1);
            assert.equal(frameMd5(frames[0]), MAIN_FIXTURE.md5[0]);
        });

        test('flipped, cut, replaced and lost packets never throw', async () => {
            const random = seededRandom(7);
            let decoded = 0;
            for (const fixture of FIXTURES) {
                const packets = annexBPackets(fixture);
                for (let round = 0; round < 4; round++) {
                    const decoder = await create({ codec: fixture.codec });
                    const check = frame => {
                        decoded++;
                        assert.equal(
                            frame.data.length,
                            (frame.codedWidth * frame.codedHeight * 3) / 2,
                        );
                    };
                    packets.forEach((packet, index) => {
                        let data = packet.slice();
                        const mode = random();
                        if (mode < 0.35)
                            for (let flip = 0; flip < 1 + random() * 12; flip++)
                                data[5 + Math.floor(random() * (data.length - 5))] ^=
                                    1 << Math.floor(random() * 8);
                        else if (mode < 0.45)
                            data = data.subarray(0, Math.floor(random() * data.length));
                        else if (mode < 0.5)
                            data = concat(
                                data.subarray(0, 6),
                                Uint8Array.from({ length: 200 }, () => random() * 256),
                            );
                        else if (mode < 0.55) return;
                        else if (mode < 0.58) decoder.reset();
                        for (const frame of decoder.decode(chunkOf(data, index))) check(frame);
                    });
                    for (const frame of decoder.flush()) check(frame);
                    decoder.close();
                }
            }
            assert(decoded > 0);
        });
    });

    describe('plugin', () => {
        test('MediaForge.frames() presents every picture of an H.264 MP4 in order', async () => {
            const frames = [];
            for await (const frame of new lite.MediaForge({ plugins: [h264] }).frames(
                await h264Mp4(MAIN_FIXTURE),
            ))
                frames.push([
                    Math.round(frame.timestamp * FRAME_RATE),
                    frame.width,
                    frame.height,
                    frame.data.length,
                ]);
            assert.deepEqual(
                frames,
                MAIN_FIXTURE.md5.map((_, index) => [index, 64, 48, 64 * 48 * 4]),
            );
        });

        test('4:4:4 chroma is refused as DECODE with its reason', async () => {
            // High 4:4:4 Predictive (profile_idc 244) with chroma_format_idc 3.
            const sps444 = highSps(
                244,
                new Bits()
                    .ue(0)
                    .ue(3)
                    .uint(0, 1)
                    .ue(0)
                    .ue(0)
                    .uint(0, 1)
                    .uint(0, 1)
                    .ue(0)
                    .ue(0)
                    .ue(0)
                    .ue(1)
                    .uint(0, 1)
                    .ue(1)
                    .ue(0)
                    .uint(1, 1)
                    .uint(1, 1)
                    .uint(0, 1)
                    .uint(0, 1),
            );
            const { packets } = avccPackets(MAIN_FIXTURE);
            const mp4 = await videoMp4({
                codec: 'avc1.F4001E',
                width: 32,
                height: 16,
                codecConfig: avcC([sps444, pps]),
                pictures: [{ data: packets[0], key: true, order: 0 }],
            });
            await assert.rejects(new MediaForge().thumbnail(mp4), {
                code: 'DECODE',
                message: /4:4:4 chroma is not supported/,
            });
        });

        test('capabilities list H.264 with the plugin and not without', async () => {
            const forge = new MediaForge();
            assert((await forge.capabilities()).video.decoders.includes('h264'));
            const without = new MediaForge({ plugins: { exclude: ['h264'] } });
            assert(!(await without.capabilities()).video.decoders.includes('h264'));
        });

        test('without the plugin and a host decoder H.264 names the h264 plugin', async () => {
            const forge = new MediaForge({ plugins: { exclude: ['h264'] } });
            const error = await forge
                .thumbnail(await h264Mp4(MAIN_FIXTURE))
                .catch(caught => caught);
            assert.deepEqual([error.code, error.plugin], ['PLUGIN', 'h264']);
            assert.match(
                error.hint,
                /Include the 'h264' plugin, or use a browser whose VideoDecoder supports avc1/,
            );
        });
    });
});
