import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPicture, createVideoStages, transform } from 'mediaforgejs/parts';
import { patternRgba, transformedPattern } from '../helpers/pattern.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const stage = path => import(distUrl(`esm/stages/${path}.js`));
const { resolveVideoGeometry } = await stage('frame-geometry');
const { transformStage } = await stage('video');
const { Picture } = await stage('picture');
const { OptionNormalizer } = await import(distUrl('esm/core/errors/option-policy.js'));

const [WIDTH, HEIGHT, BLOCK] = [24, 16, 4];

const pattern = () => patternRgba(WIDTH, HEIGHT, BLOCK);

const picture = (data = pattern(), width = WIDTH, height = HEIGHT) =>
    createPicture({ data, width, height, timestamp: 0, duration: 0.04 });

/** The pictures `stages` make of one picture. */
async function run(stages, input, info = { width: input.width, height: input.height }) {
    const chain = createVideoStages(stages, info);
    try {
        return [...(await chain.push(input)), ...(await chain.flush())];
    } finally {
        chain.close();
    }
}

/** The oracle of the pattern after `settings`. */
const expected = (settings, width, height) =>
    transformedPattern({
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
        block: BLOCK,
        ...settings,
        width,
        height,
    }).rgba;

/** One run's transform stage of `settings`, for a picture of the pattern's size. */
const stageOf = (settings, options) =>
    transformStage(
        resolveVideoGeometry(
            { width: WIDTH, height: HEIGHT },
            settings,
            new OptionNormalizer(),
            false,
        ),
        options,
    );

/** The pattern as a built-in decoder's RGBX plane, stored at an offset. */
function planarPattern() {
    const data = new Uint8Array(8 + WIDTH * HEIGHT * 4);
    data.set(pattern(), 8);
    return {
        format: 'RGBX',
        data,
        layout: [{ offset: 8, stride: WIDTH * 4 }],
        codedWidth: WIDTH,
        codedHeight: HEIGHT,
        visibleRect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        displayWidth: WIDTH,
        displayHeight: HEIGHT,
        timestamp: 0,
        duration: 0.04,
        keyFrame: true,
    };
}

/**
 * Planes of a `width` × `height` picture with half-width chroma of `chromaRows` rows: luma sample
 * (x, y) is y × width + x, and the chroma samples count on from 100.
 */
function yuvPlanes(width, height, chromaRows = height / 2) {
    const luma = width * height;
    const chroma = (width / 2) * chromaRows;
    const data = new Uint8Array(luma + 2 * chroma);
    for (let at = 0; at < luma; at++) data[at] = at;
    for (let at = luma; at < data.length; at++) data[at] = 100 + (at - luma);
    return {
        data,
        layout: [
            { offset: 0, stride: width },
            { offset: luma, stride: width / 2 },
            { offset: luma + chroma, stride: width / 2 },
        ],
    };
}

describe('stages', () => {
    describe('transform', () => {
        test('turns and mirrors RGBA pictures exactly', async () => {
            const settings = { rotate: 90, flip: 'horizontal' };
            const [output] = await run([transform(settings)], picture());
            assert.deepEqual([output.width, output.height], [HEIGHT, WIDTH]);
            assert.deepEqual([...(await output.rgba())], [...expected(settings, HEIGHT, WIDTH)]);
        });

        test('crops and resizes, the output size following from the stream', async () => {
            const stages = [transform({ crop: { x: 4, y: 4, width: 16, height: 8 }, width: 8 })];
            const chain = createVideoStages(stages, { width: WIDTH, height: HEIGHT, fps: 25 });
            assert.deepEqual(chain.output, { width: 8, height: 4, fps: 25 });
            chain.close();
        });

        test('an unchanged picture passes through as it is', async () => {
            const input = picture();
            const [output] = await run([transform({})], input);
            assert.equal(output, input);
        });

        test('the transformed picture replaces its input, which is closed', async () => {
            const input = picture();
            await run([transform({ rotate: 180 })], input);
            await assert.rejects(input.rgba(), { code: 'INPUT', message: /closed/ });
        });

        test('pictures of another size get the same output', async () => {
            const stages = [transform({ width: 12 })];
            const chain = createVideoStages(stages, { width: WIDTH, height: HEIGHT });
            try {
                const big = patternRgba(WIDTH * 2, HEIGHT * 2, BLOCK * 2);
                const [output] = await chain.push(picture(big, WIDTH * 2, HEIGHT * 2));
                assert.deepEqual([output.width, output.height], [12, 8]);
            } finally {
                chain.close();
            }
        });

        test('a repair of its options fails with INPUT, naming transform', () => {
            assert.throws(
                () =>
                    createVideoStages(
                        [transform({ crop: { x: 20, y: 0, width: 10, height: 8 } })],
                        {
                            width: WIDTH,
                            height: HEIGHT,
                        },
                    ),
                { code: 'INPUT', message: /^transform: crop was clamped/ },
            );
        });

        test('contained pictures are padded with the background colour', async () => {
            const transformStage = stageOf(
                { width: 24, height: 24, fit: 'contain' },
                { background: '#00ff00' },
            );
            const [output] = await run([transformStage], picture());
            const rgba = await output.rgba();
            assert.deepEqual([...rgba.subarray(0, 4)], [0, 255, 0, 255]);
        });
    });

    describe('built-in decoder planes', () => {
        test('planes turn exactly, converting only what is shown', async () => {
            const settings = { crop: { x: 4, y: 0, width: 12, height: 16 }, rotate: 270 };
            const input = new Picture({ kind: 'planar', planar: planarPattern() }, 0, 0.04);
            const [output] = await run([stageOf(settings)], input);
            assert.deepEqual([output.width, output.height], [16, 12]);
            assert.deepEqual([...(await output.rgba())], [...expected(settings, 16, 12)]);
        });

        test('a crop of 4:2:0 planes shows what the whole picture shows there', async () => {
            const planes = yuvPlanes(8, 8);
            const planar = {
                ...planarPattern(),
                format: 'I420',
                ...planes,
                codedWidth: 8,
                codedHeight: 8,
                visibleRect: { x: 0, y: 0, width: 8, height: 8 },
                displayWidth: 8,
                displayHeight: 8,
            };
            const whole = await new Picture({ kind: 'planar', planar }, 0, 0.04).rgba();
            const geometry = resolveVideoGeometry(
                { width: 8, height: 8 },
                { crop: { x: 2, y: 4, width: 4, height: 2 } },
                new OptionNormalizer(),
                false,
            );
            const input = new Picture({ kind: 'planar', planar }, 0, 0.04);
            const [output] = await run([transformStage(geometry)], input);
            const rgba = await output.rgba();
            for (let row = 0; row < 2; row++)
                assert.deepEqual(
                    [...rgba.subarray(row * 16, row * 16 + 16)],
                    [...whole.subarray(((4 + row) * 8 + 2) * 4, ((4 + row) * 8 + 6) * 4)],
                    `row ${row}`,
                );
        });
    });

    describe('host frames without a canvas', () => {
        /** A fake host frame (VideoFrame of the harness) of `format` with pixel planes. */
        const hostFrame = (format = 'I420', width = 16, height = 16) => {
            const { data, layout } = yuvPlanes(
                width,
                height,
                format === 'I422' ? height : height / 2,
            );
            return new VideoFrame(data, {
                format,
                codedWidth: width,
                codedHeight: height,
                layout,
                timestamp: 0,
                duration: 40000,
                colorSpace: { toJSON: () => ({ matrix: 'bt709', fullRange: false }) },
            });
        };

        const withCodecs = async body => {
            const runtime = installVideoCodecs({ pixels: true });
            try {
                await body(runtime);
                runtime.assertClosed();
            } finally {
                runtime.restore();
            }
        };

        const resolved = settings =>
            resolveVideoGeometry({ width: 16, height: 16 }, settings, new OptionNormalizer(), true);

        test('a crop on the chroma grid is a zero-copy visible rectangle', () =>
            withCodecs(async () => {
                const frame = hostFrame();
                const input = new Picture({ kind: 'frame', frame }, 0, 0.04);
                const geometry = resolved({ crop: { x: 2, y: 4, width: 8, height: 8 } });
                const [output] = await run([transformStage(geometry)], input, {
                    width: 16,
                    height: 16,
                });
                assert.equal(typeof OffscreenCanvas, 'undefined');
                assert.deepEqual(output.frame.visibleRect, { x: 2, y: 4, width: 8, height: 8 });
                assert.deepEqual([output.frame.displayWidth, output.frame.displayHeight], [8, 8]);
                assert.equal(output.frame.data, frame.data, 'the pixels are shared');
                output.close();
            }));

        test('a crop off the chroma grid is converted on the CPU', () =>
            withCodecs(async () => {
                const input = new Picture({ kind: 'frame', frame: hostFrame() }, 0, 0.04);
                const geometry = resolved({ crop: { x: 1, y: 4, width: 8, height: 8 } });
                const [output] = await run([transformStage(geometry)], input, {
                    width: 16,
                    height: 16,
                });
                assert.deepEqual([output.data.kind, output.width, output.height], ['rgba', 8, 8]);
            }));

        test('4:2:2 frames become RGBA even unchanged, as encoders take 4:2:0 or RGB', () =>
            withCodecs(async () => {
                const input = new Picture({ kind: 'frame', frame: hostFrame('I422') }, 0, 0.04);
                const [output] = await run([transformStage(resolved({}))], input, {
                    width: 16,
                    height: 16,
                });
                assert.equal(output.data.kind, 'rgba');
            }));

        test('turns of 4:2:0 frames move plane samples, keeping the colour', () =>
            withCodecs(async () => {
                const input = new Picture(
                    { kind: 'frame', frame: hostFrame('I420', 4, 2) },
                    0,
                    0.04,
                );
                const geometry = resolveVideoGeometry(
                    { width: 4, height: 2 },
                    { rotate: 90 },
                    new OptionNormalizer(),
                    false,
                );
                const [output] = await run([transformStage(geometry)], input, {
                    width: 4,
                    height: 2,
                });
                const { frame } = output;
                assert.deepEqual(
                    [frame.format, frame.codedWidth, frame.codedHeight],
                    ['I420', 2, 4],
                );
                // Luma 4 × 2 (y × 4 + x) turned clockwise: each output row reads a source column
                // from the bottom up.
                assert.deepEqual([...frame.data.subarray(0, 8)], [4, 0, 5, 1, 6, 2, 7, 3]);
                assert.deepEqual([...frame.data.subarray(8)], [100, 101, 102, 103]);
                assert.deepEqual(frame.colorSpace, { matrix: 'bt709', fullRange: false });
                output.close();
            }));
    });
});
