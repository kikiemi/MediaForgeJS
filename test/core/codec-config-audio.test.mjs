import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
    buildAacAsc,
    encodeMp3,
    isMp3InfoFrame,
    parseAdtsHeader,
    parseMp3FrameHeader,
} from 'mediaforgejs/codecs';
import { parseWaveFormat } from 'mediaforgejs/formats';
import { AC3_FIXTURES } from '../helpers/ac3-fixtures.mjs';
import { MP3_FIXTURES } from '../helpers/mp3-fixtures.mjs';
import { OPUS_FIXTURES } from '../helpers/opus-fixtures.mjs';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';
import {
    dts14,
    dtsCore,
    dtsLittleEndian,
    dtsSubstream,
    truehdUnit,
    XLL_SYNC,
} from '../helpers/sync-audio-fixtures.mjs';
import { trackPackets } from '../helpers/codec-contract.mjs';
import { withUnusedCodebook } from '../helpers/vorbis-setup.mjs';
import { tone } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const module = path => import(distUrl(`esm/core/codec-config/audio/${path}.js`));
const adts = await module('adts');
const { AacBitReader, decodeHuffman, huffmanCode } = await module('aac-bits');
const { SF_HUFF_BITS, SF_HUFF_CODES, SPECTRAL_BOOKS } = await module('aac-tables');
const mpeg = await module('mpeg-audio-header');
const dolby = await module('dolby-audio-header');
const { dolbyChannelMask } = await module('dolby-layout');
const dts = await module('dts-header');
const { parseTrueHdAccessUnit } = await module('truehd-header');
const opusHead = await module('opus-head');
const { opusPacketFrames } = await module('opus-packet');
const vorbis = await module('vorbis-headers');
const wave = await module('wave-format');
const { alacCookie, alacPacketFrames } = await module('alac-packet');

const aacFixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/aac/${name}`, import.meta.url)));
const named = (fixtures, name) => fixtures.find(entry => entry.name === name).bytes();
const stereo = await trackPackets(named(VORBIS_FIXTURES, 'stereo-48000-q2'));

/** MSB-first bits ('0'/'1' text, spaces ignored) as bytes, the last byte padded with zeros. */
function bitBytes(text) {
    const bits = text.replace(/\s+/g, '');
    return Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, index) =>
        parseInt(bits.slice(index * 8, index * 8 + 8).padEnd(8, '0'), 2),
    );
}

/** A 16-byte WAVE fmt payload. */
function fmt({ tag = 1, channels = 2, rate = 48000, bits = 16, byteRate } = {}) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    const align = channels * (bits / 8);
    view.setUint16(0, tag, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, rate, true);
    view.setUint32(8, byteRate ?? rate * align, true);
    view.setUint16(12, align, true);
    view.setUint16(14, bits, true);
    return bytes;
}

/** WAVE_FORMAT_EXTENSIBLE fmt with `subformat` (1 PCM, 3 float), `valid` bits and `mask`. */
function extensible({
    subformat = 1,
    channels = 6,
    rate = 48000,
    bits = 24,
    valid = bits,
    mask = 0x3f,
} = {}) {
    const bytes = new Uint8Array(40);
    bytes.set(fmt({ tag: 0xfffe, channels, rate, bits }));
    const view = new DataView(bytes.buffer);
    view.setUint16(16, 22, true);
    view.setUint16(18, valid, true);
    view.setUint32(20, mask, true);
    view.setUint32(24, subformat, true);
    view.setUint32(28, 0x00100000, true);
    view.setUint32(32, 0xaa000080, true);
    view.setUint32(36, 0x719b3800, true);
    return bytes;
}

describe('codec-config', () => {
    describe('ADTS', () => {
        const frames = [new Uint8Array(10).fill(1), new Uint8Array(20).fill(2)];
        const stream = adts.wrapAdts({ frames, sampleRate: 48000, channels: 2 });

        test('wraps raw AAC frames in seven-byte headers', () => {
            assert.equal(stream.length, 7 + 10 + 7 + 20);
            assert.deepEqual([...stream.subarray(0, 2)], [0xff, 0xf1]);
            assert.deepEqual(stream.subarray(7, 17), frames[0]);
        });

        test('reads a frame header; one raw block is stated as 0', () => {
            assert.deepEqual(adts.parseAdtsFrameHeader(stream, 17), {
                sampleRate: 48000,
                channels: 2,
                audioObjectType: 2,
                headerLength: 7,
                frameLength: 27,
                rawDataBlocks: 0,
            });
        });

        test('a CRC-protected header is nine bytes long', () => {
            const protectedFrame = stream.slice(0, 17);
            protectedFrame[1] &= 0xfe;
            assert.equal(adts.parseAdtsFrameHeader(protectedFrame).headerLength, 9);
        });

        test('refuses a missing sync word, a cut header and offsets outside', () => {
            assert.equal(adts.parseAdtsFrameHeader(Uint8Array.of(0xff, 0x00, 0, 0, 0, 0, 0)), null);
            assert.equal(adts.parseAdtsFrameHeader(stream.subarray(0, 6)), null);
            assert.equal(adts.parseAdtsFrameHeader(stream, -1), null);
            assert.equal(adts.parseAdtsFrameHeader(stream, 1.5), null);
        });

        test('slices a stream into its raw frames, skipping bytes between them', () => {
            assert.deepEqual(adts.sliceAdtsFrames(new Uint8Array([9, ...stream])), frames);
        });

        test('refuses frames of several raw data blocks with DEMUX', () => {
            const blocks = stream.slice();
            blocks[6] |= 1;
            assert.throws(() => adts.sliceAdtsFrames(blocks), { code: 'DEMUX' });
        });

        test('parseAdtsHeader finds the first frame after leading bytes', () => {
            assert.deepEqual(parseAdtsHeader(new Uint8Array([0, 1, 2, ...stream])), {
                sampleRate: 48000,
                channels: 2,
            });
            assert.equal(parseAdtsHeader(new Uint8Array(32)), null);
        });

        test('refuses rates and channel counts ADTS cannot state', () => {
            assert.throws(() => adts.wrapAdts({ frames, sampleRate: 44101, channels: 2 }), {
                code: 'ENCODE',
            });
            assert.throws(() => adts.wrapAdts({ frames, sampleRate: 48000, channels: 9 }), {
                code: 'ENCODE',
            });
        });
    });

    describe('AAC AudioSpecificConfig', () => {
        test('buildAacAsc writes the two-byte AAC-LC configuration', () => {
            assert.deepEqual([...buildAacAsc(44100, 2)], [0x12, 0x10]);
            assert.deepEqual([...buildAacAsc(48000, 1)], [0x11, 0x88]);
        });

        test('reads AAC-LC', () => {
            const parsed = adts.parseAacAudioSpecificConfig(Uint8Array.of(0x12, 0x10));
            assert.deepEqual(
                [
                    parsed.audioObjectType,
                    parsed.sampleRate,
                    parsed.channelCount,
                    parsed.samplesPerAccessUnit,
                ],
                [2, 44100, 2, 1024],
            );
            assert.deepEqual([parsed.sbr, parsed.ps], [-1, 0], 'SBR is left to the first frame');
            const mono = adts.parseAacAudioSpecificConfig(Uint8Array.of(0x11, 0x88));
            assert.deepEqual([mono.sbr, mono.ps], [-1, -1], 'a mono core may carry PS');
        });

        test('reads explicit HE-AAC: the SBR rate doubles the core rate', () => {
            // AOT 5, 24 kHz, stereo, extension 48 kHz, core AOT 2, GASpecificConfig.
            const parsed = adts.parseAacAudioSpecificConfig(
                bitBytes('00101 0110 0010 0011 00010 000'),
            );
            assert.deepEqual(
                [
                    parsed.audioObjectType,
                    parsed.coreAudioObjectType,
                    parsed.sampleRate,
                    parsed.coreSampleRate,
                ],
                [5, 2, 48000, 24000],
            );
            assert.deepEqual(
                [parsed.channelCount, parsed.sbr, parsed.samplesPerAccessUnit],
                [2, 1, 2048],
            );
        });

        test('reads explicit HE-AAC v2 as parametric stereo of a mono core', () => {
            // AOT 29, 24 kHz, mono core, extension 48 kHz, core AOT 2.
            const parsed = adts.parseAacAudioSpecificConfig(
                bitBytes('11101 0110 0001 0011 00010 000'),
            );
            assert.deepEqual(
                [parsed.audioObjectType, parsed.sbr, parsed.ps, parsed.channelCount],
                [29, 1, 1, 1],
            );
        });

        test('a sync extension after the core config signals SBR compatibly', () => {
            // AAC-LC 24 kHz stereo, then 0x2b7, extension type 5, SBR present, 48 kHz.
            const parsed = adts.parseAacAudioSpecificConfig(
                bitBytes('00010 0110 0010 000 01010110111 00101 1 0011'),
            );
            assert.deepEqual(
                [parsed.audioObjectType, parsed.sbr, parsed.sampleRate, parsed.extensionSampleRate],
                [2, 1, 48000, 48000],
            );
        });

        test('SBR stated at the core rate is left to the first frame', () => {
            const parsed = adts.parseAacAudioSpecificConfig(
                bitBytes('00010 0110 0010 000 01010110111 00101 1 0110'),
            );
            assert.deepEqual([parsed.sbr, parsed.sampleRate], [-1, 24000]);
        });

        test('960-sample frames switch explicit SBR off', () => {
            const parsed = adts.parseAacAudioSpecificConfig(
                bitBytes('00101 0110 0010 0011 00010 100'),
            );
            assert.deepEqual(
                [parsed.sbr, parsed.sampleRate, parsed.samplesPerAccessUnit],
                [0, 24000, 960],
            );
        });

        test('names the codec string by what the configuration signals', () => {
            assert.equal(adts.aacCodecString(Uint8Array.of(0x12, 0x10), 44100, 2), 'mp4a.40.2');
            assert.equal(
                adts.aacCodecString(bitBytes('00101 0110 0010 0011 00010 000'), 48000, 2),
                'mp4a.40.5',
            );
            assert.equal(
                adts.aacCodecString(bitBytes('11101 0110 0001 0011 00010 000'), 48000, 2),
                'mp4a.40.29',
            );
            assert.equal(adts.aacCodecString(new Uint8Array(0), 48000, 2), 'mp4a.40.2');
        });

        test('an empty configuration reads as nothing', () => {
            assert.equal(adts.parseAacAudioSpecificConfig(new Uint8Array(0)), null);
        });

        test('reads escaped object types: MPEG-1 Layer 3 in MP4 (32 + 2)', () => {
            // audioObjectType 31 escapes to 32 + 6 bits; 34 is Layer 3, at 44.1 kHz stereo.
            const parsed = adts.parseAacAudioSpecificConfig(bitBytes('11111 000010 0100 0010 000'));
            assert.deepEqual(
                [parsed.audioObjectType, parsed.sampleRate, parsed.channelCount],
                [34, 44100, 2],
            );
        });
    });

    describe('AAC prefix codes', () => {
        // The reader resolves several bits per lookup; it must read what a walk of the code bit by
        // bit reads: the same symbols ending at the same bits, and on a code no symbol has, or one
        // cut off by the end, the same error.
        function walk(bytes, codes, bits) {
            const symbols = new Map(
                Array.from(codes, (code, symbol) => [`${bits[symbol]}:${code}`, symbol]),
            );
            const prefixes = new Set();
            for (let symbol = 0; symbol < codes.length; symbol++)
                for (let length = 1; length <= bits[symbol]; length++)
                    prefixes.add(
                        `${length}:${Math.floor(codes[symbol] / 2 ** (bits[symbol] - length))}`,
                    );
            const read = [];
            let position = 0;
            for (;;) {
                let value = 0;
                for (let length = 1; ; length++) {
                    if (position >= bytes.length * 8)
                        return { read, error: 'AAC: bitstream exhausted' };
                    value = value * 2 + ((bytes[position >> 3] >> (7 - (position & 7))) & 1);
                    position++;
                    const symbol = symbols.get(`${length}:${value}`);
                    if (symbol !== undefined) {
                        read.push([symbol, position]);
                        break;
                    }
                    if (!prefixes.has(`${length}:${value}`))
                        return { read, error: 'AAC: invalid huffman code' };
                }
            }
        }
        function lookUp(bytes, code) {
            const reader = new AacBitReader(bytes);
            const read = [];
            for (;;) {
                try {
                    read.push([decodeHuffman(reader, code), reader.bitsRead()]);
                } catch (error) {
                    assert.equal(error.code, 'DECODE');
                    return { read, error: error.message };
                }
            }
        }
        // A code missing whole subtrees and with codes longer than one lookup.
        const sparse = {
            codes: [0b0, 0b10, 0b1100, 0b11010000000, 0b110100000011],
            bits: [1, 2, 4, 11, 12],
        };
        // A code where zero bits run into unknown codes, as the zeros past the end would.
        const zeros = { codes: [0b1, 0b011, 0b0101, 0b01001], bits: [1, 3, 4, 5] };

        test('every book reads what a bit-by-bit walk reads', () => {
            let state = 0x5eed1234;
            const random = limit => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state % limit;
            };
            const books = [
                { codes: SF_HUFF_CODES, bits: SF_HUFF_BITS },
                ...SPECTRAL_BOOKS.filter(Boolean).map(book => ({
                    codes: book.codes,
                    bits: book.bits,
                })),
                sparse,
                zeros,
            ];
            for (const { codes, bits } of books) {
                const code = huffmanCode(codes, bits);
                for (let round = 0; round < 40; round++) {
                    // Whole codes, then random bits ending in an unknown code or past the end.
                    const out = [];
                    for (let count = random(30); count > 0; count--) {
                        const symbol = random(codes.length);
                        for (let bit = bits[symbol] - 1; bit >= 0; bit--)
                            out.push(Math.floor(codes[symbol] / 2 ** bit) % 2);
                    }
                    for (let count = random(24); count > 0; count--) out.push(random(2));
                    const bytes = new Uint8Array(Math.ceil(out.length / 8));
                    out.forEach((bit, index) => (bytes[index >> 3] |= bit << (7 - (index & 7))));
                    assert.deepEqual(
                        lookUp(bytes, code),
                        walk(bytes, codes, bits),
                        `${codes.length} symbols`,
                    );
                }
            }
        });

        test('an unknown code within the bytes fails as an invalid code', () => {
            assert.deepEqual(
                lookUp(Uint8Array.of(0b11100000), huffmanCode(sparse.codes, sparse.bits)),
                {
                    read: [],
                    error: 'AAC: invalid huffman code',
                },
            );
        });

        test('a code cut off by the end fails as exhausted, not invalid', () => {
            const cut = lookUp(Uint8Array.of(0b11111110), huffmanCode(zeros.codes, zeros.bits));
            assert.deepEqual([cut.read.length, cut.error], [7, 'AAC: bitstream exhausted']);
        });
    });

    describe('MPEG audio frame headers', () => {
        test('reads MPEG-1 Layer III at 128 kbit/s, 44.1 kHz stereo', () => {
            assert.deepEqual(mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), 0), {
                format: 'mp3',
                sampleRate: 44100,
                channels: 2,
                bitrateKbps: 128,
                frameLength: 417,
                samplesPerFrame: 1152,
            });
        });

        test('the padding bit adds one byte, a slot of four in Layer I', () => {
            assert.equal(
                mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xfb, 0x92, 0x00), 0).frameLength,
                418,
            );
            const layer1 = mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xff, 0x92, 0x00), 0);
            const padded = mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xff, 0x90, 0x00), 0);
            assert.deepEqual([layer1.format, layer1.samplesPerFrame], ['mp1', 384]);
            assert.equal(layer1.frameLength - padded.frameLength, 4);
        });

        test('MPEG-2 and 2.5 halve the rate and the samples of Layer III', () => {
            const mpeg2 = mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xf3, 0x90, 0xc0), 0);
            assert.deepEqual(
                [mpeg2.sampleRate, mpeg2.samplesPerFrame, mpeg2.channels],
                [22050, 576, 1],
            );
            const mpeg25 = mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xe3, 0x90, 0xc0), 0);
            assert.deepEqual([mpeg25.sampleRate, mpeg25.samplesPerFrame], [11025, 576]);
        });

        test('Layer II is mp2 with 1152 samples', () => {
            const layer2 = mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xfd, 0x90, 0x00), 0);
            assert.deepEqual([layer2.format, layer2.samplesPerFrame], ['mp2', 1152]);
        });

        test('refuses free format, a bad bitrate and the reserved rate', () => {
            for (const third of [0x00, 0xf0, 0x9c])
                assert.equal(
                    mpeg.parseMpegAudioHeader(Uint8Array.of(0xff, 0xfb, third, 0x00), 0),
                    null,
                );
        });

        test('parseMp3FrameHeader is the public face of the same reader', () => {
            const header = parseMp3FrameHeader(Uint8Array.of(0, 0xff, 0xfb, 0x90, 0x00), 1);
            assert.deepEqual([header.sampleRate, header.frameLength], [44100, 417]);
        });

        test('offers the Layer II bitrates a channel count allows', () => {
            assert(mpeg.mpegBitrates('mp2', 1).every(rate => rate <= 192));
            assert(mpeg.mpegBitrates('mp2', 2).every(rate => rate >= 64));
            assert.equal(mpeg.mpegBitrates('mp3', 2).length, 14);
        });

        test('reads frames, bytes, delay and padding from a LAME Info frame', async () => {
            const entry = MP3_FIXTURES.find(fixture => fixture.name === 'mpeg1-44100-joint-64k');
            const bytes = entry.bytes();
            const first = bytes.indexOf(
                0xff,
                10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]),
            );
            const info = mpeg.parseMpegGaplessInfo(bytes.subarray(first));
            assert.equal(isMp3InfoFrame(bytes.subarray(first)), true);
            assert.deepEqual([info.frames, info.bytes], [40, 8567]);
            assert.equal(info.frames * 1152 - info.encoderDelay - info.padding, entry.sampleFrames);
        });

        test('the library MP3 encoder states its delay and padding the same way', async () => {
            const pcm = tone(44100, 1, 4410);
            const bytes = await encodeMp3([pcm], { sampleRate: 44100, bitrate: 64 });
            const info = mpeg.parseMpegGaplessInfo(bytes);
            assert.equal(info.frames * 1152 - info.encoderDelay - info.padding, 4410);
            assert.equal(info.encoderDelay, mpeg.MP3_ENCODER_DELAY);
        });

        test('an ID3v1 tag is the trailer, not a frame', () => {
            const tag = new Uint8Array(128);
            tag.set([0x54, 0x41, 0x47]);
            assert.equal(mpeg.isMpegAudioTrailerHeader(tag, 128), true);
            assert.equal(mpeg.isMpegAudioTrailerHeader(tag, 300), false);
        });
    });

    describe('AC-3 and E-AC-3 headers', () => {
        const stereo = named(AC3_FIXTURES, 'stereo-48000-96k');
        const surround71 = named(AC3_FIXTURES, '7.1-48000-288k');

        test('reads an AC-3 sync frame', () => {
            const header = dolby.parseDolbyFrameHeader(stereo, 0);
            assert.deepEqual(
                [
                    header.codec,
                    header.frameBytes,
                    header.sampleRate,
                    header.channels,
                    header.samples,
                ],
                ['ac-3', 384, 48000, 2, 1536],
            );
        });

        test('refuses a frame without the sync word or cut short', () => {
            assert.equal(dolby.parseDolbyFrameHeader(new Uint8Array(16), 0), null);
            assert.equal(dolby.parseDolbyFrameHeader(stereo.subarray(0, 6), 0), null);
        });

        test('a 7.1 E-AC-3 access unit holds an independent and a dependent frame', () => {
            const independent = dolby.parseDolbyFrameHeader(surround71, 0);
            const dependent = dolby.parseDolbyFrameHeader(surround71, independent.frameBytes);
            assert.deepEqual(
                [independent.codec, independent.streamType, dependent.streamType],
                ['ec-3', 0, 1],
            );
            assert.equal(
                dolby.dolbyAccessUnitChannels(
                    surround71.subarray(0, independent.frameBytes + dependent.frameBytes),
                ),
                8,
            );
        });

        test('dac3 and dec3 name the speakers of the stream', () => {
            assert.equal(dolbyChannelMask(dolby.ac3SpecificBox(stereo, 0), 'ac-3'), 0x3);
            const surround = named(AC3_FIXTURES, '5.1-48000-160k');
            assert.equal(dolbyChannelMask(dolby.ac3SpecificBox(surround, 0), 'ac-3'), 0x60f);
            const independent = dolby.parseDolbyFrameHeader(surround71, 0);
            const dependent = dolby.parseDolbyFrameHeader(surround71, independent.frameBytes);
            const unit = surround71.subarray(0, independent.frameBytes + dependent.frameBytes);
            assert.equal(dolbyChannelMask(dolby.eac3SpecificBox(unit), 'ec-3'), 0x63f);
        });
    });

    describe('DTS headers', () => {
        const core = dtsCore();

        test('recognizes the four stream forms of a core frame', () => {
            assert.equal(dts.dtsStreamForm(core, 0), 'be16');
            assert.equal(dts.dtsStreamForm(dtsLittleEndian(core), 0), 'le16');
            assert.equal(dts.dtsStreamForm(dts14(core), 0), 'be14');
            assert.equal(dts.dtsStreamForm(dts14(core, true), 0), 'le14');
            assert.equal(dts.dtsStreamForm(new Uint8Array(8), 0), null);
        });

        test('converts every form back to the 16-bit big-endian frame', () => {
            for (const form of ['le16', 'be14', 'le14']) {
                const stored =
                    form === 'le16' ? dtsLittleEndian(core) : dts14(core, form === 'le14');
                assert.deepEqual(
                    dts.dtsToBigEndian16(stored, form).subarray(0, core.length),
                    core,
                    form,
                );
            }
            assert.equal(dts.dtsStoredBytes(256, 'be14'), Math.ceil((256 * 8) / 14) * 2);
            assert.equal(dts.dtsStoredBytes(256, 'le16'), 256);
        });

        test('reads rate, channels and samples of a core frame', () => {
            const frame = dts.parseDtsFrame(core, 0);
            assert.deepEqual(
                [
                    frame.codec,
                    frame.frameBytes,
                    frame.sampleRate,
                    frame.channels,
                    frame.samples,
                    frame.lfe,
                ],
                ['dtsc', 256, 48000, 2, 512, false],
            );
            assert.equal(dts.parseDtsFrame(dtsCore({ amode: 9, lfe: 1 }), 0).channels, 6);
        });

        test('a core followed by an XLL substream is DTS-HD lossless (dtsl)', () => {
            const frame = dts.parseDtsFrame(
                new Uint8Array([...core, ...dtsSubstream({ sync: XLL_SYNC })]),
                0,
            );
            assert.equal(frame.codec, 'dtsl');
            assert.equal(frame.frameBytes, 256 + 64);
        });
    });

    describe('TrueHD headers', () => {
        test('reads the format of a major sync access unit', () => {
            // Channel mask bits: L/R, C, LFE, Ls/Rs.
            const unit = parseTrueHdAccessUnit(
                truehdUnit({ sampleRateCode: 1, channelMask: 0x0f }),
                0,
            );
            assert.equal(unit.bytes, 64);
            assert.deepEqual(unit.format, { sampleRate: 96000, channels: 6, samples: 80 });
        });

        test('a unit without major sync has a length and no format', () => {
            const unit = parseTrueHdAccessUnit(truehdUnit(), 0);
            assert.deepEqual([unit.bytes, unit.format], [64, undefined]);
            assert.equal(parseTrueHdAccessUnit(new Uint8Array(3), 0), null);
        });
    });

    describe('Opus headers', () => {
        const hybrid = named(OPUS_FIXTURES, 'hybrid-swb-voip-20ms');

        test('reads an OpusHead of mapping family 0', () => {
            const head = opusHead.parseOpusHead(hybrid.subarray(28, 47), 1);
            assert.deepEqual(
                [
                    head.channels,
                    head.preSkip,
                    head.inputSampleRate,
                    head.mappingFamily,
                    head.layout.streams,
                ],
                [1, 312, 48000, 0, 1],
            );
        });

        test('reads an MP4 dOps payload, big-endian, with its output gain', () => {
            const head = opusHead.parseOpusHead(
                Uint8Array.of(0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0xff, 0x00, 0),
                2,
            );
            assert.deepEqual(
                [
                    head.channels,
                    head.preSkip,
                    head.inputSampleRate,
                    head.outputGain,
                    head.layout.coupledStreams,
                ],
                [2, 312, 48000, -256, 1],
            );
        });

        test('reads the stream table of a 5.1 head of family 1', async () => {
            const { track } = await trackPackets(named(OPUS_FIXTURES, 'surround-5.1-family1'));
            const head = opusHead.parseOpusHead(track.codecConfig, 6);
            assert.deepEqual(
                [
                    head.mappingFamily,
                    head.layout.streams,
                    head.layout.coupledStreams,
                    [...head.layout.mapping],
                ],
                [1, 4, 2, [0, 4, 1, 2, 3, 5]],
            );
        });

        test('family 255 takes an explicit table; 255 entries are silent', async () => {
            const { track } = await trackPackets(named(OPUS_FIXTURES, 'surround-5.1-family1'));
            const explicit = new Uint8Array(19 + 2 + 3);
            explicit.set(track.codecConfig.subarray(0, 19));
            explicit[9] = 3;
            explicit[18] = 255;
            explicit.set([2, 1, 0, 1, 255], 19);
            const { layout } = opusHead.parseOpusHead(explicit, 3);
            assert.deepEqual(
                [layout.streams, layout.coupledStreams, [...layout.mapping]],
                [2, 1, [0, 1, 255]],
            );
            explicit[18] = 2;
            assert.throws(() => opusHead.parseOpusHead(explicit, 3), {
                code: 'FORMAT',
                message: /family 2/,
            });
        });

        test('refuses a truncated channel mapping table with FORMAT', async () => {
            const { track } = await trackPackets(named(OPUS_FIXTURES, 'surround-5.1-family1'));
            assert.throws(() => opusHead.parseOpusHead(track.codecConfig.subarray(0, 20), 6), {
                code: 'FORMAT',
            });
        });

        test('writes the head and the dOps payload that read back the same', () => {
            const head = hybrid.subarray(28, 47);
            const parsed = opusHead.parseOpusHead(head, 1);
            for (const written of [
                opusHead.opusHeadPacket(head, 1),
                opusHead.opusDopsPayload(head, 1),
            ])
                assert.deepEqual(opusHead.parseOpusHead(written, 1), parsed);
        });

        test('counts the 48 kHz samples a packet declares', () => {
            assert.equal(opusPacketFrames([31 << 3], 10), 960);
            assert.equal(opusPacketFrames([(31 << 3) | 1], 10), 1920);
            assert.equal(opusPacketFrames([(16 << 3) | 3, 6], 10), 720);
            assert.throws(() => opusPacketFrames([], 1), { code: 'DEMUX' });
        });
    });

    describe('Vorbis headers', () => {
        const headers = vorbis.xiphHeaders(stereo.track.codecConfig);

        test('splits Xiph-laced configuration into its three headers', () => {
            assert.deepEqual(
                headers.map(header => header[0]),
                [1, 3, 5],
            );
            assert.equal(vorbis.xiphHeaders(Uint8Array.of(1, 2, 3)), undefined);
        });

        test('laces three headers back into the same configuration', () => {
            assert.deepEqual(vorbis.vorbisCodecConfig(headers), stereo.track.codecConfig);
        });

        test('reads the block flag of each mode; packets name their block size', () => {
            const modes = vorbis.vorbisModes(headers[2], 2);
            assert.deepEqual([...new Set(modes)].sort(), [false, true]);
            const sizes = stereo.packets.map(packet =>
                vorbis.vorbisPacketBlock(packet, modes, 256, 2048),
            );
            assert.deepEqual(
                [...new Set(sizes)].sort((a, b) => a - b),
                [256, 2048],
            );
            assert.throws(() => vorbis.vorbisPacketBlock(headers[0], modes, 256, 2048), {
                code: 'DEMUX',
            });
        });

        test('an unused empty codebook in the setup leaves the modes alone', () => {
            assert.deepEqual(
                vorbis.vorbisModes(withUnusedCodebook(headers[2]), 2),
                vorbis.vorbisModes(headers[2], 2),
            );
        });
    });

    describe('WAVE format', () => {
        test('reads 16-bit stereo PCM as pcm-s16le', () => {
            const format = parseWaveFormat(fmt());
            assert.deepEqual(
                [
                    format.codec,
                    format.sampleRate,
                    format.channels,
                    format.bitsPerSample,
                    format.float,
                ],
                ['pcm-s16le', 48000, 2, 16, false],
            );
        });

        test('names each sample type by one codec, whatever the channels and layout', () => {
            for (const channels of [1, 2, 6])
                assert.equal(parseWaveFormat(fmt({ channels })).codec, 'pcm-s16le');
            assert.equal(parseWaveFormat(extensible({ bits: 16, valid: 16 })).codec, 'pcm-s16le');
            assert.equal(parseWaveFormat(fmt({ bits: 8 })).codec, 'pcm-u8');
            assert.equal(parseWaveFormat(fmt({ bits: 24 })).codec, 'pcm-s24le');
            assert.equal(parseWaveFormat(fmt({ bits: 32 })).codec, 'pcm-s32le');
            assert.equal(parseWaveFormat(fmt({ tag: 3, bits: 32 })).codec, 'pcm-f32le');
            assert.equal(parseWaveFormat(fmt({ tag: 3, bits: 64 })).codec, 'pcm-f64le');
        });

        test('reads G.711 at eight bits', () => {
            assert.equal(parseWaveFormat(wave.g711WaveFormat('ulaw', 8000, 1)).codec, 'ulaw');
            assert.equal(parseWaveFormat(wave.g711WaveFormat('alaw', 8000, 2)).codec, 'alaw');
        });

        test('reads WAVE_FORMAT_EXTENSIBLE: subformat, valid bits and speakers', () => {
            const format = parseWaveFormat(extensible({ bits: 32, valid: 24 }));
            assert.deepEqual(
                [format.codec, format.bitsPerSample, format.validBitsPerSample, format.channelMask],
                ['pcm-s32le', 32, 24, 0x3f],
            );
            assert.equal(wave.waveFormatTag(extensible({ subformat: 3, bits: 32 })), 3);
            assert.equal(
                parseWaveFormat(extensible({ bits: 24, valid: 0 })).validBitsPerSample,
                24,
                'zero means full',
            );
        });

        test('a wrong byte rate is reported to the callback and corrected', () => {
            const reports = [];
            const format = parseWaveFormat(fmt({ byteRate: 1 }), (...pair) => reports.push(pair));
            assert.deepEqual(reports, [[1, 192000]]);
            assert.equal(new DataView(format.codecConfig.buffer).getUint32(8, true), 192000);
            assert.throws(() => parseWaveFormat(fmt({ byteRate: 1 })), { code: 'FORMAT' });
        });

        test('refuses formats it cannot read with FORMAT', () => {
            for (const bad of [
                new Uint8Array(15),
                fmt({ tag: 2 }),
                fmt({ bits: 12 }),
                fmt({ channels: 0 }),
                fmt({ rate: 0 }),
                extensible({ valid: 30, bits: 24 }),
            ])
                assert.throws(() => parseWaveFormat(bad), { code: 'FORMAT' });
        });

        test('Audition 24-bit float in 32-bit slots is refused', () => {
            const audition = fmt({ bits: 24 });
            const view = new DataView(audition.buffer);
            view.setUint16(12, 8, true);
            view.setUint32(8, 48000 * 8, true);
            assert.throws(() => parseWaveFormat(audition), {
                code: 'FORMAT',
                message: /24-bit float/,
            });
        });

        test('names compressed WAVE tags', () => {
            assert.equal(wave.waveTagName(0x0055), '0x0055');
            assert.equal(wave.waveTagName(wave.EAC3_WAVE_TAG), 'E-AC-3 (IEC 61937 GUID)');
        });
    });

    describe('ALAC packets', () => {
        test('unwraps the cookie from CAF frma and alac atoms', () => {
            const cookie = new Uint8Array(24).fill(7);
            const wrapped = new Uint8Array([
                0,
                0,
                0,
                12,
                ...Buffer.from('frmaalac'),
                0,
                0,
                0,
                36,
                ...Buffer.from('alac'),
                0,
                0,
                0,
                0,
                ...cookie,
            ]);
            assert.deepEqual(alacCookie(wrapped), cookie);
            assert.deepEqual(alacCookie(cookie), cookie);
        });

        test('a partial frame states its own sample count', () => {
            assert.equal(alacPacketFrames(Uint8Array.of(0x20, 0, 0x00, 0, 0, 0, 0), 4096), 4096);
            assert.equal(
                alacPacketFrames(Uint8Array.of(0x20, 0, 0x10, 0, 0, 0x01, 0x00), 4096) > 0,
                true,
            );
            assert.equal(alacPacketFrames(Uint8Array.of(0x20, 0), 4096), undefined);
        });
    });

    describe('AAC fixtures', () => {
        test('the ADTS header of an HE-AAC stream states its core rate', () => {
            const header = adts.parseAdtsFrameHeader(aacFixture('he-aac-sbr.aac'));
            assert.equal(header.audioObjectType, 2);
            assert(header.sampleRate <= 24000);
        });
    });
});
