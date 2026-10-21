import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distUrl } from '../helpers/dist-paths.mjs';
import { preservationFixture, inspectMovie } from '../helpers/mp4-preservation-fixture.mjs';
import { element, uint, string, join, parseMatroska } from '../helpers/multitrack-pcm-fixtures.mjs';
import { proresFrames } from '../helpers/prores-fixtures.mjs';
import { proresVariants } from '../helpers/prores-variants.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { packetOf } from '../helpers/media-packets.mjs';
import { capabilities, check, convert, open } from 'mediaforgejs';
import { Mp4Demuxer, Mp4Muxer, WebMDemuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';

// The ProRes frame check of the codec configuration, which both containers apply.
const { proResFrameError } = await import(distUrl('esm/core/codec-config/video/prores.js'));
const { normalizeVideoPacket } = await import(
    distUrl('esm/core/codec-config/video/video-packet.js')
);

describe('matroska: ProRes in Matroska and MOV', () => {
    const profiles = Object.keys(proresFrames);
    test('MOV muxer validates the same format snapshot it writes', () => {
        let reads = 0;
        assert.throws(
            () =>
                new Mp4Muxer(
                    {
                        get format() {
                            return ++reads === 1 ? 'mp4' : 'mov';
                        },
                        mode: 'standard',
                        autoSync: false,
                        maxFragmentDuration: 2,
                        video: {
                            id: 7,
                            type: 'video',
                            codec: 'apch',
                            width: 32,
                            height: 24,
                            framerate: 25,
                        },
                    },
                    new MemorySink(),
                ),
            /standard MOV/,
        );
        assert.equal(reads, 1);
    });
    test('ProRes rejects unsupported versions with a nonzero high byte', () => {
        const frame = proresFrames.apch.slice();
        frame[10] = 1;
        assert.match(proResFrameError(frame) ?? '', /version/);
    });
    test('codec capability queries include native ProRes MOV and MKV copies', async () => {
        const { videoCopy } = await capabilities();
        for (const codec of profiles) {
            assert.equal(videoCopy.mov.includes(codec), true);
            assert.equal(videoCopy.mkv.includes(codec), true);
            assert.equal(videoCopy.mp4.includes(codec), false);
            assert.equal(videoCopy.webm.includes(codec), false);
        }
    });
    const config = codec => ({ id: 7, type: 'video', codec, width: 32, height: 24, framerate: 25 });
    const chunk = (data, index = 0) => ({
        trackType: 'video',
        data,
        timestamp: index / 25,
        duration: 1 / 25,
        isKeyframe: true,
    });
    const bytesOf = async value => new Uint8Array(await value.arrayBuffer());

    function matroska(
        codec,
        data = proresFrames[codec],
        privateBytes = new TextEncoder().encode(codec),
        type = 1,
        video = config(codec),
        flags = 0x80,
    ) {
        return join(
            element(
                0x1a45dfa3,
                uint(0x4286, 1),
                uint(0x42f7, 1),
                uint(0x42f2, 4),
                uint(0x42f3, 8),
                string(0x4282, 'matroska'),
                uint(0x4287, 4),
                uint(0x4285, 2),
            ),
            element(
                0x18538067,
                element(0x1549a966, uint(0x2ad7b1, 1000000)),
                element(
                    0x1654ae6b,
                    element(
                        0xae,
                        uint(0xd7, 7),
                        uint(0x73c5, 7),
                        uint(0x83, type),
                        string(0x86, 'V_PRORES'),
                        ...(privateBytes == null ? [] : [element(0x63a2, privateBytes)]),
                        uint(0x23e383, 40000000),
                        element(0xe0, uint(0xb0, video.width), uint(0xba, video.height)),
                    ),
                ),
                element(0x1f43b675, uint(0xe7, 0), element(0xa3, [0x87, 0, 0, flags], data)),
            ),
        );
    }

    for (const codec of profiles) {
        test(`ProRes ${codec} copies MOV → MKV without WebCodecs`, async () => {
            assert.equal(globalThis.VideoEncoder, undefined);
            assert.equal(globalThis.VideoDecoder, undefined);
            const source = preservationFixture({
                mov: true,
                tracks: [{ ...config(codec), packets: [proresFrames[codec]] }],
            });
            const { blob: output } = await convert(new Blob([source.bytes]), 'mkv');
            const parsed = parseMatroska(await bytesOf(output));
            assert.equal(new TextDecoder().decode(parsed.tracks[0].codecPrivate), codec);
            assert.deepEqual(parsed.packets[0].data, proresFrames[codec].slice(8));
        });

        test(`ProRes ${codec}: MOV → MKV → MOV preserves every coded byte`, async () => {
            const frame = proresFrames[codec];
            const fixture = preservationFixture({
                mov: true,
                tracks: [
                    {
                        ...config(codec),
                        packets: [frame, frame, frame],
                        name: `${codec} camera`,
                        title: 'Original pattern',
                    },
                ],
            });
            const input = await open(fixture.bytes);
            try {
                const support = await input.check('mkv', { copy: true });
                assert.equal(support.supported, true, support.reason);
                const bytes = await bytesOf((await input.convert('mkv', { copy: true })).blob);
                const independent = parseMatroska(bytes);
                assert.equal(independent.tracks[0].codec, 'V_PRORES');
                assert.equal(new TextDecoder().decode(independent.tracks[0].codecPrivate), codec);
                assert.deepEqual(
                    independent.packets.map(packet => [...packet.data]),
                    [frame, frame, frame].map(packet => [...packet.slice(8)]),
                );
                const restored = await open(bytes);
                try {
                    assert.equal(restored.tracks[0].codec, codec);
                    assert.equal((await restored.check('mov', { copy: true })).supported, true);
                    const mov = inspectMovie(
                        await bytesOf((await restored.convert('mov', { copy: true })).blob),
                    );
                    assert.equal(mov.tracks[0].codec, codec);
                    assert.equal(mov.tracks[0].name, `${codec} camera`);
                    assert.equal(mov.tracks[0].title, 'Original pattern');
                    assert.deepEqual(
                        mov.tracks[0].packets,
                        [frame, frame, frame].map(packet => [...packet]),
                    );
                    const copied = parseMatroska(
                        await bytesOf((await restored.convert('mkv', { copy: true })).blob),
                    );
                    assert.deepEqual(
                        copied.packets.map(packet => [...packet.data]),
                        independent.packets.map(packet => [...packet.data]),
                    );
                } finally {
                    restored.close();
                }
            } finally {
                input.close();
            }
        });

        test(`ProRes ${codec}: independent Matroska input uses source ranges`, async () => {
            const bytes = matroska(codec);
            const result = await new WebMDemuxer().demux(new Blob([bytes]));
            assert.equal(result.videoTracks[0].codec, codec);
            const sample = result.videoTracks[0].samples[0];
            assert.equal(sample.data, undefined);
            assert.deepEqual(
                bytes.slice(sample.offset, sample.offset + sample.size),
                proresFrames[codec],
            );
        });
    }

    for (const mode of ['standard', 'fragmented']) {
        test(
            `ProRes ${mode}: multiple profiles keep independent CodecPrivate and ` + `packets`,
            async () => {
                const sink = new MemorySink();
                const muxer = new WebMMuxer(
                    {
                        format: 'mkv',
                        mode,
                        autoSync: false,
                        maxFragmentDuration: 2,
                        video: config('apco'),
                        extraVideoTracks: [{ ...config('ap4x'), id: 129 }],
                    },
                    sink,
                );
                muxer.addVideoChunk(chunk(proresFrames.apco));
                muxer.addExtraVideoChunk(0, chunk(proresFrames.ap4x));
                await muxer.finalize();
                const output = parseMatroska(await bytesOf(sink.toBlob()));
                assert.deepEqual(
                    output.tracks.map(track => new TextDecoder().decode(track.codecPrivate)),
                    ['apco', 'ap4x'],
                );
                assert.deepEqual(
                    output.packets.map(packet => [...packet.data]),
                    [proresFrames.apco, proresFrames.ap4x].map(packet => [...packet.slice(8)]),
                );
            },
        );
    }

    test('WebM rejects ProRes before emitting any bytes', async () => {
        let written = 0;
        assert.throws(
            () =>
                new WebMMuxer(
                    {
                        format: 'webm',
                        mode: 'standard',
                        autoSync: false,
                        maxFragmentDuration: 2,
                        video: config('apch'),
                    },
                    {
                        write: data => {
                            written += data.length;
                        },
                        close() {},
                    },
                ),
            /ProRes.*Matroska|WebM.*ProRes/,
        );
        assert.equal(written, 0);
        const input = await open(
            preservationFixture({
                mov: true,
                tracks: [{ ...config('apch'), packets: [proresFrames.apch] }],
            }).bytes,
        );
        try {
            assert.equal((await input.check('webm', { copy: true })).supported, false);
            await assert.rejects(input.convert('webm', { copy: true }), /webm.*apch/i);
        } finally {
            input.close();
        }
    });

    test(
        'Matroska rejects absent, truncated, unknown, and contradictory ProRes profile ' + 'tags',
        async () => {
            for (const tag of [
                null,
                new Uint8Array(),
                Uint8Array.of(97),
                new TextEncoder().encode('apchX'),
                new TextEncoder().encode('xxxx'),
            ])
                await assert.rejects(
                    new WebMDemuxer().demux(new Blob([matroska('apch', proresFrames.apch, tag)])),
                    /ProRes.*(FourCC|CodecPrivate)/,
                );
            await assert.rejects(
                new WebMDemuxer().demux(
                    new Blob([
                        matroska('apch', proresFrames.apch, new TextEncoder().encode('apch'), 2),
                    ]),
                ),
                /ProRes.*video/,
            );
            assert.throws(
                () =>
                    new WebMMuxer(
                        {
                            format: 'mkv',
                            mode: 'standard',
                            autoSync: false,
                            maxFragmentDuration: 2,
                            video: {
                                ...config('apch'),
                                codecConfig: new TextEncoder().encode('apco'),
                            },
                        },
                        new MemorySink(),
                    ),
                /ProRes.*(FourCC|CodecPrivate)/,
            );
        },
    );

    const invalidFrames = [
        ['truncated frame', frame => frame.slice(0, 16)],
        [
            'inconsistent frame size',
            frame => {
                frame[3] ^= 1;
                return frame;
            },
        ],
        [
            'missing icpf header',
            frame => {
                frame[4] = 0;
                return frame;
            },
        ],
        [
            'truncated frame header',
            frame => {
                frame[8] = 255;
                frame[9] = 255;
                return frame;
            },
        ],
        [
            'empty dimensions',
            frame => {
                frame[16] = 0;
                frame[17] = 0;
                return frame;
            },
        ],
    ];
    for (const [name, mutate] of invalidFrames) {
        test(`ProRes ${name} fails validation and output consistently`, async () => {
            const frame = mutate(proresFrames.apch.slice());
            const fixture = preservationFixture({
                mov: true,
                tracks: [{ ...config('apch'), packets: [frame] }],
            });
            const media = await open(fixture.bytes);
            try {
                const checked = await media.check('mkv', { copy: true });
                assert.equal(checked.supported, false);
                assert.match(checked.reason, /ProRes/);
                await assert.rejects(media.convert('mkv', { copy: true }), /ProRes/);
            } finally {
                media.close();
            }
            await assert.rejects(
                new WebMDemuxer().demux(new Blob([matroska('apch', frame)])),
                /ProRes/,
            );
        });
    }

    for (const codec of profiles) {
        test(
            `ProRes ${codec}: standard Matroska blocks restore the frame header ` + `lazily`,
            async () => {
                const frame = proresFrames[codec];
                const bytes = matroska(codec, frame.slice(8));
                const result = await new WebMDemuxer().demux(new Blob([bytes]));
                const sample = result.videoTracks[0].samples[0];
                assert.equal(sample.data, undefined);
                assert.equal(sample.proResHeaderless, true);
                assert.deepEqual(
                    bytes.slice(sample.offset, sample.offset + sample.size),
                    frame.slice(8),
                );
                const media = await open(bytes);
                try {
                    const packets = [];
                    for await (const packet of media.packets()) packets.push(packet);
                    assert.deepEqual(packets[0].data, frame);
                    const checked = await media.check('mov', { copy: true });
                    assert.equal(checked.supported, true, checked.reason);
                    const mov = inspectMovie(
                        await bytesOf((await media.convert('mov', { copy: true })).blob),
                    );
                    assert.deepEqual(mov.tracks[0].packets[0], [...frame]);
                    const copied = parseMatroska(
                        await bytesOf((await media.convert('mkv', { copy: true })).blob),
                    );
                    assert.deepEqual(copied.packets[0].data, frame.slice(8));
                } finally {
                    media.close();
                }
            },
        );
    }

    test('ProRes standard Matroska packet restoration respects maxPacketBytes', async () => {
        const frame = proresFrames.apch;
        const media = await open(matroska('apch', frame.slice(8)), {
            maxPacketBytes: frame.length - 1,
        });
        try {
            await assert.rejects(async () => {
                for await (const packet of media.packets())
                    assert.fail(`Unexpected packet ${packet.data.length}`);
            }, /maxPacketBytes/);
        } finally {
            media.close();
        }
    });

    test('ProRes header restoration is explicit and rejects non-ProRes tracks', () => {
        const frame = proresFrames.apch;
        assert.deepEqual(
            normalizeVideoPacket(frame.slice(8), 'apch', undefined, undefined, true),
            frame,
        );
        assert.throws(
            () => normalizeVideoPacket(frame.slice(8), 'avc1', undefined, undefined, true),
            /ProRes/,
        );
        assert.equal(
            proResFrameError(frame.slice(8), config('apch')),
            'ProRes requires a complete size/icpf frame header',
        );
    });

    const pictureOffset = frame =>
        8 + new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(8);
    const corruptStructures = [
        [
            'unknown bitstream version',
            frame => {
                frame[11] = 2;
            },
        ],
        [
            'reserved chroma format',
            frame => {
                frame[20] &= 0x3f;
            },
        ],
        [
            'reserved interlace mode',
            frame => {
                frame[20] |= 12;
            },
        ],
        [
            'reserved alpha mode',
            frame => {
                frame[25] |= 15;
            },
        ],
        [
            'quantization matrices outside header',
            frame => {
                frame[8] = 0;
                frame[9] = 20;
            },
        ],
        [
            'truncated picture header',
            frame => {
                frame[pictureOffset(frame)] = 0;
            },
        ],
        [
            'picture size exceeds frame',
            frame => {
                frame[pictureOffset(frame) + 1] = 255;
            },
        ],
        [
            'slice table exceeds picture',
            frame => {
                new DataView(frame.buffer).setUint32(pictureOffset(frame) + 1, 9);
            },
        ],
        [
            'slice size exceeds picture',
            frame => {
                frame[pictureOffset(frame) + 8] = 255;
            },
        ],
        [
            'slice header exceeds slice',
            frame => {
                frame[pictureOffset(frame) + 12] = 8;
            },
        ],
        [
            'plane data exceeds slice',
            frame => {
                frame[pictureOffset(frame) + 14] = 255;
            },
        ],
        [
            'missing second field',
            frame => {
                frame[20] |= 4;
            },
        ],
    ];
    for (const [name, mutate] of corruptStructures) {
        test(`ProRes ${name} is rejected in both Matroska framings`, async () => {
            const frame = proresFrames.apch.slice();
            mutate(frame);
            assert.match(proResFrameError(frame, config('apch')) ?? '', /ProRes/);
            for (const data of [frame, frame.slice(8)]) {
                await assert.rejects(
                    new WebMDemuxer().demux(new Blob([matroska('apch', data)])),
                    /ProRes/,
                );
            }
            const media = await open(
                preservationFixture({
                    mov: true,
                    tracks: [{ ...config('apch'), packets: [frame] }],
                }).bytes,
            );
            try {
                for (const format of ['mov', 'mkv']) {
                    const checked = await media.check(format, { copy: true });
                    assert.equal(checked.supported, false, `${name}: ${format}`);
                    await assert.rejects(media.convert(format, { copy: true }), /ProRes/);
                }
            } finally {
                media.close();
            }
        });
    }

    test(
        'ProRes rejects dimensions inconsistent with the container and 4444 data declared as ' +
            '422',
        async () => {
            assert.match(
                proResFrameError(proresFrames.apch, { ...config('apch'), width: 31 }) ?? '',
                /dimensions/,
            );
            assert.match(proResFrameError(proresFrames.ap4h, config('apch')) ?? '', /profile/);
            await assert.rejects(
                new WebMDemuxer().demux(new Blob([matroska('apch', proresFrames.ap4h)])),
                /profile/,
            );
            const frame = proresFrames.apch.slice();
            frame[17] = 31;
            await assert.rejects(
                new WebMDemuxer().demux(new Blob([matroska('apch', frame)])),
                /dimensions/,
            );
        },
    );

    test('ProRes permits zero stuffing, reserved bits, and the deprecated slice count', () => {
        const frame = new Uint8Array(proresFrames.apch.length + 7);
        frame.set(proresFrames.apch);
        new DataView(frame.buffer).setUint32(0, frame.length);
        const picture = pictureOffset(frame);
        frame[picture + 5] = 255;
        frame[picture + 6] = 255;
        frame[picture + 7] |= 0xcf;
        assert.equal(proResFrameError(frame, config('apch')), undefined);
        frame[frame.length - 1] = 1;
        assert.match(proResFrameError(frame, config('apch')) ?? '', /stuffing/);
    });

    test('ProRes MOV writer validates primary and secondary video packet structures', () => {
        const muxer = new Mp4Muxer(
            {
                format: 'mov',
                mode: 'standard',
                autoSync: false,
                maxFragmentDuration: 2,
                video: config('apch'),
                extraVideoTracks: [{ ...config('ap4h'), id: 8 }],
            },
            new MemorySink(),
        );
        assert.throws(() => muxer.addVideoChunk(chunk(proresFrames.apch.slice(8))), /ProRes/);
        assert.throws(
            () => muxer.addExtraVideoChunk(0, chunk(proresFrames.ap4h.slice(8))),
            /ProRes/,
        );
    });

    for (const [name, variant] of Object.entries(proresVariants)) {
        test(
            `ProRes ${name}: MOV and Matroska roundtrips retain the complete coded ` + `frame`,
            async () => {
                const { data: frame, ...dimensions } = variant;
                const video = { ...config(variant.codec), ...dimensions };
                assert.equal(proResFrameError(frame, video), undefined);
                for (const source of [
                    preservationFixture({ mov: true, tracks: [{ ...video, packets: [frame] }] })
                        .bytes,
                    matroska(video.codec, frame.slice(8), undefined, 1, video),
                ]) {
                    const media = await open(source);
                    try {
                        for (const format of ['mov', 'mkv']) {
                            const checked = await media.check(format, { copy: true });
                            assert.equal(checked.supported, true, checked.reason);
                            const output = await bytesOf(
                                (await media.convert(format, { copy: true })).blob,
                            );
                            const restored = await open(output);
                            try {
                                const packets = [];
                                for await (const packet of restored.packets()) packets.push(packet);
                                assert.deepEqual(packets[0].data, frame);
                                assert.equal(restored.tracks[0].width, video.width);
                                assert.equal(restored.tracks[0].height, video.height);
                            } finally {
                                restored.close();
                            }
                        }
                    } finally {
                        media.close();
                    }
                }
            },
        );
    }

    test('ProRes fixed lacing marks every intra frame as a keyframe', async () => {
        const frame = proresFrames.apch;
        const bytes = matroska('apch', join([1], frame, frame), undefined, 1, config('apch'), 0x84);
        const result = await new WebMDemuxer().demux(new Blob([bytes]));
        assert.deepEqual(
            result.videoTracks[0].samples.map(sample => sample.isKeyframe),
            [true, true],
        );
        assert.deepEqual(
            result.videoTracks[0].samples.map(sample => sample.timestamp),
            [0, 0.04],
        );
    });

    test(
        'conversion restores standard Matroska ProRes framing for MOV without ' + 'WebCodecs',
        async () => {
            const frame = proresFrames.ap4h;
            const { blob: result } = await convert(
                new Blob([matroska('ap4h', frame.slice(8))]),
                'mov',
            );
            const mov = inspectMovie(await bytesOf(result));
            assert.deepEqual(mov.tracks[0].packets[0], [...frame]);
        },
    );

    const dualProResTracks = [
        {
            ...config('apch'),
            name: 'Main camera',
            language: 'eng',
            default: true,
            packets: [proresFrames.apch, proresFrames.apch],
        },
        {
            ...config('ap4h'),
            id: 9,
            name: 'Alpha camera',
            language: 'jpn',
            default: false,
            packets: [proresFrames.ap4h, proresVariants.alpha8.data],
        },
    ];

    async function dualProResMov() {
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'mov',
                mode: 'standard',
                autoSync: false,
                maxFragmentDuration: 2,
                video: dualProResTracks[0],
                extraVideoTracks: [dualProResTracks[1]],
            },
            sink,
        );
        for (const [index, frame] of dualProResTracks[0].packets.entries())
            muxer.addVideoChunk(chunk(frame, index));
        for (const [index, frame] of dualProResTracks[1].packets.entries())
            muxer.addExtraVideoChunk(0, chunk(frame, index));
        await muxer.finalize();
        return sink.toBlob();
    }

    async function assertDualProRes(blob) {
        const media = await open(blob);
        try {
            assert.equal(media.tracks.length, 2);
            assert.equal(new Set(media.tracks.map(track => track.id)).size, 2);
            for (const expected of dualProResTracks) {
                const track = media.tracks.find(track => track.codec === expected.codec);
                assert(track, `Missing ${expected.codec} track`);
                for (const key of ['name', 'language', 'default'])
                    assert.equal(track[key], expected[key], `${expected.codec} ${key}`);
                const packets = [];
                for await (const packet of media.packets({ trackIds: [track.id] }))
                    packets.push(packet.data);
                assert.deepEqual(packets, expected.packets);
            }
        } finally {
            media.close();
        }
    }

    test(
        'conversion retains both ProRes tracks across MOV → MKV → MOV with default codec ' +
            'choices',
        async () => {
            const source = await dualProResMov();
            await assertDualProRes(source);
            const { blob: mkv } = await convert(source, 'mkv');
            await assertDualProRes(mkv);
            for (const outputFormat of ['mov', 'mkv']) {
                await assertDualProRes((await convert(mkv, outputFormat)).blob);
                const sink = new MemorySink();
                await convert(mkv, outputFormat, { sink });
                await assertDualProRes(sink.toBlob());
            }
        },
    );

    for (const copy of [true, undefined]) {
        for (const format of ['mov', 'mkv']) {
            test(
                `${copy ? 'copying' : 'converting'} preserves both headerless ProRes tracks in ` +
                    `${format}`,
                async () => {
                    const source = await open(await dualProResMov());
                    let mkv;
                    try {
                        mkv = (await source.convert('mkv', { copy: true })).blob;
                    } finally {
                        source.close();
                    }
                    const checked = await check(mkv, format, { copy });
                    assert.equal(checked.supported, true, checked.reason);
                    await assertDualProRes((await convert(mkv, format, { copy })).blob);
                },
            );
        }
    }

    /**
     * Converts with WebCodecs video doubles in place of the browser's codecs; returns what each
     * output track is and whether its packets are the source's.
     */
    async function convertWithCodecs(input, target) {
        const runtime = installVideoCodecs();
        try {
            const { blob, plan: report } = await convert(input, target);
            runtime.assertClosed();
            const [source, output] = [await open(input), await open(blob)];
            try {
                const tracks = [];
                for (const track of output.tracks) {
                    const original = source.tracks.find(candidate => candidate.id === track.id);
                    const first = await packetOf(output, track.id);
                    const same = original && (await packetOf(source, original.id)).data;
                    tracks.push([
                        track.codec,
                        same !== undefined && Buffer.compare(first.data, same) === 0,
                    ]);
                }
                return { tracks, report: report.tracks.map(track => [track.type, track.action]) };
            } finally {
                source.close();
                output.close();
            }
        } finally {
            runtime.restore();
        }
    }

    test(
        'a video codec change re-encodes the first video track and copies the secondary ' + 'one',
        async () => {
            const { tracks, report } = await convertWithCodecs(await dualProResMov(), {
                to: 'mkv',
                video: { codec: 'vp8' },
            });
            assert.deepEqual(report, [
                ['video', 'encode'],
                ['video', 'copy'],
            ]);
            assert.equal(tracks[0][0], 'vp8');
            assert.deepEqual(tracks[1], ['ap4h', true]);
        },
    );

    test('a size request the first video track already has copies both video tracks', async () => {
        const secondary = proresVariants.topFieldFirst;
        const source = preservationFixture({
            mov: true,
            tracks: [
                { ...config('apch'), packets: [proresFrames.apch] },
                {
                    ...config(secondary.codec),
                    id: 9,
                    width: secondary.width,
                    height: secondary.height,
                    packets: [secondary.data],
                },
            ],
        });
        const { report } = await convertWithCodecs(new Blob([source.bytes]), {
            to: 'mov',
            video: { width: 32, height: 24 },
        });
        assert.deepEqual(report, [
            ['video', 'copy'],
            ['video', 'copy'],
        ]);
    });

    test(
        'Matroska ProRes vendor ID icpf does not masquerade as a legacy frame ' + 'wrapper',
        async () => {
            const frame = proresFrames.apch.slice();
            frame.set(new TextEncoder().encode('icpf'), 12);
            const source = matroska('apch', frame.slice(8));
            const demuxed = await new WebMDemuxer().demux(new Blob([source]));
            assert.equal(demuxed.videoTracks[0].samples[0].proResHeaderless, true);
            const media = await open(source);
            try {
                assert.equal((await media.check('mov', { copy: true })).supported, true);
                const output = inspectMovie(
                    await bytesOf((await media.convert('mov', { copy: true })).blob),
                );
                assert.deepEqual(output.tracks[0].packets[0], [...frame]);
            } finally {
                media.close();
            }
        },
    );

    test('ProRes preserves embedded HDR identifiers and container colour metadata', async () => {
        const frame = proresFrames.ap4h.slice();
        frame[22] = 9;
        frame[23] = 16;
        frame[24] = 9;
        const colour = { primaries: 9, transfer: 16, matrix: 9, fullRange: false };
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'mov',
                mode: 'standard',
                autoSync: false,
                maxFragmentDuration: 2,
                video: {
                    ...config('ap4h'),
                    colour,
                    name: 'HDR camera',
                    title: 'Original RGBA pattern',
                },
            },
            sink,
        );
        muxer.addVideoChunk(chunk(frame));
        await muxer.finalize();
        let bytes = await bytesOf(sink.toBlob());
        for (const format of ['mkv', 'mov']) {
            const media = await open(bytes);
            try {
                const parsed = await (
                    format === 'mkv' ? new Mp4Demuxer() : new WebMDemuxer()
                ).demux(new Blob([bytes]));
                assert.deepEqual(parsed.videoTracks[0].colour, colour);
                const packets = [];
                for await (const packet of media.packets()) packets.push(packet);
                assert.deepEqual(packets[0].data, frame);
                bytes = await bytesOf((await media.convert(format, { copy: true })).blob);
            } finally {
                media.close();
            }
        }
        const final = await open(bytes);
        try {
            assert.deepEqual(
                (await new Mp4Demuxer().demux(new Blob([bytes]))).videoTracks[0].colour,
                colour,
            );
            assert.equal(final.tracks[0].name, 'HDR camera');
            assert.equal(final.tracks[0].title, 'Original RGBA pattern');
        } finally {
            final.close();
        }
    });

    test('ProRes accepts the normative unpadded bottom field at odd interlaced heights', () => {
        const { data, codec, width, height } = proresVariants.oddInterlaced33;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const firstPicture = pictureOffset(data);
        const bottom = firstPicture + view.getUint32(firstPicture + 1);
        const table = bottom + (data[bottom] >>> 3);
        const firstRowSize = view.getUint16(table) + view.getUint16(table + 2);
        const frame = join(
            data.slice(0, table + 4),
            data.slice(table + 8, table + 8 + firstRowSize),
        );
        const edited = new DataView(frame.buffer);
        edited.setUint32(0, frame.length);
        edited.setUint32(bottom + 1, frame.length - bottom);
        edited.setUint16(bottom + 5, 2);
        assert.equal(proResFrameError(frame, { codec, width, height }), undefined);
    });

    test('ProRes truncated frames are rejected even after their outer size is rewritten', () => {
        for (const frame of [proresFrames.apch, proresFrames.ap4h]) {
            for (let length = 28; length < frame.length; length++) {
                const truncated = frame.slice(0, length);
                new DataView(truncated.buffer).setUint32(0, length);
                assert.match(
                    proResFrameError(truncated) ?? '',
                    /ProRes/,
                    `truncation at ${length}/${frame.length}`,
                );
            }
        }
    });

    test('ProRes embedded alpha requires data beyond the three colour planes', () => {
        const frame = proresFrames.ap4h.slice();
        const view = new DataView(frame.buffer);
        const picture = pictureOffset(frame);
        const table = picture + (frame[picture] >>> 3);
        const slice = table + 4;
        const sliceSize = view.getUint16(table);
        const alphaStart =
            (frame[slice] >>> 3) + view.getUint16(slice + 2) + view.getUint16(slice + 4);
        view.setUint16(slice + 6, sliceSize - alphaStart);
        assert.match(proResFrameError(frame, config('ap4h')) ?? '', /plane data/);
    });
});
