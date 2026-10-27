import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
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
    for (const [name, settings, crop] of [
        [
            'cover',
            { width: 200, height: 200, fit: 'cover' },
            { x: 40, y: 0, width: 240, height: 240 },
        ],
        ['contain', { width: 200, height: 200, fit: 'contain' }, undefined],
        [
            'odd',
            { crop: { x: 31, y: 17, width: 161, height: 129 } },
            { x: 31, y: 17, width: 160, height: 128 },
        ],
    ])
        test(`probe: every picture of a ${name} conversion`, { timeout: 100_000 }, async t => {
            const out = {};
            try {
                const { blob } = await patternVp8();
                const sized = settings.width !== undefined;
                const expect = (rgba, width, height) => {
                    const expected = transformedPattern({
                        crop: settings.crop ? crop : undefined,
                        width,
                        height,
                        fit: sized ? settings.fit : 'fill',
                    });
                    return +maskedDifference(rgba, expected.rgba, expected.mask).toFixed(2);
                };
                // Every decoded input frame drawn as the library draws a part of it.
                const { track, packets } = await demux(blob);
                const frames = [];
                const decoder = new VideoDecoder({
                    output: frame => frames.push(frame),
                    error: () => {},
                });
                decoder.configure({
                    codec: track.codec,
                    codedWidth: track.width,
                    codedHeight: track.height,
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
                if (crop) {
                    const [dw, dh] = sized
                        ? [settings.width, settings.height]
                        : [crop.width, crop.height];
                    const scale = dw / crop.width;
                    out.drawnInputs = frames.map(frame =>
                        expect(
                            rgbaOf(
                                context => {
                                    context.beginPath();
                                    context.rect(0, 0, dw, dh);
                                    context.clip();
                                    context.drawImage(
                                        frame,
                                        -crop.x * scale,
                                        -crop.y * scale,
                                        frame.displayWidth * scale,
                                        frame.displayHeight * scale,
                                    );
                                },
                                dw,
                                dh,
                            ),
                            dw,
                            dh,
                        ),
                    );
                }
                for (const frame of frames) frame.close();

                // What the library's conversion hands its encoder, picture by picture, and what
                // the encoder writes.
                const prototype = VideoEncoder.prototype;
                const encode = prototype.encode;
                const configure = prototype.configure;
                const inputs = [];
                prototype.configure = function (config) {
                    out.encoderConfig = { ...config };
                    return configure.call(this, config);
                };
                prototype.encode = function (input, options) {
                    const width = input.displayWidth;
                    const height = input.displayHeight;
                    inputs.push([
                        input.timestamp,
                        options?.keyFrame === true,
                        expect(
                            rgbaOf(context => context.drawImage(input, 0, 0), width, height),
                            width,
                            height,
                        ),
                    ]);
                    return encode.call(this, input, options);
                };
                let output;
                try {
                    output = await new MediaForge().convert(blob, {
                        to: 'webm',
                        video: { codec: 'vp8', bitrate: 2_000_000, ...settings },
                    });
                } finally {
                    prototype.encode = encode;
                    prototype.configure = configure;
                }
                out.inputs = inputs;
                const decoded = await demux(output.blob);
                out.chunks = decoded.packets.map(packet => [
                    +packet.timestamp.toFixed(3),
                    packet.key,
                    packet.data.length,
                ]);
                const pictures = [];
                const back = new VideoDecoder({
                    output: frame => pictures.push(frame),
                    error: () => {},
                });
                back.configure({
                    codec: decoded.track.codec,
                    codedWidth: decoded.track.width,
                    codedHeight: decoded.track.height,
                });
                for (const packet of decoded.packets)
                    back.decode(
                        new EncodedVideoChunk({
                            type: packet.key ? 'key' : 'delta',
                            timestamp: Math.round(packet.timestamp * 1e6),
                            data: packet.data,
                        }),
                    );
                await back.flush();
                back.close();
                out.outputs = pictures.map(frame => {
                    const width = frame.displayWidth;
                    const height = frame.displayHeight;
                    const result = [
                        frame.timestamp,
                        expect(
                            rgbaOf(context => context.drawImage(frame, 0, 0), width, height),
                            width,
                            height,
                        ),
                    ];
                    frame.close();
                    return result;
                });
            } catch (error) {
                out.error = text(error);
            }
            report(t, out);
        });
});
