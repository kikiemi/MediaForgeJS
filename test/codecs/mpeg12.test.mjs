import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { mpeg12 } from 'mediaforgejs/plugins';
import {
    INTERLACED_FIXTURE,
    INTRA_422_FIXTURE,
    MPEG1_FIXTURE,
} from '../helpers/mpeg2-fixtures.mjs';
import { writeMpeg2Stream } from '../helpers/mpeg2-writer.mjs';
import { join } from '../helpers/avi-h264-fixtures.mjs';
import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    mpegGop,
    mpegPicture,
    mpegSequence,
} from '../helpers/mpeg-video-fixtures.mjs';
import { assertVideoDecoderContract } from '../helpers/codec-contract.mjs';
import { seededRandom } from '../helpers/pcm.mjs';
import { mpegVideoMp4 } from '../helpers/video-mp4.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { mpeg12VideoCodec: codec } = await import(distUrl('esm/codecs/mpeg12/decoder.js'));

const FRAME_RATE = 25;
const PAL = { primaries: 'bt470bg', transfer: 'smpte170m', matrix: 'bt470bg', fullRange: false };

/**
 * Splits an elementary stream before each sequence header, GOP header and frame (or field when
 * asked), with each picture's type and presentation time.
 */
function packetize(bytes, { perField = false } = {}) {
    const packets = [];
    let current = null;
    let groupBase = 0;
    let frames = 0;
    let openField = 0;
    for (let index = 0; index + 3 < bytes.length; index++) {
        if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 1) continue;
        const code = bytes[index + 3];
        let structure = 3;
        if (code === 0) {
            for (let next = index + 4; next + 6 < bytes.length; next++) {
                if (bytes[next] === 0 && bytes[next + 1] === 0 && bytes[next + 2] === 1) {
                    if (bytes[next + 3] === 0xb5 && bytes[next + 4] >> 4 === 8)
                        structure = bytes[next + 6] & 3;
                    break;
                }
            }
        }
        const secondField =
            code === 0 && structure !== 3 && openField !== 0 && openField !== structure;
        const startsPacket =
            code === 0xb3 || code === 0xb8 || (code === 0 && (!secondField || perField));
        if (startsPacket && current?.picture) {
            current.end = index;
            packets.push(current);
            current = null;
        }
        current ??= { start: index, picture: false };
        if (code === 0xb8) groupBase = frames;
        if (code === 0) {
            const temporalReference = (bytes[index + 4] << 2) | (bytes[index + 5] >> 6);
            current.picture = true;
            current.type = (bytes[index + 5] >> 3) & 7;
            current.timestamp = (groupBase + temporalReference) / FRAME_RATE;
            current.duration = structure === 3 || !perField ? 1 / FRAME_RATE : 1 / (2 * FRAME_RATE);
            if (secondField) openField = 0;
            else {
                frames++;
                openField = structure === 3 ? 0 : structure;
            }
        }
        index += 3;
    }
    if (current) {
        current.end = bytes.length;
        packets.push(current);
    }
    return packets.map(packet => ({ ...packet, data: bytes.subarray(packet.start, packet.end) }));
}

const chunkOf = (packet, data = packet.data) => ({
    data,
    timestamp: packet.timestamp,
    duration: packet.duration,
    isKeyframe: packet.type === 1,
    trackType: 'video',
});

/** A decoder whose diagnostics go to `warnings`. */
const create = (config, warnings = []) =>
    codec.create({ ...config, onWarning: warnings.push.bind(warnings) });

/** Every frame of `packets` decoded and flushed, and the diagnostics on the way. */
function decodePackets(packets, config) {
    const warnings = [];
    const decoder = create(config, warnings);
    const frames = [];
    for (const packet of packets) frames.push(...decoder.decode(chunkOf(packet)));
    frames.push(...decoder.flush());
    decoder.close();
    return Object.assign(frames, { warnings });
}

/** MD5 of the visible Y, U and V planes packed without padding, as ffmpeg's framemd5 hashes. */
function frameMd5(frame) {
    const hash = createHash('md5');
    const { width, height } = frame.visibleRect;
    const chromaWidth = (width + 1) >> 1;
    const chromaHeight = frame.format === 'I422' ? height : (height + 1) >> 1;
    for (const [plane, planeWidth, planeHeight] of [
        [frame.layout[0], width, height],
        [frame.layout[1], chromaWidth, chromaHeight],
        [frame.layout[2], chromaWidth, chromaHeight],
    ])
        for (let row = 0; row < planeHeight; row++) {
            const start = plane.offset + row * plane.stride;
            hash.update(frame.data.subarray(start, start + planeWidth));
        }
    return hash.digest('hex');
}

/** Largest absolute luma difference of the 16x16 macroblock at (x, y) between two frames. */
function macroblockDifference(a, b, x, y) {
    let largest = 0;
    for (let row = y * 16; row < y * 16 + 16; row++)
        for (let column = x * 16; column < x * 16 + 16; column++) {
            const index = a.layout[0].offset + row * a.layout[0].stride + column;
            largest = Math.max(largest, Math.abs(a.data[index] - b.data[index]));
        }
    return largest;
}

function findStartCode(bytes, code, from = 0) {
    for (let index = from; index + 3 < bytes.length; index++)
        if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1)
            if (bytes[index + 3] === code) return index;
    return -1;
}

const count = (warnings, pattern) => warnings.filter(message => pattern.test(message)).length;

const modes = ['frame', 'field', 'dual', 'skip', 'intra', 'zero'];
const I = { type: 'I', structure: 'frame' };
const P = { type: 'P', structure: 'frame', modes, coded: true };
const top = { type: 'P', structure: 'top', modes, coded: true };
const bottom = { type: 'P', structure: 'bottom', modes, coded: true };
// Streams of writeMpeg2Stream; md5 from ffmpeg 6.1.1: ffmpeg -i <stream>.m2v -pix_fmt
// <yuv420p|yuv422p> -f framemd5 -
const SYNTHESIZED = [
    {
        name: 'frame pictures with dual-prime, field and frame prediction',
        options: { width: 96, height: 128, seed: 1, pictures: [I, P, P, P, P] },
        md5: [
            '6757a4eaa3047528789d99ea1d267cfe',
            '2e87a384aba034e2b1329492b333d575',
            '752da4119d9032dea789289d04d1ba8e',
            '117744a0664665c33d1eb2e1cb02af7c',
            '757665aac3501db8dc68c8cb7f629262',
        ],
    },
    {
        name: 'field pictures with field, 16x8 and dual-prime prediction',
        options: {
            width: 96,
            height: 128,
            seed: 2,
            pictures: [I, top, bottom, top, bottom, P, bottom, top],
        },
        md5: [
            '17ee98128a530d36d2a605ba11f093ad',
            '6831902658cb82505009f5e0a6408b77',
            'c204012ba3c6e1f31f3a97638dd3243d',
            'bcfd2eeb7ea58f7cf217c7837a821c72',
            'ec40f1fb75d6c9aed0be1b3fdb2a3085',
        ],
    },
    {
        name: '4:2:2 field pictures',
        options: {
            width: 96,
            height: 128,
            chroma: 422,
            seed: 3,
            pictures: [I, top, bottom, P, bottom, top],
        },
        md5: [
            'cc6ed6fceeb859d155c01de5220641a9',
            'a6ab33588842b10433bab1c4f6056e8a',
            'aad73a38c0d905b54e3482390312d802',
            'cb8f21968b018f87b3db980d288a52de',
        ],
    },
    {
        name: 'concealment motion vectors in frame and field I-pictures',
        options: {
            width: 96,
            height: 128,
            seed: 4,
            concealment: true,
            pictures: [I, { type: 'I', structure: 'top' }, { type: 'I', structure: 'bottom' }],
        },
        md5: ['2945e3a22575ff1de3db46f86daaf9b6', '7770e8b88500e1bfedb03dc6d0fb55f2'],
    },
];

describe('mpeg12', () => {
    describe('configuration', () => {
        test('supports MPEG-1 (mp4v.6a) and the MPEG-2 profiles mp4v.60 to mp4v.65', () => {
            assert.equal(codec.id, 'mpeg2video');
            for (const name of ['mp4v.6a', 'mp4v.6A', ...[0, 1, 2, 3, 4, 5].map(p => `mp4v.6${p}`)])
                assert.equal(codec.supports(name), true, name);
            for (const other of ['mp4v.20.9', 'mp4v.66', 'avc1.42E01E', 'mp4v', '', 'mpeg2video'])
                assert.equal(codec.supports(other), false, other);
        });

        test('refuses another codec and a cut sequence header with DECODE', () => {
            assert.throws(() => codec.create({ codec: 'avc1.42E01E' }), { code: 'DECODE' });
            assert.throws(() => codec.create({ codec: 'mp4v.61', description: [0, 0, 1, 0xb3] }), {
                code: 'DECODE',
            });
        });

        test('the description supplies the sequence header and its matrices', () => {
            const bytes = INTERLACED_FIXTURE.bytes();
            const description = bytes.slice(0, findStartCode(bytes, 0xb8));
            const stripped = packetize(bytes).map(packet =>
                findStartCode(packet.data, 0xb3) < 0
                    ? packet
                    : { ...packet, data: packet.data.subarray(findStartCode(packet.data, 0xb8)) },
            );
            assert(stripped.every(packet => findStartCode(packet.data, 0xb3) < 0));
            const frames = decodePackets(stripped, { codec: 'mp4v.61', description });
            assert.deepEqual(frames.map(frameMd5), INTERLACED_FIXTURE.md5);
        });

        test('reset() keeps the description', () => {
            const bytes = INTERLACED_FIXTURE.bytes();
            const description = bytes.slice(0, findStartCode(bytes, 0xb8));
            const stripped = packetize(bytes).map(packet =>
                findStartCode(packet.data, 0xb3) < 0
                    ? packet
                    : { ...packet, data: packet.data.subarray(findStartCode(packet.data, 0xb8)) },
            );
            const warnings = [];
            const decoder = create({ codec: 'mp4v.61', description }, warnings);
            for (const packet of stripped.slice(0, 3)) decoder.decode(chunkOf(packet));
            decoder.reset();
            const resumed = [];
            for (const packet of stripped.slice(4))
                resumed.push(...decoder.decode(chunkOf(packet)));
            resumed.push(...decoder.flush());
            assert.deepEqual(resumed.map(frameMd5), INTERLACED_FIXTURE.md5.slice(6));
            assert.equal(count(warnings, /B-picture without its references/), 2);
        });

        test('refuses 4:4:4 chroma and an oversized picture in the description', () => {
            const bytes = INTERLACED_FIXTURE.bytes();
            const description = bytes.slice(0, findStartCode(bytes, 0xb8));
            const extension = findStartCode(description, 0xb5);
            const chroma444 = description.slice();
            chroma444[extension + 5] |= 0x06;
            assert.throws(() => codec.create({ codec: 'mp4v.61', description: chroma444 }), {
                code: 'DECODE',
            });
            const oversized = description.slice();
            oversized[extension + 5] |= 0x01;
            assert.throws(() => codec.create({ codec: 'mp4v.61', description: oversized }), {
                code: 'DECODE',
            });
        });
    });

    describe('decoding against ffmpeg', () => {
        for (const fixture of [MPEG1_FIXTURE, INTERLACED_FIXTURE, INTRA_422_FIXTURE])
            test(`${fixture.name} decodes exactly with its frame layout and metadata`, () => {
                const packets = packetize(fixture.bytes());
                const frames = decodePackets(packets, { codec: fixture.codec });
                assert.deepEqual(frames.map(frameMd5), fixture.md5);
                const codedWidth = Math.ceil(fixture.width / 16) * 16;
                const codedHeight = Math.ceil(fixture.height / 16) * 16;
                const chromaHeight = fixture.format === 'I422' ? codedHeight : codedHeight / 2;
                const keys = packets
                    .filter(packet => packet.type === 1)
                    .map(packet => packet.timestamp);
                frames.forEach((frame, index) => {
                    assert.equal(frame.format, fixture.format);
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
                    assert.equal(
                        frame.data.length,
                        codedWidth * codedHeight + codedWidth * chromaHeight,
                    );
                    assert.deepEqual(
                        frame.layout.map(plane => ({ ...plane })),
                        [
                            { offset: 0, stride: codedWidth },
                            { offset: codedWidth * codedHeight, stride: codedWidth / 2 },
                            {
                                offset: codedWidth * codedHeight + (codedWidth / 2) * chromaHeight,
                                stride: codedWidth / 2,
                            },
                        ],
                    );
                    assert.deepEqual(
                        [frame.timestamp, frame.duration, frame.keyFrame, frame.interlaced],
                        [
                            index / FRAME_RATE,
                            1 / FRAME_RATE,
                            keys.includes(frame.timestamp),
                            fixture.interlaced,
                        ],
                    );
                    assert.deepEqual(frame.colorSpace, PAL);
                });
                assert(
                    frames.every(
                        frame => frames.filter(other => other.data === frame.data).length === 1,
                    ),
                    'every frame owns its buffer',
                );
            });

        for (const stream of SYNTHESIZED)
            test(`${stream.name} decode exactly, one frame or one field per packet`, () => {
                const bytes = writeMpeg2Stream(stream.options);
                const frames = decodePackets(packetize(bytes), { codec: 'mp4v.61' });
                assert.deepEqual(frames.map(frameMd5), stream.md5);
                const fieldOrder = [];
                let pairOpen = false;
                for (const { structure } of stream.options.pictures)
                    if (pairOpen) pairOpen = false;
                    else {
                        fieldOrder.push(
                            structure === 'bottom' ? 'bottom-field-first' : 'top-field-first',
                        );
                        pairOpen = structure !== 'frame';
                    }
                assert.deepEqual(
                    frames.map(frame => frame.interlaced),
                    fieldOrder,
                    'field order',
                );
                const perField = decodePackets(packetize(bytes, { perField: true }), {
                    codec: 'mp4v.61',
                });
                assert.deepEqual(perField.map(frameMd5), stream.md5);
                assert.deepEqual(
                    perField.map(frame => [frame.timestamp, frame.duration]),
                    frames.map(frame => [frame.timestamp, frame.duration]),
                    'two fields make one frame with their summed duration',
                );
            });

        test('several pictures in one packet all decode, sharing its duration', () => {
            const bytes = INTERLACED_FIXTURE.bytes();
            const whole = decodePackets(
                [{ data: bytes, timestamp: 0, duration: 10 / FRAME_RATE, type: 1 }],
                {
                    codec: 'mp4v.61',
                },
            );
            assert.deepEqual(whole.map(frameMd5), INTERLACED_FIXTURE.md5);
            whole.forEach((frame, index) => {
                assert(Math.abs(frame.timestamp - index / FRAME_RATE) < 1e-9);
                assert(Math.abs(frame.duration - 1 / FRAME_RATE) < 1e-9);
            });
        });

        test('keeps the video decoder contract', () => {
            assertVideoDecoderContract(create({ codec: 'mp4v.61' }));
        });
    });

    describe('reordering', () => {
        const packets = packetize(INTERLACED_FIXTURE.bytes());

        test('the fixture holds a closed GOP and an open GOP leaning on it', () => {
            assert.deepEqual(
                packets.map(packet => 'IPB'[packet.type - 1]),
                ['I', 'P', 'B', 'B', 'I', 'B', 'B', 'P', 'B', 'B'],
            );
        });

        test('an anchor leaves when the next arrives; flush returns the held one', () => {
            const decoder = create({ codec: 'mp4v.61' });
            const early = [
                ...decoder.decode(chunkOf(packets[0])),
                ...decoder.decode(chunkOf(packets[1])),
            ];
            assert.deepEqual(early.map(frameMd5), [INTERLACED_FIXTURE.md5[0]]);
            early.push(
                ...decoder.decode(chunkOf(packets[2])),
                ...decoder.decode(chunkOf(packets[3])),
            );
            const flushed = decoder.flush();
            assert.deepEqual(
                flushed.map(frame => frame.timestamp),
                [3 / FRAME_RATE],
            );
            const rest = [];
            for (const packet of packets.slice(4)) rest.push(...decoder.decode(chunkOf(packet)));
            rest.push(...decoder.flush());
            assert.deepEqual(
                [...early, ...flushed, ...rest].map(frameMd5),
                INTERLACED_FIXTURE.md5,
                'decoding continues after a flush',
            );
            decoder.close();
            assert.throws(() => decoder.decode(chunkOf(packets[0])), { code: 'DECODE' });
        });

        test('after reset() decoding resumes at an I-picture without the leading Bs', () => {
            const warnings = [];
            const decoder = create({ codec: 'mp4v.61' }, warnings);
            decoder.decode(chunkOf(packets[0]));
            decoder.decode(chunkOf(packets[1]));
            decoder.reset();
            const frames = [...decoder.decode(chunkOf(packets[7]))];
            for (const packet of packets.slice(4)) frames.push(...decoder.decode(chunkOf(packet)));
            frames.push(...decoder.flush());
            assert.deepEqual(
                frames.map(frame => frame.timestamp),
                [6, 7, 8, 9].map(index => index / FRAME_RATE),
            );
            assert.deepEqual(frames.map(frameMd5), INTERLACED_FIXTURE.md5.slice(6));
            assert.equal(count(warnings, /P-picture without a reference/), 1);
            assert.equal(count(warnings, /B-picture without its references/), 2);
        });

        test('broken_link drops the B-pictures before the first anchor of its GOP', () => {
            const broken = INTERLACED_FIXTURE.bytes();
            broken[findStartCode(broken, 0xb8, findStartCode(broken, 0xb8) + 4) + 7] |= 0x20;
            const frames = decodePackets(packetize(broken), { codec: 'mp4v.61' });
            assert.deepEqual(frames.map(frameMd5), [
                ...INTERLACED_FIXTURE.md5.slice(0, 4),
                ...INTERLACED_FIXTURE.md5.slice(6),
            ]);
            assert.equal(count(frames.warnings, /B-picture without its references/), 2);
        });
    });

    describe('sequences', () => {
        // A second sequence with a new aspect ratio or picture size: the first sequence's last
        // reference picture is shown, the new pictures carry the new size and display aspect, and
        // the B-picture leading the open GOP has no reference left and is skipped.
        const end = Uint8Array.of(0, 0, 1, 0xb7);
        const sequences = (second, withEnd = true) =>
            [
                [
                    join(
                        mpegSequence({ profile: 0x48, aspect: 2 }),
                        mpegGop(true),
                        mpegPicture(PICTURE_I, 0),
                    ),
                    0,
                ],
                [mpegPicture(PICTURE_P, 2), 2],
                [mpegPicture(PICTURE_B, 1), 1],
                [
                    join(
                        withEnd ? end : [],
                        mpegSequence({ profile: 0x48, ...second }),
                        mpegGop(false),
                        mpegPicture(PICTURE_I, 1),
                    ),
                    4,
                ],
                [mpegPicture(PICTURE_B, 0), 3],
                [mpegPicture(PICTURE_P, 2), 5],
            ].map(([data, position]) => ({
                data,
                timestamp: position / FRAME_RATE,
                duration: 1 / FRAME_RATE,
            }));
        const shapes = frames =>
            frames.map(frame => [
                Math.round(frame.timestamp * FRAME_RATE),
                frame.visibleRect.width,
                frame.visibleRect.height,
                frame.displayWidth,
                frame.codedWidth,
            ]);

        test('a sequence end drops the references of the ended sequence', () => {
            const frames = decodePackets(sequences({ aspect: 3 }), { codec: 'mp4v.61' });
            assert.deepEqual(shapes(frames), [
                [0, 32, 16, 21, 32],
                [1, 32, 16, 21, 32],
                [2, 32, 16, 21, 32],
                [4, 32, 16, 28, 32],
                [5, 32, 16, 28, 32],
            ]);
            assert.equal(count(frames.warnings, /B-picture without its references skipped/), 1);
        });

        test('a new picture size restarts decoding at the new size', () => {
            const frames = decodePackets(sequences({ width: 48, height: 32, aspect: 1 }, false), {
                codec: 'mp4v.61',
            });
            assert.deepEqual(shapes(frames), [
                [0, 32, 16, 21, 32],
                [1, 32, 16, 21, 32],
                [2, 32, 16, 21, 32],
                [4, 48, 32, 48, 48],
                [5, 48, 32, 48, 48],
            ]);
        });

        const metadata = options => {
            const bytes = writeMpeg2Stream({ seed: 5, pictures: [I], ...options });
            return decodePackets(packetize(bytes), { codec: 'mp4v.61' })[0];
        };

        test('NTSC 4:3 with a display extension narrows to its display region', () => {
            const ntsc = metadata({
                width: 720,
                height: 480,
                aspectRatio: 2,
                frameRateCode: 4,
                display: { width: 704, height: 480, colour: [6, 6, 6] },
            });
            assert.deepEqual(
                [ntsc.codedWidth, ntsc.codedHeight, ntsc.displayWidth, ntsc.displayHeight],
                [720, 480, 655, 480],
            );
            assert.deepEqual(ntsc.colorSpace, {
                primaries: 'smpte170m',
                transfer: 'smpte170m',
                matrix: 'smpte170m',
                fullRange: false,
            });
        });

        test('an implausible display region is ignored', () => {
            const bogus = metadata({
                width: 720,
                height: 576,
                aspectRatio: 2,
                display: { width: 720, height: 480 },
            });
            assert.deepEqual([bogus.displayWidth, bogus.displayHeight], [768, 576]);
            assert.deepEqual(bogus.colorSpace, PAL);
        });

        test('HD sizes default to BT.709 and code whole macroblock rows', () => {
            const hd = metadata({ width: 1280, height: 720, aspectRatio: 3, frameRateCode: 7 });
            assert.deepEqual([hd.codedHeight, hd.displayWidth, hd.displayHeight], [736, 1280, 720]);
            assert.deepEqual(hd.colorSpace, {
                primaries: 'bt709',
                transfer: 'bt709',
                matrix: 'bt709',
                fullRange: false,
            });
            const full = metadata({
                width: 1920,
                height: 1080,
                aspectRatio: 3,
                frameRateCode: 4,
                display: { width: 1920, height: 1080, colour: [1, 1, 1] },
            });
            assert.deepEqual(full.visibleRect, { x: 0, y: 0, width: 1920, height: 1080 });
            assert.deepEqual(
                [full.codedWidth, full.codedHeight, full.displayWidth],
                [1920, 1088, 1920],
            );
        });

        test('SIF 4:3 displays 320 wide', () => {
            const sif = metadata({ width: 352, height: 240, aspectRatio: 2, frameRateCode: 4 });
            assert.deepEqual([sif.displayWidth, sif.displayHeight], [320, 240]);
        });
    });

    describe('damage', () => {
        test('a damaged slice copies co-located macroblocks of the last anchor', () => {
            const packets = packetize(INTERLACED_FIXTURE.bytes());
            const clean = decodePackets(packets, { codec: 'mp4v.61' });
            const damaged = packets.map(packet => ({ ...packet, data: packet.data.slice() }));
            const slice = findStartCode(damaged[1].data, 3);
            damaged[1].data.fill(0xff, slice + 8, slice + 40);
            const frames = decodePackets(damaged, { codec: 'mp4v.61' });
            assert.equal(frames.length, clean.length);
            assert(count(frames.warnings, /concealed/) > 0);
            let copied = 0;
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 6; x++) {
                    const difference = macroblockDifference(frames[3], clean[3], x, y);
                    if (y !== 2) assert.equal(difference, 0, `macroblock ${x},${y}`);
                    else if (
                        difference !== 0 &&
                        macroblockDifference(frames[3], clean[0], x, y) === 0
                    )
                        copied++;
                }
            assert(copied > 0);
        });

        test('an intra-only stream conceals with grey instead of an earlier picture', () => {
            const packets = packetize(INTRA_422_FIXTURE.bytes());
            const clean = decodePackets(packets, { codec: 'mp4v.65' });
            const damaged = packets.map(packet => ({ ...packet, data: packet.data.slice() }));
            const slice = findStartCode(damaged[2].data, 2);
            damaged[2].data.fill(0, slice + 6, slice + 40);
            const frames = decodePackets(damaged, { codec: 'mp4v.65' });
            let grey = 0;
            for (let y = 0; y < 3; y++)
                for (let x = 0; x < 4; x++) {
                    if (y !== 1) {
                        assert.equal(macroblockDifference(frames[2], clean[2], x, y), 0);
                        continue;
                    }
                    const { data, layout } = frames[2];
                    let flat = true;
                    for (let row = 16; row < 32; row++)
                        for (let column = x * 16; column < x * 16 + 16; column++)
                            if (data[layout[0].offset + row * layout[0].stride + column] !== 128)
                                flat = false;
                    if (flat) grey++;
                }
            assert(grey > 0);
        });

        test('an undecodable in-band sequence header skips pictures, not the stream', () => {
            const packets = packetize(INTERLACED_FIXTURE.bytes());
            const warnings = [];
            const decoder = create({ codec: 'mp4v.61' }, warnings);
            const output = [...decoder.decode(chunkOf(packets[0]))];
            const patched = packets[4].data.slice();
            patched[findStartCode(patched, 0xb5) + 5] |= 0x06;
            output.push(...decoder.decode(chunkOf(packets[4], patched)), ...decoder.flush());
            assert.deepEqual(output.map(frameMd5), [INTERLACED_FIXTURE.md5[0]]);
            assert(count(warnings, /4:4:4/) > 0);
        });

        test('D-pictures are skipped without disturbing the stream', () => {
            const packets = packetize(MPEG1_FIXTURE.bytes());
            const picture = packets[0].data.subarray(findStartCode(packets[0].data, 0)).slice();
            picture[5] = (picture[5] & 0xc7) | (4 << 3);
            const frames = decodePackets(
                [packets[0], { ...packets[0], timestamp: 99, data: picture }, ...packets.slice(1)],
                { codec: 'mp4v.6a' },
            );
            assert.deepEqual(frames.map(frameMd5), MPEG1_FIXTURE.md5);
            assert(count(frames.warnings, /D-picture/) > 0);
        });

        test('flipped, cut, replaced and lost packets never throw', () => {
            const random = seededRandom(99);
            const streams = [
                [packetize(MPEG1_FIXTURE.bytes()), 'mp4v.6a'],
                [packetize(INTERLACED_FIXTURE.bytes()), 'mp4v.61'],
                [packetize(INTRA_422_FIXTURE.bytes()), 'mp4v.65'],
                [
                    packetize(writeMpeg2Stream(SYNTHESIZED[1].options), { perField: true }),
                    'mp4v.61',
                ],
            ];
            let decoded = 0;
            for (const [packets, codecString] of streams)
                for (let round = 0; round < 4; round++) {
                    const decoder = create({ codec: codecString });
                    const check = frame => {
                        decoded++;
                        const chroma =
                            frame.format === 'I422' ? frame.codedHeight : frame.codedHeight / 2;
                        assert.equal(
                            frame.data.length,
                            frame.codedWidth * (frame.codedHeight + chroma),
                        );
                    };
                    for (const packet of packets) {
                        let data = packet.data.slice();
                        const mode = random();
                        if (mode < 0.3)
                            for (let flip = 0; flip < 1 + random() * 12; flip++)
                                data[Math.floor(random() * data.length)] ^=
                                    1 << Math.floor(random() * 8);
                        else if (mode < 0.4)
                            data = data.subarray(0, Math.floor(random() * data.length));
                        else if (mode < 0.45)
                            data = Uint8Array.from({ length: 300 }, () =>
                                Math.floor(random() * 256),
                            );
                        else if (mode < 0.5) continue;
                        else if (mode < 0.53) decoder.reset();
                        for (const frame of decoder.decode(chunkOf(packet, data))) check(frame);
                    }
                    for (const frame of decoder.flush()) check(frame);
                    decoder.close();
                }
            assert(decoded > 0);
        });
    });

    describe('plugin', () => {
        test('MediaForge.frames() presents every picture of an MPEG-1 MP4', async () => {
            const times = [];
            for await (const frame of new lite.MediaForge({ plugins: [mpeg12] }).frames(
                await mpegVideoMp4(MPEG1_FIXTURE, 'mpeg12'),
            ))
                times.push([Math.round(frame.timestamp * FRAME_RATE), frame.width, frame.height]);
            assert.deepEqual(
                times,
                MPEG1_FIXTURE.md5.map((_, index) => [index, 70, 46]),
            );
        });

        test('without the plugin MPEG video names the mpeg12 plugin', async () => {
            const forge = new MediaForge({ plugins: { exclude: ['mpeg12'] } });
            await assert.rejects(
                forge.thumbnail(await mpegVideoMp4(MPEG1_FIXTURE, 'mpeg12')),
                error => error.code === 'PLUGIN' && error.plugin === 'mpeg12',
            );
        });
    });
});
