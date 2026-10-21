import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect } from 'mediaforgejs';
import { encodeMp3 } from 'mediaforgejs/codecs';
import { Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { createMuxer } from 'mediaforgejs/parts';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { FIXTURES } from '../helpers/new-format-fixtures.mjs';
import { SPATIAL, holdsSpatialBoxes, spatialMp4 } from '../helpers/spatial-video.mjs';
import { ac3Frame, transportStream } from '../helpers/mpeg-video-fixtures.mjs';
import { bytesOf, copied, readAll, readMedia } from '../helpers/read-media.mjs';
import { CmafWriter } from 'mediaforgejs/streaming';
import { concat, mpegAudioFixture } from '../helpers/original-fixtures.mjs';
import { truehdUnit } from '../helpers/sync-audio-fixtures.mjs';
import { structuralStreams } from '../helpers/spec-streams.mjs';

// Writing MP4 and QuickTime movies: the sample entries copies and encodes get, languages, the
// decode clock of what the writer is given, and the boxes kept for codecs the library does not
// decode.

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** The offset of the first box of `type` in `bytes`. */
const boxAt = (bytes, type) => Buffer.from(bytes).indexOf(type) - 4;
const STANDARD = { format: 'mp4', mode: 'standard', maxFragmentDuration: 2 };

/** A WAVE file of `frames` frames of `channels` channels, its data a fixed pattern. */
function wave(tag, rate, channels, bits, frames) {
    const block = (channels * bits) / 8;
    const bytes = Buffer.alloc(44 + frames * block);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(36 + frames * block, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(tag, 20);
    bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(rate, 24);
    bytes.writeUInt32LE(rate * block, 28);
    bytes.writeUInt16LE(block, 32);
    bytes.writeUInt16LE(bits, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(frames * block, 40);
    for (let at = 44; at < bytes.length; at++) bytes[at] = (at * 37 + (at >> 3)) & 0x7f;
    return new Uint8Array(bytes);
}

/** The samples of the data chunk of a 16-bit WAVE file. */
function waveSamples(bytes) {
    const view = viewOf(bytes);
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const size = view.getUint32(offset + 4, true);
        if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'data')
            return new Int16Array(bytes.slice(offset + 8, offset + 8 + size).buffer);
        offset += 8 + size + (size & 1);
    }
    throw new Error('the WAVE file has no data chunk');
}

/** The stored bytes of every packet of a read. */
const stored = result => Buffer.concat(result.packets.map(packet => packet.data));

describe('mp4: writing', () => {
    describe('PCM sample entries', () => {
        // QuickTime's entries in MOV and those of ISO/IEC 23003-5 in MP4, one sample per frame as
        // ffmpeg writes them; rates above 65535 Hz take a version-2 'lpcm' entry or the media
        // timescale.
        for (const [tag, bits, rate, mov, mp4] of [
            [1, 16, 48000, 'sowt', 'ipcm'],
            [1, 24, 48000, 'in24', 'ipcm'],
            [3, 32, 44100, 'fl32', 'fpcm'],
            [3, 64, 48000, 'fl64', 'fpcm'],
            [1, 24, 96000, 'lpcm', 'ipcm'],
        ])
            test(`${bits}-bit PCM at ${rate} Hz copies as '${mov}' and '${mp4}'`, async () => {
                const source = wave(tag, rate, 2, bits, 1000);
                const original = await readAll(source);
                for (const [to, entry] of [
                    ['mov', mov],
                    ['mp4', mp4],
                ]) {
                    const bytes = Buffer.from(await copied(source, to));
                    assert.ok(bytes.includes(entry), `${to} entry`);
                    assert.ok(!bytes.includes('moof'), `${to} stays a plain movie`);
                    const copy = await readAll(new Uint8Array(bytes));
                    const { sampleRate, channelCount } = copy.tracks[0];
                    assert.deepEqual([sampleRate, channelCount], [rate, 2]);
                    assert.deepEqual(stored(copy), stored(original), `${to} keeps the samples`);
                }
            });

        test("8-bit PCM copies into MOV as 'raw ' and not into MP4", async () => {
            const source = wave(1, 8000, 2, 8, 1000);
            const bytes = Buffer.from(await copied(source, 'mov'));
            assert.ok(bytes.includes('raw '));
            assert.deepEqual(
                stored(await readAll(new Uint8Array(bytes))),
                stored(await readAll(source)),
            );
            await assert.rejects(
                convert(source, { to: 'mp4', copy: true }),
                error =>
                    error.code === 'FORMAT' &&
                    /mp4 cannot mux audio codec 'pcm-u8'/.test(error.message),
            );
        });

        for (const [to, entry] of [
            ['mov', 'sowt'],
            ['mp4', 'ipcm'],
        ])
            test(`sound encoded as PCM goes into ${to} as 16-bit '${entry}'`, async () => {
                const result = await convert(wave(3, 48000, 2, 32, 1000), {
                    to,
                    audio: { codec: 'pcm', sampleRate: 24000 },
                });
                const bytes = await bytesOf(result);
                assert.ok(Buffer.from(bytes).includes(entry));
                const encoded = await readAll(bytes);
                assert.deepEqual(
                    [encoded.tracks[0].codec, encoded.tracks[0].sampleRate, stored(encoded).length],
                    ['pcm-s16le', 24000, 500 * 4],
                );
            });
    });

    test('a BCP 47 language goes into mdhd as ISO 639-2 and whole into elng', async () => {
        // pt-BR: 'por' in the media header instead of und.
        const { tracks } = await readAll(fixtures['mp4-aac-primed.mp4']());
        const info = tracks.find(track => track.type === 'audio');
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                ...STANDARD,
                autoSync: true,
                audio: {
                    id: 1,
                    type: 'audio',
                    codec: info.codec,
                    sampleRate: info.sampleRate,
                    channelCount: info.channelCount,
                    codecConfig: info.codecConfig,
                    language: 'pt-BR',
                },
            },
            sink,
        );
        muxer.addAudioChunk({
            trackType: 'audio',
            data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]),
            timestamp: 0,
            duration: 0.128,
            isKeyframe: true,
        });
        await muxer.finalize();
        const written = sink.toUint8Array();
        const hex = Buffer.from(written).toString('hex');
        const por = ((16 << 10) | (15 << 5) | 18).toString(16).padStart(4, '0');
        assert.ok(hex.includes('6d646864') && hex.includes(`${por}0000`), 'mdhd language por');
        assert.ok(hex.includes('656c6e670000000070742d425200'), 'elng pt-BR');
        assert.equal((await readAll(written)).tracks[0].language, 'pt-BR');
    });

    describe('the decode clock', () => {
        test('audio with composition offsets is placed by its decode start', async () => {
            // Composition offsets on the first audio packets (MP4Box fragments) only move where
            // the audio starts: the edit starts at media time 0, so readers that apply audio
            // edits on the decode clock keep it where the video is.
            const source = await readAll(fixtures['mp4-aac-primed.mp4']());
            const [video, audio] = ['video', 'audio'].map(type =>
                source.tracks.find(track => track.type === type),
            );
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    ...STANDARD,
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: video.codec,
                        width: video.width,
                        height: video.height,
                        framerate: 25,
                        codecConfig: video.codecConfig,
                    },
                    audio: {
                        id: 2,
                        type: 'audio',
                        codec: audio.codec,
                        sampleRate: audio.sampleRate,
                        channelCount: audio.channelCount,
                        codecConfig: audio.codecConfig,
                    },
                },
                sink,
            );
            const lead = 0.1;
            const audioPackets = source.packets.filter(packet => packet.trackType === 'audio');
            for (const packet of source.packets) {
                const chunk = {
                    ...packet,
                    timestamp: packet.timestamp + lead,
                    decodeTimestamp: (packet.decodeTimestamp ?? packet.timestamp) + lead,
                };
                if (packet.trackType === 'video') muxer.addVideoChunk(chunk, video.codecConfig);
                else {
                    // The first audio packet is stamped at the second's time, as MP4Box does.
                    const offset = audioPackets.indexOf(packet) === 0 ? 0.128 : 0;
                    muxer.addAudioChunk(
                        {
                            ...chunk,
                            timestamp: chunk.timestamp + offset,
                            compositionTimeOffset: undefined,
                        },
                        audio.codecConfig,
                    );
                }
            }
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            const elst = Buffer.from(bytes).lastIndexOf('elst');
            const entries = viewOf(bytes).getUint32(elst + 8);
            assert.equal(viewOf(bytes).getInt32(elst + 12 + 12 * (entries - 1) + 4), 0);
            const copy = await readAll(bytes);
            const first = (result, type) =>
                result.packets.find(packet => packet.trackType === type).timestamp;
            const distance = first(copy, 'audio') - first(copy, 'video');
            const expected = first(source, 'audio') + 0.128 - first(source, 'video');
            assert.ok(Math.abs(distance - expected) < 0.002, 'the audio keeps its distance');
        });

        test('decode times that do not increase are written a tick apart', async () => {
            // A broken stts: the composition offsets follow, so every picture keeps its
            // presentation time.
            const source = await readAll(fixtures['mp4-bframes.mp4']());
            const video = source.tracks[0];
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    ...STANDARD,
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: video.codec,
                        width: video.width,
                        height: video.height,
                        framerate: 10,
                        codecConfig: video.codecConfig,
                    },
                },
                sink,
            );
            const stalled = source.packets.map((packet, index) =>
                index < 4
                    ? {
                          ...packet,
                          decodeTimestamp: source.packets[0].decodeTimestamp,
                          compositionTimeOffset: undefined,
                      }
                    : packet,
            );
            for (const packet of stalled) muxer.addVideoChunk(packet, video.codecConfig);
            await muxer.finalize();
            const copy = await readAll(sink.toUint8Array());
            const shift = copy.packets[0].timestamp - stalled[0].timestamp;
            assert.deepEqual(
                copy.packets.map(packet => Number((packet.timestamp - shift).toFixed(6))),
                stalled.map(packet => Number(packet.timestamp.toFixed(6))),
            );
        });
    });

    describe('audio carried as the input states it', () => {
        // As ffmpeg writes and copies it: an esds of object type 0xD1 without decoder info, which
        // EVRC has none of.
        const evrc = structuralStreams.evrc;

        for (const format of ['mp4', 'mov'])
            test(`EVRC keeps its object type, with no decoder info, in ${format}`, async () => {
                const source = await readAll(evrc());
                const written = await copied(evrc(), format);
                const copy = await readAll(written);
                assert.deepEqual([copy.tracks[0].codec, copy.tracks[0].sampleRate], ['evrc', 8000]);
                assert.equal(copy.tracks[0].codecConfig, undefined);
                // The 13 bytes of the DecoderConfigDescriptor (object type 0xD1, audio) end the
                // descriptor: the SLConfigDescriptor follows, no DecoderSpecificInfo.
                const esds = Buffer.from(written).indexOf('esds');
                const config = Buffer.from(written).indexOf(Uint8Array.of(0xd1, 0x15), esds);
                assert(esds > 0 && config > esds, 'the esds names EVRC');
                assert.equal(written[config + 13], 6, 'the SLConfigDescriptor follows');
                assert.deepEqual(copy.hashes, source.hashes);
            });

        test('MPEG-H 3D audio keeps its configuration and zero channel count', async () => {
            const config = Uint8Array.of(1, 0x12, 0x10, 0, 0xb6);
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format: 'mp4',
                    mode: 'standard',
                    autoSync: false,
                    audio: {
                        id: 1,
                        type: 'audio',
                        codec: 'mhm1',
                        sampleRate: 48000,
                        channelCount: 0,
                        codecConfig: config,
                    },
                },
                sink,
            );
            for (let index = 0; index < 3; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(0xc0, index, 1, 2),
                    timestamp: index * 0.02,
                    duration: 0.02,
                    isKeyframe: true,
                });
            await muxer.finalize();
            const mpegh = sink.toUint8Array();
            const outputs = [mpegh, await copied(mpegh, 'mov'), await copied(mpegh, 'fmp4')];
            for (const output of outputs) {
                const copy = await readAll(output);
                const { codec, sampleRate, channelCount } = copy.tracks[0];
                assert.deepEqual([codec, sampleRate, channelCount], ['mhm1.0x12', 48000, 10]);
                assert.equal(viewOf(output).getUint16(boxAt(output, 'mhm1') + 24), 0);
                assert.deepEqual(copy.tracks[0].codecConfig, config);
                assert.equal(copy.packets.length, 3);
            }
        });

        describe('AC-3 from containers without a dac3 record', () => {
            // MPEG-TS and Matroska: the first syncframe supplies it.
            const DAC3 = Uint8Array.of(0x10, 0x10, 0x00);
            const transport = () =>
                transportStream(
                    [{ pid: 0x101, streamType: 0x81 }],
                    [1, 2, 3].map(fill => ({
                        pid: 0x101,
                        streamId: 0xbd,
                        payload: ac3Frame(fill),
                        pts: 90000 + (fill - 1) * 2880,
                    })),
                );

            test('MPEG-TS and Matroska read it from the first frame', async () => {
                const fromTs = await readMedia(transport());
                assert.deepEqual(fromTs.tracks[0].track.codecConfig, DAC3);
                const fromMkv = await readMedia(await copied(transport(), 'mkv'));
                assert.deepEqual(fromMkv.tracks[0].track.codecConfig, DAC3);
            });

            for (const [from, format] of [
                ['Matroska', 'mp4'],
                ['MPEG-TS', 'fmp4'],
            ])
                test(`a copy from ${from} into ${format} carries it`, async () => {
                    const source =
                        from === 'MPEG-TS' ? transport() : await copied(transport(), 'mkv');
                    const copy = await readMedia(await copied(source, format));
                    assert.equal(copy.tracks[0].track.codec, 'ac-3');
                    assert.deepEqual(copy.tracks[0].track.codecConfig, DAC3);
                    assert.deepEqual(
                        copy.tracks[0].packets.map(packet => packet.data),
                        [1, 2, 3].map(fill => ac3Frame(fill)),
                    );
                });
        });

        test('MP3 copied into MP4 keeps its priming and padding in the edit list', async () => {
            const rate = 44100;
            const frames = rate + 555;
            const planes = [new Float32Array(frames), new Float32Array(frames)];
            for (let index = 0; index < frames; index++)
                for (let channel = 0; channel < 2; channel++)
                    planes[channel][index] =
                        0.4 * Math.sin((2 * Math.PI * (channel ? 660 : 440) * index) / rate);
            const mp3 = await encodeMp3(planes, { sampleRate: rate, bitrate: 96 });
            const raw = waveSamples(await bytesOf(await convert(mp3, 'wav')));
            assert.equal(raw.length, frames * 2);
            const mp4 = await copied(mp3, 'mp4');
            assert.equal((await readAll(mp4)).tracks[0].codec, 'mp3');
            assert.deepEqual(waveSamples(await bytesOf(await convert(mp4, 'wav'))), raw);
        });
    });

    describe('spatial video', () => {
        // iPhone and Vision Pro MV-HEVC: the layer configuration, Apple's video extended usage
        // and the field of view of the sample entry.
        const isoBox = (type, ...parts) => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(8 + Buffer.concat(parts).length);
            head.write(type, 4, 'latin1');
            return Buffer.concat([head, ...parts]);
        };
        const holds = holdsSpatialBoxes;
        const spatialOf = async bytes => (await inspect(bytes)).tracks[0].spatial;

        test('inspect() reports the eyes, camera, projection and field of view', async () => {
            assert.deepEqual(await spatialOf(spatialMp4()), SPATIAL);
            assert.equal(await spatialOf(FIXTURES['hevc.mp4'].bytes()), undefined);
        });

        for (const to of ['mp4', 'mov', 'fmp4'])
            test(`a ${to} copy keeps the spatial boxes`, async () => {
                const result = await convert(spatialMp4(), { to, start: 0.1 });
                const output = await bytesOf(result);
                assert.ok(holds(output));
                assert.deepEqual(await spatialOf(output), SPATIAL);
                assert.ok(!result.warnings.some(({ code }) => code === 'STEREO_VIEW_DROPPED'));
            });

        for (const to of ['mkv', 'ts'])
            test(`a ${to} copy names the second view it loses`, async () => {
                const result = await convert(spatialMp4(), { to });
                assert.ok(result.warnings.some(({ code }) => code === 'STEREO_VIEW_DROPPED'));
                assert.equal(await spatialOf(await bytesOf(result)), undefined);
            });

        test('strict validation refuses to drop the second view', async () => {
            await assert.rejects(
                convert(spatialMp4(), { to: 'mkv', open: { validation: 'strict' } }),
                error => error.code === 'FORMAT' || error.code === 'INPUT',
            );
        });

        test('the writer takes whole spatial boxes only', () => {
            const video = {
                id: 1,
                type: 'video',
                codec: 'hvc1.1.6.L30.90',
                width: 32,
                height: 24,
                spatialBoxes: new Uint8Array(isoBox('free')),
            };
            const config = { format: 'mp4', mode: 'standard', video };
            assert.throws(() => new Mp4Muxer(config, new MemorySink()), { code: 'FORMAT' });
        });
    });

    describe('xHE-AAC', () => {
        // USAC packets depend on earlier ones except at immediate playout frames, whose first bit
        // (usacIndependencyFlag) is set and which MP4 lists in an audio pre-roll group ('prol')
        // when its sync sample table is empty.
        const isoBox = (type, ...parts) => {
            const body = Buffer.concat(parts);
            const head = Buffer.alloc(8);
            head.writeUInt32BE(8 + body.length);
            head.write(type, 4, 'latin1');
            return Buffer.concat([head, body]);
        };
        const int32 = value => {
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32BE(value);
            return bytes;
        };
        // The AudioSpecificConfig of FATE's aac/usac/Fd_1_c1_0x03.mp4 (mono, 48 kHz).
        const ASC = [249, 70, 35, 33, 16, 192, 0];
        const payloads = [0, 1, 2, 3, 4, 5, 6, 7].map(index =>
            Buffer.of(index % 4 ? 0x40 : 0xc0, index, 1, 2),
        );
        const usac = options =>
            classicMp4({
                asc: ASC,
                payloads,
                timescale: 48000,
                timing: [[8, 1024]],
                ...options,
            }).bytes;
        const preRolled = () =>
            usac({
                sync: [],
                extraTables: [
                    isoBox(
                        'sgpd',
                        Buffer.of(1, 0, 0, 0),
                        Buffer.from('prol'),
                        int32(2),
                        int32(1),
                        Buffer.of(0, 1),
                    ),
                    isoBox(
                        'sbgp',
                        Buffer.alloc(4),
                        Buffer.from('prol'),
                        int32(4),
                        ...[1, 1, 3, 0, 1, 1, 3, 0].map(int32),
                    ),
                ],
            });
        const keyframes = async input =>
            (await readAll(input)).packets.map(packet => packet.isKeyframe);
        const INDEPENDENT = [true, false, false, false, true, false, false, false];

        test('immediate playout frames of a pre-roll group are keyframes', async () => {
            assert.deepEqual(await keyframes(preRolled()), INDEPENDENT);
        });

        test('a copy from a start time starts at a playout frame', async () => {
            // MP4 presents the requested start through its edit list.
            const cut = await convert(preRolled(), { to: 'm4a', start: (5 * 1024) / 48000 });
            assert.deepEqual(
                (await readAll(await bytesOf(cut))).packets.map(packet => [
                    packet.data[1],
                    packet.isKeyframe,
                ]),
                [
                    [4, true],
                    [5, false],
                    [6, false],
                    [7, false],
                ],
            );
            assert.ok(cut.warnings.some(warning => /at the keyframe/.test(warning.message)));
        });

        for (const to of ['mp4', 'fmp4'])
            test(`a ${to} copy keeps the playout frames as sync samples`, async () => {
                assert.deepEqual(await keyframes(await copied(preRolled(), to)), INDEPENDENT);
            });

        test('Matroska, whose writers flag every frame, is read from the frames', async () => {
            assert.deepEqual(await keyframes(await copied(usac({}), 'mkv')), INDEPENDENT);
        });

        test('re-encoding without a host decoder names the host', async () => {
            await assert.rejects(
                convert(preRolled(), { to: 'wav' }),
                error =>
                    error.code === 'DECODE' &&
                    /AudioDecoder supports mp4a\.40\.42/.test(error.hint),
            );
        });
    });

    describe('audio of unknown length in fragmented MP4', () => {
        // The priming is known before the first packet, the length only when the sound ends,
        // after the init is written: the edit hides the priming (segment_duration 0, media_time
        // the priming: the edit runs to the end of the media) and the end trim stays unstated.

        /** The entries of the first edit list of `bytes` as [segment_duration, media_time]. */
        const editsOf = bytes => {
            const at = boxAt(bytes, 'elst');
            if (at < 0) return [];
            const view = viewOf(bytes);
            const wide = bytes[at + 8] === 1;
            return Array.from({ length: view.getUint32(at + 12) }, (_, index) => {
                const entry = at + 16 + index * (wide ? 20 : 12);
                return wide
                    ? [Number(view.getBigUint64(entry)), Number(view.getBigInt64(entry + 8))]
                    : [view.getUint32(entry), view.getInt32(entry + 4)];
            });
        };

        test('a muxer told the priming before the length hides it from the init', async () => {
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format: 'mp4',
                    mode: 'fragmented',
                    audio: {
                        codec: 'mp4a.40.2',
                        codecConfig: Uint8Array.of(0x11, 0x90),
                        sampleRate: 48000,
                        channelCount: 2,
                    },
                },
                sink,
            );
            muxer.setAudioPriming(1024, undefined);
            for (let index = 0; index < 50; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(index, 1, 2, 3),
                    timestamp: (index * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
            // The length stated at the end cannot end the edit any more: it is left out.
            muxer.setAudioPriming(1024, 49 * 1024 - 300);
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            assert.ok(boxAt(bytes, 'moof') > 0);
            assert.deepEqual(editsOf(bytes), [[0, 1024]]);
            const { tracks, packets } = await readAll(bytes);
            assert.equal(packets[0].timestamp, -1024 / 48000);
            assert.equal(tracks[0].duration, (49 * 1024) / 48000);
            assert.equal(packets.at(-1).timestamp + packets.at(-1).duration, (49 * 1024) / 48000);
        });

        for (const [codec, priming] of [
            ['mp3', 528 + 529],
            ['aac', 1024],
        ])
            test(`${codec} encoded into a sink that cannot patch hides its priming`, async () => {
                const rate = 44100;
                const total = 2 * rate;
                const memory = new MemorySink();
                const forward = { write: data => memory.write(data), close: () => memory.close() };
                const muxer = await createMuxer('mp4', forward, {
                    audio: { codec, sampleRate: rate, channels: 1 },
                });
                await muxer.encodeAudio({
                    sampleRate: rate,
                    channels: 1,
                    estimatedFrames: total,
                    async *chunks() {
                        for (let at = 0; at < total; at += rate / 10)
                            yield [
                                Float32Array.from(
                                    { length: rate / 10 },
                                    (_, index) => 0.3 * Math.sin((at + index) / 20),
                                ),
                            ];
                    },
                });
                await muxer.finish();
                const bytes = memory.toUint8Array();
                assert.ok(boxAt(bytes, 'moof') > 0, 'fragmented');
                assert.deepEqual(editsOf(bytes), [[0, priming]]);
                const { tracks, packets } = await readAll(bytes);
                const end = packets.at(-1).timestamp + packets.at(-1).duration;
                assert.ok(Math.abs(packets[0].timestamp + priming / rate) < 1e-9);
                assert.ok(Math.abs(tracks[0].duration - end) < 1e-9);
                // Decoded, it presents the sound from its first sample to the end of its last
                // frame: all of it, and the end padding no edit states.
                const wav = await bytesOf(await convert(bytes, 'wav'));
                const frames = waveSamples(wav).length;
                assert.equal(frames, Math.round(end * rate));
                assert.ok(frames >= total && frames < total + 2 * 1152, `${frames} frames`);
            });
    });

    test('fragmented MP3 is an mp4a entry of object type 0x6B without decoder info', async () => {
        const layer3 = mpegAudioFixture(3);
        const writer = new CmafWriter({
            tracks: [
                {
                    id: 1,
                    type: 'audio',
                    codec: 'mp3',
                    timescale: 44100,
                    sampleRate: 44100,
                    channelCount: 1,
                },
            ],
        });
        const init = writer.createInitSegment();
        const esds = Buffer.from(init).indexOf('esds');
        assert.ok(Buffer.from(init).indexOf('mp4a') > 0 && esds > 0);
        assert.equal(init[Buffer.from(init).indexOf(Uint8Array.of(4), esds + 12) + 2], 0x6b);
        for (let index = 0; index < 4; index++)
            writer.addSample({
                trackId: 1,
                data: layer3.subarray(index * 417, (index + 1) * 417),
                decodeTimestamp: index * 1152,
                duration: 1152,
                isKeyframe: true,
            });
        const { tracks, packets } = await readAll(new Blob([init, writer.flush().data]));
        assert.equal(tracks[0].codec, 'mp3');
        assert.deepEqual(packets[3].data, layer3.subarray(3 * 417));
    });

    for (const [label, format, bytes, codec] of [
        ['AC-3', 'ac3', () => concat(ac3Frame(1), ac3Frame(2)), 'ac-3'],
        [
            'TrueHD',
            'truehd',
            () => concat(truehdUnit({ sampleRateCode: 0 }), truehdUnit({ bytes: 32 })),
            'mlpa',
        ],
    ])
        test(`raw ${label} copied into MP4 gets its record from the first frame`, async () => {
            // dac3 and dmlp, which MP4 needs.
            const source = await readAll(bytes());
            assert.equal(source.format, format);
            const { tracks } = await readAll(await copied(bytes(), 'mp4'));
            assert.deepEqual(
                tracks.map(track => [track.codec, track.sampleRate, track.channelCount]),
                [[codec, 48000, 2]],
            );
            assert.deepEqual(tracks[0].codecConfig, source.tracks[0].codecConfig);
        });
});
