import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { convert, inspect, open } from 'mediaforgejs';
import { encodeMp3, parseMp3FrameHeader } from 'mediaforgejs/codecs';
import { AviDemuxer, AviMuxer, Mp4Demuxer, Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { reorderFixture } from '../helpers/avi-h264-reorder-fixtures.mjs';
import {
    aviH264,
    avcc,
    annexB,
    lengthPrefixed,
    sps,
    pps,
    idr,
    predicted,
    aud,
    filler,
    readNals,
    join,
    aviChunks,
    aviRecordLists,
    aviAvix,
    chunk,
    list,
    text,
} from '../helpers/avi-h264-fixtures.mjs';
import {
    AAC_PAYLOADS,
    adtsFrame,
    concat,
    mpegAudioFixture,
} from '../helpers/original-fixtures.mjs';
import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    divxUserData,
    mpeg2Gop,
    mpeg4Config,
    mpeg4Vop,
    mpegSequence,
} from '../helpers/mpeg-video-fixtures.mjs';
import { packetsOf } from '../helpers/media-packets.mjs';
import { differentialFixtures } from '../helpers/differential-fixtures.mjs';
import { allPackets, copied, readMedia } from '../helpers/read-media.mjs';
import { aviAudioFile, dtsCore, waveFormatEx } from '../helpers/sync-audio-fixtures.mjs';
import { aviPcmFixture, parseMatroska } from '../helpers/multitrack-pcm-fixtures.mjs';

const x264Oracle = JSON.parse(
    await readFile(new URL('../fixtures/avi-h264/oracle.json', import.meta.url), 'utf8'),
);

describe('avi', () => {
    for (const framing of ['annexb', 'avcc'])
        test(
            `AVI H.264 ${framing} restores B-frame presentation order without reordering ` +
                `packets`,
            async () => {
                const fixture = reorderFixture({ framing });
                const bytes = fixture.avi([
                    { type: 'IDR', poc: 0 },
                    { frameNum: 1, poc: 6 },
                    { type: 'B', frameNum: 2, poc: 2 },
                    { type: 'B', frameNum: 2, poc: 4 },
                ]);
                const {
                    videoTracks: [track],
                } = await new AviDemuxer().demux(new Blob([bytes]));
                assert.deepEqual(
                    track.samples.map(sample => Math.round(sample.timestamp * 25)),
                    [0, 3, 1, 2],
                );
                assert.deepEqual(
                    track.samples.map(sample => Math.round(sample.decodeTimestamp * 25)),
                    [-1, 0, 1, 2],
                );
                assert.deepEqual(
                    track.samples.map(sample => Math.round(sample.compositionTimeOffset * 25)),
                    [1, 3, 0, 0],
                );
                assert.equal(track.duration, 0.16);
                assert(
                    track.samples.every(
                        (sample, index, samples) =>
                            !index || sample.offset > samples[index - 1].offset,
                    ),
                );
            },
        );

    /**
     * AVI decode slots moved earlier by the reorder delay, so that no picture is decoded after it
     * is presented.
     */
    const decodeSlots = presentation => {
        const delay = Math.max(0, ...presentation.map((tick, index) => index - tick));
        return presentation.map((_, index) => index - delay);
    };

    const timingCases = [
        [
            'POC wrap and reference B pictures',
            {},
            [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 6 },
                { type: 'B', reference: true, frameNum: 2, poc: 4 },
                { type: 'B', frameNum: 3, poc: 2 },
                { frameNum: 3, poc: 12 },
                { type: 'B', frameNum: 4, poc: 8 },
                { type: 'B', frameNum: 4, poc: 10 },
                { frameNum: 4, poc: 2 },
                { type: 'B', frameNum: 5, poc: 14 },
                { type: 'B', frameNum: 5, poc: 0 },
            ],
            [0, 3, 2, 1, 6, 4, 5, 9, 7, 8],
        ],
        [
            'IDR reset',
            {},
            [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 4 },
                { type: 'B', frameNum: 2, poc: 2 },
                { type: 'IDR', poc: 0, idrId: 1 },
                { frameNum: 1, poc: 4 },
                { type: 'B', frameNum: 2, poc: 2 },
            ],
            [0, 2, 1, 3, 5, 4],
        ],
        [
            'POC type 1 cycle offsets',
            { pocType: 1, offsets: [6], nonRefOffset: -4 },
            [
                { type: 'IDR' },
                { frameNum: 1 },
                { type: 'B', frameNum: 2 },
                { type: 'B', frameNum: 2, delta0: 2 },
            ],
            [0, 3, 1, 2],
        ],
        [
            'POC type 1 delta and bottom field order',
            { pocType: 1, offsets: [2], bottomPresent: true },
            [
                { type: 'IDR' },
                { frameNum: 1, delta0: 4 },
                { type: 'B', frameNum: 2, delta0: 3, delta1: -2 },
                { type: 'B', frameNum: 2, delta0: 3 },
            ],
            [0, 3, 1, 2],
        ],
        [
            'POC type 1 zero delta',
            { pocType: 1, offsets: [4], nonRefOffset: -2, deltaAlwaysZero: true },
            [{ type: 'IDR' }, { frameNum: 1 }, { type: 'B', frameNum: 2 }],
            [0, 2, 1],
        ],
        [
            'POC type 2 non-reference picture',
            { pocType: 2 },
            [{ type: 'IDR' }, { frameNum: 1 }, { type: 'B', frameNum: 1 }],
            [0, 2, 1],
        ],
        [
            'MBAFF frame order uses both field counts',
            { frameOnly: false, bottomPresent: true },
            [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 8, delta1: -2 },
                { type: 'B', frameNum: 2, poc: 4, delta1: -2 },
                { type: 'B', frameNum: 2, poc: 4 },
            ],
            [0, 3, 1, 2],
        ],
        [
            'in-band parameter sets',
            { inBand: true },
            [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 4 },
                { type: 'B', frameNum: 2, poc: 2 },
            ],
            [0, 2, 1],
        ],
        [
            'MMCO 5 reset after weighted prediction',
            { weightedPred: true },
            [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 4 },
                { type: 'B', frameNum: 2, poc: 2 },
                { frameNum: 2, poc: 6, reset: true },
                { frameNum: 1, poc: 4 },
                { type: 'B', frameNum: 2, poc: 2 },
            ],
            [0, 2, 1, 3, 5, 4],
        ],
    ];
    for (const [name, options, pictures, expected] of timingCases)
        test(`AVI H.264 restores ${name}`, async () => {
            const {
                videoTracks: [track],
            } = await new AviDemuxer().demux(new Blob([reorderFixture(options).avi(pictures)]));
            assert.deepEqual(
                track.samples.map(sample => Math.round(sample.timestamp * 25)),
                expected,
            );
            assert.deepEqual(
                track.samples.map(sample => Math.round(sample.decodeTimestamp * 25) || 0),
                decodeSlots(expected),
            );
        });

    test(
        'AVI H.264 pictures repeated by damage are shown in turn; strict validation rejects ' +
            'them',
        async () => {
            const fixture = reorderFixture();
            const repeatedB = { type: 'B', frameNum: 2, poc: 2 };
            const bytes = fixture.avi([
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 4 },
                repeatedB,
                repeatedB,
            ]);
            const warnings = [];
            const media = await open(bytes, { onWarning: warning => warnings.push(warning.code) });
            try {
                const times = [];
                for await (const packet of media.packets())
                    times.push(Math.round(packet.timestamp * 25));
                assert.deepEqual(times, [0, 3, 1, 2]);
                assert(warnings.includes('AVI_DUPLICATE_PICTURE'), warnings.join());
            } finally {
                media.close();
            }
            await assert.rejects(
                open(bytes, { validation: 'strict' }),
                error => error.code === 'DEMUX',
            );
        },
    );

    test('AVI H.264 multiple slices update picture-order state once per packet', async () => {
        const fixture = reorderFixture();
        const pictures = [
            { type: 'IDR', poc: 0 },
            { frameNum: 1, poc: 4 },
            { type: 'B', frameNum: 2, poc: 2 },
        ];
        const bytes = fixture.avi(
            pictures.map(picture => [
                fixture.slice(picture),
                fixture.slice({ ...picture, firstMb: 1 }),
            ]),
        );
        const {
            videoTracks: [track],
        } = await new AviDemuxer().demux(new Blob([bytes]));
        assert.deepEqual(
            track.samples.map(sample => Math.round(sample.timestamp * 25)),
            [0, 2, 1],
        );
    });

    test('AVI H.264 rejects multiple pictures sharing a container timestamp', async () => {
        const fixture = reorderFixture();
        await assert.rejects(
            new AviDemuxer().demux(
                new Blob([
                    fixture.avi([
                        [fixture.slice({ type: 'IDR' }), fixture.slice({ frameNum: 1, poc: 2 })],
                    ]),
                ]),
            ),
            /multiple pictures/i,
        );
    });

    test('AVI H.264 rejects separate field pictures, whose frame timing is ambiguous', async () => {
        const fixture = reorderFixture({ frameOnly: false });
        await assert.rejects(
            new AviDemuxer().demux(new Blob([fixture.avi([{ type: 'IDR', field: true }])])),
            /field picture/i,
        );
    });

    test('AVI H.264 without parameter sets is rejected, not given B-frame timing', async () => {
        const fixture = reorderFixture();
        await assert.rejects(
            new AviDemuxer().demux(
                new Blob([
                    aviH264({
                        extra: new Uint8Array(0),
                        packets: [
                            fixture.packet(fixture.slice({ type: 'B', frameNum: 2, poc: 2 })),
                        ],
                    }),
                ]),
            ),
            /parameter set|PPS/i,
        );
    });

    test(
        'AVI H.264 ambiguous prefixes do not hide slice timing errors in valid length ' + 'framing',
        async () => {
            const fixture = reorderFixture();
            const other = reorderFixture({ ppsId: 1 });
            const header = other.slice({ type: 'B', poc: 2, frameNum: 2 });
            const slice = join(header, new Uint8Array(262 - header.length).fill(0xff));
            await assert.rejects(
                new AviDemuxer().demux(
                    new Blob([
                        aviH264({
                            extra: fixture.config,
                            packets: [lengthPrefixed(4, slice)],
                        }),
                    ]),
                ),
                /missing PPS/i,
            );
        },
    );

    for (const pocType of [1, 2])
        test(`AVI H.264 POC type ${pocType} frame_num wrap keeps reference history`, async () => {
            const fixture = reorderFixture({ pocType, offsets: [2], nonRefOffset: -1 });
            const pictures = [
                { type: 'IDR' },
                ...Array.from({ length: 15 }, (_, index) => ({ frameNum: index + 1 })),
            ];
            pictures.push(
                { frameNum: 0 },
                { type: 'B', frameNum: pocType === 1 ? 1 : 0 },
                { frameNum: 1 },
            );
            const {
                videoTracks: [track],
            } = await new AviDemuxer().demux(new Blob([fixture.avi(pictures)]));
            assert.deepEqual(
                track.samples.map(sample => Math.round(sample.timestamp * 25)),
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 16, 18],
            );
        });

    test('AVI H.264 header prefix may end inside an emulation-prevention sequence', async () => {
        const fixture = reorderFixture();
        const header = fixture.slice({ type: 'IDR' });
        const data = join(
            header,
            new Uint8Array(65533 - header.length).fill(0xff),
            [0, 0, 3, 0, 0x80],
        );
        const {
            videoTracks: [track],
        } = await new AviDemuxer().demux(new Blob([fixture.avi([[data]])]));
        assert.equal(track.samples[0].timestamp, 0);
    });

    test(
        'AVI H.264 preserves dropped presentation slots when the following packet is a B ' +
            'frame',
        async () => {
            const fixture = reorderFixture();
            const packets = [
                fixture.packet(fixture.slice({ type: 'IDR' })),
                fixture.packet(fixture.slice({ frameNum: 1, poc: 4 })),
                new Uint8Array(0),
                fixture.packet(fixture.slice({ type: 'B', frameNum: 2, poc: 2 })),
            ];
            const {
                videoTracks: [track],
            } = await new AviDemuxer().demux(
                new Blob([aviH264({ extra: fixture.config, packets })]),
            );
            assert.deepEqual(
                track.samples.map(sample => [
                    Math.round(sample.timestamp * 25),
                    Math.round(sample.duration * 25),
                ]),
                [
                    [0, 1],
                    [3, 1],
                    [1, 2],
                ],
            );
            assert.equal(track.duration, 0.16);
        },
    );

    for (const [name, oracle] of Object.entries(x264Oracle.fixtures))
        test(
            `AVI H.264 x264 ${name} keeps independent display order and packet hashes through ` +
                `MP4/MKV`,
            async () => {
                const bytes = new Uint8Array(
                    await readFile(new URL(`../fixtures/avi-h264/${name}.avi`, import.meta.url)),
                );
                assert.equal(createHash('sha256').update(bytes).digest('hex'), oracle.sha256);
                const {
                    videoTracks: [track],
                } = await new AviDemuxer().demux(new Blob([bytes]));
                assert.deepEqual(
                    track.samples.map(sample => Math.round(sample.timestamp * 25)),
                    oracle.presentationTicks,
                );
                assert.deepEqual(
                    track.samples.map(sample => Math.round(sample.decodeTimestamp * 25) || 0),
                    decodeSlots(oracle.presentationTicks),
                );
                assert.equal(Math.round(track.duration * 25), oracle.frameCount);
                const media = await open(bytes);
                try {
                    for (const format of ['mp4', 'mkv']) {
                        const blob = (await media.convert(format, { copy: true })).blob;
                        const outputBytes = new Uint8Array(await blob.arrayBuffer());
                        if (format === 'mp4' && name !== 'no-b') {
                            const ctts = findMp4Box(outputBytes, [
                                'moov',
                                'trak',
                                'mdia',
                                'minf',
                                'stbl',
                                'ctts',
                            ]);
                            // Decode times start one reorder delay early, so composition
                            // offsets need no sign.
                            const view = new DataView(
                                ctts.buffer,
                                ctts.byteOffset,
                                ctts.byteLength,
                            );
                            const offsets = [];
                            for (let offset = 8; offset < ctts.length; offset += 8)
                                offsets.push(view.getInt32(offset + 4));
                            assert(offsets.every(offset => offset >= 0));
                            assert(offsets.some(offset => offset > 0));
                        }
                        const output = await open(outputBytes);
                        try {
                            const packets = await Array.fromAsync(output.packets());
                            assert.deepEqual(
                                packets.map(packet => Math.round(packet.timestamp * 25)),
                                oracle.presentationTicks,
                                format,
                            );
                            assert.deepEqual(
                                packets.map(packet =>
                                    createHash('sha256').update(packet.data).digest('hex'),
                                ),
                                oracle.packetNalsSha256,
                                format,
                            );
                        } finally {
                            output.close();
                        }
                    }
                } finally {
                    media.close();
                }
            },
        );

    function findMp4Box(bytes, path) {
        let data = bytes;
        for (const name of path) {
            let found;
            for (let offset = 0; offset + 8 <= data.length;) {
                const view = new DataView(
                    data.buffer,
                    data.byteOffset + offset,
                    data.length - offset,
                );
                const shortSize = view.getUint32(0);
                const header = shortSize === 1 ? 16 : 8;
                const size =
                    shortSize === 1
                        ? Number(view.getBigUint64(8))
                        : shortSize || data.length - offset;
                assert(size >= header && offset + size <= data.length);
                if (String.fromCharCode(...data.subarray(offset + 4, offset + 8)) === name) {
                    found = data.subarray(offset + header, offset + size);
                    break;
                }
                offset += size;
            }
            assert(found, `missing ${name} box`);
            data = found;
        }
        return data;
    }

    /**
     * `mp4` holds the packets an MP4 copy reads back as when they differ: an MP4 sample without a
     * picture joins the access unit that follows (ISO/IEC 14496-15 keeps one access unit, with its
     * picture, per sample).
     */
    async function verifyCopy(
        input,
        expectedConfig,
        expectedNals,
        keyframes,
        mp4 = { nals: expectedNals, keyframes },
    ) {
        const parsed = await new AviDemuxer().demux(new Blob([input]));
        const track = parsed.videoTracks[0];
        assert.deepEqual(
            track.codecConfig,
            expectedConfig,
            'AVI must retain or derive its decoder configuration',
        );
        assert.equal(track.codec, 'avc1.42000a');
        assert.deepEqual(
            track.samples.map(sample => sample.isKeyframe),
            keyframes,
        );
        assert(
            track.samples.every(sample => sample.data === undefined),
            'Demux must keep source ranges without retaining payload copies',
        );
        const media = await open(input);
        try {
            for (const format of ['mkv', 'mp4']) {
                const check = await media.check(format, { copy: true });
                assert.equal(check.supported, true, `${format}: ${check.reason}`);
                const output = await open((await media.convert(format, { copy: true })).blob);
                try {
                    assert.equal(output.tracks.length, 1);
                    assert.deepEqual(output.tracks[0].codecConfig, expectedConfig);
                    const packets = await Array.fromAsync(output.packets());
                    assert.deepEqual(
                        packets.map(packet => packet.isKeyframe),
                        format === 'mp4' ? mp4.keyframes : keyframes,
                    );
                    assert.deepEqual(
                        packets.map(packet => readNals(packet.data, (expectedConfig[4] & 3) + 1)),
                        format === 'mp4' ? mp4.nals : expectedNals,
                        `${format}: every NAL must survive with the declared length prefix`,
                    );
                } finally {
                    output.close();
                }
            }
        } finally {
            media.close();
        }
    }

    for (const width of [2, 4])
        test(`AVI avcC with ${width}-byte NAL lengths remuxes to MKV and MP4`, async () => {
            const nals = [[aud, filler(1024), idr], [predicted]];
            await verifyCopy(
                aviH264({
                    extra: avcc(width),
                    fourcc: 'avc1',
                    packets: nals.map(packet => lengthPrefixed(width, ...packet)),
                }),
                avcc(width),
                nals,
                [true, false],
            );
        });

    test('AVI avcC with one-byte lengths retains a valid non-IDR packet', async () => {
        const packet = lengthPrefixed(1, predicted);
        await verifyCopy(
            aviH264({ extra: avcc(1), packets: [packet] }),
            avcc(1),
            [[predicted]],
            [false],
        );
    });

    test('AVI Annex B strf configuration and IDR after a long filler are retained', async () => {
        const nals = [[aud, filler(5000), idr], [predicted]];
        await verifyCopy(
            aviH264({ extra: annexB(sps, pps), packets: nals.map(packet => annexB(...packet)) }),
            avcc(),
            nals,
            [true, false],
        );
    });

    test('AVI in-band SPS/PPS derive the actual profile and keyframes', async () => {
        const nals = [[sps, pps, aud, filler(5000), idr], [predicted]];
        await verifyCopy(
            aviH264({ extra: new Uint8Array(0), packets: nals.map(packet => annexB(...packet)) }),
            avcc(),
            nals,
            [true, false],
        );
    });

    test('AVI H.264 inspection uses bounded source reads for a large Annex B packet', async () => {
        const input = aviH264({
            extra: annexB(sps, pps),
            packets: [annexB(filler(3 * 1024 * 1024), idr)],
        });
        let largestRead = 0;
        const source = {
            size: input.length,
            async read(offset, size) {
                largestRead = Math.max(largestRead, size);
                return input.slice(offset, offset + size);
            },
        };
        const result = await new AviDemuxer().demux(source);
        assert.equal(result.videoTracks[0].samples[0].isKeyframe, true);
        assert.equal(result.videoTracks[0].samples[0].data, undefined);
        assert(largestRead <= 1024 * 1024);
    });

    test(
        'AVI Annex B is not misread when its bytes also form a valid length-prefixed ' + 'packet',
        async () => {
            const sei = join([6, 5, 255, 3], new Uint8Array(258).fill(0x55), [0x80]);
            await verifyCopy(
                aviH264({ extra: annexB(sps, pps), packets: [join([0, 0, 1], sei), annexB(idr)] }),
                avcc(),
                [[sei], [idr]],
                [false, true],
                { nals: [[sei, idr]], keyframes: [true] },
            );
        },
    );

    test('AVI length-prefixed NAL size 262 is not mistaken for an Annex B start code', async () => {
        const data = filler(262);
        await verifyCopy(
            aviH264({ extra: avcc(), packets: [lengthPrefixed(4, data), lengthPrefixed(4, idr)] }),
            avcc(),
            [[data], [idr]],
            [false, true],
            { nals: [[data, idr]], keyframes: [true] },
        );
    });

    test('AVI NAL conversion enforces the packet budget after adding length prefixes', async () => {
        const packet = annexB(aud, idr);
        const media = await open(aviH264({ extra: annexB(sps, pps), packets: [packet] }), {
            maxPacketBytes: packet.length,
        });
        try {
            const check = await media.check('mkv', { copy: true });
            assert.equal(check.supported, false);
            assert.equal(check.code, 'OOM');
            await assert.rejects(media.convert('mkv', { copy: true }), {
                code: 'OOM',
                message: check.reason,
            });
        } finally {
            media.close();
        }
    });

    test(
        'AVI empty dropped-frame chunks extend presentation without creating empty ' + 'packets',
        async () => {
            const bytes = aviH264({
                packets: [lengthPrefixed(4, idr), new Uint8Array(0), lengthPrefixed(4, predicted)],
            });
            const result = await new AviDemuxer().demux(new Blob([bytes]));
            assert.deepEqual(
                result.videoTracks[0].samples.map(sample => [sample.timestamp, sample.duration]),
                [
                    [0, 0.08],
                    [0.08, 0.04],
                ],
            );
            await verifyCopy(bytes, avcc(), [[idr], [predicted]], [true, false]);
        },
    );

    test('conversion copies the same AVI framing without dropping a NAL header', async () => {
        const sei = join([6, 5, 255, 3], new Uint8Array(258).fill(0x55), [0x80]);
        const input = new Blob([
            aviH264({ extra: annexB(sps, pps), packets: [join([0, 0, 1], sei), annexB(idr)] }),
        ]);
        for (const outputFormat of ['mkv', 'mp4']) {
            const { blob: output } = await convert(input, outputFormat);
            const media = await open(output);
            try {
                const packets = await Array.fromAsync(media.packets());
                assert.deepEqual(
                    packets.map(packet => readNals(packet.data, 4)),
                    outputFormat === 'mp4' ? [[sei, idr]] : [[sei], [idr]],
                );
            } finally {
                media.close();
            }
        }
    });

    for (const [name, extra, packet] of [
        ['truncated avcC', avcc().subarray(0, 9), lengthPrefixed(4, idr)],
        ['zero-length NAL', avcc(), Uint8Array.of(0, 0, 0, 0)],
        ['oversized NAL length', avcc(), Uint8Array.of(0, 0, 1, 0, 0x65)],
        ['forbidden NAL header', avcc(), Uint8Array.of(0, 0, 0, 2, 0xe5, 0x80)],
    ])
        test(`AVI H.264 rejects ${name}`, async () => {
            await assert.rejects(
                new AviDemuxer().demux(new Blob([aviH264({ extra, packets: [packet] })])),
                {
                    name: 'DemuxError',
                },
            );
        });

    const recovery = { recovery: 'complete-packets' };
    const sha256 = data => createHash('sha256').update(data).digest('hex');
    const flattenChunks = chunks =>
        chunks.flatMap(chunk => [chunk, ...flattenChunks(chunk.children)]);
    const sourceFixture = async name =>
        new Uint8Array(
            await readFile(new URL(`../fixtures/avi-h264/${name}.avi`, import.meta.url)),
        );

    test(
        'AVI recovery retains every complete no-reorder packet at chunk, payload, and ' +
            'odd-padding cuts',
        async () => {
            const bytes = await sourceFixture('no-b');
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            const oracle = x264Oracle.fixtures['no-b'];
            for (const chunk of chunks) {
                const cuts = new Set([
                    chunk.offset,
                    chunk.offset + 1,
                    chunk.offset + 7,
                    chunk.data,
                    chunk.end - 1,
                    chunk.end,
                    chunk.next,
                ]);
                for (const cut of cuts) {
                    const input = bytes.subarray(0, cut);
                    const expected = chunks.filter(chunk => chunk.end <= cut);
                    if (!expected.length) {
                        await assert.rejects(new AviDemuxer(recovery).demux(new Blob([input])), {
                            code: 'DEMUX',
                        });
                        continue;
                    }
                    const warnings = [];
                    const {
                        videoTracks: [track],
                    } = await new AviDemuxer({
                        ...recovery,
                        onWarning: warning => warnings.push(warning),
                    }).demux(new Blob([input]));
                    assert.equal(track.incomplete, true, `cut ${cut}`);
                    assert(
                        warnings.some(warning => warning.code.startsWith('AVI_TRUNCATED_')),
                        `cut ${cut}`,
                    );
                    assert.deepEqual(
                        track.samples.map(sample => [sample.offset, sample.size]),
                        expected.map(chunk => [chunk.data, chunk.size]),
                        `cut ${cut}`,
                    );
                    assert.deepEqual(
                        track.samples.map(sample => Math.round(sample.timestamp * 25)),
                        oracle.presentationTicks.slice(0, expected.length),
                        `cut ${cut}`,
                    );
                    assert.deepEqual(
                        track.samples.map(sample => Math.round(sample.decodeTimestamp * 25)),
                        Array.from({ length: expected.length }, (_, index) => index),
                        `cut ${cut}`,
                    );
                    assert.equal(Math.round(track.duration * 25), expected.length, `cut ${cut}`);
                }
            }
        },
    );

    test(
        'AVI recovery is the compatible default and strict validation rejects physical ' +
            'truncation',
        async () => {
            const bytes = await sourceFixture('no-b');
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            const input = bytes.subarray(0, chunks[5].end);
            await assert.rejects(new AviDemuxer().demux(new Blob([input])), { code: 'DEMUX' });
            for (const options of [
                { validation: 'strict' },
                { ...recovery, validation: 'strict' },
            ]) {
                await assert.rejects(new AviDemuxer(options).demux(new Blob([input])), {
                    code: 'DEMUX',
                });
                await assert.rejects(open(input, options), { code: 'DEMUX' });
            }
            const {
                videoTracks: [track],
            } = await new AviDemuxer({ validation: 'compatible' }).demux(new Blob([input]));
            assert.equal(track.samples.length, 6);
            const warnings = [];
            const media = await open(input, { onWarning: warning => warnings.push(warning) });
            try {
                assert.equal(media.tracks[0].incomplete, true);
                assert(warnings.length > 0);
                assert.deepEqual(media.warnings, warnings);
                for (const format of ['mp4', 'mkv']) {
                    assert.equal((await media.check(format, { copy: true })).supported, true);
                    const output = await open((await media.convert(format, { copy: true })).blob);
                    try {
                        const packets = await Array.fromAsync(output.packets());
                        assert.deepEqual(
                            packets.map(packet => sha256(packet.data)),
                            x264Oracle.fixtures['no-b'].packetNalsSha256.slice(0, 6),
                        );
                        assert.deepEqual(
                            packets.map(packet => Math.round(packet.timestamp * 25)),
                            [0, 1, 2, 3, 4, 5],
                        );
                    } finally {
                        output.close();
                    }
                }
            } finally {
                media.close();
            }
        },
    );

    test(
        'AVI recovery discards an unresolved final B-frame GOP without moving earlier ' + 'PTS',
        async () => {
            const bytes = await sourceFixture('closed-gop');
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            const warnings = [];
            const media = await open(bytes.subarray(0, chunks[30].end - 1), {
                ...recovery,
                onWarning: warning => warnings.push(warning),
            });
            try {
                const packets = await Array.fromAsync(media.packets());
                assert.equal(packets.length, 25);
                assert.deepEqual(
                    packets.map(packet => sha256(packet.data)),
                    x264Oracle.fixtures['closed-gop'].packetNalsSha256.slice(0, 25),
                );
                assert.deepEqual(
                    packets.map(packet => Math.round(packet.timestamp * 25)),
                    x264Oracle.fixtures['closed-gop'].presentationTicks.slice(0, 25),
                );
                assert(warnings.some(warning => warning.code === 'AVI_UNRESOLVED_TIMING'));
                for (const format of ['mp4', 'mkv']) {
                    assert.equal((await media.check(format, { copy: true })).supported, true);
                    const output = await open((await media.convert(format, { copy: true })).blob);
                    try {
                        const copied = await Array.fromAsync(output.packets());
                        assert.deepEqual(
                            copied.map(packet => sha256(packet.data)),
                            x264Oracle.fixtures['closed-gop'].packetNalsSha256.slice(0, 25),
                        );
                        assert.deepEqual(
                            copied.map(packet => Math.round(packet.timestamp * 25)),
                            x264Oracle.fixtures['closed-gop'].presentationTicks.slice(0, 25),
                        );
                    } finally {
                        output.close();
                    }
                }
            } finally {
                media.close();
            }
            await assert.rejects(
                new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, chunks[2].end)])),
                {
                    code: 'DEMUX',
                },
            );
        },
    );

    test(
        'AVI recovery cannot assign timing to a truncated open GOP with no complete ' +
            'IDR-delimited group',
        async () => {
            const bytes = await sourceFixture('open-gop');
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            await assert.rejects(
                new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, chunks[70].end)])),
                {
                    code: 'DEMUX',
                },
            );
        },
    );

    test('AVI recovery retains all B-frame packets when only the index tail is cut', async () => {
        const bytes = await sourceFixture('open-gop');
        const index = flattenChunks(aviChunks(bytes)).find(chunk => chunk.id === 'idx1');
        for (const cut of [index.offset, index.offset + 3, index.data, bytes.length - 1]) {
            const {
                videoTracks: [track],
            } = await new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, cut)]));
            assert.equal(track.incomplete, true);
            assert.deepEqual(
                track.samples.map(sample => Math.round(sample.timestamp * 25)),
                x264Oracle.fixtures['open-gop'].presentationTicks,
            );
        }
    });

    test(
        'AVI recovery traverses truncated nested record lists using declared chunk ' + 'boundaries',
        async () => {
            const bytes = aviRecordLists(await sourceFixture('no-b'));
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            const {
                videoTracks: [track],
            } = await new AviDemuxer(recovery).demux(
                new Blob([bytes.subarray(0, chunks[5].data + 1)]),
            );
            assert.equal(track.incomplete, true);
            assert.deepEqual(
                track.samples.map(sample => [sample.offset, sample.size]),
                chunks.slice(0, 5).map(chunk => [chunk.data, chunk.size]),
            );
        },
    );

    test('AVI recovery rejects truncated stream headers and codec configuration', async () => {
        const bytes = await sourceFixture('no-b');
        const chunks = flattenChunks(aviChunks(bytes));
        for (const cut of [0, 4, 11, 12, 13, 19, 20, 21, 22, 23, 24])
            await assert.rejects(
                new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, cut)])),
                {
                    code: 'DEMUX',
                },
            );
        for (const chunk of chunks.filter(chunk => ['strh', 'strf'].includes(chunk.id))) {
            for (const cut of [chunk.offset + 5, chunk.data, chunk.end - 1])
                await assert.rejects(
                    new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, cut)])),
                    { code: 'DEMUX' },
                );
        }
        const input = aviH264({
            extra: new Uint8Array(0),
            packets: [annexB(sps), annexB(pps, idr)],
        });
        const packets = flattenChunks(aviChunks(input)).filter(chunk => chunk.id === '00dc');
        await assert.rejects(
            new AviDemuxer(recovery).demux(new Blob([input.subarray(0, packets[1].end - 1)])),
            {
                code: 'DEMUX',
            },
        );
        await assert.rejects(
            new AviDemuxer(recovery).demux(new Blob([aviH264({ extra: avcc().subarray(0, 9) })])),
            {
                code: 'DEMUX',
            },
        );
    });

    test(
        'AVI strict validation rejects a child crossing its declared parent; compatible reading ' +
            'skips it',
        async () => {
            const bytes = await sourceFixture('no-b');
            const chunks = flattenChunks(aviChunks(bytes));
            const movie = chunks.find(chunk => chunk.type === 'movi');
            const packets = chunks.filter(chunk => chunk.id === '00dc');
            const last = packets.at(-1);
            new DataView(bytes.buffer).setUint32(last.offset + 4, movie.end - last.data + 16, true);
            await assert.rejects(
                new AviDemuxer({ validation: 'strict' }).demux(new Blob([bytes])),
                {
                    code: 'DEMUX',
                },
            );
            const warnings = [];
            const {
                videoTracks: [track],
            } = await new AviDemuxer({
                ...recovery,
                onWarning: warning => warnings.push(warning.code),
            }).demux(new Blob([bytes]));
            assert.deepEqual(
                track.samples.map(sample => [sample.offset, sample.size]),
                packets.slice(0, -1).map(chunk => [chunk.data, chunk.size]),
            );
            assert(warnings.includes('AVI_RESYNCHRONIZED'), warnings.join());
        },
    );

    test('AVI recovery never scans an incomplete payload for apparent packet headers', async () => {
        const bytes = await sourceFixture('no-b');
        const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
        const incomplete = chunks[16];
        const falsePacket = bytes.subarray(chunks[1].offset, chunks[1].next);
        const input = join(bytes.subarray(0, incomplete.data + 12), falsePacket);
        assert(input.length < incomplete.end);
        const {
            videoTracks: [track],
        } = await new AviDemuxer(recovery).demux(new Blob([input]));
        assert.deepEqual(
            track.samples.map(sample => [sample.offset, sample.size]),
            chunks.slice(0, 16).map(chunk => [chunk.data, chunk.size]),
        );
    });

    test(
        'AVI recovery does not treat absence of observed B pictures as proof of no ' + 'reordering',
        async () => {
            const fixture = reorderFixture();
            const bytes = fixture.avi([
                { type: 'IDR' },
                { frameNum: 1, poc: 6 },
                { type: 'B', frameNum: 2, poc: 2 },
            ]);
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            await assert.rejects(
                new AviDemuxer(recovery).demux(new Blob([bytes.subarray(0, chunks[1].end)])),
                {
                    code: 'DEMUX',
                },
            );
        },
    );

    test(
        'AVI damaged NAL framing inside a complete packet is rejected strictly and dropped ' +
            'compatibly',
        async () => {
            const bytes = aviH264({
                packets: [lengthPrefixed(4, idr), Uint8Array.of(0, 0, 1, 0, 0x41)],
            });
            await assert.rejects(new AviDemuxer().demux(new Blob([bytes])), { code: 'DEMUX' });
            const warnings = [];
            const {
                videoTracks: [track],
            } = await new AviDemuxer({
                ...recovery,
                onWarning: warning => warnings.push(warning.code),
            }).demux(new Blob([bytes]));
            assert.equal(track.samples.length, 1);
            assert.deepEqual(warnings, ['AVI_PACKET_DAMAGED']);
        },
    );

    test('AVI recovery leaves complete inputs complete and respects onWarning', async () => {
        const bytes = await sourceFixture('no-b');
        const warnings = [];
        const {
            videoTracks: [complete],
        } = await new AviDemuxer({
            ...recovery,
            onWarning: warning => warnings.push(warning),
        }).demux(new Blob([bytes]));
        assert.equal(complete.incomplete, undefined);
        assert.equal(warnings.length, 0);
        const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
        const {
            videoTracks: [partial],
        } = await new AviDemuxer({
            ...recovery,
            maxWarnings: 0,
            onWarning: warning => warnings.push(warning),
        }).demux(new Blob([bytes.subarray(0, chunks[5].end)]));
        assert.equal(partial.incomplete, true);
        assert.equal(warnings.length, 0);
    });

    test(
        'AVI recovery retains complete packets across truncated AVIX headers and movie ' + 'lists',
        async () => {
            const bytes = aviAvix(await sourceFixture('no-b'), 10);
            const [, extension] = aviChunks(bytes);
            const chunks = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc');
            for (const cut of [
                extension.offset,
                extension.offset + 4,
                extension.offset + 11,
                extension.data + 4,
                extension.children[0].data + 2,
                chunks[17].end - 1,
            ]) {
                const warnings = [];
                const {
                    videoTracks: [track],
                } = await new AviDemuxer({
                    ...recovery,
                    onWarning: warning => warnings.push(warning),
                }).demux(new Blob([bytes.subarray(0, cut)]));
                const expected = chunks.filter(chunk => chunk.end <= cut);
                assert.equal(track.incomplete, true, `cut ${cut}`);
                assert(warnings.length > 0, `cut ${cut}`);
                assert.deepEqual(
                    track.samples.map(sample => [sample.offset, sample.size]),
                    expected.map(chunk => [chunk.data, chunk.size]),
                );
            }
        },
    );

    test(
        'AVI recovery validates and snapshots its public option before reading the ' + 'input',
        async () => {
            const bytes = await sourceFixture('no-b');
            const chunk = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc')[5];
            const input = bytes.subarray(0, chunk.end);
            for (const value of [null, true, 'compatible', 1]) {
                assert.throws(() => new AviDemuxer({ recovery: value }), { code: 'INPUT' });
                if (value === null) {
                    await assert.rejects(open(input, { recovery: value, validation: 'strict' }), {
                        code: 'DEMUX',
                    });
                    const media = await open(input, { recovery: value });
                    assert.equal(
                        media.tracks[0].incomplete,
                        true,
                        'compatible reading recovers without the option',
                    );
                    media.close();
                    continue;
                }
                await assert.rejects(open(input, { recovery: value, validation: 'strict' }), {
                    code: 'INPUT',
                });
                const codes = [];
                const media = await open(input, {
                    recovery: value,
                    onWarning: warning => codes.push(warning.code),
                });
                media.close();
                assert.equal(
                    codes[0],
                    'OPTION_IGNORED',
                    'lenient open drops the unusable option and reports it',
                );
                assert(
                    codes.slice(1).every(code => code.startsWith('AVI_TRUNCATED_')),
                    codes.join(),
                );
            }
            let reads = 0;
            const media = await open(input, {
                get recovery() {
                    reads++;
                    return reads === 1 ? 'complete-packets' : 'invalid';
                },
            });
            try {
                assert.equal(reads, 1);
                assert.equal((await Array.fromAsync(media.packets())).length, 6);
            } finally {
                media.close();
            }
        },
    );

    test('AVI recovery keeps demux budgets and cancellation active', async () => {
        const bytes = await sourceFixture('no-b');
        const chunk = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00dc')[5];
        const input = new Blob([bytes.subarray(0, chunk.end)]);
        await assert.rejects(new AviDemuxer({ ...recovery, maxSamples: 1 }).demux(input), {
            code: 'OOM',
        });
        await assert.rejects(new AviDemuxer({ ...recovery, maxIndexBytes: 1 }).demux(input), {
            code: 'OOM',
        });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(new AviDemuxer(recovery).demux(input, controller.signal), {
            code: 'ABORT',
        });
    });

    async function mpegPackets(bytes) {
        const media = await open(bytes);
        try {
            const [track] = media.tracks;
            const packets = [];
            for await (const packet of media.packets({ trackIds: [track.id] }))
                packets.push(packet);
            return { media, track, packets };
        } finally {
            media.close();
        }
    }
    const seconds = values => values.map(value => Math.round(value * 1000) / 1000);

    const mpeg4Avi = aviH264({
        fourcc: 'XVID',
        extra: mpeg4Config(),
        packets: [PICTURE_I, PICTURE_P, PICTURE_B, PICTURE_B, PICTURE_P].map(type =>
            mpeg4Vop(type),
        ),
    });

    test(
        'AVI MPEG-4 Part 2 presents B-VOPs from decode-order slots and copies to every MPEG ' +
            'video container',
        async () => {
            const { track, packets } = await mpegPackets(mpeg4Avi);
            assert.equal(
                (await new AviDemuxer().demux(new Blob([mpeg4Avi]))).videoTracks[0].codecTag,
                'XVID',
            );
            const vops = [PICTURE_I, PICTURE_P, PICTURE_B, PICTURE_B, PICTURE_P].map(type =>
                mpeg4Vop(type),
            );
            assert.equal(track.codec, 'mp4v.20.1');
            assert.deepEqual(track.codecConfig, mpeg4Config());
            assert.deepEqual(
                packets.map(packet => packet.data),
                vops,
            );
            assert.deepEqual(
                seconds(packets.map(packet => packet.timestamp)),
                [0.04, 0.16, 0.08, 0.12, 0.2],
            );
            assert.deepEqual(
                seconds(packets.map(packet => packet.decodeTimestamp)),
                [0, 0.04, 0.08, 0.12, 0.16],
            );
            assert.deepEqual(
                packets.map(packet => packet.isKeyframe),
                [true, false, false, false, false],
            );
            for (const format of ['mp4', 'mov', 'mkv', 'ts', 'avi']) {
                const media = await open(mpeg4Avi);
                const sink = new MemorySink();
                await media.convert(format, { copy: true, sink });
                media.close();
                const copy = await mpegPackets(sink.toUint8Array());
                assert.equal(copy.track.codec, 'mp4v.20.1', format);
                if (format === 'mp4')
                    assert.equal(
                        (await new Mp4Demuxer().demux(new Blob([sink.toUint8Array()])))
                            .videoTracks[0].codecTag,
                        'mp4v',
                    );
                assert.deepEqual(copy.track.codecConfig, mpeg4Config(), `${format} configuration`);
                assert.deepEqual(
                    copy.packets.map(packet => packet.data),
                    format === 'ts' ? [join(mpeg4Config(), vops[0]), ...vops.slice(1)] : vops,
                    `${format} packets; TS repeats the configuration before the keyframe`,
                );
                assert.deepEqual(
                    seconds(
                        copy.packets.map(packet => packet.timestamp - copy.packets[0].timestamp),
                    ),
                    [0, 0.12, 0.04, 0.08, 0.16],
                    `${format} presentation`,
                );
            }
        },
    );

    test('AVI DivX packed B-frames are unpacked like mpeg4_unpack_bframes', async () => {
        // Packed chunks hold an anchor VOP followed by the B-VOP displayed before it; the next slot
        // holds a not-coded VOP.
        const packed = aviH264({
            fourcc: 'DX50',
            extra: join(mpeg4Config(), divxUserData(), [0]),
            packets: [
                join(divxUserData(), mpeg4Vop(PICTURE_I)),
                join(mpeg4Vop(PICTURE_P), mpeg4Vop(PICTURE_B)),
                mpeg4Vop(PICTURE_P, { coded: false }),
                join(mpeg4Vop(PICTURE_P), mpeg4Vop(PICTURE_B)),
                mpeg4Vop(PICTURE_P, { coded: false }),
            ],
        });
        const { track, packets } = await mpegPackets(packed);
        const unpackedUserData = divxUserData(false);
        assert.deepEqual(
            track.codecConfig,
            join(mpeg4Config(), unpackedUserData, [0, 0]),
            "the 'p' marker is cleared",
        );
        assert.deepEqual(
            packets.map(packet => packet.data),
            [
                join(unpackedUserData, [0], mpeg4Vop(PICTURE_I)),
                mpeg4Vop(PICTURE_P),
                mpeg4Vop(PICTURE_B),
                mpeg4Vop(PICTURE_P),
                mpeg4Vop(PICTURE_B),
            ],
        );
        assert.deepEqual(
            seconds(packets.map(packet => packet.timestamp)),
            [0.04, 0.12, 0.08, 0.2, 0.16],
        );
    });

    test('AVI MPEG-4 dropped frames keep their slots through an AVI copy', async () => {
        const bytes = aviH264({
            fourcc: 'XVID',
            extra: mpeg4Config(),
            packets: [
                mpeg4Vop(PICTURE_I),
                new Uint8Array(0),
                new Uint8Array(0),
                mpeg4Vop(PICTURE_P),
                mpeg4Vop(PICTURE_P),
            ],
        });
        const { packets } = await mpegPackets(bytes);
        assert.deepEqual(seconds(packets.map(packet => packet.timestamp)), [0, 0.12, 0.16]);
        const media = await open(bytes);
        const sink = new MemorySink();
        await media.convert('avi', { copy: true, sink });
        media.close();
        const output = sink.toUint8Array();
        const movie = aviChunks(output)[0].children.find(chunk => chunk.type === 'movi');
        assert.deepEqual(
            movie.children.map(chunk => chunk.size),
            packets.flatMap((packet, index) =>
                index === 1 ? [0, 0, packet.data.length] : [packet.data.length],
            ),
            'empty chunks hold the dropped slots',
        );
        const copy = await mpegPackets(output);
        assert.deepEqual(seconds(copy.packets.map(packet => packet.timestamp)), [0, 0.12, 0.16]);
    });

    test('AVI MPEG-2 without extradata is configured by its sequence header', async () => {
        const units = mpeg2Gop();
        const { track, packets } = await mpegPackets(
            aviH264({
                fourcc: 'MPG2',
                extra: new Uint8Array(0),
                packets: units.map(unit => unit.data),
            }),
        );
        assert.equal(track.codec, 'mp4v.61');
        assert.deepEqual(track.codecConfig, mpegSequence({ profile: 0x48 }));
        assert.deepEqual(
            packets.map(packet => packet.data),
            units.map(unit => unit.data),
        );
        assert.deepEqual(
            seconds(packets.map(packet => packet.timestamp)),
            units.map(unit => Math.round((unit.pts - units[0].pts + 3600) / 90) / 1000),
        );
    });

    test('AVI Microsoft MPEG-4 v1-v3 keeps its own codec, not MPEG-4 Part 2', async () => {
        for (const [fourcc, codec] of [
            ['DIV3', 'msmpeg4v3'],
            ['MP42', 'msmpeg4v2'],
            ['MP41', 'msmpeg4v1'],
        ]) {
            const packet = mpeg4Vop(PICTURE_I);
            const {
                videoTracks: [track],
            } = await new AviDemuxer().demux(
                new Blob([aviH264({ fourcc, extra: new Uint8Array(0), packets: [packet] })]),
            );
            assert.equal(track.codec, codec);
            assert.equal(track.samples.length, 1);
            assert.equal(track.samples[0].size, packet.length);
        }
    });

    for (const [fourcc, intra, inter] of [
        ['DIV3', [0x05, 0x80, 0x10], [0x40, 0x80, 0x10]],
        ['MPG4', [0, 0, 1, 0, 0x08, 0x40], [0, 0, 1, 0, 0x0a, 0x40]],
    ])
        test(`AVI Microsoft MPEG-4 (${fourcc}) intra pictures are keyframes`, async () => {
            // The picture header's first two bits, after v1's start code and frame number, code
            // the picture type.
            const packets = await allPackets(
                aviH264({
                    fourcc,
                    extra: new Uint8Array(0),
                    packets: [Uint8Array.from(intra), Uint8Array.from(inter)],
                }),
            );
            assert.deepEqual(
                packets.map(packet => packet.isKeyframe),
                [true, false],
            );
        });

    test('AVI copies the parameter sets of an avc3 track in band', async () => {
        // An avc3 record may leave every parameter set to the samples.
        const inBand = Uint8Array.of(1, 66, 0, 10, 0xff, 0xe0, 0);
        const sink = new MemorySink();
        const video = {
            id: 1,
            type: 'video',
            codec: 'avc3.42000a',
            width: 32,
            height: 16,
            codecConfig: inBand,
        };
        const muxer = new AviMuxer({ format: 'avi', video }, sink);
        [lengthPrefixed(4, sps, pps, idr), lengthPrefixed(4, predicted)].forEach((data, index) =>
            muxer.addVideoChunk(
                {
                    trackType: 'video',
                    data,
                    timestamp: index * 0.04,
                    duration: 0.04,
                    isKeyframe: index === 0,
                },
                inBand,
            ),
        );
        await muxer.finalize();
        const output = sink.toUint8Array();
        assert.equal((await allPackets(output)).length, 2);
        assert.ok(Buffer.from(output).includes(Buffer.from(join([0, 0, 1], sps))));
    });

    test('AVI MPEG-4 video opens with an unsupported audio stream omitted', async () => {
        const bytes = aviH264({
            fourcc: 'XVID',
            extra: mpeg4Config(),
            packets: [mpeg4Vop(PICTURE_I)],
            audioFormat: 0x2,
        });
        const warnings = [];
        const media = await open(bytes, { onWarning: warning => warnings.push(warning.code) });
        try {
            assert.deepEqual(
                media.tracks.map(track => track.codec),
                ['mp4v.20.1'],
            );
            assert.deepEqual(warnings, ['AVI_UNSUPPORTED_STREAM']);
        } finally {
            media.close();
        }
    });

    test('AVI empty audio chunks carry no packet and no time', async () => {
        const mp3 = await encodeMp3([new Float32Array(1152 * 2)], {
            sampleRate: 44100,
            bitrate: 64,
        });
        const first = parseMp3FrameHeader(mp3, 0).frameLength;
        const second = parseMp3FrameHeader(mp3, first).frameLength;
        const frame = length => new Uint8Array(length).fill(0x55);
        for (const [audioFormat, audioSampleSize, chunks] of [
            [0x55, 0, [mp3.subarray(0, first), frame(0), mp3.subarray(first, first + second)]],
            [1, 1, [frame(8), frame(0), frame(8)]],
        ]) {
            const bytes = aviH264({
                fourcc: 'XVID',
                extra: mpeg4Config(),
                packets: [mpeg4Vop(PICTURE_I)],
                audioFormat,
                audioSampleSize,
                audioChunks: chunks,
            });
            const {
                audioTracks: [track],
            } = await new AviDemuxer().demux(new Blob([bytes]));
            assert.deepEqual(
                track.samples.map(sample => sample.size),
                chunks.filter(chunk => chunk.length).map(chunk => chunk.length),
                `format ${audioFormat}`,
            );
            assert.equal(
                track.samples[1].timestamp,
                track.samples[0].timestamp + track.samples[0].duration,
            );
        }
    });

    test(
        'AVI PCM chunks cut inside a channel frame keep their whole frames; strict validation ' +
            'rejects them',
        async () => {
            // 16-bit stereo: four-byte channel frames; the middle chunk ends three bytes into a
            // frame.
            const frame = length => new Uint8Array(length).fill(0x11);
            const bytes = aviH264({
                fourcc: 'XVID',
                extra: mpeg4Config(),
                packets: [mpeg4Vop(PICTURE_I)],
                audioFormat: 1,
                audioSampleSize: 4,
                audioBlockAlign: 4,
                audioChannels: 2,
                audioBits: 16,
                audioChunks: [frame(8), frame(11), frame(8)],
            });
            const warnings = [];
            const media = await open(bytes, { onWarning: warning => warnings.push(warning.code) });
            try {
                const audio = media.tracks.find(track => track.type === 'audio');
                const sizes = [];
                for await (const packet of media.packets({ trackIds: [audio.id] }))
                    sizes.push(packet.data.length);
                assert.deepEqual(sizes, [8, 8, 8]);
                assert.deepEqual(warnings, ['AVI_PARTIAL_FRAME']);
            } finally {
                media.close();
            }
            await assert.rejects(
                open(bytes, { validation: 'strict' }),
                error => error.code === 'DEMUX',
            );
        },
    );

    test('AVI MPEG audio cut at any chunk sizes is reassembled into whole frames', async () => {
        const pcm = Float32Array.from({ length: 1152 * 6 }, (_, index) => Math.sin(index / 7) / 4);
        const stream = await encodeMp3([pcm], { sampleRate: 44100, bitrate: 64 });
        const frames = [];
        for (let at = 0; at < stream.length;) {
            const header = parseMp3FrameHeader(stream, at);
            assert(
                header && header.frameLength <= stream.length - at,
                'the encoder wrote whole frames',
            );
            frames.push(stream.subarray(at, at + header.frameLength));
            at += header.frameLength;
        }
        assert(frames.length >= 6);
        const cuts = [frames[0].length + 3, 1, 100, 100, 7, stream.length];
        const chunks = [];
        for (let at = 0; at < stream.length;) {
            const size = Math.min(cuts[chunks.length] ?? 100, stream.length - at);
            chunks.push(stream.subarray(at, at + size));
            at += size;
        }
        const bytes = aviH264({
            fourcc: 'XVID',
            extra: mpeg4Config(),
            packets: [mpeg4Vop(PICTURE_I)],
            audioFormat: 0x55,
            audioSampleSize: 1,
            audioChunks: chunks,
        });
        const media = await open(bytes);
        try {
            const track = media.tracks.find(candidate => candidate.type === 'audio');
            assert.equal(track.codec, 'mp3');
            assert.equal(track.sampleRate, 44100);
            const packets = await packetsOf(media, track.id);
            assert.equal(packets.length, frames.length);
            for (const [index, frame] of frames.entries()) {
                const packet = packets[index];
                assert.deepEqual(packet.data, frame, `frame ${index}`);
                assert.ok(
                    Math.abs(packet.timestamp - (index * 1152) / 44100) < 1e-9,
                    `frame ${index} time`,
                );
            }
        } finally {
            media.close();
        }
    });

    /**
     * A RIFF AVI of `streams` ({ type, handler, scale, rate, sampleSize, format }) and raw movi
     * bytes.
     */
    function aviStreams({ streams, movi, form = 'AVI ', frameMicroseconds = 40000 }) {
        const main = new Uint8Array(56);
        new DataView(main.buffer).setUint32(0, frameMicroseconds, true);
        new DataView(main.buffer).setUint32(24, streams.length, true);
        const headers = streams.map(stream => {
            const header = new Uint8Array(56);
            const view = new DataView(header.buffer);
            header.set(text(stream.type), 0);
            header.set(text(stream.handler ?? '\0\0\0\0'), 4);
            view.setUint32(20, stream.scale ?? 1, true);
            view.setUint32(24, stream.rate ?? 25, true);
            view.setUint32(44, stream.sampleSize ?? 0, true);
            return list('strl', chunk('strh', header), chunk('strf', stream.format));
        });
        const body = join(
            text(form),
            list('hdrl', chunk('avih', main), ...headers),
            chunk('LIST', join(text('movi'), movi)),
        );
        return chunk('RIFF', body);
    }

    /**
     * WAVEFORMATEX with `tag`, `channels`, `rate`, `blockAlign` and `bits`, optionally followed by
     * `extension`.
     */
    function waveFormat(tag, channels, rate, blockAlign, bits, extension) {
        const format = new Uint8Array(extension ? 18 + extension.length : 16);
        const view = new DataView(format.buffer);
        view.setUint16(0, tag, true);
        view.setUint16(2, channels, true);
        view.setUint32(4, rate, true);
        view.setUint32(8, rate * blockAlign, true);
        view.setUint16(12, blockAlign, true);
        view.setUint16(14, bits, true);
        if (extension) {
            view.setUint16(16, extension.length, true);
            format.set(extension, 18);
        }
        return format;
    }

    const pcmU8 = { type: 'auds', rate: 8000, sampleSize: 1, format: waveFormat(1, 1, 8000, 1, 8) };
    const pcmPayload = (value, length = 8) => new Uint8Array(length).fill(value);

    test(
        'AVI reads every audio stream, including an extensible one with unspecified valid ' +
            'bits',
        async () => {
            const guid = [0x01, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
            const extensible = waveFormat(0xfffe, 1, 8000, 2, 16, [0, 0, 4, 0, 0, 0, ...guid]);
            const bytes = aviStreams({
                streams: [pcmU8, { type: 'auds', rate: 8000, sampleSize: 2, format: extensible }],
                movi: join(
                    chunk('00wb', pcmPayload(1)),
                    chunk('01wb', pcmPayload(2)),
                    chunk('00wb', pcmPayload(3)),
                    chunk('01wb', pcmPayload(4)),
                ),
            });
            const media = await open(bytes);
            try {
                assert.deepEqual(
                    (await inspect(bytes)).tracks.map(track => [
                        track.type,
                        track.codec,
                        track.sampleCount,
                    ]),
                    [
                        ['audio', 'pcm-u8', 2],
                        ['audio', 'pcm-s16le', 2],
                    ],
                );
                const second = await Array.fromAsync(
                    media.packets({ trackIds: [media.tracks[1].id] }),
                );
                assert.deepEqual(
                    second.map(packet => [packet.data[0], packet.timestamp]),
                    [
                        [2, 0],
                        [4, 0.0005],
                    ],
                );
            } finally {
                media.close();
            }
        },
    );

    test(
        'AVI compatible reading resynchronizes after a damaged chunk header; strict validation ' +
            'rejects it',
        async () => {
            const movi = join(
                chunk('00wb', pcmPayload(1)),
                chunk('00wb', pcmPayload(0x7f)),
                chunk('00wb', pcmPayload(3)),
            );
            const bytes = aviStreams({ streams: [pcmU8], movi });
            const damaged = bytes.slice();
            const second = flattenChunks(aviChunks(bytes)).filter(chunk => chunk.id === '00wb')[1];
            damaged.fill(0, second.offset, second.offset + 8);
            await assert.rejects(open(damaged, { validation: 'strict' }), { code: 'DEMUX' });
            const warnings = [];
            const media = await open(damaged, {
                onWarning: warning => warnings.push(warning.code),
            });
            try {
                const packets = await Array.fromAsync(media.packets());
                assert.deepEqual(
                    packets.map(packet => packet.data[0]),
                    [1, 3],
                );
                assert(warnings.includes('AVI_RESYNCHRONIZED'), warnings.join());
            } finally {
                media.close();
            }
        },
    );

    test('AVI compatible reading follows chunks written without odd-size padding', async () => {
        const unpadded = join(text('00wb'), [3, 0, 0, 0], pcmPayload(5, 3));
        const bytes = aviStreams({
            streams: [pcmU8],
            movi: join(unpadded, unpadded, chunk('00wb', pcmPayload(6))),
        });
        const warnings = [];
        const media = await open(bytes, { onWarning: warning => warnings.push(warning.code) });
        try {
            const packets = await Array.fromAsync(media.packets());
            assert.deepEqual(
                packets.map(packet => packet.data.length),
                [3, 3, 8],
            );
            assert.deepEqual(warnings, ['AVI_UNPADDED_CHUNK']);
        } finally {
            media.close();
        }
    });

    test('AVI video without a stream time base takes the main header frame period', async () => {
        const bitmap = new Uint8Array(40);
        const view = new DataView(bitmap.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, 16, true);
        view.setInt32(8, 16, true);
        bitmap.set(text('MJPG'), 16);
        const bytes = aviStreams({
            streams: [{ type: 'vids', handler: 'MJPG', scale: 0, rate: 0, format: bitmap }],
            movi: join(
                chunk('00dc', [0xff, 0xd8, 0xff, 0xd9]),
                chunk('00dc', [0xff, 0xd8, 0xff, 0xd9]),
            ),
            frameMicroseconds: 50000,
        });
        await assert.rejects(new AviDemuxer({ validation: 'strict' }).demux(new Blob([bytes])), {
            code: 'DEMUX',
        });
        const warnings = [];
        const {
            videoTracks: [track],
        } = await new AviDemuxer({
            validation: 'compatible',
            onWarning: warning => warnings.push(warning.code),
        }).demux(new Blob([bytes]));
        assert.deepEqual(
            track.samples.map(sample => sample.timestamp),
            [0, 0.05],
        );
        assert.deepEqual(warnings, ['AVI_INVALID_TIME_BASE']);
    });

    test("AVI files of the 'AVI\\x19' form some cameras write are detected and read", async () => {
        const bytes = aviStreams({
            streams: [pcmU8],
            movi: chunk('00wb', pcmPayload(1)),
            form: 'AVI\x19',
        });
        const media = await open(bytes);
        try {
            assert.equal(media.format, 'avi');
            assert.equal((await inspect(bytes)).tracks[0].sampleCount, 1);
        } finally {
            media.close();
        }
    });

    /**
     * An MPEG-1 Layer III frame header (128 kbit/s, 44.1 kHz, stereo) padded with zeros to its 417
     * bytes.
     */
    const mp3Frame = () => join([0xff, 0xfb, 0x90, 0x64], new Uint8Array(413));

    test(
        'AVI MPEG audio skips sync patterns of another layer before the declared Layer III ' +
            'frames',
        async () => {
            // A Layer II / 48 kHz header whose declared frame would run into the real Layer III
            // frames.
            const falseSync = join([0xff, 0xfd, 0x84, 0x00], new Uint8Array(20));
            const bytes = aviH264({
                fourcc: 'XVID',
                extra: mpeg4Config(),
                packets: [mpeg4Vop(PICTURE_I)],
                audioFormat: 0x55,
                audioSampleSize: 0,
                audioChunks: [join(falseSync, mp3Frame(), mp3Frame())],
            });
            const warnings = [];
            const media = await open(bytes, { onWarning: warning => warnings.push(warning.code) });
            try {
                const track = (await inspect(bytes)).tracks.find(
                    candidate => candidate.type === 'audio',
                );
                assert.deepEqual(
                    [track.codec, track.sampleRate, track.sampleCount],
                    ['mp3', 44100, 2],
                );
                assert(warnings.includes('AVI_AUDIO_RESYNCHRONIZED'), warnings.join());
            } finally {
                media.close();
            }
        },
    );

    test('AVI MPEG audio after skipped padding resumes at the stream byte clock', async () => {
        // A constant-rate stream (one byte per 1/8000 s unit): one second of zero padding follows
        // the first frame.
        const bytes = aviH264({
            fourcc: 'XVID',
            extra: mpeg4Config(),
            packets: [mpeg4Vop(PICTURE_I)],
            audioFormat: 0x55,
            audioSampleSize: 1,
            audioChunks: [join(mp3Frame(), new Uint8Array(8000)), mp3Frame()],
        });
        const media = await open(bytes);
        try {
            const track = media.tracks.find(candidate => candidate.type === 'audio');
            const packets = await Array.fromAsync(media.packets({ trackIds: [track.id] }));
            assert.deepEqual(
                packets.map(packet => Math.round(packet.timestamp * 1000) / 1000),
                [0, Math.round(((417 + 8000) / 8000) * 1000) / 1000],
            );
        } finally {
            media.close();
        }
    });

    test(
        'AVI VBR MPEG audio after zeroed chunks resumes at the chunk clock, as blank audio ' +
            'delays it',
        async () => {
            // DirectShow VBR: one 1152-sample frame per unit, a chunk spanning its bytes over
            // nBlockAlign (1152) units.
            const bytes = aviH264({
                fourcc: 'XVID',
                extra: mpeg4Config(),
                packets: [mpeg4Vop(PICTURE_I)],
                audioFormat: 0x55,
                audioSampleSize: 0,
                audioScale: 1152,
                audioRate: 44100,
                audioBlockAlign: 1152,
                audioChunks: [mp3Frame(), new Uint8Array(1152 * 10), mp3Frame()],
            });
            const media = await open(bytes);
            try {
                const track = media.tracks.find(candidate => candidate.type === 'audio');
                const packets = await Array.fromAsync(media.packets({ trackIds: [track.id] }));
                assert.deepEqual(
                    packets.map(packet => Math.round(packet.timestamp * 1e4) / 1e4),
                    [0, Math.round(((11 * 1152) / 44100) * 1e4) / 1e4],
                );
                // An AVI copy writes the pause back as zero bytes, which count as time again.
                const copy = await open((await media.convert({ to: 'avi' })).blob);
                try {
                    const copied = copy.tracks.find(candidate => candidate.type === 'audio');
                    const times = await Array.fromAsync(copy.packets({ trackIds: [copied.id] }));
                    assert.deepEqual(
                        times.map(packet => Math.round(packet.timestamp * 1e4) / 1e4),
                        [0, Math.round(((11 * 1152) / 44100) * 1e4) / 1e4],
                    );
                } finally {
                    copy.close();
                }
            } finally {
                media.close();
            }
        },
    );

    test(
        'AVI copies write pauses of whole frames as zero frames and leave shorter ones to later ' +
            'pauses',
        async () => {
            // MPEG-TS clocks jitter by parts of a frame; a copy adds those up and writes a pause
            // only once it is a whole frame. A long pause (an FLV whose sound stops for half a
            // minute) takes several chunks of zero frames.
            const frame = 1152 / 44100;
            const sink = new MemorySink();
            const muxer = new AviMuxer(
                { format: 'avi', audio: { codec: 'mp3', sampleRate: 44100, channelCount: 2 } },
                sink,
            );
            for (const start of [0, 1 + 2 / 3, 2 + 2 / 3, 6 + 2 / 3, 1006 + 2 / 3])
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: mp3Frame(),
                    timestamp: start * frame,
                    duration: frame,
                    isKeyframe: true,
                });
            await muxer.finalize();
            const media = await open(sink.toUint8Array());
            try {
                const track = media.tracks.find(candidate => candidate.type === 'audio');
                const packets = await Array.fromAsync(media.packets({ trackIds: [track.id] }));
                assert.deepEqual(
                    packets.map(packet => Math.round(packet.timestamp / frame)),
                    [0, 1, 2, 6, 1006],
                );
            } finally {
                media.close();
            }
        },
    );

    test('AVI AAC under a VfW format tag reads its ADTS frames as raw access units', async () => {
        const frames = AAC_PAYLOADS.slice(0, 2).map(payload => adtsFrame(payload));
        const bytes = aviH264({
            fourcc: 'XVID',
            extra: mpeg4Config(),
            packets: [mpeg4Vop(PICTURE_I)],
            audioFormat: 0x706d,
            audioSampleSize: 0,
            audioChunks: [join(...frames)],
        });
        const media = await open(bytes);
        try {
            const track = media.tracks.find(candidate => candidate.type === 'audio');
            assert.deepEqual(
                [track.codec, track.sampleRate, track.channelCount],
                ['mp4a.40.2', 48000, 1],
            );
            const packets = await Array.fromAsync(media.packets({ trackIds: [track.id] }));
            assert.deepEqual(
                packets.map(packet => [...packet.data]),
                AAC_PAYLOADS.slice(0, 2).map(payload => [...payload]),
            );
        } finally {
            media.close();
        }
    });

    test('AVI 8-bit palette pictures carry their palette as their configuration', async () => {
        const palette = Uint8Array.of(0, 0, 255, 0, 0, 255, 0, 0);
        const bitmap = new Uint8Array(40);
        const view = new DataView(bitmap.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, 2, true);
        view.setInt32(8, 1, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 8, true);
        view.setUint32(32, 2, true);
        const bytes = aviStreams({
            streams: [{ type: 'vids', format: join(bitmap, palette) }],
            movi: chunk('00dc', [1, 0, 0, 0]),
        });
        const {
            videoTracks: [track],
        } = await new AviDemuxer().demux(new Blob([bytes]));
        assert.equal(track.codec, 'raw.PAL8.flip');
        assert.deepEqual(track.codecConfig, palette);
    });

    /** `bytes` with every `from` (latin1) replaced by `to`. */
    const replaced = (bytes, from, to) => {
        const copy = bytes.slice();
        const pattern = Buffer.from(from, 'latin1');
        for (let index = 0; (index = Buffer.from(copy).indexOf(pattern, index)) >= 0; index++)
            copy.set(Buffer.from(to, 'latin1'), index);
        return copy;
    };

    test('takes the INFO title and flags every Motion JPEG picture a keyframe', async () => {
        const { title, tracks } = await readMedia(differentialFixtures['avi-mjpeg.avi']());
        assert.equal(title, 'Motion');
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.isKeyframe),
            [true, true, true],
        );
    });

    test('omits a stream of an unsupported codec next to a readable one', async () => {
        const source = differentialFixtures['avi-mjpeg-u8.avi']();
        const intact = await readMedia(source);
        assert.deepEqual(
            intact.tracks.map(({ track }) => track.codec),
            ['mjpeg', 'pcm-u8'],
        );
        const cinepak = replaced(source, 'MJPG', 'cvid');
        const { tracks, warnings } = await readMedia(cinepak);
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['pcm-u8'],
        );
        assert.deepEqual(warnings, ['AVI_UNSUPPORTED_STREAM']);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            intact.tracks[1].packets.map(packet => packet.data),
        );
        await assert.rejects(
            open(cinepak, { validation: 'strict' }),
            error => error.code === 'DEMUX',
        );
    });

    test('omits an audio stream of an unsupported format tag', async () => {
        const source = differentialFixtures['avi-mjpeg-u8.avi']();
        const intact = await readMedia(source);
        const adpcm = source.slice();
        adpcm[Buffer.from(source).lastIndexOf('strf') + 8] = 2;
        const { tracks, warnings } = await readMedia(adpcm);
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['mjpeg'],
        );
        assert.deepEqual(warnings, ['AVI_UNSUPPORTED_STREAM']);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            intact.tracks[0].packets.map(packet => packet.data),
        );
    });

    test('omits a stream without chunks', async () => {
        const source = differentialFixtures['avi-mjpeg-u8.avi']();
        const intact = await readMedia(source);
        const silent = replaced(source, '01wb', 'JUNK');
        const { tracks, warnings } = await readMedia(silent);
        assert.deepEqual(warnings, ['AVI_EMPTY_STREAM']);
        assert.deepEqual(
            tracks.map(({ packets }) => packets.map(packet => packet.data)),
            [intact.tracks[0].packets.map(packet => packet.data)],
        );
        await assert.rejects(
            open(silent, { validation: 'strict' }),
            error => error.code === 'DEMUX',
        );
    });

    test('a frame held over several slots is followed by empty chunks', async () => {
        // Later frames keep their times.
        // A Windows Media frame held longer than one slot: a variable-rate still.
        const sink = new MemorySink();
        const muxer = new AviMuxer(
            {
                format: 'avi',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'wmv3',
                    width: 64,
                    height: 48,
                    framerate: 25,
                    codecConfig: Uint8Array.of(0x4f, 0xf1, 0x08, 0x01),
                },
            },
            sink,
        );
        const times = [0, 0.4, 0.44, 0.48];
        times.forEach((timestamp, index) =>
            muxer.addVideoChunk({
                trackType: 'video',
                data: Uint8Array.of(index ? 0x40 : 0x00, 0x11, 0x22, 0x33),
                timestamp,
                decodeTimestamp: timestamp,
                duration: (times[index + 1] ?? timestamp + 0.04) - timestamp,
                isKeyframe: index === 0,
            }),
        );
        await muxer.finalize();
        const packets = await allPackets(new Uint8Array(await sink.toBlob().arrayBuffer()));
        assert.deepEqual(
            packets.map(packet => Number(packet.timestamp.toFixed(6))),
            times,
        );
    });

    test('variable-rate MPEG-4 Part 2 copied into AVI keeps its frames in place', async () => {
        // AVI keeps one frame per slot: the slots follow the 40 ms grid of the decode times, empty
        // slots holding the gaps, where the mean rate would drift from the source timeline.
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'mp4',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: false,
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'mp4v.20.9',
                    width: 32,
                    height: 16,
                    codecConfig: mpeg4Config(),
                },
            },
            sink,
        );
        const times = [0, 0.08, 0.2, 0.24, 0.36];
        times.forEach((timestamp, index) =>
            muxer.addVideoChunk(
                {
                    trackType: 'video',
                    data: mpeg4Vop(index ? PICTURE_P : PICTURE_I),
                    timestamp,
                    duration: (times[index + 1] ?? 0.4) - timestamp,
                    isKeyframe: index === 0,
                },
                mpeg4Config(),
            ),
        );
        await muxer.finalize();
        const avi = await copied(new Uint8Array(await sink.toBlob().arrayBuffer()), 'avi');
        assert.deepEqual(
            (await allPackets(avi)).map(packet => Math.round(packet.timestamp * 1000)),
            times.map(time => Math.round(time * 1000)),
        );
    });

    test('drop frames that only the idx1 index records take their slots', async () => {
        // Zero-size entries without a movi chunk, as ffmpeg reads them from the index.
        const frames = [
            [0x05, 0x80, 0x10],
            [0x40, 0x80, 0x11],
            [0x40, 0x80, 0x12],
        ].map(bytes => Uint8Array.from(bytes));
        const stored = aviH264({ fourcc: 'DIV3', extra: new Uint8Array(0), packets: frames });
        const entry = (size, flags = 0) => {
            const bytes = new Uint8Array(16);
            bytes.set(Buffer.from('00dc'), 0);
            new DataView(bytes.buffer).setUint32(4, flags, true);
            new DataView(bytes.buffer).setUint32(12, size, true);
            return bytes;
        };
        const indexed = join(
            stored,
            Buffer.from('idx1'),
            [64, 0, 0, 0],
            entry(3, 0x10),
            entry(0),
            entry(3),
            entry(3),
        );
        new DataView(indexed.buffer).setUint32(4, indexed.length - 8, true);
        const { tracks, warnings } = await readMedia(indexed);
        const video = tracks.find(({ track }) => track.type === 'video');
        assert.deepEqual(
            video.packets.map(packet => Math.round(packet.timestamp * 25)),
            [0, 2, 3],
        );
        assert.deepEqual(warnings, ['AVI_INDEX_DROP_FRAMES']);
    });

    test('reads DV video, every frame coded alone', async () => {
        const frames = [0, 1, 2].map(index => new Uint8Array(480).fill(0x1f + index));
        const avi = aviH264({
            extra: new Uint8Array(0),
            packets: frames,
            fourcc: 'dvsd',
            width: 720,
            height: 576,
        });
        const { tracks } = await readMedia(avi);
        assert.equal(tracks[0].track.codec, 'dvvideo');
        assert.deepEqual(
            tracks[0].packets.map(packet => [packet.isKeyframe, packet.data]),
            frames.map(frame => [true, frame]),
        );
    });

    describe('INFO tags', () => {
        // The common tags RIFF INFO has fields for: INAM, IART, IPRD, ICMT, ICRD, IGNR, ICOP, IPRT.
        const TAGS = [
            { key: 'title', value: 'Song' },
            { key: 'artist', value: 'Artist' },
            { key: 'album', value: 'Album' },
            { key: 'comment', value: 'Comment' },
            { key: 'date', value: '2024' },
            { key: 'genre', value: 'Rock' },
            { key: 'copyright', value: 'Copyright' },
            { key: 'track', value: '3' },
        ];
        /** A sink without patchAt, so the writer holds the file until it finalizes. */
        const wholeSink = () => {
            const parts = [];
            return {
                write: bytes => void parts.push(bytes.slice()),
                close: async () => {},
                toUint8Array: () => concat(...parts),
            };
        };
        /** An AVI of four MP3 frames written into `sink` with `config` (title, tags). */
        async function mp3Avi(sink, config) {
            const audio = {
                id: 1,
                type: 'audio',
                codec: 'mp3',
                sampleRate: 44100,
                channelCount: 1,
            };
            const muxer = new AviMuxer({ format: 'avi', audio, ...config }, sink);
            const frames = mpegAudioFixture(3);
            for (let index = 0; index < 4; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: frames.subarray(index * 417, (index + 1) * 417),
                    timestamp: (index * 1152) / 44100,
                    duration: 1152 / 44100,
                    isKeyframe: true,
                });
            await muxer.finalize();
            return sink.toUint8Array();
        }

        for (const [label, sink] of [
            ['a streamed file', () => new MemorySink()],
            ['a file written at the end', wholeSink],
        ])
            test(`${label} keeps the title and common tags, read back`, async () => {
                const avi = await mp3Avi(sink(), { tags: { entries: TAGS } });
                const result = await new AviDemuxer().demux(new Blob([avi]));
                assert.equal(result.title, 'Song');
                assert.deepEqual(result.tags.entries, TAGS);
                assert.equal(result.audioTracks[0].samples.length, 4);
            });

        test('a title stated for the output wins over the title of the tags', async () => {
            const avi = await mp3Avi(new MemorySink(), {
                title: 'Stated',
                tags: { entries: TAGS },
            });
            const { title, tags } = await new AviDemuxer().demux(new Blob([avi]));
            assert.equal(title, 'Stated');
            assert.deepEqual(tags.entries, [{ key: 'title', value: 'Stated' }, ...TAGS.slice(1)]);
        });

        test('tags RIFF INFO has no field for leave no INFO list', async () => {
            const tags = { entries: [{ key: 'description', value: 'Long' }] };
            const avi = await mp3Avi(new MemorySink(), { tags });
            assert.equal(Buffer.from(avi).indexOf('INFO'), -1);
            assert.equal((await new AviDemuxer().demux(new Blob([avi]))).tags, undefined);
        });
    });

    describe('audio named by its format tag', () => {
        const dtsFrames = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
        // Format tag 0x0011 (IMA ADPCM) is not read from AVI.
        const unsupported = () => ({ format: waveFormatEx(0x0011), chunks: [new Uint8Array(64)] });

        test('DTS (0x2001) is read, and a stream of an unread format is skipped', async () => {
            const dts = { format: waveFormatEx(0x2001), chunks: dtsFrames };
            const { tracks, warnings } = await readMedia(aviAudioFile([unsupported(), dts]));
            assert.deepEqual(
                tracks.map(({ track }) => [track.codec, track.sampleRate, track.channelCount]),
                [['dtsc', 48000, 2]],
            );
            assert.deepEqual(warnings, ['AVI_UNSUPPORTED_STREAM']);
            assert.deepEqual(
                tracks[0].packets.map(packet => packet.data),
                dtsFrames,
            );
        });

        test('a file of only that stream fails with DEMUX, naming the format', async () => {
            await assert.rejects(open(aviAudioFile([unsupported()])), {
                code: 'DEMUX',
                message: /audio format 0x0011 is not supported/,
            });
        });
    });

    describe('PCM', () => {
        const bytesOf = async sink => new Uint8Array(await sink.toBlob().arrayBuffer());

        test('joins one-frame PCM packets into chunks of 50 ms at most', async () => {
            // QuickTime PCM tracks hold one sample frame per sample; a chunk each would add 24
            // bytes per frame.
            const frames = Array.from({ length: 4800 }, (_, index) =>
                Uint8Array.of(index & 255, index >> 8, 7, 9),
            );
            for (const sink of [
                new MemorySink(),
                {
                    chunks: [],
                    write(data) {
                        this.chunks.push(data.slice());
                    },
                    async close() {},
                },
            ]) {
                const muxer = new AviMuxer(
                    {
                        format: 'avi',
                        mode: 'standard',
                        maxFragmentDuration: 2,
                        autoSync: true,
                        audio: {
                            id: 1,
                            type: 'audio',
                            codec: 'pcm-s16le',
                            sampleRate: 48000,
                            channelCount: 2,
                        },
                    },
                    sink,
                );
                frames.forEach((data, index) =>
                    muxer.addAudioChunk({
                        data,
                        timestamp: index / 48000,
                        duration: 1 / 48000,
                        isKeyframe: true,
                        trackType: 'audio',
                    }),
                );
                await muxer.finalize();
                const bytes = sink.chunks ? join(...sink.chunks) : await bytesOf(sink);
                const result = await new AviDemuxer().demux(new Blob([bytes]));
                const samples = result.audioTracks[0].samples;
                assert.deepEqual(
                    samples.map(sample => sample.size),
                    [9600, 9600],
                    'two 2400-frame chunks',
                );
                assert.deepEqual(
                    join(
                        ...samples.map(sample =>
                            bytes.slice(sample.offset, sample.offset + sample.size),
                        ),
                    ),
                    join(...frames),
                );
                assert.equal(Math.round(result.audioTracks[0].duration * 48000), 4800);
            }
        });

        test('planar float samples are written as the 16-bit codes they came from', async () => {
            // Every 16-bit code read as code / 32768 is written as itself, and ±1 as the ends.
            const codes = Int16Array.from({ length: 65536 }, (_, index) => index - 32768);
            const plane = Float32Array.from([...codes, 32768, -32768], code => code / 32768);
            const sink = new MemorySink();
            const muxer = new AviMuxer(
                {
                    format: 'avi',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    audio: {
                        id: 1,
                        type: 'audio',
                        codec: 'pcm-s16le',
                        sampleRate: 48000,
                        channelCount: 1,
                    },
                },
                sink,
            );
            muxer.addPcmPlanarChunk([plane], 48000);
            await muxer.finalize();
            const bytes = await bytesOf(sink);
            const { samples } = (await new AviDemuxer().demux(new Blob([bytes]))).audioTracks[0];
            const data = join(
                ...samples.map(sample => bytes.slice(sample.offset, sample.offset + sample.size)),
            );
            const read = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
            assert.deepEqual(read.subarray(0, 65536), codes);
            assert.deepEqual([...read.subarray(65536)], [32767, -32768]);
        });

        test(
            'explicit AVI PCM16 keeps the existing AVI copy path without relabeling unsupported ' +
                'bytes',
            async () => {
                const input = aviPcmFixture();
                const media = await open(input.bytes);
                try {
                    assert.equal((await media.check('avi', { copy: true })).supported, true);
                    const bytes = new Uint8Array(
                        await (await media.convert('avi', { copy: true })).blob.arrayBuffer(),
                    );
                    const result = await new AviDemuxer().demux(new Blob([bytes]));
                    assert.equal(result.audioTracks[0].codec, 'pcm-s16le');
                    assert.deepEqual(
                        join(
                            ...result.audioTracks[0].samples.map(sample =>
                                bytes.slice(sample.offset, sample.offset + sample.size),
                            ),
                        ),
                        join(...input.packets),
                    );
                } finally {
                    media.close();
                }
                for (const [fixture, reason] of [
                    [aviPcmFixture({ bits: 24 }), /cannot mux audio codec 'pcm-s24le'/],
                    [
                        aviPcmFixture({ bits: 32, float: true }),
                        /cannot mux audio codec 'pcm-f32le'/,
                    ],
                    [aviPcmFixture({ extensible: true, validBits: 12 }), /full 16-bit PCM/],
                    [
                        aviPcmFixture({ extensible: true, channelMask: 0x30 }),
                        /standard channel layout/,
                    ],
                ]) {
                    const {
                        audioTracks: [track],
                    } = await new AviDemuxer().demux(new Blob([fixture.bytes]));
                    assert.throws(
                        () =>
                            new AviMuxer(
                                {
                                    format: 'avi',
                                    mode: 'standard',
                                    maxFragmentDuration: 2,
                                    autoSync: true,
                                    audio: { id: 1, type: 'audio', ...track },
                                },
                                new MemorySink(),
                            ),
                        error => error.code === 'FORMAT' && reason.test(error.message),
                    );
                }
            },
        );

        test(
            'AVI malformed channel count, bit depth, sample size, alignment and partial frames ' +
                'fail',
            async () => {
                for (const options of [
                    { channels: 0 },
                    { channels: 33 },
                    { bits: 12 },
                    { blockAlign: 3 },
                    { byteRate: 1 },
                    { sampleSize: 1 },
                    { partial: true },
                ]) {
                    const bytes = aviPcmFixture(options).bytes;
                    await assert.rejects(
                        new AviDemuxer().demux(new Blob([bytes])),
                        undefined,
                        JSON.stringify(options),
                    );
                }
            },
        );

        test('extensible PCM copies into MKV whole, not narrowed, without its layout', async () => {
            const compatible = aviPcmFixture({ bits: 24, extensible: true, channelMask: 3 });
            const media = await open(compatible.bytes);
            try {
                assert.equal((await media.check('mkv', { copy: true })).supported, true);
            } finally {
                media.close();
            }
            const narrowed = await open(
                aviPcmFixture({ bits: 24, validBits: 20, extensible: true }).bytes,
            );
            try {
                assert.equal((await narrowed.check('mkv', { copy: true })).supported, false);
            } finally {
                narrowed.close();
            }
            // MKV states no speaker layout: the samples are copied and the layout reported
            // lost, or refused under strict validation.
            const surround = aviPcmFixture({ extensible: true, channelMask: 0x30 }).bytes;
            const file = await open(surround);
            const strict = await open(surround, { validation: 'strict' });
            try {
                const copy = await file.convert('mkv', { copy: true });
                assert.deepEqual(
                    copy.warnings.map(warning => warning.code),
                    ['CHANNEL_LAYOUT_DROPPED'],
                );
                const written = parseMatroska(new Uint8Array(await copy.blob.arrayBuffer()));
                assert.equal(written.tracks[0].codec, 'A_PCM/INT/LIT');
                const refused = await strict.check('mkv', { copy: true });
                assert.equal(refused.supported, false);
                assert.equal(refused.code, 'FORMAT');
            } finally {
                file.close();
                strict.close();
            }
        });
    });
});
