import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { TsDemuxer, TsMuxer } from 'mediaforgejs/formats';
import { encodeMp3 } from 'mediaforgejs/codecs';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import {
    Bits,
    annexB,
    aud,
    idr,
    join,
    lengthPrefixed,
    nal,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { AAC_PAYLOADS, adtsFrame, concat } from '../helpers/original-fixtures.mjs';
import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    ac3Frame,
    mpeg2Gop,
    mpeg4Config,
    mpeg4Vop,
    mpegSequence,
    transportStream,
} from '../helpers/mpeg-video-fixtures.mjs';
import { readAll, rejectsStrict, sha256 } from '../helpers/read-media.mjs';
import { readFileSync } from 'node:fs';
import {
    XLL_SYNC,
    dtsCore,
    dtsSubstream,
    eac3Frame,
    truehdUnit,
    tsOpusUnit,
} from '../helpers/sync-audio-fixtures.mjs';

const hex = bytes => Buffer.from(bytes).toString('hex');
const pidAt = (bytes, offset) => ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
/** The transport packets of `bytes` whose PID `keep` accepts. */
function withPackets(bytes, keep) {
    const kept = [];
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188)
        if (keep(pidAt(bytes, offset))) kept.push(bytes.subarray(offset, offset + 188));
    return new Uint8Array(Buffer.concat(kept));
}
/** A slice of the length of `size` bytes, as a picture's slice data. */
const largeSlice = size => join([0x41], new Uint8Array(size).fill(0x55), [0x80]);
/** An H.264 stream of one PID (0x100) of `pictures` ({ payload, pts, dts }). */
const h264Transport = pictures =>
    transportStream(
        [{ pid: 0x100, streamType: 0x1b }],
        pictures.map(picture => ({ pid: 0x100, streamId: 0xe0, ...picture })),
    );
/** The AAC stream of AAC_PAYLOADS as ADTS frames. */
const adtsStream = () => Buffer.concat(AAC_PAYLOADS.map(payload => adtsFrame(payload)));
/** One audio PID (0x101) whose PES packets cut `bytes` at `cuts`, stamped every `tick` ticks. */
const audioTransport = (bytes, cuts, stamps, { streamType = 0x0f, tick = 1920 } = {}) =>
    transportStream(
        [{ pid: 0x101, streamType }],
        cuts.slice(1).map((end, index) => ({
            pid: 0x101,
            streamId: 0xc0,
            payload: bytes.subarray(cuts[index], end),
            pts: 90000 + stamps[index] * tick,
        })),
    );
/** An MP2 frame of 576 bytes (48 kHz, 192 kbit/s) marked with `index`. */
function mp2Frame(index) {
    const frame = new Uint8Array(576);
    frame.set([0xff, 0xfd, 0xa4, 0x00, index]);
    return frame;
}

/**
 * A LOAS AudioMuxElement of `payload`, with a StreamMuxConfig of AAC-LC at 48 kHz in `channels`
 * channels when `config`.
 */
function loasFrame(payload, { config = true, channels = 1 } = {}) {
    const bits = [];
    const put = (value, count) => {
        for (let bit = count - 1; bit >= 0; bit--) bits.push((value >> bit) & 1);
    };
    put(config ? 0 : 1, 1);
    if (config) {
        put(0b01, 2);
        put(0, 6 + 4 + 3);
        put(0b00010_0011, 9);
        put(channels, 4);
        put(0, 3 + 3);
        put(0xff, 8);
        put(0, 2);
    }
    put(payload.length, 8);
    for (const byte of payload) put(byte, 8);
    while (bits.length % 8) bits.push(0);
    const body = Uint8Array.from({ length: bits.length / 8 }, (_, index) =>
        bits.slice(index * 8, index * 8 + 8).reduce((value, bit) => value * 2 + bit, 0),
    );
    return Uint8Array.from([0x56, 0xe0 | (body.length >> 8), body.length & 255, ...body]);
}

const MPEG_VIDEO_STREAMS = {
    '0x01': { codec: 'mp4v.6a', units: mpeg2Gop({ sequence: mpegSequence(), mpeg1: true }) },
    '0x02': { codec: 'mp4v.61', units: mpeg2Gop() },
    '0x10': {
        codec: 'mp4v.20.1',
        units: [
            [PICTURE_I, 0, 3600],
            [PICTURE_P, 3600, 10800],
            [PICTURE_B, 7200, 7200],
        ].map(([type, dts, pts], index) => ({
            type,
            dts: 90000 + dts,
            pts: 90000 + pts,
            data: index === 0 ? Buffer.concat([mpeg4Config(), mpeg4Vop(type)]) : mpeg4Vop(type),
        })),
    },
};
/** One MPEG video PID of `streamType` carrying `units`, B pictures without a decode time. */
const mpegTransport = (streamType, units) =>
    transportStream(
        [{ pid: 0x100, streamType }],
        units.map(unit => ({
            pid: 0x100,
            streamId: 0xe0,
            payload: unit.data,
            pts: unit.pts,
            dts: unit.type === PICTURE_B ? undefined : unit.dts,
        })),
    );

describe('mpeg-ts: reading', () => {
    describe('transport and tables', () => {
        test('an M2TS file of 192-byte packets reads its AAC', async () => {
            const { tracks, packets } = await readAll(fixtures['m2ts-aac.m2ts']());
            assert.deepEqual(
                tracks.map(track => track.codec),
                ['mp4a.40.2'],
            );
            assert.equal(packets.length, 2);
        });

        test('after damaged sync bytes, the frame whose header survived is kept', async () => {
            const source = fixtures['ts-aac.ts']();
            const intact = await readAll(source);
            assert.equal(intact.packets.length, 3);
            const damaged = source.slice();
            const count = Math.floor(source.length / 188);
            damaged.fill(0, 188 * (count - 2) + 20, 188 * (count - 1) + 20);
            const recovered = await readAll(damaged);
            assert.ok(recovered.warnings.includes('TS_RESYNCHRONIZED'), recovered.warnings.join());
            assert.ok(recovered.packets.length >= 1 && recovered.packets.length < 3);
            // The frame whose payload was zeroed keeps its intact header and is delivered damaged,
            // as ffprobe delivers it.
            assert.equal(recovered.hashes[0], intact.hashes[0]);
            await rejectsStrict(damaged);
        });

        test('a damaged PMT is skipped for its next repetition', async () => {
            const av = fixtures['ts-av.ts']();
            const intact = await readAll(av);
            assert.equal(intact.tracks.length, 2);
            const damaged = av.slice();
            let pmt = 0;
            while (pidAt(av, pmt) !== 0x1000) pmt += 188;
            damaged[pmt + 5 + 6] = 0x09;
            const later = await readAll(damaged);
            assert.ok(later.warnings.includes('TS_PSI_DAMAGED'), later.warnings.join());
            assert.equal(later.packets.length, intact.packets.length);
            await rejectsStrict(damaged);
        });

        test('a declared stream without packets is left out with a warning', async () => {
            const videoOnly = withPackets(fixtures['ts-av.ts'](), pid => pid !== 257);
            const omitted = await readAll(videoOnly);
            assert.ok(omitted.warnings.includes('TS_EMPTY_STREAM'), omitted.warnings.join());
            assert.deepEqual(
                omitted.tracks.map(track => track.type),
                ['video'],
            );
            await rejectsStrict(videoOnly);
        });

        test('without PAT and PMT, streams are found from their PES packets', async () => {
            const av = fixtures['ts-av.ts']();
            const withPsi = await readAll(av);
            const orphans = withPackets(av, pid => pid !== 0 && pid !== 0x1000);
            const read = await readAll(orphans);
            assert.deepEqual(read.warnings, ['TS_PSI_MISSING']);
            assert.deepEqual(
                read.tracks.map(track => track.codec),
                withPsi.tracks.map(track => track.codec),
            );
            assert.deepEqual(read.hashes, withPsi.hashes);
            await rejectsStrict(orphans);
        });

        test('a marked PAT is read and a private stream known by its payload', async () => {
            const stream = adtsStream();
            const marked = await readAll(
                transportStream(
                    [
                        {
                            pid: 0x101,
                            streamType: 0x0f,
                            descriptors: [0x0a, 4, 0x65, 0x6e, 0x67, 0],
                        },
                        { pid: 0x102, streamType: 0x06, descriptors: [0x52, 1, 5] },
                        {
                            pid: 0x103,
                            streamType: 0x0f,
                            descriptors: [
                                ...[0x0a, 4, 0x69, 0x74, 0x61, 3],
                                ...[0x7f, 5, 6, 0x87, 0x65, 0x6e, 0x67],
                            ],
                        },
                    ],
                    [
                        { pid: 0x101, streamId: 0xc0, payload: stream, pts: 90000 },
                        { pid: 0x102, streamId: 0xbd, payload: stream, pts: 90000 },
                        { pid: 0x103, streamId: 0xc1, payload: stream, pts: 90000 },
                    ],
                    { patFlags: 0xf0 },
                ),
            );
            // The private stream is identified from its payload; the third takes the language of
            // its supplementary audio descriptor.
            assert.deepEqual(marked.warnings, []);
            assert.deepEqual(
                marked.tracks.map(track => [track.codec, track.language]),
                [
                    ['mp4a.40.2', 'eng'],
                    ['mp4a.40.2', undefined],
                    ['mp4a.40.2', 'eng'],
                ],
            );
        });

        for (const validation of ['compatible', 'strict'])
            test(`a PMT update that adds a stream adds its track (${validation})`, async () => {
                const stream = adtsStream();
                const update = transportStream(
                    [{ pid: 0x102, streamType: 0x0f }],
                    [{ pid: 0x102, streamId: 0xc0, payload: stream, pts: 99000 }],
                );
                update[188 + 3] |= 1;
                const updated = join(
                    transportStream(
                        [{ pid: 0x101, streamType: 0x0f }],
                        [{ pid: 0x101, streamId: 0xc0, payload: stream, pts: 90000 }],
                    ),
                    update,
                );
                const programmes = await readAll(updated, { validation });
                assert.deepEqual(programmes.warnings, ['TS_PMT_UPDATED']);
                assert.deepEqual(
                    programmes.tracks.map(
                        track =>
                            programmes.packets.filter(packet => packet.trackId === track.id).length,
                    ),
                    [AAC_PAYLOADS.length, AAC_PAYLOADS.length],
                );
            });

        test('a program whose PMT never appears gives way to the next one', async () => {
            const programs = fixtures['ts-two-programs.ts']();
            const first = await readAll(programs);
            assert.deepEqual(
                first.tracks.map(track => track.type),
                ['video'],
            );
            for (let at = 0; at + 188 <= programs.length; at += 188)
                if (pidAt(programs, at) === 0x1000) {
                    programs[at + 1] = (programs[at + 1] & 0xe0) | 0x1f;
                    programs[at + 2] = 0xff;
                }
            const second = await readAll(programs);
            assert.deepEqual(second.warnings, ['TS_PROGRAM_SELECTED']);
            assert.deepEqual(
                second.tracks.map(track => track.codec),
                ['mp2'],
            );
        });
    });

    describe('PES packets', () => {
        test('a PES cut by the end keeps its whole frames, marked incomplete', async () => {
            const source = fixtures['ts-aac.ts']();
            const intact = await readAll(source);
            const partial = await readAll(source.subarray(0, 188 * 5 + 100));
            assert.ok(partial.warnings.includes('TS_TRUNCATED_PES'), partial.warnings.join());
            assert.ok(partial.packets.length >= 1);
            assert.deepEqual(partial.hashes, intact.hashes.slice(0, partial.packets.length));
            assert.equal(partial.tracks[0].incomplete, true);
            assert.equal(intact.tracks[0].incomplete, undefined);
        });

        test('a packet flagged with a transport error keeps its payload', async () => {
            // Receivers flag the packets whose errors they could not correct.
            const source = fixtures['ts-aac.ts']();
            const flagged = source.slice();
            let at = 0;
            while (pidAt(flagged, at) !== 0x100) at += 188;
            flagged[at + 1] |= 0x80;
            const kept = await readAll(flagged);
            assert.deepEqual(kept.warnings, ['TS_PES_TRANSPORT_ERROR']);
            assert.deepEqual(kept.hashes, (await readAll(source)).hashes);
            await rejectsStrict(flagged);
        });

        test('a wrong PES length field keeps the complete PES, unless strict', async () => {
            // Muxers write a length for long video PES too.
            const av = fixtures['ts-av.ts']();
            const wrong = av.slice();
            for (let offset = 0; offset + 188 <= wrong.length; offset += 188) {
                const start = offset + 4 + (wrong[offset + 3] & 0x20 ? 1 + wrong[offset + 4] : 0);
                if (pidAt(wrong, offset) === 0x100 && wrong[offset + 1] & 0x40) {
                    wrong.set([0xff, 0xf0], start + 4);
                    break;
                }
            }
            const kept = await readAll(wrong);
            assert.deepEqual(kept.warnings, ['TS_PES_LENGTH']);
            assert.deepEqual(kept.hashes, (await readAll(av)).hashes);
            await rejectsStrict(wrong);
        });

        test('a hundred MP2 frames in one PES are each read on from the frame before', async () => {
            // A broadcast capture copied to TS read half a gigabyte for three megabytes when each
            // frame was read from the PES start.
            const frames = Array.from({ length: 100 }, (_, index) => mp2Frame(index));
            const stream = transportStream(
                [{ pid: 0x101, streamType: 0x03 }],
                [{ pid: 0x101, streamId: 0xc0, payload: concat(...frames), pts: 90000 }],
            );
            let bytesRead = 0;
            const media = await open(
                {
                    size: stream.length,
                    read: async (offset, length) => {
                        bytesRead += length;
                        return stream.slice(offset, offset + length);
                    },
                },
                { cacheBytes: 0 },
            );
            try {
                bytesRead = 0;
                const packets = [];
                for await (const packet of media.packets()) packets.push(sha256(packet.data));
                assert.deepEqual(packets, frames.map(sha256));
                assert.ok(bytesRead < 5 * stream.length, `${bytesRead} bytes read`);
            } finally {
                media.close();
            }
        });

        test('opened files read packet bytes from the input on demand', async () => {
            // Pictures span many transport packets, one access unit continues across PES packets,
            // and the audio PES payloads cut ADTS frames anywhere, so every packet is gathered from
            // several transport packets.
            const frames = Array.from({ length: 24 }, (_, index) => [
                ...AAC_PAYLOADS[index % 4],
                index,
            ]);
            const adts = join(...frames.map(payload => adtsFrame(payload)));
            const cuts = [0, 17, 40, 41, 90, 150, adts.length];
            const pictures = [
                { payload: annexB(aud, sps, pps, idr, largeSlice(3000)), dts: 90000, pts: 93600 },
                { payload: annexB(aud, predicted, largeSlice(700)), dts: 93600, pts: 97200 },
                { payload: annexB(aud, predicted), dts: 97200, pts: 100800, split: 3 },
            ];
            const entries = [
                ...pictures.flatMap(({ split, ...picture }) =>
                    split
                        ? [
                              {
                                  pid: 0x100,
                                  streamId: 0xe0,
                                  ...picture,
                                  payload: picture.payload.slice(0, split),
                              },
                              { pid: 0x100, streamId: 0xe0, payload: picture.payload.slice(split) },
                          ]
                        : [{ pid: 0x100, streamId: 0xe0, ...picture }],
                ),
                ...cuts.slice(1).map((end, index) => ({
                    pid: 0x101,
                    streamId: 0xc0,
                    payload: adts.slice(cuts[index], end),
                    ...(index === 0 ? { dts: 90000, pts: 90000 } : {}),
                })),
            ];
            const input = transportStream(
                [
                    { pid: 0x100, streamType: 0x1b },
                    { pid: 0x101, streamType: 0x0f },
                ],
                entries,
            );
            // The delimiters and the repeated parameter sets leave the samples, whose NAL units
            // take 4-byte lengths.
            const expected = [
                [
                    lengthPrefixed(4, idr, largeSlice(3000)),
                    lengthPrefixed(4, predicted, largeSlice(700)),
                    lengthPrefixed(4, predicted),
                ].map(hex),
                frames.map(payload => hex(Uint8Array.from(payload))),
            ];
            let reads = 0;
            const media = await open(
                {
                    size: input.length,
                    async read(offset, length) {
                        reads++;
                        return input.slice(offset, offset + length);
                    },
                },
                { cacheBytes: 0 },
            );
            try {
                const opened = reads;
                const packets = media.tracks.map(() => []);
                for await (const packet of media.packets())
                    packets[media.tracks.findIndex(track => track.id === packet.trackId)].push(
                        hex(packet.data),
                    );
                // packets() gives decode order, the sample tables the order the stream stored.
                const sorted = tracks => tracks.map(track => [...track].sort());
                assert.deepEqual(sorted(packets), sorted(expected));
                assert.ok(reads >= opened + 27, `packet reads after opening: ${reads - opened}`);
            } finally {
                media.close();
            }
        });
    });

    describe('H.264', () => {
        test('samples hold NAL units after 4-byte lengths, whatever the start codes', async () => {
            // annexB() alternates 4-byte and 3-byte start codes. The delimiter and the repeated
            // parameter sets are dropped, which leaves room to write a sample over its own payload;
            // a picture of 3-byte codes without them needs more bytes than it arrived in.
            const pictures = [
                [
                    annexB(aud, sps, pps, idr, largeSlice(3000)),
                    lengthPrefixed(4, idr, largeSlice(3000)),
                ],
                [
                    annexB(aud, predicted, largeSlice(700), predicted),
                    lengthPrefixed(4, predicted, largeSlice(700), predicted),
                ],
                [annexB(predicted, largeSlice(500)), lengthPrefixed(4, predicted, largeSlice(500))],
                [
                    join([0, 0, 1], predicted, [0, 0, 1], largeSlice(90)),
                    lengthPrefixed(4, predicted, largeSlice(90)),
                ],
            ];
            const input = h264Transport(
                pictures.map(([payload], index) => ({ payload, pts: 90000 + index * 3600 })),
            );
            const expected = pictures.map(([, sample]) => hex(sample));
            const whole = await new TsDemuxer().demux(new Blob([input]));
            assert.deepEqual(
                whole.videoTracks[0].samples.map(sample => hex(sample.data)),
                expected,
            );
            // An opened file gathers each sample from its transport packets again when it is read.
            const { packets } = await readAll(input);
            assert.deepEqual(
                packets.map(packet => hex(packet.data)),
                expected,
            );
        });

        test('the duration ends with the last picture shown, not the last decoded', async () => {
            const media = await open(
                h264Transport([
                    { payload: annexB(sps, pps, idr), dts: 90000, pts: 93600 },
                    { payload: annexB(predicted), dts: 93600, pts: 104400 },
                    { payload: annexB(predicted), dts: 97200, pts: 97200 },
                    { payload: annexB(predicted), dts: 100800, pts: 100800 },
                ]),
            );
            try {
                // Presented from 93600 to 104400 + 3600 ticks: 0.16 s, where the decode order ends
                // 0.04 s earlier.
                assert.ok(Math.abs(media.tracks[0].duration - 0.16) < 1e-6);
            } finally {
                media.close();
            }
        });

        test('both fields of an interlaced frame in one PES become two samples', async () => {
            // The second takes half the time to the next PES, as ffmpeg's parser times it.
            const { packets } = await readAll(
                h264Transport([
                    {
                        payload: join(annexB(aud, sps, pps, idr), annexB(aud, predicted)),
                        pts: 90000,
                        dts: 90000,
                    },
                    { payload: annexB(aud, predicted), pts: 97200, dts: 97200 },
                ]),
            );
            assert.deepEqual(
                packets.map(packet => [
                    Math.round(packet.decodeTimestamp * 90000),
                    packet.isKeyframe,
                ]),
                [
                    [90000, true],
                    [93600, false],
                    [97200, false],
                ],
            );
        });

        test("slices before a PES's first delimiter end the access unit before", async () => {
            const { packets } = await readAll(
                h264Transport([
                    { payload: annexB(aud, sps, pps, idr), pts: 90000, dts: 90000 },
                    {
                        payload: join(annexB(predicted), annexB(aud, predicted)),
                        pts: 93600,
                        dts: 93600,
                    },
                ]),
            );
            assert.deepEqual(
                packets.map(packet => [
                    Math.round(packet.decodeTimestamp * 90000),
                    packet.data.length,
                ]),
                [
                    [90000, 4 + idr.length + 4 + predicted.length],
                    [93600, 4 + predicted.length],
                ],
            );
        });

        describe('a stream without IDR pictures', () => {
            const config = join(
                [1, 66, 0, 10, 0xff, 0xe1, 0, sps.length],
                sps,
                [1, 0, pps.length],
                pps,
            );
            const recovery = Uint8Array.of(0x06, 0x06, 0x01, 0xc4, 0x80);
            const intra = nal(0x41, new Bits().ue(0).ue(7).ue(0).uint(1, 4).bytes());
            /** The keyframe flags read back from a TS of pictures of `units` (NAL units each). */
            const keyframesOf = async units => {
                const sink = new MemorySink();
                const muxer = new TsMuxer(
                    {
                        format: 'ts',
                        mode: 'standard',
                        autoSync: true,
                        video: {
                            id: 1,
                            type: 'video',
                            codec: 'avc1.42000a',
                            codecConfig: config,
                            width: 32,
                            height: 16,
                        },
                    },
                    sink,
                );
                units.forEach((nals, index) =>
                    muxer.addVideoChunk({
                        trackType: 'video',
                        data: lengthPrefixed(4, ...nals),
                        timestamp: index * 0.04,
                        duration: 0.04,
                        isKeyframe: index === 0,
                    }),
                );
                await muxer.finalize();
                return (await readAll(sink.toUint8Array())).packets.map(
                    packet => packet.isKeyframe,
                );
            };

            test('is entered at its recovery points, as ffmpeg marks them', async () => {
                assert.deepEqual(
                    await keyframesOf([
                        [recovery, predicted],
                        [predicted],
                        [recovery, predicted],
                        [predicted],
                    ]),
                    [true, false, true, false],
                );
            });

            test('keeps its IDR pictures alone where it has them', async () => {
                assert.deepEqual(
                    await keyframesOf([[idr], [predicted], [recovery, predicted], [predicted]]),
                    [true, false, false, false],
                );
            });

            test('without recovery points is entered at its I pictures', async () => {
                // Where ffmpeg's decoder starts presenting such a stream.
                assert.deepEqual(await keyframesOf([[predicted], [intra], [predicted], [intra]]), [
                    false,
                    true,
                    false,
                    true,
                ]);
                assert.deepEqual(
                    await keyframesOf([[recovery, predicted], [intra], [predicted], [intra]]),
                    [true, false, false, false],
                );
            });
        });
    });

    describe('MPEG video', () => {
        for (const [streamType, { codec, units }] of Object.entries(MPEG_VIDEO_STREAMS))
            test(`stream type ${streamType} is ${codec}, one access unit a packet`, async () => {
                const result = await new TsDemuxer().demux(
                    new Blob([mpegTransport(Number(streamType), units)]),
                );
                const [track] = result.videoTracks;
                assert.equal(track.codec, codec);
                assert.deepEqual([track.width, track.height], [32, 16]);
                assert.deepEqual(
                    track.samples.map(sample => hex(sample.data)),
                    units.map(unit => hex(unit.data)),
                );
                assert.deepEqual(
                    track.samples.map(sample => [
                        Math.round(sample.timestamp * 90000),
                        Math.round(sample.decodeTimestamp * 90000),
                    ]),
                    units.map(unit => [unit.pts, unit.dts]),
                );
                assert.deepEqual(
                    track.samples.map(sample => sample.isKeyframe),
                    units.map(unit => unit.type === PICTURE_I),
                );
            });

        test('MPEG-2 video without a sequence header is left out while audio remains', async () => {
            const video = MPEG_VIDEO_STREAMS['0x02'].units.slice(1).map(unit => ({
                pid: 0x100,
                streamId: 0xe0,
                payload: unit.data,
                pts: unit.pts,
                dts: unit.dts,
            }));
            const streams = [
                { pid: 0x100, streamType: 2 },
                { pid: 0x101, streamType: 0x0f },
            ];
            const audio = {
                pid: 0x101,
                streamId: 0xc0,
                payload: adtsFrame(AAC_PAYLOADS[0]),
                pts: 90000,
            };
            const withAudio = transportStream(streams, [...video, audio]);
            const read = await readAll(withAudio);
            assert.deepEqual(
                read.tracks.map(track => track.type),
                ['audio'],
            );
            assert.deepEqual(read.warnings, ['TS_VIDEO_UNUSABLE']);
            const noSequenceHeader = error =>
                error.code === 'DEMUX' && /sequence header/.test(error.message);
            await assert.rejects(open(withAudio, { validation: 'strict' }), noSequenceHeader);
            await assert.rejects(
                open(transportStream(streams.slice(0, 1), video)),
                noSequenceHeader,
            );
        });
    });

    describe('audio', () => {
        test('frames split across PES packets are joined and timed by their PES', async () => {
            const frames = [...AAC_PAYLOADS, ...AAC_PAYLOADS].map(payload => adtsFrame(payload));
            const stream = Buffer.concat(frames);
            const split = audioTransport(stream, [0, 15, 40, stream.length], [0, 2, 4]);
            const joined = await readAll(split);
            assert.deepEqual(joined.warnings, []);
            assert.deepEqual(
                joined.packets.map(packet => hex(packet.data)),
                [...AAC_PAYLOADS, ...AAC_PAYLOADS].map(payload => hex(Uint8Array.from(payload))),
            );
            assert.deepEqual(
                joined.packets.map(packet => Math.round(packet.timestamp * 90000)),
                frames.map((_, index) => 90000 + index * 1920),
            );
            assert.equal(joined.tracks[0].incomplete, undefined);
            await rejectsStrict(split, 'strict validation expects frame-aligned audio PES');
        });

        test('junk between frames is passed by, marking the track incomplete', async () => {
            const stream = Buffer.concat(
                [...AAC_PAYLOADS, ...AAC_PAYLOADS].map(payload => adtsFrame(payload)),
            );
            const junk = Buffer.concat([
                stream.subarray(0, 55),
                Buffer.from([0x4d, 0x46, 0x34]),
                stream.subarray(55),
            ]);
            const intact = await readAll(
                audioTransport(stream, [0, 15, 40, stream.length], [0, 2, 4]),
            );
            const read = await readAll(audioTransport(junk, [0, 15, 40, junk.length], [0, 2, 4]));
            assert.deepEqual(read.warnings, ['TS_AUDIO_RESYNCHRONIZED']);
            assert.deepEqual(read.hashes, intact.hashes);
            assert.equal(read.tracks[0].incomplete, true);
        });

        test('a stream that stops inside a frame of a complete PES is a cut track', async () => {
            const stream = Buffer.concat(
                [...AAC_PAYLOADS, ...AAC_PAYLOADS].map(payload => adtsFrame(payload)),
            );
            const intact = await readAll(
                audioTransport(stream, [0, 15, 40, stream.length], [0, 2, 4]),
            );
            const cut = await readAll(
                audioTransport(stream, [0, 15, 40, stream.length - 3], [0, 2, 4]),
            );
            assert.deepEqual(cut.hashes, intact.hashes.slice(0, -1));
            assert.equal(cut.tracks[0].incomplete, true);
        });

        test('frames before the first timed PES precede it on its clock', async () => {
            // A capture that starts inside a PES: its frames do not start the timeline at zero.
            const mp3 = (await readAll(fixtures['mov-mp3.mov']())).packets
                .map(packet => packet.data)
                .slice(0, 3);
            const { packets } = await readAll(
                transportStream(
                    [{ pid: 0x101, streamType: 0x03 }],
                    [
                        { pid: 0x101, streamId: 0xc0, payload: join(mp3[0], mp3[1]) },
                        { pid: 0x101, streamId: 0xc0, payload: mp3[2], pts: 900000 },
                    ],
                ),
            );
            assert.deepEqual(
                packets.map(packet => Math.round(packet.timestamp * 32000)),
                [320000 - 2304, 320000 - 1152, 320000],
            );
        });

        test('a PID of no whole frame is left out, not guessed, beside an intact one', async () => {
            // An MPEG-1 Layer II 44.1 kHz sync pattern followed by an MPEG-2 Layer I 16 kHz one,
            // which does not continue it, as a cropped PID holds.
            const junk = new Uint8Array(489);
            junk.set([0xff, 0xfc, 0x50, 0x00], 10);
            junk.set([0xff, 0xf6, 0x38, 0x00], 271);
            const frames = [0, 1, 2].map(mp2Frame);
            const read = await readAll(
                transportStream(
                    [
                        { pid: 0x101, streamType: 0x03 },
                        { pid: 0x102, streamType: 0x03 },
                    ],
                    [
                        { pid: 0x101, streamId: 0xc0, payload: concat(...frames), pts: 90000 },
                        { pid: 0x102, streamId: 0xc1, payload: junk, pts: 90000 },
                    ],
                ),
            );
            assert.deepEqual(
                read.tracks.map(track => [track.codec, track.sampleRate]),
                [['mp2', 48000]],
            );
            assert.deepEqual(read.hashes, frames.map(sha256));
            assert.ok(read.warnings.includes('TS_AUDIO_UNFRAMED'), read.warnings.join());
        });

        test('MPEG audio frames across transport packets decode as the stream', async () => {
            const rate = 48000;
            const frames = rate / 2;
            const planes = [new Float32Array(frames), new Float32Array(frames)];
            for (let index = 0; index < frames; index++)
                for (let channel = 0; channel < 2; channel++)
                    planes[channel][index] =
                        0.25 * Math.sin((2 * Math.PI * (channel ? 660 : 440) * index) / rate);
            const stream = await encodeMp3(planes, { sampleRate: rate });
            // 700-byte PES payloads cut the frames, so each is read from several transport packets.
            const entries = [];
            for (let at = 0; at < stream.length; at += 700)
                entries.push({
                    pid: 0x101,
                    streamId: 0xc0,
                    payload: stream.slice(at, at + 700),
                    ...(at === 0 ? { dts: 90000, pts: 90000 } : {}),
                });
            const input = new Blob([transportStream([{ pid: 0x101, streamType: 0x03 }], entries)]);
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning.code) });
            const level = async blob => {
                const wav = (await forge.convert(blob, 'wav')).blob;
                const bytes = new Uint8Array(await wav.arrayBuffer());
                const samples = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
                let sum = 0;
                for (const sample of samples) sum += (sample / 32768) ** 2;
                return Math.sqrt(sum / samples.length);
            };
            const expected = await level(input);
            const reencoded = await forge.convert(input, 'mkv', {
                copy: false,
                audio: { codec: 'aac' },
            });
            const actual = await level(reencoded.blob);
            assert.ok(expected > 0.15, `the direct decode has level ${expected}`);
            assert.ok(Math.abs(actual - expected) < 0.02, `${actual} against ${expected}`);
            assert.deepEqual(
                warnings.filter(code => /CONCEAL|FALLBACK/.test(code)),
                [],
            );
        });

        describe('AAC in LOAS/LATM', () => {
            const loas = Buffer.concat(
                AAC_PAYLOADS.map((payload, index) =>
                    loasFrame(payload, { config: index % 2 === 0 }),
                ),
            );
            /** One PID of `streamType` whose PES packets cut `bytes` at `cuts`. */
            const latmTransport = (streamType, bytes, cuts) =>
                audioTransport(
                    bytes,
                    cuts,
                    cuts.slice(1).map((_, index) => index * 2),
                    { streamType },
                );

            test('the StreamMuxConfig is the configuration, each payload a raw frame', async () => {
                // The payloads start at no byte boundary; a frame split across PES is joined.
                const latm = await readAll(latmTransport(0x11, loas, [0, 20, loas.length]));
                assert.deepEqual(latm.warnings, []);
                const [track] = latm.tracks;
                assert.equal(track.codec, 'mp4a.40.2');
                assert.deepEqual([...track.codecConfig], [0x11, 0x88]);
                assert.deepEqual([track.sampleRate, track.channelCount], [48000, 1]);
                assert.deepEqual(
                    latm.packets.map(packet => hex(packet.data)),
                    AAC_PAYLOADS.map(payload => hex(Uint8Array.from(payload))),
                );
                assert.deepEqual(
                    latm.packets.map(packet => Math.round(packet.timestamp * 90000)),
                    AAC_PAYLOADS.map((_, index) => 90000 + index * 1920),
                );
            });

            test('a stream declared as ADTS whose payload is LOAS is read as LATM', async () => {
                const latm = await readAll(latmTransport(0x11, loas, [0, loas.length]));
                const declared = await readAll(latmTransport(0x0f, loas, [0, loas.length]));
                assert.deepEqual(declared.hashes, latm.hashes);
            });

            test('strict validation expects frame-aligned LATM PES', async () => {
                const cut = loasFrame(AAC_PAYLOADS[0]).length * 2 - 1;
                await rejectsStrict(latmTransport(0x11, loas, [0, cut, loas.length]));
            });

            test('a frame of another channel configuration ends the track', async () => {
                const switched = Buffer.concat([
                    loasFrame(AAC_PAYLOADS[0]),
                    loasFrame(AAC_PAYLOADS[1], { config: false }),
                    loasFrame(AAC_PAYLOADS[2], { channels: 2 }),
                    loasFrame(AAC_PAYLOADS[3], { config: false }),
                ]);
                const input = latmTransport(0x11, switched, [0, switched.length]);
                const ended = await readAll(input);
                assert.deepEqual(ended.warnings, ['TS_AUDIO_CONFIG_CHANGED']);
                const latm = await readAll(latmTransport(0x11, loas, [0, loas.length]));
                assert.deepEqual(ended.hashes, latm.hashes.slice(0, 2));
                assert.equal(ended.tracks[0].channelCount, 1);
                await rejectsStrict(input);
            });
        });
    });

    describe('timelines', () => {
        test('captures spliced back to back keep one rising timeline', async () => {
            // 100 s, then 5 s: packets keep file order, audio and video keep their offset, and a
            // track lasts its span, not its end time.
            const splice = await readAll(fixtures['ts-splice.ts']());
            assert.ok(splice.warnings.includes('TS_TIMELINE_SPLICE'), splice.warnings.join());
            for (const track of splice.tracks) {
                const times = splice.packets
                    .filter(packet => packet.trackId === track.id)
                    .map(packet => packet.decodeTimestamp ?? packet.timestamp);
                assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
                assert.ok(track.duration > 1 && track.duration < 1.6, `${track.duration} s`);
            }
            const audioTimes = splice.packets
                .filter(packet => packet.trackId === splice.tracks[1].id)
                .map(packet => packet.timestamp);
            const steps = audioTimes.slice(1).map((time, index) => time - audioTimes[index]);
            assert.ok(
                steps.every(step => step > 0.127 && step < 0.4),
                `audio frames neither overlap nor leave a hole: ${steps}`,
            );
        });

        test('a capture across the 33-bit wrap of the clock keeps rising', async () => {
            const wrap = await readAll(fixtures['ts-wrap.ts']());
            assert.deepEqual(wrap.warnings, []);
            assert.ok(wrap.tracks[0].duration < 1, `${wrap.tracks[0].duration} s`);
            assert.ok(
                wrap.packets.every(
                    (packet, index) =>
                        index === 0 || packet.timestamp > wrap.packets[index - 1].timestamp,
                ),
            );
        });
    });

    describe('AAC whose decoded shape differs from its header', () => {
        for (const [file, rate, channels] of [
            ['he-aac-sbr.aac', 44100, 2],
            ['he-aac-ps.aac', 44100, 2],
            ['aac-7.1.aac', 48000, 8],
        ])
            test(`${file} in MPEG-TS reports ${rate} Hz in ${channels} channels`, async () => {
                // As decoded: SBR doubles the rate and PS makes stereo of mono. The samples are
                // read back from their transport packets.
                const adts = readFileSync(new URL(`../fixtures/aac/${file}`, import.meta.url));
                const { tracks } = await readAll(
                    transportStream(
                        [{ pid: 0x101, streamType: 0x0f }],
                        [{ pid: 0x101, streamId: 0xc0, payload: adts, pts: 90000 }],
                    ),
                );
                assert.deepEqual([tracks[0].sampleRate, tracks[0].channelCount], [rate, channels]);
            });
    });

    describe('codecs of elementary streams', () => {
        const shapes = tracks =>
            tracks.map(track => [track.codec, track.sampleRate, track.channelCount]);
        const DTS_FRAMES = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
        /** The Blu-ray registration of a program. */
        const HDMV = [0x05, 4, ...Buffer.from('HDMV')];
        const dtsPes = () =>
            DTS_FRAMES.map((frame, index) => ({
                pid: 0x101,
                streamId: 0xbd,
                payload: frame,
                pts: 90000 + index * 960,
            }));

        // DTS by user-private type, DVB descriptor, registration and Blu-ray types; payload
        // sniffing never labels other data as audio.
        for (const [label, stream, options] of [
            ['user-private type 0x82', { streamType: 0x82 }],
            ['a DVB DTS descriptor', { streamType: 0x06, descriptors: [0x7b, 0] }],
            [
                'a DTS2 registration',
                { streamType: 0x06, descriptors: [0x05, 4, ...Buffer.from('DTS2')] },
            ],
            ['Blu-ray type 0x86', { streamType: 0x86 }, { programDescriptors: HDMV }],
            ['a private stream without descriptors', { streamType: 0x06 }],
        ])
            test(`DTS is found by ${label}`, async () => {
                const { tracks, packets } = await readAll(
                    transportStream([{ pid: 0x101, ...stream }], dtsPes(), options),
                );
                assert.deepEqual(shapes(tracks), [['dtsc', 48000, 2]]);
                assert.deepEqual(
                    packets.map(packet => hex(packet.data)),
                    DTS_FRAMES.map(hex),
                );
            });

        test("a Blu-ray DTS-HD substream in its own PES completes the core's unit", async () => {
            // It does not become a packet (and a changed stream configuration) of its own.
            const extension = () =>
                dtsSubstream({ bytes: 96, sampleRateCode: 12, channels: 2, sync: XLL_SYNC });
            const units = [1, 2].map(fill => [dtsCore({ fill }), extension()]);
            const { tracks, packets, warnings } = await readAll(
                transportStream(
                    [{ pid: 0x101, streamType: 0x86 }],
                    units.flatMap(([core, substream], index) => [
                        { pid: 0x101, streamId: 0xbd, payload: core, pts: 90000 + index * 960 },
                        { pid: 0x101, streamId: 0xbd, payload: substream },
                    ]),
                    { programDescriptors: HDMV },
                ),
            );
            assert.deepEqual(warnings, []);
            assert.deepEqual(shapes(tracks), [['dtsl', 48000, 2]]);
            assert.deepEqual(
                packets.map(packet => hex(packet.data)),
                units.map(unit => hex(concat(...unit))),
            );
        });

        describe('Blu-ray LPCM (HDMV 0x80)', () => {
            // A 4-byte header, then big-endian samples; an odd channel count is stored with a
            // padding channel, which the packets leave out.
            const lpcm = (assignment, size, samples) =>
                concat(
                    [samples.length >> 8, samples.length & 255, (assignment << 4) | 1, size << 6],
                    samples,
                );
            const stereo = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
            const mono24 = Uint8Array.from({ length: 24 }, (_, index) =>
                index % 6 < 3 ? 0x40 + index : 0,
            );
            for (const [label, assignment, size, samples, expected, codec, channels] of [
                ['stereo 16-bit', 3, 1, stereo, stereo, 'pcm-s16be', 2],
                [
                    'mono 24-bit, its padding channel left out',
                    1,
                    3,
                    mono24,
                    mono24.filter((_, index) => index % 6 < 3),
                    'pcm-s24be',
                    1,
                ],
            ])
                test(`reads ${label}`, async () => {
                    const { tracks, packets, warnings } = await readAll(
                        transportStream(
                            [{ pid: 0x1100, streamType: 0x80 }],
                            [0, 1].map(index => ({
                                pid: 0x1100,
                                streamId: 0xbd,
                                payload: lpcm(assignment, size, samples),
                                pts: 90000 + index * 900,
                            })),
                            { programDescriptors: HDMV },
                        ),
                    );
                    assert.deepEqual(warnings, []);
                    assert.deepEqual(shapes(tracks), [[codec, 48000, channels]]);
                    assert.deepEqual(
                        packets.map(packet => hex(packet.data)),
                        [hex(expected), hex(expected)],
                    );
                });
        });

        test('an E-AC-3 dependent substream belongs to the frame before it', async () => {
            // 7.1 extension channels, in the access unit of the independent frame (Blu-ray 0x84).
            const unit = index =>
                concat(eac3Frame(256, index), eac3Frame(128, index, { dependent: true }));
            const { tracks, packets } = await readAll(
                transportStream(
                    [{ pid: 0x101, streamType: 0x84 }],
                    [0, 1].map(index => ({
                        pid: 0x101,
                        streamId: 0xbd,
                        payload: unit(index),
                        pts: 90000 + index * 2880,
                    })),
                    { programDescriptors: HDMV },
                ),
            );
            assert.deepEqual(shapes(tracks), [['ec-3', 48000, 2]]);
            assert.deepEqual(
                packets.map(packet => hex(packet.data)),
                [hex(unit(0)), hex(unit(1))],
            );
        });

        test("an AC-3 core's dependent frame in a PES of its own joins the core", async () => {
            // Blu-ray muxers put it after the core's PES under stream type 0x81: E-AC-3 as a
            // whole, with a dec3 describing both.
            const dependent = index => {
                const frame = eac3Frame(128, index, { dependent: true });
                // dialnorm 0, compre 0, chanmape 1, chanmap 0x0200 (location 6: Lrs/Rrs).
                frame.set([0x10, 0x20, 0x00], 6);
                return frame;
            };
            const { tracks, packets, warnings } = await readAll(
                transportStream(
                    [{ pid: 0x101, streamType: 0x81 }],
                    [0, 1].flatMap(index => [
                        {
                            pid: 0x101,
                            streamId: 0xbd,
                            payload: ac3Frame(index + 1),
                            pts: 90000 + index * 2880,
                        },
                        { pid: 0x101, streamId: 0xbd, payload: dependent(index + 1) },
                    ]),
                    { programDescriptors: HDMV },
                ),
            );
            assert.deepEqual(warnings, []);
            assert.deepEqual(shapes(tracks), [['ec-3', 48000, 4]]);
            assert.equal(hex(tracks[0].codecConfig), '010010040202');
            assert.deepEqual(
                packets.map(packet => hex(packet.data)),
                [0, 1].map(index => hex(concat(ac3Frame(index + 1), dependent(index + 1)))),
            );
        });

        test('Blu-ray TrueHD and its AC-3 stream on one PID are two tracks', async () => {
            const major = truehdUnit({ sampleRateCode: 0, channelMask: 1, fill: 7 });
            const minor = truehdUnit({ bytes: 32, fill: 8 });
            const pes = [0, 1].map(index => ({
                pid: 0x101,
                streamId: 0xbd,
                payload: concat(ac3Frame(index), major, minor),
                pts: 90000 + index * 2880,
            }));
            const { tracks, packets } = await readAll(
                transportStream([{ pid: 0x101, streamType: 0x83 }], pes, {
                    programDescriptors: HDMV,
                }),
            );
            assert.deepEqual(shapes(tracks), [
                ['mlpa', 48000, 2],
                ['ac-3', 48000, 2],
            ]);
            const truehd = packets.filter(packet => packet.trackId === tracks[0].id);
            assert.deepEqual(
                truehd.map(packet => [packet.data.length, packet.isKeyframe]),
                [
                    [64, true],
                    [32, false],
                    [64, true],
                    [32, false],
                ],
            );
        });

        test('Opus is found by its registration, its trim the pre-skip', async () => {
            // The channel count comes from the extension descriptor.
            const packet = Uint8Array.of(0xfc, 1, 2, 3);
            const pes = [0, 1].map(index => ({
                pid: 0x101,
                streamId: 0xbd,
                payload: tsOpusUnit(packet, index ? undefined : 312),
                pts: 90000 + index * 1800,
            }));
            const descriptors = [0x05, 4, ...Buffer.from('Opus'), 0x7f, 2, 0x80, 2];
            const { tracks, packets } = await readAll(
                transportStream([{ pid: 0x101, streamType: 0x06, descriptors }], pes),
            );
            assert.deepEqual(shapes(tracks), [['opus', 48000, 2]]);
            assert.equal(
                hex(tracks[0].codecConfig.subarray(0, 12)),
                hex(Buffer.from('OpusHead\x01\x02\x38\x01', 'latin1')),
            );
            assert.deepEqual(
                packets.map(item => [hex(item.data), item.duration]),
                [
                    [hex(packet), 0.02],
                    [hex(packet), 0.02],
                ],
            );
        });

        test('a FLAC frame in a private stream is not taken for AAC', async () => {
            // Its header (0xfff8) also parses as ADTS; unconfirmed framing is not labelled AAC.
            const flac = concat([0xff, 0xf8, 0x69, 0x08, 0, 0x2f, 0x5c], new Uint8Array(40));
            const stream = transportStream(
                [{ pid: 0x101, streamType: 0x06 }],
                [{ pid: 0x101, streamId: 0xbd, payload: flac, pts: 90000 }],
            );
            await assert.rejects(open(stream), {
                code: 'DEMUX',
                message: /unknown audio framing/,
            });
        });

        test('a stream of an unsupported type is reported and the others read', async () => {
            const { tracks, warnings } = await readAll(
                transportStream(
                    [
                        { pid: 0x100, streamType: 0x42 },
                        { pid: 0x101, streamType: 0x81 },
                    ],
                    [{ pid: 0x101, streamId: 0xbd, payload: ac3Frame(), pts: 90000 }],
                ),
            );
            assert.deepEqual(shapes(tracks), [['ac-3', 48000, 2]]);
            assert.deepEqual(warnings, ['TS_UNSUPPORTED_STREAM']);
        });
    });
});
