import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, MediaForgeError, convert, open } from 'mediaforgejs';
import { MediaForge as LiteForge } from 'mediaforgejs/lite';
import { detectFormat, detectSourceFormat } from 'mediaforgejs/formats';
import * as plugins from 'mediaforgejs/plugins';
import {
    AAC_PAYLOADS,
    adtsFixture,
    adtsFrame,
    aviFixture,
    concat,
    flacFixture,
    mpegAudioFixture,
    tsFixture,
    waveFixture,
} from './helpers/original-fixtures.mjs';
import { ac3Frame, programStream } from './helpers/mpeg-video-fixtures.mjs';
import { dtsCore } from './helpers/sync-audio-fixtures.mjs';
import { apvStream, iamfSequence } from './helpers/new-format-fixtures.mjs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { Mp4Demuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { readerPart } from './helpers/parts.mjs';

// The library's formats as a whole: which format a file's first bytes name, the formats each entry
// reads and writes with its plugins, and the tags each writer keeps.

const ascii = text => Uint8Array.from(text, character => character.charCodeAt(0));
const u32be = value =>
    Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value);
const pad = (bytes, length = 64) =>
    concat(bytes, new Uint8Array(Math.max(0, length - bytes.length)));
/** An ISO box of `type` around `payload`. */
const box = (type, payload = new Uint8Array(0)) =>
    concat(u32be(8 + payload.length), ascii(type), payload);
/** A PNG chunk; detection does not check its CRC. */
const pngChunk = (type, body) => concat(u32be(body.length), ascii(type), body, new Uint8Array(4));
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const IHDR = pngChunk('IHDR', new Uint8Array(13));
const riff = form => concat(ascii('RIFF'), new Uint8Array(4), ascii(form));
const ebml = docType => concat(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), ascii(`....B\x82${docType}`));
const ftyp = (...brands) =>
    box('ftyp', concat(ascii(brands[0]), new Uint8Array(4), ...brands.map(ascii)));
const ASF_HEADER = Uint8Array.of(
    0x30,
    0x26,
    0xb2,
    0x75,
    0x8e,
    0x66,
    0xcf,
    0x11,
    0xa6,
    0xd9,
    0x00,
    0xaa,
    0x00,
    0x62,
    0xce,
    0x6c,
);
const MXF_PARTITION = Uint8Array.of(
    0x06,
    0x0e,
    0x2b,
    0x34,
    0x02,
    0x05,
    0x01,
    0x01,
    0x0d,
    0x01,
    0x02,
    0x01,
    0x01,
    0x02,
    0x04,
    0x00,
);
/** An ID3v2.4 tag holding the title `title`. */
function id3Title(title) {
    const syncsafe = n => Uint8Array.of((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
    const text = concat([3], ascii(title));
    const frame = concat(ascii('TIT2'), syncsafe(text.length), [0, 0], text);
    return concat(ascii('ID3'), [4, 0, 0], syncsafe(frame.length), frame);
}
/** A source of `bytes` that reads only what it is asked for. */
const sourceOf = bytes => ({
    size: bytes.length,
    read: async (offset, length) => bytes.slice(offset, offset + length),
});

const SIGNATURES = [
    ['a RIFF WAVE header', riff('WAVEfmt '), 'wav'],
    ['an RF64 WAVE header', concat(ascii('RF64'), new Uint8Array(4), ascii('WAVEds64')), 'wav'],
    ['a RIFF WEBP header', riff('WEBPVP8 '), 'webp'],
    ['a RIFF AVI header', riff('AVI LIST'), 'avi'],
    ['an EBML header naming Matroska', ebml('\x88matroska'), 'mkv'],
    ['an EBML header naming WebM', ebml('\x84webm'), 'webm'],
    ['an ISO file type box', ftyp('isom', 'avc1'), 'mp4'],
    ['a QuickTime file type box', ftyp('qt  '), 'mov'],
    ['an M4A file type box', ftyp('M4A ', 'mp42'), 'm4a'],
    ['an M4V file type box', ftyp('M4V ', 'mp42'), 'm4v'],
    ["an M4V file type box of Apple's players", ftyp('M4VH', 'M4V '), 'm4v'],
    ['a 3GPP file type box', ftyp('3gp6', 'isom'), '3gp'],
    ['an AVIF file type box', ftyp('avif', 'mif1'), 'avif'],
    ['a HEIF file type box', ftyp('heic', 'mif1'), 'heif'],
    ['a QuickTime movie box with no file type box', box('moov'), 'mp4'],
    [
        'free space ahead of the media data',
        concat(box('free', new Uint8Array(8)), box('mdat')),
        'mp4',
    ],
    ['an AIFF form', concat(ascii('FORM'), new Uint8Array(4), ascii('AIFFCOMM')), 'aiff'],
    ['an AIFF-C form', concat(ascii('FORM'), new Uint8Array(4), ascii('AIFCFVER')), 'aiff'],
    ['a Sun audio header', ascii('.snd'), 'au'],
    ['a Core Audio header', ascii('caff'), 'caf'],
    ['a FLAC stream marker', ascii('fLaC'), 'flac'],
    ['an Ogg page', ascii('OggS'), 'ogg'],
    ['an FLV header', ascii('FLV\x01'), 'flv'],
    ['an IVF header', ascii('DKIF'), 'ivf'],
    ['an ASF header object', ASF_HEADER, 'asf'],
    ['an MXF header partition', MXF_PARTITION, 'mxf'],
    ['an MXF header partition after a run-in', concat(new Uint8Array(20), MXF_PARTITION), 'mxf'],
    ['an IAMF sequence header', iamfSequence().raw, 'iamf'],
    ['an APV access unit', apvStream().raw, 'apv'],
    ['a PNG signature', concat(PNG_SIGNATURE, IHDR), 'png'],
    [
        'a PNG whose animation control comes before its image data',
        concat(PNG_SIGNATURE, IHDR, pngChunk('acTL', new Uint8Array(8))),
        'apng',
    ],
    ['a JPEG start of image', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), 'jpeg'],
    ['a GIF header', ascii('GIF89a'), 'gif'],
    ['a BMP header', ascii('BM'), 'bmp'],
    ['a little-endian TIFF header', Uint8Array.of(0x49, 0x49, 0x2a, 0), 'tiff'],
    ['a big-endian TIFF header', Uint8Array.of(0x4d, 0x4d, 0, 0x2a), 'tiff'],
    [
        'an icon directory',
        Uint8Array.of(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0, 22, 0),
        'ico',
    ],
    [
        'a JPEG XL container',
        Uint8Array.of(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
        'jxl',
    ],
    ['a JPEG XL codestream', Uint8Array.of(0xff, 0x0a), 'jxl'],
    ['an ADTS frame header', Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc), 'aac'],
    ['an MP3 frame header', mpegAudioFixture(3), 'mp3'],
    ['an MPEG audio layer II frame header', mpegAudioFixture(2), 'mp2'],
];

/** The frames of a FLAC stream without its marker and metadata, after the end of another frame. */
const headerlessFlac = () => {
    const bytes = flacFixture();
    const first = bytes.findIndex((byte, at) => byte === 0xff && bytes[at + 1] === 0xf8);
    return concat([0x12, 0x34], bytes.subarray(first));
};

/** ADTS frames of MPEG-2 AAC, whose headers start like FLAC frame headers (0xFFF9). */
const mpeg2Adts = () =>
    concat(
        ...AAC_PAYLOADS.map(payload => {
            const frame = adtsFrame(payload);
            frame[1] = 0xf9;
            return frame;
        }),
    );

const STREAMS = [
    ['an MPEG transport stream', tsFixture(), 'ts'],
    [
        'an MPEG program stream',
        programStream([{ streamId: 0xc0, payload: mpegAudioFixture(2), pts: 0 }]),
        'mpeg',
    ],
    ['AC-3 frames', concat(ac3Frame(1), ac3Frame(2)), 'ac3'],
    ['DTS core frames', concat(dtsCore({ fill: 1 }), dtsCore({ fill: 2 })), 'dts'],
    ['ADTS frames that start inside a frame', concat([0x12, 0x34], adtsFixture()), 'aac'],
    ['MP3 frames that start inside a frame', concat([0x12, 0x34], mpegAudioFixture(3)), 'mp3'],
    ['FLAC frames that start inside a frame', headerlessFlac(), 'flac'],
    // FLAC frame headers start with the bytes of MPEG-2 ADTS headers.
    ['FLAC frames from a fixed-blocking frame header', flacFixture().subarray(42), 'flac'],
    [
        'FLAC frames from a variable-blocking frame header',
        flacFixture({ variable: true }).subarray(42),
        'flac',
    ],
    ['MPEG-2 ADTS frames', mpeg2Adts(), 'aac'],
];

describe('formats', () => {
    describe('detection from the first bytes', () => {
        for (const [label, bytes, format] of SIGNATURES)
            test(`${label} is ${format}`, () => {
                assert.equal(detectFormat(pad(bytes)), format);
            });

        for (const [label, bytes, format] of STREAMS)
            test(`${label} without a signature are ${format}`, () => {
                assert.equal(detectFormat(bytes), format);
            });

        test('bytes of no format fail with DEMUX', () => {
            assert.throws(() => detectFormat(new Uint8Array(64)), {
                code: 'DEMUX',
                message: /Unable to detect file format/,
            });
        });

        test('MPEG-4 Part 2 video is not taken for an icon, whose first bytes it shares', () => {
            // A video object start code, then the video object layer start code where an icon has
            // its first directory entry.
            const m4v = Uint8Array.of(
                ...[0, 0, 1, 0, 0, 0, 1, 0x20, 7, 0xa1, 0xe5, 0x50, 0xb4, 0x20, 0xf0, 0x45],
                ...[0x40, 0, 0x40, 0, 0x40, 0, 0x40, 0, 0x80, 0, 0xc0, 0, 0, 1, 0xb3, 0xff],
            );
            assert.throws(() => detectFormat(pad(m4v)), { code: 'DEMUX' });
        });

        test('a Matroska header that names no doctype is WebM', () => {
            assert.equal(detectFormat(pad(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3))), 'webm');
        });

        test('an AVIF brand among the compatible brands makes an ISO file AVIF', () => {
            assert.equal(detectFormat(pad(ftyp('mif1', 'miaf', 'avif'))), 'avif');
        });

        test('ADTS headers that also read as FLAC frame headers are ADTS by their sequence', () => {
            // 44.1 kHz stereo AAC-LC frames of a length whose low bits, with the buffer fullness,
            // make the sixth header byte the CRC-8 a FLAC frame header ends with there.
            const crc8 = bytes =>
                bytes.reduce((crc, byte) => {
                    crc ^= byte;
                    for (let bit = 0; bit < 8; bit++)
                        crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
                    return crc;
                }, 0);
            let length = 64;
            while (crc8([0xff, 0xf9, 0x50, 0x80, length >> 3]) >> 5 !== (length & 7)) length++;
            const head = [0xff, 0xf9, 0x50, 0x80, length >> 3];
            const frame = concat(head, [crc8(head), 0xfc], new Uint8Array(length - 7));
            assert.equal(detectFormat(concat(frame, frame, frame)), 'aac');
        });
    });

    describe('detection of a source', () => {
        test('ID3v2 tags ahead of MPEG audio frames are skipped', async () => {
            const tagged = concat(id3Title('Song'), mpegAudioFixture(3));
            assert.equal(await detectSourceFormat(sourceOf(tagged)), 'mp3');
        });

        test('frames after a damaged tag are found past the end the tag declares', async () => {
            // The tag's size lost part of its picture: the rest of the picture comes before the
            // frames, as ffmpeg finds them.
            const picture = Uint8Array.from({ length: 20000 }, (_, at) => (at * 73 + 11) & 0x7f);
            const damaged = concat(id3Title('Song'), picture, mpegAudioFixture(3));
            assert.equal(await detectSourceFormat(sourceOf(damaged)), 'mp3');
        });

        test('a tag longer than the source fails with DEMUX', async () => {
            const tag = id3Title('Song');
            await assert.rejects(detectSourceFormat(sourceOf(tag.subarray(0, 14))), {
                code: 'DEMUX',
                message: /Truncated ID3v2 tag/,
            });
        });

        test('a source without read() is an invalid argument (INPUT)', async () => {
            await assert.rejects(detectSourceFormat({ size: 10 }), { code: 'INPUT' });
        });

        test('a PNG whose animation control lies past the first bytes is APNG', async () => {
            const png = concat(
                PNG_SIGNATURE,
                IHDR,
                pngChunk('tEXt', new Uint8Array(10_000)),
                pngChunk('acTL', new Uint8Array(8)),
            );
            assert.equal(detectFormat(png.subarray(0, 8192)), 'png');
            assert.equal(await detectSourceFormat(sourceOf(png)), 'apng');
        });

        test('MP4 boxes that reach the movie box past the first bytes are MP4', async () => {
            const movie = concat(box('free', new Uint8Array(10_000)), box('moov'));
            assert.throws(() => detectFormat(movie.subarray(0, 8192)), { code: 'DEMUX' });
            assert.equal(await detectSourceFormat(sourceOf(movie)), 'mp4');
        });

        test('a first box with an overwritten type counts if it leads to a movie box', async () => {
            const media = concat(u32be(24), Uint8Array.of(1, 2, 3, 4), new Uint8Array(16));
            assert.equal(await detectSourceFormat(sourceOf(concat(media, box('moov')))), 'mp4');
        });

        test('an MXF run-in longer than the first bytes is MXF', async () => {
            const mxf = concat(new Uint8Array(9000), MXF_PARTITION, new Uint8Array(64));
            assert.equal(await detectSourceFormat(sourceOf(mxf)), 'mxf');
        });

        test('an aborted signal stops the detection', async () => {
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                detectSourceFormat(sourceOf(pad(ascii('fLaC'))), controller.signal),
                error => error instanceof MediaForgeError && error.code === 'ABORT',
            );
        });
    });

    describe('plugins', () => {
        test("each format plugin's signature has its place among the library's", () => {
            const places = Object.fromEntries(
                Object.values(plugins)
                    .flatMap(plugin => plugin?.readers ?? [])
                    .filter(reader => reader.sniff)
                    .map(reader => [reader.id, reader.priority]),
            );
            // AVI (42) after WAVE (40) and WebP (41): all three are RIFF forms.
            assert.deepEqual(places, {
                avi: 42,
                asf: 90,
                ivf: 100,
                iamf: 100,
                apv: 100,
                mxf: 110,
                flv: 130,
            });
        });

        test('a plugin format is detected without its plugin, and the error names it', async () => {
            await assert.rejects(new LiteForge().open(new Blob([aviFixture()])), error => {
                assert.equal(error.code, 'PLUGIN');
                assert.match(error.hint, /'avi' plugin/);
                return true;
            });
        });

        test("an application reader's priority places its sniff among the library's", async () => {
            const formatOf = async priority => {
                const reader = {
                    id: 'riffx',
                    formats: ['riffx'],
                    priority,
                    sniff: head => String.fromCharCode(...head.subarray(0, 4)) === 'RIFF',
                    load: async () => ({
                        read: async () => Promise.reject(new MediaForgeError('riffx', 'DEMUX')),
                    }),
                };
                const options = { plugins: { add: [{ name: 'riffx', readers: [reader] }] } };
                return open(new Blob([waveFixture()]), options).then(
                    media => {
                        media.close();
                        return media.format;
                    },
                    error => error.message,
                );
            };
            // WAVE is asked at 40.
            assert.equal(await formatOf(35), 'riffx');
            assert.equal(await formatOf(45), 'wav');
        });

        test('a reader priority that is not a number fails with INPUT', async () => {
            const reader = { id: 'x', formats: ['x'], priority: 'first', load: async () => ({}) };
            await assert.rejects(
                open(new Blob(), { plugins: { add: [{ name: 'x', readers: [reader] }] } }),
                { code: 'INPUT' },
            );
        });

        test('the lite entry reads and writes the core formats only', async () => {
            const { containers } = await new LiteForge().capabilities();
            assert.deepEqual(containers.read, [
                ...['3gp', 'aac', 'ac3', 'aiff', 'au', 'caf', 'dts', 'eac3', 'flac', 'm4a'],
                ...['m4v', 'mkv', 'mov', 'mp1', 'mp2', 'mp3', 'mp4', 'oga', 'ogg', 'ogv'],
                ...['opus', 'truehd', 'ts', 'wav', 'webm'],
            ]);
            assert.deepEqual(containers.write, [
                ...['3gp', 'aac', 'aiff', 'au', 'caf', 'flac', 'm4a', 'm4v', 'mkv', 'mov'],
                ...['mp1', 'mp2', 'mp3', 'mp4', 'ogg', 'ts', 'wav', 'webm'],
            ]);
        });

        test('the default entry adds the formats of its plugins', async () => {
            const { containers } = await new MediaForge().capabilities();
            for (const format of ['avi', 'flv', 'asf', 'wmv', 'mxf', 'mpeg', 'vob', 'ivf', 'obu'])
                assert.ok(containers.read.includes(format), format);
            for (const format of ['avi', 'flv', 'ivf', 'iamf', 'apv'])
                assert.ok(containers.write.includes(format), format);
        });

        test('excluding a plugin leaves its formats out', async () => {
            const forge = new MediaForge({ plugins: { exclude: ['avi'] } });
            const { containers } = await forge.capabilities();
            assert.equal(containers.read.includes('avi'), false);
            assert.equal(containers.write.includes('avi'), false);
            assert.ok(containers.read.includes('flv'));
        });
    });

    describe('kept tags', () => {
        const tagged = () => new Blob([concat(id3Title('Song'), mpegAudioFixture(3))]);
        const titleOf = async blob => {
            const media = await open(blob);
            media.close();
            return media.title;
        };

        // The input's frames carry no Xing or LAME header: reading it warns of the gapless data.
        const GAPLESS = [
            'MPEG_GAPLESS_METADATA',
            'No Xing/LAME gapless data; all coded frames are presented',
        ];
        for (const to of ['mkv', 'mp4', 'mp3', 'avi'])
            test(`${to} keeps the title of the file`, async () => {
                const result = await convert(tagged(), { to, copy: true, onWarning() {} });
                assert.deepEqual(
                    result.warnings.map(warning => [warning.code, warning.message]),
                    [GAPLESS],
                );
                assert.equal(await titleOf(result.blob), 'Song');
            });

        for (const to of ['ts'])
            test(`${to} keeps no tags, and copying into it reports the loss`, async () => {
                const result = await convert(tagged(), { to, copy: true, onWarning() {} });
                assert.deepEqual(
                    result.warnings.map(warning => [warning.code, warning.message]),
                    [
                        GAPLESS,
                        [
                            'CONTAINER_METADATA_LOSS',
                            `${to} cannot keep the container's tags (title)`,
                        ],
                    ],
                );
                assert.equal(await titleOf(result.blob), undefined);
            });
    });

    describe('tags a conversion writes', () => {
        // One AAC frame in Matroska, read through a plugin reader that gives it the file tags.
        const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
        const TAGS = {
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
        async function tagged(to) {
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
                            samples: [{ ...sample, offset: 0, size: frame.length }],
                        },
                    ],
                    tags: TAGS,
                }),
            });
            const plugins = { add: [{ name: 'tagged', readers: [reader] }] };
            const { blob, warnings } = await convert(sink.toBlob(), to, { plugins });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return { bytes, text: Buffer.from(bytes).toString('latin1'), warnings };
        }
        const lost = warnings => warnings.filter(({ code }) => code === 'CONTAINER_METADATA_LOSS');

        test('FLAC keeps the tags and chapters as comments and the picture', async () => {
            // A VORBIS_COMMENT block and a PICTURE block.
            const { text, warnings } = await tagged('flac');
            for (const field of ['TITLE=Song', 'ARTIST=Artist', 'ALBUMARTIST=Band', 'DATE=1999'])
                assert.ok(text.includes(field), field);
            assert.ok(text.includes('CHAPTER002=00:00:00.010'));
            assert.ok(text.includes('CHAPTER002NAME=Rest'));
            assert.ok(text.includes('image/png'));
            assert.deepEqual(lost(warnings), []);
        });

        test('MP3 keeps them in a leading ID3v2 tag', async () => {
            const { text } = await tagged('mp3');
            assert.ok(text.startsWith('ID3'));
            for (const frame of ['TIT2', 'TPE1', 'TPE2', 'CHAP', 'APIC'])
                assert.ok(text.includes(frame), frame);
        });

        test('WAV keeps the RIFF INFO fields and reports the rest lost', async () => {
            const { text, warnings } = await tagged('wav');
            for (const field of ['LIST', 'INFO', 'INAM', 'Song', 'IART', 'Artist', 'ICRD', '1999'])
                assert.ok(text.includes(field), field);
            assert.ok(
                lost(warnings).some(
                    ({ message }) => /albumArtist/.test(message) && /chapters/.test(message),
                ),
            );
        });

        test('M4A keeps the items, Nero chapters and the cover', async () => {
            const { bytes } = await tagged('m4a');
            const { tags } = await new Mp4Demuxer().demux(new Blob([bytes]));
            const sorted = entries => [...entries].sort((a, b) => a.key.localeCompare(b.key));
            assert.deepEqual(sorted(tags.entries), sorted(TAGS.entries));
            assert.deepEqual(
                tags.chapters.map(chapter => [chapter.start, chapter.title]),
                [
                    [0, 'Intro'],
                    [0.01, 'Rest'],
                ],
            );
            assert.deepEqual(tags.pictures[0].data, PNG);
        });
    });
});
