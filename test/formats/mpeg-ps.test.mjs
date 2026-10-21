import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, open } from 'mediaforgejs';
import { annexB, aud, idr, join, pps, predicted, sps } from '../helpers/avi-h264-fixtures.mjs';
import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    ac3Frame,
    lpcmSubstream,
    mpeg2Gop,
    mpeg4Config,
    mpeg4Vop,
    mpegSequence,
    packHeader,
    pesPacket,
    privateSubstream,
    programEnd,
    programStream,
    systemHeader,
} from '../helpers/mpeg-video-fixtures.mjs';
import { dtsCore } from '../helpers/sync-audio-fixtures.mjs';
import { mpegAudioFixture } from '../helpers/original-fixtures.mjs';
import { differentialFixtures } from '../helpers/differential-fixtures.mjs';
import { assertTimes, copied, readMedia } from '../helpers/read-media.mjs';

/** Program stream entries of the pictures `units`, B-pictures without a decode time. */
const videoEntries = (units, { mpeg1 = false } = {}) =>
    units.map(unit => ({
        streamId: 0xe0,
        payload: unit.data,
        pts: unit.pts,
        dts: unit.type === PICTURE_B ? undefined : unit.dts,
        scr: unit.dts - 900,
        mpeg1,
    }));

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

/** MPEG-2 video with B-pictures, AC-3 and DVD LPCM and a subpicture in private stream 1. */
function dvdStream() {
    const units = mpeg2Gop();
    const samples = Uint8Array.from({ length: 64 }, (_, index) => index * 3);
    const bytes = join(
        packHeader(80000),
        systemHeader(),
        programStream([
            ...videoEntries(units),
            {
                streamId: 0xbd,
                payload: privateSubstream(0x80, join(ac3Frame(1), ac3Frame(2))),
                pts: 90000,
            },
            { streamId: 0xbd, payload: lpcmSubstream(samples), pts: 90000 },
            { streamId: 0xbd, payload: join([0x20, 0, 0, 0], new Uint8Array(12)), pts: 90000 },
        ]),
    );
    return { units, samples, bytes };
}

const DTS_FRAMES = [dtsCore({ fill: 1 }), dtsCore({ fill: 2 })];

/** H.264 whose access units PES packets cut, a DTS substream between the parts of the first. */
function dtsAndH264Stream() {
    const first = annexB(aud, sps, pps, idr);
    const second = annexB(aud, predicted);
    return programStream([
        { streamId: 0xe0, payload: first.subarray(0, 40), pts: 90000 },
        { streamId: 0xbd, payload: privateSubstream(0x88, join(...DTS_FRAMES)), pts: 90000 },
        { streamId: 0xe0, payload: first.subarray(40) },
        { streamId: 0xe0, payload: second.subarray(0, 9), pts: 93600 },
        { streamId: 0xe0, payload: second.subarray(9) },
    ]);
}

describe('mpeg-ps', () => {
    test('reads MPEG-2 video with its B-pictures in decode order and their PES times', async () => {
        const { units, bytes } = dvdStream();
        const { format, tracks, warnings } = await readMedia(bytes);
        assert.equal(format, 'mpeg');
        assert.deepEqual(warnings, []);
        const [{ track, packets }] = tracks;
        assert.equal(track.codec, 'mp4v.61');
        assert.deepEqual([track.width, track.height], [32, 16]);
        assert.deepEqual(track.codecConfig, mpegSequence({ profile: 0x48 }));
        assert.deepEqual(
            packets.map(packet => packet.data),
            units.map(unit => unit.data),
        );
        assertTimes(
            assert,
            packets.map(packet => packet.timestamp),
            units.map(unit => unit.pts / 90000),
            'presentation times',
        );
        assertTimes(
            assert,
            packets.map(packet => packet.decodeTimestamp),
            units.map(unit => unit.dts / 90000),
            'decode times',
        );
        assert.deepEqual(
            packets.map(packet => packet.isKeyframe),
            units.map(unit => unit.type === PICTURE_I),
        );
    });

    test('reads AC-3 in private stream 1 with a dac3 record from its first syncframe', async () => {
        const { tracks } = await readMedia(dvdStream().bytes);
        const { track, packets } = tracks[1];
        assert.equal(track.codec, 'ac-3');
        assert.deepEqual([track.sampleRate, track.channelCount], [48000, 2]);
        assert.deepEqual(track.codecConfig, Uint8Array.of(0x10, 0x10, 0x00));
        assert.deepEqual(
            packets.map(packet => packet.data),
            [ac3Frame(1), ac3Frame(2)],
        );
        assertTimes(
            assert,
            packets.map(packet => packet.timestamp),
            [1, 1.032],
            'AC-3 times',
        );
    });

    test('reads DVD LPCM as big-endian PCM without its substream header', async () => {
        const { samples, bytes } = dvdStream();
        const { tracks } = await readMedia(bytes);
        const { track, packets } = tracks[2];
        assert.equal(track.codec, 'pcm-s16be');
        assert.deepEqual([track.sampleRate, track.channelCount], [48000, 2]);
        assert.deepEqual(packets[0].data, samples);
        assertTimes(assert, [packets[0].timestamp], [1], 'LPCM time');
    });

    test('ignores subpicture streams', async () => {
        const { tracks } = await readMedia(dvdStream().bytes);
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['mp4v.61', 'ac-3', 'pcm-s16be'],
        );
    });

    test('copies MPEG-2 video into MP4 with the sequence header in its esds', async () => {
        const { units, bytes } = dvdStream();
        const media = await open(bytes);
        const trackIds = media.tracks.slice(0, 2).map(track => track.id);
        media.close();
        const copy = await readMedia(await copied(bytes, 'mp4', { trackIds }));
        const [video, audio] = copy.tracks;
        assert.equal(video.track.codec, 'mp4v.61');
        assert.deepEqual(video.track.codecConfig, mpegSequence({ profile: 0x48 }));
        assert.deepEqual(
            video.packets.map(packet => packet.data),
            units.map(unit => unit.data),
        );
        assertTimes(
            assert,
            video.packets.map(packet => packet.timestamp - video.packets[0].timestamp),
            units.map(unit => (unit.pts - units[0].pts) / 90000),
            'presentation times of the copy',
        );
        assert.equal(audio.track.codec, 'ac-3');
    });

    test('reads an MPEG-1 system stream and its MPEG-1 pixel aspect code', async () => {
        const units = mpeg2Gop({ sequence: mpegSequence({ aspect: 3 }), mpeg1: true });
        const { format, tracks, warnings } = await readMedia(
            programStream(videoEntries(units, { mpeg1: true }), { mpeg1: true }),
        );
        assert.equal(format, 'mpeg');
        assert.deepEqual(warnings, []);
        const [{ track, packets }] = tracks;
        assert.equal(track.codec, 'mp4v.6a');
        assert.deepEqual([track.pixelAspectRatioNum, track.pixelAspectRatioDen], [64, 45]);
        assert.deepEqual(
            packets.map(packet => packet.data),
            units.map(unit => unit.data),
        );
        assertTimes(
            assert,
            packets.map(packet => packet.timestamp),
            units.map(unit => unit.pts / 90000),
            'presentation times',
        );
    });

    test('recognises MPEG-4 Part 2 video by its visual object sequence', async () => {
        const config = mpeg4Config({ level: 3 });
        const vops = [join(config, mpeg4Vop(PICTURE_I)), mpeg4Vop(PICTURE_P), mpeg4Vop(PICTURE_B)];
        const { tracks } = await readMedia(
            programStream([
                { streamId: 0xe0, payload: vops[0], pts: 3600, dts: 0 },
                { streamId: 0xe0, payload: vops[1], pts: 10800, dts: 3600 },
                { streamId: 0xe0, payload: vops[2], pts: 7200 },
            ]),
        );
        const [{ track, packets }] = tracks;
        assert.equal(track.codec, 'mp4v.20.3');
        assert.deepEqual(track.codecConfig, config);
        assert.deepEqual(
            packets.map(packet => packet.data),
            vops,
        );
        assertTimes(
            assert,
            packets.map(packet => packet.timestamp),
            [0.04, 0.12, 0.08],
            'presentation times',
        );
        assert.deepEqual(
            packets.map(packet => packet.isKeyframe),
            [true, false, false],
        );
    });

    test('resynchronises after junk at the next pack, dropping the frame it cut', async () => {
        const units = mpeg2Gop();
        const entries = videoEntries(units);
        const damaged = join(
            programStream(entries.slice(0, 3), { end: false }),
            new Uint8Array(100).fill(0x55),
            programStream(entries.slice(3)),
        );
        const { tracks, warnings } = await readMedia(damaged);
        assert.deepEqual(warnings, ['PS_RESYNCHRONIZED', 'PS_VIDEO_FRAME_DAMAGED']);
        const kept = units.filter((_, index) => index !== 2);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            kept.map(unit => unit.data),
        );
        assertTimes(
            assert,
            tracks[0].packets.map(packet => packet.timestamp),
            kept.map(unit => unit.pts / 90000),
            'times of the kept frames',
        );
        await rejectsStrict(damaged);
    });

    test('keeps the complete frames before a packet the end of the input cuts', async () => {
        const units = mpeg2Gop();
        const truncated = programStream(videoEntries(units), { end: false }).slice(0, -10);
        const { tracks, warnings } = await readMedia(truncated);
        assert.deepEqual(warnings, ['PS_TRUNCATED_PACKET']);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            units.slice(0, -1).map(unit => unit.data),
        );
    });

    test('keeps the only picture that damage cuts, joined with the slices after it', async () => {
        const [unit] = mpeg2Gop();
        const at = Buffer.from(unit.data).lastIndexOf(Buffer.from([0, 0, 1, 1]));
        const slice = join([0, 0, 1, 2], unit.data.subarray(at + 4));
        const [entry] = videoEntries([unit]);
        const damaged = join(
            programStream([entry], { end: false }),
            new Uint8Array(100).fill(0x55),
            programStream([{ streamId: 0xe0, payload: slice, scr: entry.scr }]),
        );
        const { tracks, warnings } = await readMedia(damaged);
        assert.deepEqual(
            tracks.map(({ packets }) => packets.map(packet => packet.data)),
            [[join(unit.data, slice)]],
        );
        assert.deepEqual([...new Set(warnings)], ['PS_RESYNCHRONIZED', 'PS_VIDEO_FRAME_DAMAGED']);
        await rejectsStrict(damaged);
    });

    test('continues the timeline after a clock reset and keeps the spacing after it', async () => {
        const first = mpeg2Gop({ start: 900000 });
        const second = mpeg2Gop({ start: 90000 });
        const { tracks, warnings } = await readMedia(
            programStream([...videoEntries(first), ...videoEntries(second)]),
        );
        assert.deepEqual(warnings, ['PS_TIMESTAMP_DISCONTINUITY']);
        const times = tracks[0].packets.map(packet => packet.decodeTimestamp);
        assert.equal(times.length, 14);
        assert.ok(
            times.every((value, index) => index === 0 || value > times[index - 1]),
            `decode times rise across the reset: ${times}`,
        );
        assertTimes(
            assert,
            times.slice(7).map(value => value - times[7]),
            second.map(unit => (unit.dts - second[0].dts) / 90000),
            'spacing after the reset',
        );
    });

    test('unwraps a 33-bit clock wrap without a warning', async () => {
        const wrap = 2 ** 33;
        const late = mpeg2Gop({ start: wrap - 7200 });
        const early = mpeg2Gop({ start: wrap - 7200 + 7 * 3600 }).map(unit => ({
            ...unit,
            dts: unit.dts - wrap,
            pts: unit.pts - wrap,
        }));
        const { tracks, warnings } = await readMedia(
            programStream(
                [...late, ...early].map(unit => ({
                    streamId: 0xe0,
                    payload: unit.data,
                    pts: (unit.pts + wrap) % wrap,
                    dts: unit.type === PICTURE_B ? undefined : (unit.dts + wrap) % wrap,
                    scr: (unit.dts - 900 + wrap) % wrap,
                })),
            ),
        );
        assert.deepEqual(warnings, []);
        const times = tracks[0].packets.map(packet => packet.decodeTimestamp);
        assertTimes(
            assert,
            times.map(value => value - times[0]),
            Array.from({ length: 14 }, (_, index) => index * 0.04),
            'decode times across the wrap',
        );
    });

    test('detects a pack header and reads up to the program end code', async () => {
        const bytes = join(
            packHeader(0),
            pesPacket(0xe0, mpeg2Gop()[0].data, { pts: 3600, dts: 0 }),
            programEnd(),
        );
        const { format, tracks } = await readMedia(bytes);
        assert.equal(format, 'mpeg');
        assert.equal(tracks[0].packets.length, 1);
    });

    test('capabilities name mpeg, ps and vob and where MPEG video copies to', async () => {
        const reported = await capabilities();
        for (const name of ['mpeg', 'ps', 'vob'])
            assert.ok(reported.containers.read.includes(name), `reads ${name}`);
        for (const container of ['mp4', 'mov', 'mkv', 'ts', 'avi'])
            for (const codec of ['mpeg1v', 'mpeg2v', 'mpeg4v'])
                assert.ok(reported.videoCopy[container].includes(codec), `${container} ${codec}`);
    });

    test('omits a video stream without a sequence header and keeps the others', async () => {
        const entries = [
            ...videoEntries(mpeg2Gop().slice(1)),
            { streamId: 0xbd, payload: privateSubstream(0x80, ac3Frame()), pts: 90000 },
        ];
        const { tracks, warnings } = await readMedia(programStream(entries));
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['ac-3'],
        );
        assert.deepEqual(warnings, ['PS_VIDEO_UNUSABLE']);
        await rejectsStrict(programStream(entries));
    });

    test('rejects a stream whose only video has no sequence header', async () => {
        await assert.rejects(
            open(programStream(videoEntries(mpeg2Gop().slice(1)))),
            error => error.code === 'DEMUX' && /sequence header/.test(error.message),
        );
    });

    test('reads DVD DTS substreams with the codec string of the other containers', async () => {
        const { tracks, warnings } = await readMedia(dtsAndH264Stream());
        assert.deepEqual(warnings, []);
        const { track, packets } = tracks[1];
        assert.equal(track.codec, 'dtsc');
        assert.deepEqual(
            packets.map(packet => packet.data),
            DTS_FRAMES,
        );
        assert.equal(track.codecConfig.length, 20, 'a DTSSpecificBox for MP4 copies');
    });

    test('reads H.264 access units that PES packets cut, each with its own PES time', async () => {
        // An access unit starts at a delimiter or a new picture wherever the PES packets cut it,
        // also with a packet of another stream between its parts.
        const { tracks, warnings } = await readMedia(dtsAndH264Stream());
        assert.deepEqual(warnings, []);
        assert.equal(tracks[0].track.codec, 'avc1.42000a');
        const lengthPrefixed = unit => join([0, 0, unit.length >> 8, unit.length & 255], unit);
        assert.deepEqual(
            tracks[0].packets.map(packet => [packet.data, packet.timestamp, packet.isKeyframe]),
            [
                [lengthPrefixed(idr), 1, true],
                [lengthPrefixed(predicted), 1.04, false],
            ],
        );
    });

    test('reads PES packets without pack headers behind leading junk', async () => {
        const frames = mpegAudioFixture(2);
        const frameLength = frames.length / 4;
        const stream = join(
            new Uint8Array(300).fill(0x5a),
            pesPacket(0xc0, frames.subarray(0, 2 * frameLength), { pts: 90000 }),
            pesPacket(0xc0, frames.subarray(2 * frameLength), { pts: 90000 + 2 * 2160 }),
        );
        const { format, tracks } = await readMedia(stream);
        assert.equal(format, 'mpeg');
        assert.deepEqual(
            tracks.map(({ track, packets }) => [
                track.codec,
                packets.length,
                Boolean(track.incomplete),
            ]),
            [['mp2', 4, false]],
        );
    });

    test('keeps the whole frames of audio the end cuts, marked incomplete', async () => {
        const frames = mpegAudioFixture(2);
        const frameLength = frames.length / 4;
        const stream = join(
            pesPacket(0xc0, frames.subarray(0, 2 * frameLength), { pts: 90000 }),
            pesPacket(0xc0, frames.subarray(2 * frameLength), { pts: 90000 + 2 * 2160 }),
        );
        const whole = await readMedia(stream);
        const cut = await readMedia(stream.subarray(0, stream.length - 50));
        assert.deepEqual(
            cut.tracks.map(({ track, packets }) => [packets.length, Boolean(track.incomplete)]),
            [[3, true]],
        );
        assert.deepEqual(
            cut.tracks[0].packets.map(packet => packet.data),
            whole.tracks[0].packets.slice(0, 3).map(packet => packet.data),
        );
    });

    test('a malformed PES header after leading data does not hide the first pictures', async () => {
        // A QuickTime header or a damaged start before the stream: a start code there whose PES
        // header is malformed lent its length, which skipped the first pictures of the stream.
        const clean = differentialFixtures['ps-mpeg1.mpg']();
        const junk = new Uint8Array(16);
        junk.set([0, 0, 1, 0xd4]);
        new DataView(junk.buffer).setUint16(4, 2100);
        junk.set([0x80, 0x40], 6);
        const intact = await readMedia(clean);
        const prefixed = await readMedia(join(junk, clean));
        assert.deepEqual(prefixed.warnings, ['PS_MALFORMED_PES', 'PS_RESYNCHRONIZED']);
        assert.deepEqual(
            prefixed.tracks.map(({ packets }) => packets.map(packet => packet.data)),
            intact.tracks.map(({ packets }) => packets.map(packet => packet.data)),
        );
    });
});
