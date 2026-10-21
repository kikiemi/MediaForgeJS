// The WebAssembly SIMD kernels and the frame threads of the H.264 decoder decode the samples of
// the JavaScript kernels on a single thread.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { h264 } from 'mediaforgejs/plugins';
import {
    BASELINE_FIXTURE,
    CROPPED_FIXTURE,
    FIELD_SLICES_FIXTURE,
    HIGH_FIXTURE,
    INTERLACED_FIXTURE,
    MAIN_FIXTURE,
    annexBPackets,
    avccPackets,
    frameMd5,
} from '../helpers/h264-fixtures.mjs';
import { seededRandom } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const kernels = await import(distUrl('esm/codecs/h264/kernels.js'));
const { MotionCompensator, putBiWeighted, putWeighted } = await import(
    distUrl('esm/codecs/h264/inter-pred.js')
);
const transform = await import(distUrl('esm/codecs/h264/transform.js'));
const { deblockRowCount, deblockRows } = await import(distUrl('esm/codecs/h264/deblock.js'));
const { Picture, MB_FIELD, MB_INTRA, MB_T8X8, filterParams } = await import(
    distUrl('esm/codecs/h264/picture.js')
);
const { PICT_BOTTOM, PICT_FRAME, PICT_TOP } = await import(distUrl('esm/codecs/h264/tables.js'));
const threads = await import(distUrl('esm/codecs/h264/frame-threads.js'));
const { frameWorker } = await import(distUrl('esm/codecs/h264/frame-worker-url.js'));

const createDecoder = await h264.decoders.find(part => part.id === 'h264').load();
const FIXTURES = [
    BASELINE_FIXTURE,
    MAIN_FIXTURE,
    HIGH_FIXTURE,
    INTERLACED_FIXTURE,
    CROPPED_FIXTURE,
];
const FRAME_RATE = 25;

const chunkOf = (data, index) => ({
    data,
    timestamp: index / FRAME_RATE,
    duration: 1 / FRAME_RATE,
    isKeyframe: index === 0,
    trackType: 'video',
});

async function decodeMd5s(config, packets) {
    const decoder = await createDecoder({ ...config, onWarning: () => undefined });
    const frames = [];
    packets.forEach((data, index) => frames.push(...decoder.decode(chunkOf(data, index))));
    frames.push(...decoder.flush());
    decoder.close();
    return frames.map(frameMd5);
}

/**
 * Frame MD5s of every fixture, a resolution change, a per-packet configuration change and damaged
 * copies, with the kernels and threads selected when each decoder is created.
 */
async function decodeEverything() {
    const results = [];
    for (const fixture of [...FIXTURES, FIELD_SLICES_FIXTURE])
        results.push(await decodeMd5s({ codec: fixture.codec }, annexBPackets(fixture)));
    const switched = [HIGH_FIXTURE, INTERLACED_FIXTURE, BASELINE_FIXTURE].flatMap(annexBPackets);
    results.push(await decodeMd5s({ codec: HIGH_FIXTURE.codec }, switched));
    const configured = [HIGH_FIXTURE, BASELINE_FIXTURE].map(avccPackets);
    const decoder = await createDecoder({
        codec: HIGH_FIXTURE.codec,
        description: configured[0].description,
    });
    const frames = [];
    let index = 0;
    for (const { description, packets } of configured)
        for (const data of packets)
            frames.push(
                ...decoder.decode({ ...chunkOf(data, index++), codecConfig: description.slice() }),
            );
    frames.push(...decoder.flush());
    decoder.close();
    results.push(frames.map(frameMd5));
    const random = seededRandom(11);
    for (const fixture of FIXTURES)
        for (let round = 0; round < 3; round++) {
            const packets = annexBPackets(fixture).map(packet => {
                const data = packet.slice();
                if (random() < 0.5)
                    for (let flip = 0; flip < 1 + random() * 8; flip++)
                        data[5 + Math.floor(random() * (data.length - 5))] ^=
                            1 << Math.floor(random() * 8);
                return random() < 0.1 ? data.subarray(0, Math.floor(random() * data.length)) : data;
            });
            results.push(await decodeMd5s({ codec: fixture.codec }, packets));
        }
    // Field pairs repeated with packets dropped, cut and damaged: a B second field can then take
    // its own first field as the colocated picture, which must be read at the first field's
    // macroblocks.
    for (const seed of [7, 139]) {
        const next = seededRandom(seed);
        const packets = [];
        const repeat = 1 + Math.floor(next() * 3);
        for (let round = 0; round < repeat; round++)
            for (const packet of annexBPackets(FIELD_SLICES_FIXTURE)) {
                let data = packet.slice();
                const mode = next();
                if (mode < 0.15)
                    for (let flip = 0; flip < 1 + next() * 8; flip++)
                        data[5 + Math.floor(next() * (data.length - 5))] ^=
                            1 << Math.floor(next() * 8);
                else if (mode < 0.2) data = data.subarray(0, Math.floor(next() * data.length));
                else if (mode < 0.3) continue;
                packets.push(data);
            }
        results.push(await decodeMd5s({ codec: FIELD_SLICES_FIXTURE.codec }, packets));
    }
    return results;
}

/** The pictures a decoder shows for its first packet, at the start and after reset(). */
async function firstShown() {
    const decoder = await createDecoder({ codec: BASELINE_FIXTURE.codec });
    const [first] = annexBPackets(BASELINE_FIXTURE);
    const shown = decoder.decode(chunkOf(first, 0)).length;
    decoder.reset();
    const afterReset = decoder.decode(chunkOf(first, 0)).length;
    decoder.close();
    return [shown, afterReset];
}

/** Decodes the High fixture with a new decoder, closes it and returns it. */
async function decodeHighAndClose() {
    const decoder = await createDecoder({ codec: HIGH_FIXTURE.codec });
    annexBPackets(HIGH_FIXTURE).forEach((data, index) => decoder.decode(chunkOf(data, index)));
    decoder.flush();
    decoder.close();
    return decoder;
}

const reference = await decodeEverything();
const arena = await kernels.createKernelArena(false);

describe('h264', () => {
    describe('kernels', () => {
        const simd = arena?.kernels;
        const random = (() => {
            const next = seededRandom(99);
            return n => Math.floor(next() * n);
        })();
        /** `size` bytes in the kernel memory and in an array of their own, with one content. */
        const pair = (size, fill) => {
            const base = arena.allocate(size + 64);
            const local = new Uint8Array(size + 64);
            for (let index = 0; index < size; index++) local[index] = fill(index);
            arena.bytes.set(local, base);
            return { base, local, view: () => arena.bytes.subarray(base, base + size + 64) };
        };
        const plane = (store, wasm, offset, stride, width, height) => {
            const data = wasm ? store.view() : store.local;
            const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
            return { data, words, base: wasm ? store.base : 0, offset, stride, width, height };
        };
        const same = (actual, expected, message) => {
            if (
                actual.length !== expected.length ||
                actual.some((value, index) => value !== expected[index])
            )
                assert.fail(message);
        };

        test('Node decodes with the WebAssembly SIMD kernels', () => {
            assert(arena);
        });

        test('motion compensation and full-sample blending match the JavaScript', () => {
            const W = 48;
            const H = 32;
            const textures = [
                () => random(256),
                () => 100 + random(9),
                () => (random(2) ? 255 : 0),
            ];
            const wasmMc = new MotionCompensator();
            wasmMc.useKernels(arena);
            const jsMc = new MotionCompensator();
            const shapes = [
                [16, 16],
                [16, 8],
                [8, 16],
                [8, 8],
                [8, 4],
                [4, 8],
                [4, 4],
            ];
            for (let round = 0; round < 6; round++) {
                const samples = pair(W * H * 2, textures[round % 3]);
                const out = pair(16 * 16 * 2, () => 7);
                for (let block = 0; block < 300; block++) {
                    const field = random(3);
                    const offset = field === 2 ? W : 0;
                    const stride = field ? W * 2 : W;
                    const height = field ? H / 2 : H;
                    const [w, h] = shapes[random(shapes.length)];
                    const x = random(W + 16) - 8 - w / 2;
                    const y = random(height + 16) - 8 - h / 2;
                    const fx = random(4);
                    const fy = random(4);
                    const expected = new Uint8Array(512);
                    jsMc.luma(
                        plane(samples, false, offset, stride, W, height),
                        x,
                        y,
                        fx,
                        fy,
                        w,
                        h,
                        expected,
                        new Uint32Array(expected.buffer),
                        0,
                        16,
                    );
                    const view = out.view();
                    const words = new Uint32Array(view.buffer, view.byteOffset, 128);
                    wasmMc.luma(
                        plane(samples, true, offset, stride, W, height),
                        x,
                        y,
                        fx,
                        fy,
                        w,
                        h,
                        view,
                        words,
                        0,
                        16,
                    );
                    for (let row = 0; row < h; row++)
                        same(
                            out.view().subarray(row * 16, row * 16 + w),
                            expected.subarray(row * 16, row * 16 + w),
                            `luma ${w}x${h} at ${x},${y}+${fx}/4,${fy}/4`,
                        );
                    const cw = w >> 1;
                    const ch = random(2) ? h : h >> 1;
                    const cx = random(W / 2 + 8) - 4 - cw;
                    const cy = random(height / 2 + 8) - 4 - ch;
                    const cfx = random(8);
                    const cfy = random(8);
                    const chroma = new Uint8Array(512);
                    const chromaPlane = wasm =>
                        plane(samples, wasm, offset, stride, W / 2, height / 2);
                    jsMc.chroma(
                        chromaPlane(false),
                        W * H,
                        cx,
                        cy,
                        cfx,
                        cfy,
                        cw,
                        ch,
                        chroma,
                        new Uint32Array(chroma.buffer),
                        0,
                        8,
                        16,
                    );
                    wasmMc.chroma(
                        chromaPlane(true),
                        W * H,
                        cx,
                        cy,
                        cfx,
                        cfy,
                        cw,
                        ch,
                        view,
                        words,
                        0,
                        8,
                        16,
                    );
                    for (let row = 0; row < ch; row++)
                        for (const column of [0, 8]) {
                            const at = row * 16 + column;
                            same(
                                out.view().subarray(at, at + cw),
                                chroma.subarray(at, at + cw),
                                `chroma ${cw}x${ch}`,
                            );
                        }
                    const logWD = random(8);
                    const weights = random(2)
                        ? [1 << logWD, 1 << logWD, 0]
                        : [random(256) - 128, random(256) - 128, random(256) - 128];
                    const bx = random(W - w + 1);
                    const by = random(height - h + 1);
                    const sx = random(W - w + 1);
                    const sy = random(height - h + 1);
                    const blended = new Uint8Array(512);
                    const full = wasm => plane(samples, wasm, offset, stride, W, height);
                    jsMc.blendFullSamples(
                        full(false),
                        bx,
                        by,
                        full(false),
                        sx,
                        sy,
                        0,
                        w,
                        h,
                        blended,
                        new Uint32Array(blended.buffer),
                        0,
                        16,
                        ...weights,
                        logWD,
                    );
                    wasmMc.blendFullSamples(
                        full(true),
                        bx,
                        by,
                        full(true),
                        sx,
                        sy,
                        0,
                        w,
                        h,
                        view,
                        words,
                        0,
                        16,
                        ...weights,
                        logWD,
                    );
                    for (let row = 0; row < h; row++)
                        same(
                            out.view().subarray(row * 16, row * 16 + w),
                            blended.subarray(row * 16, row * 16 + w),
                            `blend ${w}x${h} weights ${weights}`,
                        );
                }
            }
        });

        test('weighted prediction matches the JavaScript', () => {
            for (let block = 0; block < 1500; block++) {
                const a = pair(256, () => random(256));
                const b = pair(256, () => random(256));
                const w = [2, 4, 8, 16][random(4)];
                const h = [2, 4, 8, 16][random(4)];
                const logWD = random(8);
                const w0 = random(256) - 128;
                const w1 = random(256) - 128;
                const offset = random(256) - 128;
                const single = random(2) === 0;
                const expected = new Uint8Array(32 * 16);
                if (single) putWeighted(a.local, 0, expected, 0, 32, w, h, w0, offset, logWD);
                else
                    putBiWeighted(
                        a.local,
                        b.local,
                        0,
                        expected,
                        0,
                        32,
                        w,
                        h,
                        w0,
                        w1,
                        offset,
                        logWD,
                    );
                const out = pair(32 * 16, () => 0);
                if (single) simd.weight1(a.base, 16, out.base, 32, w, h, w0, offset, logWD);
                else
                    simd.weight2(a.base, 16, b.base, 16, out.base, 32, w, h, w0, w1, offset, logWD);
                same(
                    out.view().subarray(0, 32 * 16),
                    expected,
                    `weighted ${single ? 'single' : 'bi'} ${w}x${h}`,
                );
            }
        });

        test('inverse transforms match the JavaScript and clear their coefficients', () => {
            for (let block = 0; block < 1500; block++) {
                const size = random(2) ? 8 : 4;
                const range = [1 << 30, 4096, 64][random(3)];
                const coefficients = Int32Array.from({ length: size * size }, () =>
                    random(2) ? 0 : random(range) - range / 2,
                );
                const pixels = pair(size * 32, () => random(256));
                const expected = new Uint8ClampedArray(pixels.local.subarray(0, size * 32));
                const dcOnly = random(4) === 0;
                if (dcOnly)
                    (size === 4 ? transform.dc4x4Add : transform.dc8x8Add)(
                        coefficients[0],
                        expected,
                        0,
                        32,
                    );
                else
                    (size === 4 ? transform.idct4x4Add : transform.idct8x8Add)(
                        Int32Array.from(coefficients),
                        0,
                        expected,
                        0,
                        32,
                    );
                const address = arena.allocate(256);
                new Int32Array(arena.buffer, address, size * size).set(coefficients);
                if (dcOnly) simd.dc_add(coefficients[0], pixels.base, 32, size);
                else (size === 4 ? simd.idct4_add : simd.idct8_add)(address, pixels.base, 32);
                same(
                    pixels.view().subarray(0, size * 32),
                    expected,
                    `${dcOnly ? 'DC' : 'transform'} ${size}x${size}`,
                );
                if (!dcOnly)
                    same(
                        new Int32Array(arena.buffer, address, size * size),
                        new Int32Array(size * size),
                        'cleared',
                    );
            }
        });

        test('deblocking matches the JavaScript for frames, fields and MBAFF', () => {
            for (let round = 0; round < 40; round++) {
                const mbWidth = 3;
                const mbHeight = 4;
                const chromaFormat = 1 + random(2);
                const structure = [PICT_FRAME, PICT_FRAME, PICT_TOP, PICT_BOTTOM][random(4)];
                const mbaff = structure === PICT_FRAME && random(2) === 1;
                const pictures = [
                    new Picture(1, mbWidth, mbHeight, chromaFormat, arena),
                    new Picture(1, mbWidth, mbHeight, chromaFormat),
                ];
                const smooth = random(3);
                for (let index = 0; index < pictures[1].data.length; index++)
                    pictures[1].data[index] =
                        smooth === 0
                            ? random(256)
                            : 90 + ((index >> 2) & 7) * (smooth + 1) + random(4);
                pictures[0].data.set(pictures[1].data);
                const count = mbWidth * mbHeight;
                const flags = Uint8Array.from(
                    { length: count },
                    () => (random(4) === 0 ? MB_INTRA : 0) | (random(2) ? MB_T8X8 : 0),
                );
                if (mbaff)
                    for (let xy = 0; xy < count; xy++)
                        if ((Math.floor(xy / mbWidth) & 1) === 0 && random(2))
                            flags[xy] |= flags[xy + mbWidth] |= MB_FIELD;
                const refIds = [0, 1].map(() =>
                    Int32Array.from({ length: count * 4 }, () => random(3) - 1),
                );
                const vectors = [0, 1].map(() =>
                    Int16Array.from({ length: count * 32 }, () => random(13) - 6),
                );
                // Two slices, the second filtering inside itself only; macroblocks of slice -1
                // were never decoded.
                const slices = [0, 2].map(disableIdc =>
                    filterParams(
                        disableIdc,
                        (random(13) - 6) * 2,
                        (random(13) - 6) * 2,
                        random(25) - 12,
                        random(25) - 12,
                    ),
                );
                // A field picture holds the rows of its parity, all of field macroblocks.
                const parity = structure === PICT_BOTTOM ? 1 : 0;
                const inPicture = xy =>
                    structure === PICT_FRAME || (Math.floor(xy / mbWidth) & 1) === parity;
                if (structure !== PICT_FRAME)
                    for (let xy = 0; xy < count; xy++) flags[xy] |= MB_FIELD;
                const sliceNum = Int32Array.from({ length: count }, (_, xy) =>
                    inPicture(xy) && random(8) ? random(2) : -1,
                );
                const macroblocks = {
                    qp: Uint8Array.from({ length: count }, () => 16 + random(36)),
                    nzMask: Uint16Array.from({ length: count }, () =>
                        random(2) ? random(65536) : 0,
                    ),
                    motionClass: Uint8Array.from({ length: count }, () => random(5)),
                    sliceNum,
                    filterParams: Int32Array.from(sliceNum, slice => slices[slice] ?? 0),
                };
                for (const picture of pictures) {
                    picture.mbFlags.set(flags);
                    for (const list of [0, 1]) {
                        picture.refId[list].set(refIds[list]);
                        picture.mv[list].set(vectors[list]);
                    }
                    for (const [name, values] of Object.entries(macroblocks))
                        picture[name].set(values);
                }
                for (const [index, picture] of pictures.entries()) {
                    const input = { picture, mbaff, structure, kernels: index ? null : simd };
                    deblockRows(input, 0, deblockRowCount(input));
                }
                same(
                    pictures[0].data,
                    pictures[1].data,
                    `${mbaff ? 'MBAFF ' : ''}structure ${structure} chroma ${chromaFormat}`,
                );
            }
        });

        test('fixtures, changes and damaged streams decode the same without them', async () => {
            kernels.setH264KernelsEnabled(false);
            try {
                assert.deepEqual(await decodeEverything(), reference);
            } finally {
                kernels.setH264KernelsEnabled(true);
            }
            assert.deepEqual(
                reference[FIXTURES.length + 1],
                [HIGH_FIXTURE, INTERLACED_FIXTURE, BASELINE_FIXTURE].flatMap(
                    fixture => fixture.md5,
                ),
            );
        });
    });

    describe('frame threads', () => {
        // Node worker_threads share the kernel memory; each picture decodes as a job waiting for
        // the rows of its references, and frames leave a few packets late. macroblocks 0 threads
        // pictures of any size.
        test('a threaded decoder shows its first pictures as early as one thread', async () => {
            threads.setH264Threads({ workers: 0 });
            const single = await firstShown();
            threads.setH264Threads({ workers: 2, macroblocks: 0 });
            try {
                assert(single[0] > 0);
                assert.deepEqual(await firstShown(), single);
            } finally {
                threads.setH264Threads({});
            }
        });

        test('without warm-up the first picture waits while later ones decode', async () => {
            threads.setH264Threads({ workers: 2, macroblocks: 0, warmup: 0 });
            try {
                assert.deepEqual(await firstShown(), [0, 0]);
            } finally {
                threads.setH264Threads({});
            }
        });

        test('threads decode fixtures, changes and damaged streams the same', async () => {
            threads.setH264Threads({ workers: 2, macroblocks: 0, warmup: 0 });
            try {
                assert.deepEqual(await decodeEverything(), reference);
            } finally {
                threads.setH264Threads({});
            }
        });

        test('a closed decoder leaves its memory and workers to the next one', async () => {
            threads.setH264Threads({ workers: 2, macroblocks: 0, warmup: 0 });
            try {
                const first = await decodeHighAndClose();
                assert.equal(threads.idleFrameWorkers(), 2, 'its two workers wait');
                const second = await createDecoder({ codec: HIGH_FIXTURE.codec });
                assert(second.arena !== null && second.arena === first.arena);
                second.close();
                assert.deepEqual(
                    await decodeEverything(),
                    reference,
                    'a reused memory decodes the same',
                );
            } finally {
                threads.setH264Threads({});
            }
        });

        test('the workers of a memory not kept end with it', async () => {
            // Idle, they would hold the memory on (they seldom collect their heap).
            threads.setH264Threads({ workers: 2, macroblocks: 0, warmup: 0, keptMemory: 2 ** 40 });
            try {
                const unkept = await decodeHighAndClose();
                assert.equal(threads.idleFrameWorkers(), 0);
                assert.notEqual((await decodeHighAndClose()).arena, unkept.arena);
            } finally {
                threads.setH264Threads({});
            }
        });

        test("Node's frame worker file sits next to the decoder's chunk", () => {
            const workerFile = fileURLToPath(frameWorker.node());
            assert(existsSync(workerFile), workerFile);
        });
    });
});
