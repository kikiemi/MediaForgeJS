import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { inspect, open } from 'mediaforgejs';
import { Mp4Demuxer, Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { manyFragmentsMp4 } from '../helpers/huge-sources.mjs';
import { reorderFixture } from '../helpers/avi-h264-reorder-fixtures.mjs';
import { idr, join, lengthPrefixed, pps, predicted, sps } from '../helpers/avi-h264-fixtures.mjs';
import { copied, readAll, rejectsStrict } from '../helpers/read-media.mjs';

// Reading MP4 and QuickTime movies: the sample tables, movie boxes damage or old writers left out
// of shape, fragments, and H.264 samples that do not hold one access unit each.

/** The offset of the first box of `type` in `bytes`. */
const boxAt = (bytes, type, from = 0) => Buffer.from(bytes).indexOf(type, from) - 4;
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const milliseconds = value => Math.round(value * 1000);

/** The avcC record of the shared H.264 parameter sets. */
const AVC_CONFIG = join([1, 66, 0, 10, 0xff, 0xe1, 0, sps.length], sps, [1, 0, pps.length], pps);

/**
 * A standard MP4 of H.264 `samples` ({ data, config, key }) 40 ms apart, each with the
 * configuration it is coded with.
 */
async function h264Mp4(samples) {
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
                codec: 'avc1.42000a',
                width: 32,
                height: 16,
                codecConfig: samples[0].config,
                codecConfigChanges: true,
            },
        },
        sink,
    );
    samples.forEach(({ data, config, key }, index) =>
        muxer.addVideoChunk(
            { trackType: 'video', data, timestamp: index * 0.04, duration: 0.04, isKeyframe: key },
            config,
        ),
    );
    await muxer.finalize();
    return sink.toUint8Array();
}

/** NAL unit types of a four-byte length-prefixed sample. */
const nalTypes = data => {
    const types = [];
    for (let at = 0; at + 4 <= data.length; at += 4 + viewOf(data).getUint32(at))
        types.push(data[at + 4] & 31);
    return types;
};

/** `bytes` without the `nth` box of `type`, the boxes holding it left as they were. */
const without = (bytes, type, nth = 0) => {
    let at = -1;
    for (let index = 0; index <= nth; index++) at = Buffer.from(bytes).indexOf(type, at + 1);
    const start = at - 4;
    return join(bytes.subarray(0, start), bytes.subarray(start + viewOf(bytes).getUint32(start)));
};

/** An MP4 of the video and audio of the MPEG-TS fixture, its movie box after the media. */
const audioVideoMp4 = () => copied(fixtures['ts-av.ts'](), 'mp4');

describe('mp4: reading', () => {
    describe('sample tables', () => {
        // Six AAC samples of 1 to 6 ms, one time-to-sample run each.
        const payloads = Array.from({ length: 6 }, (_, index) =>
            Uint8Array.of(0x21, index, 0x10, 0x04),
        );
        const TIMES = [0, 0.001, 0.003, 0.006, 0.01, 0.015];
        const DURATIONS = [0.001, 0.002, 0.003, 0.004, 0.005, 0.006];
        async function sixSamples() {
            const sink = new MemorySink();
            const writer = new Mp4Muxer(
                {
                    format: 'mp4',
                    audio: {
                        codec: 'mp4a.40.2',
                        sampleRate: 48000,
                        channelCount: 1,
                        codecConfig: Uint8Array.of(0x11, 0x88),
                    },
                },
                sink,
            );
            let timestamp = 0;
            payloads.forEach((data, index) => {
                const duration = (index + 1) / 1000;
                writer.addAudioChunk({
                    trackType: 'audio',
                    data,
                    timestamp,
                    duration,
                    isKeyframe: true,
                });
                timestamp += duration;
            });
            await writer.finalize();
            return sink.toUint8Array();
        }
        /** The offset of the sample table box `type` of the first track. */
        function tableOffset(bytes, type) {
            const view = viewOf(bytes);
            let start = 0;
            let end = bytes.length;
            // A size of 1 is followed by a 64-bit size.
            const sizeAt = at =>
                view.getUint32(at) === 1 ? Number(view.getBigUint64(at + 8)) : view.getUint32(at);
            for (const wanted of ['moov', 'trak', 'mdia', 'minf', 'stbl', type]) {
                let offset = start;
                while (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) !== wanted)
                    offset += sizeAt(offset);
                assert.ok(offset + 8 <= end, `${wanted} box`);
                start = offset + 8;
                end = offset + sizeAt(offset);
            }
            return start - 8;
        }
        /** The six samples with the table `type` changed by `mutate(view, offset)`. */
        const changed = async (type, mutate) => {
            const bytes = await sixSamples();
            mutate(viewOf(bytes), tableOffset(bytes, type));
            return bytes;
        };
        const skipsFirstChunk = () => changed('stsc', (view, at) => view.setUint32(at + 16, 2));
        const firstRunTooLong = () => changed('stts', (view, at) => view.setUint32(at + 16, 7));
        const lastRunTooLong = () =>
            changed('stts', (view, at) => view.setUint32(at + 16 + 5 * 8, 2));
        const emptyRuns = () =>
            changed('stts', (view, at) => {
                const runs = [
                    [0, 777],
                    [2, 0],
                    [0, 555],
                    [1, 96],
                    [3, 0],
                    [0, 999],
                ];
                runs.forEach(([count, delta], index) => {
                    view.setUint32(at + 16 + index * 8, count);
                    view.setUint32(at + 20 + index * 8, delta);
                });
            });

        // open() and inspect() read the tables into a compact index; Mp4Demuxer.demux(), strict
        // without a diagnostics context, into a sample array.
        const PATHS = [
            [
                'open()',
                async (bytes, validation = 'compatible') => {
                    const info = await inspect(bytes, { open: { validation }, sampleCounts: true });
                    const media = await open(bytes, { validation });
                    try {
                        const packets = [];
                        for await (const packet of media.packets()) packets.push(packet);
                        return [info.tracks[0].sampleCount, packets];
                    } finally {
                        media.close();
                    }
                },
            ],
            [
                'Mp4Demuxer',
                async bytes => {
                    const result = await new Mp4Demuxer().demux(new Blob([bytes]));
                    const samples = result.audioTracks[0].samples;
                    return [
                        samples.length,
                        samples.map(sample => ({
                            ...sample,
                            data: bytes.slice(sample.offset, sample.offset + sample.size),
                        })),
                    ];
                },
            ],
        ];
        for (const [path, read] of PATHS) {
            const timing = async bytes => {
                const [count, packets] = await read(bytes);
                assert.equal(count, 6);
                assert.deepEqual(
                    packets.map(packet => packet.data),
                    payloads,
                );
                return packets.map(packet => [packet.timestamp, packet.duration]);
            };

            test(`${path} times each sample by its time-to-sample run`, async () => {
                assert.deepEqual(
                    await timing(await sixSamples()),
                    TIMES.map((time, index) => [time, DURATIONS[index]]),
                );
            });

            test(`${path} reads empty time-to-sample runs as no samples`, async () => {
                const expected = [
                    [0, 0.001],
                    [0, 0.001],
                    [0, 0.002],
                    [0.002, 0.002],
                    [0.002, 0.002],
                    [0.002, 0.002],
                ];
                assert.deepEqual(await timing(await emptyRuns()), expected);
            });

            test(`${path} rejects a chunk table that skips the first chunk`, async () => {
                await assert.rejects(read(await skipsFirstChunk()), { code: 'DEMUX' });
            });

            test(`${path} rejects a first run that outlasts the track`, async () => {
                await assert.rejects(read(await firstRunTooLong()), { code: 'DEMUX' });
            });
        }

        test('a last run that outlasts the track keeps the timing, unless strict', async () => {
            const [[, read], [, demux]] = PATHS;
            const [, packets] = await read(await lastRunTooLong());
            assert.deepEqual(
                packets.map(packet => [packet.timestamp, packet.duration]),
                TIMES.map((time, index) => [time, DURATIONS[index]]),
            );
            await assert.rejects(read(await lastRunTooLong(), 'strict'), { code: 'DEMUX' });
            await assert.rejects(demux(await lastRunTooLong()), { code: 'DEMUX' });
        });

        test('strict validation rejects the tables compatible reading rejects', async () => {
            const read = PATHS[0][1];
            await assert.rejects(read(await skipsFirstChunk(), 'strict'), { code: 'DEMUX' });
            await assert.rejects(read(await firstRunTooLong(), 'strict'), { code: 'DEMUX' });
        });

        const bframes = () => fixtures['mp4-bframes.mp4']();

        test('composition offsets past the last sample are ignored, unless strict', async () => {
            const excess = bframes();
            const ctts = boxAt(excess, 'ctts');
            const lastRun = ctts + 16 + (viewOf(excess).getUint32(ctts + 12) - 1) * 8;
            viewOf(excess).setUint32(lastRun, viewOf(excess).getUint32(lastRun) + 3);
            const clamped = await readAll(excess);
            assert.deepEqual(clamped.warnings, ['MP4_CTTS_EXCESS']);
            assert.deepEqual(
                clamped.packets.map(packet => packet.timestamp),
                (await readAll(bframes())).packets.map(packet => packet.timestamp),
            );
            await rejectsStrict(excess);
        });

        test('time-to-sample entries past the last sample are ignored, unless strict', async () => {
            const timing = bframes();
            const stts = boxAt(timing, 'stts');
            const last = stts + 16 + (viewOf(timing).getUint32(stts + 12) - 1) * 8;
            viewOf(timing).setUint32(last, viewOf(timing).getUint32(last) + 1);
            const timed = await readAll(timing);
            assert.deepEqual(timed.warnings, ['MP4_STTS_EXCESS']);
            assert.deepEqual(timed.hashes, (await readAll(bframes())).hashes);
            await rejectsStrict(timing);
        });

        test('a time-to-sample table of the first samples times the rest alike', async () => {
            // The samples after the table continue its last duration.
            const short = classicMp4({ timing: [[3, 40]] }).bytes;
            const shortRead = await readAll(short);
            assert.deepEqual(shortRead.warnings, ['MP4_STTS_SHORT']);
            assert.deepEqual(
                shortRead.packets.map(packet => [packet.timestamp, packet.duration]),
                (await readAll(classicMp4().bytes)).packets.map(packet => [
                    packet.timestamp,
                    packet.duration,
                ]),
            );
            await rejectsStrict(short);
        });

        test('sync samples outside the track are ignored, unless strict', async () => {
            const sync = bframes();
            const stss = boxAt(sync, 'stss');
            viewOf(sync).setUint32(stss + 16 + (viewOf(sync).getUint32(stss + 12) - 1) * 4, 999);
            const synced = await readAll(sync);
            assert.deepEqual(synced.warnings, ['MP4_SYNC_TABLE']);
            assert.deepEqual(synced.hashes, (await readAll(bframes())).hashes);
            await rejectsStrict(sync);
        });

        test('an empty chunk holds no samples, and strict validation rejects it', async () => {
            // A sample-to-chunk row of zero samples per chunk for one more chunk offset.
            const source = bframes();
            const view = viewOf(source);
            const stsc = boxAt(source, 'stsc');
            const stco = boxAt(source, 'stco');
            assert.ok(stsc < stco);
            const stscEnd = stsc + view.getUint32(stsc);
            const stcoEnd = stco + view.getUint32(stco);
            const emptyRow = new Uint8Array(12);
            viewOf(emptyRow).setUint32(0, view.getUint32(stco + 12) + 1);
            viewOf(emptyRow).setUint32(8, 1);
            const chunked = join(
                source.subarray(0, stscEnd),
                emptyRow,
                source.subarray(stscEnd, stcoEnd),
                source.subarray(stcoEnd - 4, stcoEnd),
                source.subarray(stcoEnd),
            );
            for (const [type, grown, entries] of [
                ['stsc', 12, 1],
                ['stco', 4, 1],
                ['stbl', 16, 0],
                ['minf', 16, 0],
                ['mdia', 16, 0],
                ['trak', 16, 0],
                ['moov', 16, 0],
            ]) {
                const box = boxAt(chunked, type);
                const chunkedView = viewOf(chunked);
                chunkedView.setUint32(box, chunkedView.getUint32(box) + grown);
                if (entries)
                    chunkedView.setUint32(box + 12, chunkedView.getUint32(box + 12) + entries);
            }
            const emptyChunk = await readAll(chunked);
            assert.deepEqual(emptyChunk.warnings, []);
            assert.deepEqual(emptyChunk.hashes, (await readAll(source)).hashes);
            await rejectsStrict(chunked);
        });
    });

    describe('movie boxes out of shape', () => {
        test('bytes after a complete movie are an optional tail, even if strict', async () => {
            const movie = classicMp4().bytes;
            const padded = join(movie, [1, 2, 3]);
            const tail = await readAll(padded, { validation: 'strict' });
            assert.ok(tail.warnings.includes('MP4_OPTIONAL_TAIL'));
            assert.deepEqual(tail.hashes, (await readAll(movie)).hashes);
        });

        test('a file cut inside its file type box is rejected in strict reading', async () => {
            await rejectsStrict(classicMp4().bytes.subarray(0, 12));
        });

        test('a complete movie followed by the cut start of another keeps the first', async () => {
            // An interrupted append.
            const movie = fixtures['mp4-bframes.mp4']();
            const moov = boxAt(movie, 'moov');
            const appended = join(movie, movie.subarray(0, 32), movie.subarray(moov, moov + 64));
            const kept = await readAll(appended);
            assert.deepEqual(kept.warnings, ['MP4_TRUNCATED_TAIL']);
            assert.deepEqual(kept.hashes, (await readAll(movie)).hashes);
            await rejectsStrict(appended);
        });

        test('reads a QuickTime movie box compressed into cmov', async () => {
            // dcom 'zlib' and cmvd, the size of the movie box and its deflated bytes.
            const plain = await h264Mp4([{ data: lengthPrefixed(4, idr), config: AVC_CONFIG }]);
            const at = Buffer.from(plain).lastIndexOf('moov') - 4;
            const box = (type, ...parts) => {
                const body = join(...parts);
                const header = new Uint8Array(8);
                viewOf(header).setUint32(0, body.length + 8);
                header.set(new TextEncoder().encode(type), 4);
                return join(header, body);
            };
            const size = new Uint8Array(4);
            viewOf(size).setUint32(0, plain.length - at);
            const cmov = box(
                'cmov',
                box('dcom', new TextEncoder().encode('zlib')),
                box('cmvd', size, deflateSync(plain.subarray(at))),
            );
            const expected = await readAll(plain);
            const actual = await readAll(join(plain.subarray(0, at), box('moov', cmov)));
            assert.deepEqual(actual.hashes, expected.hashes);
            assert.equal(actual.tracks[0].codec, expected.tracks[0].codec);
        });

        describe('a trailing movie box cut by the end of the input', () => {
            // udta holding a complete QuickTime title and a comment the end of the input cuts.
            const cutInUdta = async () => {
                const plain = await h264Mp4([
                    { data: lengthPrefixed(4, idr), config: AVC_CONFIG, key: true },
                ]);
                const at = Buffer.from(plain).lastIndexOf('moov') - 4;
                assert.equal(viewOf(plain).getUint32(at), plain.length - at);
                const text = value => new TextEncoder().encode(value);
                const udta = join([0, 0, 0, 52], text('udta'), [0, 0, 0, 16, 0xa9], text('nam'));
                const item = join([0, 4, 0, 0], text('Kept'));
                const comment = join([0, 0, 0, 28, 0xa9], text('cmt'), new Uint8Array(20));
                const whole = join(plain, udta, item, comment);
                viewOf(whole).setUint32(at, whole.length - at);
                return { plain, whole };
            };

            test('inside its udta keeps the tracks and the complete title', async () => {
                const { plain, whole } = await cutInUdta();
                const cut = whole.subarray(0, whole.length - 10);
                const actual = await readAll(cut);
                assert.deepEqual(actual.hashes, (await readAll(plain)).hashes);
                assert.ok(actual.warnings.includes('MP4_TRUNCATED_MOOV'));
                assert.equal(actual.title, 'Kept');
                await rejectsStrict(cut);
            });

            test('before or inside the header of its udta loses the metadata only', async () => {
                const { plain, whole } = await cutInUdta();
                const expected = (await readAll(plain)).hashes;
                for (const kept of [0, 5]) {
                    const between = await readAll(whole.subarray(0, plain.length + kept));
                    assert.deepEqual(
                        [between.hashes, between.warnings],
                        [expected, ['MP4_TRUNCATED_MOOV']],
                    );
                }
            });

            test('before the media box of its only track leaves nothing to read', async () => {
                const { plain } = await cutInUdta();
                const trak = Buffer.from(plain).lastIndexOf('trak') - 4;
                await assert.rejects(readAll(plain.subarray(0, trak + 12)), /no mdia box/);
            });

            test('inside its second track keeps the complete first track', async () => {
                // The cut track keeps its complete boxes, which lack its sample tables, so it is
                // skipped, as ffmpeg reads it.
                const whole = await audioVideoMp4();
                const traks = [...Buffer.from(whole).toString('latin1').matchAll(/trak/g)].map(
                    match => match.index,
                );
                assert.ok(boxAt(whole, 'moov') > boxAt(whole, 'mdat') && traks.length === 2);
                const cut = whole.subarray(0, traks[1] + 40);
                const cutTrack = await readAll(cut);
                assert.deepEqual(cutTrack.warnings, ['MP4_TRUNCATED_MOOV', 'MP4_TRACK_SKIPPED']);
                assert.deepEqual(
                    cutTrack.tracks.map(track => track.type),
                    ['video'],
                );
                assert.equal(
                    cutTrack.packets.length,
                    (await readAll(whole)).packets.filter(packet => packet.trackId === 1).length,
                );
                await rejectsStrict(cut);
            });
        });

        test('the only track fails to open when its sample table is unreadable', async () => {
            const damaged = fixtures['3gp-esds.3gp']();
            damaged.set([0x7a, 0x7a, 0x7a, 0x7a], Buffer.from(damaged).indexOf('stbl'));
            await assert.rejects(open(damaged), { code: 'DEMUX' });
        });

        describe('a movie box that lost a box its parents still count', () => {
            // It runs past the end of the input or into the media; its sizes are repaired to end
            // where the next box starts, as ffmpeg reads it.
            const edited = () => classicMp4({ count: 40, edits: [[1600, 0]] });
            /** The movie box first, ahead of the media it places. */
            const faststart = () => {
                const movieLength = edited().bytes.length - edited().moovOffset;
                const fast = classicMp4({
                    count: 40,
                    edits: [[1600, 0]],
                    offsets: [24 + movieLength + 8],
                });
                return {
                    movieLength,
                    bytes: join(
                        fast.bytes.subarray(0, 24),
                        fast.bytes.subarray(fast.moovOffset),
                        fast.bytes.subarray(24, fast.moovOffset),
                    ),
                };
            };

            test('at the end of the input ends where the input does', async () => {
                const trailing = without(edited().bytes, 'edts');
                const repaired = await readAll(trailing);
                assert.deepEqual(
                    [repaired.hashes, repaired.warnings],
                    [(await readAll(edited().bytes)).hashes, ['MP4_MOVIE_REPAIRED']],
                );
                await rejectsStrict(trailing);
            });

            test('ahead of the media ends where the media starts', async () => {
                const expected = (await readAll(edited().bytes)).hashes;
                assert.deepEqual((await readAll(faststart().bytes)).hashes, expected);
                const leading = without(faststart().bytes, 'edts');
                const moved = await readAll(leading);
                assert.deepEqual(
                    [moved.hashes, moved.warnings],
                    [expected, ['MP4_MOVIE_REPAIRED']],
                );
                await rejectsStrict(leading);
            });

            test('names a track that lost its hdlr by its media header', async () => {
                // smhd: a sound track, as ffmpeg reads it.
                const whole = await audioVideoMp4();
                const intact = await readAll(whole);
                const unnamed = await readAll(without(whole, 'hdlr', 1));
                assert.deepEqual(
                    [unnamed.tracks.map(track => track.type), unnamed.hashes, unnamed.warnings],
                    [
                        intact.tracks.map(track => track.type),
                        intact.hashes,
                        ['MP4_MOVIE_REPAIRED', 'MP4_HANDLER_INFERRED'],
                    ],
                );
            });

            test('repairs every box a gained box overran, not the track box alone', async () => {
                // A box the first track's minf gained, as long as the last box of its sample
                // table: the track box alone chains to its end with that last box as a stray
                // child, but leaves the minf overrun.
                const whole = await audioVideoMp4();
                const sizeAt = at => viewOf(whole).getUint32(at);
                const stbl = boxAt(whole, 'stbl', boxAt(whole, 'minf'));
                let last = stbl + 8;
                while (last + sizeAt(last) < stbl + sizeAt(stbl)) last += sizeAt(last);
                const free = new Uint8Array(sizeAt(last));
                viewOf(free).setUint32(0, free.length);
                free.set(Buffer.from('free'), 4);
                const gained = await readAll(
                    join(whole.subarray(0, stbl), free, whole.subarray(stbl)),
                );
                assert.deepEqual(
                    [gained.hashes, gained.warnings],
                    [(await readAll(whole)).hashes, ['MP4_MOVIE_REPAIRED']],
                );
            });

            test('an unreadable box header after the movie box leaves the samples', async () => {
                // The samples are read where the movie box places them, as ffmpeg reads them.
                const { movieLength, bytes } = faststart();
                bytes.fill(0xff, 24 + movieLength, 24 + movieLength + 8);
                const placed = await readAll(bytes);
                assert.deepEqual(
                    [placed.hashes, placed.warnings],
                    [(await readAll(edited().bytes)).hashes, ['MP4_DAMAGED_BOX']],
                );
            });
        });

        test('a first box of media bytes leading to the movie box is QuickTime', async () => {
            // Old QuickTime movies whose first box type is media bytes: a size leading exactly to
            // the movie box makes the input QuickTime, and the samples are counted from the start.
            const intact = classicMp4().bytes;
            const unnamed = intact.slice();
            assert.equal(Buffer.from(unnamed).indexOf('moov'), 60);
            viewOf(unnamed).setUint32(0, 56);
            unnamed.set([0x82, 0x82, 0x7f, 0x7d], 4);
            const media = await readAll(unnamed);
            assert.deepEqual(
                [media.warnings, media.hashes],
                [['MP4_UNNAMED_MEDIA_BOX'], (await readAll(intact)).hashes],
            );
            await rejectsStrict(unnamed);
        });
    });

    describe('fragments', () => {
        test('a fragment that goes back in time replaces what it codes again', async () => {
            // Its tfdt goes back into the previous fragment: the earlier samples from its decode
            // time on are dropped, so decode times keep increasing.
            const fragmented = manyFragmentsMp4({ fragments: 4 });
            const overlapping = await fragmented.read(0, fragmented.size);
            let tfdt = -1;
            for (let index = 0; index < 3; index++)
                tfdt = Buffer.from(overlapping).indexOf('tfdt', tfdt + 1);
            viewOf(overlapping).setBigUint64(tfdt + 8, 1024n);
            const overlapRead = await readAll(overlapping);
            assert.deepEqual(overlapRead.warnings, ['MP4_FRAGMENT_OVERLAP']);
            assert.deepEqual(
                overlapRead.packets.map(packet => [packet.timestamp * 48000, packet.data[0]]),
                [
                    [0, 0],
                    [1024, 2],
                    [3072, 3],
                ],
            );
            await rejectsStrict(overlapping);
        });
    });

    describe('H.264 samples', () => {
        test('an avcC record stored as the first sample is dropped', async () => {
            // It holds no picture, so copies that frame NAL units hold the pictures only.
            const withRecord = await h264Mp4([
                { data: AVC_CONFIG, config: AVC_CONFIG, key: true },
                { data: lengthPrefixed(4, idr), config: AVC_CONFIG, key: true },
                { data: lengthPrefixed(4, predicted), config: AVC_CONFIG, key: false },
            ]);
            const pictures = await readAll(withRecord);
            assert.deepEqual(pictures.warnings, ['MP4_CONFIG_SAMPLE']);
            assert.deepEqual(
                pictures.packets.map(packet => [packet.timestamp, nalTypes(packet.data)]),
                [
                    [0.04, [5]],
                    [0.08, [1]],
                ],
            );
            for (const format of ['ts', 'flv', 'fmp4'])
                assert.equal(
                    (await readAll(await copied(withRecord, format))).packets.length,
                    2,
                    format,
                );
        });

        describe('sample descriptions switched by the chunk table', () => {
            // Standard MP4 whose H.264 track switches stsd entries: the samples carry their
            // configuration.
            const { sps: otherSps, pps: otherPps, config: other } = reorderFixture();
            const frames = [
                lengthPrefixed(4, idr),
                lengthPrefixed(4, predicted),
                lengthPrefixed(4, idr),
            ];
            const switching = () =>
                h264Mp4([
                    { data: frames[0], config: AVC_CONFIG, key: true },
                    { data: frames[1], config: AVC_CONFIG, key: false },
                    { data: frames[2], config: other, key: true },
                ]);

            test('each packet carries the configuration of its description', async () => {
                const { tracks, packets } = await readAll(await switching());
                assert.deepEqual(tracks[0].codecConfig, AVC_CONFIG);
                assert.deepEqual(
                    packets.map(packet => packet.codecConfig),
                    [AVC_CONFIG, AVC_CONFIG, other],
                );
            });

            test('an MP4 copy keeps one description per configuration', async () => {
                const source = await switching();
                const again = await readAll(await copied(source, 'mp4'));
                assert.deepEqual(
                    again.packets.map(packet => [packet.codecConfig, packet.data]),
                    (await readAll(source)).packets.map(packet => [
                        packet.codecConfig,
                        packet.data,
                    ]),
                );
            });

            test('a Matroska copy sends the new parameter sets in band', async () => {
                // Where the configuration changes, and at later keyframes.
                const matroska = await readAll(await copied(await switching(), 'mkv'));
                assert.deepEqual(matroska.tracks[0].codecConfig, AVC_CONFIG);
                assert.deepEqual(matroska.packets[1].data, frames[1]);
                assert.deepEqual(
                    matroska.packets[2].data,
                    join(lengthPrefixed(4, otherSps, otherPps), frames[2]),
                );
            });
        });

        test('samples of SEI or parameter sets alone join the next picture', async () => {
            // ISO/IEC 14496-15 wants one access unit, with its picture, per sample. Keyframes
            // follow the IDR picture rather than a sync sample table that lists the SEI sample and
            // a P picture but not the IDR picture; every copy keeps three pictures.
            const sei = Uint8Array.of(6, 1, 1, 0, 0x80);
            const source = await h264Mp4([
                { data: lengthPrefixed(4, sei), config: AVC_CONFIG, key: true },
                { data: lengthPrefixed(4, predicted), config: AVC_CONFIG, key: false },
                { data: lengthPrefixed(4, sps, pps), config: AVC_CONFIG, key: false },
                { data: lengthPrefixed(4, idr), config: AVC_CONFIG, key: false },
                { data: lengthPrefixed(4, predicted), config: AVC_CONFIG, key: true },
            ]);
            const joined = await readAll(source);
            assert.deepEqual(joined.warnings, ['MP4_PICTURELESS_SAMPLES']);
            assert.deepEqual(
                joined.packets.map(packet => [
                    milliseconds(packet.timestamp),
                    milliseconds(packet.duration),
                    packet.isKeyframe,
                    nalTypes(packet.data),
                ]),
                [
                    [40, 80, false, [6, 1]],
                    [120, 40, true, [7, 8, 5]],
                    [160, 40, false, [1]],
                ],
            );
            for (const format of ['mp4', 'mkv', 'ts'])
                assert.deepEqual(
                    (await readAll(await copied(source, format))).packets.map(
                        packet => packet.isKeyframe,
                    ),
                    [false, true, false],
                    format,
                );
        });

        test('Annex B start codes in a length-prefixed track read length-prefixed', async () => {
            // Some writers store them; ffmpeg's decoder reads them as Annex B. Copies and decoders
            // see the framing the configuration declares.
            const samples = [lengthPrefixed(4, idr), lengthPrefixed(4, predicted)];
            const bytes = await h264Mp4(
                samples.map((data, index) => ({ data, config: AVC_CONFIG, key: !index })),
            );
            for (const nal of [idr, predicted])
                bytes.set([0, 0, 0, 1], Buffer.from(bytes).indexOf(Buffer.from(nal)) - 4);
            const expected = samples.map(data => [...data]);
            assert.deepEqual(
                (await readAll(bytes)).packets.map(packet => [...packet.data]),
                expected,
            );
            assert.deepEqual(
                (await readAll(await copied(bytes, 'ts'))).packets.map(packet => [...packet.data]),
                expected,
                'the MPEG-TS copy carries the pictures with the parameter sets a decoder needs',
            );
        });

        test('a pixel aspect of zero spacing is square, and copies into Matroska', async () => {
            // A camera's "unspecified", as ffmpeg reads it.
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
                        codec: 'avc1.42000a',
                        width: 32,
                        height: 16,
                        codecConfig: AVC_CONFIG,
                        pixelAspectRatioNum: 4,
                        pixelAspectRatioDen: 3,
                    },
                },
                sink,
            );
            muxer.addVideoChunk({
                trackType: 'video',
                data: lengthPrefixed(4, idr),
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
            });
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            const pasp = Buffer.from(bytes).indexOf('pasp');
            assert.ok(pasp > 0);
            viewOf(bytes).setUint32(pasp + 4, 0);
            const source = await readAll(bytes);
            const { pixelAspectRatioNum, pixelAspectRatioDen, displayWidth } = source.tracks[0];
            assert.deepEqual([pixelAspectRatioNum, pixelAspectRatioDen, displayWidth], [1, 1, 32]);
            assert.deepEqual((await readAll(await copied(bytes, 'mkv'))).hashes, source.hashes);
        });
    });
});
