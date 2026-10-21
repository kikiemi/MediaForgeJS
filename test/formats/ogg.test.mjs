import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open } from 'mediaforgejs';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { concat, flacFixture, oggPage } from '../helpers/original-fixtures.mjs';
import { FIXTURES, assertReadsAsRecorded } from '../helpers/recorded-fixtures.mjs';
import {
    allPackets,
    bytesOf,
    copied,
    decodedWave,
    readAll,
    readMedia,
    sha256,
} from '../helpers/read-media.mjs';
import { readFileSync } from 'node:fs';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';
import { VorbisMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { readerPart } from '../helpers/parts.mjs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

const payloads = packets => packets.map(packet => packet.data);
const ascii = value => new TextEncoder().encode(value);

/** The CRC of an Ogg page, its checksum field zeroed. */
function oggCrc(page) {
    let crc = 0;
    for (const byte of page) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    return crc >>> 0;
}

/** The pages of an Ogg stream, each a copy. */
function oggPages(bytes) {
    const pages = [];
    for (let at = 0; at < bytes.length;) {
        const segments = bytes[at + 26];
        let size = 27 + segments;
        for (let index = 0; index < segments; index++) size += bytes[at + 27 + index];
        pages.push(bytes.slice(at, at + size));
        at += size;
    }
    return pages;
}

/** `pages` joined, each with its CRC computed again. */
function oggJoin(pages) {
    for (const page of pages) {
        const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
        view.setUint32(22, 0, true);
        view.setUint32(22, oggCrc(page), true);
    }
    return new Uint8Array(Buffer.concat(pages));
}

/** Where each Ogg page of `bytes` starts. */
function pageStarts(bytes) {
    const starts = [];
    for (let at = Buffer.from(bytes).indexOf('OggS'); at >= 0;) {
        starts.push(at);
        at = Buffer.from(bytes).indexOf('OggS', at + 1);
    }
    return starts;
}

/** The STREAMINFO and the three frames of flacFixture(). */
function flacParts() {
    const native = flacFixture();
    return {
        streamInfo: native.subarray(4, 42),
        frames: [0, 1, 2].map(index => native.subarray(42 + index * 12, 54 + index * 12)),
    };
}

/** flacFixture() in Ogg with the 0x7F 'FLAC' mapping of FLAC 1.1.1 and later. */
function oggFlac() {
    const { streamInfo, frames } = flacParts();
    const identification = concat([0x7f], ascii('FLAC'), [1, 0, 0, 0], ascii('fLaC'), streamInfo);
    return concat(
        oggPage([identification], 0, { flags: 2 }),
        oggPage(frames, 1, { flags: 4, granule: 48 }),
    );
}

describe('ogg', () => {
    for (const file of ['speex.ogg', 'theora.ogv', 'twoopus.ogg'])
        test(`reads ${file} as recorded: tracks, packet times, keyframes and payloads`, () =>
            assertReadsAsRecorded(file));

    test('reads Opus of mapping family 1 and the title of its comments', async () => {
        const { title, tracks } = await readMedia(fixtures['ogg-opus6.opus']());
        assert.equal(tracks[0].track.channelCount, 6);
        assert.equal(title, 'Surround');
        assert.equal(tracks[0].packets.length, 4);
    });

    test('a cut last page keeps the packets before it and marks the track incomplete', async () => {
        const source = fixtures['ogg-opus.opus']();
        const whole = await allPackets(source);
        assert.equal(whole.length, 16);
        const cut = source.subarray(0, Buffer.from(source).lastIndexOf('OggS') + 40);
        const { tracks, warnings } = await readMedia(cut);
        assert.deepEqual(warnings, ['OGG_TRUNCATED', 'OGG_MISSING_EOS']);
        assert.equal(tracks[0].track.incomplete, true);
        const read = payloads(tracks[0].packets);
        assert.ok(read.length > 0 && read.length < 16, `${read.length} packets`);
        assert.deepEqual(read, payloads(whole).slice(0, read.length));
        await rejectsStrict(cut);
    });

    test('a page whose CRC does not match is left out and the track is incomplete', async () => {
        const source = fixtures['ogg-opus.opus']();
        const pages = pageStarts(source);
        assert.ok(pages.length > 6, `${pages.length} pages`);
        const damaged = source.slice();
        damaged[pages[4] + 27 + source[pages[4] + 26] + 3] ^= 0xff;
        const { tracks, warnings } = await readMedia(damaged);
        assert.ok(warnings.includes('OGG_PAGE_CRC'), `${warnings}`);
        assert.ok(tracks[0].packets.length > 0 && tracks[0].packets.length < 16);
        assert.equal(tracks[0].track.incomplete, true);
        await rejectsStrict(damaged);
    });

    test('reads every logical stream of a multiplexed file, also when strict', async () => {
        const multiplexed = fixtures['ogg-theora-opus.ogg']();
        const { tracks, warnings } = await readMedia(multiplexed);
        assert.deepEqual(
            tracks.map(({ track }) => track.codec),
            ['theora', 'opus'],
        );
        assert.deepEqual(warnings, []);
        assert.deepEqual(
            payloads(await allPackets(multiplexed, { validation: 'strict' })),
            payloads(await allPackets(multiplexed)),
        );
    });

    test('a chained link of the same codec setup continues the track, with a warning', async () => {
        // The join keeps the second link's pre-skip, so it is reported.
        const single = fixtures['ogg-opus.ogg']();
        const first = payloads(await allPackets(single));
        const chained = concat(single, single);
        const { tracks, warnings } = await readMedia(chained);
        assert.deepEqual(warnings, ['OGG_CHAINED_STREAMS']);
        assert.deepEqual(payloads(tracks[0].packets), [...first, ...first]);
        await rejectsStrict(chained);
    });

    test('skips sector padding between one link and the next', async () => {
        // Game and disc rips pad each link to a sector.
        const single = fixtures['ogg-opus.ogg']();
        const first = payloads(await allPackets(single));
        const { tracks, warnings } = await readMedia(concat(single, new Uint8Array(300), single));
        assert.deepEqual(warnings, ['OGG_CHAIN_PADDING', 'OGG_CHAINED_STREAMS']);
        assert.deepEqual(payloads(tracks[0].packets), [...first, ...first]);
    });

    test('a BOS page of the same serial after a lost EOS page starts the next link', async () => {
        const single = fixtures['ogg-opus.ogg']();
        const first = payloads(await allPackets(single));
        const pages = oggPages(single);
        pages.at(-1)[5] &= ~4;
        const { tracks, warnings } = await readMedia(concat(oggJoin(pages), single));
        // The last page without EOS keeps the first link's end padding, which its granule reports.
        assert.deepEqual(warnings, [
            'OGG_GRANULE_MISMATCH',
            'OGG_MISSING_EOS',
            'OGG_CHAINED_STREAMS',
        ]);
        assert.deepEqual(payloads(tracks[0].packets), [...first, ...first]);
    });

    test("reads FLAC 1.0.x's bare 'fLaC' mapping as the 0x7F 'FLAC' mapping", async () => {
        // FLAC 1.0.x wrote 'fLaC' and then one packet per metadata block.
        const { streamInfo, frames } = flacParts();
        const current = await readMedia(oggFlac());
        const legacy = await readMedia(
            concat(
                oggPage([ascii('fLaC')], 0, { flags: 2 }),
                oggPage([streamInfo], 1),
                oggPage(frames, 2, { flags: 4, granule: 48 }),
            ),
        );
        assert.deepEqual(legacy.warnings, []);
        assert.equal(legacy.tracks[0].track.codec, 'flac');
        assert.equal(legacy.tracks[0].track.sampleRate, 8000);
        assert.deepEqual(legacy.tracks[0].track.codecConfig, current.tracks[0].track.codecConfig);
        assert.deepEqual(payloads(legacy.tracks[0].packets), frames);
        assert.deepEqual(payloads(current.tracks[0].packets), frames);
    });

    test('skips an ID3v2 tag in front of the stream', async () => {
        const id3 = concat(ascii('ID3'), [3, 0, 0, 0, 0, 0, 10], new Uint8Array(10));
        assert.deepEqual(payloads(await allPackets(concat(id3, oggFlac()))), flacParts().frames);
    });

    test('writes a selected one of two multiplexed Opus streams', async () => {
        const input = FIXTURES['twoopus.ogg'].bytes();
        const source = await readMedia(input);
        const second = source.tracks[1];
        const { tracks } = await readMedia(
            await copied(input, 'ogg', { trackIds: [second.track.id] }),
        );
        assert.equal(tracks.length, 1);
        assert.deepEqual(payloads(tracks[0].packets), payloads(second.packets));
    });

    test('an Ogg copy holds one audio stream and reports the others dropped', async () => {
        const input = FIXTURES['twoopus.ogg'].bytes();
        const source = await readMedia(input);
        const result = await convert(input, { to: 'ogg', copy: true, onWarning: () => {} });
        assert.deepEqual(
            result.warnings.map(warning => warning.code),
            ['TARGET_TRACKS_DROPPED'],
        );
        const { tracks } = await readMedia(result.blob);
        assert.equal(tracks.length, 1);
        assert.deepEqual(payloads(tracks[0].packets), payloads(source.tracks[0].packets));
    });

    describe('OGM and the Ogg video mappings', () => {
        const le = (value, bytes) => {
            const out = Buffer.alloc(bytes);
            for (let index = 0; index < bytes; index++)
                out[index] = Math.floor(value / 2 ** (8 * index)) & 255;
            return out;
        };
        const ogmHeader = (type, subtype, timeUnit, perUnit, tail) =>
            Buffer.concat([
                Buffer.from([1]),
                Buffer.from(type.padEnd(8, '\0'), 'latin1'),
                Buffer.from(subtype, 'latin1'),
                le(56, 4),
                le(timeUnit, 8),
                le(perUnit, 8),
                le(1, 4),
                le(0, 4),
                le(0, 2),
                le(0, 2),
                tail,
            ]);
        const comments = title =>
            Buffer.concat([
                Buffer.from('\x03vorbis'),
                le(0, 4),
                le(1, 4),
                le(6 + title.length, 4),
                Buffer.from(`TITLE=${title}`),
            ]);
        const vop = coding => Buffer.from([0, 0, 1, 0xb6, coding << 6, 0x11, 0x22, 0x33]);
        const page = (serial, sequence, packets, flags = 0, granule = 0) =>
            oggPage(packets, sequence, { serial, flags, granule });

        /** An OGM of MPEG-4 video, MP3 audio cut at byte counts and a text stream. */
        async function ogm() {
            const mp3 = (await allPackets(fixtures['mov-mp3.mov']()))
                .map(packet => packet.data)
                .slice(0, 3);
            const audio = Buffer.concat(mp3);
            const bytes = concat(
                page(
                    1,
                    0,
                    [ogmHeader('video', 'XVID', 400000, 1, Buffer.concat([le(64, 4), le(48, 4)]))],
                    2,
                ),
                page(
                    2,
                    0,
                    [
                        ogmHeader(
                            'audio',
                            '0055',
                            10000000,
                            32000,
                            Buffer.concat([le(1, 2), le(0, 2), le(4000, 4)]),
                        ),
                    ],
                    2,
                ),
                page(3, 0, [ogmHeader('text', '\0\0\0\0', 10000, 1, Buffer.alloc(8))], 2),
                page(1, 1, [comments('OGM')]),
                page(2, 1, [comments('')]),
                page(3, 1, [comments('')]),
                // Keyframe flag 0x08; the frame period is the stream's default duration.
                page(
                    1,
                    2,
                    [
                        Buffer.concat([Buffer.from([0x08]), vop(0)]),
                        Buffer.concat([Buffer.from([0]), vop(1)]),
                    ],
                    0,
                    1,
                ),
                // Audio cut at byte counts, with one duration byte (0x40): the frames are
                // reassembled.
                page(
                    2,
                    2,
                    [Buffer.concat([Buffer.from([0x40, 200]), audio.subarray(0, 200)])],
                    0,
                    0,
                ),
                page(
                    2,
                    3,
                    [Buffer.concat([Buffer.from([0x40, 232]), audio.subarray(200)])],
                    4,
                    200,
                ),
                // Text with two duration bytes (0x80) and the keyframe flag, at the page
                // granule (ms).
                page(
                    3,
                    2,
                    [Buffer.concat([Buffer.from([0x88]), le(1500, 2), Buffer.from('Hello')])],
                    4,
                    500,
                ),
                page(1, 3, [Buffer.concat([Buffer.from([0]), vop(1)])], 4, 2),
            );
            return { bytes, mp3 };
        }

        test('reads the video, audio and text streams of an OGM and its title', async () => {
            const { bytes, mp3 } = await ogm();
            const { title, tracks } = await readMedia(bytes);
            assert.equal(title, 'OGM');
            assert.deepEqual(
                tracks.map(({ track }) => [
                    track.type,
                    track.codec,
                    track.width ?? 0,
                    track.sampleRate ?? 0,
                ]),
                [
                    ['video', 'mp4v.20.9', 64, 0],
                    ['audio', 'mp3', 0, 32000],
                    ['subtitle', 'text/utf8', 0, 0],
                ],
            );
            assert.deepEqual(
                tracks[0].packets.map(packet => [
                    packet.timestamp,
                    packet.isKeyframe,
                    packet.data.length,
                ]),
                [
                    [0, true, 8],
                    [0.04, false, 8],
                    [0.08, false, 8],
                ],
            );
            assert.deepEqual(
                tracks[1].packets.map(packet => [
                    Math.round(packet.timestamp * 32000),
                    packet.data,
                ]),
                mp3.map((frame, index) => [index * 1152, frame]),
            );
            assert.deepEqual(
                tracks[2].packets.map(packet => [
                    packet.timestamp,
                    packet.duration,
                    Buffer.from(packet.data).toString(),
                ]),
                [[0.5, 1.5, 'Hello']],
            );
        });

        test('a Vorbis stream without a TITLE keeps the title another stream gave', async () => {
            const ogmPages = oggPages((await ogm()).bytes);
            const vorbis = oggPages(fixtures['ogg-vorbis-pages.ogg']());
            const { title, tracks } = await readMedia(
                oggJoin([ogmPages[0], vorbis[0], ogmPages[3], ...vorbis.slice(1), ogmPages[10]]),
            );
            assert.equal(title, 'OGM');
            assert.deepEqual(
                tracks.map(({ track }) => track.codec),
                ['mp4v.20.9', 'vorbis'],
            );
        });

        /** VP8 in Ogg: the upper 32 bits of a granule count the frames to the end of the page. */
        const vp8File = serial =>
            concat(
                page(
                    serial,
                    0,
                    [
                        Buffer.concat([
                            Buffer.from('OVP80\x01\x01\x00', 'latin1'),
                            Buffer.from([0, 16, 0, 16, 0, 0, 1, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1]),
                        ]),
                    ],
                    2,
                ),
                page(
                    serial,
                    1,
                    [Buffer.from([0x10, 1, 2]), Buffer.from([0x11, 3])],
                    0,
                    2 * 2 ** 32,
                ),
                page(serial, 2, [Buffer.from([0x11, 4, 5, 6])], 4, 3 * 2 ** 32),
            );

        test('reads VP8 in Ogg, bit 0 of a frame marking it inter', async () => {
            const { tracks } = await readMedia(vp8File(5));
            const { track, packets } = tracks[0];
            assert.deepEqual([track.codec, track.width, track.height], ['vp8', 16, 16]);
            assert.deepEqual(
                packets.map(packet => [
                    Math.round(packet.timestamp * 30),
                    packet.isKeyframe,
                    packet.data.length,
                ]),
                [
                    [0, true, 3],
                    [1, false, 2],
                    [2, false, 4],
                ],
            );
        });

        test('a zero-length Theora packet repeats the frame before and lengthens it', async () => {
            const id = Buffer.alloc(42);
            id.write('\x80theora', 'latin1');
            id.set([3, 2, 1, 0, 1, 0, 1, 0, 0, 16, 0, 0, 16, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1], 7);
            id[41] = 6 << 5;
            const packets = await allPackets(
                concat(
                    page(7, 0, [id], 2),
                    page(7, 1, [
                        Buffer.concat([Buffer.from('\x81theora', 'latin1'), Buffer.alloc(8)]),
                        Buffer.from('\x82theora\x00', 'latin1'),
                    ]),
                    page(
                        7,
                        2,
                        [Buffer.from([0x00, 1]), Buffer.alloc(0), Buffer.from([0x40, 2])],
                        4,
                        (1 << 6) | 2,
                    ),
                ),
            );
            assert.deepEqual(
                packets.map(packet => [packet.timestamp, packet.duration, packet.isKeyframe]),
                [
                    [0, 0.4, true],
                    [0.4, 0.2, false],
                ],
            );
        });

        test('a second chain link of a video file is not read, and a warning says so', async () => {
            const { tracks, warnings } = await readMedia(concat(vp8File(5), vp8File(6)));
            assert.equal(tracks[0].packets.length, 3);
            assert.deepEqual(warnings, ['OGG_CHAIN_IGNORED']);
        });
    });

    test('Speex whose look-ahead starts it before zero keeps that timeline', async () => {
        // The first audio page's granule places its packets; it is not damage.
        const speex = FIXTURES['speex.ogg'].bytes();
        const [bos, comments] = oggPages(speex);
        const serial = new DataView(bos.buffer, bos.byteOffset).getUint32(14, true);
        const packets = (await allPackets(speex)).map(packet => packet.data);
        const split = oggJoin([
            bos,
            comments,
            oggPage(packets.slice(0, 10), 2, { serial, granule: 10 * 160 - 40 }),
            oggPage(packets.slice(10), 3, { serial, flags: 4, granule: packets.length * 160 - 40 }),
        ]);
        const { tracks, warnings } = await readMedia(split);
        assert.deepEqual(warnings, []);
        assert.deepEqual(
            tracks[0].packets.slice(0, 2).map(packet => packet.timestamp),
            [-0.005, 0.015],
        );
    });

    describe('FLAC and Vorbis', () => {
        // ffmpeg -f lavfi -i sine=f=440:r=22050:d=0.1 -af
        // "pan=5.1|c0=c0|c1=0.5*c0|c2=0.3*c0|c3=0.1*c0|c4=0.7*c0|c5=0.2*c0" -c:a flac -f ogg;
        // the digest is SHA-256 of `ffmpeg -i flac-5.1.oga -f s16le -c:a pcm_s16le -`.
        const oggFlac = () =>
            new Uint8Array(readFileSync(new URL('../fixtures/flac/flac-5.1.oga', import.meta.url)));
        const DIGEST = '056da329f6288b2ae472cbe8377641eb41a80f64625c0140d5022d6075533c29';
        /** The SHA-256 of the samples of `input` decoded to WAVE, its 5.1 layout checked. */
        async function wavDigest(input) {
            const wav = await bytesOf(await convert(input, 'wav', { copy: false }));
            const view = new DataView(wav.buffer);
            const chunks = new Map();
            for (let at = 12; at + 8 <= wav.length; at += 8 + view.getUint32(at + 4, true))
                chunks.set(String.fromCharCode(...wav.subarray(at, at + 4)), at + 8);
            const fmt = chunks.get('fmt ');
            // Six channels as WAVE_FORMAT_EXTENSIBLE with the FLAC 5.1 speaker mask.
            assert.equal(view.getUint16(fmt, true), 0xfffe);
            assert.equal(view.getUint16(fmt + 2, true), 6);
            assert.equal(view.getUint32(fmt + 20, true), 0x3f);
            const data = chunks.get('data');
            return sha256(wav.subarray(data, data + view.getUint32(data - 4, true)));
        }

        test('Ogg FLAC 5.1 decodes as FFmpeg decodes it', async () => {
            const { tracks } = await readMedia(oggFlac());
            assert.deepEqual(
                [tracks[0].track.codec, tracks[0].track.channelCount, tracks[0].track.sampleRate],
                ['flac', 6, 22050],
            );
            assert.equal(await wavDigest(oggFlac()), DIGEST);
        });

        for (const format of ['flac', 'mkv', 'mp4', 'm4a', 'ogg'])
            test(`Ogg FLAC frames copy into ${format} unchanged`, async () => {
                const source = payloads(await allPackets(oggFlac()));
                const copy = await copied(oggFlac(), format);
                const { tracks } = await readMedia(copy);
                assert.equal(tracks[0].track.codec, 'flac');
                assert.deepEqual(payloads(tracks[0].packets), source);
                assert.equal(await wavDigest(copy), DIGEST);
            });

        test('FLAC re-encoded into Ogg is lossless, its headers paged as mapped', async () => {
            // The first page holds the mapping header (0x7F 'FLAC', 'fLaC' and the STREAMINFO)
            // alone, the VORBIS_COMMENT block follows at granule 0, and the last page ends at the
            // length of the sound.
            const reencoded = await bytesOf(
                await convert(oggFlac(), { to: 'ogg', copy: false, audio: { codec: 'flac' } }),
            );
            assert.equal(await wavDigest(reencoded), DIGEST);
            const pages = [];
            for (let at = 0; at < reencoded.length;) {
                const segments = reencoded[at + 26];
                const size = reencoded
                    .subarray(at + 27, at + 27 + segments)
                    .reduce((a, b) => a + b, 0);
                pages.push({
                    flags: reencoded[at + 5],
                    granule: new DataView(reencoded.buffer, at + 6, 8).getBigInt64(0, true),
                    body: reencoded.subarray(at + 27 + segments, at + 27 + segments + size),
                });
                at += 27 + segments + size;
            }
            assert.equal(String.fromCharCode(...pages[0].body.subarray(0, 5)), '\x7fFLAC');
            assert.deepEqual([pages[0].flags, pages[0].body.length], [2, 51]);
            assert.deepEqual([pages[1].body[0], pages[1].granule], [0x84, 0n]);
            assert.deepEqual([pages.at(-1).flags, pages.at(-1).granule], [4, 2205n]);
        });

        for (const [range, frames] of [
            [{ start: 0.25 }, 11968],
            [{ end: 0.25 }, 11872],
            [{ start: 0.1, end: 0.3 }, 9472],
        ])
            test(`a Vorbis copy of ${JSON.stringify(range)} ends its granules there`, async () => {
                // Not at the length of the whole input.
                const source = VORBIS_FIXTURES.find(entry => entry.name === 'stereo-48000-q2');
                const copy = (await convert(source.bytes(), { to: 'ogg', ...range })).blob;
                const wav = (await convert(copy, 'wav')).blob;
                const media = await open(wav);
                media.close();
                assert.equal(Math.round(media.tracks[0].duration * 48000), frames);
            });
    });

    describe('Vorbis pages early encoders and damage left', () => {
        // Compatible reading keeps the coded timeline instead of rejecting the file.
        const pages = () => oggPages(fixtures['ogg-vorbis-pages.ogg']());
        const intact = () => readAll(fixtures['ogg-vorbis-pages.ogg']());

        test('the LANGUAGE comment is the language of the track', async () => {
            assert.equal((await intact()).tracks[0].language, 'eng');
        });

        test('an unstamped audio page keeps the coded timeline', async () => {
            const unstamped = pages();
            new DataView(unstamped[4].buffer).setBigInt64(6, -1n, true);
            const read = await readAll(oggJoin(unstamped));
            assert.ok(read.warnings.includes('OGG_GRANULE_MISSING'));
            assert.deepEqual(
                read.packets.map(packet => packet.timestamp),
                (await intact()).packets.map(packet => packet.timestamp),
            );
        });

        test('a missing page loses its packets, unless strict', async () => {
            // A stream recorded from its middle.
            const gap = pages();
            gap.splice(3, 1);
            const read = await readAll(oggJoin(gap));
            assert.ok(read.warnings.includes('OGG_PAGE_GAP'));
            assert.equal(read.packets.length, (await intact()).packets.length - 4);
            await rejectsStrict(oggJoin(gap));
        });

        test('a page repeated by damage is ignored, unless strict', async () => {
            // Its regressing granule rejected the file.
            const repeated = pages();
            repeated.splice(4, 0, repeated[3].slice());
            const read = await readAll(oggJoin(repeated));
            assert.ok(read.warnings.includes('OGG_PAGE_REPEATED'));
            assert.deepEqual(read.hashes, (await intact()).hashes);
            await rejectsStrict(oggJoin(repeated));
        });

        test('damage between the first page and the header pages is skipped', async () => {
            // Like damage between audio pages.
            const early = pages();
            early.splice(
                1,
                0,
                Uint8Array.from({ length: 300 }, (_, index) => (index * 37) & 0xff),
            );
            const read = await readAll(oggJoin(early));
            assert.ok(read.warnings.includes('OGG_RESYNCHRONIZED'));
            assert.deepEqual(read.hashes, (await intact()).hashes);
        });

        test('pages stamped at the start of their last packet keep the timeline', async () => {
            // Early muxers did so: where block sizes change, the granules run one packet behind
            // the decoded samples, and the packets keep the timeline they decode to.
            const music = VORBIS_FIXTURES.find(entry => entry.name === 'stereo-48000-q2').bytes();
            const coded = await readAll(music);
            const rate = coded.tracks[0].sampleRate;
            const [bos, headerPage] = oggPages(music);
            const serial = new DataView(bos.buffer).getUint32(14, true);
            const audioPackets = coded.packets.slice(0, 30);
            const repaginate = stamp => {
                let frames = 0;
                return oggJoin([
                    bos,
                    headerPage,
                    ...audioPackets.map((packet, index) => {
                        const before = frames;
                        if (index) frames += Math.round(packet.duration * rate);
                        const flags = index === audioPackets.length - 1 ? 4 : 0;
                        return oggPage([packet.data], index + 2, {
                            serial,
                            flags,
                            granule: stamp(before, frames),
                        });
                    }),
                ]);
            };
            const endStamped = repaginate((before, after) => after);
            const startStamped = repaginate(before => before);
            const [ends, starts] = [await readAll(endStamped), await readAll(startStamped)];
            assert.deepEqual(ends.warnings, []);
            assert.deepEqual(starts.warnings, ['OGG_VORBIS_START_GRANULES']);
            const timing = read => read.packets.map(packet => [packet.timestamp, packet.duration]);
            assert.deepEqual(timing(starts), timing(ends));
            assert.deepEqual(
                (await decodedWave(startStamped, 1)).bytes,
                (await decodedWave(endStamped, 1)).bytes,
            );
        });

        test('a copy of packets timed back into their predecessors keeps going', async () => {
            // A source that followed a damaged page's granule backwards: the copy continues the
            // granule timeline instead of failing.
            const source = await intact();
            const [track] = source.tracks;
            const sink = new MemorySink();
            const muxer = new VorbisMuxer(sink, {
                codec: 'vorbis',
                codecConfig: track.codecConfig,
                sampleRate: track.sampleRate,
                channelCount: track.channelCount,
            });
            for (const [index, packet] of source.packets.entries())
                await muxer.addAudioChunk({
                    trackType: 'audio',
                    data: packet.data,
                    timestamp: packet.timestamp - (index >= 10 ? 0.1 : 0),
                    duration: packet.duration,
                    isKeyframe: true,
                });
            await muxer.finalize();
            assert.deepEqual(
                (await readAll(sink.toUint8Array())).packets.map(packet => packet.timestamp),
                source.packets.map(packet => packet.timestamp),
            );
        });

        test('header pages of an unknown granule read as stamped ones', async () => {
            // ogmtools stamped the header pages after the first so.
            const headerGranule = pages();
            new DataView(headerGranule[1].buffer).setBigInt64(6, -1n, true);
            const read = await readAll(oggJoin(headerGranule));
            assert.deepEqual(read.warnings, ['OGG_HEADER_GRANULE']);
            assert.deepEqual(read.hashes, (await intact()).hashes);
        });

        test('after a dropped page, the rest of a packet it began times nothing', async () => {
            const orphan = pages();
            const rest = oggPage([Uint8Array.of(1, 2, 3, 4, 5)], 4, {
                flags: 1,
                granule: 1792,
                serial: 3749587108,
            });
            for (const page of orphan.slice(4)) {
                const view = new DataView(page.buffer);
                view.setUint32(18, view.getUint32(18, true) + 1, true);
            }
            const orphaned = oggJoin([...orphan.slice(0, 4), rest, ...orphan.slice(4)]);
            orphaned[orphan[0].length + orphan[1].length + orphan[2].length + 40] ^= 0xff;
            const read = await readAll(orphaned);
            assert.ok(read.warnings.includes('OGG_PAGE_CRC'), read.warnings.join());
            assert.equal(read.packets.length, (await intact()).packets.length - 4);
        });
    });

    describe('tags of an encoded stream', () => {
        // One AAC frame in Matroska, read through a plugin reader that gives it file tags, a cover
        // and the Finnish language, then encoded as FLAC in Ogg.
        const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
        async function encodedOgg() {
            const frame = (
                await encodeAacLc([new Float32Array(1024)], { sampleRate: 48000, bitrate: 64 })
            ).frames[0];
            const aac = {
                id: 1,
                type: 'audio',
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: Uint8Array.of(0x11, 0x88),
            };
            const sink = new MemorySink();
            const muxer = new WebMMuxer({ format: 'mkv', mode: 'standard', audio: aac }, sink);
            const sample = { data: frame, timestamp: 0, duration: 1024 / 48000, isKeyframe: true };
            muxer.addAudioChunk({ ...sample, trackType: 'audio' });
            await muxer.finalize();
            const tags = {
                entries: [
                    { key: 'title', value: 'Song' },
                    { key: 'artist', value: 'Artist' },
                    { key: 'albumArtist', value: 'Band' },
                    { key: 'date', value: '1999' },
                ],
                chapters: [
                    { start: 0, end: 0.01, title: 'Intro' },
                    { start: 0.01, title: 'Rest' },
                ],
                pictures: [{ data: PNG, mimeType: 'image/png', type: 3 }],
            };
            const reader = readerPart({
                formats: ['mkv'],
                read: async () => ({
                    duration: 1024 / 48000,
                    videoTracks: [],
                    audioTracks: [
                        {
                            ...aac,
                            width: 0,
                            height: 0,
                            duration: 1024 / 48000,
                            language: 'fin',
                            samples: [{ ...sample, offset: 0, size: frame.length }],
                        },
                    ],
                    tags,
                }),
            });
            const { blob, warnings } = await convert(sink.toBlob(), 'ogg', {
                plugins: { add: [{ name: 'tagged', readers: [reader] }] },
                audio: { codec: 'flac' },
            });
            return { bytes: new Uint8Array(await blob.arrayBuffer()), warnings };
        }
        const latin = bytes => Buffer.from(bytes).toString('latin1');

        test('carries the tags, chapters, cover and language in its comment header', async () => {
            // As a copied stream does; they used to be left out without a warning.
            const { bytes, warnings } = await encodedOgg();
            for (const field of [
                'TITLE=Song',
                'ARTIST=Artist',
                'ALBUMARTIST=Band',
                'DATE=1999',
                'CHAPTER002NAME=Rest',
                'METADATA_BLOCK_PICTURE=',
                'LANGUAGE=fin',
            ])
                assert.ok(latin(bytes).includes(field), field);
            assert.ok(!warnings.some(({ code }) => /LANGUAGE/.test(code)));
            assert.equal((await readMedia(bytes)).tracks[0].track.language, 'fin');
        });

        test('a copy through Matroska back into Ogg keeps the LANGUAGE comment', async () => {
            const { bytes } = await encodedOgg();
            const mka = await copied(bytes, 'mkv');
            const result = await convert(mka, 'ogg', { copy: true });
            assert.deepEqual(
                result.plan.tracks.map(planned => planned.action),
                ['copy'],
            );
            assert.ok(latin(await bytesOf(result)).includes('LANGUAGE=fin'));
        });

        test('copied into FLAC, the cover of the comments stays one picture', async () => {
            // It is not written again as a PICTURE block.
            const { bytes } = await encodedOgg();
            const flac = await copied(bytes, 'flac');
            // The metadata blocks after fLaC: a type byte (the last block's top bit set) and a
            // 24-bit length each.
            const types = [];
            for (let at = 4, last = false; !last;) {
                last = (flac[at] & 0x80) !== 0;
                types.push(flac[at] & 0x7f);
                at += 4 + ((flac[at + 1] << 16) | (flac[at + 2] << 8) | flac[at + 3]);
            }
            const comments = latin(flac).split('METADATA_BLOCK_PICTURE=').length - 1;
            assert.equal(types.filter(type => type === 6).length + comments, 1);
        });
    });
});
