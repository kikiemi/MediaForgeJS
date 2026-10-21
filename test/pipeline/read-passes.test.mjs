import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    counted,
    encoded,
    indexedCopy,
    largePicture,
    muxedWithAudio,
    probeBytes,
} from '../helpers/large-ts-matroska.mjs';
import { describe, test } from 'node:test';
import { BufferSource, MemorySink } from 'mediaforgejs/io';
import { convert, frames, open, packageMedia, thumbnail } from 'mediaforgejs';
import { TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import {
    Bits,
    avcc,
    filler,
    idr,
    lengthPrefixed,
    nal,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { engineWith, mediaFileState } from '../helpers/engine.mjs';
import { PROBE_MIB, scaleProbeWindows } from '../helpers/probe-windows.mjs';

// Passes read a large input once, in file order, and give what a read of its index gives. The
// probe windows are scaled down (probe-windows.mjs): sizes are in probe kibibytes and mebibytes.

scaleProbeWindows();

/** `count` probe kibibytes. */
const pkib = count => count * (PROBE_MIB / 1024);

/** `make()` once, on first use. */
const once = make => {
    let made;
    return () => (made ??= make());
};
/** The SHA-256 of a conversion's output. */
const hashOf = async result =>
    createHash('sha256')
        .update(new Uint8Array(await result.blob.arrayBuffer()))
        .digest('hex');
/** The time and bytes of each picture frames() gives. */
const picturesOf = async pictures => {
    const list = [];
    for await (const picture of pictures) list.push([picture.timestamp, picture.data]);
    return list;
};

describe('read: passes over large inputs', () => {
    describe("a source that reads into the caller's bytes", () => {
        // As files and in-memory bytes do: the pass refills a few pooled chunks. Pictures of
        // reordered Matroska video wait past their window for their decode times, and a copy keeps
        // their bytes: they equal those of an indexed copy, as do the TS samples gathered into the
        // pass's own buffers. The pass times the pictures as a read of the whole file does, also
        // where the reordering deepens after the head (an indexed read took the deepest
        // reordering of the whole track, the pass that of the head).
        const reorderedMatroska = once(async () => {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'avc1.42c00a',
                        codecConfig: avcc(),
                        width: 64,
                        height: 48,
                        framerate: 30,
                    },
                },
                sink,
            );
            for (let index = 0; index < 1100; index++) {
                // Decode order I P B, shown as I B P, then groups of five shown as 0 2 3 1 4
                // (positions 0 4 2 1 3 in decode order): each picture's filler differs, so a
                // refilled buffer shows.
                const shown =
                    index < 300
                        ? index % 3 === 0
                            ? index
                            : index % 3 === 1
                              ? index + 1
                              : index - 1
                        : index - (index % 5) + [0, 4, 2, 1, 3][index % 5];
                const data = lengthPrefixed(4, index % 30 ? predicted : idr, filler(pkib(64)));
                data.fill(index & 255, data.length - 64);
                muxer.addVideoChunk({
                    trackType: 'video',
                    data,
                    timestamp: shown / 30,
                    decodeTimestamp: index / 30,
                    duration: 1 / 30,
                    isKeyframe: index % 30 === 0,
                });
            }
            await muxer.finalize();
            return new BufferSource(sink.toUint8Array(), { copy: false });
        });
        for (const [name, input] of [
            ['reordered Matroska pictures', reorderedMatroska],
            ['MPEG-TS samples', () => muxedWithAudio(TsMuxer, 'ts')],
        ])
            test(`${name} keep their bytes and times through a pass`, async () => {
                // A copy through a pass writes the bytes a copy of the index writes.
                const source = await input();
                for (const target of ['mkv', 'mp4'])
                    assert.equal(
                        await hashOf(await convert(source, target)),
                        await hashOf(await indexedCopy(source, target)),
                        target,
                    );
            });
    });

    for (const [Muxer, format] of [
        [TsMuxer, 'ts'],
        [WebMMuxer, 'mkv'],
    ])
        describe(`a large ${format} with its audio stored half a second ahead`, () => {
            // A pass reads packets in file order and hands them on in the order an index merges
            // them (by decode time). Packaging, frames() whose times rise and a converted range
            // read the input once (a range from its start to after the range), without an index
            // first, and give what an indexed input gives.
            const input = once(async () => {
                const sink = new MemorySink();
                const muxer = new Muxer(
                    {
                        format,
                        mode: 'standard',
                        video: {
                            id: 1,
                            type: 'video',
                            codec: 'avc1.42c00a',
                            codecConfig: avcc(),
                            width: 64,
                            height: 48,
                            framerate: 30,
                        },
                        audio: {
                            codec: 'mp4a.40.2',
                            codecConfig: Uint8Array.of(0x11, 0x88),
                            sampleRate: 48000,
                            channelCount: 1,
                        },
                    },
                    sink,
                );
                // 1,100 pictures of 64 probe KiB (about 70 probe MiB) with a keyframe each second.
                let frame = 0;
                for (let index = 0; index < 1100; index++) {
                    for (; (frame * 1024) / 48000 < index / 30 + 0.5; frame++)
                        muxer.addAudioChunk({
                            trackType: 'audio',
                            data: encoded.frames[frame % encoded.frames.length],
                            timestamp: (frame * 1024) / 48000,
                            duration: 1024 / 48000,
                            isKeyframe: true,
                        });
                    muxer.addVideoChunk({
                        trackType: 'video',
                        data: largePicture(index),
                        timestamp: index / 30,
                        duration: 1 / 30,
                        isKeyframe: index % 30 === 0,
                    });
                }
                await muxer.finalize();
                return new BufferSource(sink.toUint8Array(), { copy: false });
            });

            test('copies as an indexed copy does', async () => {
                const source = await input();
                assert.equal(
                    await hashOf(await convert(source, 'ts')),
                    await hashOf(await indexedCopy(source, 'ts')),
                );
            });

            test('packages in one read the files an indexed package writes', async () => {
                const source = await input();
                const packaged = counted(source);
                const { files } = await packageMedia(packaged.source, 'hls');
                // Its probe and the input once.
                assert.ok(
                    packaged.counter.bytes <= (await probeBytes(source)) + source.size,
                    `${packaged.counter.bytes}`,
                );
                const media = await open(source);
                try {
                    const expected = (await media.packageMedia('hls')).files;
                    assert.deepEqual([...files.keys()], [...expected.keys()]);
                    for (const [file, entry] of files)
                        assert.deepEqual(entry.data, expected.get(file).data, file);
                } finally {
                    media.close();
                }
            });

            test('frames() gives the pictures of an indexed input, reading a window', async () => {
                const source = await input();
                const media = await open(source);
                try {
                    for (const settings of [
                        { times: [1, 2.5, 2.5, 7], width: 16, height: 12 },
                        { every: 5, width: 16, height: 12 },
                    ]) {
                        const read = counted(source);
                        assert.deepEqual(
                            await picturesOf(frames(read.source, settings)),
                            await picturesOf(media.frames(settings)),
                            JSON.stringify(settings),
                        );
                        if (settings.times)
                            assert.ok(
                                read.counter.bytes < source.size / 2,
                                `${read.counter.bytes}`,
                            );
                    }
                } finally {
                    media.close();
                }
            });

            test('a converted range reads its window and converts as indexed', async () => {
                const source = await input();
                const ranged = counted(source);
                const cut = await convert(ranged.source, { to: 'wav', start: 2, end: 4 });
                // Its probe and less than half of the input.
                assert.ok(
                    ranged.counter.bytes < (await probeBytes(source)) + source.size / 2,
                    `${ranged.counter.bytes}`,
                );
                assert.equal(
                    await hashOf(cut),
                    await hashOf(await indexedCopy(source, { to: 'wav', start: 2, end: 4 })),
                );
            });
        });
    describe('inputs of about 8 probe MB, just large enough to describe from their ends', () => {
        // A pass over a large input gives the packets of its index, and a Media's copy does not
        // depend on what the Media read before.
        const engine = once(() => engineWith([]));
        const packetsOfFile = async file => {
            const packets = [];
            for await (const packet of file.packets({}, 'owned'))
                packets.push([
                    packet.trackId,
                    packet.timestamp,
                    packet.duration,
                    packet.decodeTimestamp,
                    packet.isKeyframe,
                    packet.data,
                ]);
            file.close();
            return packets;
        };
        const VIDEO = { codec: 'avc1.42c00a', codecConfig: avcc(), width: 64, height: 48 };

        // Sound stored without durations lasts until the next frame, also across the windows of
        // a pass: here 22 and 21 ms in turn. No frame rate is stored: a copy takes it from the
        // pictures, which last 40 ms for the first two seconds and 33 ms after, from the probe's
        // head for a pass and so too for a Media that read the index.
        const matroska = once(async () => {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: { ...VIDEO, framerate: 0 },
                    audio: { codec: 'dtsc', sampleRate: 48000, channelCount: 2 },
                },
                sink,
            );
            let sound = 0;
            let shown = 0;
            for (let index = 0; index < 900; index++) {
                const duration = index < 50 ? 0.04 : 1 / 30;
                for (; sound * 0.0215 < shown; sound++)
                    muxer.addAudioChunk({
                        trackType: 'audio',
                        data: new Uint8Array(600).fill(sound),
                        timestamp: sound * 0.0215 + (sound % 2) * 0.0005,
                        duration: 0.0215,
                        isKeyframe: true,
                    });
                muxer.addVideoChunk({
                    trackType: 'video',
                    data:
                        index % 30
                            ? lengthPrefixed(4, predicted, filler(pkib(8)))
                            : lengthPrefixed(4, sps, pps, idr, filler(pkib(8))),
                    timestamp: shown,
                    duration,
                    isKeyframe: index % 30 === 0,
                });
                shown += duration;
            }
            await muxer.finalize();
            return sink.toUint8Array();
        });

        test('a pass gives the packets of the index', async () => {
            const streamed = await (
                await engine()
            ).open(await matroska(), {}, [], { stream: true });
            assert.equal(streamed.streamed, true);
            assert.deepEqual(
                await packetsOfFile(streamed),
                await packetsOfFile(await (await engine()).open(await matroska())),
            );
        });

        test("a Media's copy is the same whether or not it read the index first", async () => {
            const digest = async result =>
                createHash('sha1')
                    .update(new Uint8Array(await result.blob.arrayBuffer()))
                    .digest('hex');
            const viaMedia = async (target, indexFirst) => {
                const media = await open(await matroska());
                try {
                    if (indexFirst) for await (const _ of media.packets({ start: 1e12 }));
                    return await digest(await media.convert(target));
                } finally {
                    media.close();
                }
            };
            for (const target of [{}, { to: 'ts' }, { start: 4, end: 6 }]) {
                const copied = await digest(await convert(await matroska(), target));
                assert.equal(await viaMedia(target, false), copied, JSON.stringify(target));
                assert.equal(await viaMedia(target, true), copied, JSON.stringify(target));
            }
        });

        test('a thumbnail reads the head and the window of its picture, not the tail', async () => {
            // The window is placed by the Cues; the input's end describes nothing a picture
            // needs. Its decoder's pass stops at the window's end.
            const bytes = await matroska();
            let read = 0;
            const source = {
                size: bytes.length,
                read: async (offset, length) => {
                    read += length;
                    return bytes.slice(offset, offset + length);
                },
            };
            const picture = await thumbnail(source, { time: 20, width: 32 });
            assert.ok(picture.blob.size > 0);
            assert.ok(read < 3.5 * PROBE_MIB, `a thumbnail read ${read} bytes`);
        });

        test('a window derives an unstated avcC once, warning once', async () => {
            // A window describes its tracks as the open did, from their first samples, as an
            // index does: a track stating no avcC (its CodecPrivate renamed) takes it from the
            // in-band parameter sets of its first picture.
            const unstated = (await matroska()).slice();
            let codecPrivate = 0;
            // The element 63 A2 whose avcC starts with its version, 1.
            while (unstated[codecPrivate] !== 0x63 || unstated[codecPrivate + 1] !== 0xa2)
                codecPrivate++;
            assert.equal(unstated[codecPrivate + 3], 1);
            unstated[codecPrivate + 1] = 0xa3;
            const heard = [];
            const media = await open(unstated, { onWarning: warning => heard.push(warning.code) });
            try {
                assert.ok(await media.packetAt(1, 10.5));
                assert.deepEqual(heard, ['VIDEO_CONFIG_DERIVED']);
            } finally {
                media.close();
            }
        });

        test("a window from past libfaac's first frame keeps its encoder delay", async () => {
            // libfaac marks its encoder delay in the first frame of a stream only.
            const marker = Uint8Array.from(
                Buffer.from('de0200006c69626661616320312e323801c0', 'hex'),
            );
            const silence = Uint8Array.from(Buffer.from('01540685a00000800380', 'hex'));
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: { ...VIDEO, framerate: 30 },
                    audio: {
                        codec: 'mp4a.40.2',
                        codecConfig: Uint8Array.of(0x13, 0x88),
                        sampleRate: 22050,
                        channelCount: 1,
                    },
                },
                sink,
            );
            for (let index = 0, sound = 0; index < 900; index++) {
                for (; (sound * 1024) / 22050 < index / 30; sound++)
                    muxer.addAudioChunk({
                        trackType: 'audio',
                        data: sound ? silence : marker,
                        timestamp: (sound * 1024) / 22050,
                        duration: 1024 / 22050,
                        isKeyframe: true,
                    });
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: lengthPrefixed(4, index % 30 ? predicted : idr, filler(pkib(8))),
                    timestamp: index / 30,
                    duration: 1 / 30,
                    isKeyframe: index % 30 === 0,
                });
            }
            await muxer.finalize();
            const faac = sink.toUint8Array();
            const delayOf = file =>
                mediaFileState(file).tracks.find(track => track.description.type === 'audio').info
                    .decoderDelaySamples;
            const indexed = await (await engine()).open(faac);
            assert.equal(delayOf(indexed), 1024);
            indexed.close();
            const described = await (await engine()).open(faac, {}, [], {});
            const window = await described.window({ range: { start: 15, end: 17 }, timed: true });
            assert.equal(window.probedInput, true);
            assert.equal(delayOf(window), 1024);
            window.close();
            described.close();
        });

        test('H.264 in MPEG-TS without IDR pictures is read from its index', async () => {
            // It is entered at its I pictures, which only a read of the whole stream tells: a
            // pass and the windows read the index instead.
            const intra = nal(0x21, new Bits().ue(0).ue(7).ue(0).uint(0, 4).ue(0).ue(0).bytes());
            const sink = new MemorySink();
            const muxer = new TsMuxer({ format: 'ts', mode: 'standard', video: VIDEO }, sink);
            for (let index = 0; index < 900; index++)
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: lengthPrefixed(4, index % 30 ? predicted : intra, filler(pkib(8))),
                    timestamp: index / 30,
                    duration: 1 / 30,
                    isKeyframe: index % 30 === 0,
                });
            await muxer.finalize();
            const intraOnly = sink.toUint8Array();
            const keyframes = (await packetsOfFile(await (await engine()).open(intraOnly)))
                .filter(packet => packet[4])
                .map(packet => packet[1]);
            assert.equal(keyframes.length, 30);
            const probed = await (await engine()).open(intraOnly, {}, [], {});
            assert.equal(probed.probedInput, true);
            probed.close();
            assert.deepEqual(
                await packetsOfFile(
                    await (await engine()).open(intraOnly, {}, [], { stream: true }),
                ),
                await packetsOfFile(await (await engine()).open(intraOnly)),
            );
            const searched = await open(intraOnly);
            try {
                const found = await searched.packetAt(1, 10.5, { keyframe: true });
                assert.equal(found?.timestamp, keyframes[10]);
            } finally {
                searched.close();
            }
        });

        test('the tail of VfW VC-1 tells when its last anchor is shown', async () => {
            // The blocks carry decode times; the last anchor is shown when the last block ends,
            // which the tail tells as a read of the whole track does: the first block lasts
            // longer than the others and no longer decides it.
            const headers = Uint8Array.from(
                Buffer.from(
                    '0000010fdbfe3bf21bca3bf886f180c909a5b8d707fc0000010e1adffcefc86c40',
                    'hex',
                ),
            );
            const config = Uint8Array.of(headers.length, ...headers);
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: {
                        codec: 'vc1',
                        width: 32,
                        height: 16,
                        codecConfig: config,
                        framerate: 0,
                    },
                },
                sink,
            );
            // PTYPE after FCM 0: 110 an I picture, 0 a P picture, 10 a B picture.
            for (let index = 0; index < 600; index++) {
                const slot = index % 30;
                const first = slot === 0 ? 0x60 : slot % 2 ? 0x00 : 0x40;
                const decodeTimestamp = index && 0.05 + (index - 1) * 0.04;
                muxer.addVideoChunk(
                    {
                        trackType: 'video',
                        data: Uint8Array.of(first, ...new Uint8Array(pkib(16)).fill(0x55)),
                        timestamp: decodeTimestamp,
                        decodeTimestamp,
                        duration: index ? 0.04 : 0.05,
                        isKeyframe: slot === 0,
                    },
                    config,
                );
            }
            await muxer.finalize();
            const vc1 = sink.toUint8Array();
            const indexed = await (await engine()).open(vc1);
            const described = await (await engine()).open(vc1, {}, [], {});
            assert.equal(described.probedInput, true);
            assert.deepEqual(described.uncountedTracks, indexed.uncountedTracks);
            described.close();
            indexed.close();
        });
    });

    test('a thumbnail of a track starting late reads nothing past the last head', async () => {
        // In probe MiB: the head grows fourfold from 64 probe KiB until it holds the first sample
        // of each track, and the last reaches the 32 of other heads: audio that starts 11 s (about
        // 21) in is found past the 16 head, and the thumbnail reads nothing past the 32 head but
        // the Cues at the end (87.6), where a read of the whole input would read about 48.
        const late = await muxedWithAudio(WebMMuxer, 'mkv', { pictures: 1400, audioStart: 11 });
        const head = 40 * PROBE_MIB;
        let past = 0;
        const early = await thumbnail(
            {
                size: late.size,
                read(offset, length) {
                    past += Math.max(0, offset + length - Math.max(offset, head));
                    return late.read(offset, length);
                },
            },
            { time: 2, width: 32 },
        );
        assert.ok(early.blob.size > 0);
        assert.ok(past < PROBE_MIB, `a thumbnail read ${past} bytes past 40 probe MiB`);
    });

    for (const [Muxer, format] of [
        [WebMMuxer, 'mkv'],
        [TsMuxer, 'ts'],
    ])
        describe(`packets() of a described ${format}`, () => {
            // Media.packets() of an input open() described from its ends reads it once, in one
            // pass, and hands the packets its index holds.
            const input = once(() => muxedWithAudio(Muxer, format, { pictures: 600 }));
            const row = packet => [
                packet.trackId,
                packet.timestamp,
                packet.decodeTimestamp,
                packet.duration,
                packet.isKeyframe,
                createHash('sha1').update(packet.data).digest('base64'),
            ];
            const expected = once(async () => {
                const indexed = await (await engineWith([])).open(await input());
                const rows = [];
                for await (const packet of indexed.packets({}, 'owned')) rows.push(row(packet));
                indexed.close();
                return rows;
            });
            /** The input with a block, or a transport packet, losing its header mid-file. */
            const damaged = once(async () => {
                const source = await input();
                const bytes = new Uint8Array(await source.read(0, source.size));
                const middle = bytes.length >> 1;
                if (format === 'mkv') {
                    const clusterId = Buffer.of(0x1f, 0x43, 0xb6, 0x75);
                    const cluster = Buffer.from(bytes.buffer).indexOf(clusterId, middle);
                    const block = bytes.indexOf(0xa3, cluster + 12);
                    bytes.fill(0, block, block + 8);
                } else bytes[middle - (middle % 188)] = 0;
                return new BufferSource(bytes, { copy: false });
            });
            const openDamaged = async () => {
                const heard = [];
                const media = await open(await damaged(), { onWarning: item => heard.push(item) });
                return { media, heard };
            };
            /** The warnings of a read of the damaged input's index. */
            const indexWarnings = once(async () => {
                const { media, heard } = await openDamaged();
                for await (const packet of media.packets({ start: 0 })) void packet;
                const { warnings } = media;
                media.close();
                assert.ok(warnings.some(item => item.code.endsWith('_RESYNCHRONIZED')));
                assert.deepEqual(heard, warnings);
                return warnings;
            });

            test('is one pass with the packets of the index', async () => {
                const source = await input();
                const { counter, source: countedSource } = counted(source);
                const media = await open(countedSource);
                const passed = [];
                try {
                    for await (const packet of media.packets()) passed.push(row(packet));
                } finally {
                    media.close();
                }
                assert.deepEqual(passed, await expected());
                // The probe the open reads and the pass reads again, and the input once.
                assert.ok(
                    counter.bytes <= 2 * (await probeBytes(source)) + source.size,
                    `read ${counter.bytes} bytes`,
                );
            });

            test('a failed read of the index fails that call only', async () => {
                // Here on a source one byte short.
                const source = await input();
                let short = false;
                const flaky = await open(
                    {
                        size: source.size,
                        async read(offset, length) {
                            const bytes = await source.read(offset, length);
                            return short ? bytes.subarray(0, bytes.length - 1) : bytes;
                        },
                    },
                    { cacheBytes: 0 },
                );
                const indexPackets = async () => {
                    const packets = [];
                    for await (const packet of flaky.packets({ start: 0 }))
                        packets.push(row(packet));
                    return packets;
                };
                try {
                    short = true;
                    await assert.rejects(indexPackets());
                    short = false;
                    assert.deepEqual(await indexPackets(), await expected());
                } finally {
                    flaky.close();
                }
            });

            test('an abort stops a pass at the next packet', async () => {
                // Not past the cluster or the transport packets the pass read it with.
                const media = await open(await input());
                const controller = new AbortController();
                let handed = 0;
                try {
                    await assert.rejects(
                        async () => {
                            for await (const packet of media.packets({
                                signal: controller.signal,
                            })) {
                                void packet;
                                if (++handed === 100) controller.abort();
                            }
                        },
                        { code: 'ABORT' },
                    );
                } finally {
                    media.close();
                }
                assert.equal(handed, 100);
            });

            test('the damage a pass reads past is reported as its index reports it', async () => {
                // media.warnings lists what the index does, in its order, and the listener hears
                // each once, also when the index is read after the pass.
                const warnings = await indexWarnings();
                const { media, heard } = await openDamaged();
                try {
                    for await (const packet of media.packets()) void packet;
                    assert.deepEqual(media.warnings, warnings, 'a pass');
                    for await (const packet of media.packets({ start: 0 })) void packet;
                    assert.deepEqual(media.warnings, warnings, 'the index after a pass');
                    assert.deepEqual(heard, warnings, 'the listener');
                } finally {
                    media.close();
                }
            });

            test('a pass stopped past the damage reports what it read', async () => {
                // As one read to the end does.
                const warnings = await indexWarnings();
                const counting = await openDamaged();
                let total = 0;
                for await (const packet of counting.media.packets()) total += packet ? 1 : 0;
                counting.media.close();
                const { media, heard } = await openDamaged();
                let read = 0;
                try {
                    for await (const packet of media.packets()) {
                        void packet;
                        if (++read === Math.floor(total * 0.8)) break;
                    }
                    assert.deepEqual(media.warnings, warnings);
                    assert.deepEqual(heard, warnings);
                } finally {
                    media.close();
                }
            });
        });
});
