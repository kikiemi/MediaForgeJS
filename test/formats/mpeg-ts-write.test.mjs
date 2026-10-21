import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, convert, inspect, open, packageMedia } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { MemorySink } from 'mediaforgejs/io';
import { Mp4Muxer, TsDemuxer, TsMuxer } from 'mediaforgejs/formats';
import { preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { FIXTURES } from '../helpers/new-format-fixtures.mjs';
import {
    annexB,
    aud,
    avcc,
    idr,
    join,
    lengthPrefixed,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { AAC_PAYLOADS, adtsFixture, adtsFrame } from '../helpers/original-fixtures.mjs';
import { mpeg2Gop, transportStream } from '../helpers/mpeg-video-fixtures.mjs';
import { bytesOf, readAll, readMedia } from '../helpers/read-media.mjs';
import { dtsCore } from '../helpers/sync-audio-fixtures.mjs';

const hex = bytes => Buffer.from(bytes).toString('hex');
const packetsOf = bytes =>
    Array.from({ length: bytes.length / 188 }, (_, i) => bytes.subarray(i * 188, (i + 1) * 188));
const pidOf = packet => (packet[1] & 31) * 256 + packet[2];
const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    return crc >>> 0;
};

/** The elementary streams of the first PMT of `bytes` (PID 0x1000), its CRC checked. */
function pmtStreams(bytes) {
    const payloads = [];
    for (const packet of packetsOf(bytes)) {
        if (pidOf(packet) !== 0x1000) continue;
        if (payloads.length && packet[1] & 0x40) break;
        let offset = packet[3] & 0x20 ? 5 + packet[4] : 4;
        if (packet[1] & 0x40) offset += 1 + packet[offset];
        payloads.push(packet.subarray(offset));
    }
    const all = Buffer.concat(payloads);
    const section = all.subarray(0, 3 + ((all[1] & 15) << 8) + all[2]);
    assert.equal(crc32(section), 0);
    const streams = [];
    for (let offset = 12 + ((section[10] & 15) << 8) + section[11]; offset < section.length - 4;) {
        const length = ((section[offset + 3] & 15) << 8) + section[offset + 4];
        streams.push({
            type: section[offset],
            pid: ((section[offset + 1] & 31) << 8) + section[offset + 2],
            descriptors: section.subarray(offset + 5, offset + 5 + length),
        });
        offset += 5 + length;
    }
    return streams;
}

/** The presentation times of the PES packets of `bytes` in file order, in 90 kHz ticks. */
function pesTimes(bytes) {
    const times = [];
    for (const packet of packetsOf(bytes)) {
        if (!(packet[1] & 0x40)) continue;
        const payload = packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
        if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || !(payload[7] & 0x80))
            continue;
        const at = payload[7] & 0x40 ? 14 : 9;
        times.push(
            ((payload[at] >> 1) & 7) * 2 ** 30 +
                payload[at + 1] * 2 ** 22 +
                (payload[at + 2] >> 1) * 2 ** 15 +
                payload[at + 3] * 2 ** 7 +
                (payload[at + 4] >> 1),
        );
    }
    return times;
}

/** An MP4 of `audio` AAC tracks, after an H.264 track with `video`; as M4A with `m4a`. */
function mp4Fixture({ video = false, m4a = false, audio = 3 } = {}) {
    const result = preservationFixture({
        tracks: [
            ...(video
                ? [
                      {
                          type: 'video',
                          codecConfig: avcc(),
                          packets: [lengthPrefixed(4, idr), lengthPrefixed(4, idr)],
                      },
                  ]
                : []),
            ...Array.from({ length: audio }, () => ({ type: 'audio' })),
        ],
    });
    if (m4a) result.bytes.set(Buffer.from('M4A '), 8);
    return result;
}

/**
 * Asserts that the TS `blob` holds the audio of `expected` ({ packets }) and a video track when
 * `video`, its PES packets interleaved in decode order.
 */
async function assertTsCopy(blob, expected, video = false) {
    const bytes = await bytesOf(blob);
    const result = await new TsDemuxer().demux(blob);
    assert.equal(result.videoTracks.length, Number(video));
    assert.deepEqual(
        result.audioTracks.map(track => track.samples.map(sample => hex(sample.data))),
        expected.map(track => track.packets.map(hex)),
    );
    const times = pesTimes(bytes);
    assert.ok(times.length >= expected.reduce((total, track) => total + track.packets.length, 0));
    assert.deepEqual(
        times,
        [...times].sort((a, b) => a - b),
        'transport packets are interleaved in decode order',
    );
}

/** AAC track `index`: 48 kHz stereo English when even, 44.1 kHz mono Japanese when odd. */
const aacTrack = (index, overrides = {}) => ({
    id: 20 + index,
    type: 'audio',
    codec: 'mp4a.40.2',
    sampleRate: index % 2 ? 44100 : 48000,
    channelCount: index % 2 ? 1 : 2,
    codecConfig: Uint8Array.of(...(index % 2 ? [0x12, 0x08] : [0x11, 0x90])),
    language: index % 2 ? 'jpn' : 'eng',
    ...overrides,
});
const muxerConfig = tracks => ({
    format: 'ts',
    mode: 'standard',
    autoSync: true,
    maxFragmentDuration: 2,
    audio: tracks[0],
    extraAudioTracks: tracks.slice(1),
});
/** Frame `sample` of `track`: four bytes that name the track and the frame. */
const aacChunk = (track, sample = 0) => ({
    trackType: 'audio',
    timestamp: (sample * 1024) / track.sampleRate,
    duration: 1024 / track.sampleRate,
    isKeyframe: true,
    data: Uint8Array.of(0x21, track.id, sample, 0x7f),
});
/** A TS of `count` frames of each of `tracks`, added in time order. */
async function multiAudio(tracks, count = 4) {
    const sink = new MemorySink();
    const muxer = new TsMuxer(muxerConfig(tracks), sink);
    const items = tracks.flatMap((track, index) =>
        Array.from({ length: count }, (_, sample) => ({ index, chunk: aacChunk(track, sample) })),
    );
    items.sort((a, b) => a.chunk.timestamp - b.chunk.timestamp || b.index - a.index);
    for (const item of items) {
        if (item.index) muxer.addExtraAudioChunk(item.index - 1, item.chunk);
        else muxer.addAudioChunk(item.chunk);
    }
    await muxer.finalize();
    return sink.toUint8Array();
}

/** The H.264 avcC record of the fixtures' parameter sets. */
const AVCC = join([1, 66, 0, 10, 0xff, 0xe1, 0, sps.length], sps, [1, 0, pps.length], pps);
/** NAL unit types of a four-byte length-prefixed sample. */
function nalTypes(data) {
    const types = [];
    const view = new DataView(data.buffer, data.byteOffset);
    for (let at = 0; at + 4 <= data.length; at += 4 + view.getUint32(at))
        types.push(data[at + 4] & 31);
    return types;
}

describe('mpeg-ts: writing', () => {
    describe('copies into MPEG-TS', () => {
        test('every audio track of an MP4 copies in decode order', async () => {
            const input = mp4Fixture();
            await assertTsCopy((await convert(input.bytes, 'ts')).blob, input.tracks);
        });

        test('video and several audio tracks stream to a sink in decode order', async () => {
            const input = mp4Fixture({ video: true });
            const sink = new MemorySink();
            await convert(input.bytes, 'ts', { sink });
            await assertTsCopy(
                sink.toBlob(),
                input.tracks.filter(track => track.type === 'audio'),
                true,
            );
        });

        for (const m4a of [false, true])
            test(`${m4a ? 'M4A' : 'MP4'} audio tracks copy through a Blob and a sink`, async () => {
                const input = mp4Fixture({ m4a });
                assert.equal((await inspect(input.bytes)).format, m4a ? 'm4a' : 'mp4');
                await assertTsCopy((await convert(input.bytes, 'ts')).blob, input.tracks);
                const sink = new MemorySink();
                await convert(input.bytes, 'ts', { sink });
                await assertTsCopy(sink.toBlob(), input.tracks);
            });

        test('trackIds copy only the audio chosen', async () => {
            const input = mp4Fixture();
            const ids = (await inspect(input.bytes)).tracks.map(track => track.id);
            const chosen = await convert(input.bytes, 'ts', { trackIds: [ids[2]] });
            await assertTsCopy(chosen.blob, [input.tracks[2]]);
            const sink = new MemorySink();
            await convert(input.bytes, 'ts', { trackIds: [ids[1]], sink });
            await assertTsCopy(sink.toBlob(), [input.tracks[1]]);
        });

        test('raw AAC copies in the lite entry, without a decoder or encoder', async () => {
            const expected = [{ packets: AAC_PAYLOADS.map(payload => Uint8Array.from(payload)) }];
            assert.equal((await lite.check(adtsFixture(), 'ts')).plan.action, 'copy');
            await assertTsCopy((await lite.convert(adtsFixture(), 'ts')).blob, expected);
            const sink = new MemorySink();
            await lite.convert(adtsFixture(), 'ts', { sink });
            await assertTsCopy(sink.toBlob(), expected);
        });

        test('two audio tracks of an MP4 pass check() and copy whole', async () => {
            const { bytes, tracks } = preservationFixture({
                tracks: [{ type: 'audio' }, { type: 'audio' }],
            });
            const media = await open(bytes);
            try {
                const support = await media.check('ts', { copy: true });
                assert.equal(support.supported, true, support.reason);
                const copy = (await media.convert('ts', { copy: true })).blob;
                await assertTsCopy(copy, tracks);
            } finally {
                media.close();
            }
        });

        /** A TS of an MPEG-2 GOP that starts one second in, B pictures without decode times. */
        const mpeg2Transport = units =>
            transportStream(
                [{ pid: 0x100, streamType: 2 }],
                units.map(unit => ({
                    pid: 0x100,
                    streamId: 0xe0,
                    payload: unit.data,
                    pts: unit.pts,
                    dts: unit.type === 3 ? undefined : unit.dts,
                })),
            );

        test('MPEG-2 video copies back to TS, declared as MPEG-2', async () => {
            const units = mpeg2Gop();
            const input = mpeg2Transport(units);
            const bytes = await bytesOf(await convert(input, { to: 'ts', copy: true }));
            const [stream] = pmtStreams(bytes);
            assert.equal(stream.type, 0x02);
            const copy = await new TsDemuxer().demux(new Blob([bytes]));
            assert.equal(copy.videoTracks[0].codec, 'mp4v.61');
            assert.deepEqual(
                copy.videoTracks[0].samples.map(sample => hex(sample.data)),
                units.map(unit => hex(unit.data)),
            );
        });

        test('MPEG-2 video from TS copies into Matroska at its frame rate', async () => {
            // The one-second start is not counted as frame time.
            const out = await bytesOf(
                await convert(mpeg2Transport(mpeg2Gop()), { to: 'mkv', copy: true }),
            );
            const at = out.findIndex(
                (_, index) =>
                    out[index] === 0x23 && out[index + 1] === 0xe3 && out[index + 2] === 0x83,
            );
            assert.ok(at >= 0, 'DefaultDuration is written');
            let duration = 0;
            for (let index = 0; index < (out[at + 3] & 0x0f); index++)
                duration = duration * 256 + out[at + 4 + index];
            assert.equal(duration, 40_000_000);
            const reopened = await inspect(out);
            assert.equal(reopened.tracks[0].codec, 'mp4v.61');
        });

        test('a stream refreshed without IDR pictures copies with its parameter sets', async () => {
            // It has no keyframe; the copy still opens.
            const refreshed = transportStream(
                [{ pid: 0x100, streamType: 0x1b }],
                [
                    {
                        pid: 0x100,
                        streamId: 0xe0,
                        payload: annexB(aud, sps, pps, predicted),
                        pts: 90000,
                        dts: 90000,
                    },
                    {
                        pid: 0x100,
                        streamId: 0xe0,
                        payload: annexB(aud, predicted),
                        pts: 93600,
                        dts: 93600,
                    },
                ],
            );
            const copy = await readAll(
                await bytesOf(await convert(refreshed, { to: 'ts', copy: true })),
            );
            assert.equal(copy.tracks[0].codec, 'avc1.42000a');
            assert.equal(copy.packets.length, 2);
        });

        test("a sample holding the next picture's delimiter stays one access unit", async () => {
            // FFmpeg's mixed-nal-coding sample: a length-prefixed unit holds the Annex B access
            // unit delimiter of the next picture, which the TS copy splits out and drops.
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
                        codecConfig: AVCC,
                    },
                },
                sink,
            );
            [
                lengthPrefixed(4, join(idr, [0, 0, 0, 1, 9, 0x30])),
                lengthPrefixed(4, join(predicted, [0, 0, 1, 9, 0x30])),
            ].forEach((data, index) =>
                muxer.addVideoChunk(
                    {
                        trackType: 'video',
                        data,
                        timestamp: index * 0.04,
                        duration: 0.04,
                        isKeyframe: index === 0,
                    },
                    AVCC,
                ),
            );
            await muxer.finalize();
            const output = await bytesOf(
                await convert(sink.toUint8Array(), { to: 'ts', copy: true }),
            );
            assert.equal(Buffer.from(output).indexOf(Buffer.of(0, 0, 1, 9, 0x30)), -1);
            const { packets } = await readAll(output);
            assert.deepEqual(
                packets.map(packet =>
                    nalTypes(packet.data).filter(type => type === 5 || type === 1),
                ),
                [[5], [1]],
            );
        });

        test('22.05 kHz AAC on the 90 kHz clock copies whole into fragmented MP4', async () => {
            // Rounding the stamps and the fragment times apart puts some frames one tick before the
            // end of the frame before, which is not an overlap.
            const frames = [...AAC_PAYLOADS, ...AAC_PAYLOADS].map(payload => {
                const frame = adtsFrame(payload);
                frame[2] = 0x5c;
                return frame;
            });
            const step = (1024 / 22050) * 90000;
            const slow = transportStream(
                [{ pid: 0x101, streamType: 0x0f }],
                frames.map((frame, index) => ({
                    pid: 0x101,
                    streamId: 0xc0,
                    payload: frame,
                    pts: Math.round(90002 + index * step),
                })),
            );
            const parts = [];
            await packageMedia(slow, 'hls', {
                container: 'fmp4',
                onFile: file => file.kind === 'playlist' || parts.push(file.data),
            });
            const fragmented = new Uint8Array(Buffer.concat(parts));
            const { tracks } = await readMedia(fragmented);
            assert.equal(tracks[0].packets.length, frames.length);
        });
    });

    describe('video', () => {
        test('an avc3 track copies its parameter sets in band', async () => {
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
            const muxer = new TsMuxer({ format: 'ts', video }, sink);
            [lengthPrefixed(4, sps, pps, idr), lengthPrefixed(4, predicted)].forEach(
                (data, index) =>
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
            assert.equal((await readAll(output)).packets.length, 2);
            assert.ok(Buffer.from(output).includes(Buffer.from(join([0, 0, 1], sps))));
        });

        test('HEVC NAL units whose header bytes have zero low bits become Annex B', async () => {
            // A VPS (type 32, 0x40) and a TRAIL_N slice (type 0, 0x00): HEVC types whose first byte
            // has no low five bits.
            const vps = [0x40, 0x01, 0x0c, 0x01];
            const hvcC = [
                ...[1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8],
                ...[0xf8, 0, 0, 0x0f],
            ];
            const sink = new MemorySink();
            const muxer = new TsMuxer(
                {
                    format: 'ts',
                    mode: 'standard',
                    autoSync: true,
                    maxFragmentDuration: 2,
                    video: {
                        type: 'video',
                        codec: 'hvc1.1.6.L93.B0',
                        width: 16,
                        height: 16,
                        framerate: 25,
                        codecConfig: Uint8Array.of(...hvcC, 1, 0x20, 0, 1, 0, vps.length, ...vps),
                    },
                },
                sink,
            );
            muxer.addVideoChunk({
                trackType: 'video',
                data: Uint8Array.of(0, 0, 0, 4, ...vps, 0, 0, 0, 3, 0x00, 0x01, 0xd0),
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
            });
            await muxer.finalize();
            const bytes = Buffer.from(sink.toUint8Array());
            assert.ok(bytes.includes(Buffer.of(0, 0, 0, 1, ...vps, 0, 0, 0, 1, 0x00, 0x01, 0xd0)));
        });

        test('an hev1 record without parameter set arrays still copies', async () => {
            // hev1 keeps its parameter sets in band.
            const { tracks } = await readMedia(FIXTURES['hevc.flv'].bytes());
            const video = tracks.find(entry => entry.track.type === 'video');
            const record = video.track.codecConfig;
            const empty = record.slice(0, 23);
            empty[22] = 0;
            const lengthSize = (record[21] & 3) + 1;
            const inBand = [];
            for (let at = 23, array = 0; array < record[22]; array++) {
                const count = (record[at + 1] << 8) | record[at + 2];
                at += 3;
                for (let index = 0; index < count; index++) {
                    const length = (record[at] << 8) | record[at + 1];
                    const prefix = Buffer.alloc(lengthSize);
                    prefix.writeUIntBE(length, 0, lengthSize);
                    inBand.push(prefix, Buffer.from(record.subarray(at + 2, at + 2 + length)));
                    at += 2 + length;
                }
            }
            const sink = new MemorySink();
            const muxer = new TsMuxer(
                {
                    format: 'ts',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'hev1.1.6.L30.90',
                        codecConfig: empty,
                        width: 32,
                        height: 24,
                        framerate: 10,
                    },
                },
                sink,
            );
            for (const packet of video.packets)
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: packet.isKeyframe
                        ? new Uint8Array(Buffer.concat([...inBand, packet.data]))
                        : packet.data,
                    timestamp: packet.timestamp,
                    decodeTimestamp: packet.decodeTimestamp,
                    duration: packet.duration,
                    isKeyframe: packet.isKeyframe,
                });
            await muxer.finalize();
            const copy = await readMedia(sink.toUint8Array());
            assert.equal(copy.tracks[0].packets.length, video.packets.length);
        });

        test('capabilities copy VC-1, AV1 and VVC into TS', async () => {
            const { videoCopy } = await capabilities();
            for (const codec of ['vc1', 'av01', 'vvc1'])
                assert.ok(videoCopy.ts.includes(codec), codec);
        });
    });

    describe('several audio tracks', () => {
        test('keep their PIDs, languages, configurations, times and payloads', async () => {
            const tracks = [aacTrack(0), aacTrack(1)];
            const bytes = await multiAudio(tracks);
            const streams = pmtStreams(bytes);
            assert.deepEqual(
                streams.map(stream => [stream.pid, stream.type, [...stream.descriptors]]),
                [
                    [0x101, 15, [10, 4, 101, 110, 103, 0]],
                    [0x102, 15, [10, 4, 106, 112, 110, 0]],
                ],
            );
            const counters = new Map();
            for (const packet of packetsOf(bytes)) {
                if (!(packet[3] & 0x10)) continue;
                const pid = pidOf(packet);
                if (counters.has(pid)) assert.equal(packet[3] & 15, (counters.get(pid) + 1) & 15);
                counters.set(pid, packet[3] & 15);
            }
            const read = await new TsDemuxer().demux(new Blob([bytes]));
            assert.equal(read.audioTracks.length, 2);
            read.audioTracks.forEach((track, i) => {
                const { language, sampleRate, channelCount, codecConfig } = tracks[i];
                assert.deepEqual(
                    [track.language, track.sampleRate, track.channelCount, track.codecConfig],
                    [language, sampleRate, channelCount, codecConfig],
                );
                assert.equal(track.samples.length, 4);
                track.samples.forEach((sample, j) => {
                    assert.deepEqual(sample.data, aacChunk(tracks[i], j).data);
                    assert.ok(Math.abs(sample.timestamp - (j * 1024) / sampleRate) <= 1 / 90000);
                });
            });
        });

        test('a PMT assembled elsewhere exposes every audio PID', async () => {
            const inputs = await Promise.all(
                [aacTrack(0), aacTrack(1)].map(track => multiAudio([track], 2)),
            );
            const section = Buffer.from([
                ...[2, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0, 15, 0xe1, 1, 0xf0, 0],
                ...[15, 0xe1, 2, 0xf0, 0],
            ]);
            const crc = Buffer.alloc(4);
            crc.writeUInt32BE(crc32(section));
            const table = Buffer.alloc(188, 255);
            table.set([0x47, 0x50, 0, 0x10, 0]);
            table.set(section, 5);
            table.set(crc, 5 + section.length);
            const media = inputs.map((bytes, i) =>
                packetsOf(bytes)
                    .filter(packet => pidOf(packet) === 0x101)
                    .map(packet => {
                        const moved = packet.slice();
                        moved[2] += i;
                        return moved;
                    }),
            );
            const bytes = Buffer.concat([packetsOf(inputs[0])[0], table, ...media.flat()]);
            assert.equal(pmtStreams(bytes).length, 2);
            const read = await new TsDemuxer().demux(new Blob([bytes]));
            assert.deepEqual(
                read.audioTracks.map(track => track.sampleRate),
                [48000, 44100],
            );
        });

        test('a PMT spanning transport packets lists all 32 audio streams', async () => {
            const tracks = Array.from({ length: 32 }, (_, i) => aacTrack(i));
            const bytes = await multiAudio(tracks, 1);
            assert.equal(pmtStreams(bytes).length, tracks.length);
            const read = await new TsDemuxer().demux(new Blob([bytes]));
            assert.equal(read.audioTracks.length, tracks.length);
            read.audioTracks.forEach((track, i) =>
                assert.deepEqual(track.samples[0].data, aacChunk(tracks[i]).data),
            );
        });

        test('AAC and MPEG audio take their own stream types and frame durations', async () => {
            const tracks = [
                aacTrack(0),
                aacTrack(1, {
                    codec: 'mp2',
                    sampleRate: 48000,
                    channelCount: 2,
                    codecConfig: undefined,
                }),
            ];
            const sink = new MemorySink();
            const muxer = new TsMuxer(muxerConfig(tracks), sink);
            const frame = new Uint8Array(384);
            frame.set([0xff, 0xfd, 0x84, 0]);
            muxer.addExtraAudioChunk(0, { ...aacChunk(tracks[1]), data: frame });
            muxer.addAudioChunk(aacChunk(tracks[0]));
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            assert.deepEqual(
                pmtStreams(bytes).map(stream => stream.type),
                [15, 3],
            );
            const read = await new TsDemuxer().demux(new Blob([bytes]));
            assert.deepEqual(
                read.audioTracks.map(track => track.codec),
                ['mp4a.40.2', 'mp2'],
            );
            assert.equal(read.audioTracks[1].samples[0].duration, 1152 / 48000);
            assert.deepEqual(read.audioTracks[1].samples[0].data, frame);
        });

        test('wrong extra routes and empty declared tracks fail, dropping no audio', async () => {
            const muxer = new TsMuxer(muxerConfig([aacTrack(0), aacTrack(1)]), new MemorySink());
            assert.throws(() => muxer.addExtraAudioChunk(1, aacChunk(aacTrack(1))), /track|index/i);
            assert.throws(
                () => muxer.addExtraAudioChunk(0, { ...aacChunk(aacTrack(1)), trackType: 'video' }),
                /audio|video/,
            );
            muxer.addAudioChunk(aacChunk(aacTrack(0)));
            await assert.rejects(muxer.finalize(), /audio.*no|no.*audio/);
        });

        test('64 frames fit a sample index budget of 16 KiB, and 63 samples do not', async () => {
            const bytes = await multiAudio([aacTrack(0)], 64);
            const read = await new TsDemuxer({ maxSamples: 64, maxIndexBytes: 64 * 256 }).demux(
                new Blob([bytes]),
            );
            assert.equal(read.audioTracks[0].samples.length, 64);
            assert.deepEqual(read.audioTracks[0].samples[63].data, aacChunk(aacTrack(0), 63).data);
            await assert.rejects(
                new TsDemuxer({ maxSamples: 63 }).demux(new Blob([bytes])),
                error => error.code === 'OOM',
            );
        });

        test('an earlier second audio track starts the clock before its first PES', async () => {
            const tracks = [aacTrack(0), aacTrack(1)];
            const sink = new MemorySink();
            const muxer = new TsMuxer(muxerConfig(tracks), sink);
            muxer.addExtraAudioChunk(0, aacChunk(tracks[1]));
            muxer.addAudioChunk({ ...aacChunk(tracks[0]), timestamp: 5 });
            await muxer.finalize();
            const rows = packetsOf(sink.toUint8Array());
            const firstPcr = rows.findIndex(p => p[3] & 0x20 && p[4] >= 7 && p[5] & 0x10);
            const firstSecondary = rows.findIndex(p => pidOf(p) === 0x102 && p[3] & 0x10);
            assert.ok(firstPcr >= 0 && firstPcr < firstSecondary);
            assert.equal(pidOf(rows[firstPcr]), 0x101);
            assert.deepEqual([...rows[firstPcr].subarray(6, 11)], [0, 0, 0, 0, 0x7e]);
            const read = await new TsDemuxer().demux(sink.toBlob());
            assert.deepEqual(
                read.audioTracks.map(track => track.samples[0].timestamp),
                [5, 0],
            );
        });
    });

    test("DTS keeps stream type 0x82 and names itself with the registration 'DTS1'", async () => {
        // Readers without Blu-ray tables (ffmpeg) need it to know the stream; the copy reads back
        // as DTS.
        const frames = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
        const bytes = await bytesOf(await convert(Buffer.concat(frames), 'ts'));
        let pmt;
        for (let at = 0; at + 188 <= bytes.length && !pmt; at += 188)
            if ((((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2]) === 0x1000)
                pmt = bytes.subarray(at + 5, at + 188);
        assert.ok(pmt, 'a PMT is written');
        const entry = Buffer.from(pmt).indexOf(Buffer.from([0x82]), 12);
        assert.ok(entry > 0, 'stream type 0x82');
        assert.deepEqual([...pmt.subarray(entry + 5, entry + 11)], [5, 4, 0x44, 0x54, 0x53, 0x31]);
        assert.equal((await readAll(bytes)).tracks[0].codec, 'dtsc');
    });
});
