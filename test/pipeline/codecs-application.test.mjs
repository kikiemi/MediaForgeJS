import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, inspect, open } from 'mediaforgejs';
import { Mp4Muxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { createProResDecoder, prores, proResVideoCodec } from '../../packages/prores/index.js';
import { packetOf } from '../helpers/media-packets.mjs';
import { codecParts, readerPart } from '../helpers/parts.mjs';
import { proresFrames } from '../helpers/prores-fixtures.mjs';
import { proresVariants } from '../helpers/prores-variants.mjs';
import { installWorkflowVideoCodecs, vp8Packet } from '../helpers/workflow-video-codecs.mjs';

// Application video codecs as plugins, here the ProRes package and wrapped copies of it: they
// decode and encode in conversions as the library's codecs do, own their frames once, and report
// their failures with the library's codes.

/** A lite MediaForge whose only video codec plugin is `codec`. */
const forgeWith = (codec, extra = {}) =>
    new lite.MediaForge({ plugins: [{ name: 'prores', ...codecParts(codec), ...extra }] });
const target = { to: 'mov', video: { codec: 'apcn' }, allowPrecisionLoss: true };

/** Two ProRes pictures in MOV, or with `extras` in Matroska beside two sounds and captions. */
async function inputVideo({
    codec = 'apch',
    data = proresFrames.apch,
    extras = false,
    width = 32,
    height = 24,
} = {}) {
    const sink = new MemorySink();
    const Muxer = extras ? WebMMuxer : Mp4Muxer;
    const muxer = new Muxer(
        {
            format: extras ? 'mkv' : 'mov',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            title: 'Provider movie',
            video: {
                id: 3,
                type: 'video',
                codec,
                width,
                height,
                framerate: 25,
                name: 'Picture',
                language: 'eng',
            },
            ...(extras
                ? {
                      audio: {
                          id: 7,
                          type: 'audio',
                          codec: 'pcm-s16le',
                          sampleRate: 48000,
                          channelCount: 1,
                          language: 'eng',
                          name: 'Main',
                      },
                      extraAudioTracks: [
                          {
                              id: 9,
                              type: 'audio',
                              codec: 'pcm-s16le',
                              sampleRate: 48000,
                              channelCount: 1,
                              language: 'jpn',
                              name: 'Commentary',
                              commentary: true,
                          },
                      ],
                      subtitleTracks: [
                          { id: 11, codec: 'text/utf8', language: 'eng', name: 'Captions' },
                      ],
                  }
                : {}),
        },
        sink,
    );
    for (let index = 0; index < 2; index++) {
        const timing = { timestamp: index * 0.04, isKeyframe: true };
        muxer.addVideoChunk({ ...timing, data, duration: 0.04, trackType: 'video' });
        if (extras) {
            const sound = { ...timing, duration: 2 / 48000, trackType: 'audio' };
            muxer.addAudioChunk({ ...sound, data: Uint8Array.of(0, 1, 0, 2) });
            muxer.addExtraAudioChunk(0, { ...sound, data: Uint8Array.of(0, 3, 0, 4) });
        }
    }
    if (extras)
        muxer.addSubtitleChunk({
            data: new TextEncoder().encode('Actual caption'),
            timestamp: 0,
            duration: 0.08,
            isKeyframe: true,
            trackType: 'subtitle',
        });
    await muxer.finalize();
    return sink.toBlob();
}

/** The codec, packet count and dimensions of the first track of a written file. */
async function firstTrack(blob) {
    const { tracks } = await inspect(blob, { sampleCounts: true });
    return tracks[0];
}

describe('pipeline/codecs: application video codecs', () => {
    test('ProRes is decoded and encoded by the plugin; the title stays', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo();
        assert.equal((await forge.check(input, target)).supported, true);
        const { blob } = await forge.convert(input, target);
        const media = await open(blob);
        const decoder = await createProResDecoder({ codec: 'apcn', width: 32, height: 24 });
        try {
            assert.equal(media.title, 'Provider movie');
            assert.equal(media.tracks[0].codec, 'apcn');
            for (let index = 0; index < 2; index++) {
                const frame = await decoder.decode(
                    await packetOf(media, media.tracks[0].id, index),
                );
                try {
                    assert.equal(frame.timestamp, index * 0.04);
                    const rgba = await frame.toRgba({ allowPrecisionLoss: true });
                    assert.equal(rgba.data.length, 32 * 24 * 4);
                    assert.ok(rgba.data.some((byte, at) => at % 4 !== 3 && byte > 32));
                } finally {
                    frame.close();
                }
            }
        } finally {
            await decoder.close();
            media.close();
        }
    });

    test('frames() and thumbnail() decode with the plugin, not DECODE', async () => {
        const forge = new lite.MediaForge({ plugins: [prores] });
        const input = await inputVideo();
        const frames = [];
        for await (const frame of forge.frames(input)) frames.push(frame);
        assert.deepEqual(
            frames.map(frame => [frame.timestamp, frame.width, frame.height]),
            [
                [0, 32, 24],
                [0.04, 32, 24],
            ],
        );
        const media = await open(input);
        const decoder = await createProResDecoder({ codec: 'apch', width: 32, height: 24 });
        try {
            const frame = await decoder.decode(await packetOf(media, media.tracks[0].id, 1));
            try {
                const rgba = await frame.toRgba({ allowPrecisionLoss: true });
                assert.deepEqual(frames[1].data, rgba.data);
            } finally {
                frame.close();
            }
        } finally {
            await decoder.close();
            media.close();
        }
        const { blob } = await forge.thumbnail(input, { time: 0.04, to: 'png' });
        assert.equal(blob.type, 'image/png');
    });

    test("without the plugin 'apcn' names no codec: ignored, or refused strictly", async () => {
        const input = await inputVideo();
        const unknown = await new MediaForge().check(input, target);
        assert.ok(
            unknown.warnings.some(
                warning =>
                    warning.code === 'OPTION_IGNORED' && /video\.codec/.test(warning.message),
            ),
        );
        const strict = await new MediaForge({ optionPolicy: 'strict' }).check(input, target);
        assert.equal(strict.code, 'INPUT');
        const viaPlugin = new MediaForge({ plugins: { add: [prores] } });
        const written = await firstTrack((await viaPlugin.convert(input, target)).blob);
        assert.deepEqual([written.codec, written.sampleCount], ['apcn', 2]);
    });

    test('a loss of precision is refused with allowPrecisionLoss: false', async () => {
        const forge = forgeWith(proResVideoCodec);
        const refused = await forge.check(await inputVideo(), {
            ...target,
            allowPrecisionLoss: false,
        });
        assert.equal(refused.supported, false);
        assert.match(refused.reason, /allowPrecisionLoss/);
    });

    test('the other tracks are copied beside the encoded video', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo({ extras: true });
        const media = await open((await forge.convert(input, { ...target, to: 'mkv' })).blob);
        try {
            assert.equal(media.tracks.length, 4);
            for (const [id, name, data] of [
                [7, 'Main', Uint8Array.of(0, 1, 0, 2)],
                [9, 'Commentary', Uint8Array.of(0, 3, 0, 4)],
                [11, 'Captions', new TextEncoder().encode('Actual caption')],
            ]) {
                assert.equal(media.tracks.find(track => track.id === id).name, name);
                assert.deepEqual((await packetOf(media, id)).data, data);
            }
        } finally {
            media.close();
        }
    });

    test('video settings that change nothing copy the pictures', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo();
        for (const video of [
            { width: 32, height: 24 },
            { width: 0, height: 0, fps: 0, bitrate: 0 },
        ]) {
            const media = await open((await forge.convert(input, { to: 'mov', video })).blob);
            assert.deepEqual((await packetOf(media, media.tracks[0].id)).data, proresFrames.apch);
            media.close();
        }
    });

    test('audio settings with no sound are ignored and reported, refused strictly', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo();
        const soundless = { ...target, audio: { sampleRate: 24000 } };
        const ignored = await forge.check(input, soundless);
        assert.equal(ignored.supported, true, ignored.reason);
        assert.ok(ignored.warnings.some(warning => warning.code === 'OPTION_IGNORED'));
        const strict = await forge.check(input, { ...soundless, open: { validation: 'strict' } });
        assert.equal(strict.supported, false);
    });

    test("an application decoder's pictures are resized on the CPU", async () => {
        const forge = forgeWith(proResVideoCodec);
        const video = { codec: 'apcn', width: 16 };
        const written = await firstTrack(
            (await forge.convert(await inputVideo(), { ...target, video })).blob,
        );
        assert.deepEqual([written.width, written.height], [16, 12]);
    });

    test('interlaced pictures are encoded as frames, reported once', async () => {
        const forge = forgeWith(proResVideoCodec);
        const support = await forge.check(await inputVideo(proresVariants.topFieldFirst), target);
        assert.equal(support.supported, true);
        const interlaced = support.warnings.filter(warning => warning.code === 'VIDEO_INTERLACED');
        assert.equal(interlaced.length, 1);
    });

    test('alpha the output cannot keep is dropped and reported, or refused strictly', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo({ codec: 'ap4h', data: proresFrames.ap4h });
        const alpha = await forge.check(input, target);
        assert.equal(alpha.supported, true, alpha.reason);
        const dropped = alpha.warnings.filter(warning => warning.code === 'ALPHA_DROPPED');
        assert.equal(dropped.length, 1);
        const strict = await forge.check(input, { ...target, open: { validation: 'strict' } });
        assert.equal(strict.supported, false);
        assert.match(strict.reason, /alpha/i);
    });

    test("an application encoder's own error is ENCODE in check() and convert()", async () => {
        const refusing = forgeWith({
            ...proResVideoCodec,
            async createEncoder(config) {
                const encoder = await proResVideoCodec.createEncoder(config);
                return {
                    encode: () => Promise.reject(new Error('encoder refused')),
                    flush: () => encoder.flush(),
                    close: () => encoder.close(),
                };
            },
        });
        const input = await inputVideo();
        const refused = await refusing.check(input, target);
        assert.deepEqual([refused.supported, refused.code], [false, 'ENCODE']);
        assert.match(refused.reason, /encoder refused/);
        await assert.rejects(
            refusing.convert(input, target),
            error => error.code === 'ENCODE' && /encoder refused/.test(error.message),
        );
    });

    test('a failing close of an application encoder is reported; the output stands', async () => {
        const forge = forgeWith({
            ...proResVideoCodec,
            async createEncoder(config) {
                const encoder = await proResVideoCodec.createEncoder(config);
                return {
                    encode: frame => encoder.encode(frame),
                    async close() {
                        await encoder.close();
                        throw new Error('Synthetic release error');
                    },
                };
            },
        });
        const support = await forge.check(await inputVideo(), target);
        assert.equal(support.supported, true);
        assert.ok(support.warnings.some(warning => warning.code === 'CODEC_CLOSE_FAILED'));
    });

    test('a new decoder for each configuration of a track; each frame owned once', async () => {
        const seen = [];
        const counts = { decoderCloses: 0, encoderCloses: 0, live: 0, peak: 0, supports: 0 };
        const observed = {
            ...proResVideoCodec,
            supportsDecode(codec) {
                counts.supports++;
                return proResVideoCodec.supportsDecode(codec);
            },
            async createDecoder(config) {
                seen.push([...config.description]);
                config.description.fill(99);
                const decoder = await proResVideoCodec.createDecoder(config);
                return {
                    async decode(packet) {
                        const frame = await decoder.decode(packet);
                        counts.live++;
                        counts.peak = Math.max(counts.peak, counts.live);
                        const close = frame.close.bind(frame);
                        frame.close = () => {
                            assert.equal(frame.closed, false);
                            counts.live--;
                            close();
                        };
                        return frame;
                    },
                    flush: () => decoder.flush(),
                    close() {
                        counts.decoderCloses++;
                        return decoder.close();
                    },
                };
            },
            async createEncoder(config) {
                const encoder = await proResVideoCodec.createEncoder(config);
                return {
                    encode: frame => encoder.encode(frame),
                    flush: () => encoder.flush(),
                    close() {
                        counts.encoderCloses++;
                        return encoder.close();
                    },
                };
            },
        };
        const reader = {
            formats: ['provider-config'],
            async read() {
                const sample = {
                    data: proresFrames.apch,
                    offset: 0,
                    size: proresFrames.apch.length,
                };
                return {
                    audioTracks: [],
                    videoTracks: [
                        {
                            id: 3,
                            codec: 'apch',
                            width: 32,
                            height: 24,
                            sampleRate: 0,
                            channelCount: 0,
                            duration: 0.08,
                            codecConfigurations: [10, 20].map(value => ({
                                codec: 'apch',
                                width: 32,
                                height: 24,
                                codecConfig: Uint8Array.of(value),
                            })),
                            samples: [0, 1].map(index => ({
                                ...sample,
                                timestamp: index * 0.04,
                                duration: 0.04,
                                isKeyframe: true,
                                codecConfigIndex: index,
                            })),
                        },
                    ],
                };
            },
        };
        const media = await forgeWith(observed, { readers: [readerPart(reader)] }).open(
            proresFrames.apch,
            { format: 'provider-config' },
        );
        try {
            assert.equal((await media.check(target)).supported, true);
            // The plugin's methods were taken when it was added; changing them changes nothing.
            observed.createDecoder = () => {
                throw new Error('a captured factory is not replaced');
            };
            observed.supportsDecode = () => false;
            await media.convert(target);
        } finally {
            media.close();
        }
        assert.deepEqual(seen, [[10], [20], [10], [20]], 'a copy of each configuration, each run');
        assert.deepEqual(
            [counts.decoderCloses, counts.encoderCloses, counts.live, counts.peak, counts.supports],
            [4, 2, 0, 1, 1],
        );
    });

    for (const phase of ['factory', 'frame'])
        test(
            `an abort while the decoder ${phase === 'factory' ? 'is made' : 'decodes'} closes it`,
            { timeout: 10_000 },
            async () => {
                let started;
                const ready = new Promise(resolve => (started = resolve));
                let release;
                let closes = 0;
                let lateFrame;
                const abortCodec = {
                    ...proResVideoCodec,
                    async createDecoder(config) {
                        if (phase === 'factory') {
                            started();
                            return new Promise(resolve => {
                                release = () =>
                                    resolve({
                                        decode() {
                                            throw new Error('an aborted factory does not decode');
                                        },
                                        close() {
                                            closes++;
                                        },
                                    });
                            });
                        }
                        const decoder = await proResVideoCodec.createDecoder(config);
                        return {
                            async decode(packet) {
                                lateFrame = await decoder.decode(packet);
                                started();
                                return new Promise(resolve => (release = () => resolve(lateFrame)));
                            },
                            close() {
                                closes++;
                                return decoder.close();
                            },
                        };
                    },
                };
                const controller = new AbortController();
                const cancelled = forgeWith(abortCodec).convert(await inputVideo(), {
                    ...target,
                    signal: controller.signal,
                });
                await ready;
                controller.abort();
                // The call settles while the decoder still holds on.
                await assert.rejects(cancelled, error => error.code === 'ABORT');
                release();
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(closes, 1);
                if (lateFrame)
                    assert.equal(lateFrame.closed, true, 'a frame that came late is closed');
            },
        );
});

describe('pipeline/codecs: application codecs beside the host', () => {
    test('the host encodes and decodes beside the plugin; frames cross once', async () => {
        const forge = forgeWith(proResVideoCodec);
        const input = await inputVideo();
        const host = installWorkflowVideoCodecs({ lateFrame: true });
        try {
            const vp8 = await forge.convert(input, {
                to: 'webm',
                video: { codec: 'vp8' },
                allowPrecisionLoss: true,
            });
            const encoded = await open(vp8.blob);
            assert.deepEqual([encoded.tracks[0].codec, host.flushes], ['vp8', 1]);
            assert.deepEqual(host.keyFrames, [true, false], 'keyframes by time, not per batch');
            assert.equal((await packetOf(encoded, encoded.tracks[0].id, 1)).timestamp, 0.04);
            encoded.close();
            const mp4 = await forge.convert(input, { to: 'mp4', allowPrecisionLoss: true });
            assert.match((await firstTrack(mp4.blob)).codec, /^avc1/);
            const hostInput = await inputVideo({ codec: 'vp8', data: vp8Packet, extras: true });
            const { blob: fromHost } = await forge.convert(hostInput, { ...target, to: 'mkv' });
            const pictures = await firstTrack(fromHost);
            const decoded = await open(fromHost);
            try {
                assert.equal(decoded.tracks[0].codec, 'apcn');
                assert.equal(decoded.tracks.length, 4);
                assert.equal(pictures.sampleCount, 2, 'the final flush drains reordered frames');
                assert.equal(host.planeCopies, 2, 'the bridge copies each plane set once a frame');
                assert.equal(host.rgbaConversions, 1, "the host's RGBA copy is probed once");
                const bridged = await createProResDecoder({ codec: 'apcn', width: 32, height: 24 });
                try {
                    const frame = await bridged.decode(
                        await packetOf(decoded, decoded.tracks[0].id),
                    );
                    try {
                        const [red, green, blue] = (
                            await frame.toRgba({ allowPrecisionLoss: true })
                        ).data;
                        assert.ok(red > 240 && green < 10 && blue < 10, `${red},${green},${blue}`);
                    } finally {
                        frame.close();
                    }
                } finally {
                    await bridged.close();
                }
            } finally {
                decoded.close();
            }
            // A bitrate in bits per second reaches the host encoder as given, however low.
            const configured = host.configurations.length;
            await forge.convert(input, {
                to: 'webm',
                video: { codec: 'vp8', bitrate: 58_206 },
                allowPrecisionLoss: true,
            });
            assert.ok(
                host.configurations.slice(configured).some(config => config.bitrate === 58_206),
            );
            await Promise.resolve();
            host.assertClosed();
        } finally {
            host.restore();
        }
    });

    test('a host encoder failing is ENCODE, everything closed', async () => {
        const host = installWorkflowVideoCodecs({ encodeFailure: true });
        try {
            const failed = await forgeWith(proResVideoCodec).check(await inputVideo(), {
                to: 'webm',
                video: { codec: 'vp8' },
                allowPrecisionLoss: true,
            });
            assert.equal(failed.code, 'ENCODE');
            host.assertClosed();
        } finally {
            host.restore();
        }
    });
});
