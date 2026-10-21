import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, convert, open } from 'mediaforgejs';
import { encodeMp3, parseMp3FrameHeader } from 'mediaforgejs/codecs';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { flvFile, flvTags } from '../helpers/flv-tags.mjs';
import { assertReadsAsRecorded } from '../helpers/recorded-fixtures.mjs';
import { allPackets, bytesOf, copied, readMedia } from '../helpers/read-media.mjs';
import {
    annexB,
    aud,
    idr,
    join,
    lengthPrefixed,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { FlvMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { transportStream } from '../helpers/mpeg-video-fixtures.mjs';
import { flvFile as tagFile, flvTag as tag } from '../helpers/sync-audio-fixtures.mjs';
import { concat } from '../helpers/original-fixtures.mjs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

const payloads = packets => packets.map(packet => packet.data);
const audioOf = packets => packets.filter(packet => packet.trackType === 'audio');

/**
 * The AAC tags of flv-title.flv with an AudioSpecificConfig of AAC-LC at 22.05 kHz, channel
 * configuration 0 and a program_config_element of one front mono element.
 */
function withProgramConfig() {
    const parsed = flvTags(fixtures['flv-title.flv']());
    const bits = [];
    const put = (value, count) => {
        for (let bit = count - 1; bit >= 0; bit--) bits.push((value >> bit) & 1);
    };
    put(2, 5);
    put(7, 4);
    put(0, 4);
    put(0, 3);
    put(0, 4);
    put(1, 2);
    put(7, 4);
    put(1, 4);
    put(0, 4 + 4 + 2 + 3 + 4 + 3);
    put(0, 5);
    while (bits.length % 8) bits.push(0);
    put(0, 8);
    const pce = Uint8Array.from({ length: bits.length / 8 }, (_, index) =>
        bits.slice(index * 8, index * 8 + 8).reduce((value, bit) => value * 2 + bit, 0),
    );
    return flvFile(
        parsed.head,
        parsed.tags.map(tag =>
            tag.type === 8 && tag.data[1] === 0
                ? { ...tag, data: new Uint8Array([tag.data[0], 0, ...pce]) }
                : tag,
        ),
    ).bytes;
}

describe('flv', () => {
    test('reads hevc.flv as recorded: tracks, packet times, keyframes and payloads', () =>
        assertReadsAsRecorded('hevc.flv'));

    test('B-frame video ends at the onMetaData duration', async () => {
        const { tracks } = await readMedia(fixtures['flv-bframes.flv']());
        const { track, packets } = tracks[0];
        const end = Math.max(...packets.map(packet => packet.timestamp + packet.duration));
        assert.equal(Number(end.toFixed(6)), 0.7);
        assert.equal(Number(track.duration.toFixed(6)), 0.7);
    });

    test('takes the title from onMetaData', async () => {
        const { title, tracks } = await readMedia(fixtures['flv-title.flv']());
        assert.equal(title, 'Flash');
        assert.equal(
            tracks.reduce((sum, entry) => sum + entry.packets.length, 0),
            3,
        );
    });

    test('omits Sorenson video and keeps the MP3 audio of the same file', async () => {
        const { tracks, warnings } = await readMedia(fixtures['flv-sorenson-mp3.flv']());
        assert.deepEqual(warnings, ['FLV_UNSUPPORTED_CODEC']);
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['mp3'],
        );
        assert.equal(tracks[0].packets.length, 10);
    });

    test('a file without its last PreviousTagSize keeps every tag and stays complete', async () => {
        const whole = fixtures['flv-bframes.flv']();
        const { tracks, warnings } = await readMedia(whole.subarray(0, whole.length - 4));
        assert.deepEqual(warnings, ['FLV_TRUNCATED']);
        assert.equal(tracks[0].track.incomplete, undefined);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(whole)));
    });

    test('a cut file keeps its complete tags, ends where they end and is incomplete', async () => {
        const whole = fixtures['flv-bframes.flv']();
        const view = new DataView(whole.buffer);
        const lastTag = whole.length - 4 - view.getUint32(whole.length - 4);
        // The final tag is the AVC end-of-sequence marker; the tag before it holds the last
        // picture.
        const lastPicture = lastTag - 4 - view.getUint32(lastTag - 4);
        const cut = whole.subarray(0, lastPicture + 14);
        const { tracks, warnings } = await readMedia(cut);
        assert.deepEqual(warnings, ['FLV_TRUNCATED']);
        assert.equal(tracks[0].track.incomplete, true);
        assert.deepEqual(
            payloads(tracks[0].packets),
            payloads(await allPackets(whole)).slice(0, -1),
        );
        assert.ok(tracks[0].track.duration < 0.7, `${tracks[0].track.duration}`);
        await rejectsStrict(cut);
    });

    test('a PreviousTagSize that disagrees with its tag is tolerated with a warning', async () => {
        const whole = fixtures['flv-bframes.flv']();
        const lastTag = whole.length - 4 - new DataView(whole.buffer).getUint32(whole.length - 4);
        const mismatch = whole.slice();
        new DataView(mismatch.buffer).setUint32(lastTag - 4, 1);
        const { tracks, warnings } = await readMedia(mismatch);
        assert.deepEqual(warnings, ['FLV_PREVIOUS_TAG_SIZE']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(whole)));
        await rejectsStrict(mismatch);
    });

    test('a tag holding two MP3 frames gives two packets, the second after the first', async () => {
        const sorenson = fixtures['flv-sorenson-mp3.flv']();
        const { head, tags } = flvTags(sorenson);
        const audio = tags.flatMap((tag, index) => (tag.type === 8 ? [index] : []));
        const merged = tags.slice();
        merged[audio[0]] = {
            ...tags[audio[0]],
            data: new Uint8Array(
                Buffer.concat([tags[audio[0]].data, tags[audio[1]].data.subarray(1)]),
            ),
        };
        merged.splice(audio[1], 1);
        const split = audioOf(await allPackets(flvFile(head, merged).bytes));
        assert.deepEqual(payloads(split), payloads(audioOf(await allPackets(sorenson))));
        const [one, two] = split;
        assert.ok(Math.abs(two.timestamp - one.timestamp - one.duration) < 1e-9);
    });

    test('tags of two MP3 frames decode without gaps between the tags', async () => {
        const silence = [new Float32Array(1152 * 16)];
        const stream = await encodeMp3(silence, { sampleRate: 44100, bitrate: 64 });
        const frames = [];
        for (let at = 0; at < stream.length;) {
            const length = parseMp3FrameHeader(stream, at).frameLength;
            frames.push(stream.subarray(at, at + length));
            at += length;
        }
        const audio = frames.slice(-16);
        const tags = [];
        for (let index = 0; index < 16; index += 2)
            tags.push({
                type: 8,
                timestamp: Math.round((index * 1152 * 1000) / 44100),
                data: new Uint8Array(
                    Buffer.concat([Buffer.of(0x2e), audio[index], audio[index + 1]]),
                ),
            });
        const head = Uint8Array.of(0x46, 0x4c, 0x56, 1, 4, 0, 0, 0, 9, 0, 0, 0, 0);
        const flv = flvFile(head, tags).bytes;
        assert.equal((await allPackets(flv)).length, 16);
        const wav = await bytesOf(await convert(flv, { to: 'wav', copy: false }));
        const dataAt = Buffer.from(wav).indexOf('data');
        assert.equal(new DataView(wav.buffer).getUint32(dataAt + 4, true) / 2, 16 * 1152);
    });

    test('resynchronises after a damaged tag header and drops that tag', async () => {
        const sorenson = fixtures['flv-sorenson-mp3.flv']();
        const { head, tags } = flvTags(sorenson);
        const audio = tags.flatMap((tag, index) => (tag.type === 8 ? [index] : []));
        const { bytes, offsets } = flvFile(head, tags);
        const damaged = bytes.slice();
        damaged.fill(0, offsets[audio[2]], offsets[audio[2]] + 11);
        const { tracks, warnings } = await readMedia(damaged);
        assert.ok(warnings.includes('FLV_RESYNCHRONIZED'), `${warnings}`);
        assert.deepEqual(
            payloads(tracks[0].packets),
            payloads(audioOf(await allPackets(sorenson))).filter((_, index) => index !== 2),
        );
        await rejectsStrict(damaged);
    });

    test('an onMetaData duration past the sound does not stretch its last AAC frame', async () => {
        const longer = fixtures['flv-title.flv']().slice();
        const at = Buffer.from(longer).indexOf('duration') + 'duration'.length + 1;
        const view = new DataView(longer.buffer, longer.byteOffset);
        view.setFloat64(at, view.getFloat64(at) + 1);
        const { tracks } = await readMedia(longer);
        const { track, packets } = tracks[0];
        const last = packets.at(-1);
        assert.equal(Math.round(last.duration * track.sampleRate), 1024);
        assert.ok(Math.abs(track.duration - (last.timestamp + last.duration)) < 1e-6);
    });

    test('reads AAC whose configuration is a program config element', async () => {
        const { tracks } = await readMedia(withProgramConfig());
        assert.deepEqual(
            [tracks[0].track.codec, tracks[0].track.sampleRate, tracks[0].track.channelCount],
            ['mp4a.40.2', 22050, 1],
        );
        assert.deepEqual(
            payloads(tracks[0].packets),
            payloads(await allPackets(fixtures['flv-title.flv']())),
        );
    });

    test('ADTS cannot carry a program config element layout: AAC output encodes it', async () => {
        const action = async input => (await check(input, 'aac')).plan.tracks[0].action;
        assert.equal(await action(fixtures['flv-title.flv']()), 'copy');
        assert.equal(await action(withProgramConfig()), 'encode');
    });

    test('repairs repeated video decode times so they rise, unless strict', async () => {
        const avc = flvTags(fixtures['flv-bframes.flv']());
        const pictures = avc.tags.flatMap((tag, index) =>
            tag.type === 9 && tag.data[1] === 1 ? [index] : [],
        );
        const repeated = flvFile(
            avc.head,
            avc.tags.map((tag, index) =>
                index === pictures[1]
                    ? { ...tag, timestamp: avc.tags[pictures[0]].timestamp }
                    : tag,
            ),
        ).bytes;
        const { tracks, warnings } = await readMedia(repeated);
        assert.ok(warnings.includes('FLV_TIMESTAMPS_REPAIRED'), `${warnings}`);
        const times = tracks[0].packets.map(packet => packet.decodeTimestamp);
        assert.ok(
            times.every((time, index) => !index || time > times[index - 1]),
            `${times}`,
        );
        await rejectsStrict(repeated);
    });

    test('unwraps Annex B access units stored behind one NAL length', async () => {
        const source = fixtures['flv-bframes.flv']();
        const avc = flvTags(source);
        const wrapped = flvFile(
            avc.head,
            avc.tags.map(tag => {
                if (tag.type !== 9 || tag.data[1] !== 1) return tag;
                const units = [];
                for (let at = 5; at < tag.data.length;) {
                    const length = new DataView(tag.data.buffer).getUint32(at);
                    units.push(Buffer.of(0, 0, 0, 1), tag.data.subarray(at + 4, at + 4 + length));
                    at += 4 + length;
                }
                const annexB = Buffer.concat(units);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(annexB.length);
                return {
                    ...tag,
                    data: new Uint8Array(Buffer.concat([tag.data.subarray(0, 5), length, annexB])),
                };
            }),
        ).bytes;
        const { tracks, warnings } = await readMedia(wrapped);
        assert.ok(warnings.includes('FLV_AVC_ANNEXB_WRAPPED'), `${warnings}`);
        const original = await allPackets(source);
        assert.deepEqual(payloads(tracks[0].packets), payloads(original));
        const ts = await bytesOf(await convert(wrapped, { to: 'ts', copy: true }));
        assert.equal((await allPackets(ts)).length, original.length);
    });

    test('a stream whose clock starts late lasts from its first timestamp', async () => {
        const avc = flvTags(fixtures['flv-bframes.flv']());
        const late = flvFile(
            avc.head,
            avc.tags.map(tag =>
                tag.type === 18 ? tag : { ...tag, timestamp: tag.timestamp + 100000 },
            ),
        ).bytes;
        const { tracks } = await readMedia(late);
        assert.equal(Number(tracks[0].track.duration.toFixed(6)), 0.7);
    });

    test('audio decode times that overlap are repaired in a fragmented MP4 copy', async () => {
        const parsed = flvTags(fixtures['flv-title.flv']());
        const tags = parsed.tags.slice();
        const audio = tags.flatMap((tag, index) =>
            tag.type === 8 && tag.data[1] === 1 ? [index] : [],
        );
        tags[audio[2]] = { ...tags[audio[2]], timestamp: tags[audio[1]].timestamp + 1 };
        const result = await convert(flvFile(parsed.head, tags).bytes, {
            to: 'fmp4',
            copy: true,
            onWarning: () => {},
        });
        assert.ok(
            result.warnings.some(warning => warning.code === 'FMP4_DECODE_TIME_REPAIRED'),
            result.warnings.map(warning => warning.code).join(),
        );
    });

    test('a video clock that restarts goes on one frame step after the frame before', async () => {
        // Spliced recordings make the decode times jump back seconds; the spacing of the frames
        // after the jump is kept.
        const config = join(
            [1, 66, 0, 10, 0xff, 0xe1, 0, sps.length],
            sps,
            [1, 0, pps.length],
            pps,
        );
        const tag = (ms, body) => {
            const size = body.length;
            const head = [
                9,
                size >> 16,
                (size >> 8) & 255,
                size & 255,
                (ms >> 16) & 255,
                (ms >> 8) & 255,
                ms & 255,
                0,
            ];
            return join(head, [0, 0, 0], body, [0, 0, (size + 11) >> 8, (size + 11) & 255]);
        };
        const frame = (ms, key, nal) =>
            tag(ms, join([key ? 0x17 : 0x27, 1, 0, 0, 0], lengthPrefixed(4, nal)));
        const flv = join(
            [0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0],
            tag(0, join([0x17, 0, 0, 0, 0], config)),
            frame(0, true, idr),
            frame(1000, false, predicted),
            frame(2000, false, predicted),
            frame(40, false, predicted),
            frame(1040, false, predicted),
        );
        const { tracks, warnings } = await readMedia(flv);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.timestamp),
            [0, 1, 2, 3, 4],
        );
        assert.deepEqual(warnings, ['FLV_TIMESTAMPS_REPAIRED']);
    });

    describe('writing', () => {
        const avcRecord = join(
            [1, 66, 0, 10, 0xff, 0xe1, 0, sps.length],
            sps,
            [1, 0, pps.length],
            pps,
        );
        /** NAL unit types of a four-byte length-prefixed sample. */
        const nalTypes = data => {
            const types = [];
            const view = new DataView(data.buffer, data.byteOffset);
            for (let at = 0; at + 4 <= data.length; at += 4 + view.getUint32(at))
                types.push(data[at + 4] & 31);
            return types;
        };
        /** An FLV muxer of an AAC track (16 kHz mono unless `audio` says) and `video`, if any. */
        const flvMuxer = (sink, { video, audio = {} } = {}) =>
            new FlvMuxer(
                {
                    format: 'flv',
                    ...(video ? { video } : {}),
                    audio: {
                        id: 2,
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        sampleRate: 16000,
                        channelCount: 1,
                        ...audio,
                    },
                },
                sink,
            );

        test('Annex B pictures are stored in the avcC form', async () => {
            // As some MP4 writers stored them.
            const sink = new MemorySink();
            const video = {
                id: 1,
                type: 'video',
                codec: 'avc1.42000a',
                width: 32,
                height: 16,
                codecConfig: avcRecord,
            };
            const muxer = flvMuxer(sink, { video, audio: { sampleRate: 48000 } });
            [annexB(idr), annexB(predicted)].forEach((data, index) =>
                muxer.addVideoChunk(
                    {
                        trackType: 'video',
                        data,
                        timestamp: index * 0.04,
                        duration: 0.04,
                        isKeyframe: index === 0,
                    },
                    avcRecord,
                ),
            );
            muxer.addAudioChunk(
                {
                    trackType: 'audio',
                    data: Uint8Array.of(1, 2, 3),
                    timestamp: 0,
                    duration: 0.0213,
                    isKeyframe: true,
                },
                Uint8Array.of(0x11, 0x88),
            );
            await muxer.finalize();
            const { tracks } = await readMedia(sink.toUint8Array());
            const pictures = tracks.find(entry => entry.track.type === 'video').packets;
            assert.deepEqual(
                pictures.map(packet => nalTypes(packet.data)),
                [[5], [1]],
            );
        });

        test('an audio tag takes the decode time of its packet', async () => {
            // Audio tags carry no composition offset.
            const sink = new MemorySink();
            const muxer = flvMuxer(sink, { audio: { sampleRate: 48000 } });
            for (const [timestamp, decodeTimestamp] of [
                [0.0943, 0],
                [0.0943, 0.0464],
                [0.0929, 0.0929],
            ])
                muxer.addAudioChunk(
                    {
                        trackType: 'audio',
                        data: Uint8Array.of(1, 2, 3),
                        timestamp,
                        decodeTimestamp,
                        duration: 0.0464,
                        isKeyframe: true,
                    },
                    Uint8Array.of(0x11, 0x88),
                );
            await muxer.finalize();
            assert.deepEqual(
                (await allPackets(sink.toUint8Array())).map(packet =>
                    Math.round(packet.timestamp * 1000),
                ),
                [0, 46, 93],
            );
        });

        for (const [name, packets, expected] of [
            [
                'faac M4A priming, decoded 64 ms before zero',
                [
                    [0, -0.064],
                    [0, 0],
                    [0.064, 0.064],
                ],
                [0, 0, 64],
            ],
            [
                'priming presented 1.45 ms after the first packet shown',
                [
                    [0.00145, -0.09288],
                    [0.00145, -0.04644],
                    [0, 0],
                    [0.04644, 0.04644],
                ],
                [0, 0, 0, 46],
            ],
        ])
            test(`reordered AAC is stamped at zero where it plays: ${name}`, async () => {
                // Stamping the second at its presentation time put 0 ms after 1 ms, and the copy
                // failed.
                const sink = new MemorySink();
                const muxer = flvMuxer(sink);
                for (const [timestamp, decodeTimestamp] of packets)
                    muxer.addAudioChunk(
                        {
                            trackType: 'audio',
                            data: Uint8Array.of(1, 2, 3),
                            timestamp,
                            decodeTimestamp,
                            duration: 0.064,
                            isKeyframe: true,
                        },
                        Uint8Array.of(0x14, 0x08),
                    );
                await muxer.finalize();
                assert.deepEqual(
                    (await allPackets(sink.toUint8Array())).map(packet =>
                        Math.round(packet.timestamp * 1000),
                    ),
                    expected,
                );
            });

        test('a presentation time is rounded to its millisecond as a whole', async () => {
            // Not the decode time and the offset apart.
            const reordered = transportStream(
                [{ pid: 0x100, streamType: 0x1b }],
                [
                    {
                        pid: 0x100,
                        streamId: 0xe0,
                        payload: annexB(aud, sps, pps, idr),
                        pts: 90000,
                        dts: 90000,
                    },
                    {
                        pid: 0x100,
                        streamId: 0xe0,
                        payload: annexB(aud, predicted),
                        pts: 105000,
                        dts: 97500,
                    },
                ],
            );
            const packets = await allPackets(await copied(reordered, 'flv'));
            assert.equal(Math.round((packets[1].timestamp - packets[0].timestamp) * 1000), 167);
        });
    });

    describe('codecs of its tags', () => {
        test('reads G.711 A-law audio tags at 8 kHz mono', async () => {
            const alaw = tagFile(
                { audio: true },
                tag(8, concat([0x70], new Uint8Array(160)), 0),
                tag(8, concat([0x70], new Uint8Array(160)), 20),
            );
            const { track, packets } = (await readMedia(alaw)).tracks[0];
            assert.deepEqual(
                [track.codec, track.sampleRate, track.channelCount],
                ['alaw', 8000, 1],
            );
            assert.deepEqual(
                packets.map(packet => packet.duration),
                [0.02, 0.02],
            );
        });

        test('reads Enhanced RTMP VP9 with its vpcC and the onMetaData size', async () => {
            const vpcC = Uint8Array.of(1, 0, 0, 0, 0, 10, 0x80, 1, 1, 1, 0, 0);
            const metadata = concat(
                [2, 0, 10],
                Buffer.from('onMetaData'),
                [8, 0, 0, 0, 2],
                [0, 5],
                Buffer.from('width'),
                [0, 0x40, 0x60, 0, 0, 0, 0, 0, 0],
                [0, 6],
                Buffer.from('height'),
                [0, 0x40, 0x50, 0, 0, 0, 0, 0, 0],
                [0, 0, 9],
            );
            const vp9 = tagFile(
                { video: true },
                tag(18, metadata, 0),
                tag(9, concat([0x90], Buffer.from('vp09'), vpcC), 0),
                tag(9, concat([0x93], Buffer.from('vp09'), [0x82, 0x49, 0x83]), 0),
                tag(9, concat([0xa3], Buffer.from('vp09'), [0x86, 0, 0]), 40),
            );
            const { track, packets } = (await readMedia(vp9)).tracks[0];
            assert.deepEqual([track.codec, track.width, track.height], ['vp09.00.10.08', 128, 64]);
            assert.deepEqual(
                packets.map(packet => packet.isKeyframe),
                [true, false],
            );
        });

        // VP6 (codec id 4) is not read.
        const vp6 = () => tag(9, Uint8Array.of(0x14, 0, 0, 0, 0), 0);

        test('a track of a codec not read is reported and the others read', async () => {
            const aac = [
                tag(8, Uint8Array.of(0xaf, 0, 0x11, 0x90), 0),
                tag(8, Uint8Array.of(0xaf, 1, 0x21, 0), 0),
            ];
            const { tracks, warnings } = await readMedia(
                tagFile({ audio: true, video: true }, vp6(), ...aac),
            );
            assert.deepEqual(
                tracks.map(({ track }) => [track.codec, track.sampleRate, track.channelCount]),
                [['mp4a.40.2', 48000, 2]],
            );
            assert.deepEqual(warnings, ['FLV_UNSUPPORTED_CODEC']);
        });

        test('a file of only codecs not read fails with DEMUX, naming them', async () => {
            await assert.rejects(open(tagFile({ video: true }, vp6())), {
                code: 'DEMUX',
                message: /unsupported codecs: video codec id 4/,
            });
        });
    });
});
