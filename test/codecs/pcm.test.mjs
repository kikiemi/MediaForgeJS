import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MediaForgeError, check, convert, open } from 'mediaforgejs';
import {
    decodeG711,
    encodeG711,
    encodeReplayablePcmToSink,
    normalizePcmSource,
} from 'mediaforgejs/codecs';
import { MemorySink } from 'mediaforgejs/io';
import { decodeAudio, open as openParts } from 'mediaforgejs/parts';
import { matroskaFixture } from '../helpers/multitrack-pcm-fixtures.mjs';
import { bytesOf, waveChunks } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { decodeIma4, ima4Channel } = await import(distUrl('esm/codecs/pcm/ima-adpcm.js'));
const { decodePcmPacket } = await import(distUrl('esm/codecs/pcm/pcm-track-source.js'));
const { StreamingResampler } = await import(distUrl('esm/codecs/pcm/streaming-resampler.js'));
const { downmixChannels } = await import(distUrl('esm/codecs/pcm/audio-buffer-tools.js'));
const { InterleavedPcmQueue } = await import(distUrl('esm/codecs/pcm/pcm-queue.js'));

const fixture = name =>
    new Uint8Array(readFileSync(new URL(`../fixtures/pcm/${name}`, import.meta.url)));

/** ITU-T G.711 expansion of one code to a 16-bit sample. */
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

/** The interleaved 16-bit samples of the WAVE file a conversion of `input` writes. */
async function decodedWave(input, target = 'wav') {
    const wave = await bytesOf(
        (await convert(new Blob([input]), { to: target, copy: false })).blob,
    );
    const data = waveChunks(wave).get('data');
    return new Int16Array(wave.slice(data.at, data.at + data.size).buffer);
}

/** The data of every packet of the first track of an input. */
async function packetData(input) {
    const media = await open(new Blob([input]));
    try {
        const parts = [];
        for await (const packet of media.packets()) parts.push(packet.data);
        return { codec: media.tracks[0].codec, bytes: Buffer.concat(parts) };
    } finally {
        media.close();
    }
}

/** Every chunk of a source joined per channel. */
async function collect(source) {
    const planes = Array.from({ length: source.channels }, () => []);
    for await (const chunk of source.chunks())
        chunk.forEach((plane, channel) => planes[channel].push(...plane));
    return planes.map(plane => Float32Array.from(plane));
}

/** One second of a sine of `tone` Hz through the resampler, then the level of `measured` Hz. */
function resampledLevel(source, target, tone, measured) {
    const input = Float32Array.from(
        { length: source },
        (_, index) => 0.5 * Math.sin((2 * Math.PI * tone * index) / source),
    );
    const resampler = new StreamingResampler(source, target, 1);
    const parts = [];
    for (let index = 0; index < source; index += 4096)
        parts.push(resampler.process([input.subarray(index, index + 4096)])[0]);
    parts.push(resampler.flush()[0]);
    const output = Float32Array.from(parts.flatMap(part => [...part]));
    assert.equal(output.length, target, 'one second in, one second out');
    const middle = output.subarray(target >> 2, (3 * target) >> 2);
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < middle.length; index++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (middle.length - 1));
        const angle = (2 * Math.PI * measured * index) / target;
        real += middle[index] * window * Math.cos(angle);
        imaginary += middle[index] * window * Math.sin(angle);
    }
    return 20 * Math.log10((4 * Math.hypot(real, imaginary)) / middle.length / 0.5);
}

/** A CAF of the IMA4 blocks of the AIFF fixture whose packet table states its frame counts. */
function imaCaf(blocks, valid, remainder) {
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
    const pakt = Buffer.alloc(24);
    pakt.writeBigInt64BE(BigInt(valid), 8);
    pakt.writeInt32BE(remainder, 20);
    return new Uint8Array(
        Buffer.concat([
            Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]),
            chunk('desc', 32),
            desc,
            chunk('pakt', 24),
            pakt,
            chunk('data', 4 + blocks.length),
            Buffer.alloc(4),
            blocks,
        ]),
    );
}

describe('pcm', () => {
    describe('G.711', () => {
        for (const codec of ['ulaw', 'alaw'])
            test(`${codec}: every code expands as G.711 defines it`, () => {
                const [plane] = decodeG711(
                    Uint8Array.from({ length: 256 }, (_, i) => i),
                    {
                        codec,
                    },
                );
                for (let code = 0; code < 256; code++)
                    assert.equal(plane[code] * 32768, expand(codec, code), `code ${code}`);
            });

        test('every expanded code encodes back to itself, u-law -0 to +0', () => {
            for (const codec of ['ulaw', 'alaw']) {
                const all = Uint8Array.from({ length: 256 }, (_, index) => index);
                const again = encodeG711(decodeG711(all, { codec }), { codec });
                for (let code = 0; code < 256; code++)
                    assert.equal(again[code], codec === 'ulaw' && code === 0x7f ? 0xff : code);
            }
        });

        test('encodes by the one quantizing rule: NaN as silence, the range clamped', () => {
            // quantizeSample() of core/model/pcm-quantize, as the linear codings use it.
            for (const codec of ['ulaw', 'alaw']) {
                const [nan, zero, above, one, below, minusOne] = encodeG711(
                    [Float32Array.of(Number.NaN, 0, 2, 1, -2, -1)],
                    { codec },
                );
                assert.deepEqual([nan, above, below], [zero, one, minusOne], codec);
                assert.equal(expand(codec, zero), codec === 'ulaw' ? 0 : 8);
            }
        });

        test('interleaved codes decode into one plane per channel', () => {
            const all = Uint8Array.from({ length: 256 }, (_, index) => index);
            const stereo = decodeG711(all, { codec: 'ulaw', channels: 2 });
            assert.deepEqual(
                [stereo.length, stereo[0].length, stereo[1][0] * 32768],
                [2, 128, expand('ulaw', 1)],
            );
        });

        for (const [codec, reference] of [
            ['ulaw', 'g711-source.ulaw'],
            ['alaw', 'g711-source.alaw'],
        ])
            test(`${codec}: a 700 Hz tone encodes to the reference encoder's codes`, async () => {
                // ffmpeg -f lavfi -i sine=f=700:r=8000:d=0.02 -af volume=0.9 -c:a pcm_s16le, and
                // the pcm_mulaw and pcm_alaw encodes of it.
                const { blob } = await convert(fixture('g711-source.wav'), {
                    to: 'wav',
                    audio: { codec },
                });
                const read = await packetData(await bytesOf(blob));
                assert.equal(read.codec, codec);
                assert.deepEqual(new Uint8Array(read.bytes), fixture(reference));
            });

        for (const [name, codec, reference] of [
            ['g711-ulaw.wav', 'ulaw', 'g711-source.ulaw'],
            ['g711-alaw.aifc', 'alaw', 'g711-source.alaw'],
        ])
            test(`${codec}: a file decodes bit-exactly to the expanded codes`, async () => {
                assert.deepEqual(
                    [...(await decodedWave(fixture(name)))],
                    [...fixture(reference)].map(code => expand(codec, code)),
                );
            });

        test('refuses a codec that is not G.711 and no channels with INPUT', () => {
            assert.throws(() => encodeG711([new Float32Array(8)], { codec: 'linear' }), {
                code: 'INPUT',
            });
            assert.throws(() => decodeG711(new Uint8Array(8), { codec: 'ulaw', channels: 0 }), {
                code: 'INPUT',
            });
            assert(encodeG711([new Float32Array(8)], { codec: 'alaw' }) instanceof Uint8Array);
        });
    });

    describe('IMA4 ADPCM', () => {
        // ffmpeg -f lavfi -i "aevalsrc=0.6*sin(2*PI*440*t)|0.4*sin(2*PI*1000*t+1):s=8000:
        // d=0.032" -c:a adpcm_ima_qt -bitexact -f aiff; the reference is its s16le decode, four
        // blocks of 64 frames per channel.
        const aiff = fixture('ima4.aif');
        const reference = Buffer.from(fixture('ima4-reference.s16le'));
        const blocks = aiff.subarray(aiff.length - 272);

        test('decodes AIFF-C blocks bit-exactly like the reference', async () => {
            assert(reference.equals(Buffer.from((await decodedWave(aiff)).buffer)));
        });

        test('decodes one 34-byte block per channel to 64 frames each', () => {
            const channels = [ima4Channel(), ima4Channel()];
            const planes = [0, 1, 2, 3].map(block =>
                decodeIma4(blocks.subarray(block * 68, block * 68 + 68), channels),
            );
            assert(planes.every(block => block.length === 2 && block[0].length === 64));
            const expected = new Int16Array(reference.buffer.slice(reference.byteOffset));
            planes.forEach((block, index) =>
                block.forEach((plane, channel) =>
                    plane.forEach((value, frame) =>
                        assert.equal(
                            Math.round(value * 32768),
                            expected[(index * 64 + frame) * 2 + channel],
                        ),
                    ),
                ),
            );
        });

        test('presents the valid frames of a CAF packet table and no remainder', async () => {
            const trimmed = Buffer.from((await decodedWave(imaCaf(blocks, 250, 6))).buffer);
            assert(reference.subarray(0, 1000).equals(trimmed));
        });

        test('keeps every frame when a CAF packet table does not add up', async () => {
            assert(
                reference.equals(Buffer.from((await decodedWave(imaCaf(blocks, 250, 5))).buffer)),
            );
        });
    });

    describe('linear PCM', () => {
        const format = (bitsPerSample, extra = {}) => ({
            channels: 1,
            blockAlign: bitsPerSample / 8,
            bitsPerSample,
            float: false,
            signed: true,
            littleEndian: true,
            ...extra,
        });
        const one = (bytes, shape) => [...decodePcmPacket(Uint8Array.from(bytes), shape)][0][0];

        test('reads unsigned and signed 8-bit samples around their zero', () => {
            assert.deepEqual(
                [...one([0, 128, 255], format(8, { signed: false }))],
                [-1, 0, 127 / 128],
            );
            assert.deepEqual([...one([0x80, 0, 0x7f], format(8))], [-1, 0, 127 / 128]);
        });

        test('reads 16, 24 and 32-bit samples in either byte order as v / 2^(bits - 1)', () => {
            assert.deepEqual([...one([0, 0x80, 0, 0x40], format(16))], [-1, 0.5]);
            assert.deepEqual(
                [...one([0x80, 0, 0x40, 0], format(16, { littleEndian: false }))],
                [-1, 0.5],
            );
            assert.deepEqual([...one([0, 0, 0x80, 0, 0, 0x40], format(24))], [-1, 0.5]);
            assert.deepEqual(
                [...one([0x80, 0, 0, 0x40, 0, 0], format(24, { littleEndian: false }))],
                [-1, 0.5],
            );
            assert.deepEqual([...one([0, 0, 0, 0x80, 0, 0, 0, 0x40], format(32))], [-1, 0.5]);
        });

        test('reads 32 and 64-bit float samples as they are', () => {
            const bytes = new Uint8Array(new Float32Array([0.25, -0.75]).buffer);
            assert.deepEqual([...one(bytes, format(32, { float: true }))], [0.25, -0.75]);
            const doubles = new Uint8Array(new Float64Array([0.125]).buffer);
            assert.deepEqual([...one(doubles, format(64, { float: true }))], [0.125]);
        });

        test('reports nonfinite float samples and a partial frame with DECODE', () => {
            const nan = new Uint8Array(new Float32Array([Number.NaN]).buffer);
            assert.throws(() => one(nan, format(32, { float: true })), { code: 'DECODE' });
            assert.throws(() => one([0, 0, 0], format(16)), { code: 'DECODE' });
        });

        test('splits interleaved channels into planes', () => {
            const planes = [
                ...decodePcmPacket(
                    Uint8Array.of(0, 0x40, 0, 0xc0),
                    format(16, { channels: 2, blockAlign: 4 }),
                ),
            ][0];
            assert.deepEqual(
                planes.map(plane => [...plane]),
                [[0.5], [-0.5]],
            );
        });

        test('writes x * 2^(depth - 1) rounded half up and clamped, either order', async () => {
            // A sink that copies its writes lets every chunk reuse one buffer; a sink that keeps
            // what it is given still gets bytes of its own.
            const halves = [0, 0.5, 1.5, 2.5, 3.49, 32766.5, 32767.49, 32767.5, 32768, 40000];
            const chunks = [
                Float32Array.from(
                    [...halves, ...halves.map(value => -value), -32768.5].map(
                        value => value / 32768,
                    ),
                ),
                Float32Array.from(
                    [0.5, 1.5, 8388606.5, 8388607.5, -8388607.5, -8388608.5].map(
                        value => value / 8388608,
                    ),
                ),
                Float32Array.from([1, -1, 1.5, -1.5, 1e-30, -1e-30, 0.25, -0.75]),
            ];
            const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
            const source = {
                sampleRate: 8000,
                channels: 2,
                estimatedFrames: frames,
                async *chunks() {
                    for (const chunk of chunks) yield [chunk, chunk.map(value => -value / 3)];
                },
            };
            for (const [target, littleEndian] of [
                ['wav', true],
                ['aiff', false],
            ])
                for (const [sampleFormat, depth] of [
                    ['s16', 16],
                    ['s24', 24],
                ]) {
                    const width = depth / 8;
                    const expected = new Uint8Array(frames * 2 * width);
                    let at = 0;
                    for (const chunk of chunks)
                        for (const value of chunk)
                            for (const sample of [value, Math.fround(-value / 3)]) {
                                const code = Math.max(
                                    -(2 ** (depth - 1)),
                                    Math.min(
                                        2 ** (depth - 1) - 1,
                                        Math.round(sample * 2 ** (depth - 1)),
                                    ),
                                );
                                for (let byte = 0; byte < width; byte++)
                                    expected[at + (littleEndian ? byte : width - 1 - byte)] =
                                        (code >> (8 * byte)) & 255;
                                at += width;
                            }
                    const memory = new MemorySink();
                    await encodeReplayablePcmToSink(source, target, memory, { sampleFormat });
                    const copied = memory.toUint8Array();
                    const kept = [];
                    await encodeReplayablePcmToSink(
                        source,
                        target,
                        { write: bytes => kept.push(bytes), close: async () => {} },
                        { sampleFormat },
                    );
                    const label = `${target} ${sampleFormat}`;
                    assert.deepEqual(
                        copied.subarray(copied.length - expected.length),
                        expected,
                        label,
                    );
                    assert.deepEqual(Buffer.concat(kept), Buffer.from(copied), label);
                }
        });
    });

    describe('sources', () => {
        const toneSource = (rate, channels, frames) => ({
            sampleRate: rate,
            channels,
            estimatedFrames: frames,
            async *chunks() {
                for (let at = 0; at < frames; at += 1000) {
                    const length = Math.min(1000, frames - at);
                    yield Array.from({ length: channels }, (_, channel) =>
                        Float32Array.from(
                            { length },
                            (_, index) => (channel + 1) * 0.1 * Math.sin((at + index) / 10),
                        ),
                    );
                }
            },
        });

        test('normalizing to the same shape keeps every sample', async () => {
            const source = toneSource(48000, 2, 4500);
            assert.deepEqual(
                await collect(normalizePcmSource(source, 48000, 2)),
                await collect(source),
            );
        });

        test('normalizing trims the head and bounds the valid frames', async () => {
            const source = toneSource(48000, 1, 4500);
            const whole = await collect(source);
            const [plane] = await collect(
                normalizePcmSource(source, 48000, 1, { head: 100, valid: 2000 }),
            );
            assert.deepEqual(plane, whole[0].subarray(100, 2100));
        });

        test('normalizing to another rate keeps the duration', async () => {
            const [plane] = await collect(
                normalizePcmSource(toneSource(48000, 1, 48000), 44100, 1),
            );
            assert(Math.abs(plane.length - 44100) <= 1, `${plane.length} frames`);
        });

        test('normalizing mono to stereo copies the channel into both', async () => {
            const [left, right] = await collect(
                normalizePcmSource(toneSource(48000, 1, 3000), 48000, 2),
            );
            assert.deepEqual(left, right);
        });

        for (const chunkSize of [1, 3, 17, 257])
            test(`chunks of ${chunkSize}: a window stops and closes its source`, async () => {
                const values = Float32Array.from(
                    { length: 1024 },
                    (_, at) => ((at % 32) - 16) / 16,
                );
                let pulled = 0;
                let closed = false;
                const source = {
                    sampleRate: 8000,
                    channels: 1,
                    estimatedFrames: 1024,
                    async *chunks() {
                        try {
                            for (let at = 0; at < values.length; at += chunkSize) {
                                pulled += Math.min(chunkSize, values.length - at);
                                yield [values.slice(at, at + chunkSize)];
                            }
                        } finally {
                            closed = true;
                        }
                    },
                };
                const [left, right] = await collect(
                    normalizePcmSource(source, 8000, 2, { head: 13, valid: 701 }),
                );
                const expected = Float32Array.from(
                    { length: 701 },
                    (_, at) => (((at + 13) % 32) - 16) / 16,
                );
                assert.deepEqual([left, right], [expected, expected]);
                assert(pulled < 13 + 701 + chunkSize, `read ${pulled} of 1024 frames`);
                assert.equal(closed, true);
            });

        test('a replay of a normalized source repeats it', async () => {
            const source = normalizePcmSource(toneSource(48000, 2, 4500), 44100, 1);
            assert.deepEqual(await collect(source), await collect(source));
        });
    });

    describe('track timelines', () => {
        // Four packets of 4096 stereo 16-bit frames in Matroska, whose millisecond clock rounds
        // their times; `shift` moves the last two by a real gap or overlap.
        const values = Int16Array.from({ length: 4096 * 2 }, (_, at) =>
            Math.round(8192 * Math.sin((at >> 1) / 12 + (at & 1))),
        );
        const data = new Uint8Array(values.buffer);
        const clip = (shift = 0) =>
            matroskaFixture({
                pcm: { codec: 'A_PCM/INT/LIT', bits: 16, channels: 2, sampleRate: 48000 },
                packets: Array.from({ length: 4 }, (_, index) => ({
                    id: 1,
                    trackType: 'audio',
                    timestamp: (index * 4096) / 48000 + (index >= 2 ? shift : 0),
                    duration: 4096 / 48000,
                    isKeyframe: true,
                    data,
                })),
            });
        const decoded = async input => {
            const media = await openParts(new Blob([input]));
            try {
                return await collect(await decodeAudio(media, media.tracks[0].id));
            } finally {
                media.close();
            }
        };

        test('clock rounding is no gap: every sample is read, in place', async () => {
            const [left, right] = await decoded(clip());
            assert.equal(left.length, 4096 * 4);
            for (let frame = 0; frame < left.length; frame += 997) {
                assert.equal(left[frame], values[(frame % 4096) * 2] / 32768);
                assert.equal(right[frame], values[(frame % 4096) * 2 + 1] / 32768);
            }
            const decode = { copy: false };
            assert.equal((await check(clip(), 'wav', decode)).supported, true);
            const copied = (await convert(clip(), 'wav', { copy: true })).blob;
            assert.deepEqual(
                await bytesOf((await convert(clip(), 'wav', decode)).blob),
                await bytesOf((await convert(copied, 'wav', decode)).blob),
            );
        });

        for (const shift of [-0.004, 0.004])
            test(`refuses a real ${shift < 0 ? 'overlap' : 'gap'} past the clock`, async () => {
                const input = clip(shift);
                assert.equal((await check(input, 'wav', { copy: false })).supported, false);
                await assert.rejects(convert(input, 'wav', { copy: false }), /gapless/);
                await assert.rejects(decoded(input), /gapless/);
            });
    });

    describe('resampling', () => {
        for (const [source, target] of [
            [48000, 44100],
            [96000, 48000],
            [48000, 16000],
        ]) {
            test(`${source} to ${target} Hz keeps the band below 0.88 of Nyquist flat`, () => {
                const nyquist = target / 2;
                const level = resampledLevel(source, target, 0.88 * nyquist, 0.88 * nyquist);
                assert(Math.abs(level) < 0.1, `${level} dB`);
            });

            test(`${source} to ${target} Hz folds 1.12 of Nyquist below -90 dB`, () => {
                const folded = 1.12 * (target / 2);
                assert(resampledLevel(source, target, folded, target - folded) < -90);
            });
        }

        test('upsampling keeps one second one second and the tone at its level', () => {
            assert(Math.abs(resampledLevel(44100, 48000, 1000, 1000)) < 0.1);
        });

        test('refuses data after flush and impossible rates', () => {
            const resampler = new StreamingResampler(48000, 44100, 1);
            resampler.flush();
            assert.throws(() => resampler.process([new Float32Array(10)]), { code: 'ENCODE' });
            assert.throws(() => new StreamingResampler(0, 44100, 1), { code: 'ENCODE' });
            assert.throws(() => new StreamingResampler(48000, 44100, 9), { code: 'ENCODE' });
        });
    });

    describe('channel mapping', () => {
        test('stereo folds to mono as the mean of both channels', () => {
            const [mono] = downmixChannels(
                [Float32Array.of(1, 0.5), Float32Array.of(0, -0.5)],
                2,
                1,
                2,
            );
            assert.deepEqual([...mono], [0.5, 0]);
        });

        test('5.1 folds to stereo by BS.775 and drops the LFE', () => {
            const unit = channel =>
                Array.from({ length: 6 }, (_, index) => Float32Array.of(index === channel ? 1 : 0));
            const fold = channel => downmixChannels(unit(channel), 6, 2, 1).map(plane => plane[0]);
            const [fl, fr, fc, lfe, bl, br] = [0, 1, 2, 3, 4, 5].map(fold);
            assert(fl[0] > 0 && fl[1] === 0 && bl[0] > 0 && bl[1] === 0);
            assert(fr[1] > 0 && fr[0] === 0 && br[1] > 0 && br[0] === 0);
            assert(fc[0] > 0 && Math.abs(fc[0] - fc[1]) < 1e-7);
            assert.deepEqual(lfe, [0, 0]);
        });

        test('7.1 folds to 5.1 by the matrix: each side joins the back of its side', () => {
            // FL FR FC LFE BL BR SL SR
            const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
            const planes = values.map(value => Float32Array.of(value));
            const folded = downmixChannels(planes, 8, 6, 1).map(plane => plane[0]);
            const expected = [0.1, 0.2, 0.3, 0.4, (0.5 + 0.7) / 2, (0.6 + 0.8) / 2];
            folded.forEach((value, plane) =>
                assert(Math.abs(value - expected[plane]) < 1e-7, `plane ${plane}: ${value}`),
            );
        });

        test('mono spreads to both channels of stereo', () => {
            const [left, right] = downmixChannels([Float32Array.of(0.25, -0.5)], 1, 2, 2);
            assert.deepEqual(
                [[...left], [...right]],
                [
                    [0.25, -0.5],
                    [0.25, -0.5],
                ],
            );
        });
    });

    describe('encoder queue', () => {
        test('pushes planes and copies interleaved frames without consuming them', () => {
            const queue = new InterleavedPcmQueue(2);
            queue.pushPlanar([Float32Array.of(1, 2, 3), Float32Array.of(-1, -2, -3)]);
            assert.equal(queue.bufferedFrames, 3);
            assert.deepEqual([...queue.copyFrames(1, 3)], [2, -2, 3, -3, 0, 0]);
            assert.equal(queue.bufferedFrames, 3);
        });

        test('refuses planes of another channel count or of unequal lengths', () => {
            const queue = new InterleavedPcmQueue(2);
            assert.throws(() => queue.pushPlanar([new Float32Array(2)]), { code: 'ENCODE' });
            assert.throws(() => queue.pushPlanar([new Float32Array(2), new Float32Array(3)]), {
                code: 'ENCODE',
            });
            assert.throws(() => new InterleavedPcmQueue(9), { code: 'ENCODE' });
        });
    });
});
