import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Mp4Muxer, TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { differentialFixtures } from '../helpers/differential-fixtures.mjs';
import { md5, nalBodies } from '../helpers/new-format-fixtures.mjs';
import { FIXTURES, assertSamePackets } from '../helpers/recorded-fixtures.mjs';
import { allPackets, bytesOf, copied, readMedia } from '../helpers/read-media.mjs';
import { check, convert, inspect, open, packageMedia } from 'mediaforgejs';
import { flvFile, flvTags } from '../helpers/flv-tags.mjs';
import { aviH264 } from '../helpers/avi-h264-fixtures.mjs';
import { opusPacket, vp9Interframe, vp9Keyframe, webmClip } from '../helpers/webm-clip-fixture.mjs';
import { testSignal, waveFile, waveSamples } from '../helpers/pcm.mjs';
import { CmafWriter } from 'mediaforgejs/streaming';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { concat, flvFixture, mpegAudioFixture, oggFixture } from '../helpers/original-fixtures.mjs';
import { classicMp4, patchTable } from '../helpers/mp4-fixture.mjs';
import { dtsCore } from '../helpers/sync-audio-fixtures.mjs';

const hex = text => Uint8Array.from(Buffer.from(text, 'hex'));

/** The four-letter box types `bytes` hold anywhere. */
function boxNames(bytes) {
    const names = new Set();
    for (let offset = 0; offset + 8 <= bytes.length; offset++) {
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (/^[a-zA-Z0-9 ]{4}$/.test(type)) names.add(type);
    }
    return names;
}

/** The bytes a muxer wrote into `sink`. */
const written = async sink => new Uint8Array(await sink.toBlob().arrayBuffer());

/** A recorded fixture and the containers that carry its codecs. */
const TARGETS = {
    'wmv2.wmv': ['mkv', 'avi'],
    'wma2.wma': ['mkv'],
    'h264mp3.asf': ['mkv', 'mp4', 'ts'],
    'h264.mxf': ['mp4', 'mkv', 'ts', 'mov'],
    'mpeg2.mxf': ['mkv'],
    'pcm24.mxf': ['mkv', 'wav'],
    'av1.ivf': ['mp4', 'mkv', 'webm', 'ts', 'ivf'],
    'av1.obu': ['ivf', 'mp4'],
    'av1.mp4': ['ivf', 'mkv'],
    'av1.webm': ['ivf'],
    'hevc.flv': ['mp4', 'mkv', 'ts'],
    'hevc.mp4': ['flv', 'avi', 'ts', 'mkv'],
    'hevc.ts': ['mp4', 'flv'],
    'hevc.avi': ['mp4', 'mkv'],
    'theora.ogv': ['mkv'],
    'twoopus.ogg': ['mkv', 'mp4'],
};

// A VVC stream (hand-built VPS, SPS and PPS: Main 10, level 3.1, 32x24) of IDR and trailing
// pictures; the record and the codec string are those the parameter sets give.
const VVC = {
    record: hex(
        'ff00115f0102338000002000180000038e00010004007110048f0001000c0079000b0233800001086470' +
            '900001000400810020',
    ),
    codec: 'vvc1.1.L51.CQA.O0+1',
    idr: hex('0039af133742'),
    trail: hex('0009215c0d'),
};

/** NAL units `units` each after a four-byte length. */
const lengthPrefixed = (...units) =>
    Buffer.concat(
        units.map(unit =>
            Buffer.concat([Buffer.of(0, 0, unit.length >> 8, unit.length & 255), unit]),
        ),
    );

/** VVC in MPEG-TS: IDR, two trailing pictures and an IDR at 25 frames a second. */
async function vvcTransportStream() {
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
                codec: VVC.codec,
                codecConfig: VVC.record,
                width: 32,
                height: 24,
                framerate: 25,
            },
        },
        sink,
    );
    [VVC.idr, VVC.trail, VVC.trail, VVC.idr].forEach((unit, index) =>
        muxer.addVideoChunk({
            trackType: 'video',
            data: new Uint8Array(lengthPrefixed(unit)),
            timestamp: index * 0.04,
            duration: 0.04,
            isKeyframe: unit === VVC.idr,
        }),
    );
    await muxer.finalize();
    return written(sink);
}

/** Asserts that `read` holds the VVC pictures of vvcTransportStream() as `sampleEntry`. */
function assertVvc(read, sampleEntry) {
    const { track, packets } = read.tracks[0];
    assert.equal(track.codec, VVC.codec.replace('vvc1', sampleEntry));
    assert.deepEqual([track.width, track.height], [32, 24]);
    assert.deepEqual(
        packets.map(packet => packet.isKeyframe),
        [true, false, false, true],
    );
    const slices = data =>
        md5(
            Buffer.concat(
                nalBodies(data, 'vvc').filter(unit => ![14, 15, 16, 20].includes(unit[1] >> 3)),
            ),
        );
    assert.deepEqual(
        packets.map(packet => slices(packet.data)),
        [VVC.idr, VVC.trail, VVC.trail, VVC.idr].map(unit => slices(lengthPrefixed(unit))),
    );
}

/** First audio minus first video presentation time, of packets in decode order. */
function audioLead(packets) {
    const first = type => packets.find(packet => packet.trackType === type).timestamp;
    return first('audio') - first('video');
}

describe('copy between containers', () => {
    for (const [file, targets] of Object.entries(TARGETS))
        test(`copies ${file} into ${targets.join(', ')} with the same packets`, async () => {
            const source = await readMedia(FIXTURES[file].bytes());
            for (const to of targets) {
                const copy = await readMedia(await copied(FIXTURES[file].bytes(), to));
                assert.equal(copy.format, to, `${to} format`);
                assertSamePackets(source, copy, { decodeOrder: to === 'avi' });
            }
        });

    test('VVC keeps its codec, record and keyframes from MPEG-TS to MP4 to Matroska', async () => {
        // MPEG-TS carries parameter sets in band (vvi1), which the MP4 copy keeps; Matroska has no
        // such distinction (vvc1).
        const ts = await vvcTransportStream();
        assertVvc(await readMedia(ts), 'vvi1');
        const mp4 = await copied(ts, 'mp4');
        const fromMp4 = await readMedia(mp4);
        assertVvc(fromMp4, 'vvi1');
        assert.deepEqual(fromMp4.tracks[0].track.codecConfig, VVC.record);
        const fromMkv = await readMedia(await copied(mp4, 'mkv'));
        assertVvc(fromMkv, 'vvc1');
        assert.deepEqual(fromMkv.tracks[0].track.codecConfig, VVC.record);
    });

    test('a Dolby Vision record next to HEVC survives MP4 to Matroska to MP4', async () => {
        // Profile 5, level 6, RPU and base layer present, no enhancement layer, compatibility id 0.
        const record = Uint8Array.of(1, 0, 5 << 1, (6 << 3) | 0x05, 0, ...new Array(19).fill(0));
        const { tracks } = await readMedia(FIXTURES['hevc.mp4'].bytes());
        const [{ track, packets }] = tracks;
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'mp4',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: track.codec,
                    codecConfig: track.codecConfig,
                    dolbyVisionConfig: record,
                    width: track.width,
                    height: track.height,
                    framerate: 10,
                },
            },
            sink,
        );
        for (const packet of packets)
            muxer.addVideoChunk({
                trackType: 'video',
                data: packet.data,
                timestamp: packet.timestamp,
                decodeTimestamp: packet.decodeTimestamp,
                duration: packet.duration,
                isKeyframe: packet.isKeyframe,
            });
        await muxer.finalize();
        // MP4 stores the record as a dvcC box after hvcC, Matroska as the BlockAddIDExtraData of a
        // 'dvcC' mapping.
        const assertHolds = async bytes => {
            const read = await readMedia(bytes);
            assert.equal(read.tracks[0].track.codec, 'dvh1.05.06');
            assert.equal(read.tracks[0].packets.length, packets.length);
            const box = Buffer.concat([Buffer.from('dvcC'), record]);
            const mapping = Buffer.concat([Uint8Array.of(0x41, 0xed, 0x98), record]);
            assert.ok(Buffer.from(bytes).includes(box) || Buffer.from(bytes).includes(mapping));
        };
        const mp4 = await written(sink);
        assert.ok(Buffer.from(mp4).includes('dvh1'), 'a dvh1 sample entry');
        await assertHolds(mp4);
        const mkv = await copied(mp4, 'mkv');
        await assertHolds(mkv);
        await assertHolds(await copied(mkv, 'mp4'));
    });

    for (const [name, targets] of [
        ['mp4-aac-primed.mp4', ['mkv', 'fmp4']],
        ['webm-vp9-opus.webm', ['fmp4', 'mkv']],
    ])
        test(`copies of ${name} keep its audio aligned with its video`, async () => {
            // Matroska moves every track past the primed AAC packet an MP4 edit list presents
            // before zero, and fragmented MP4 times Opus by the pre-skip its edit list removes
            // again.
            const input = differentialFixtures[name]();
            const lead = audioLead(await allPackets(input));
            for (const to of targets) {
                const copyLead = audioLead(await allPackets(await copied(input, to)));
                assert.ok(Math.abs(copyLead - lead) <= 0.0011, `${to}: ${copyLead} vs ${lead}`);
            }
        });

    test('Motion JPEG copies as it is, labelled as each container labels it', async () => {
        // V_MJPEG in Matroska, MJPG in AVI, 'jpeg' in MOV and an 'mp4v' entry naming JPEG (object
        // type 0x6C) in MP4.
        const input = differentialFixtures['avi-mjpeg.avi']();
        const pictures = (await allPackets(input)).map(packet => packet.data);
        for (const [to, label] of [
            ['mkv', 'V_MJPEG'],
            ['avi', 'MJPG'],
            ['mov', 'jpeg'],
            ['mp4', 'mp4v'],
        ]) {
            const bytes = await copied(input, to);
            assert.ok(Buffer.from(bytes).includes(label), `${to} labels the track ${label}`);
            const { tracks } = await readMedia(bytes);
            assert.deepEqual(
                tracks.map(({ track }) => track.codec),
                ['mjpeg'],
            );
            assert.deepEqual(
                tracks[0].packets.map(packet => packet.data),
                pictures,
                to,
            );
        }
    });

    test('sound that starts before the pictures keeps its lead re-encoded in AVI', async () => {
        // AVI has no edit list: the pictures move later instead of the sound being cut to their
        // start.
        const audio = flvTags(differentialFixtures['flv-title.flv']()).tags.filter(
            tag => tag.type === 8,
        );
        const video = flvTags(differentialFixtures['flv-bframes.flv']());
        const tags = [
            ...audio,
            ...video.tags
                .filter(tag => tag.type === 9)
                .map(tag => ({ ...tag, timestamp: tag.timestamp + 40 })),
        ].sort((a, b) => a.timestamp - b.timestamp);
        const head = video.head.slice();
        head[4] = 5;
        const input = flvFile(head, tags).bytes;
        const source = await readMedia(input);
        const sourceAudio = source.tracks.find(({ track }) => track.type === 'audio').track;
        const result = await convert(input, { to: 'avi', onWarning: () => {} });
        assert.deepEqual(
            result.plan.tracks.map(track => `${track.type}:${track.action}`),
            ['video:copy', 'audio:encode'],
        );
        const avi = await readMedia(result.blob);
        const pcm = avi.tracks.find(({ track }) => track.type === 'audio').track;
        assert.ok(
            Math.abs(pcm.duration - sourceAudio.duration) < 1e-3,
            `${pcm.duration} s of ${sourceAudio.duration} s`,
        );
    });

    describe('AAC configurations ADTS can and cannot carry', () => {
        // ADTS (raw .aac and MPEG-TS) carries the AAC core: SBR stays implicit at the core rate,
        // while program-config layouts and 960-sample frames, which ADTS cannot signal, are
        // refused. 3gp-esds.3gp with its AudioSpecificConfig replaced by `asc`.
        const withConfig = asc => {
            const base = differentialFixtures['3gp-esds.3gp']();
            const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const boxAt = (bytes, type) => Buffer.from(bytes).indexOf(type) - 4;
            const descriptor = (bytes, at) => {
                let length = 0;
                let size = 0;
                do length = (length << 7) | (bytes[at + 1 + size] & 0x7f);
                while (bytes[at + 1 + size++] & 0x80);
                return { length, lengthAt: at + size, body: at + 1 + size };
            };
            const es = descriptor(base, boxAt(base, 'esds') + 12);
            const config = descriptor(base, es.body + 3);
            const specific = descriptor(base, config.body + 13);
            const bytes = new Uint8Array(
                Buffer.concat([
                    base.subarray(0, specific.body),
                    Buffer.from(asc),
                    base.subarray(specific.body + specific.length),
                ]),
            );
            const grown = asc.length - specific.length;
            for (const at of [es.lengthAt, config.lengthAt, specific.lengthAt]) bytes[at] += grown;
            for (const type of ['esds', 'mp4a', 'stsd', 'stbl', 'minf', 'mdia', 'trak', 'moov']) {
                const box = boxAt(bytes, type);
                view(bytes).setUint32(box, view(bytes).getUint32(box) + grown);
            }
            return bytes;
        };

        test('explicit SBR copies into MPEG-TS as AAC-LC at the core rate', async () => {
            // AAC-LC at 44.1 kHz mono is 0x12 0x08; explicit SBR at a 22.05 kHz core is
            // 0x2b 0x8a 0x08 0x00.
            const ts = await copied(withConfig([0x2b, 0x8a, 0x08, 0x00]), 'ts');
            const adts = ts.findIndex(
                (byte, index) => byte === 0xff && (ts[index + 1] & 0xf6) === 0xf0,
            );
            assert.equal(ts[adts + 2] >> 6, 1, 'ADTS profile AAC-LC');
            assert.equal((ts[adts + 2] >> 2) & 15, 7, 'ADTS rate index of 22.05 kHz');
        });

        for (const [label, asc] of [
            ['a program config element', [0x12, 0x00]],
            ['960-sample frames', [0x12, 0x0c]],
        ]) {
            test(`AAC of ${label} cannot be copied into MPEG-TS`, async () => {
                const support = await check(withConfig(asc), 'ts', { copy: true });
                assert.equal(support.supported, false);
                assert.match(support.reason, /ADTS/);
            });

            test(`AAC of ${label} is not copied into raw AAC`, async () => {
                const support = await check(withConfig(asc), 'aac');
                assert.ok(!support.supported || support.plan.tracks[0].action === 'encode');
            });
        }

        test('MPEG-4 ALS shares the mp4a entry but copies into the MP4 family only', async () => {
            const als = withConfig([0xf8, 0x88, 0x20]);
            const { tracks } = await readMedia(als);
            assert.equal(tracks[0].track.codec, 'mp4a.40.36');
            assert.equal((await check(als, 'mp4', { copy: true })).supported, true);
            for (const to of ['mkv', 'flv', 'ts'])
                assert.equal((await check(als, to, { copy: true })).supported, false, to);
        });
    });

    test('DV video copies as it is into AVI and Matroska', async () => {
        const frames = [0, 1, 2].map(index => new Uint8Array(480).fill(0x1f + index));
        const avi = aviH264({
            extra: new Uint8Array(0),
            packets: frames,
            fourcc: 'dvsd',
            width: 720,
            height: 576,
        });
        for (const to of ['avi', 'mkv']) {
            const { tracks } = await readMedia(await copied(avi, to));
            assert.equal(tracks[0].track.codec, 'dvvideo', to);
            assert.deepEqual(
                tracks[0].packets.map(packet => packet.data),
                frames,
                to,
            );
        }
    });

    describe('WebM as browsers write it', () => {
        const OPUS_HEAD = Uint8Array.of(...new TextEncoder().encode('OpusHead'), 1, 2);

        test('VP9 and Opus copy into plain MP4, MOV and M4V with vpcC and dOps', async () => {
            const clip = webmClip({ frames: 30 });
            const expected = (await allPackets(clip)).map(packet => [packet.trackId, packet.data]);
            for (const format of ['mp4', 'mov', 'm4v']) {
                const result = await convert(clip, format);
                assert.ok(!result.warnings.some(w => w.code === 'TARGET_REENCODED'), format);
                const bytes = await bytesOf(result);
                const boxes = boxNames(bytes);
                for (const name of ['vp09', 'vpcC', 'Opus', 'dOps', 'stsz'])
                    assert.ok(boxes.has(name), `${format} holds ${name}`);
                assert.ok(!boxes.has('moof'), `${format} is not fragmented`);
                const { tracks } = await readMedia(bytes);
                assert.deepEqual(
                    tracks.map(({ track }) => [track.codec, track.sampleRate]),
                    [
                        ['vp09.00.10.08', undefined],
                        ['opus', 48000],
                    ],
                );
                assert.equal(tracks[0].track.codecConfig[0], 1, 'vpcC version 1');
                // dOps: version 0, two channels, the 312-sample pre-skip, big-endian.
                assert.deepEqual([...tracks[1].track.codecConfig.subarray(0, 4)], [0, 2, 1, 0x38]);
                assert.deepEqual(
                    (await allPackets(bytes)).map(packet => [packet.trackId, packet.data]),
                    expected,
                );
            }
        });

        test('Opus timed in whole milliseconds copies into MP4 with its pre-skip', async () => {
            // As FFmpeg's fate/opus/tron.6ch.tinypkts.mka: 2.5 ms frames from 2.5 ms on, stored
            // at whole milliseconds, and a pre-skip of 120 samples. The times span 0.5 ms less
            // than the 200 frames code, so a window over every coded sample does not fit the track
            // MP4 times from them: the copy failed with MUX after check() accepted it.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    audio: {
                        codec: 'opus',
                        codecConfig: Uint8Array.of(...OPUS_HEAD, 120, 0, 0x80, 0xbb, 0, 0, 0, 0, 0),
                        sampleRate: 48000,
                        channelCount: 2,
                    },
                },
                sink,
            );
            for (let index = 0; index < 200; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(0xe4, index & 255, 1, 2),
                    timestamp: (index + 1) * 0.0025,
                    duration: 0.0025,
                    isKeyframe: true,
                });
            await muxer.finalize();
            const mka = sink.toUint8Array();
            for (const format of ['mp4', 'm4a', 'mov']) {
                assert.equal((await check(mka, format)).supported, true, format);
                const copy = await bytesOf(await convert(mka, format));
                // The window ends where the copied times do (stored from 2 to 499 ms, the last
                // lasting 2.5 ms: 0.4995 s) less the pre-skip, 0.5 ms short of the 0.4975 s coded.
                const media = await open(copy);
                media.close();
                assert.ok(
                    Math.abs(media.duration - 0.497) < 0.0002,
                    `${format}: ${media.duration}`,
                );
                assert.equal((await allPackets(copy)).length, 200, format);
            }
        });

        test('AAC timed in whole milliseconds copies into MP4, every sample kept', async () => {
            // 109 frames of 1,024 samples at 22.05 kHz from -46.4 ms on, stored at whole
            // milliseconds as FFmpeg muxes them: the times span 0.5 ms less than the frames code.
            // The MP4 writer stretches an AAC track that close to its coded samples.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    audio: {
                        codec: 'mp4a.40.2',
                        codecConfig: Uint8Array.of(0x13, 0x90),
                        sampleRate: 22050,
                        channelCount: 2,
                    },
                },
                sink,
            );
            for (let index = 0; index < 109; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(0x21, index & 255, 1, 2),
                    timestamp: ((index - 1) * 1024) / 22050,
                    duration: 1024 / 22050,
                    isKeyframe: true,
                });
            await muxer.finalize();
            const mka = sink.toUint8Array();
            // Every coded sample after the 46 ms lead read from the first packet (1,014 samples).
            const presented = (109 * 1024 - 1014) / 22050;
            for (const format of ['mp4', 'm4a', 'mov']) {
                const media = await open(await bytesOf(await convert(mka, format)));
                media.close();
                assert.ok(Math.abs(media.duration - presented) < 0.0001, `${format}`);
            }
        });

        test('a copy that leaves a track out reads a large input whole', async () => {
            // VP9, Opus and a second sound in AAC into WebM: the conversion copies the pictures
            // and the Opus and leaves the AAC out, encoding nothing. On a large input it took the
            // plan's copy for a copy of the file, streamed the probe and failed with "A probed
            // input has no packet index".
            const inputOf = async (pictures, pictureBytes) => {
                const sink = new MemorySink();
                const muxer = new WebMMuxer(
                    {
                        format: 'mkv',
                        mode: 'standard',
                        video: { codec: 'vp09.00.10.08', width: 16, height: 16, framerate: 30 },
                        audio: {
                            codec: 'opus',
                            codecConfig: Uint8Array.of(
                                ...OPUS_HEAD,
                                0,
                                0,
                                0x80,
                                0xbb,
                                0,
                                0,
                                0,
                                0,
                                0,
                            ),
                            sampleRate: 48000,
                            channelCount: 2,
                        },
                        extraAudioTracks: [
                            {
                                codec: 'mp4a.40.2',
                                codecConfig: Uint8Array.of(0x11, 0x90),
                                sampleRate: 48000,
                                channelCount: 2,
                            },
                        ],
                    },
                    sink,
                );
                const padded = frame => Uint8Array.of(...frame, ...new Uint8Array(pictureBytes));
                const [key, inter] = [padded(vp9Keyframe), padded(vp9Interframe)];
                for (let index = 0; index < pictures; index++) {
                    const timestamp = index / 30;
                    const sound = {
                        trackType: 'audio',
                        timestamp,
                        duration: 1 / 30,
                        isKeyframe: true,
                    };
                    muxer.addAudioChunk({ ...sound, data: opusPacket });
                    muxer.addExtraAudioChunk(0, {
                        ...sound,
                        data: Uint8Array.of(0x21, index & 255, 1, 2),
                    });
                    muxer.addVideoChunk({
                        trackType: 'video',
                        data: index % 30 ? inter : key,
                        timestamp,
                        duration: 1 / 30,
                        isKeyframe: index % 30 === 0,
                    });
                }
                await muxer.finalize();
                return sink.toUint8Array();
            };
            for (const [pictures, pictureBytes] of [
                [30, 16],
                [900, 8 * 1024],
            ]) {
                const result = await convert(await inputOf(pictures, pictureBytes), 'webm');
                assert.deepEqual(
                    result.plan.tracks.map(track => [track.codec, track.action]),
                    [
                        ['vp09.00.10.08', 'copy'],
                        ['opus', 'copy'],
                    ],
                );
                assert.deepEqual(
                    result.warnings.map(warning => warning.code),
                    ['TARGET_TRACKS_DROPPED'],
                );
                const packets = await allPackets(await bytesOf(result));
                assert.equal(packets.filter(packet => packet.trackId === 1).length, pictures);
            }
        });
    });

    test('FLAC frames copied into Matroska and fragmented MP4 decode as their source', async () => {
        const wave = waveFile(testSignal(4096 * 2 + 77, 2), 48000, 2);
        const flac = await bytesOf(await convert(wave, 'flac'));
        const restored = await waveSamples((await convert(flac, 'wav')).blob);
        const mkv = await copied(flac, 'mkv');
        const { files } = await packageMedia(flac, 'hls', { container: 'fmp4' });
        const fragmented = new Uint8Array(
            Buffer.concat(
                [...files.values()].filter(file => file.kind !== 'playlist').map(file => file.data),
            ),
        );
        for (const [copy, format] of [
            [mkv, 'mkv'],
            [fragmented, 'mp4'],
        ]) {
            const { format: read, tracks } = await readMedia(copy);
            assert.deepEqual([read, tracks[0].track.codec], [format, 'flac']);
            assert.deepEqual(
                await waveSamples((await convert(copy, 'wav')).blob),
                restored,
                format,
            );
        }
    });

    describe('what each target takes', () => {
        /** One Opus packet in fragmented MP4, as CmafWriter writes it. */
        function fragmentedOpus() {
            const writer = new CmafWriter({
                tracks: [
                    {
                        id: 1,
                        type: 'audio',
                        codec: 'opus',
                        timescale: 48000,
                        sampleRate: 48000,
                        channelCount: 1,
                        codecConfig: Uint8Array.of(0, 1, 0, 0, 0, 0, 187, 128, 0, 0, 0),
                    },
                ],
            });
            const init = writer.createInitSegment();
            writer.addSample({
                trackId: 1,
                data: Uint8Array.of(248, 255, 254),
                decodeTimestamp: 0,
                duration: 960,
                isKeyframe: true,
            });
            return new Blob([init, writer.flush().data]);
        }
        const adts = async () =>
            wrapAdts(
                await encodeAacLc([new Float32Array(2048)], { sampleRate: 48000, bitrate: 64 }),
            );
        const supported = async (input, to) => (await check(input, { to, copy: true })).supported;

        test('Opus copies into the MP4 family, not into AVI or FLV', async () => {
            // Into standard MP4 ('Opus' with dOps) as into fragmented MP4.
            for (const to of ['mp4', 'm4a', 'mov', 'fmp4'])
                assert.equal(await supported(fragmentedOpus(), to), true, to);
            for (const to of ['avi', 'flv'])
                assert.equal(await supported(fragmentedOpus(), to), false, to);
            for (const to of ['mp4', 'fmp4']) {
                const [packet] = await allPackets(await copied(fragmentedOpus(), to));
                assert.deepEqual(packet.data, Uint8Array.of(248, 255, 254), to);
            }
        });

        test('a copy AVI refuses writes nothing to the sink', async () => {
            const sink = new MemorySink();
            await assert.rejects(
                convert(await adts(), { to: 'avi', copy: true, sink }),
                error =>
                    error.code === 'FORMAT' && /avi cannot mux audio codec/.test(error.message),
            );
            assert.equal(sink.size, 0);
        });

        test('a fragmented MP4 copy reports progress for every packet', async () => {
            const input = await adts();
            let packets = 0;
            await convert(input, {
                to: 'fmp4',
                copy: true,
                onProgress: progress => (packets = progress.packets),
            });
            const { tracks } = await inspect(input, { sampleCounts: true });
            assert.equal(packets, tracks[0].sampleCount);
        });

        test('MP3 copies into fragmented MP4', async () => {
            assert.equal(await supported(mpegAudioFixture(3), 'fmp4'), true);
        });

        test('AAC in FLV milliseconds copies into fragmented MP4, every frame kept', async () => {
            // 1024-sample frames at 48 kHz land 1/3 ms early without overlapping.
            const { tracks } = await inspect(await copied(flvFixture(), 'fmp4'), {
                sampleCounts: true,
            });
            assert.equal(tracks[0].sampleCount, 4);
        });

        test('the Opus pre-skip of MP4 dOps becomes the Matroska CodecDelay', async () => {
            const mp4 = await copied(oggFixture({ trimmed: true }), 'mp4');
            const mkv = await readMedia(await copied(mp4, 'mkv'));
            assert.equal(mkv.tracks[0].track.codec, 'opus');
            assert.deepEqual(
                mkv.tracks[0].packets.map(packet => [...packet.data]),
                [
                    [0x80, 0x31, 0x01],
                    [0x80, 0x32, 0x02],
                    [0x80, 0x33, 0x03],
                ],
            );
        });

        test('PCM above 65535 Hz is unsupported in fragments but kept in plain MP4', async () => {
            // Fragmented MP4 sample entries hold rates below 64 kHz: a copy outside them is an
            // unsupported combination (FORMAT), not a failed write (MUX). 192 kHz stereo 16-bit.
            const wave = new Uint8Array(44 + 400);
            const view = new DataView(wave.buffer);
            wave.set(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '));
            view.setUint32(4, 36 + 400, true);
            [16, 0x10001, 192000, 384000, 0x100002].forEach((value, index) =>
                view.setUint32(16 + index * 4, value, true),
            );
            wave.set(new TextEncoder().encode('data'), 36);
            view.setUint32(40, 400, true);
            const fragmented = await check(new Blob([wave]), { to: 'fmp4', copy: true });
            assert.deepEqual([fragmented.supported, fragmented.code], [false, 'FORMAT']);
            assert.equal(await supported(new Blob([wave]), 'mp4'), true);
            assert.equal((await check(new Blob([wave]), 'mp4')).supported, true);
        });

        test('a track whose samples all lie past the end of the file is unsupported', async () => {
            // Nothing to copy or convert: FORMAT, not a start past the end of the request (INPUT).
            const empty = new Blob([patchTable(classicMp4({ count: 2 }).bytes, 'stco', 16, 1e6)]);
            for (const range of [{}, { start: 0.01 }])
                await assert.rejects(convert(empty, { to: 'mp4', ...range }), error => {
                    assert.equal(error.code, 'FORMAT', error.message);
                    assert.ok(!error.message.includes('Infinity'), error.message);
                    return true;
                });
        });
    });

    describe('DTS', () => {
        // Raw DTS: three core frames.
        const frames = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
        const raw = () => concat(...frames);

        for (const format of ['mkv', 'mp4', 'mov', 'ts'])
            test(`copies into ${format}, keeping each access unit`, async () => {
                const output = await copied(raw(), format);
                const { tracks } = await readMedia(output);
                assert.deepEqual(
                    tracks.map(({ track }) => [track.codec, track.sampleRate, track.channelCount]),
                    [['dtsc', 48000, 2]],
                );
                assert.deepEqual(
                    tracks[0].packets.map(packet => packet.data),
                    frames,
                );
                if (format === 'mp4' || format === 'mov') {
                    // A dtsc sample entry with its DTSSpecificBox.
                    const bytes = Buffer.from(output);
                    const movie = bytes.subarray(bytes.indexOf('moov'));
                    assert.ok(movie.includes('dtsc') && movie.includes('ddts'));
                }
            });

        test('does not copy into WebM', async () => {
            await assert.rejects(convert(raw(), { to: 'webm', copy: true }), { code: 'FORMAT' });
        });

        test('decoding it needs a host decoder', async () => {
            await assert.rejects(convert(new Blob([raw()]), 'wav'), {
                code: 'DECODE',
                message: /No audio decoder for 'dtsc'/,
            });
        });
    });
});
