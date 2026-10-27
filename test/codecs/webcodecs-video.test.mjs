import assert from 'node:assert/strict';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { FakeChunk, installGlobals } from '../helpers/fake-webcodecs.mjs';
import { FIXTURES } from '../helpers/new-format-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const video = await import(distUrl('esm/codecs/webcodecs/video.js'));
const { CodecLifetime } = await import(distUrl('esm/codecs/shared/codec-lifetime.js'));
const { DamageLog, HostVideoDecoder, HostVideoEncoder, DECODE_AHEAD, MAX_RECOVERIES } = video;
const { encodableFrame } = video;

/** A frame stand-in with a microsecond timestamp. */
class FakeFrame {
    constructor(timestamp, duration) {
        Object.assign(this, { timestamp, duration, closed: false });
    }
    close() {
        this.closed = true;
    }
}

/**
 * A VideoDecoder class: `respond(decoder, chunk, index)` returns the frames for a chunk (output in
 * the order given), or an Error to fail with. It holds `hold` chunks before outputting, as a
 * reordering decoder does, and fires 'dequeue' as its queue shrinks.
 */
function fakeVideoDecoder(respond, { hold = 0, refuseConfig = false } = {}) {
    const stats = { decoders: 0, chunks: [], closed: 0 };
    class Decoder extends EventTarget {
        state = 'unconfigured';
        decodeQueueSize = 0;
        ondequeue = null;
        queued = [];
        constructor(init) {
            super();
            this.init = init;
            stats.decoders++;
        }
        configure(config) {
            if (refuseConfig) throw new TypeError('codec not supported');
            this.config = config;
            this.state = 'configured';
        }
        decode(chunk) {
            const index = stats.chunks.length;
            stats.chunks.push(chunk);
            this.queued.push([chunk, index]);
            this.decodeQueueSize++;
            if (this.queued.length > hold) this.drain(this.queued.length - hold);
        }
        drain(count) {
            const batch = this.queued.splice(0, count);
            queueMicrotask(() => {
                for (const [chunk, index] of batch) {
                    if (this.state === 'closed') return;
                    this.decodeQueueSize--;
                    this.dispatchEvent(new Event('dequeue'));
                    const result = respond(this, chunk, index);
                    if (result instanceof Error) {
                        this.state = 'closed';
                        this.init.error(result);
                        return;
                    }
                    for (const frame of [result].flat()) if (frame) this.init.output(frame);
                }
            });
        }
        async flush() {
            this.drain(this.queued.length);
            await yieldTask();
        }
        close() {
            this.state = 'closed';
            stats.closed++;
        }
    }
    return { Decoder, stats };
}

/** A HostVideoDecoder on `Decoder`, collecting its pictures and warnings. */
function decoderOn(Decoder, { strict = false } = {}) {
    const restore = installGlobals({ VideoDecoder: Decoder, EncodedVideoChunk: FakeChunk });
    const pictures = [];
    const warnings = [];
    const lifetime = new CodecLifetime();
    try {
        const decoder = new HostVideoDecoder(
            { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
            lifetime,
            (picture, timing) => pictures.push([picture, timing]),
            { strict, warn: (code, message) => warnings.push([code, message]) },
        );
        return { decoder, pictures, warnings, lifetime, restore };
    } catch (error) {
        restore();
        throw error;
    }
}

const packet = (index, key = index === 0, rate = 3) => ({
    data: Uint8Array.of(index),
    timestamp: index / rate,
    duration: 1 / rate,
    isKeyframe: key,
});

/** Every chunk out as one frame with the chunk's timestamp. */
const echo = (_, chunk) => new FakeFrame(chunk.timestamp, chunk.duration);

/**
 * WebCodecs classes over I420 pictures: a frame copies out its visible rectangle, a VP8 encoder
 * packs the picture it encodes as I420 and the decoder unpacks it. With `codedPicture` the encoder
 * encodes the whole coded picture scaled into the configured size, as Firefox's does.
 */
function i420Codecs({ codedPicture = false } = {}) {
    const stats = { encoders: 0 };
    class Frame {
        constructor(source, init) {
            const own = source instanceof Frame;
            this.planes = own ? source.planes : source;
            this.format = own ? source.format : init.format;
            this.codedWidth = own ? source.codedWidth : init.codedWidth;
            this.codedHeight = own ? source.codedHeight : init.codedHeight;
            const whole = { x: 0, y: 0, width: this.codedWidth, height: this.codedHeight };
            this.visibleRect = init.visibleRect ?? (own ? source.visibleRect : whole);
            this.displayWidth = init.displayWidth ?? this.visibleRect.width;
            this.displayHeight = init.displayHeight ?? this.visibleRect.height;
            this.timestamp = init.timestamp ?? source.timestamp;
            this.duration = init.duration ?? source.duration ?? null;
            this.colorSpace = { toJSON: () => ({ matrix: 'bt709' }) };
            this.closed = false;
        }
        /** The luma at (x, y) of the coded picture and the chroma of its 2 x 2 block. */
        sample(x, y) {
            const { codedWidth: width, codedHeight: height, planes } = this;
            const chroma = (y >> 1) * (width >> 1) + (x >> 1);
            return [
                planes[y * width + x],
                planes[width * height + chroma],
                planes[width * height * 1.25 + chroma],
            ];
        }
        /** The I420 planes of `width` x `height` read from a picture at `at(x, y)`. */
        static pack(width, height, at) {
            const data = new Uint8Array(width * height * 1.5);
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const [luma, u, v] = at(x, y);
                    data[y * width + x] = luma;
                    const chroma = (y >> 1) * (width >> 1) + (x >> 1);
                    data[width * height + chroma] = u;
                    data[width * height * 1.25 + chroma] = v;
                }
            return data;
        }
        allocationSize() {
            return this.visibleRect.width * this.visibleRect.height * 1.5;
        }
        async copyTo(target) {
            const { x, y, width, height } = this.visibleRect;
            target.set(Frame.pack(width, height, (dx, dy) => this.sample(x + dx, y + dy)));
            return [
                { offset: 0, stride: width },
                { offset: width * height, stride: width / 2 },
                { offset: width * height * 1.25, stride: width / 2 },
            ];
        }
        close() {
            this.closed = true;
        }
    }
    class Encoder {
        state = 'unconfigured';
        constructor(init) {
            this.init = init;
            stats.encoders++;
        }
        configure(config) {
            this.config = config;
            this.state = 'configured';
        }
        encode(frame) {
            const { width, height } = this.config;
            const { x, y } = frame.visibleRect;
            const data = codedPicture
                ? Frame.pack(width, height, (dx, dy) =>
                      frame.sample(
                          Math.floor((dx * frame.codedWidth) / width),
                          Math.floor((dy * frame.codedHeight) / height),
                      ),
                  )
                : Frame.pack(width, height, (dx, dy) => frame.sample(x + dx, y + dy));
            this.init.output(new FakeChunk({ timestamp: 0, type: 'key', data, width, height }));
        }
        async flush() {}
        close() {
            this.state = 'closed';
        }
    }
    class Decoder {
        state = 'unconfigured';
        constructor(init) {
            this.init = init;
        }
        configure() {
            this.state = 'configured';
        }
        decode(chunk) {
            const { data, width, height } = chunk;
            this.init.output(
                new Frame(data, { format: 'I420', codedWidth: width, codedHeight: height }),
            );
        }
        async flush() {}
        close() {
            this.state = 'closed';
        }
    }
    const restore = installGlobals({
        VideoFrame: Frame,
        VideoEncoder: Encoder,
        VideoDecoder: Decoder,
    });
    return { Frame, stats, restore };
}

describe('webcodecs', () => {
    describe('video decoder configuration', () => {
        test('carries the coded size, record and colour names of a track', () => {
            const config = video.hostVideoDecoderConfig({
                codec: 'hvc1.2.4.L120.B0',
                width: 1920,
                height: 1080,
                codecConfig: Uint8Array.of(1),
                colour: { primaries: 9, transfer: 16, matrix: 9, fullRange: false },
            });
            assert.deepEqual(config, {
                codec: 'hvc1.2.4.L120.B0',
                codedWidth: 1920,
                codedHeight: 1080,
                hardwareAcceleration: 'no-preference',
                description: Uint8Array.of(1),
                colorSpace: {
                    primaries: 'bt2020',
                    transfer: 'pq',
                    matrix: 'bt2020-ncl',
                    fullRange: false,
                },
            });
        });

        test('code points WebCodecs cannot name are left out', () => {
            const config = video.hostVideoDecoderConfig({
                codec: 'vp8',
                colour: { primaries: 2, transfer: 2, matrix: 2 },
            });
            assert.equal(config.colorSpace, undefined);
            assert.equal(config.description, undefined);
        });

        test('PQ and HLG are the HDR transfers', () => {
            assert.deepEqual(['pq', 'hlg', 'bt709', null].map(video.isHdrTransfer), [
                true,
                true,
                false,
                false,
            ]);
        });
    });

    describe('decode damage', () => {
        const log = strict => {
            const warnings = [];
            return {
                warnings,
                damage: new DamageLog(
                    { strict, warn: (...pair) => warnings.push(pair) },
                    new CodecLifetime(),
                ),
            };
        };

        test('dropped packets are reported once decoding resumes at a keyframe', () => {
            const { warnings, damage } = log(false);
            damage.skip(0.5);
            damage.drop(0.25);
            damage.report(1);
            damage.report(2);
            assert.deepEqual(warnings, [
                [
                    'VIDEO_DECODE_RECOVERED',
                    'Dropped 2 video packet(s) from 0.250 s to the keyframe at 1.000 s',
                ],
            ]);
        });

        test('packets dropped at the end are reported up to the end', () => {
            const { warnings, damage } = log(false);
            damage.drop(3);
            damage.report(undefined);
            assert.match(warnings[0][1], /to the end$/);
        });

        test('strict decoding fails on a packet it cannot start with', () => {
            assert.throws(() => log(true).damage.skip(0), {
                code: 'DECODE',
                message: /needs a keyframe/,
            });
        });
    });

    describe('host video decoder', () => {
        test('pictures keep the exact timing of their packets', async () => {
            const { Decoder } = fakeVideoDecoder(echo);
            const { decoder, pictures, restore } = decoderOn(Decoder);
            try {
                for (let index = 0; index < 4; index++) await decoder.decode(packet(index));
                await decoder.flush(true);
                assert.deepEqual(
                    pictures.map(([, timing]) => [timing.timestamp, timing.duration]),
                    [0, 1, 2, 3].map(index => [index / 3, 1 / 3]),
                    'not the microseconds the host rounds them to',
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('reordered output takes the timing of the packet it came from', async () => {
            // Packets 0, 2, 1 in decode order; the decoder outputs 0, 1, 2.
            const order = [0, 2, 1];
            const { Decoder } = fakeVideoDecoder(
                (decoder, chunk, index) =>
                    index === 0
                        ? new FakeFrame(0)
                        : index === 2
                          ? [1, 2].map(at => new FakeFrame(stamps[at]))
                          : null,
                {},
            );
            const stamps = [];
            const { decoder, pictures, restore } = decoderOn(Decoder);
            try {
                for (const index of order) {
                    stamps[index] = Math.round((index / 3) * 1e6);
                    await decoder.decode(packet(index));
                }
                await decoder.flush(true);
                assert.deepEqual(
                    pictures.map(([, timing]) => timing.timestamp),
                    [0, 1 / 3, 2 / 3],
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('delta packets before the first keyframe are dropped and reported', async () => {
            const { Decoder, stats } = fakeVideoDecoder(echo);
            const { decoder, pictures, warnings, restore } = decoderOn(Decoder);
            try {
                await decoder.decode(packet(0, false));
                await decoder.decode(packet(1, false));
                await decoder.decode(packet(2, true));
                await decoder.flush(true);
                assert.equal(stats.chunks.length, 1);
                assert.equal(pictures.length, 1);
                assert.deepEqual(
                    warnings.map(([code]) => code),
                    ['VIDEO_DECODE_RECOVERED'],
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('strict decoding refuses a delta packet before any keyframe', async () => {
            const { Decoder } = fakeVideoDecoder(echo);
            const { decoder, restore } = decoderOn(Decoder, { strict: true });
            try {
                await assert.rejects(decoder.decode(packet(1, false)), { code: 'DECODE' });
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a decoder error restarts decoding at the next keyframe', async () => {
            // The second packet fails the first decoder; the next keyframe decodes on a new one.
            const { Decoder, stats } = fakeVideoDecoder((decoder, chunk, index) =>
                index === 1 ? new DOMException('corrupt', 'EncodingError') : echo(decoder, chunk),
            );
            const { decoder, pictures, warnings, restore } = decoderOn(Decoder);
            try {
                await decoder.decode(packet(0));
                await decoder.decode(packet(1, false));
                await yieldTask();
                await decoder.decode(packet(2, false));
                await decoder.decode(packet(3, true));
                await decoder.decode(packet(4, false));
                await decoder.flush(true);
                assert.equal(stats.decoders, 2);
                assert.deepEqual(
                    pictures.map(([, timing]) => Math.round(timing.timestamp * 3)),
                    [0, 3, 4],
                );
                assert.deepEqual(
                    warnings.map(([code]) => code),
                    ['VIDEO_DECODE_RECOVERED'],
                );
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a failing keyframe costs no earlier picture where pictures come late', async () => {
            // Each picture comes out when the next packet is decoded, as from Firefox's VP8
            // decoder, so the failure of the keyframe at 3 takes the picture of 2 with it: the
            // group of 2 is decoded again and flushed out, then decoding resumes at 6.
            const { Decoder, stats } = fakeVideoDecoder((decoder, chunk) => {
                if (chunk.data[0] === 3) return new DOMException('corrupt', 'EncodingError');
                const previous = decoder.previous;
                decoder.previous = chunk;
                return previous && echo(decoder, previous);
            });
            class Late extends Decoder {
                async flush() {
                    await super.flush();
                    const previous = this.previous;
                    this.previous = undefined;
                    if (previous && this.state !== 'closed') this.init.output(echo(this, previous));
                }
            }
            const { decoder, pictures, warnings, restore } = decoderOn(Late);
            try {
                for (let index = 0; index < 8; index++) {
                    await decoder.decode(packet(index, index % 3 === 0));
                    await yieldTask();
                }
                await decoder.flush(true);
                assert.deepEqual(
                    pictures.map(([, timing]) => Math.round(timing.timestamp * 3)),
                    [0, 1, 2, 6, 7],
                );
                assert.deepEqual(warnings, [
                    [
                        'VIDEO_DECODE_RECOVERED',
                        'Dropped 3 video packet(s) from 1.000 s to the keyframe at 2.000 s',
                    ],
                ]);
                assert.equal(stats.decoders, 3);
            } finally {
                decoder.close();
                restore();
            }
        });

        test('strict decoding fails on the first decoder error', async () => {
            const { Decoder } = fakeVideoDecoder(
                () => new DOMException('corrupt', 'EncodingError'),
            );
            const { decoder, restore } = decoderOn(Decoder, { strict: true });
            try {
                await decoder.decode(packet(0));
                await assert.rejects(decoder.flush(true), {
                    code: 'DECODE',
                    message: /Native video decode failed: corrupt/,
                });
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a decoder that never outputs fails the final flush', async () => {
            const { Decoder } = fakeVideoDecoder(() => null);
            const { decoder, restore } = decoderOn(Decoder);
            try {
                await decoder.decode(packet(0));
                await assert.rejects(decoder.flush(true), {
                    code: 'DECODE',
                    message: /produced no frames/,
                });
            } finally {
                decoder.close();
                restore();
            }
        });

        test(`keeps failing past ${MAX_RECOVERIES} restarts without a picture`, async () => {
            const { Decoder, stats } = fakeVideoDecoder(
                () => new DOMException('broken', 'EncodingError'),
            );
            const { decoder, restore } = decoderOn(Decoder);
            try {
                await assert.rejects(
                    (async () => {
                        for (let index = 0; index < 100; index++) {
                            await decoder.decode(packet(index, true));
                            await yieldTask();
                        }
                    })(),
                    { code: 'DECODE' },
                );
                assert.equal(stats.decoders, MAX_RECOVERIES + 1);
            } finally {
                decoder.close();
                restore();
            }
        });

        test('a refused configuration fails with DECODE naming the codec', () => {
            const { Decoder } = fakeVideoDecoder(echo, { refuseConfig: true });
            assert.throws(() => decoderOn(Decoder), {
                code: 'DECODE',
                message: /configure failed for 'vp8'/,
            });
        });

        test(`waits while more than ${DECODE_AHEAD} packets are queued`, async () => {
            const { Decoder } = fakeVideoDecoder(echo, { hold: 100 });
            const { decoder, restore } = decoderOn(Decoder);
            try {
                for (let index = 0; index <= DECODE_AHEAD; index++)
                    await decoder.decode(packet(index, true));
                let submitted = false;
                const next = decoder
                    .decode(packet(DECODE_AHEAD + 1, true))
                    .then(() => (submitted = true));
                await yieldTask();
                assert.equal(submitted, false, 'the queue is full');
                await decoder.flush(false);
                await next;
                assert.equal(submitted, true);
            } finally {
                decoder.close();
                restore();
            }
        });
    });

    describe('video encoder configuration', () => {
        const shape = { width: 640, height: 360, framerate: 30, bitrate: 1e6 };

        test('AVC and HEVC are length-prefixed in MP4 and FLV, Annex B elsewhere', () => {
            assert.equal(
                video.hostVideoEncoderConfig('avc1.42e01e', { ...shape, container: 'mp4' }).avc
                    .format,
                'avc',
            );
            assert.equal(
                video.hostVideoEncoderConfig('avc1.42e01e', { ...shape, container: 'ts' }).avc
                    .format,
                'annexb',
            );
            assert.equal(
                video.hostVideoEncoderConfig('hvc1.1.6.L93.B0', { ...shape, container: 'flv' }).hevc
                    .format,
                'hevc',
            );
            assert.equal(
                video.hostVideoEncoderConfig('vp8', { ...shape, container: 'webm' }).avc,
                undefined,
            );
        });

        test('asks for quality latency and no hardware preference unless told', () => {
            const plain = video.hostVideoEncoderConfig('vp8', { ...shape, container: 'webm' });
            assert.deepEqual(
                [plain.latencyMode, plain.hardwareAcceleration, plain.bitrateMode],
                ['quality', 'no-preference', undefined],
            );
            const live = video.hostVideoEncoderConfig('vp8', {
                ...shape,
                container: 'webm',
                latencyMode: 'realtime',
                hardwareAcceleration: 'prefer-hardware',
                bitrateMode: 'constant',
            });
            assert.deepEqual(
                [live.latencyMode, live.hardwareAcceleration, live.bitrateMode],
                ['realtime', 'prefer-hardware', 'constant'],
            );
        });

        /** Runs `body` with a VideoEncoder whose support query answers `supports(config)`. */
        async function withEncoderSupport(supports, body) {
            class Encoder {
                static async isConfigSupported(config) {
                    return { supported: supports(config), config };
                }
            }
            const restore = installGlobals({ VideoEncoder: Encoder, VideoFrame: FakeFrame });
            try {
                return await body();
            } finally {
                restore();
            }
        }

        test('takes the first profile the host accepts, at a level the output needs', async () => {
            const config = await withEncoderSupport(
                config => config.codec.startsWith('avc1.4d'),
                () =>
                    video.selectEncoderConfig(
                        { ...shape, codec: 'avc1', explicit: false, container: 'mp4' },
                        new CodecLifetime(),
                    ),
            );
            assert.match(config.codec, /^avc1\.4d00[0-9a-f]{2}$/);
            assert(
                parseInt(config.codec.slice(-2), 16) >= 30,
                'level 3 or above for 640x360 at 30 fps',
            );
        });

        test('refuses with ENCODE when nothing is accepted, FORMAT for 10-bit', async () => {
            await withEncoderSupport(
                () => false,
                async () => {
                    const request = { ...shape, codec: 'avc1', explicit: false, container: 'mp4' };
                    await assert.rejects(video.selectEncoderConfig(request, new CodecLifetime()), {
                        code: 'ENCODE',
                    });
                    await assert.rejects(
                        video.selectEncoderConfig(
                            { ...request, codec: 'hvc1', bitDepth: 10 },
                            new CodecLifetime(),
                        ),
                        {
                            code: 'FORMAT',
                            message: /10-bit/,
                        },
                    );
                },
            );
        });

        test('without a host VideoEncoder it fails with ENCODE', async () => {
            const restore = installGlobals({ VideoEncoder: undefined });
            try {
                await assert.rejects(
                    video.selectEncoderConfig(
                        { ...shape, codec: 'vp8', explicit: false, container: 'webm' },
                        new CodecLifetime(),
                    ),
                    { code: 'ENCODE', message: /no WebCodecs VideoEncoder/ },
                );
            } finally {
                restore();
            }
        });
    });

    describe('host video encoder', () => {
        /** A VideoEncoder that emits each frame at once, with `metadata` for the first. */
        function encoderOn(metadata, data = () => Uint8Array.of(1, 2)) {
            const encoded = [];
            class Encoder extends EventTarget {
                state = 'unconfigured';
                encodeQueueSize = 0;
                constructor(init) {
                    super();
                    this.init = init;
                }
                configure(config) {
                    this.config = config;
                    this.state = 'configured';
                }
                encode(frame, options) {
                    encoded.push(options.keyFrame);
                    const chunk = new FakeChunk({
                        timestamp: frame.timestamp,
                        duration: frame.duration,
                        type: options.keyFrame ? 'key' : 'delta',
                        data: data(options.keyFrame),
                    });
                    this.init.output(chunk, encoded.length === 1 ? metadata : undefined);
                }
                async flush() {}
                close() {
                    this.state = 'closed';
                }
            }
            const restore = installGlobals({ VideoEncoder: Encoder });
            const packets = [];
            const encoder = (codec = 'vp8', interval = 1) =>
                new HostVideoEncoder(
                    { codec, width: 16, height: 16 },
                    new CodecLifetime(),
                    interval,
                    packet => packets.push(packet),
                );
            return { encoded, packets, encoder, restore };
        }

        test('keyframes follow time: one per interval, from the first frame', () => {
            const { encoded, encoder, restore } = encoderOn();
            try {
                const host = encoder('vp8', 1);
                for (let index = 0; index < 5; index++)
                    host.submit(new FakeFrame(index * 500000, 500000), {
                        timestamp: index * 0.5,
                        duration: 0.5,
                    });
                host.submit(
                    new FakeFrame(2600000, 500000),
                    { timestamp: 2.6, duration: 0.5 },
                    true,
                );
                assert.deepEqual(encoded, [true, false, true, false, true, true]);
            } finally {
                restore();
            }
        });

        test("chunks stamped late by a reordering encoder get their frames' times", async () => {
            // Firefox's H.264 encodes one B-frame and stamps each chunk a frame late.
            for (const late of [0, 40000]) {
                const chunks = [];
                class Encoder extends EventTarget {
                    state = 'unconfigured';
                    encodeQueueSize = 0;
                    held = [];
                    constructor(init) {
                        super();
                        this.init = init;
                    }
                    configure() {
                        this.state = 'configured';
                    }
                    /** I0 P2 B1 P4 B3 ...: each odd frame waits for the one after it. */
                    encode(frame, options) {
                        const chunk = new FakeChunk({
                            timestamp: frame.timestamp + late,
                            duration: frame.duration,
                            type: options.keyFrame ? 'key' : 'delta',
                            data: Uint8Array.of(frame.timestamp / 40000),
                        });
                        if ((frame.timestamp / 40000) % 2) this.held.push(chunk);
                        else
                            for (const next of [chunk, ...this.held.splice(0)])
                                this.init.output(next);
                    }
                    async flush() {
                        for (const chunk of this.held.splice(0)) this.init.output(chunk);
                    }
                    close() {
                        this.state = 'closed';
                    }
                }
                const restore = installGlobals({ VideoEncoder: Encoder });
                try {
                    const host = new HostVideoEncoder(
                        { codec: 'avc1.64001f', width: 16, height: 16 },
                        new CodecLifetime(),
                        10,
                        packet => chunks.push(packet),
                    );
                    for (let index = 0; index < 6; index++)
                        host.submit(new FakeFrame(index * 40000, 40000), {
                            timestamp: index * 0.04,
                            duration: 0.04,
                        });
                    await host.flush();
                    const frames = [0, 2, 1, 4, 3, 5];
                    assert.deepEqual(
                        chunks.map(packet => packet.timestamp),
                        frames.map(index => index * 0.04),
                        `late ${late}`,
                    );
                    // Each decodes by the time every frame after it presents: never later than
                    // its own, never before the one before.
                    assert.deepEqual(
                        chunks.map(packet => packet.decodeTimestamp ?? packet.timestamp),
                        [0, 1, 1, 3, 3, 5].map(index => index * 0.04),
                    );
                } finally {
                    restore();
                }
            }
        });

        test('packets keep the exact timing of their frames and own their bytes', () => {
            const { packets, encoder, restore } = encoderOn();
            try {
                encoder().submit(new FakeFrame(333333, 333333), {
                    timestamp: 1 / 3,
                    duration: 1 / 3,
                });
                assert.deepEqual(
                    [
                        packets[0].timestamp,
                        packets[0].duration,
                        packets[0].isKeyframe,
                        [...packets[0].data],
                    ],
                    [1 / 3, 1 / 3, true, [1, 2]],
                );
            } finally {
                restore();
            }
        });

        test('the reported description and colour reach the first packet', () => {
            const description = Uint8Array.of(1, 0x64, 0, 0x1f);
            const { packets, encoder, restore } = encoderOn({
                decoderConfig: {
                    description,
                    colorSpace: {
                        primaries: 'bt709',
                        transfer: 'bt709',
                        matrix: 'bt709',
                        fullRange: false,
                    },
                },
            });
            try {
                encoder('avc1.64001f').submit(new FakeFrame(0, 40000), {
                    timestamp: 0,
                    duration: 0.04,
                });
                assert.deepEqual(packets[0].codecConfig, description);
                assert.notEqual(packets[0].codecConfig, description, 'a copy');
                assert.deepEqual(packets[0].colour, {
                    primaries: 1,
                    transfer: 1,
                    matrix: 1,
                    fullRange: false,
                });
            } finally {
                restore();
            }
        });

        test('AV1 without a reported description takes it from the first key unit', () => {
            // The low-overhead AV1 stream of an encoder: a temporal delimiter, its sequence
            // header, then frames.
            const unit = FIXTURES['av1.obu'].bytes();
            const { packets, encoder, restore } = encoderOn(undefined, () => unit);
            try {
                encoder('av01.0.00M.08').submit(new FakeFrame(0, 40000), {
                    timestamp: 0,
                    duration: 0.04,
                });
                assert.equal(packets[0].codecConfig?.[0], 0x81, 'an av1C record');
            } finally {
                restore();
            }
        });

        test('a refused configuration fails with ENCODE naming the codec', () => {
            class Refusing {
                constructor() {
                    this.state = 'unconfigured';
                }
                configure() {
                    throw new TypeError('no');
                }
                close() {
                    this.state = 'closed';
                }
            }
            const restore = installGlobals({ VideoEncoder: Refusing });
            try {
                assert.throws(
                    () => new HostVideoEncoder({ codec: 'vp8' }, new CodecLifetime(), 1, () => {}),
                    {
                        code: 'ENCODE',
                        message: /configure failed for 'vp8'/,
                    },
                );
            } finally {
                restore();
            }
        });
    });

    describe('frames for the encoder', () => {
        /** A 64 x 32 picture whose luma counts its columns. */
        const counted = Frame =>
            new Frame(
                Frame.pack(64, 32, x => [x * 3, 100, 150]),
                {
                    format: 'I420',
                    codedWidth: 64,
                    codedHeight: 32,
                    timestamp: 40000,
                },
            );
        const pixels = async picture => {
            const data = new Uint8Array(picture.allocationSize());
            await picture.copyTo(data);
            return data;
        };

        test('a crop goes as a view where encoders encode it, else as a copy', async () => {
            for (const codedPicture of [false, true]) {
                const { Frame, restore } = i420Codecs({ codedPicture });
                try {
                    const visibleRect = { x: 16, y: 8, width: 32, height: 16 };
                    const view = new Frame(counted(Frame), { visibleRect });
                    const frame = await encodableFrame(view, new CodecLifetime());
                    assert.equal(frame === view, !codedPicture, `codedPicture: ${codedPicture}`);
                    assert.deepEqual(
                        [frame.displayWidth, frame.displayHeight, frame.timestamp],
                        [32, 16, 40000],
                    );
                    assert.deepEqual(await pixels(frame), await pixels(view));
                    assert.equal(view.closed, false, 'the caller keeps the view');
                } finally {
                    restore();
                }
            }
        });

        test('a frame showing its whole picture goes as it is, unprobed', async () => {
            const { Frame, stats, restore } = i420Codecs({ codedPicture: true });
            try {
                const whole = counted(Frame);
                assert.equal(await encodableFrame(whole, new CodecLifetime()), whole);
                assert.equal(stats.encoders, 0);
            } finally {
                restore();
            }
        });
    });
});
