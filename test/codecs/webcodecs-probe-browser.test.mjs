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
    test('probe: colours of canvas frames through the encoder', { timeout: 100_000 }, async t => {
        const out = {};
        try {
            const colours = [
                [255, 0, 0],
                [0, 255, 0],
                [0, 0, 255],
                [128, 128, 128],
                [200, 100, 50],
                [30, 60, 90],
                [235, 235, 235],
                [20, 20, 20],
            ];
            const side = 32;
            const width = side * colours.length;
            const height = side;
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d', { alpha: false });
            colours.forEach(([r, g, b], index) => {
                context.fillStyle = `rgb(${r}, ${g}, ${b})`;
                context.fillRect(index * side, 0, side, side);
            });
            const rgba = context.getImageData(0, 0, width, height).data;
            out.canvasPixels = colours.map((_, index) => [
                ...rgba.subarray(((side / 2) * width + index * side + side / 2) * 4).slice(0, 3),
            ]);
            const centres = picture =>
                colours.map((_, index) => [
                    ...picture
                        .subarray(((side / 2) * width + index * side + side / 2) * 4)
                        .slice(0, 3),
                ]);
            const sources = {
                canvas: () => new VideoFrame(canvas, { timestamp: 0 }),
                rgbaBuffer: () =>
                    new VideoFrame(rgba, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: 0,
                    }),
                rgbaBufferSrgb: () =>
                    new VideoFrame(rgba, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: 0,
                        colorSpace: {
                            primaries: 'bt709',
                            transfer: 'iec61966-2-1',
                            matrix: 'rgb',
                            fullRange: true,
                        },
                    }),
            };
            for (const codec of ['vp8', 'vp09.00.10.08']) {
                for (const [name, make] of Object.entries(sources)) {
                    const entry = (out[`${codec} ${name}`] = {});
                    const frame = make();
                    entry.frame = { format: frame.format, colour: frame.colorSpace?.toJSON?.() };
                    const drawnSource = rgbaOf(c => c.drawImage(frame, 0, 0), width, height);
                    entry.drawnSource = centres(drawnSource);
                    const chunks = [];
                    let decoderConfig;
                    const encoder = new VideoEncoder({
                        output: (chunk, metadata) => {
                            chunks.push(chunk);
                            decoderConfig ??= metadata?.decoderConfig;
                        },
                        error: error => (entry.encodeError = text(error)),
                    });
                    encoder.configure({ codec, width, height, bitrate: 8_000_000, framerate: 10 });
                    encoder.encode(frame, { keyFrame: true });
                    await encoder.flush();
                    encoder.close();
                    frame.close();
                    entry.reported = decoderConfig?.colorSpace;
                    const pictures = [];
                    const decoder = new VideoDecoder({
                        output: picture => pictures.push(picture),
                        error: error => (entry.decodeError = text(error)),
                    });
                    decoder.configure({
                        codec,
                        codedWidth: width,
                        codedHeight: height,
                        hardwareAcceleration: 'prefer-software',
                    });
                    for (const chunk of chunks) decoder.decode(chunk);
                    await decoder.flush();
                    decoder.close();
                    const [picture] = pictures;
                    if (!picture) continue;
                    entry.decoded = {
                        format: picture.format,
                        colour: picture.colorSpace?.toJSON?.(),
                    };
                    entry.drawnDecoded = centres(
                        rgbaOf(c => c.drawImage(picture, 0, 0), width, height),
                    );
                    const data = new Uint8Array(picture.allocationSize());
                    const planes = await picture.copyTo(data);
                    const [luma, chroma] = planes;
                    entry.yuv = colours.map((_, index) => {
                        const x = index * side + side / 2;
                        const y = side / 2;
                        const yValue = data[luma.offset + y * luma.stride + x];
                        if (picture.format === 'NV12')
                            return [
                                yValue,
                                data[chroma.offset + (y / 2) * chroma.stride + (x / 2) * 2],
                                data[chroma.offset + (y / 2) * chroma.stride + (x / 2) * 2 + 1],
                            ];
                        const v = planes[2];
                        return [
                            yValue,
                            data[chroma.offset + (y / 2) * chroma.stride + x / 2],
                            data[v.offset + (y / 2) * v.stride + x / 2],
                        ];
                    });
                    for (const each of pictures) each.close();
                }
            }
        } catch (error) {
            out.error = text(error);
        }
        report(t, out);
    });
});
