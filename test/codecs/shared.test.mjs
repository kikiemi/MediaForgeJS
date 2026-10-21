import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { seededRandom } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const shared = path => import(distUrl(`esm/codecs/shared/${path}.js`));
const { idct8x8, idct8x8Add, idct8x8DcOnly, idct8x8Put } = await shared('idct');
const { ALTERNATE_8X8, ZIGZAG_8X8 } = await shared('dct-scan');
const yuv = await shared('yuv-rgba');
const { uncompressedVideoCodec } = await shared('raw-video');
const { RealFft } = await shared('real-fft');
const { POW43_MAX, pow43, pow43Table } = await shared('pow43');
const { CodecLifetime } = await shared('codec-lifetime');
const { DecoderWarnings } = await shared('decoder-warnings');
const { encoderLoader, lazyAudioEncoder } = await shared('lazy-audio-encoder');

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** A one-pixel-tall planar picture of `format` with the given planes, each its own stride. */
function picture(format, planes, width) {
    const data = new Uint8Array(planes.flat());
    let offset = 0;
    const layout = planes.map(plane => {
        const entry = { offset, stride: plane.length };
        offset += plane.length;
        return entry;
    });
    return { format, data, layout, codedWidth: width, codedHeight: 1 };
}

const rgbaOf = (pic, width, matrix = 'bt601', fullRange = false) => [
    ...yuv.planarToRgba(pic, { x: 0, y: 0, width, height: pic.codedHeight }, matrix, fullRange),
];

describe('shared', () => {
    describe('8x8 inverse DCT', () => {
        // The IEEE 1180-1990 reference: a double-precision separable DCT.
        const COS = Float64Array.from({ length: 64 }, (_, index) => {
            const k = index >> 3;
            const n = index & 7;
            return ((k === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * n + 1) * k * Math.PI) / 16)) / 2;
        });
        const transform = (input, output, forward) => {
            const temporary = new Float64Array(64);
            for (let row = 0; row < 8; row++)
                for (let k = 0; k < 8; k++) {
                    let sum = 0;
                    for (let n = 0; n < 8; n++)
                        sum += (forward ? COS[k * 8 + n] : COS[n * 8 + k]) * input[row * 8 + n];
                    temporary[row * 8 + k] = sum;
                }
            for (let column = 0; column < 8; column++)
                for (let k = 0; k < 8; k++) {
                    let sum = 0;
                    for (let n = 0; n < 8; n++)
                        sum +=
                            (forward ? COS[k * 8 + n] : COS[n * 8 + k]) * temporary[n * 8 + column];
                    output[k * 8 + column] = sum;
                }
        };
        const round = value => (value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5));

        for (const [low, high] of [
            [256, 255],
            [5, 5],
            [300, 300],
        ])
            for (const sign of [1, -1])
                test(`meets IEEE 1180 for -${low}..${high}, sign ${sign}`, () => {
                    // 10000 random blocks, the generator seeded with 1 for each run (Annex A).
                    let seed = 1;
                    const random = () => {
                        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
                        return (
                            Math.trunc(((seed & 0x7ffffffe) / 0x7fffffff) * (low + high + 1)) - low
                        );
                    };
                    const errorSum = new Float64Array(64);
                    const squareSum = new Float64Array(64);
                    let peak = 0;
                    const pixels = new Float64Array(64);
                    const coefficients = new Float64Array(64);
                    const reference = new Float64Array(64);
                    const block = new Int32Array(64);
                    for (let trial = 0; trial < 10000; trial++) {
                        for (let index = 0; index < 64; index++) pixels[index] = random() * sign;
                        transform(pixels, coefficients, true);
                        for (let index = 0; index < 64; index++)
                            block[index] = coefficients[index] = clamp(
                                round(coefficients[index]),
                                -2048,
                                2047,
                            );
                        transform(coefficients, reference, false);
                        idct8x8(block);
                        for (let index = 0; index < 64; index++) {
                            const error =
                                clamp(block[index], -256, 255) -
                                clamp(round(reference[index]), -256, 255);
                            errorSum[index] += error;
                            squareSum[index] += error * error;
                            peak = Math.max(peak, Math.abs(error));
                        }
                    }
                    assert(peak <= 1, `peak error ${peak}`);
                    for (let index = 0; index < 64; index++) {
                        assert(
                            squareSum[index] / 10000 <= 0.06,
                            `coefficient ${index} mean square error`,
                        );
                        assert(
                            Math.abs(errorSum[index] / 10000) <= 0.015,
                            `coefficient ${index} mean error`,
                        );
                    }
                    const total = errorSum.reduce((sum, value) => sum + value, 0);
                    const totalSquare = squareSum.reduce((sum, value) => sum + value, 0);
                    assert(
                        totalSquare / 640000 <= 0.02,
                        `overall mean square error ${totalSquare / 640000}`,
                    );
                    assert(
                        Math.abs(total / 640000) <= 0.0015,
                        `overall mean error ${total / 640000}`,
                    );
                });

        test('an all-zero block stays zero', () => {
            const zero = new Int32Array(64);
            idct8x8(zero);
            assert(zero.every(value => value === 0));
        });

        test('a DC-only block is flat at the DC shortcut value', () => {
            for (let dc = -2048; dc <= 2047; dc += 7) {
                const block = new Int32Array(64);
                block[0] = dc;
                idct8x8(block);
                assert(
                    block.every(value => value === idct8x8DcOnly(dc)),
                    `DC ${dc}`,
                );
            }
        });

        test('put and add write the transform clamped into a strided picture', () => {
            const random = seededRandom(7);
            for (let trial = 0; trial < 200; trial++) {
                const coefficients = Int32Array.from({ length: 64 }, (_, index) =>
                    index < 10 || random() < 0.1 ? Math.round((random() - 0.5) * 1600) : 0,
                );
                const expected = coefficients.slice();
                idct8x8(expected);
                const stride = 11;
                const put = new Uint8ClampedArray(stride * 8);
                idct8x8Put(coefficients.slice(), put, 2, stride);
                const prediction = Uint8ClampedArray.from({ length: stride * 8 }, () =>
                    Math.floor(random() * 256),
                );
                const added = prediction.slice();
                idct8x8Add(coefficients.slice(), added, 2, stride);
                for (let row = 0; row < 8; row++)
                    for (let column = 0; column < 8; column++) {
                        const index = 2 + row * stride + column;
                        const sample = expected[row * 8 + column];
                        assert.equal(put[index], clamp(sample, 0, 255));
                        assert.equal(added[index], clamp(prediction[index] + sample, 0, 255));
                    }
            }
        });

        test('both scans visit every coefficient once, in their standard order', () => {
            for (const scan of [ZIGZAG_8X8, ALTERNATE_8X8])
                assert.deepEqual(
                    [...scan].sort((a, b) => a - b),
                    [...Array(64).keys()],
                );
            assert.deepEqual([...ZIGZAG_8X8.subarray(0, 6)], [0, 1, 8, 16, 9, 2]);
            assert.deepEqual([...ALTERNATE_8X8.subarray(0, 6)], [0, 8, 16, 24, 1, 9]);
        });
    });

    describe('YUV to RGBA', () => {
        test('limited-range white and black reach 255 and 0', () => {
            const pic = picture(
                'I444',
                [
                    [235, 16],
                    [128, 128],
                    [128, 128],
                ],
                2,
            );
            assert.deepEqual(rgbaOf(pic, 2), [255, 255, 255, 255, 0, 0, 0, 255]);
        });

        test('full range takes 0..255 as it is', () => {
            const pic = picture(
                'I444',
                [
                    [255, 0],
                    [128, 128],
                    [128, 128],
                ],
                2,
            );
            assert.deepEqual(rgbaOf(pic, 2, 'bt709', true), [255, 255, 255, 255, 0, 0, 0, 255]);
        });

        test('BT.601 and BT.709 red differ in their luma weights', () => {
            // Limited-range red of BT.601 (81, 90, 240) and of BT.709 (63, 102, 240).
            const red601 = rgbaOf(picture('I444', [[81], [90], [240]], 1), 1, 'bt601');
            const red709 = rgbaOf(picture('I444', [[63], [102], [240]], 1), 1, 'bt709');
            for (const red of [red601, red709]) {
                assert(red[0] >= 253 && red[1] <= 2 && red[2] <= 2, `${red}`);
                assert.equal(red[3], 255);
            }
        });

        test('subsampled chroma serves the pixels that share it', () => {
            const i444 = picture(
                'I444',
                [
                    [100, 150],
                    [90, 90],
                    [200, 200],
                ],
                2,
            );
            const i420 = picture('I420', [[100, 150], [90], [200]], 2);
            const nv12 = picture(
                'NV12',
                [
                    [100, 150],
                    [90, 200],
                ],
                2,
            );
            assert.deepEqual(rgbaOf(i420, 2), rgbaOf(i444, 2));
            assert.deepEqual(rgbaOf(nv12, 2), rgbaOf(i444, 2));
        });

        test('packed RGB formats reorder their bytes; X is opaque', () => {
            assert.deepEqual(rgbaOf(picture('BGRX', [[3, 2, 1, 9]], 1), 1), [1, 2, 3, 255]);
            assert.deepEqual(rgbaOf(picture('BGRA', [[3, 2, 1, 9]], 1), 1), [1, 2, 3, 9]);
            assert.deepEqual(rgbaOf(picture('RGBA', [[1, 2, 3, 9]], 1), 1), [1, 2, 3, 9]);
        });

        test('alpha planes give the alpha of each pixel', () => {
            const pic = picture('I420A', [[235, 235], [128], [128], [10, 200]], 2);
            const rgba = rgbaOf(pic, 2);
            assert.deepEqual([rgba[3], rgba[7]], [10, 200]);
        });

        test('a region converts only its pixels', () => {
            const pic = picture(
                'I444',
                [
                    [16, 235, 16],
                    [128, 128, 128],
                    [128, 128, 128],
                ],
                3,
            );
            const region = { x: 1, y: 0, width: 1, height: 1 };
            assert.deepEqual(
                [...yuv.planarToRgba(pic, region, 'bt601', false)],
                [255, 255, 255, 255],
            );
        });

        test('names the matrix by colour or, unnamed, by picture size', () => {
            assert.equal(yuv.yuvMatrix('bt709', 640, 480), 'bt709');
            assert.equal(yuv.yuvMatrix('bt470bg', 1920, 1080), 'bt601');
            assert.equal(yuv.yuvMatrix('bt2020-ncl', 1920, 1080), 'bt2020');
            assert.equal(yuv.yuvMatrix(null, 720, 576), 'bt601');
            assert.equal(yuv.yuvMatrix(undefined, 1280, 720), 'bt709');
            assert.deepEqual(yuv.assumedYuvColour(1920, 1080), {
                primaries: 'bt709',
                transfer: 'bt709',
                matrix: 'bt709',
                fullRange: false,
            });
        });

        test('an unnamed wide picture of 576 lines or fewer is HD: 1280×534 is BT.709', () => {
            assert.equal(yuv.yuvMatrix(undefined, 1280, 534), 'bt709');
            assert.equal(yuv.assumedYuvColour(1280, 534).matrix, 'bt709');
            assert.equal(yuv.yuvMatrix(undefined, 1024, 576), 'bt601');
        });

        test('knows which formats it converts and their sample depths', () => {
            for (const format of [
                'I420',
                'I422',
                'I444',
                'NV12',
                'I420A',
                'I420P10',
                'BGRX',
                'RGBA',
            ])
                assert.equal(yuv.isConvertibleFormat(format), true, format);
            for (const format of ['YUY2', '', null])
                assert.equal(yuv.isConvertibleFormat(format), false);
            assert.deepEqual(['I420', 'I420P10', 'I444P12'].map(yuv.planarBitDepth), [8, 10, 12]);
        });
    });

    describe('uncompressed video', () => {
        test('a bottom-up PAL8 picture takes its palette and flips', () => {
            const decoder = uncompressedVideoCodec.create({
                codec: 'raw.PAL8.flip',
                description: Uint8Array.of(0, 0, 255, 0, 0, 255, 0, 0),
                codedWidth: 2,
                codedHeight: 1,
            });
            const [frame] = decoder.decode({
                data: Uint8Array.of(1, 0, 0, 0),
                timestamp: 0,
                duration: 0.04,
            });
            assert.equal(frame.format, 'BGRX');
            assert.deepEqual([...frame.data], [0, 255, 0, 255, 0, 0, 255, 255]);
        });

        test('RGB555 expands each five-bit channel to eight bits', () => {
            const decoder = uncompressedVideoCodec.create({
                codec: 'raw.RGB555',
                codedWidth: 1,
                codedHeight: 1,
            });
            const [frame] = decoder.decode({
                data: Uint8Array.of(0x1f, 0x7c, 0, 0),
                timestamp: 0,
                duration: 0.04,
            });
            assert.deepEqual([...frame.data], [255, 0, 255, 255]);
        });

        test('YV12 and NV12 become I420 with the chroma in its order', () => {
            const i420 = Uint8Array.of(10, 20, 30, 40, 1, 2);
            for (const [codec, data] of [
                ['raw.I420', i420],
                ['raw.YV12', Uint8Array.of(10, 20, 30, 40, 2, 1)],
                ['raw.NV12', Uint8Array.of(10, 20, 30, 40, 1, 2)],
            ]) {
                const decoder = uncompressedVideoCodec.create({
                    codec,
                    codedWidth: 2,
                    codedHeight: 2,
                });
                const [frame] = decoder.decode({ data, timestamp: 0, duration: 0.04 });
                const { data: bytes, layout } = frame;
                assert.deepEqual(
                    [frame.format, bytes[layout[1].offset], bytes[layout[2].offset]],
                    ['I420', 1, 2],
                    codec,
                );
            }
        });

        test('refuses unknown layouts, a missing size and short pictures', () => {
            assert.throws(
                () =>
                    uncompressedVideoCodec.create({
                        codec: 'raw.NOPE',
                        codedWidth: 1,
                        codedHeight: 1,
                    }),
                {
                    code: 'DECODE',
                },
            );
            assert.throws(() => uncompressedVideoCodec.create({ codec: 'raw.I420' }), {
                code: 'DECODE',
            });
            const decoder = uncompressedVideoCodec.create({
                codec: 'raw.I420',
                codedWidth: 2,
                codedHeight: 2,
            });
            assert.throws(
                () => decoder.decode({ data: new Uint8Array(3), timestamp: 0, duration: 0 }),
                {
                    code: 'DECODE',
                },
            );
        });

        test('every packet is a keyframe with its own time', () => {
            const decoder = uncompressedVideoCodec.create({
                codec: 'raw.BGRX',
                codedWidth: 1,
                codedHeight: 1,
            });
            const [frame] = decoder.decode({
                data: Uint8Array.of(1, 2, 3, 4),
                timestamp: 2,
                duration: 0.5,
            });
            assert.deepEqual([frame.keyFrame, frame.timestamp, frame.duration], [true, 2, 0.5]);
            assert.deepEqual([...decoder.flush()], []);
        });
    });

    describe('real FFT', () => {
        const size = 64;
        const fft = new RealFft(size);
        const spectrum = () => [new Float64Array(size / 2 + 1), new Float64Array(size / 2 + 1)];

        test('an impulse has a flat spectrum', () => {
            const [re, im] = spectrum();
            const impulse = new Float64Array(size);
            impulse[0] = 1;
            fft.forward(impulse, re, im);
            assert(
                re.every(value => Math.abs(value - 1) < 1e-12) &&
                    im.every(value => Math.abs(value) < 1e-12),
            );
        });

        test('a cosine of bin k lands in bin k alone', () => {
            const [re, im] = spectrum();
            const cosine = Float64Array.from({ length: size }, (_, n) =>
                Math.cos((2 * Math.PI * 5 * n) / size),
            );
            fft.forward(cosine, re, im);
            for (let bin = 0; bin <= size / 2; bin++)
                assert(
                    Math.abs(re[bin] - (bin === 5 ? size / 2 : 0)) < 1e-9 &&
                        Math.abs(im[bin]) < 1e-9,
                    `bin ${bin}`,
                );
        });

        test('inverse undoes forward', () => {
            const random = seededRandom(3);
            const input = Float64Array.from({ length: size }, () => random() - 0.5);
            const [re, im] = spectrum();
            fft.forward(input, re, im);
            const output = new Float64Array(size);
            fft.inverse(re, im, output);
            assert(output.every((value, index) => Math.abs(value - input[index]) < 1e-12));
        });
    });

    describe('q^(4/3)', () => {
        test('the table holds q^(4/3) up to its limit, beyond it is computed', () => {
            const table = pow43Table();
            assert.equal(table.length, POW43_MAX + 1);
            for (const q of [0, 1, 8, 8191, POW43_MAX]) assert.equal(table[q], Math.pow(q, 4 / 3));
            assert.equal(pow43(POW43_MAX + 10), Math.pow(POW43_MAX + 10, 4 / 3));
            assert.equal(pow43(27), Math.pow(27, 4 / 3));
        });
    });

    describe('codec lifetime', () => {
        test('stop() makes checks and waits fail with the stopped error', async () => {
            const lifetime = new CodecLifetime();
            assert.equal(lifetime.acceptingOutput, true);
            const waiting = lifetime.waitFor(new Promise(() => undefined));
            lifetime.stop();
            await assert.rejects(waiting, { code: 'DECODE' });
            assert.throws(() => lifetime.check(), { code: 'DECODE' });
            assert.equal(lifetime.acceptingOutput, false);
        });

        test('an abort signal fails it with ABORT', async () => {
            const controller = new AbortController();
            const lifetime = new CodecLifetime(controller.signal);
            const waiting = lifetime.waitFor(new Promise(() => undefined));
            controller.abort();
            await assert.rejects(waiting, { code: 'ABORT' });
            assert.throws(() => lifetime.check(), { code: 'ABORT' });
            assert.throws(() => new CodecLifetime(AbortSignal.abort()).check(), { code: 'ABORT' });
        });

        test('the first failure is kept; later ones return it', () => {
            const lifetime = new CodecLifetime();
            const first = new Error('first');
            assert.equal(lifetime.record(first), first);
            assert.equal(lifetime.record(new Error('second')), first);
            assert.throws(
                () => lifetime.check(),
                error => error === first,
            );
        });

        test('waitFor passes a settled value through', async () => {
            assert.equal(await new CodecLifetime().waitFor(Promise.resolve(7)), 7);
        });
    });

    describe('decoder warnings', () => {
        test('reports 24 diagnostics, then one notice, then nothing', () => {
            const seen = [];
            const warnings = new DecoderWarnings(message => seen.push(message));
            for (let index = 0; index < 40; index++) warnings.warn(`damage ${index}`);
            assert.equal(warnings.count, 40);
            assert.deepEqual(seen.slice(0, 2), ['damage 0', 'damage 1']);
            assert.deepEqual(seen.slice(23), ['damage 23', 'further diagnostics suppressed']);
        });

        test('without a listener diagnostics are counted, not printed', t => {
            const warn = t.mock.method(console, 'warn');
            const warnings = new DecoderWarnings();
            warnings.warn('damage');
            assert.equal(warnings.count, 1);
            assert.equal(warn.mock.callCount(), 0);
        });
    });

    describe('lazy audio encoders', () => {
        test('a placeholder carries its loader; a loaded encoder has none', async () => {
            const encoder = { encode() {} };
            const placeholder = lazyAudioEncoder(async () => encoder);
            assert.equal(await encoderLoader(placeholder)(), encoder);
            assert.equal(encoderLoader(encoder), undefined);
            assert.equal(encoderLoader(undefined), undefined);
        });
    });
});
