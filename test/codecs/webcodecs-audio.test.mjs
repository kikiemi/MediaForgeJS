import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError, convert, encodeFrames, inspect } from 'mediaforgejs';
import { buildAacAsc, createAudioTrackSource } from 'mediaforgejs/codecs';
import {
    FakeChunk,
    fakeAudioData,
    fakeAudioDecoder,
    installGlobals,
} from '../helpers/fake-webcodecs.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';
import { toneWav } from '../helpers/api-fixtures.mjs';

const webcodecs = path => import(distUrl(`esm/codecs/webcodecs/${path}.js`));
const { HostAudioDecoder, HostAudioEncoder, hostAudioDecoderConfig } = await webcodecs('audio');
const { copyAudioPlanes } = await webcodecs('audio-data');
const { bufferCopy, closeCodec, codecError, isCodecFailure, micros } = await webcodecs('codec');
const { hostCodecAvailable, hostSupports, queryHostCodec } = await webcodecs('support');
const { CodecLifetime } = await import(distUrl('esm/codecs/shared/codec-lifetime.js'));

const STREAMINFO = Uint8Array.from({ length: 34 }, (_, index) => index + 1);
const OPUS_HEAD = Uint8Array.of(
    ...Buffer.from('OpusHead'),
    1,
    2,
    0x38,
    1,
    0x80,
    0xbb,
    0,
    0,
    0,
    0,
    0,
);

/** A track of the fields hostAudioDecoderConfig reads. */
const trackOf = (codec, codecConfig, sampleRate = 48000, channelCount = 2) => ({
    codec,
    codecConfig,
    sampleRate,
    channelCount,
});

/** A HostAudioDecoder on `Decoder` with the warnings it reports and its lifetime. */
function hostDecoder(Decoder, config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }) {
    const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: FakeChunk });
    const lifetime = new CodecLifetime();
    const warnings = [];
    const decoder = new HostAudioDecoder(config, lifetime, (code, message) =>
        warnings.push([code, message]),
    );
    return { decoder, lifetime, warnings, restore };
}

/** Planes of `frames` frames: channel c holds c + 1 + frame / 1000. */
const planesOf = (channels, frames, base = 0) =>
    Array.from({ length: channels }, (_, channel) =>
        Float32Array.from({ length: frames }, (_, frame) => channel + 1 + (base + frame) / 1000),
    );

describe('webcodecs', () => {
    describe('audio decoder configuration', () => {
        test('FLAC is described by its stream header', () => {
            const config = hostAudioDecoderConfig(trackOf('flac', STREAMINFO));
            assert.equal(config.codec, 'flac');
            assert.deepEqual(
                [...config.description.subarray(0, 8)],
                [0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34],
            );
            assert.deepEqual(config.description.subarray(8), STREAMINFO);
        });

        test('Opus is described by an OpusHead without pre-skip', () => {
            const config = hostAudioDecoderConfig(trackOf('opus', OPUS_HEAD));
            assert.equal(config.codec, 'opus');
            assert.deepEqual([config.description[10], config.description[11]], [0, 0]);
            assert.equal(
                hostAudioDecoderConfig(trackOf('opus', Uint8Array.of(1, 2, 3), 48000, 9)),
                null,
            );
        });

        test('AAC names its object type with the output rate and channels', () => {
            const lc = hostAudioDecoderConfig(trackOf('mp4a.40.2', buildAacAsc(48000, 2)));
            assert.deepEqual(
                [lc.codec, lc.sampleRate, lc.numberOfChannels],
                ['mp4a.40.2', 48000, 2],
            );
            // AOT 5, 24 kHz, stereo, extension 48 kHz: HE-AAC.
            const he = hostAudioDecoderConfig(
                trackOf('mp4a.40.2', Uint8Array.of(0x2b, 0x11, 0x88, 0x00)),
            );
            assert.equal(he.codec, 'mp4a.40.5');
        });

        test('AAC and ALAC without their configuration have no host configuration', () => {
            assert.equal(hostAudioDecoderConfig(trackOf('mp4a.40.2', undefined)), null);
            assert.equal(hostAudioDecoderConfig(trackOf('alac', undefined)), null);
        });

        test('MP3onMP4 (object types 32 to 34) has no host configuration', () => {
            for (const type of [32, 33, 34])
                assert.equal(
                    hostAudioDecoderConfig(trackOf(`mp4a.40.${type}`, Uint8Array.of(1))),
                    null,
                );
        });

        test('MPEG audio and G.711 go without a description; MP2 asks for mp3', () => {
            assert.deepEqual(hostAudioDecoderConfig(trackOf('mp2', Uint8Array.of(1))), {
                codec: 'mp3',
                sampleRate: 48000,
                numberOfChannels: 2,
            });
            assert.equal(
                hostAudioDecoderConfig(trackOf('ulaw', Uint8Array.of(1), 8000, 1)).description,
                undefined,
            );
            assert.deepEqual(
                hostAudioDecoderConfig(trackOf('vorbis', Uint8Array.of(2))).description,
                Uint8Array.of(2),
            );
        });
    });

    describe('reading AudioData', () => {
        test('float planes are copied as they are', () => {
            const planes = [new Float32Array(3), new Float32Array(3)];
            copyAudioPlanes(
                fakeAudioData({ samples: [Float32Array.of(0.5, -1), Float32Array.of(0.25, 1)] }),
                planes,
                1,
            );
            assert.deepEqual(planes, [Float32Array.of(0, 0.5, -1), Float32Array.of(0, 0.25, 1)]);
        });

        test('interleaved s16 is scaled by 1 / 32768 exactly, not by the host', () => {
            const audio = fakeAudioData({
                format: 's16',
                samples: Int16Array.of(32767, -32768, 1, -1),
                channels: 2,
            });
            const planes = [new Float32Array(2), new Float32Array(2)];
            copyAudioPlanes(audio, planes, 0);
            assert.deepEqual(planes, [
                Float32Array.of(32767 / 32768, 1 / 32768),
                Float32Array.of(-1, -1 / 32768),
            ]);
        });

        test('planar s32 and unsigned u8 are scaled around their zero', () => {
            const s32 = fakeAudioData({
                format: 's32-planar',
                samples: [Int32Array.of(2 ** 30, -(2 ** 31))],
            });
            const plane = [new Float32Array(2)];
            copyAudioPlanes(s32, plane, 0);
            assert.deepEqual(plane[0], Float32Array.of(0.5, -1));
            const u8 = fakeAudioData({
                format: 'u8',
                samples: Uint8Array.of(128, 0, 255),
                channels: 1,
            });
            const bytes = [new Float32Array(3)];
            copyAudioPlanes(u8, bytes, 0);
            assert.deepEqual(bytes[0], Float32Array.of(0, -1, 127 / 128));
        });

        test('only as many channels as there are planes are read', () => {
            const audio = fakeAudioData({
                format: 's16',
                samples: Int16Array.of(1, 2, 3, 4, 5, 6),
                channels: 3,
            });
            const planes = [new Float32Array(2)];
            copyAudioPlanes(audio, planes, 0);
            assert.deepEqual(planes[0], Float32Array.of(1 / 32768, 4 / 32768));
        });
    });

    describe('host audio decoder', () => {
        test('gathers the output of several chunks into one block', async () => {
            const { Decoder, stats } = fakeAudioDecoder((_, chunk, index) =>
                fakeAudioData({ samples: planesOf(2, 480, index * 480) }),
            );
            const { decoder, restore } = hostDecoder(Decoder);
            try {
                for (let index = 0; index < 4; index++)
                    await decoder.decode(Uint8Array.of(index), index * 10000, 10000);
                await decoder.flush();
                const blocks = decoder.take();
                assert.equal(blocks.length, 1);
                assert.deepEqual(blocks[0], planesOf(2, 1920));
                assert.deepEqual(decoder.take(), [], 'ownership passed to the caller');
                assert.deepEqual(
                    stats.chunks.map(chunk => [chunk.type, chunk.timestamp, chunk.duration]),
                    [0, 1, 2, 3].map(index => ['key', index * 10000, 10000]),
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('closes each AudioData once it is read', async () => {
            const outputs = [];
            const { Decoder } = fakeAudioDecoder(() => {
                const audio = fakeAudioData({ samples: planesOf(2, 4) });
                outputs.push(audio);
                return audio;
            });
            const { decoder, restore } = hostDecoder(Decoder);
            try {
                await decoder.decode(Uint8Array.of(1), 0);
                await decoder.flush();
                assert(outputs.every(audio => audio.closed));
            } finally {
                decoder.close();
                restore();
            }
        });

        test('another channel count is mixed to the configured one, with one warning', async () => {
            // A stream that starts in stereo before its 5.1 frames, configured for 5.1.
            const { Decoder } = fakeAudioDecoder((_, chunk, index) =>
                fakeAudioData({ samples: planesOf(index < 2 ? 2 : 6, 4) }),
            );
            const { decoder, warnings, restore } = hostDecoder(Decoder, {
                codec: 'ac-3',
                sampleRate: 48000,
                numberOfChannels: 6,
            });
            try {
                for (let index = 0; index < 4; index++)
                    await decoder.decode(Uint8Array.of(index), index);
                await decoder.flush();
                const blocks = decoder.take();
                assert(blocks.every(block => block.length === 6));
                assert.deepEqual(warnings, [
                    ['AUDIO_FORMAT_CHANGED', 'ac-3 audio changes to 2 channels, mixed to 6'],
                ]);
                const [first] = blocks;
                assert.deepEqual(
                    [first[0][0], first[1][0], first[2][0]],
                    [1, 2, 0],
                    'stereo fills the front pair',
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('another sample rate fails the decoding with DECODE', async () => {
            const { Decoder } = fakeAudioDecoder(() =>
                fakeAudioData({ sampleRate: 44100, samples: planesOf(2, 4) }),
            );
            const { decoder, lifetime, restore } = hostDecoder(Decoder);
            try {
                await decoder.decode(Uint8Array.of(1), 0);
                await assert.rejects(decoder.flush(), {
                    code: 'DECODE',
                    message: /another sample rate/,
                });
                assert.throws(() => lifetime.check(), { code: 'DECODE' });
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a host error ends the decoding with DECODE naming the codec', async () => {
            const { Decoder } = fakeAudioDecoder(
                () => new DOMException('bad packet', 'EncodingError'),
            );
            const { decoder, restore } = hostDecoder(Decoder);
            try {
                await decoder.decode(Uint8Array.of(1), 0);
                await assert.rejects(decoder.flush(), {
                    code: 'DECODE',
                    message: /AudioDecoder failed for 'opus': bad packet/,
                });
                await assert.rejects(decoder.decode(Uint8Array.of(2), 1), { code: 'DECODE' });
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a host that refuses the configuration fails at once with DECODE', () => {
            class Refusing {
                constructor() {
                    this.state = 'unconfigured';
                }
                configure() {
                    throw new TypeError('unsupported');
                }
                close() {
                    this.state = 'closed';
                }
            }
            const restore = installGlobals({
                AudioDecoder: Refusing,
                EncodedAudioChunk: FakeChunk,
            });
            try {
                assert.throws(
                    () =>
                        new HostAudioDecoder(
                            { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
                            new CodecLifetime(),
                        ),
                    {
                        code: 'DECODE',
                        message: /unsupported/,
                    },
                );
            } finally {
                restore();
            }
        });
    });

    describe('host audio encoder', () => {
        /** An AudioEncoder class that emits one chunk per AudioData, reporting `description`. */
        function fakeEncoder(description) {
            const given = [];
            class Encoder {
                state = 'unconfigured';
                encodeQueueSize = 0;
                constructor(init) {
                    this.init = init;
                }
                configure(config) {
                    this.config = config;
                    this.state = 'configured';
                }
                encode(audio) {
                    given.push(audio);
                    const chunk = new FakeChunk({
                        timestamp: audio.timestamp,
                        duration: Math.round((audio.numberOfFrames / audio.sampleRate) * 1e6),
                        data: Uint8Array.of(7, given.length),
                    });
                    this.init.output(chunk, description && { decoderConfig: { description } });
                }
                async flush() {}
                close() {
                    this.state = 'closed';
                }
            }
            class Data {
                constructor(init) {
                    Object.assign(this, init);
                }
                close() {}
            }
            return { given, restore: installGlobals({ AudioEncoder: Encoder, AudioData: Data }) };
        }

        test('encodes planes as f32-planar and hands on packets in seconds', async () => {
            const { given, restore } = fakeEncoder(buildAacAsc(48000, 2));
            const packets = [];
            try {
                const encoder = new HostAudioEncoder(
                    { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
                    new CodecLifetime(),
                    (packet, description) => packets.push([packet, description]),
                );
                await encoder.encodePlanes(planesOf(2, 960), 0.5);
                await encoder.flush();
                assert.equal(given[0].format, 'f32-planar');
                assert.deepEqual(
                    given[0].data,
                    Float32Array.from([...planesOf(2, 960)[0], ...planesOf(2, 960)[1]]),
                );
                assert.equal(given[0].timestamp, 500000);
                const [[packet, description]] = packets;
                assert.deepEqual(
                    [packet.timestamp, packet.duration, packet.isKeyframe, [...packet.data]],
                    [0.5, 0.02, true, [7, 1]],
                );
                assert.deepEqual(description, buildAacAsc(48000, 2));
                assert.equal(encoder.packets, 1);
                encoder.close();
            } finally {
                restore();
            }
        });

        test('an AAC record of another object type fails as a host ENCODE failure', async () => {
            const { restore } = fakeEncoder(buildAacAsc(48000, 2));
            try {
                const lifetime = new CodecLifetime();
                const encoder = new HostAudioEncoder(
                    { codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2 },
                    lifetime,
                    () => {},
                );
                await assert.rejects(encoder.encodePlanes(planesOf(2, 960), 0), {
                    code: 'ENCODE',
                    message: /another AAC type/,
                });
                assert.equal(
                    encoder.hostFailure?.code,
                    'ENCODE',
                    'a built-in encoder may take over',
                );
                encoder.close();
            } finally {
                restore();
            }
        });

        test('HE-AAC without an AudioSpecificConfig is refused', async () => {
            const { restore } = fakeEncoder(undefined);
            try {
                const encoder = new HostAudioEncoder(
                    { codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2 },
                    new CodecLifetime(),
                    () => {},
                );
                await assert.rejects(encoder.encodePlanes(planesOf(2, 960), 0), {
                    code: 'ENCODE',
                    message: /no valid AudioSpecificConfig/,
                });
                encoder.close();
            } finally {
                restore();
            }
        });
    });

    describe('codec helpers', () => {
        test('seconds become whole microseconds within the safe range', () => {
            assert.equal(micros(1.0000004), 1000000);
            assert.equal(micros(-0.25), -250000);
            assert.throws(() => micros(2 ** 60), { code: 'FORMAT' });
        });

        test('host failures become library errors; library errors and aborts keep identity', () => {
            const wrapped = codecError(new TypeError('boom'), 'ENCODE', 'Encoder failed');
            assert.deepEqual([wrapped.code, wrapped.message], ['ENCODE', 'Encoder failed: boom']);
            const own = new MediaForgeError('mine', 'IO');
            assert.equal(codecError(own, 'DECODE', 'x'), own);
            const abort = new DOMException('stop', 'AbortError');
            assert.equal(codecError(abort, 'DECODE', 'x'), abort);
            assert.equal(isCodecFailure(wrapped), true);
            assert.equal(isCodecFailure(own), false, 'I/O is final');
        });

        test('a reported record is copied, not kept as a view', () => {
            const source = Uint8Array.of(1, 2, 3);
            const copy = bufferCopy(source.subarray(1));
            source[1] = 9;
            assert.deepEqual(copy, Uint8Array.of(2, 3));
        });

        test('closing a codec ignores one already closed or failing to close', () => {
            let closes = 0;
            closeCodec({ state: 'closed', close: () => closes++ });
            closeCodec({
                state: 'configured',
                close: () => {
                    closes++;
                    throw new Error('late');
                },
            });
            closeCodec(undefined);
            assert.equal(closes, 1);
        });
    });

    describe('host support', () => {
        test('a codec counts as available only with the class it consumes', () => {
            const { Decoder } = fakeAudioDecoder(() => null);
            let restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: undefined });
            try {
                assert.equal(hostCodecAvailable('AudioDecoder'), false);
            } finally {
                restore();
            }
            restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: FakeChunk });
            try {
                assert.equal(hostCodecAvailable('AudioDecoder'), true);
            } finally {
                restore();
            }
        });

        test('asks once per configuration, whatever the key order or undefined keys', async () => {
            const { Decoder, stats } = fakeAudioDecoder(() => null, {
                supported: config => config.codec === 'opus',
            });
            const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: FakeChunk });
            try {
                const config = {
                    codec: 'opus',
                    sampleRate: 48000,
                    description: Uint8Array.of(1, 2),
                };
                assert.equal((await queryHostCodec('AudioDecoder', config)).supported, true);
                await queryHostCodec('AudioDecoder', {
                    description: Uint8Array.of(1, 2),
                    sampleRate: 48000,
                    codec: 'opus',
                    extra: undefined,
                });
                assert.equal(stats.probes, 1);
                await queryHostCodec('AudioDecoder', {
                    ...config,
                    description: Uint8Array.of(1, 3),
                });
                assert.equal(stats.probes, 2, 'other bytes are another configuration');
                assert.equal(await hostSupports('AudioDecoder', { codec: 'aac' }), false);
            } finally {
                restore();
            }
        });

        test('a throwing support query reads as unsupported with its message', async () => {
            class Throwing {
                static isConfigSupported() {
                    throw new TypeError('invalid config');
                }
            }
            const restore = installGlobals({ AudioEncoder: Throwing, AudioData: FakeChunk });
            try {
                assert.deepEqual(await queryHostCodec('AudioEncoder', { codec: 'x' }), {
                    available: true,
                    supported: false,
                    error: 'invalid config',
                });
            } finally {
                restore();
            }
        });

        test('without the host class nothing is available', async () => {
            const restore = installGlobals({ VideoDecoder: undefined });
            try {
                assert.deepEqual(await queryHostCodec('VideoDecoder', {}), {
                    available: false,
                    supported: false,
                });
                assert.equal(await hostSupports('VideoDecoder', {}), false);
            } finally {
                restore();
            }
        });
    });

    describe('through the public API', () => {
        // 'x-ramp' is a test codec whose packets are little-endian 16-bit PCM, decoded both by a
        // plugin decoder and by the fake host.
        const s16Planes = (data, channels) => {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const frames = data.length / (2 * channels);
            return Array.from({ length: channels }, (_, channel) =>
                Float32Array.from(
                    { length: frames },
                    (_, frame) => view.getInt16((frame * channels + channel) * 2, true) / 32768,
                ),
            );
        };
        const rampDecoder = {
            id: 'ramp',
            codecs: ['x-ramp'],
            create: track => ({
                create: () => ({
                    decode: packet => [s16Planes(packet, track.channelCount)],
                    reset() {},
                }),
            }),
        };
        const rampTrack = (
            count = 24,
            channels = 1,
            value = (packet, at) => packet * 1000 - at * 7,
        ) => ({
            codec: 'x-ramp',
            sampleRate: 48000,
            channelCount: channels,
            duration: (count * 480) / 48000,
            samples: Array.from({ length: count }, (_, packet) => {
                const data = new Uint8Array(480 * 2 * channels);
                const view = new DataView(data.buffer);
                for (let at = 0; at < 480 * channels; at++)
                    view.setInt16(at * 2, value(packet, at), true);
                return {
                    offset: 0,
                    size: data.length,
                    data,
                    isKeyframe: true,
                    timestamp: (packet * 480) / 48000,
                    duration: 480 / 48000,
                };
            }),
        });
        const reader = async () => {
            throw new Error('inline packets are not read');
        };
        const source = (track, options = {}) =>
            createAudioTrackSource(track, reader, { decoders: [rampDecoder], ...options });
        async function planes(audio) {
            const joined = Array.from({ length: audio.channels }, () => []);
            for await (const chunk of audio.chunks())
                chunk.forEach((plane, channel) => joined[channel].push(...plane));
            return joined.map(values => Float32Array.from(values));
        }
        /** A host decoding x-ramp as `format` AudioData: 's16' interleaved, or float planes. */
        const rampHost = format =>
            fakeAudioDecoder(
                (decoder, chunk) => {
                    const channels = decoder.config.numberOfChannels;
                    return format === 's16'
                        ? fakeAudioData({
                              format,
                              samples: new Int16Array(chunk.data.slice().buffer),
                              channels,
                          })
                        : fakeAudioData({ samples: s16Planes(chunk.data, channels) });
                },
                { supported: config => config.codec === 'x-ramp' },
            );

        test('host output reaches the caller in blocks of several packets', async () => {
            const expected = await planes(source(rampTrack(), { builtinOnly: true }));
            const { Decoder, stats } = rampHost();
            const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: FakeChunk });
            try {
                const blocks = [];
                for await (const chunk of source(rampTrack()).chunks())
                    blocks.push(chunk[0].slice());
                assert.equal(stats.chunks.length, 24);
                assert(blocks.length <= 4, `${blocks.length} blocks for 24 packets`);
                assert.deepEqual(
                    Float32Array.from(blocks.flatMap(block => [...block])),
                    expected[0],
                );
            } finally {
                restore();
            }
        });

        test('integer host audio is scaled as the library reads PCM', async () => {
            // Stereo samples of both signs differ per packet and channel.
            const track = rampTrack(
                24,
                2,
                (packet, at) => (packet * 2900 - at * 31 + (at & 1) * 9000) % 32768,
            );
            const expected = await planes(source(track, { builtinOnly: true }));
            const { Decoder, stats } = rampHost('s16');
            const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: FakeChunk });
            try {
                assert.deepEqual(await planes(source(track)), expected);
                assert.equal(stats.decoders, 1);
            } finally {
                restore();
            }
        });

        /**
         * Installs an AAC-LC AudioEncoder that gives back one frame for every 1024 samples after
         * `delay` samples of its own: 1024, as AAC encoders have, or 0, as Chromium's on Windows.
         */
        function aacHost(delay) {
            class Encoder {
                state = 'unconfigured';
                encodeQueueSize = 0;
                static async isConfigSupported(config) {
                    return { supported: config.codec === 'mp4a.40.2', config };
                }
                constructor(init) {
                    this.init = init;
                    this.pending = delay;
                    this.emitted = 0;
                }
                configure(config) {
                    this.config = config;
                    this.state = 'configured';
                }
                emit() {
                    const { sampleRate, numberOfChannels } = this.config;
                    const description = buildAacAsc(sampleRate, numberOfChannels);
                    this.init.output(
                        new FakeChunk({
                            timestamp: Math.round(((this.emitted * 1024) / sampleRate) * 1e6),
                            duration: Math.round((1024 / sampleRate) * 1e6),
                            data: Uint8Array.of(0x21, 0x10, this.emitted & 0xff),
                        }),
                        this.emitted === 0 ? { decoderConfig: { description } } : undefined,
                    );
                    this.emitted++;
                }
                encode(audio) {
                    this.pending += audio.numberOfFrames;
                    for (; this.pending >= 1024; this.pending -= 1024) this.emit();
                }
                async flush() {
                    if (this.pending > 0) this.emit();
                    this.pending = 0;
                }
                close() {
                    this.state = 'closed';
                }
            }
            class Data {
                constructor(init) {
                    Object.assign(this, init);
                }
                close() {}
            }
            return installGlobals({ AudioEncoder: Encoder, AudioData: Data });
        }

        test('an AAC encoder without delay writes MP4 and MKV, not a MUX failure', async () => {
            for (const delay of [0, 1024]) {
                const restore = aacHost(delay);
                try {
                    for (const to of ['m4a', 'mp4', 'mkv', 'mov']) {
                        const result = await convert(toneWav(0.5), to, { audio: { codec: 'aac' } });
                        assert.deepEqual(
                            result.plan.tracks.map(track => track.encoder),
                            ['webcodecs'],
                        );
                        const [track] = (await inspect(result.blob)).tracks;
                        // Matroska times are milliseconds.
                        assert.ok(
                            Math.abs(track.duration - 0.5) < 1e-3,
                            `${to} of an encoder delay of ${delay}: ${track.duration} s`,
                        );
                    }
                } finally {
                    restore();
                }
            }
        });

        test('encodeFrames reads integer AudioData exactly', async () => {
            // Interleaved stereo s16 AudioData whose float copy divides positive samples by 32767,
            // as Chromium's does. The host encoder must be given the samples handed in, v / 32768.
            const given = [[], []];
            class Data {
                constructor({ samples, ...init }) {
                    Object.assign(this, init);
                    if (samples)
                        Object.assign(this, fakeAudioData({ format: 's16', samples, channels: 2 }));
                }
                close() {}
            }
            class Encoder {
                state = 'unconfigured';
                encodeQueueSize = 0;
                static async isConfigSupported(config) {
                    return { supported: config.codec === 'opus', config };
                }
                constructor(init) {
                    this.init = init;
                }
                configure(config) {
                    this.config = config;
                    this.state = 'configured';
                }
                encode(audio) {
                    assert.equal(audio.format, 'f32-planar');
                    const frames = audio.numberOfFrames;
                    for (let channel = 0; channel < 2; channel++)
                        given[channel].push(
                            ...audio.data.subarray(channel * frames, (channel + 1) * frames),
                        );
                    this.init.output(
                        new FakeChunk({
                            timestamp: audio.timestamp,
                            duration: Math.round((frames / 48000) * 1e6),
                            data: Uint8Array.of(0xf8, 0xff, 0xfe),
                        }),
                    );
                }
                async flush() {}
                close() {
                    this.state = 'closed';
                }
            }
            const restore = installGlobals({ AudioData: Data, AudioEncoder: Encoder });
            try {
                const blocks = Array.from({ length: 6 }, (_, block) =>
                    Int16Array.from({ length: 1920 }, (_, at) => block * 13000 - 32768 + at * 17),
                );
                async function* sound() {
                    for (const [block, samples] of blocks.entries())
                        yield new Data({ samples, timestamp: (block * 960 * 1e6) / 48000 });
                }
                await encodeFrames({ audio: sound() }, { to: 'webm' });
                for (let channel = 0; channel < 2; channel++) {
                    const expected = Float32Array.from(
                        blocks.flatMap(samples => [
                            ...samples.filter((_, at) => at % 2 === channel),
                        ]),
                        value => value / 32768,
                    );
                    assert.deepEqual(
                        Float32Array.from(given[channel].slice(0, expected.length)),
                        expected,
                        `channel ${channel}`,
                    );
                }
            } finally {
                restore();
            }
        });
    });
});
