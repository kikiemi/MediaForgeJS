import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, open } from 'mediaforgejs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { createPicture } from 'mediaforgejs/parts';
import { PATTERN, maskedDifference, patternRgba, transformedPattern } from '../helpers/pattern.mjs';

// Crops, turns, mirrors and display rotation of video with the browser's WebCodecs and canvas
// (npm run test:browser), checked against the pattern oracle of test/helpers/pattern.mjs.

const inBrowser = typeof document !== 'undefined';
const internal = path => import(`/dist/esm/${path}.js`);

const VP8 = { codec: 'vp8', width: PATTERN.width, height: PATTERN.height, framerate: 10 };

/** Whether the browser has what these tests need: a VP8 encoder and decoder, and a canvas. */
async function hostVideo() {
    const needed = ['VideoEncoder', 'VideoDecoder', 'OffscreenCanvas'].map(
        name => globalThis[name],
    );
    if (!needed.every(constructor => typeof constructor === 'function')) return false;
    const config = { ...VP8, bitrate: 2_000_000 };
    return (
        (await VideoEncoder.isConfigSupported(config)).supported === true &&
        (await VideoDecoder.isConfigSupported({ codec: 'vp8' })).supported === true
    );
}

/** 1.5 s of the pattern as VP8 in WebM, encoded by the browser, keyframes every five pictures. */
async function patternClip({ rotation } = {}) {
    const chunks = [];
    let failure;
    const encoder = new VideoEncoder({
        output: chunk => {
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
        error: error => (failure = error),
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
    if (failure) throw failure;
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'webm',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            videoColour: { primaries: 6, transfer: 6, matrix: 6, fullRange: false },
            video: { id: 1, type: 'video', ...VP8, rotation },
        },
        sink,
    );
    for (const chunk of chunks) muxer.addVideoChunk(chunk);
    await muxer.finalize();
    return sink.toBlob('video/webm');
}

/** The picture a file shows at `time` (seconds), decoded by the browser's own VideoDecoder. */
async function hostPicture(blob, time) {
    const media = await open(blob);
    const frames = [];
    let failure;
    const decoder = new VideoDecoder({
        output: frame => frames.push(frame),
        error: error => (failure = error),
    });
    try {
        const track = media.tracks.find(candidate => candidate.type === 'video');
        decoder.configure({
            codec: track.codec,
            codedWidth: track.width,
            codedHeight: track.height,
            ...(track.codecConfig ? { description: track.codecConfig } : {}),
        });
        for await (const packet of media.packets({ trackIds: [track.id] }))
            decoder.decode(
                new EncodedVideoChunk({
                    type: packet.isKeyframe ? 'key' : 'delta',
                    timestamp: Math.round(packet.timestamp * 1e6),
                    data: packet.data,
                }),
            );
        await decoder.flush();
        if (failure) throw failure;
        const shown = frames.filter(frame => frame.timestamp <= time * 1e6 + 1).at(-1);
        const canvas = new OffscreenCanvas(shown.displayWidth, shown.displayHeight);
        const context = canvas.getContext('2d');
        context.drawImage(shown, 0, 0);
        return {
            track,
            width: canvas.width,
            height: canvas.height,
            rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
    } finally {
        for (const frame of frames) frame.close();
        if (decoder.state !== 'closed') decoder.close();
        media.close();
    }
}

/** Mean difference inside the pattern's blocks between a picture and the oracle of `settings`. */
function oracleDifference(picture, settings) {
    const sized = settings.width !== undefined && settings.height !== undefined;
    const expected = transformedPattern({
        upright: settings.upright,
        crop: settings.crop,
        rotate: settings.rotate,
        flip: settings.flip,
        width: picture.width,
        height: picture.height,
        fit: sized ? (settings.fit ?? 'fill') : 'fill',
    });
    return maskedDifference(picture.rgba, expected.rgba, expected.mask);
}

/** The bytes of packet `index` of the first track. */
async function packetBytes(blob, index) {
    const media = await open(blob);
    try {
        let at = 0;
        for await (const packet of media.packets({ trackIds: [media.tracks[0].id] }))
            if (at++ === index) return packet.data;
    } finally {
        media.close();
    }
}

describe('stages', { skip: !inBrowser && 'runs in a browser (npm run test:browser)' }, () => {
    let source;
    const clip = async t => {
        if (!(await hostVideo())) {
            t.skip('the browser has no VP8 encoder, decoder or OffscreenCanvas');
            return undefined;
        }
        return (source ??= await patternClip());
    };

    describe('transform in conversions', () => {
        const cases = [
            [{}, [320, 240]],
            [{ crop: { x: 32, y: 16, width: 160, height: 128 } }, [160, 128]],
            [{ rotate: 90 }, [240, 320]],
            [{ flip: 'vertical' }, [320, 240]],
            [{ rotate: 270, flip: 'horizontal' }, [240, 320]],
            [{ width: 200, height: 200, fit: 'contain' }, [200, 200]],
            [{ width: 200, height: 200, fit: 'cover' }, [200, 200]],
            [
                {
                    crop: { x: 48, y: 32, width: 192, height: 160 },
                    rotate: 90,
                    flip: 'vertical',
                    width: 128,
                    height: 96,
                    fit: 'cover',
                },
                [128, 96],
            ],
        ];
        for (const [settings, size] of cases)
            test(`shows the oracle's picture: ${JSON.stringify(settings)}`, async t => {
                const input = await clip(t);
                if (!input) return;
                const { blob } = await new MediaForge().convert(input, {
                    to: 'webm',
                    video: { codec: 'vp8', bitrate: 2_000_000, ...settings },
                });
                const picture = await hostPicture(blob, 0.2);
                assert.deepEqual([picture.width, picture.height], size);
                const difference = oracleDifference(picture, settings);
                assert(difference < 12, `differs from the oracle by ${difference.toFixed(2)}`);
            });

        test('an odd crop is trimmed to even sides and reported', async t => {
            const input = await clip(t);
            if (!input) return;
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning.code) });
            const { blob } = await forge.convert(input, {
                to: 'webm',
                video: {
                    codec: 'vp8',
                    bitrate: 2_000_000,
                    crop: { x: 31, y: 17, width: 161, height: 129 },
                },
            });
            const picture = await hostPicture(blob, 0.2);
            assert.deepEqual([picture.width, picture.height], [160, 128]);
            const crop = { x: 31, y: 17, width: 160, height: 128 };
            assert(oracleDifference(picture, { crop }) < 12);
            assert(warnings.includes('OPTION_NORMALIZED'));
        });

        test('turns and mirrors reach the encoder as decoded 4:2:0 planes', async t => {
            const input = await clip(t);
            if (!input) return;
            const forge = new MediaForge();
            const handed = [];
            const encode = VideoEncoder.prototype.encode;
            VideoEncoder.prototype.encode = function (frame, options) {
                handed.push({ format: frame.format, colour: JSON.stringify(frame.colorSpace) });
                return encode.call(this, frame, options);
            };
            const decoded = [];
            try {
                for await (const frame of forge.frames(input, {
                    format: 'videoframe',
                    maxFrames: 1,
                })) {
                    decoded.push({
                        format: frame.format,
                        colour: JSON.stringify(frame.colorSpace),
                    });
                    frame.close();
                }
                await forge.convert(input, {
                    to: 'webm',
                    video: { codec: 'vp8', bitrate: 2_000_000, rotate: 90, flip: 'horizontal' },
                });
            } finally {
                VideoEncoder.prototype.encode = encode;
            }
            assert(handed.length > 0, 'the encoder received frames');
            // A decoder of RGB pictures (Firefox's gives BGRX) leaves no planes to move: they are
            // drawn.
            if (!/^(I420|NV12)/.test(decoded[0]?.format ?? ''))
                return t.skip(`the browser decodes VP8 to ${decoded[0]?.format}, not 4:2:0`);
            for (const { format } of handed) assert.match(format, /^(I420|NV12)/);
            assert.equal(handed[0].colour, decoded[0].colour, 'the decoded colour is kept');
        });
    });

    describe('display rotation', () => {
        test('re-encoding turns the picture upright and writes no rotation', async t => {
            if (!(await clip(t))) return;
            const rotated = await patternClip({ rotation: 90 });
            const { blob } = await new MediaForge().convert(rotated, {
                to: 'webm',
                video: { codec: 'vp8', bitrate: 2_000_000 },
            });
            const picture = await hostPicture(blob, 0);
            assert(!picture.track.rotation, `wrote rotation ${picture.track.rotation}`);
            assert.deepEqual([picture.width, picture.height], [240, 320]);
            const difference = oracleDifference(picture, { upright: 270 });
            assert(difference < 12, `differs from upright by ${difference.toFixed(2)}`);
        });

        test('autoRotate false keeps the stored picture and its rotation', async t => {
            if (!(await clip(t))) return;
            const rotated = await patternClip({ rotation: 90 });
            const { blob } = await new MediaForge().convert(rotated, {
                to: 'webm',
                video: { codec: 'vp8', bitrate: 2_000_000, autoRotate: false },
            });
            const picture = await hostPicture(blob, 0);
            assert.equal(picture.track.rotation, 90);
            assert.equal(picture.width, 320);
        });

        test('a rotation alone is copied as rotation metadata, packets unchanged', async t => {
            const input = await clip(t);
            if (!input) return;
            const { blob } = await new MediaForge().convert(input, {
                to: 'webm',
                video: { rotate: 90 },
            });
            const media = await open(blob);
            const rotation = media.tracks[0].rotation;
            media.close();
            assert.equal(rotation, 270);
            assert.deepEqual(await packetBytes(blob, 3), await packetBytes(input, 3));
        });
    });

    describe('transform stage on host frames', () => {
        const geometryOf = async (settings, width, height) => {
            const { resolveVideoGeometry } = await internal('stages/frame-geometry');
            const { OptionNormalizer } = await internal('core/errors/option-policy');
            return resolveVideoGeometry({ width, height }, settings, new OptionNormalizer(), true);
        };

        /** The pictures one stage makes of one picture. */
        const runStage = async (stage, picture) => {
            const output = [];
            stage.configure?.({ width: picture.width, height: picture.height });
            await stage.process(picture, item => output.push(item));
            return output;
        };

        test('padding has the background colour on the canvas and the CPU', async () => {
            const { transformStage } = await internal('stages/video');
            const { Picture } = await internal('stages/picture');
            const geometry = await geometryOf({ width: 32, height: 32, fit: 'contain' }, 32, 16);
            const rgba = new Uint8Array(32 * 16 * 4).fill(200);
            const frame = new VideoFrame(rgba, {
                format: 'RGBA',
                codedWidth: 32,
                codedHeight: 16,
                timestamp: 0,
            });
            const drawn = await runStage(
                transformStage(geometry, { background: '#00ff00' }),
                new Picture({ kind: 'frame', frame }, 0, 0.04),
            );
            const converted = await runStage(
                transformStage(geometry, { background: '#00ff00' }),
                createPicture({ data: rgba, width: 32, height: 16, timestamp: 0, duration: 0.04 }),
            );
            for (const [path, [picture]] of [
                ['canvas', drawn],
                ['CPU', converted],
            ]) {
                const corner = [...(await picture.rgba()).subarray(0, 3)];
                assert.deepEqual(corner, [0, 255, 0], `${path} padding`);
                picture.close();
            }
        });

        test('a quarter turn of an I420 frame moves its plane samples exactly', async () => {
            const { transformStage } = await internal('stages/video');
            const { Picture } = await internal('stages/picture');
            const [width, height] = [4, 2];
            const data = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 102, 103);
            const frame = new VideoFrame(data, {
                format: 'I420',
                codedWidth: width,
                codedHeight: height,
                timestamp: 0,
                colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
            });
            const geometry = await geometryOf({ rotate: 90 }, width, height);
            const [output] = await runStage(
                transformStage(geometry),
                new Picture({ kind: 'frame', frame }, 0, 0.04),
            );
            const turned = output.frame;
            assert.deepEqual(
                [turned.format, turned.codedWidth, turned.codedHeight],
                ['I420', 2, 4],
            );
            assert.equal(turned.colorSpace.matrix, 'bt709');
            const copy = new Uint8Array(turned.allocationSize());
            await turned.copyTo(copy);
            assert.deepEqual([...copy], [4, 0, 5, 1, 6, 2, 7, 3, 100, 101, 102, 103]);
            output.close();
        });
    });
});
