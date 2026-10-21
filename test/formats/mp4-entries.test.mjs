import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { convert, open } from 'mediaforgejs';
import { Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { CmafWriter } from 'mediaforgejs/streaming';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { AAC_PAYLOADS, adtsFrame, concat } from '../helpers/original-fixtures.mjs';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';
import { idr, join, lengthPrefixed, pps, sps } from '../helpers/avi-h264-fixtures.mjs';
import { copied, decodedWave, readAll, rejectsStrict, sha256 } from '../helpers/read-media.mjs';
import { atom, preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { BASELINE_FIXTURE, annexBPackets } from '../helpers/h264-fixtures.mjs';
import { dtsCore } from '../helpers/sync-audio-fixtures.mjs';

// The sample entries of MP4 and QuickTime tracks: the codec, the configuration and the shape of the
// samples each one states, as the writers of old and odd files wrote them.

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** The offset of the first box of `type` in `bytes`. */
const boxAt = (bytes, type) => Buffer.from(bytes).indexOf(type) - 4;

/** A QuickTime box of `type` around `parts`. */
const qtBox = (type, ...parts) => {
    const payload = Buffer.concat(parts.map(part => Buffer.from(part)));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
};
/** Big-endian 32-bit words. */
const u32s = (...values) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
    return out;
};

/**
 * A QuickTime movie of one sound track: its sample entry `fourcc` with `entry` (the sound
 * description after the box header), `units` single-sample units at `rate` in `chunks`, `perChunk`
 * units per chunk.
 */
function soundMovie({ fourcc, entry, rate, units, chunks, perChunk }) {
    const mdhd = Buffer.alloc(24);
    mdhd.writeUInt32BE(rate, 12);
    mdhd.writeUInt32BE(units, 16);
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(rate, 12);
    const tkhd = Buffer.alloc(84);
    tkhd.writeUInt32BE(1, 12);
    const ftyp = qtBox('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1'));
    const first = ftyp.length + 8;
    const offsets = chunks.map(
        (_, index) => first + chunks.slice(0, index).reduce((sum, chunk) => sum + chunk.length, 0),
    );
    const stsc = perChunk.flatMap((count, index) => [index + 1, count, 1]);
    const moov = qtBox(
        'moov',
        qtBox('mvhd', mvhd),
        qtBox(
            'trak',
            qtBox('tkhd', tkhd),
            qtBox(
                'mdia',
                qtBox('mdhd', mdhd),
                qtBox('hdlr', u32s(0, 0), 'soun', Buffer.alloc(12)),
                qtBox(
                    'minf',
                    qtBox(
                        'stbl',
                        qtBox('stsd', u32s(0, 1), qtBox(fourcc, entry)),
                        qtBox('stts', u32s(0, 1, units, 1)),
                        qtBox('stsc', u32s(0, perChunk.length, ...stsc)),
                        qtBox('stsz', u32s(0, 1, units)),
                        qtBox('stco', u32s(0, chunks.length, ...offsets)),
                    ),
                ),
            ),
        ),
    );
    return new Uint8Array(Buffer.concat([ftyp, qtBox('mdat', ...chunks), moov]));
}

/** A version-0 sound description of `channels` 16-bit channels at 8 kHz. */
const version0 = channels => {
    const entry = Buffer.alloc(28);
    entry.writeUInt16BE(1, 6);
    entry.writeUInt16BE(channels, 16);
    entry.writeUInt16BE(16, 18);
    entry.writeUInt32BE(8000 * 65536, 24);
    return entry;
};

/** An MP4 of one H.264 picture. */
async function h264Picture() {
    const config = join([1, 66, 0, 10, 0xff, 0xe1, 0, sps.length], sps, [1, 0, pps.length], pps);
    const sink = new MemorySink();
    const muxer = new Mp4Muxer(
        {
            format: 'mp4',
            mode: 'standard',
            autoSync: false,
            video: {
                id: 1,
                type: 'video',
                codec: 'avc1.42000a',
                width: 32,
                height: 16,
                codecConfig: config,
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
    return sink.toUint8Array();
}

const pcmFixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/pcm/${name}`, import.meta.url)));

describe('mp4: sample entries', () => {
    describe('QuickTime sound', () => {
        test('reads the Macintosh language code of a track', async () => {
            const mac = await readAll(fixtures['mov-maclang.mov']());
            assert.deepEqual(
                [mac.tracks[0].language, mac.tracks[0].codec, mac.title],
                ['jpn', 'pcm-s16le', 'Mac'],
            );
        });

        test("reads the same movie behind a 'pnot' preview header in place of ftyp", async () => {
            // Old QuickTime files open with it; both boxes here are 20 bytes.
            const preview = fixtures['mov-maclang.mov']();
            preview.set([...Buffer.from('pnot\0\0\0\0\0\0PICT\0\x01', 'latin1')], 4);
            assert.deepEqual(
                (await readAll(preview)).hashes,
                (await readAll(fixtures['mov-maclang.mov']())).hashes,
            );
        });

        test("reads MPEG audio under '.mp2', Microsoft's 'ms\\0P' and '.mp1'", async () => {
            const layer2 = fixtures['mov-mp2.mov']();
            assert.equal((await readAll(layer2)).tracks[0].codec, 'mp2');
            const fourcc = Buffer.from(layer2).indexOf('.mp2');
            layer2.set([0x6d, 0x73, 0, 0x50], fourcc);
            assert.equal((await readAll(layer2)).tracks[0].codec, 'mp2');
            layer2.set([...Buffer.from('.mp1', 'latin1')], fourcc);
            assert.equal((await readAll(layer2)).tracks[0].codec, 'mp1');
        });

        for (const [name, codec] of [
            ['mov-in24le.mov', 'pcm-s24le'],
            ['mov-in24be.mov', 'pcm-s24be'],
            ['mov-fl32le.mov', 'pcm-f32le'],
        ])
            test(`reads ${name} as ${codec} and decodes it`, async () => {
                const media = await readAll(fixtures[name]());
                assert.equal(media.tracks[0].codec, codec);
                const { channels, frames } = await decodedWave(
                    fixtures[name](),
                    media.tracks[0].id,
                );
                assert.deepEqual([channels, frames], [1, 160]);
            });

        test("reads the ALAC configuration inside a 'wave' atom", async () => {
            const { tracks } = await readAll(fixtures['mov-alac6.mov']());
            assert.deepEqual([tracks[0].codec, tracks[0].channelCount], ['alac', 6]);
        });

        test('reads six-channel ALAC in M4A', async () => {
            const { tracks } = await readAll(fixtures['m4a-alac6.m4a']());
            assert.deepEqual([tracks[0].codec, tracks[0].channelCount], ['alac', 6]);
        });

        test("reads MP3 under 'mp4a' with the MP3 object type and under '.mp3'", async () => {
            assert.equal((await readAll(fixtures['mp4-mp3.mp4']())).tracks[0].codec, 'mp3');
            assert.equal((await readAll(fixtures['mov-mp3.mov']())).tracks[0].codec, 'mp3');
        });

        test('a movie without ftyp is QuickTime though MPEG audio fills the prefix', async () => {
            const withoutFtyp = fixtures['mov-mp3.mov']();
            withoutFtyp.set(Buffer.from('free'), 4);
            const boxed = await readAll(withoutFtyp);
            assert.deepEqual(
                [boxed.format, boxed.hashes],
                ['mp4', (await readAll(fixtures['mov-mp3.mov']())).hashes],
            );
        });

        test('version-1 MPEG audio of single samples splits at the frame headers', async () => {
            // One stts run of duration 1 and a placeholder stsz size of 1: each chunk splits at
            // its frame headers, as ffmpeg's parser splits it.
            const mp3 = await readAll(fixtures['mov-mp3.mov']());
            const frames = mp3.packets.map(packet => packet.data);
            const chunks = [frames.slice(0, 2), frames.slice(2)];
            const entry = Buffer.alloc(44);
            entry.writeUInt16BE(1, 6);
            entry.writeUInt16BE(1, 8);
            entry.writeUInt16BE(1, 16);
            entry.writeUInt16BE(16, 18);
            entry.writeUInt16BE(0xfffe, 20);
            entry.writeUInt32BE(32000 * 65536, 24);
            entry.writeUInt32BE(1152, 28);
            entry.writeUInt32BE(frames[0].length, 32);
            entry.writeUInt32BE(frames[0].length, 36);
            entry.writeUInt32BE(2, 40);
            const movie = soundMovie({
                fourcc: 'ms\0U',
                entry,
                rate: 32000,
                units: frames.length * 1152,
                chunks: chunks.map(chunk => Buffer.concat(chunk)),
                perChunk: chunks.map(chunk => chunk.length * 1152),
            });
            const chunked = await readAll(movie);
            assert.equal(chunked.tracks[0].codec, 'mp3');
            assert.deepEqual(chunked.hashes, mp3.hashes, 'one packet per MPEG audio frame');
            assert.deepEqual(
                chunked.packets.map(packet => Math.round(packet.timestamp * 32000)),
                frames.map((_, index) => index * 1152),
            );
        });

        describe('legacy PCM tables', () => {
            // The chunk layout holds the frames, as ffmpeg reads them.
            const tableOf = (bytes, type) => boxAt(bytes, type);
            const perChannel = () => {
                const bytes = fixtures['mov-twos-stereo.mov']();
                const stsz = tableOf(bytes, 'stsz');
                viewOf(bytes).setUint32(stsz + 12, 2);
                viewOf(bytes).setUint32(stsz + 16, 320);
                return bytes;
            };

            test('reads a stereo twos movie as one packet', async () => {
                const reference = await readAll(fixtures['mov-twos-stereo.mov']());
                assert.deepEqual(
                    [
                        reference.tracks[0].codec,
                        reference.packets.map(packet => packet.data.length),
                    ],
                    ['pcm-s16be', [640]],
                );
            });

            test('stsz counting per-channel samples reads frames by the chunks', async () => {
                const reference = await readAll(fixtures['mov-twos-stereo.mov']());
                const legacy = await readAll(perChannel());
                assert.deepEqual(legacy.warnings, ['MP4_PCM_FRAME_LAYOUT']);
                assert.deepEqual(legacy.hashes, reference.hashes);
                assert.equal(legacy.tracks[0].duration, reference.tracks[0].duration);
            });

            test("16-bit 'raw ' with a placeholder sample size is big-endian", async () => {
                const raw = perChannel();
                raw.set(Buffer.from('raw '), tableOf(raw, 'twos') + 4);
                const stsz = tableOf(raw, 'stsz');
                viewOf(raw).setUint32(stsz + 12, 1);
                viewOf(raw).setUint32(stsz + 16, 160);
                const rawRead = await readAll(raw);
                assert.equal(rawRead.tracks[0].codec, 'pcm-s16be');
                assert.deepEqual(
                    rawRead.hashes,
                    (await readAll(fixtures['mov-twos-stereo.mov']())).hashes,
                );
            });

            test('tables of single frames read as packets of up to 1024 frames', async () => {
                // One packet per frame made millions of packets and stalled copies.
                const u8 = await readAll(fixtures['mov-u8-mono.mov']());
                assert.deepEqual(
                    [u8.tracks[0].codec, u8.packets.map(packet => packet.data.length), u8.warnings],
                    ['pcm-u8', [1024, 1024, 1024, 1024, 64], []],
                );
                assert.deepEqual(
                    u8.packets.map(packet => [packet.timestamp * 8000, packet.duration * 8000]),
                    [
                        [0, 1024],
                        [1024, 1024],
                        [2048, 1024],
                        [3072, 1024],
                        [4096, 64],
                    ],
                );
                const { channels, frames } = await decodedWave(
                    fixtures['mov-u8-mono.mov'](),
                    u8.tracks[0].id,
                );
                assert.deepEqual([channels, frames], [1, 4160]);
            });

            test('the sample budget counts those packets, not the frames', async () => {
                (await open(fixtures['mov-u8-mono.mov'](), { maxSamples: 5 })).close();
                await assert.rejects(open(fixtures['mov-u8-mono.mov'](), { maxSamples: 4 }), {
                    code: 'OOM',
                });
            });

            test('a chunk past its media data keeps the whole frames before the cut', async () => {
                const cut = fixtures['mov-u8-mono.mov']();
                viewOf(cut).setUint32(tableOf(cut, 'stco') + 16, 36 + 3000);
                const cutRead = await readAll(cut);
                assert.deepEqual(
                    cutRead.packets.map(packet => packet.data.length),
                    [1024, 136],
                );
                assert.deepEqual(cutRead.warnings, ['MP4_TRUNCATED_SAMPLES']);
                assert.equal(cutRead.tracks[0].incomplete, true);
                await rejectsStrict(cut);
            });

            test('a media header longer than the frames ends the track at them', async () => {
                const long = fixtures['mov-u8-mono.mov']();
                viewOf(long).setUint32(tableOf(long, 'mdhd') + 24, 8000);
                assert.equal((await readAll(long)).tracks[0].duration, 4160 / 8000);
            });

            test("QuickTime's original 'NONE' sound is offset-binary 8-bit", async () => {
                const none = fixtures['mov-u8-mono.mov']();
                none.set(Buffer.from('NONE'), tableOf(none, 'raw ') + 4);
                assert.equal((await readAll(none)).tracks[0].codec, 'pcm-u8');
            });
        });

        describe('codecs that state the shape of their frames', () => {
            // A version-0 description of IMA4 or MACE leaves the frame shape to the codec (64
            // samples in 34 bytes per channel; MACE 3:1 six samples in two bytes), which the chunk
            // layout of its sample tables needs. Such movies used to fail as "ledger-flood input".
            // The blocks of test/fixtures/pcm/ima4.aif, two chunks of two frames counted in single
            // samples (stts 256 x 1, stsz placeholder 1), as old QuickTime wrote them.
            const ima4Movie = () => {
                const aiff = pcmFixture('ima4.aif');
                const blocks = aiff.subarray(aiff.length - 272);
                return soundMovie({
                    fourcc: 'ima4',
                    entry: version0(2),
                    rate: 8000,
                    units: 256,
                    chunks: [blocks.subarray(0, 136), blocks.subarray(136)],
                    perChunk: [128],
                });
            };

            test('reads each IMA4 chunk of two 68-byte frames as a packet', async () => {
                const { tracks, packets } = await readAll(ima4Movie());
                assert.deepEqual(
                    [tracks[0].codec, packets.map(packet => packet.data.length)],
                    ['ima4', [136, 136]],
                );
            });

            test('IMA4 in a movie decodes as the reference decodes the AIFF-C', async () => {
                // ffmpeg's s16le decode of ima4.aif.
                const { bytes } = await decodedWave(ima4Movie(), 1);
                const samples = Buffer.from(bytes.subarray(Buffer.from(bytes).indexOf('data') + 8));
                assert.ok(samples.equals(pcmFixture('ima4-reference.s16le')));
            });

            test('MACE 3:1 opens with its frames and converting it names MACE', async () => {
                // 4098 single-sample units, 683 frames of two bytes.
                const mace = soundMovie({
                    fourcc: 'MAC3',
                    entry: version0(1),
                    rate: 8000,
                    units: 4098,
                    chunks: [Buffer.alloc(683 * 2)],
                    perChunk: [4098],
                });
                const { tracks, packets } = await readAll(mace);
                assert.deepEqual(
                    [tracks[0].codec, packets.length, packets[0].data.length],
                    ['MAC3', 5, 340],
                );
                await assert.rejects(convert(mace, { to: 'wav' }), {
                    code: 'DECODE',
                    message: /MACE 3:1 audio cannot be decoded/,
                });
            });
        });
    });

    describe('AAC and other audio', () => {
        test('walks the descriptor tree of esds rather than scanning it', async () => {
            // A maxBitrate of 0x00007e05 puts an 0x05 byte before the DecoderSpecificInfo tag.
            const esds = await readAll(fixtures['3gp-esds.3gp']());
            const [track] = esds.tracks;
            assert.deepEqual([track.codec, track.sampleRate], ['mp4a.40.2', 44100]);
            assert.equal(Buffer.from(track.codecConfig).toString('hex'), '120856e500');
            const { channels, frames } = await decodedWave(fixtures['3gp-esds.3gp'](), track.id);
            assert.deepEqual([channels, frames], [1, 2205]);
        });

        test('an ES_Descriptor sized past its esds box still gives the configuration', async () => {
            // An SL descriptor the box cuts.
            const intact = classicMp4().bytes;
            const cut = intact.slice();
            const tag = Buffer.from(cut).indexOf('esds') + 8;
            assert.equal(cut[tag], 3);
            cut[tag + 1] += 6;
            const expected = await readAll(intact);
            const actual = await readAll(cut);
            assert.deepEqual(actual.tracks[0].codecConfig, expected.tracks[0].codecConfig);
            assert.deepEqual(actual.hashes, expected.hashes);
        });

        describe('AAC samples of whole ADTS frames without esds', () => {
            const frames = AAC_PAYLOADS.map(payload => adtsFrame(payload));
            const wrapped = () =>
                classicMp4({ payloads: frames, esds: false, timing: [[4, 1024]] }).bytes;

            test('take the configuration from the ADTS header and read raw', async () => {
                // LC, 48 kHz, mono.
                const { tracks, packets } = await readAll(wrapped());
                assert.equal(tracks[0].codec, 'mp4a.40.2');
                assert.deepEqual([...tracks[0].codecConfig], [0x11, 0x88]);
                assert.deepEqual(
                    packets.map(packet => [...packet.data]),
                    AAC_PAYLOADS.map(payload => [...payload]),
                );
            });

            test('copy to ADTS with one header per frame, and to MP4', async () => {
                assert.deepEqual(await copied(wrapped(), 'aac'), concat(...frames));
                const mp4 = await readAll(await copied(wrapped(), 'mp4'));
                assert.deepEqual([...mp4.tracks[0].codecConfig], [0x11, 0x88]);
                assert.deepEqual(mp4.hashes, (await readAll(wrapped())).hashes);
            });

            test('a sample that is not one ADTS frame leaves the track as stored', async () => {
                const mixed = await readAll(
                    classicMp4({
                        payloads: [...frames.slice(0, 3), Uint8Array.from(AAC_PAYLOADS[3])],
                        esds: false,
                    }).bytes,
                );
                assert.equal(mixed.tracks[0].codecConfig, undefined);
                assert.deepEqual(mixed.hashes.slice(0, 3), frames.slice(0, 3).map(sha256));
            });
        });

        for (const [fourcc, rate] of [
            ['samr', 8000],
            ['sawb', 16000],
        ])
            test(`'${fourcc}' AMR is mono at ${rate} Hz whatever its entry states`, async () => {
                // Phones write a zero rate and two channels, which ffmpeg overrides likewise.
                const bytes = classicMp4({ esds: false }).bytes;
                const entry = boxAt(bytes, 'mp4a');
                bytes.set(Buffer.from(fourcc), entry + 4);
                viewOf(bytes).setUint16(entry + 24, 2);
                viewOf(bytes).setUint32(entry + 32, 0);
                const [track] = (await readAll(bytes)).tracks;
                assert.deepEqual(
                    [track.codec, track.sampleRate, track.channelCount],
                    [fourcc, rate, 1],
                );
            });

        test("an 'mp4a' entry of the EVRC object type is 8 kHz mono EVRC", async () => {
            const bytes = classicMp4().bytes;
            const objectType = Buffer.from(bytes).indexOf(
                Uint8Array.of(0x40, 0x15),
                Buffer.from(bytes).indexOf('esds'),
            );
            bytes[objectType] = 0xd1;
            viewOf(bytes).setUint32(boxAt(bytes, 'mp4a') + 32, 0);
            const [evrc] = (await readAll(bytes)).tracks;
            assert.deepEqual([evrc.codec, evrc.sampleRate, evrc.channelCount], ['evrc', 8000, 1]);
        });

        test('reads Vorbis in MP4 into the Xiph-laced configuration', async () => {
            // esds object type 0xDD as GPAC wrote it: each header packet after a 16-bit length.
            // The decoder and other containers use the laced form.
            const vorbis = VORBIS_FIXTURES.find(entry => entry.name === 'stereo-48000-q2');
            const ogg = await readAll(vorbis.bytes());
            const laced = ogg.tracks[0].codecConfig;
            const lengths = [0, 0];
            let lace = 1;
            for (const header of [0, 1])
                do lengths[header] += laced[lace];
                while (laced[lace++] === 255);
            const headers = [
                laced.subarray(lace, lace + lengths[0]),
                laced.subarray(lace + lengths[0], lace + lengths[0] + lengths[1]),
                laced.subarray(lace + lengths[0] + lengths[1]),
            ];
            const packets = ogg.packets.slice(0, 12).map(packet => packet.data);
            const mp4 = Buffer.from(
                classicMp4({ sizes: packets.map(packet => packet.length) }).bytes,
            );
            let at = mp4.indexOf('mdat') + 4;
            for (const packet of packets) at += Buffer.from(packet).copy(mp4, at);
            const length = size => [
                0x80 | ((size >> 21) & 127),
                0x80 | ((size >> 14) & 127),
                0x80 | ((size >> 7) & 127),
                size & 127,
            ];
            const info = Buffer.concat(
                headers.map(header =>
                    Buffer.concat([Buffer.from([header.length >> 8, header.length & 255]), header]),
                ),
            );
            const decoderConfig = Buffer.concat([
                Buffer.from([0xdd, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                Buffer.from([5, ...length(info.length)]),
                info,
            ]);
            const es = Buffer.concat([
                Buffer.from([0, 1, 0, 4, ...length(decoderConfig.length)]),
                decoderConfig,
                Buffer.from([6, 1, 2]),
            ]);
            const body = Buffer.concat([Buffer.from([0, 0, 0, 0, 3, ...length(es.length)]), es]);
            const esdsAt = mp4.indexOf('esds') - 4;
            const esds = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('esds'), body]);
            esds.writeUInt32BE(esds.length, 0);
            const delta = esds.length - mp4.readUInt32BE(esdsAt);
            const vorbisMp4 = Buffer.concat([
                mp4.subarray(0, esdsAt),
                esds,
                mp4.subarray(esdsAt + mp4.readUInt32BE(esdsAt)),
            ]);
            for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']) {
                const box = vorbisMp4.indexOf(type) - 4;
                vorbisMp4.writeUInt32BE(vorbisMp4.readUInt32BE(box) + delta, box);
            }
            const media = await readAll(new Uint8Array(vorbisMp4));
            assert.deepEqual(
                [media.tracks[0].codec, media.tracks[0].codecConfig],
                ['vorbis', laced],
            );
            const { frames } = await decodedWave(new Uint8Array(vorbisMp4), media.tracks[0].id);
            assert.ok(frames > 0);
        });
    });

    describe('FLAC', () => {
        /** A STREAMINFO record of `sampleRate`, two channels of 24 bits and 4096-sample blocks. */
        const streamInfo = sampleRate => {
            const record = new Uint8Array(34);
            const view = viewOf(record);
            view.setUint16(0, 4096);
            view.setUint16(2, 4096);
            view.setUint32(10, sampleRate * 4096 + 1 * 512 + 23 * 16);
            return record;
        };
        /** The channel count, sample size and rate (integer part) of the 'fLaC' entry in `file`. */
        const entryOf = file => {
            const at = boxAt(file, 'fLaC');
            const view = viewOf(file);
            return [view.getUint16(at + 24), view.getUint16(at + 26), view.getUint16(at + 32)];
        };
        const standard = async sampleRate => {
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format: 'mp4',
                    mode: 'standard',
                    autoSync: false,
                    audio: {
                        codec: 'flac',
                        sampleRate,
                        channelCount: 2,
                        codecConfig: streamInfo(sampleRate),
                    },
                },
                sink,
            );
            muxer.addAudioChunk({
                trackType: 'audio',
                data: Uint8Array.of(0xff, 0xf8, 0, 0),
                timestamp: 0,
                duration: 4096 / sampleRate,
                isKeyframe: true,
            });
            await muxer.finalize();
            return sink.toUint8Array();
        };
        const fragmented = sampleRate =>
            new CmafWriter({
                tracks: [
                    {
                        id: 1,
                        type: 'audio',
                        codec: 'flac',
                        timescale: sampleRate,
                        sampleRate,
                        channelCount: 2,
                        codecConfig: streamInfo(sampleRate),
                    },
                ],
            }).createInitSegment();

        // xiph's FLAC in ISOBMFF: the 16.16 rate field holds a rate above 65535 Hz as its greatest
        // expressible regular division, or 65535 where it has none; the record states the rate.
        for (const [sampleRate, stated] of [
            [44100, 44100],
            [96000, 48000],
            [176400, 44100],
            [192000, 48000],
            [100001, 65535],
        ])
            test(`${sampleRate} Hz is stated as ${stated} Hz in MP4 and fMP4`, async () => {
                const file = await standard(sampleRate);
                assert.deepEqual(entryOf(file), [2, 24, stated], 'standard');
                assert.deepEqual(entryOf(fragmented(sampleRate)), [2, 24, stated], 'fragmented');
                assert.equal((await readAll(file)).tracks[0].sampleRate, sampleRate);
            });
    });

    describe('video', () => {
        for (const [version, codec] of [
            [1, 'flv1'],
            [0, 'h263'],
        ])
            test(`F4V 'H263' of picture start code version ${version} is ${codec}`, async () => {
                // F4V names Sorenson Spark (FLV's H.263 variant, version 1) 'H263', as it names
                // H.263.
                const file = Buffer.from(await h264Picture());
                file.write('H263', file.indexOf('avc1', file.indexOf('stsd')), 'latin1');
                const picture = file.indexOf(Buffer.from(lengthPrefixed(4, idr)));
                file.set([0, 0, 0x80 | (version << 2)], picture);
                assert.equal((await readAll(new Uint8Array(file))).tracks[0].codec, codec);
            });
    });

    describe('codecs named by the entry', () => {
        const shapes = tracks =>
            tracks.map(track => [track.codec, track.sampleRate, track.channelCount]);
        /** An mp4a entry whose esds names `objectType`, with decoder info `specificInfo`. */
        function mp4aEntry(objectType, specificInfo = []) {
            const base = Buffer.alloc(28);
            base.writeUInt16BE(1, 6);
            base.writeUInt16BE(2, 16);
            base.writeUInt16BE(16, 18);
            base.writeUInt32BE(48000 * 65536, 24);
            const info = specificInfo.length ? [5, specificInfo.length, ...specificInfo] : [];
            const config = [
                4,
                13 + info.length,
                objectType,
                0x15,
                ...new Array(11).fill(0),
                ...info,
            ];
            const es = [3, 3 + config.length + 3, 0, 1, 0, ...config, 6, 1, 2];
            return atom('mp4a', base, atom('esds', Buffer.alloc(4), Buffer.from(es)));
        }
        /** A sound entry of `type` with stereo 16-bit fields that `fields` completes. */
        function audioEntry(type, fields, ...children) {
            const base = Buffer.alloc(28);
            base.writeUInt16BE(1, 6);
            base.writeUInt16BE(2, 16);
            base.writeUInt16BE(16, 18);
            fields(base);
            return atom(type, base, ...children);
        }
        const audioMovie = (audioEntry, packets) =>
            preservationFixture({
                tracks: [{ type: 'audio', audioEntry, ...(packets ? { packets } : {}) }],
            }).bytes;

        // Only 0x40 and 0x66-0x68 are AAC.
        for (const [objectType, codec] of [
            [0xa9, 'dtsc'],
            [0xab, 'dtsl'],
            [0xa5, 'ac-3'],
            [0xa6, 'ec-3'],
            [0xdd, 'vorbis'],
            [0xe1, 'qcelp'],
            [0xe2, 'mp4a-oti-e2'],
            [0x40, 'mp4a.40.2'],
        ])
            test(`the esds object type 0x${objectType.toString(16)} names '${codec}'`, async () => {
                const { tracks } = await readAll(audioMovie(mp4aEntry(objectType)));
                assert.equal(tracks[0].codec, codec);
            });

        test("ffmpeg's DTS in MP4 takes its DTSSpecificBox from the first unit", async () => {
            const frames = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
            const { tracks } = await readAll(audioMovie(mp4aEntry(0xa9), frames.map(Buffer.from)));
            assert.deepEqual(shapes(tracks), [['dtsc', 48000, 2]]);
            assert.equal(tracks[0].codecConfig.length, 20);
        });

        test('an avc1 entry with an empty avcC is named by its in-band SPS', async () => {
            // Its samples are Annex B; the codec string is not a placeholder profile.
            const packets = annexBPackets(BASELINE_FIXTURE).map(Buffer.from);
            const bytes = preservationFixture({
                tracks: [{ type: 'video', codecConfig: new Uint8Array(0), packets }],
            }).bytes;
            const { tracks } = await readAll(bytes);
            assert.equal(tracks[0].codec.toLowerCase(), BASELINE_FIXTURE.codec.toLowerCase());
        });

        const rate48k = base => base.writeUInt32BE(48000 * 65536, 24);
        for (const [label, entry, expected] of [
            [
                'TrueHD stating its rate as a 32-bit integer',
                () => audioEntry('mlpa', base => base.writeUInt32BE(96000, 24)),
                ['mlpa', 96000, 2],
            ],
            [
                'little-endian 24-bit ipcm',
                () => audioEntry('ipcm', rate48k, atom('pcmC', Buffer.alloc(4), Buffer.of(1, 24))),
                ['pcm-s24le', 48000, 2],
            ],
            [
                'big-endian 32-bit fpcm',
                () => audioEntry('fpcm', rate48k, atom('pcmC', Buffer.alloc(4), Buffer.of(0, 32))),
                ['pcm-f32be', 48000, 2],
            ],
            ['QuickTime MPEG Layer II', () => audioEntry('.mp2', rate48k), ['mp2', 48000, 2]],
            [
                'QuickTime DTS-HD lossless',
                () => audioEntry('dtsl', rate48k, atom('ddts', Buffer.alloc(20))),
                ['dtsl', 48000, 2],
            ],
        ])
            test(`reads ${label}`, async () => {
                assert.deepEqual(shapes((await readAll(audioMovie(entry()))).tracks), [expected]);
            });
    });
});
