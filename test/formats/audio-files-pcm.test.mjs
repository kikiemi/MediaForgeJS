import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect, open } from 'mediaforgejs';
import { WavMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { allPackets, bytesOf, copied, readMedia } from '../helpers/read-media.mjs';
import { readFileSync } from 'node:fs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

const payloads = packets => packets.map(packet => packet.data);

/** A WAVE of `frames` frames of format `tag` (1 PCM, 3 float, 6 A-law), its samples zero. */
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
    return new Uint8Array(bytes);
}

/** wav-info.wav and where its 800 bytes of samples start. */
function waveInfo() {
    const source = fixtures['wav-info.wav']();
    return { source, dataStart: source.length - 800 };
}

describe('audio files: WAVE, AIFF, CAF and AU', () => {
    test('takes the title of a WAVE from its INFO list', async () => {
        assert.equal((await readMedia(waveInfo().source)).title, 'Wave');
    });

    test('16-bit WAVE is pcm-s16le at any channel count, and so are its copies', async () => {
        // One codec ID per sample format: no reader names 16-bit samples 'pcm' by their layout.
        for (const channels of [1, 2, 6]) {
            const input = wave(1, 8000, channels, 16, 64);
            assert.equal((await inspect(input)).tracks[0].codec, 'pcm-s16le');
            for (const format of ['wav', 'avi', 'mov', 'mkv']) {
                const { tracks } = await inspect(await copied(input, format));
                assert.equal(tracks[0].codec, 'pcm-s16le', `${channels} channels in ${format}`);
            }
        }
    });

    test('24-bit WAVE copied through AIFF, AU, CAF and WAV keeps its samples', async () => {
        const source = wave(1, 48000, 1, 24, 1);
        source.set([1, 2, 3], 44);
        for (const format of ['wav', 'aiff', 'au', 'caf']) {
            const back = await copied(await copied(source, format), 'wav');
            const { tracks } = await readMedia(back);
            assert.equal(tracks[0].track.codec, 'pcm-s24le', format);
            assert.deepEqual(payloads(tracks[0].packets), [Uint8Array.of(1, 2, 3)], format);
        }
    });

    test('holds the samples of a short WAVE in one packet', async () => {
        const { tracks } = await inspect(waveInfo().source, { sampleCounts: true });
        assert.equal(tracks[0].sampleCount, 1);
    });

    test('a wrong nAvgBytesPerSec warns, reads the same and a copy writes it right', async () => {
        // The byte rate is redundant with the rate and the block alignment.
        const { source } = waveInfo();
        const wrong = source.slice();
        const fmt = Buffer.from(wrong).indexOf('fmt ');
        const view = new DataView(wrong.buffer);
        const byteRate = view.getUint32(fmt + 16, true);
        view.setUint32(fmt + 16, byteRate * 8, true);
        const { tracks, warnings } = await readMedia(wrong);
        assert.deepEqual(warnings, ['WAV_BYTE_RATE']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(source)));
        await rejectsStrict(wrong);
        const copy = await copied(wrong, 'wav');
        const copyFmt = Buffer.from(copy).indexOf('fmt ');
        assert.equal(
            new DataView(copy.buffer, copy.byteOffset).getUint32(copyFmt + 16, true),
            byteRate,
        );
    });

    test('a data chunk the end cuts keeps its whole frames, marked incomplete', async () => {
        const { source, dataStart } = waveInfo();
        const cut = source.subarray(0, dataStart + 442);
        const { tracks, warnings } = await readMedia(cut);
        assert.deepEqual(warnings, ['WAV_TRUNCATED_CHUNK']);
        assert.equal(tracks[0].track.incomplete, true);
        assert.deepEqual(tracks[0].packets[0].data, source.subarray(dataStart, cut.length));
        await rejectsStrict(cut);
    });

    test('a partial frame at the cut is dropped with a warning', async () => {
        const { source, dataStart } = waveInfo();
        const { tracks, warnings } = await readMedia(source.subarray(0, dataStart + 443));
        assert.deepEqual(warnings, ['WAV_TRUNCATED_CHUNK', 'WAV_PARTIAL_FRAME']);
        assert.equal(tracks[0].packets[0].data.length, 442);
    });

    test('a RIFF size past the input with whole chunks reads the audio and warns', async () => {
        // A file cut at a chunk boundary after its data: a trailing LIST was lost.
        const { source } = waveInfo();
        const longer = source.slice();
        const view = new DataView(longer.buffer);
        view.setUint32(4, view.getUint32(4, true) + 20, true);
        const { tracks, warnings } = await readMedia(longer);
        assert.deepEqual(warnings, ['WAV_RIFF_SIZE']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(source)));
        await rejectsStrict(longer);
    });

    test('a RIFF size that stops inside a whole data chunk gives way to the chunk', async () => {
        const short = wave(1, 48000, 2, 24, 480);
        new DataView(short.buffer).setUint32(4, short.length - 8 - 12, true);
        const { tracks, warnings } = await readMedia(short);
        assert.deepEqual(warnings, ['WAV_RIFF_SIZE']);
        assert.equal(
            tracks[0].packets.reduce((sum, packet) => sum + packet.data.length, 0),
            480 * 6,
        );
        await rejectsStrict(short);
    });

    test('streaming size placeholders run to the end of the input', async () => {
        const { source, dataStart } = waveInfo();
        const streamed = source.slice();
        const view = new DataView(streamed.buffer);
        view.setUint32(4, 0xffffffff, true);
        view.setUint32(dataStart - 4, 0xffffffff, true);
        const { tracks, warnings } = await readMedia(streamed);
        assert.deepEqual(warnings, ['WAV_UNBOUNDED_SIZE']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(source)));
        await rejectsStrict(streamed);
    });

    for (const [file, title, code] of [
        ['aiff-chan.aiff', 'Six', 'AIFF_TRUNCATED_CHUNK'],
        ['caf-6ch.caf', 'Core', 'CAF_TRUNCATED_CHUNK'],
        ['au-6ch.au', undefined, 'AU_TRUNCATED_DATA'],
    ]) {
        test(`reads the six channels and the title of ${file}`, async () => {
            const read = await readMedia(fixtures[file]());
            assert.equal(read.title, title);
            assert.equal(read.tracks[0].track.channelCount, 6);
            assert.equal(read.tracks[0].packets[0].data.length, 160 * 6 * 2);
        });

        test(`${file} cut between frames keeps its whole frames, marked incomplete`, async () => {
            const source = fixtures[file]();
            const cut = source.subarray(0, source.length - 96);
            const { tracks, warnings } = await readMedia(cut);
            assert.deepEqual(warnings, [code]);
            assert.equal(tracks[0].track.incomplete, true);
            assert.equal(tracks[0].packets[0].data.length, 160 * 6 * 2 - 96);
            await rejectsStrict(cut);
        });

        test(`${file} cut inside a frame drops the part frame with a second warning`, async () => {
            const source = fixtures[file]();
            const { tracks, warnings } = await readMedia(source.subarray(0, source.length - 100));
            assert.equal(warnings.length, 2, `${warnings}`);
            assert.equal(tracks[0].packets[0].data.length, 160 * 6 * 2 - 108);
        });
    }

    test('ignores bytes after a whole CAF data chunk that do not form a chunk', async () => {
        const caf = fixtures['caf-6ch.caf']();
        const trailing = new Uint8Array(caf.length + 40);
        trailing.set(caf);
        trailing.set(new TextEncoder().encode('junk'), caf.length);
        new DataView(trailing.buffer).setBigInt64(caf.length + 4, 1n << 60n);
        const { tracks, warnings } = await readMedia(trailing);
        assert.deepEqual(warnings, ['CAF_TRAILING_BYTES']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(await allPackets(caf)));
        await rejectsStrict(trailing);
    });

    test('takes the title of an AU header annotation', async () => {
        const au = fixtures['au-6ch.au']();
        const annotation = new TextEncoder().encode('title=Sun audio\nencoder=Lavf\0');
        const titled = new Uint8Array(au.length + annotation.length);
        titled.set(au.subarray(0, 24));
        titled.set(annotation, 24);
        titled.set(au.subarray(24), 24 + annotation.length);
        new DataView(titled.buffer).setUint32(4, 24 + annotation.length);
        assert.equal((await readMedia(titled)).title, 'Sun audio');
    });

    for (const [rate, bytes, expected] of [
        [8000, wave(6, 8000, 1, 8, 3000), [512, 512, 512, 512, 512, 440]],
        [16000, wave(1, 16000, 2, 16, 2500), [1024, 1024, 452]],
        [48000, wave(1, 48000, 2, 16, 10000), [4096, 4096, 1808]],
        [2000, wave(1, 2000, 1, 16, 600), [256, 256, 88]],
    ])
        test(`PCM and G.711 packets at ${rate} Hz hold a power of two of frames`, async () => {
            // The largest power of two below a tenth of a second.
            const packets = await allPackets(bytes);
            assert.deepEqual(
                packets.map(packet => Math.round(packet.duration * rate)),
                expected,
            );
        });

    test('WAVE_FORMAT_EXTENSIBLE with zero valid bits stores full-width samples', async () => {
        const plain = wave(1, 48000, 2, 24, 480);
        const extensible = Buffer.alloc(plain.length + 24);
        extensible.set(plain.subarray(0, 36));
        extensible.writeUInt32LE(plain.length + 24 - 8, 4);
        extensible.writeUInt32LE(40, 16);
        extensible.writeUInt16LE(0xfffe, 20);
        extensible.writeUInt16LE(22, 36);
        extensible.writeUInt16LE(0, 38);
        extensible.writeUInt32LE(3, 40);
        Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(extensible, 44);
        extensible.set(plain.subarray(36), 60);
        const { tracks } = await readMedia(new Uint8Array(extensible));
        assert.deepEqual([tracks[0].track.codec, tracks[0].packets.length], ['pcm-s24le', 1]);
    });

    test('an ID3v2 chunk after the audio names the title over the INFO list', async () => {
        const info = Buffer.from(
            'LIST\x16\x00\x00\x00INFOINAM\x0a\x00\x00\x00RIFF INFO\x00',
            'latin1',
        );
        const id3 = Buffer.from(
            'id3 \x20\x00\x00\x00ID3\x03\x00\x00\x00\x00\x00\x16' +
                'TIT2\x00\x00\x00\x0c\x00\x00\x00ID3 in RIFF',
            'latin1',
        );
        const tagged = Buffer.concat([wave(1, 8000, 1, 16, 10), info, id3]);
        tagged.writeUInt32LE(tagged.length - 8, 4);
        assert.equal((await readMedia(new Uint8Array(tagged))).title, 'ID3 in RIFF');
        tagged.write('JUNK', tagged.length - id3.length);
        assert.equal((await readMedia(new Uint8Array(tagged))).title, 'RIFF INFO');
    });

    test("declines Adobe Audition's 24-bit float by name", async () => {
        // Format tag 1 with 24 bits in 4-byte slots.
        const audition = wave(1, 44100, 2, 32, 100);
        audition.set([24, 0], 34);
        await assert.rejects(
            open(audition),
            error => error.code === 'FORMAT' && /24-bit float/.test(error.message),
        );
    });

    test('the WAV writer writes each float sample back as its 16-bit code', async () => {
        // Every 16-bit code read as code / 32768 is written as itself, and ±1 as the ends.
        const codes = Int16Array.from({ length: 65536 }, (_, index) => index - 32768);
        const samples = Float32Array.from(codes, code => code / 32768);
        const ends = Float32Array.of(1, -1, 1.25, -1.25);
        const sink = new MemorySink();
        const muxer = new WavMuxer(sink, 8000, 1);
        for (const plane of [samples, ends])
            muxer.addAudioBuffer({
                sampleRate: 8000,
                numberOfChannels: 1,
                length: plane.length,
                getChannelData: () => plane,
            });
        await muxer.finalize();
        const written = sink.toUint8Array().subarray(44);
        const read = new Int16Array(written.buffer.slice(written.byteOffset));
        assert.deepEqual(read.subarray(0, 65536), codes);
        assert.deepEqual([...read.subarray(65536)], [32767, -32768, 32767, -32768]);
    });

    describe('IMA4 ADPCM', () => {
        // The four 68-byte blocks (64 frames of each of two channels) of the fixture ima4.aif.
        const aiff = () =>
            new Uint8Array(readFileSync(new URL('../fixtures/pcm/ima4.aif', import.meta.url)));
        const blocks = () => aiff().subarray(aiff().length - 272);
        /** A CAF of the blocks whose packet table states `valid` and `remainder` frames. */
        function caf(valid, remainder) {
            const chunk = (type, size) => {
                const header = Buffer.alloc(12);
                header.write(type, 0, 'latin1');
                header.writeBigInt64BE(BigInt(size), 4);
                return header;
            };
            const desc = Buffer.alloc(32);
            desc.writeDoubleBE(8000, 0);
            desc.write('ima4', 8, 'latin1');
            desc.writeUInt32BE(68, 16);
            desc.writeUInt32BE(64, 20);
            desc.writeUInt32BE(2, 24);
            // No packet count, as some writers leave it.
            const pakt = Buffer.alloc(24);
            pakt.writeBigInt64BE(BigInt(valid), 8);
            pakt.writeInt32BE(remainder, 20);
            return new Uint8Array(
                Buffer.concat([
                    Buffer.from('caff\0\x01\0\0', 'latin1'),
                    chunk('desc', 32),
                    desc,
                    chunk('pakt', 24),
                    pakt,
                    chunk('data', 4 + 272),
                    Buffer.alloc(4),
                    blocks(),
                ]),
            );
        }

        test('AIFF-C reads one packet per block of both channels', async () => {
            const { tracks } = await readMedia(aiff());
            assert.deepEqual(
                [tracks[0].track.codec, tracks[0].packets.map(packet => packet.data.length)],
                ['ima4', [68, 68, 68, 68]],
            );
        });

        test('CAF presents the valid frames its packet table states', async () => {
            // 250 valid frames and 6 remainder frames: the remainder is not presented. CAF IMA4
            // used to be rejected.
            const { tracks, warnings } = await readMedia(caf(250, 6));
            const { track, packets } = tracks[0];
            assert.deepEqual(
                [track.codec, packets.length, track.duration * 8000, warnings],
                ['ima4', 4, 250, []],
            );
        });

        test('CAF keeps every frame when its packet table does not add up', async () => {
            const { tracks, warnings } = await readMedia(caf(250, 5));
            assert.deepEqual(warnings, ['CAF_FRAME_COUNT']);
            assert.equal(tracks[0].packets.length, 4);
        });
    });

    describe('G.711', () => {
        const fixture = name => readFileSync(new URL(`../fixtures/pcm/${name}`, import.meta.url));
        /** FFmpeg's codes of g711-source.wav (a tone at 8 kHz) for `codec`. */
        const CODES = {
            ulaw: new Uint8Array(fixture('g711-source.ulaw')),
            alaw: new Uint8Array(fixture('g711-source.alaw')),
        };
        /** The 16-bit sample of G.711 `code`, as the standard expands it. */
        function expand(codec, code) {
            if (codec === 'ulaw') {
                const u = ~code & 0xff;
                const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
                return u & 0x80 ? 0x84 - t : t - 0x84;
            }
            const a = code ^ 0x55;
            const segment = (a & 0x70) >> 4;
            let t = a & 0x0f;
            t = segment ? (t + t + 1 + 32) << (segment + 2) : (t + t + 1) << 3;
            return a & 0x80 ? t : -t;
        }
        /** The codec, rate, channels and codes (packets joined) of the first track of `input`. */
        async function codesOf(input) {
            const { tracks } = await readMedia(input);
            const [{ track, packets }] = tracks;
            return {
                codec: track.codec,
                sampleRate: track.sampleRate,
                channels: track.channelCount,
                codes: new Uint8Array(Buffer.concat(packets.map(packet => packet.data))),
            };
        }
        // ffmpeg -i g711-source.wav -c:a pcm_mulaw (wav, au, caf, avi) or pcm_alaw (aiff, mkv)
        // -bitexact.
        const CONTAINERS = [
            ['g711-ulaw.wav', 'ulaw'],
            ['g711-ulaw.au', 'ulaw'],
            ['g711-alaw.aifc', 'alaw'],
            ['g711-ulaw.caf', 'ulaw'],
            ['g711-alaw.mkv', 'alaw'],
            ['g711-ulaw.avi', 'ulaw'],
        ];

        for (const [file, codec] of CONTAINERS) {
            test(`${file} reads FFmpeg's codes, 8 kHz mono`, async () => {
                assert.deepEqual(await codesOf(fixture(file)), {
                    codec,
                    sampleRate: 8000,
                    channels: 1,
                    codes: CODES[codec],
                });
            });

            test(`${file} decodes each code to its standard sample`, async () => {
                const wav = await bytesOf(await convert(fixture(file), { to: 'wav', copy: false }));
                const { codes } = await codesOf(wav);
                const samples = Int16Array.from({ length: codes.length / 2 }, (_, index) =>
                    Buffer.from(codes).readInt16LE(index * 2),
                );
                assert.deepEqual(
                    [...samples],
                    [...CODES[codec]].map(code => expand(codec, code)),
                );
            });

            test(`${file} copies its codes into WAV, AIFF, AU, CAF, MOV and MKV`, async () => {
                for (const format of ['wav', 'aiff', 'au', 'caf', 'mov', 'mkv']) {
                    const copy = await codesOf(await copied(fixture(file), format));
                    assert.equal(copy.codec, codec, format);
                    assert.deepEqual(copy.codes, CODES[codec], format);
                }
            });
        }

        const HEADERS = {
            wav: (bytes, codec) =>
                assert.equal(bytes[20] | (bytes[21] << 8), codec === 'ulaw' ? 7 : 6),
            au: (bytes, codec) =>
                assert.equal(new DataView(bytes.buffer).getUint32(12), codec === 'ulaw' ? 1 : 27),
            aiff: bytes => assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'AIFC'),
            caf: (bytes, codec) =>
                assert.equal(Buffer.from(bytes.subarray(28, 32)).toString(), codec),
        };
        for (const codec of ['ulaw', 'alaw'])
            for (const format of ['wav', 'aiff', 'au', 'caf'])
                test(`${format} as ${codec} is labelled so and holds FFmpeg's codes`, async () => {
                    const bytes = await bytesOf(
                        await convert(fixture('g711-source.wav'), format, {
                            copy: false,
                            audio: { codec },
                        }),
                    );
                    HEADERS[format](bytes, codec);
                    const read = await codesOf(bytes);
                    assert.equal(read.codec, codec);
                    assert.deepEqual(read.codes, CODES[codec]);
                });

        for (const codec of ['ulaw', 'alaw'])
            test(`MOV and MKV converted to ${codec} hold FFmpeg's codes`, async () => {
                for (const to of ['mov', 'mkv']) {
                    const { blob } = await convert(fixture('g711-source.wav'), {
                        to,
                        audio: { codec },
                    });
                    const read = await codesOf(await bytesOf(blob));
                    assert.equal(read.codec, codec, to);
                    assert.deepEqual(read.codes, CODES[codec], to);
                }
            });
    });
});
