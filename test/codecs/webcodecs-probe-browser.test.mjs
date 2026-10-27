import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import { encodeFlac } from 'mediaforgejs/codecs';
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

/** 1.5 s of the pattern as VP8 in WebM, as the transform tests make it; the encoder's colour. */
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
    test('probe: FLAC descriptions', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { flacStreamHeader } = await internal('core/codec-config/audio/flac-frame');
            const { deinterleave, tone } = await import('../helpers/pcm.mjs');
            const blob = new Blob([
                await encodeFlac(deinterleave(tone(48000, 2, 9600), 2), { sampleRate: 48000 }),
            ]);
            const { track, packets } = await demux(blob);
            const header = flacStreamHeader(track.codecConfig);
            const info = header.subarray(4);
            const join = (...parts) => {
                const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
                let at = 0;
                for (const part of parts) {
                    bytes.set(part, at);
                    at += part.length;
                }
                return bytes;
            };
            const ascii = value => Uint8Array.from(value, char => char.charCodeAt(0));
            const size = length => Uint8Array.of(0, 0, length >> 8, length & 255);
            const shape = { codec: 'flac', sampleRate: 48000, numberOfChannels: 2 };
            const box = join(size(12 + info.length), ascii('dfLa'), new Uint8Array(4), info);
            const variants = {
                dfLaPayload: join(new Uint8Array(4), info),
                dfLaBox: box,
                fLaCdfLaBox: join(ascii('fLaC'), box),
                streamInfoBlock: info,
            };
            for (const [name, description] of Object.entries(variants))
                out[name] = await audioDecode({ ...shape, description }, packets.slice(0, 1));
            out.mse =
                typeof MediaSource === 'function' &&
                MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
            out.element = document.createElement('audio').canPlayType('audio/flac');
            const media = document.createElement('audio');
            media.muted = true;
            media.src = URL.createObjectURL(new Blob([blob], { type: 'audio/flac' }));
            out.elementPlays = await new Promise(resolve => {
                media.addEventListener('loadedmetadata', () =>
                    resolve(`duration ${media.duration}`),
                );
                media.addEventListener('error', () => resolve(`error ${media.error?.code}`));
                setTimeout(() => resolve('timeout'), 5000);
            });
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: the drawing of a cover conversion', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const { blob } = await patternVp8();
            const { track, packets } = await demux(blob);
            const decoded = await videoDecode(
                { codec: track.codec, codedWidth: track.width, codedHeight: track.height },
                packets.slice(0, 1),
                true,
            );
            const frame = decoded.kept;
            const { width, height } = { width: frame.displayWidth, height: frame.displayHeight };
            const reference = new OffscreenCanvas(width, height);
            reference.getContext('2d').drawImage(frame, 0, 0);
            const s = { x: 40, y: 0, width: 240, height: 240 };
            const [dw, dh] = [200, 200];
            const viaCanvas = rgbaOf(
                context => context.drawImage(reference, s.x, s.y, s.width, s.height, 0, 0, dw, dh),
                dw,
                dh,
            );
            const scale = dw / s.width;
            const library = (clip, centred, options) => {
                const canvas = new OffscreenCanvas(dw, dh);
                const context = canvas.getContext('2d', options);
                context.save();
                if (centred) context.translate(dw / 2, dh / 2);
                const x0 = centred ? -dw / 2 : 0;
                const y0 = centred ? -dh / 2 : 0;
                if (clip) {
                    context.beginPath();
                    context.rect(x0, y0, dw, dh);
                    context.clip();
                }
                context.drawImage(
                    frame,
                    x0 - s.x * scale,
                    y0 - s.y * scale,
                    width * scale,
                    height * scale,
                );
                context.restore();
                return context.getImageData(0, 0, dw, dh).data;
            };
            for (const [name, clip, centred, options] of [
                ['clipCentred', true, true, { alpha: false }],
                ['clipCentredRead', true, true, { alpha: false, willReadFrequently: true }],
                ['centred', false, true, { alpha: false }],
                ['clip', true, false, { alpha: false }],
            ]) {
                const rgba = library(clip, centred, options);
                out[name] = [meanDifference(rgba, viaCanvas), oracle(rgba, dw, dh, s)];
            }
            const { VideoFrameTransformer } = await internal('stages/frame-transform');
            const geometry = {
                width: dw,
                height: dh,
                target: { x: 0, y: 0, width: dw, height: dh },
                region: s,
                sourceWidth: width,
                sourceHeight: height,
                rotation: 0,
                flipX: false,
                flipY: false,
            };
            for (const readable of [false, true]) {
                const transformer = new VideoFrameTransformer(geometry, readable);
                const output = transformer.apply(frame, frame.timestamp, undefined);
                const rgba = rgbaOf(context => context.drawImage(output, 0, 0), dw, dh);
                out[`transformer${readable ? 'Read' : ''}`] = {
                    size: [output.displayWidth, output.displayHeight],
                    difference: [meanDifference(rgba, viaCanvas), oracle(rgba, dw, dh, s)],
                };
                if (output !== frame) output.close();
            }
            frame.close();

            const prototype = OffscreenCanvasRenderingContext2D.prototype;
            const drawImage = prototype.drawImage;
            const encode = VideoEncoder.prototype.encode;
            const draws = [];
            let first;
            prototype.drawImage = function (source, ...args) {
                if (draws.length < 4 && source instanceof VideoFrame) {
                    const m = this.getTransform();
                    const visible = source.visibleRect;
                    draws.push({
                        args: args.map(value => +value.toFixed(2)),
                        transform: [m.a, m.b, m.c, m.d, m.e, m.f].map(value => +value.toFixed(2)),
                        canvas: [this.canvas.width, this.canvas.height],
                        display: [source.displayWidth, source.displayHeight],
                        coded: [source.codedWidth, source.codedHeight],
                        visible: visible && [visible.x, visible.y, visible.width, visible.height],
                        format: source.format,
                    });
                }
                return drawImage.call(this, source, ...args);
            };
            VideoEncoder.prototype.encode = function (input, options) {
                if (!first && input.displayWidth === dw)
                    first = rgbaOf(context => drawImage.call(context, input, 0, 0), dw, dh);
                return encode.call(this, input, options);
            };
            try {
                await new MediaForge().convert(blob, {
                    to: 'webm',
                    video: {
                        codec: 'vp8',
                        bitrate: 2_000_000,
                        width: dw,
                        height: dh,
                        fit: 'cover',
                    },
                });
            } finally {
                prototype.drawImage = drawImage;
                VideoEncoder.prototype.encode = encode;
            }
            out.draws = draws;
            out.firstEncoded = first && [
                meanDifference(first, viaCanvas),
                oracle(first, dw, dh, s),
            ];
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });

    test('probe: playback of short packages', { timeout: 400_000 }, async t => {
        const out = { stalls: 0, attempts: 0 };
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
            for (const [to, attempts] of [
                ['hls', 8],
                ['dash', 4],
            ]) {
                const wave = new Blob([waveFile(toInt16(tone(48000, 2, 48000)), 48000, 2)]);
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
                    for (const type of ['playing', 'seeking', 'seeked', 'ended', 'error'])
                        media.addEventListener(type, () =>
                            events.push(`${type}@${at()} t${media.currentTime.toFixed(3)}`),
                        );
                    let finished = 'pending';
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
                    await Promise.race([
                        Promise.all([done, ended]),
                        new Promise(resolve => setTimeout(resolve, 15_000)),
                    ]);
                    out.attempts++;
                    if (finished === 'pending') {
                        out.stalls++;
                        out[`${to} #${attempt}`] = {
                            events,
                            time: media.currentTime,
                            readyState: media.readyState,
                        };
                        playback.stop?.();
                    } else out[`${to} #${attempt}`] = events.join(' ');
                    media.remove();
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });
});
