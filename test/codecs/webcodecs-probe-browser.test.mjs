import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import { encodeBmp, encodeFlac, encodeIco } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { player } from 'mediaforgejs-player';
import { PATTERN, maskedDifference, patternRgba, transformedPattern } from '../helpers/pattern.mjs';

// TEMPORARY diagnostics of the host's WebCodecs, canvas, image decoding and playback, reported as
// skip reasons (JSON) so that the CI log shows them; removed once the browser tests pass.

const inBrowser = typeof document !== 'undefined';
const internal = path => import(`/dist/esm/${path}.js`);
const hex = (bytes, n = 24) =>
    [...new Uint8Array(bytes).subarray(0, n)].map(b => b.toString(16).padStart(2, '0')).join('');
const text = error => (error ? `${error.name}: ${error.message}` : undefined);
const report = (t, out) => t.skip(`PROBE ${JSON.stringify(out)}`);

async function demux(blob) {
    const media = await open(blob);
    try {
        const track = media.tracks[0];
        const packets = [];
        for await (const packet of media.packets({ trackIds: [track.id] }))
            packets.push({
                data: packet.data.slice(),
                timestamp: packet.timestamp,
                duration: packet.duration,
                key: packet.isKeyframe,
            });
        return { track, packets };
    } finally {
        media.close();
    }
}

const summary = config =>
    Object.fromEntries(
        Object.entries(config).map(([key, value]) => [
            key,
            ArrayBuffer.isView(value) || value instanceof ArrayBuffer
                ? `${value.byteLength}:${hex(value, 48)}`
                : value,
        ]),
    );

async function audioDecode(config, packets) {
    const out = { config: summary(config) };
    try {
        out.supported = (await AudioDecoder.isConfigSupported(config)).supported;
    } catch (error) {
        out.supported = text(error);
    }
    let failure;
    let outputs = 0;
    let frames = 0;
    const decoder = new AudioDecoder({
        output: data => {
            outputs++;
            frames += data.numberOfFrames;
            out.format ??= data.format;
            data.close();
        },
        error: error => (failure ??= error),
    });
    try {
        decoder.configure(config);
        for (const packet of packets)
            decoder.decode(
                new EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round(packet.timestamp * 1e6),
                    duration: Math.round((packet.duration ?? 0) * 1e6),
                    data: packet.data,
                }),
            );
        await decoder.flush();
    } catch (error) {
        failure ??= error;
    }
    if (decoder.state !== 'closed') decoder.close();
    return { ...out, outputs, frames, error: text(failure) };
}

async function videoDecode(config, packets, keep) {
    const out = { config: summary(config) };
    try {
        out.supported = (await VideoDecoder.isConfigSupported(config)).supported;
    } catch (error) {
        out.supported = text(error);
    }
    let failure;
    let outputs = 0;
    const decoder = new VideoDecoder({
        output: frame => {
            outputs++;
            if (!out.frame)
                out.frame = {
                    format: frame.format,
                    coded: [frame.codedWidth, frame.codedHeight],
                    display: [frame.displayWidth, frame.displayHeight],
                    visible: frame.visibleRect && [
                        frame.visibleRect.x,
                        frame.visibleRect.y,
                        frame.visibleRect.width,
                        frame.visibleRect.height,
                    ],
                    colour: frame.colorSpace?.toJSON?.(),
                };
            if (keep && !out.kept) out.kept = frame;
            else frame.close();
        },
        error: error => (failure ??= error),
    });
    try {
        decoder.configure(config);
        for (const packet of packets)
            decoder.decode(
                new EncodedVideoChunk({
                    type: packet.key ? 'key' : 'delta',
                    timestamp: Math.round(packet.timestamp * 1e6),
                    data: packet.data,
                }),
            );
        await decoder.flush();
    } catch (error) {
        failure ??= error;
    }
    if (decoder.state !== 'closed') decoder.close();
    const kept = out.kept;
    delete out.kept;
    return { ...out, outputs, error: text(failure), kept };
}

/** 1.5 s of the pattern as VP8 in WebM, as the transform tests make it, and the encoder's colour. */
async function patternVp8(colour) {
    const chunks = [];
    let reported;
    const VP8 = { codec: 'vp8', width: PATTERN.width, height: PATTERN.height, framerate: 10 };
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            if (metadata?.decoderConfig) reported ??= metadata.decoderConfig.colorSpace ?? null;
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({
                data,
                timestamp: chunk.timestamp / 1e6,
                duration: 0.1,
                isKeyframe: chunk.type === 'key',
                trackType: 'video',
            });
        },
        error: () => undefined,
    });
    encoder.configure({ ...VP8, bitrate: 2_000_000 });
    const rgba = patternRgba();
    for (let index = 0; index < 15; index++) {
        const frame = new VideoFrame(rgba, {
            format: 'RGBA',
            codedWidth: PATTERN.width,
            codedHeight: PATTERN.height,
            timestamp: index * 100000,
            duration: 100000,
        });
        encoder.encode(frame, { keyFrame: index % 5 === 0 });
        frame.close();
    }
    await encoder.flush();
    encoder.close();
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'webm',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            videoColour: colour ?? { primaries: 6, transfer: 6, matrix: 6, fullRange: false },
            video: { id: 1, type: 'video', ...VP8 },
        },
        sink,
    );
    for (const chunk of chunks) muxer.addVideoChunk(chunk);
    await muxer.finalize();
    return { blob: sink.toBlob('video/webm'), reported: reported?.toJSON?.() ?? reported };
}

function rgbaOf(draw, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    draw(context);
    return context.getImageData(0, 0, width, height).data;
}

function meanDifference(a, b) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < a.length; index += 4)
        for (let channel = 0; channel < 3; channel++) {
            sum += Math.abs(a[index + channel] - b[index + channel]);
            count++;
        }
    return +(sum / count).toFixed(2);
}

function oracle(rgba, width, height, crop) {
    const expected = transformedPattern({ crop, width, height, fit: 'fill' });
    return +maskedDifference(rgba, expected.rgba, expected.mask).toFixed(2);
}

/** The picture of a file at 0.2 s, decoded by the host without a colour space, as the tests do. */
async function shownPicture(blob) {
    const { track, packets } = await demux(blob);
    const frames = [];
    const decoder = new VideoDecoder({ output: frame => frames.push(frame), error: () => {} });
    decoder.configure({
        codec: track.codec,
        codedWidth: track.width,
        codedHeight: track.height,
        ...(track.codecConfig ? { description: track.codecConfig } : {}),
    });
    for (const packet of packets)
        decoder.decode(
            new EncodedVideoChunk({
                type: packet.key ? 'key' : 'delta',
                timestamp: Math.round(packet.timestamp * 1e6),
                data: packet.data,
            }),
        );
    await decoder.flush();
    decoder.close();
    const shown = frames.filter(frame => frame.timestamp <= 200001).at(-1);
    const width = shown.displayWidth;
    const height = shown.displayHeight;
    const rgba = rgbaOf(context => context.drawImage(shown, 0, 0), width, height);
    for (const frame of frames) frame.close();
    return { width, height, rgba, colour: track.colour };
}

describe('host probe', { skip: !inBrowser && 'runs in a browser (npm run test:browser)' }, () => {
    test('probe: FLAC host decode', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { flacStreamHeader } = await internal('core/codec-config/audio/flac-frame');
            const { hostAudioDecoderConfig } = await internal('codecs/webcodecs/audio');
            const { deinterleave, tone } = await import('../helpers/pcm.mjs');
            const sources = {
                library: async () =>
                    new Blob([
                        await encodeFlac(deinterleave(tone(48000, 2, 9600), 2), {
                            sampleRate: 48000,
                        }),
                    ]),
                fixture: async () =>
                    new Blob([
                        await (
                            await fetch('/test/fixtures/flac/lpc-order32-24bit.flac')
                        ).arrayBuffer(),
                    ]),
            };
            for (const [name, make] of Object.entries(sources)) {
                const entry = (out[name] = {});
                try {
                    const blob = await make();
                    const { track, packets } = await demux(blob);
                    entry.track = {
                        codec: track.codec,
                        rate: track.sampleRate,
                        channels: track.channelCount,
                        config:
                            track.codecConfig &&
                            `${track.codecConfig.length}:${hex(track.codecConfig, 48)}`,
                    };
                    entry.packets = [
                        packets.length,
                        ...packets.slice(0, 3).map(p => `${p.data.length}:${hex(p.data, 12)}`),
                    ];
                    const header = flacStreamHeader(track.codecConfig);
                    const library = hostAudioDecoderConfig(track);
                    const notLast = header.slice();
                    notLast[4] = 0;
                    const shape = {
                        codec: 'flac',
                        sampleRate: track.sampleRate,
                        numberOfChannels: track.channelCount,
                    };
                    const fileHead = new Uint8Array(await blob.arrayBuffer()).slice(0, 8192);
                    const variants = {
                        library,
                        notLast: { ...shape, description: notLast },
                        bare: { ...shape, description: header.subarray(8) },
                        none: shape,
                    };
                    for (const [variant, config] of Object.entries(variants)) {
                        entry[`${variant}/1`] = await audioDecode(config, packets.slice(0, 1));
                        entry[`${variant}/all`] = await audioDecode(config, packets);
                    }
                    entry.head = hex(fileHead, 64);
                } catch (error) {
                    entry.error = text(error);
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: VP9 and AV1 host decode', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { supportStream } = await import('../helpers/support-streams.mjs');
            const { hostVideoDecoderConfig } = await internal('codecs/webcodecs/video');
            for (const name of ['vp9.webm', 'av1.mp4', 'vp8.webm']) {
                const entry = (out[name] = {});
                try {
                    const { track, packets } = await demux(new Blob([await supportStream(name)]));
                    entry.track = {
                        codec: track.codec,
                        size: [track.width, track.height],
                        config:
                            track.codecConfig &&
                            `${track.codecConfig.length}:${hex(track.codecConfig)}`,
                        colour: track.colour,
                        packets: packets.length,
                    };
                    const library = hostVideoDecoderConfig(track);
                    entry.library = await videoDecode(library, packets);
                    for (const acceleration of ['prefer-software', 'prefer-hardware'])
                        entry[acceleration] = await videoDecode(
                            { ...library, hardwareAcceleration: acceleration },
                            packets,
                        );
                    const bare = {
                        codec: library.codec,
                        codedWidth: track.width,
                        codedHeight: track.height,
                    };
                    entry.bare = await videoDecode(bare, packets);
                    entry.bareSoftware = await videoDecode(
                        { ...bare, hardwareAcceleration: 'prefer-software' },
                        packets,
                    );
                } catch (error) {
                    entry.error = text(error);
                }
            }
            // The host's own VP9 and AV1, decoded back.
            for (const codec of ['vp09.00.10.08', 'av01.0.04M.08']) {
                const entry = (out[`own ${codec}`] = {});
                try {
                    const config = {
                        codec,
                        width: 64,
                        height: 48,
                        bitrate: 500_000,
                        framerate: 30,
                    };
                    entry.encodeSupported = (
                        await VideoEncoder.isConfigSupported(config)
                    ).supported;
                    if (!entry.encodeSupported) continue;
                    const packets = [];
                    let decoderConfig;
                    const encoder = new VideoEncoder({
                        output: (chunk, metadata) => {
                            decoderConfig ??= metadata?.decoderConfig;
                            const data = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(data);
                            packets.push({
                                data,
                                timestamp: chunk.timestamp / 1e6,
                                key: chunk.type === 'key',
                            });
                        },
                        error: error => (entry.encodeError = text(error)),
                    });
                    encoder.configure(config);
                    const canvas = new OffscreenCanvas(64, 48);
                    const context = canvas.getContext('2d');
                    for (let index = 0; index < 5; index++) {
                        context.fillStyle = `rgb(${index * 40}, 80, 160)`;
                        context.fillRect(0, 0, 64, 48);
                        const frame = new VideoFrame(canvas, { timestamp: index * 33333 });
                        encoder.encode(frame, { keyFrame: index === 0 });
                        frame.close();
                    }
                    await encoder.flush();
                    encoder.close();
                    entry.decoderConfig = decoderConfig && summary(decoderConfig);
                    entry.decoded = await videoDecode(
                        decoderConfig ?? { codec, codedWidth: 64, codedHeight: 48 },
                        packets,
                    );
                    entry.decodedSoftware = await videoDecode(
                        {
                            ...(decoderConfig ?? { codec, codedWidth: 64, codedHeight: 48 }),
                            hardwareAcceleration: 'prefer-software',
                        },
                        packets,
                    );
                } catch (error) {
                    entry.error = text(error);
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: HDR colour of decoded frames', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { patternClip } = await import('../helpers/pattern-clip.mjs');
            const { hostVideoDecoderConfig } = await internal('codecs/webcodecs/video');
            const pq = { primaries: 9, transfer: 16, matrix: 9, fullRange: false };
            const blob = await patternClip({ colour: pq, frames: 5 });
            const { track, packets } = await demux(blob);
            out.track = track.colour;
            const config = hostVideoDecoderConfig(track);
            const colorSpace = {
                primaries: 'bt2020',
                transfer: 'pq',
                matrix: 'bt2020-ncl',
                fullRange: false,
            };
            out.withColour = await videoDecode({ ...config, colorSpace }, packets);
            out.without = await videoDecode(config, packets);
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning.code) });
            for await (const frame of forge.frames(blob, { format: 'videoframe', times: [0] })) {
                out.libraryFrame = frame.colorSpace?.toJSON?.();
                frame.close();
            }
            const thumbnail = await forge.thumbnail(blob, { time: 0, to: 'png' });
            out.thumbnailWarnings = thumbnail.warnings?.map(warning => warning.code);
            out.warnings = warnings;
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: drawing parts of decoded frames', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { blob, reported } = await patternVp8();
            out.encoderColour = reported;
            const { track, packets } = await demux(blob);
            const decoded = await videoDecode(
                { codec: track.codec, codedWidth: track.width, codedHeight: track.height },
                packets.slice(0, 1),
                true,
            );
            const frame = decoded.kept;
            delete decoded.kept;
            out.frame = decoded;
            const { width, height } = { width: frame.displayWidth, height: frame.displayHeight };
            const whole = rgbaOf(context => context.drawImage(frame, 0, 0), width, height);
            out.wholeOracle = oracle(whole, width, height, undefined);
            const reference = new OffscreenCanvas(width, height);
            reference.getContext('2d').drawImage(frame, 0, 0);
            for (const [name, s, d] of [
                ['cover', { x: 40, y: 0, width: 240, height: 240 }, [200, 200]],
                ['odd', { x: 31, y: 17, width: 160, height: 128 }, [160, 128]],
                ['crop', { x: 32, y: 16, width: 160, height: 128 }, [160, 128]],
            ]) {
                const [dw, dh] = d;
                const entry = (out[name] = {});
                const viaCanvas = rgbaOf(
                    context =>
                        context.drawImage(reference, s.x, s.y, s.width, s.height, 0, 0, dw, dh),
                    dw,
                    dh,
                );
                const variants = {
                    sourceRect: context =>
                        context.drawImage(frame, s.x, s.y, s.width, s.height, 0, 0, dw, dh),
                    shiftedClip: context => {
                        const scaleX = dw / s.width;
                        const scaleY = dh / s.height;
                        context.beginPath();
                        context.rect(0, 0, dw, dh);
                        context.clip();
                        context.drawImage(
                            frame,
                            -s.x * scaleX,
                            -s.y * scaleY,
                            width * scaleX,
                            height * scaleY,
                        );
                    },
                    shifted: context => {
                        const scaleX = dw / s.width;
                        const scaleY = dh / s.height;
                        context.drawImage(
                            frame,
                            -s.x * scaleX,
                            -s.y * scaleY,
                            width * scaleX,
                            height * scaleY,
                        );
                    },
                };
                entry.viaCanvasOracle = oracle(viaCanvas, dw, dh, s);
                for (const [variant, draw] of Object.entries(variants)) {
                    const rgba = rgbaOf(draw, dw, dh);
                    entry[variant] = [meanDifference(rgba, viaCanvas), oracle(rgba, dw, dh, s)];
                }
                const bitmap = await createImageBitmap(frame);
                const viaBitmap = rgbaOf(
                    context => context.drawImage(bitmap, s.x, s.y, s.width, s.height, 0, 0, dw, dh),
                    dw,
                    dh,
                );
                bitmap.close();
                entry.bitmap = [meanDifference(viaBitmap, viaCanvas), oracle(viaBitmap, dw, dh, s)];
            }
            frame.close();
            // The library's conversions, as the transform tests check them.
            for (const [name, settings, crop] of [
                ['none', {}, undefined],
                ['contain', { width: 200, height: 200, fit: 'contain' }, undefined],
                [
                    'cover',
                    { width: 200, height: 200, fit: 'cover' },
                    { x: 40, y: 0, width: 240, height: 240 },
                ],
                [
                    'odd',
                    { crop: { x: 31, y: 17, width: 161, height: 129 } },
                    { x: 31, y: 17, width: 160, height: 128 },
                ],
            ]) {
                try {
                    const { blob: output } = await new MediaForge().convert(blob, {
                        to: 'webm',
                        video: { codec: 'vp8', bitrate: 2_000_000, ...settings },
                    });
                    const picture = await shownPicture(output);
                    const sized = settings.width !== undefined;
                    const expected = transformedPattern({
                        crop: settings.crop ? crop : undefined,
                        width: picture.width,
                        height: picture.height,
                        fit: sized ? settings.fit : 'fill',
                    });
                    out[`convert ${name}`] = {
                        size: [picture.width, picture.height],
                        oracle: +maskedDifference(
                            picture.rgba,
                            expected.rgba,
                            expected.mask,
                        ).toFixed(2),
                        colour: picture.colour,
                    };
                } catch (error) {
                    out[`convert ${name}`] = text(error);
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: ICO and BMP through createImageBitmap', { timeout: 100_000 }, async t => {
        const out = {};
        const fill = (width, height) => ({
            data: new Uint8Array(width * height * 4).fill(200),
            width,
            height,
        });
        for (const [width, height] of [
            [1, 1],
            [2, 2],
            [16, 12],
            [16, 16],
            [32, 32],
        ]) {
            const bytes = await encodeIco(fill(width, height));
            for (const type of ['image/x-icon', 'image/vnd.microsoft.icon', ''])
                try {
                    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
                    out[`ico ${width}x${height} ${type}`] = [bitmap.width, bitmap.height];
                    bitmap.close();
                } catch (error) {
                    out[`ico ${width}x${height} ${type}`] = text(error);
                }
        }
        try {
            const bitmap = await createImageBitmap(
                new Blob([await encodeBmp(fill(1, 1))], { type: 'image/bmp' }),
            );
            out.bmp = [bitmap.width, bitmap.height];
        } catch (error) {
            out.bmp = text(error);
        }
        out.icoHead = hex(await encodeIco(fill(1, 1)), 40);
        try {
            out.imageDecoder = await globalThis.ImageDecoder?.isTypeSupported('image/x-icon');
        } catch (error) {
            out.imageDecoder = text(error);
        }
        report(t, out);
    });

    test('probe: playback of short packages', { timeout: 400_000 }, async t => {
        const out = {};
        const BASE = 'https://media.test/probe/';
        const served =
            files =>
            async (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input.url);
                const file = files.get(url.pathname.slice(new URL(BASE).pathname.length));
                if (!file) return new Response(null, { status: 404 });
                const data = file.data ?? file;
                const range = /^bytes=(\d+)-(\d*)$/.exec(
                    new Headers(init.headers).get('range') ?? '',
                );
                if (!range) return new Response(data, { status: 200 });
                const start = Number(range[1]);
                const end = range[2] ? Number(range[2]) + 1 : data.length;
                return new Response(data.slice(start, end), {
                    status: 206,
                    headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
                });
            };
        try {
            const { tone, toInt16, waveFile } = await import('../helpers/pcm.mjs');
            const forge = new MediaForge({ plugins: { add: [player] } });
            for (const [to, seconds, attempts] of [
                ['hls', 1, 3],
                ['dash', 1, 2],
                ['hls', 2, 1],
            ]) {
                const wave = new Blob([
                    waveFile(toInt16(tone(48000, 2, seconds * 48000)), 48000, 2),
                ]);
                const { blob } = await forge.convert(wave, { to: 'mp4', audio: { codec: 'aac' } });
                const pack = await forge.packageMedia(blob, { to, targetDuration: 0.5 });
                for (let attempt = 0; attempt < attempts; attempt++) {
                    const media = document.createElement('audio');
                    media.muted = true;
                    media.defaultPlaybackRate = 4;
                    media.playbackRate = 4;
                    document.body.append(media);
                    const started = performance.now();
                    const events = [];
                    const at = () => Math.round(performance.now() - started);
                    for (const type of [
                        'loadedmetadata',
                        'canplay',
                        'playing',
                        'waiting',
                        'stalled',
                        'pause',
                        'ended',
                        'error',
                        'durationchange',
                        'seeking',
                        'seeked',
                    ])
                        media.addEventListener(type, () =>
                            events.push(
                                `${type}@${at()} t${media.currentTime.toFixed(3)} d${media.duration.toFixed(3)}`,
                            ),
                        );
                    let lastUpdate;
                    media.addEventListener(
                        'timeupdate',
                        () => (lastUpdate = `${at()} t${media.currentTime.toFixed(3)}`),
                    );
                    const state = () => ({
                        time: media.currentTime,
                        duration: media.duration,
                        buffered: [...Array(media.buffered.length).keys()].map(i => [
                            +media.buffered.start(i).toFixed(3),
                            +media.buffered.end(i).toFixed(3),
                        ]),
                        readyState: media.readyState,
                        networkState: media.networkState,
                        paused: media.paused,
                        ended: media.ended,
                        error: media.error?.message,
                        src: media.getAttribute('src'),
                        lastUpdate,
                    });
                    let finished = 'pending';
                    let snapshot;
                    const ended = new Promise(resolve =>
                        media.addEventListener('ended', resolve, { once: true }),
                    );
                    const playback = forge.play(BASE + pack.entry, media, {
                        fetch: served(pack.files),
                    });
                    const done = playback.finished.then(
                        () => (finished = `resolved@${at()}`),
                        error => (finished = `rejected@${at()} ${text(error)}`),
                    );
                    const timeout = new Promise(resolve => setTimeout(resolve, 20_000));
                    await Promise.race([Promise.all([done, ended]), timeout]);
                    snapshot = state();
                    if (finished === 'pending') playback.stop?.();
                    out[`${to} ${seconds}s #${attempt}`] = { finished, events, state: snapshot };
                    media.remove();
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });
});
