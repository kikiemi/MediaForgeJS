import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { mpeg4 } from 'mediaforgejs/plugins';
import {
    ADVANCED_FIXTURE,
    H263_B_FIXTURE,
    H263_OBMC_FIXTURE,
    H263_PLUS_FIXTURE,
    INTERLACED_FIXTURE,
    PARTITIONED_FIXTURE,
    SHORT_HEADER_FIXTURE,
    SIMPLE_FIXTURE,
    XVID_PACKED_FIXTURE,
} from '../helpers/mpeg4-fixtures.mjs';
import { assertVideoDecoderContract } from '../helpers/codec-contract.mjs';
import { seededRandom } from '../helpers/pcm.mjs';
import { mpegVideoMp4 } from '../helpers/video-mp4.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { mpeg4VideoCodec: codec } = await import(distUrl('esm/codecs/mpeg4/decoder.js'));

const FRAME_RATE = 25;
const VOP_START = 0xb6;
const SMPTE170M = {
    primaries: 'smpte170m',
    transfer: 'smpte170m',
    matrix: 'smpte170m',
    fullRange: false,
};

const isStartCode = (bytes, index, code) =>
    bytes[index] === 0 &&
    bytes[index + 1] === 0 &&
    bytes[index + 2] === 1 &&
    bytes[index + 3] === code;

function vopOffsets(bytes) {
    const offsets = [];
    for (let index = 0; index + 3 < bytes.length; index++)
        if (isStartCode(bytes, index, VOP_START)) offsets.push(index);
    return offsets;
}

/** Headers before the first VOP, and one packet per VOP in stream order. */
function splitVops(bytes) {
    const offsets = vopOffsets(bytes);
    return {
        headers: bytes.subarray(0, offsets[0]),
        vops: offsets.map((offset, index) =>
            bytes.subarray(offset, offsets[index + 1] ?? bytes.length),
        ),
    };
}

/** Splits a short header stream before each picture start code. */
function splitPictures(bytes) {
    const offsets = [];
    for (let index = 0; index + 2 < bytes.length; index++)
        if (bytes[index] === 0 && bytes[index + 1] === 0 && (bytes[index + 2] & 0xfc) === 0x80)
            offsets.push(index);
    return offsets.map((offset, index) =>
        bytes.subarray(offset, offsets[index + 1] ?? bytes.length),
    );
}

function splitSizes(bytes, sizes) {
    const packets = [];
    let offset = 0;
    for (const size of sizes) {
        packets.push(bytes.subarray(offset, offset + size));
        offset += size;
    }
    assert.equal(offset, bytes.length);
    return packets;
}

/** Presentation index of each VOP in decode order: an anchor shows after the B-VOPs after it. */
function presentationOrder(vops) {
    const order = [];
    let held = -1;
    let shown = 0;
    vops.forEach((vop, index) => {
        if (vop[4] >> 6 === 2) order[index] = shown++;
        else {
            if (held >= 0) order[held] = shown++;
            held = index;
        }
    });
    if (held >= 0) order[held] = shown;
    return order;
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/**
 * Container-style packets of a fixture with their presentation indices: the layer headers in
 * `description` when `withDescription`, else in-band.
 */
function packetsOf(fixture, { withDescription = true } = {}) {
    const bytes = fixture.bytes();
    const sequential = packets => ({ packets, order: packets.map((_, index) => index) });
    if (fixture.codec === 's263') return sequential(splitPictures(bytes));
    if (fixture.packetSizes) return sequential(splitSizes(bytes, fixture.packetSizes));
    const { headers, vops } = splitVops(bytes);
    const order = presentationOrder(vops);
    if (withDescription) return { description: headers, packets: vops, order };
    return { packets: [concat(headers, vops[0]), ...vops.slice(1)], order };
}

const chunkOf = (data, index) => ({
    data,
    timestamp: index / FRAME_RATE,
    duration: 1 / FRAME_RATE,
    isKeyframe: index === 0,
    trackType: 'video',
});

/** A decoder whose diagnostics go to `warnings`. */
const create = (config, warnings = []) =>
    codec.create({ ...config, onWarning: warnings.push.bind(warnings) });

/** Every frame of `packets` decoded and flushed, with the diagnostics as `warnings`. */
function decodeAll(config, packets, order = packets.map((_, index) => index)) {
    const warnings = [];
    const decoder = create(config, warnings);
    const frames = [];
    packets.forEach((data, index) => frames.push(...decoder.decode(chunkOf(data, order[index]))));
    frames.push(...decoder.flush());
    decoder.close();
    return Object.assign(frames, { warnings });
}

/** MD5 of the visible Y, U and V planes packed without padding, as ffmpeg's framemd5 hashes. */
function frameMd5(frame) {
    const hash = createHash('md5');
    const { width, height } = frame.visibleRect;
    for (const [plane, planeWidth, planeHeight] of [
        [frame.layout[0], width, height],
        [frame.layout[1], (width + 1) >> 1, (height + 1) >> 1],
        [frame.layout[2], (width + 1) >> 1, (height + 1) >> 1],
    ])
        for (let row = 0; row < planeHeight; row++) {
            const start = plane.offset + row * plane.stride;
            hash.update(frame.data.subarray(start, start + planeWidth));
        }
    return hash.digest('hex');
}

/** Luma samples of macroblock (x, y). */
function lumaMacroblock(frame, x, y) {
    const { offset, stride } = frame.layout[0];
    const rows = [];
    for (let row = y * 16; row < y * 16 + 16; row++) {
        const start = offset + row * stride + x * 16;
        rows.push(Array.from(frame.data.subarray(start, start + 16)));
    }
    return rows;
}

/** MSB-first bits followed by next_start_code() stuffing (a zero, then ones to the byte end). */
function bitsToBytes(bits) {
    let text = bits.replace(/\s+/g, '') + '0';
    while (text.length % 8) text += '1';
    return Uint8Array.from({ length: text.length / 8 }, (_, index) =>
        parseInt(text.slice(index * 8, index * 8 + 8), 2),
    );
}

const has = (warnings, text) => warnings.some(warning => warning.includes(text));

const EXACT = [
    { fixture: SIMPLE_FIXTURE, displayWidth: 64, interlaced: undefined },
    { fixture: PARTITIONED_FIXTURE, displayWidth: 64, interlaced: undefined },
    { fixture: ADVANCED_FIXTURE, displayWidth: 82, interlaced: undefined },
    { fixture: INTERLACED_FIXTURE, displayWidth: 64, interlaced: 'bottom-field-first' },
    { fixture: XVID_PACKED_FIXTURE, displayWidth: 64, interlaced: undefined },
    { fixture: SHORT_HEADER_FIXTURE, displayWidth: 140, interlaced: undefined },
    { fixture: H263_PLUS_FIXTURE, displayWidth: 140, interlaced: undefined },
    { fixture: H263_OBMC_FIXTURE, displayWidth: 140, interlaced: undefined },
];

describe('mpeg4', () => {
    describe('configuration', () => {
        test('supports MPEG-4 Part 2 profiles and H.263, nothing else', () => {
            assert.equal(codec.id, 'mpeg4-part2');
            for (const name of [
                'mp4v.20',
                'mp4v.20.1',
                'mp4v.20.9',
                'mp4v.20.245',
                'MP4V.20.8',
                's263',
                'h263',
            ])
                assert.equal(codec.supports(name), true, name);
            for (const other of [
                'mp4v.6a',
                'mp4v.61',
                'mp4v.20.2450',
                'avc1.42E01E',
                'mp4v',
                '',
                'mpeg4',
            ])
                assert.equal(codec.supports(other), false, other);
        });

        test('a layer with binary shape is refused as DECODE, out of band or in band', () => {
            // visual_object_sequence, then a video_object_layer with binary shape (14496-2 6.2.3).
            const shaped = concat(
                [0, 0, 1, 0xb0, 0xf3, 0, 0, 1, 0, 0, 0, 1, 0x20],
                bitsToBytes('0 00000001 0 0001 0 01'),
            );
            assert.throws(() => codec.create({ codec: 'mp4v.20.245', description: shaped }), {
                code: 'DECODE',
            });
            const decoder = create({ codec: 'mp4v.20.245' });
            assert.throws(() => decoder.decode(chunkOf(shaped, 0)), { code: 'DECODE' });
            decoder.close();
            assert.throws(
                () => decoder.decode(chunkOf(SIMPLE_FIXTURE.bytes(), 0)),
                { code: 'DECODE' },
                'after close',
            );
        });

        test('the layer headers may arrive in band instead of in the description', () => {
            const inBand = packetsOf(SIMPLE_FIXTURE, { withDescription: false });
            assert.deepEqual(
                decodeAll({ codec: SIMPLE_FIXTURE.codec }, inBand.packets).map(frameMd5),
                SIMPLE_FIXTURE.md5,
            );
        });

        test('VOPs before any layer header are dropped with a diagnostic', () => {
            const frames = decodeAll(
                { codec: SIMPLE_FIXTURE.codec },
                packetsOf(SIMPLE_FIXTURE).packets,
            );
            assert.equal(frames.length, 0);
            assert(has(frames.warnings, 'before any video object layer'));
        });

        test('video_signal_type sets BT.709 full-range colour', () => {
            const { headers, vops } = splitVops(SIMPLE_FIXTURE.bytes());
            // visual_object: component video, full range, BT.709 primaries, transfer and matrix.
            const visualObject = concat(
                [0, 0, 1, 0xb5],
                bitsToBytes('0 0001 1 000 1 1 00000001 00000001 00000001'),
            );
            const layer = headers.subarray(
                headers.findIndex((_, index) => isStartCode(headers, index, 0x20)),
            );
            const frames = decodeAll(
                {
                    codec: SIMPLE_FIXTURE.codec,
                    description: concat([0, 0, 1, 0xb0, 0x01], visualObject, [0, 0, 1, 0], layer),
                },
                vops,
            );
            assert.deepEqual(frames.map(frameMd5), SIMPLE_FIXTURE.md5);
            for (const frame of frames)
                assert.deepEqual(frame.colorSpace, {
                    primaries: 'bt709',
                    transfer: 'bt709',
                    matrix: 'bt709',
                    fullRange: true,
                });
        });

        test('a layer of a new size restarts decoding at that size', () => {
            const simple = packetsOf(SIMPLE_FIXTURE, { withDescription: false }).packets;
            const advanced = packetsOf(ADVANCED_FIXTURE, { withDescription: false }).packets;
            const frames = decodeAll({ codec: 'mp4v.20.245' }, [...simple, ...advanced]);
            assert.deepEqual(frames.map(frameMd5), [
                ...SIMPLE_FIXTURE.md5,
                ...ADVANCED_FIXTURE.md5,
            ]);
            assert.deepEqual(
                frames.map(({ visibleRect: { width, height }, codedWidth, codedHeight }) =>
                    [width, height, 'in', codedWidth, codedHeight].join(' '),
                ),
                [...simple.map(() => '64 48 in 64 48'), ...advanced.map(() => '70 46 in 80 48')],
            );
        });
    });

    describe('decoding against ffmpeg', () => {
        for (const { fixture, displayWidth, interlaced } of EXACT)
            test(`${fixture.name} decodes exactly with its frame layout and metadata`, () => {
                const { description, packets, order } = packetsOf(fixture);
                const frames = decodeAll({ codec: fixture.codec, description }, packets, order);
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
                        [codedWidth, codedHeight, displayWidth, fixture.height],
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
                        [index / FRAME_RATE, 1 / FRAME_RATE, index === 0, interlaced],
                    );
                    assert.deepEqual(frame.colorSpace, SMPTE170M);
                });
                assert(
                    frames.every(
                        frame => frames.filter(other => other.data === frame.data).length === 1,
                    ),
                    'every frame owns its buffer',
                );
            });

        test('H.263 B pictures decode exactly and show between their references', () => {
            // In containers timed by presentation the first P picture shows before the decoder
            // meets a B picture, so the B pictures before it are dropped.
            const packets = splitPictures(H263_B_FIXTURE.bytes());
            const references = packets.map(picture => ((picture[2] & 3) << 6) | (picture[3] >> 2));
            const order = references.map(
                reference => references.filter(other => other < reference).length,
            );
            const frames = decodeAll({ codec: 's263' }, packets, order);
            assert.deepEqual(frames.map(frameMd5), H263_B_FIXTURE.md5);
            assert.deepEqual(
                frames.map(frame => Math.round(frame.timestamp * FRAME_RATE)),
                [0, 3, 4, 5, 6],
            );
            assert.deepEqual(frames.warnings, [
                'Dropped a B-VOP in a low-delay stream',
                'Dropped a B picture shown after its later reference',
            ]);
        });

        for (const improved of [false, true])
            test(`${improved ? 'improved ' : ''}PB-frames decode their P pictures exactly`, () => {
                // Sub-QCIF H.263: an I picture of DC-only macroblocks, then a PB-frame (Annex G,
                // or Annex M in a PLUSPTYPE picture) with B vectors and coefficients on an inter
                // and an intra macroblock. The B part is read and discarded as in ffmpeg.
                const bin = (value, length) => value.toString(2).padStart(length, '0');
                const h263Bytes = bits => {
                    const text = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
                    return Uint8Array.from({ length: text.length / 8 }, (_, i) =>
                        parseInt(text.slice(i * 8, i * 8 + 8), 2),
                    );
                };
                const start = tr => '0000000000000000100000' + bin(tr, 8) + '10000';
                const escaped = level => '0000011' + '1' + '000000' + bin(level, 8);
                let intra = start(0) + '001' + '0' + '0000' + bin(8, 5) + '0' + '0';
                for (let mb = 0; mb < 48; mb++) {
                    intra += '1' + '0011';
                    for (let n = 0; n < 6; n++)
                        intra += bin(
                            n < 4 ? 16 + ((mb * 37 + n * 11) % 96) : 100 + ((mb * 13) % 27),
                            8,
                        );
                }
                // Baseline PTYPE with the PB flag, or PLUSPTYPE (UFEP 1, sub-QCIF, no modes) with
                // picture type 2; then TRB, DBQUANT and PEI.
                let pb = improved
                    ? start(1) +
                      '111' +
                      '001' +
                      '001' +
                      '00000000000' +
                      '1000' +
                      '010' +
                      '000' +
                      '001' +
                      '0' +
                      bin(8, 5)
                    : start(1) + '001' + '1' + '0001' + bin(8, 5) + '0';
                pb += '010' + '00' + '0';
                for (let mb = 0; mb < 48; mb++) {
                    if (mb === 9) {
                        // Inter: MODB with CBPB 000001, CBPY, MVD, MVDB, then the B chroma block.
                        pb += '0' + '1' + (improved ? '1110' : '11') + '000001110010001111';
                        pb += escaped(1);
                    } else if (mb === 20) {
                        // Intra: MODB (Annex M: with CBPB 100000), CBPY, the B vectors, six DCs,
                        // the B luma block.
                        pb +=
                            '0' +
                            '00011' +
                            (improved ? '10' + '100000' : '10') +
                            '0011' +
                            (improved ? '11' : '1111');
                        for (let n = 0; n < 6; n++) pb += bin(200, 8);
                        if (improved) pb += escaped(2);
                    } else if (mb === 30) pb += '0' + '1' + '0' + '1011' + '1' + '1' + escaped(3);
                    else pb += '1';
                }
                const frames = decodeAll({ codec: 'h263' }, [h263Bytes(intra), h263Bytes(pb)]);
                assert.deepEqual(frames.warnings, []);
                assert.deepEqual(frames.map(frameMd5), [
                    'b1c914da6815facc0fc556ced9981f67',
                    'a95ebf0939c55417fdf536ef3d369e01',
                ]);
            });

        test('P pictures before any I picture decode against a blank picture', () => {
            // A stream cut after its first I picture starts from black luma, as ffmpeg's.
            const { packets } = packetsOf(SHORT_HEADER_FIXTURE);
            const frames = decodeAll({ codec: 's263' }, packets.slice(1));
            assert.deepEqual(frames.map(frameMd5), [
                'bd8f03fd661aaa3fd936a932242383dc',
                '5700994cfd8f8bcf7ec91679120c0a29',
            ]);
            assert(has(frames.warnings, 'predicted from a blank picture'));
        });

        test('keeps the video decoder contract', () => {
            assertVideoDecoderContract(create({ codec: 'mp4v.20.9' }));
        });
    });

    describe('reordering', () => {
        test('anchors wait for the B-VOPs shown before them; flush returns the last', () => {
            const { description, packets } = packetsOf(ADVANCED_FIXTURE);
            assert.deepEqual(
                packets.map(packet => 'IPBS'[packet[4] >> 6]),
                ['I', 'P', 'B', 'B', 'P', 'B', 'B'],
            );
            const decoder = create({ codec: ADVANCED_FIXTURE.codec, description });
            const shown = [0, 3, 1, 2, 6, 4, 5].map((index, step) =>
                decoder
                    .decode(chunkOf(packets[step], index))
                    .map(frame => Math.round(frame.timestamp * FRAME_RATE)),
            );
            assert.deepEqual(shown, [[], [0], [1], [2], [3], [4], [5]]);
            assert.deepEqual(
                decoder
                    .flush()
                    .map(frame => [Math.round(frame.timestamp * FRAME_RATE), frameMd5(frame)]),
                [[6, ADVANCED_FIXTURE.md5[6]]],
            );
            assert.deepEqual(decoder.flush(), [], 'a second flush has nothing left');
            decoder.close();
        });

        test('packed B-frames decode the same pictures one VOP per packet', () => {
            // Each anchor (a GMC S-VOP, then a P-VOP) travels with the B-VOP shown before it.
            const { packets } = packetsOf(XVID_PACKED_FIXTURE);
            assert.deepEqual(
                packets.map(packet =>
                    vopOffsets(packet).map(
                        offset => 'IPBS'[packet[offset + 4] >> 6] + (packet.length > 8 ? '' : 'n'),
                    ),
                ),
                [['I'], ['S', 'B'], ['Sn'], ['P', 'B'], ['Pn']],
            );
            const vops = packets.flatMap(packet =>
                vopOffsets(packet).map((offset, index, all) =>
                    packet.subarray(index ? offset : 0, all[index + 1]),
                ),
            );
            const frames = decodeAll(
                { codec: XVID_PACKED_FIXTURE.codec },
                [vops[0], vops[1], vops[2], vops[4], vops[5]],
                [0, 2, 1, 4, 3],
            );
            assert.deepEqual(frames.map(frameMd5), XVID_PACKED_FIXTURE.md5);
            assert.deepEqual(
                frames.map(frame => frame.timestamp * FRAME_RATE),
                [0, 1, 2, 3, 4],
            );
        });

        test('a not-coded VOP repeats the previous picture at its own time', () => {
            const { description, packets } = packetsOf(SIMPLE_FIXTURE);
            // A P-VOP with vop_coded 0: a 5-bit vop_time_increment for 25 Hz (14496-2 6.2.5).
            const notCoded = concat([0, 0, 1, VOP_START], bitsToBytes('01 0 1 00110 1 0'));
            const decoder = create({ codec: SIMPLE_FIXTURE.codec, description });
            const output = packets.flatMap((data, index) => decoder.decode(chunkOf(data, index)));
            const repeated = decoder.decode(chunkOf(notCoded, packets.length));
            assert.equal(repeated.length, 1);
            assert.equal(frameMd5(repeated[0]), SIMPLE_FIXTURE.md5.at(-1));
            assert.deepEqual(
                [repeated[0].timestamp, repeated[0].keyFrame],
                [packets.length / FRAME_RATE, false],
            );
            assert.notEqual(repeated[0].data, output.at(-1).data, 'each frame owns its planes');
        });

        test('after reset() P-VOPs wait for the next I-VOP', () => {
            const { description, packets } = packetsOf(SIMPLE_FIXTURE);
            const warnings = [];
            const decoder = create({ codec: SIMPLE_FIXTURE.codec, description }, warnings);
            packets.forEach((data, index) => decoder.decode(chunkOf(data, index)));
            decoder.reset();
            assert.deepEqual(
                packets.slice(1).flatMap((data, index) => decoder.decode(chunkOf(data, index + 1))),
                [],
            );
            assert(has(warnings, 'waiting for an I-VOP'));
            const resumed = packets.flatMap((data, index) => decoder.decode(chunkOf(data, index)));
            assert.deepEqual(resumed.map(frameMd5), SIMPLE_FIXTURE.md5);
        });

        test('B-VOPs without both references are dropped', () => {
            const { description, packets } = packetsOf(ADVANCED_FIXTURE);
            const warnings = [];
            const decoder = create({ codec: ADVANCED_FIXTURE.codec, description }, warnings);
            decoder.decode(chunkOf(packets[0], 0));
            decoder.reset();
            assert.deepEqual(
                [
                    ...decoder.decode(chunkOf(packets[2], 1)),
                    ...decoder.decode(chunkOf(packets[1], 3)),
                ],
                [],
            );
            assert(has(warnings, 'B-VOP without both references'));
        });
    });

    describe('damage', () => {
        test('macroblocks lost after a resync marker repeat the previous picture', () => {
            const { description, packets } = packetsOf(SIMPLE_FIXTURE);
            const intact = decodeAll({ codec: SIMPLE_FIXTURE.codec, description }, packets);
            // Cut the P-VOP at its last resync marker (16 zero bits and a one for f_code 1).
            let marker = packets[2].length - 3;
            while (
                packets[2][marker] !== 0 ||
                packets[2][marker + 1] !== 0 ||
                packets[2][marker + 2] < 0x80
            )
                marker--;
            const damaged = packets.slice();
            damaged[2] = packets[2].subarray(0, marker);
            const frames = decodeAll({ codec: SIMPLE_FIXTURE.codec, description }, damaged);
            assert.equal(frames.length, packets.length);
            assert(has(frames.warnings, 'concealed'));
            for (let x = 0; x < 4; x++)
                assert.deepEqual(lumaMacroblock(frames[2], x, 0), lumaMacroblock(intact[2], x, 0));
            assert.notDeepEqual(lumaMacroblock(intact[2], 3, 2), lumaMacroblock(intact[1], 3, 2));
            assert.deepEqual(lumaMacroblock(frames[2], 3, 2), lumaMacroblock(frames[1], 3, 2));
        });

        test('flipped, cut and replaced packets never throw', () => {
            const random = seededRandom(99);
            let decoded = 0;
            for (const fixture of [...EXACT.map(entry => entry.fixture), H263_B_FIXTURE]) {
                const { description, packets } = packetsOf(fixture);
                for (let round = 0; round < 4; round++) {
                    const decoder = create({ codec: fixture.codec, description });
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
                                data[4 + Math.floor(random() * (data.length - 4))] ^=
                                    1 << Math.floor(random() * 8);
                        else if (mode < 0.45)
                            data = data.subarray(0, Math.floor(random() * data.length));
                        else if (mode < 0.5)
                            data = concat(
                                data.subarray(0, 5),
                                Uint8Array.from({ length: 200 }, () => random() * 256),
                            );
                        else if (mode < 0.53) decoder.reset();
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
        test('MediaForge.frames() presents every picture of an MPEG-4 MP4', async () => {
            const shown = [];
            for await (const frame of new lite.MediaForge({ plugins: [mpeg4] }).frames(
                await mpegVideoMp4(SIMPLE_FIXTURE, 'mpeg4'),
            ))
                shown.push([Math.round(frame.timestamp * FRAME_RATE), frame.width, frame.height]);
            assert.deepEqual(
                shown,
                SIMPLE_FIXTURE.md5.map((_, index) => [index, 64, 48]),
            );
        });

        test('without the plugin MPEG-4 video names the mpeg4 plugin', async () => {
            const forge = new MediaForge({ plugins: { exclude: ['mpeg4'] } });
            await assert.rejects(
                forge.thumbnail(await mpegVideoMp4(SIMPLE_FIXTURE, 'mpeg4')),
                error => error.code === 'PLUGIN' && error.plugin === 'mpeg4',
            );
        });
    });
});
