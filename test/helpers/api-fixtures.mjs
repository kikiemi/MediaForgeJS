// Inputs the API tests share: a small H.264 + AAC movie, a VP8 clip in Matroska with a plugin
// decoder that shows a known pattern, and a reader of the PNGs the library writes.
import { inflateSync } from 'node:zlib';
import { open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { avcc, aviH264, filler, idr, lengthPrefixed, predicted } from './avi-h264-fixtures.mjs';
import { preservationFixture } from './mp4-preservation-fixture.mjs';
import { patternRgba } from './pattern.mjs';

/** 12 H.264 frames with keyframes at 1, 5 and 9 plus 23 AAC packets, as an MP4 with two tracks. */
export function movie() {
    const video = Array.from({ length: 12 }, (_, index) =>
        lengthPrefixed(4, index % 4 ? predicted : idr, filler(4 + index)),
    );
    const audio = Array.from({ length: 23 }, (_, index) =>
        Buffer.of(0x21, 0x10, index + 1, 0x7f, index),
    );
    return preservationFixture({
        tracks: [
            {
                type: 'video',
                name: 'Camera',
                default: true,
                packets: video,
                sync: [1, 5, 9],
                codecConfig: avcc(),
            },
            { type: 'audio', name: 'Main', default: true, packets: audio },
        ],
    }).bytes;
}

/** The format and the tracks (type, codec) of a written file, read back. */
export async function reopen(blob) {
    const media = await open(blob);
    try {
        return {
            format: media.format,
            tracks: media.tracks.map(track => ({ type: track.type, codec: track.codec })),
        };
    } finally {
        media.close();
    }
}

/** The pattern's size and block. */
export const PICTURE = Object.freeze({ width: 64, height: 48, block: 8 });

/**
 * Limited-range BT.601 I420 planes of the block pattern, as a built-in decoder would produce them.
 */
export function patternPicture(
    width = PICTURE.width,
    height = PICTURE.height,
    block = PICTURE.block,
) {
    const rgba = patternRgba(width, height, block);
    const data = new Uint8Array(width * height * 1.5);
    const chroma = width * height;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = rgba.subarray((y * width + x) * 4);
            data[y * width + x] = Math.round(
                16 + (219 * (0.299 * r + 0.587 * g + 0.114 * b)) / 255,
            );
            if (x % 2 || y % 2) continue;
            const at = (y / 2) * (width / 2) + x / 2;
            data[chroma + at] = Math.round(
                128 + (224 * (-0.168736 * r - 0.331264 * g + 0.5 * b)) / 255,
            );
            data[chroma * 1.25 + at] = Math.round(
                128 + (224 * (0.5 * r - 0.418688 * g - 0.081312 * b)) / 255,
            );
        }
    }
    return data;
}

/**
 * A plugin whose VP8 decoder shows the pattern for every packet but those starting with 0xff
 * (which hold no picture), and the timestamps it was given, in order.
 */
export function patternDecoderPlugin() {
    const { width, height } = PICTURE;
    const picture = patternPicture();
    const decoded = [];
    const decoder = {
        kind: 'video',
        id: 'pattern',
        codecs: codec => codec === 'vp8',
        load: async () => () => ({
            decode(chunk) {
                decoded.push(chunk.timestamp);
                if (chunk.data[0] === 0xff) return [];
                return [
                    {
                        format: 'I420',
                        data: picture.slice(),
                        layout: [
                            { offset: 0, stride: width },
                            { offset: width * height, stride: width / 2 },
                            { offset: width * height * 1.25, stride: width / 2 },
                        ],
                        codedWidth: width,
                        codedHeight: height,
                        visibleRect: { x: 0, y: 0, width, height },
                        displayWidth: width,
                        displayHeight: height,
                        timestamp: chunk.timestamp,
                        duration: chunk.duration,
                        keyFrame: chunk.isKeyframe,
                    },
                ];
            },
            flush: () => [],
            reset() {},
            close() {},
        }),
    };
    return { plugin: { name: 'pattern', decoders: [decoder] }, decoded };
}

/**
 * VP8 packets of 0.1 s in Matroska, keyframes every 0.5 s unless `keyframe` says otherwise:
 * ten by default.
 */
export async function vp8Clip({
    rotation,
    keyframe = index => index % 5 === 0,
    payload = index => Uint8Array.of(index),
    display = {},
    count = 10,
} = {}) {
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            video: {
                id: 1,
                type: 'video',
                codec: 'vp8',
                width: PICTURE.width,
                height: PICTURE.height,
                framerate: 10,
                rotation,
                ...display,
            },
        },
        sink,
    );
    for (let index = 0; index < count; index++)
        muxer.addVideoChunk({
            data: payload(index),
            timestamp: index / 10,
            duration: 0.1,
            isKeyframe: keyframe(index),
            trackType: 'video',
        });
    await muxer.finalize();
    return sink.toBlob();
}

/** The size and the RGBA pixels of an 8-bit RGBA PNG, its scanline filters undone. */
export function pngRgba(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    const parts = [];
    for (let at = 8; at < bytes.length;) {
        const length = view.getUint32(at);
        const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
        if (type === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + length));
        at += 12 + length;
    }
    const filtered = inflateSync(Buffer.concat(parts));
    const stride = width * 4;
    const rgba = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const kind = filtered[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const raw = filtered[y * (stride + 1) + 1 + x];
            const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
            const up = y ? rgba[(y - 1) * stride + x] : 0;
            const corner = x >= 4 && y ? rgba[(y - 1) * stride + x - 4] : 0;
            const paeth = () => {
                const estimate = left + up - corner;
                const [a, b, c] = [
                    Math.abs(estimate - left),
                    Math.abs(estimate - up),
                    Math.abs(estimate - corner),
                ];
                return a <= b && a <= c ? left : b <= c ? up : corner;
            };
            const predictor = [0, left, up, (left + up) >> 1, kind === 4 ? paeth() : 0][kind];
            rgba[y * stride + x] = (raw + predictor) & 255;
        }
    }
    return { width, height, rgba };
}

/**
 * One AAC frame of silence in Matroska, 48 kHz mono, the track's fields (name, language, ...)
 * taken from `extra`.
 */
export async function aacMatroska(extra = {}) {
    const silence = [new Float32Array(1024)];
    const [frame] = (await encodeAacLc(silence, { sampleRate: 48000, bitrate: 64 })).frames;
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            audio: {
                id: 1,
                type: 'audio',
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: Uint8Array.of(0x11, 0x88),
                ...extra,
            },
        },
        sink,
    );
    muxer.addAudioChunk({
        data: frame,
        timestamp: 0,
        duration: 1024 / 48000,
        isKeyframe: true,
        trackType: 'audio',
    });
    await muxer.finalize();
    return sink.toBlob('video/x-matroska');
}

/** Warning codes. */
export const codes = warnings => warnings.map(warning => warning.code);

/** A 48 kHz stereo 16-bit WAV of a 440 Hz tone. */
export function toneWav(seconds = 0.5, rate = 48000) {
    const frames = Math.round(seconds * rate);
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) =>
        [...value].forEach((char, index) => (bytes[offset + index] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * 4, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * 4, true);
    for (let index = 0; index < frames; index++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 12000);
        view.setInt16(44 + index * 4, sample, true);
        view.setInt16(46 + index * 4, sample, true);
    }
    return bytes;
}

/**
 * A mono WAV of `samples`: 16- or 24-bit integers, or 32-bit floats with `float`.
 */
export function monoWav(
    samples = [-32768, -16384, 0, 16384, 32767],
    { rate = 48000, bits = 16, float = false } = {},
) {
    const bytes = new Uint8Array(44 + (samples.length * bits) / 8);
    const view = new DataView(bytes.buffer);
    const tag = (at, text) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
    tag(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, float ? 3 : 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, (rate * bits) / 8, true);
    view.setUint16(32, bits / 8, true);
    view.setUint16(34, bits, true);
    tag(36, 'data');
    view.setUint32(40, bytes.length - 44, true);
    samples.forEach((sample, i) => {
        if (float) view.setFloat32(44 + i * 4, sample, true);
        else if (bits === 24) {
            view.setUint16(44 + i * 3, sample & 0xffff, true);
            view.setInt8(44 + i * 3 + 2, sample >> 16);
        } else view.setInt16(44 + i * 2, sample, true);
    });
    return bytes;
}

/** A grey 32x16 I420 AVI of three pictures (the avi plugin reads it). */
export function greyAvi() {
    const i420 = new Uint8Array(32 * 16 * 1.5).fill(128);
    return aviH264({
        fourcc: 'I420',
        extra: new Uint8Array(0),
        packets: [i420, i420, i420],
        width: 32,
        height: 16,
    });
}

/** The first five packets of the first track of a file, as byte arrays. */
export async function firstPackets(input) {
    const media = await open(input instanceof Blob ? input : new Blob([input]));
    try {
        const data = [];
        for await (const packet of media.packets()) {
            data.push([...packet.data]);
            if (data.length === 5) break;
        }
        return data;
    } finally {
        media.close();
    }
}
