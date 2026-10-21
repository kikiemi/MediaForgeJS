import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { proresFrames } from '../../../test/helpers/prores-fixtures.mjs';
import { proresVariants } from '../../../test/helpers/prores-variants.mjs';
import { createProResDecoder, createProResEncoder, proResVideoCodec } from '../index.js';

describe('packages/prores', () => {
    const packet = data => ({
        data,
        timestamp: 1.25,
        duration: 0.04,
        isKeyframe: true,
        trackType: 'video',
    });
    // Reference Y/Cb/Cr samples decoded from these original fixtures by FFmpeg 6.1.1.
    // Tests consume these numbers only; FFmpeg is not a test/runtime dependency.
    const reference = {
        apco: [
            [84, 531, 523],
            [185, 554, 525],
            [526, 512, 166],
        ],
        apcs: [
            [72, 521, 519],
            [189, 551, 528],
            [552, 523, 202],
        ],
        apcn: [
            [69, 518, 516],
            [187, 553, 526],
            [559, 525, 217],
        ],
        apch: [
            [65, 516, 517],
            [187, 554, 528],
            [566, 516, 209],
        ],
        ap4h: [
            [257, 2049, 2047],
            [746, 2224, 2132],
            [2285, 2079, 868],
        ],
        ap4x: [
            [567, 2100, 2012],
            [1055, 2276, 2098],
            [2598, 2130, 834],
        ],
    };
    const rgba = (width = 32, height = 24, alpha = false) => {
        const data = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++)
            data.set([64, 128, 192, alpha ? i % 256 : 255], i * 4);
        return { data, format: 'RGBA', width, height, timestamp: 1.25, duration: 0.04 };
    };

    test('ProRes provider recognizes six profiles, and keeps RAW separate', () => {
        for (const codec of Object.keys(proresFrames)) {
            assert.equal(proResVideoCodec.supportsDecode(codec), true);
            assert.equal(proResVideoCodec.supportsEncode(codec), true);
        }
        for (const codec of ['aprn', 'aprh', 'prores-raw', 'hvc1', 'prores']) {
            assert.equal(proResVideoCodec.supportsDecode(codec), false);
            assert.equal(proResVideoCodec.supportsEncode(codec), false);
        }
    });

    for (const [codec, data] of Object.entries(proresFrames)) {
        test(
            `ProRes ${codec} decodes actual packets with native planes and owned ` + `lifetime`,
            async () => {
                const decoder = await createProResDecoder({ codec, width: 32, height: 24 });
                let frame;
                try {
                    frame = await decoder.decode(packet(data));
                    assert.equal(frame.format, codec.startsWith('ap4') ? 'I444P12A16' : 'I422P10');
                    assert.equal(frame.bitDepth, codec.startsWith('ap4') ? 12 : 10);
                    assert.equal(frame.alphaBitDepth, codec.startsWith('ap4') ? 16 : 0);
                    assert.equal(frame.visibleWidth, 32);
                    assert.equal(frame.visibleHeight, 24);
                    assert.equal(frame.timestamp, 1.25);
                    assert.equal(frame.duration, 0.04);
                    assert.equal(frame.scanType, 'progressive');
                    assert.equal(frame.layout.length, codec.startsWith('ap4') ? 4 : 3);
                    const snapshot = frame.data.slice();
                    const second = await decoder.decode(packet(data));
                    second.close();
                    await decoder.close();
                    assert.deepEqual(frame.data, snapshot);
                    const samples = new Uint16Array(
                        frame.data.buffer,
                        frame.data.byteOffset,
                        frame.data.byteLength / 2,
                    );
                    assert.ok(
                        samples.some(value => value > 255),
                        'native high-depth samples were retained',
                    );
                    const decoded = new DataView(frame.data.buffer, frame.data.byteOffset);
                    for (const [index, [x, y]] of [
                        [0, 0],
                        [5, 3],
                        [31, 23],
                    ].entries())
                        for (let plane = 0; plane < 3; plane++) {
                            const cx = plane && codec.startsWith('apc') ? Math.floor(x / 2) : x;
                            const sample = decoded.getUint16(
                                frame.layout[plane].offset +
                                    y * frame.layout[plane].stride +
                                    cx * 2,
                                true,
                            );
                            assert.ok(
                                Math.abs(sample - reference[codec][index][plane]) <= 1,
                                `reference pixel ${x},${y}, plane ${plane}`,
                            );
                        }
                    if (frame.alphaBitDepth) {
                        const alpha = frame.layout[3];
                        const view = new DataView(frame.data.buffer, frame.data.byteOffset);
                        // The fixture's 8-bit alpha was expanded through a 10-bit encoder input.
                        assert.equal(
                            view.getUint16(alpha.offset, true),
                            codec === 'ap4h' ? 0 : (124 << 6) | (124 >> 4),
                        );
                        assert.ok(
                            view.getUint16(alpha.offset + 2, true) & 15,
                            'low alpha bits survive',
                        );
                    }
                    await assert.rejects(frame.toRgba(), /allowPrecisionLoss/);
                    const rgb = await frame.toRgba({ allowPrecisionLoss: true });
                    assert.equal(rgb.data.length, 32 * 24 * 4);
                } finally {
                    frame?.close();
                    await decoder.close();
                }
                assert.equal(frame.closed, true);
                assert.throws(() => frame.data, /closed/);
            },
        );
    }

    for (const [name, fixture] of Object.entries(proresVariants)) {
        test(`ProRes preserves ${name} dimensions, scan type and alpha precision`, async () => {
            const decoder = await createProResDecoder(fixture);
            let frame;
            try {
                frame = await decoder.decode(packet(fixture.data));
                assert.equal(frame.visibleWidth, fixture.width);
                assert.equal(frame.visibleHeight, fixture.height);
                const mode = (fixture.data[20] >> 2) & 3;
                assert.equal(
                    frame.scanType,
                    ['progressive', 'interlaced-top-field-first', 'interlaced-bottom-field-first'][
                        mode
                    ],
                );
                const alphaMode = fixture.data[25] & 15;
                assert.equal(frame.alphaBitDepth, alphaMode === 2 ? 16 : alphaMode === 1 ? 12 : 0);
                if (alphaMode === 2) assert.ok(frame.format.endsWith('A16'));
            } finally {
                frame?.close();
                await decoder.close();
            }
        });
    }

    for (const codec of Object.keys(proresFrames)) {
        test(`ProRes ${codec} encodes RGBA8 into a real decodable packet`, async () => {
            const input = rgba(32, 24, codec.startsWith('ap4'));
            const encoder = await createProResEncoder({ codec, width: 32, height: 24 });
            const decoder = await createProResDecoder({ codec, width: 32, height: 24 });
            let frame;
            try {
                const encoded = await encoder.encode(input);
                assert.equal(new TextDecoder().decode(encoded.data.subarray(4, 8)), 'icpf');
                assert.equal(
                    new DataView(encoded.data.buffer).getUint32(0),
                    encoded.data.byteLength,
                );
                assert.equal(encoded.timestamp, input.timestamp);
                assert.equal(encoded.duration, input.duration);
                assert.equal(encoded.isKeyframe, true);
                assert.equal(encoded.trackType, 'video');
                frame = await decoder.decode(encoded);
                const output = await frame.toRgba({ allowPrecisionLoss: true });
                for (let i = 0; i < input.data.length; i++) {
                    const tolerance = i % 4 === 3 ? 0 : 3;
                    assert.ok(
                        Math.abs(output.data[i] - input.data[i]) <= tolerance,
                        `component ${i}: ${output.data[i]} vs ${input.data[i]}`,
                    );
                }
            } finally {
                frame?.close();
                await encoder.close();
                await decoder.close();
            }
        });
    }

    test(
        'ProRes rejects invalid input, profile contradictions and silent precision/alpha ' + 'loss',
        async () => {
            await assert.rejects(createProResDecoder({ codec: 'aprn' }), /RAW|codec/);
            await assert.rejects(
                createProResEncoder({ codec: 'apch', width: 0, height: 24 }),
                /dimensions/,
            );
            const encoder = await createProResEncoder({ codec: 'apch', width: 32, height: 24 });
            const decoder = await createProResDecoder({ codec: 'apch', width: 32, height: 24 });
            try {
                await assert.rejects(encoder.encode(rgba(32, 24, true)), /alpha/);
                await assert.rejects(
                    encoder.encode({ ...rgba(), format: 'RGBA64', data: new Uint16Array(3072) }),
                    /RGBA8|RGBA/,
                );
                await assert.rejects(
                    encoder.encode({ ...rgba(), scanType: 'interlaced-top-field-first' }),
                    /interlac/,
                );
                await assert.rejects(
                    encoder.encode({ ...rgba(), colorPrimaries: 9 }),
                    /color|primar/,
                );
                await assert.rejects(encoder.encode({ ...rgba(), timestamp: NaN }), /timestamp/);
                await assert.rejects(decoder.decode(packet(proresFrames.ap4h)), /profile|chroma/);
                await assert.rejects(
                    decoder.decode(packet(proresFrames.apch.slice(0, 180))),
                    /size|truncated|packet/,
                );
                const wrongSize = proresFrames.apch.slice();
                wrongSize[17] = 33;
                await assert.rejects(decoder.decode(packet(wrongSize)), /dimensions/);
                const wrongVersion = proresFrames.apch.slice();
                wrongVersion[10] = 1;
                await assert.rejects(decoder.decode(packet(wrongVersion)), /version/);
            } finally {
                await encoder.close();
                await decoder.close();
            }
            await assert.rejects(encoder.encode(rgba()), /closed/);
            await assert.rejects(decoder.decode(packet(proresFrames.apch)), /closed/);
        },
    );

    test('ProRes takes ownership of queued Buffer packet bytes', async () => {
        const decoder = await createProResDecoder({ codec: 'apch' });
        let frame;
        try {
            const input = Buffer.from(proresFrames.apch);
            const pending = decoder.decode(packet(input));
            input.fill(0);
            frame = await pending;
            assert.equal(frame.format, 'I422P10');
            const luma = new DataView(frame.data.buffer, frame.data.byteOffset).getUint16(0, true);
            assert.ok(Math.abs(luma - reference.apch[0][0]) <= 1);
        } finally {
            frame?.close();
            await decoder.close();
        }
    });

    test(
        'ProRes preserves independently packed sixteen-bit alpha values, including low ' + 'bits',
        async () => {
            // An original alpha pattern inserted into the original fixture's two slices.
            // Literal deltas exercise every alpha bit without a lossy RGB/YUV conversion.
            const source = proresFrames.ap4h;
            const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
            const picture = 8 + view.getUint16(8);
            const table = picture + (source[picture] >>> 3);
            const count = view.getUint16(picture + 5);
            assert.equal(count, 2);
            const expectedAlpha = (x, y) => (x * 1987 + y * 7919 + 3) & 65535;
            let start = table + count * 2;
            const slices = [];
            for (let s = 0; s < count; s++) {
                const size = view.getUint16(table + s * 2);
                const alphaStart =
                    start +
                    (source[start] >>> 3) +
                    view.getUint16(start + 2) +
                    view.getUint16(start + 4) +
                    view.getUint16(start + 6);
                const alpha = new Uint8Array(Math.ceil((512 * 18 - 1) / 8));
                let bit = 0;
                let previous = 65535;
                const write = (value, width) => {
                    for (let b = width - 1; b >= 0; b--, bit++)
                        alpha[bit >> 3] |= ((value >> b) & 1) << (7 - (bit & 7));
                };
                for (let n = 0; n < 512; n++) {
                    const current = expectedAlpha(n % 32, s * 16 + Math.floor(n / 32));
                    write(1, 1);
                    write((current - previous) & 65535, 16);
                    if (n !== 511) write(1, 1);
                    previous = current;
                }
                const slice = new Uint8Array(alphaStart - start + alpha.length);
                slice.set(source.subarray(start, alphaStart));
                slice.set(alpha, alphaStart - start);
                slices.push(slice);
                start += size;
            }
            const bytes = new Uint8Array(
                table + count * 2 + slices.reduce((sum, data) => sum + data.length, 0),
            );
            bytes.set(source.subarray(0, table + count * 2));
            const result = new DataView(bytes.buffer);
            result.setUint32(0, bytes.length);
            result.setUint32(picture + 1, bytes.length - picture);
            start = table + count * 2;
            for (let i = 0; i < count; i++) {
                result.setUint16(table + i * 2, slices[i].length);
                bytes.set(slices[i], start);
                start += slices[i].length;
            }
            const decoder = await createProResDecoder({ codec: 'ap4h' });
            let frame;
            try {
                frame = await decoder.decode(packet(bytes));
                const values = new DataView(frame.data.buffer, frame.data.byteOffset);
                for (let y = 0; y < 24; y++)
                    for (let x = 0; x < 32; x++) {
                        assert.equal(
                            values.getUint16(
                                frame.layout[3].offset + y * frame.layout[3].stride + x * 2,
                                true,
                            ),
                            expectedAlpha(x, y),
                        );
                    }
            } finally {
                frame?.close();
                await decoder.close();
            }
        },
    );

    test(
        'ProRes bounds pending frames and cancels queued work with the original abort ' + 'reason',
        async () => {
            const controller = new AbortController();
            const decoder = await createProResDecoder({
                codec: 'apch',
                signal: controller.signal,
                maxQueueSize: 1,
            });
            const pending = decoder.decode(packet(proresFrames.apch));
            const overflow = decoder.decode(packet(proresFrames.apch));
            await assert.rejects(overflow, /queue|backpressure/);
            const frame = await pending;
            frame.close();
            assert.equal(decoder.queueSize, 0);
            const reason = new Error('stop exact request');
            const late = decoder.decode(packet(proresFrames.apch));
            controller.abort(reason);
            await assert.rejects(late, error => error === reason);
            await assert.rejects(
                decoder.decode(packet(proresFrames.apch)),
                error => error === reason,
            );
            await decoder.close();
            await decoder.close();
            await assert.rejects(
                createProResEncoder({
                    codec: 'apch',
                    width: 32,
                    height: 24,
                    signal: controller.signal,
                }),
                error => error === reason,
            );
        },
    );

    test('ProRes factories snapshot options before asynchronous module loading', async () => {
        const decoderOptions = { codec: 'apch', width: 32, height: 24 };
        const openingDecoder = createProResDecoder(decoderOptions);
        decoderOptions.codec = 'ap4h';
        const decoder = await openingDecoder;
        let frame;
        try {
            frame = await decoder.decode(packet(proresFrames.apch));
            assert.equal(frame.format, 'I422P10');
        } finally {
            frame?.close();
            await decoder.close();
        }
        const encoderOptions = { codec: 'apch', width: 32, height: 24, framerate: 25 };
        const openingEncoder = createProResEncoder(encoderOptions);
        encoderOptions.framerate = NaN;
        const encoder = await openingEncoder;
        try {
            assert.ok((await encoder.encode(rgba())).data.byteLength > 28);
        } finally {
            await encoder.close();
        }
    });

    test('ProRes factories reject invalid pixel limits and signals', async () => {
        const config = { codec: 'apch', width: 32, height: 24 };
        for (const create of [createProResDecoder, createProResEncoder]) {
            await assert.rejects(create({ ...config, maxPixels: NaN }), /maxPixels/);
            await assert.rejects(create({ ...config, signal: { aborted: false } }), /AbortSignal/);
            const failure = new Error('cannot attach an abort listener');
            await assert.rejects(
                create({
                    ...config,
                    signal: {
                        aborted: false,
                        addEventListener() {
                            throw failure;
                        },
                        removeEventListener() {},
                    },
                }),
                error => error === failure,
            );
        }
    });

    test('ProRes closed encoder handles release their WASM memory', () => {
        // Isolate collection from the test runner and keep the closed handles alive; a handle that
        // kept the module would hold at least 64 MiB.
        const adapterUrl = new URL('../index.js', import.meta.url).href;
        execFileSync(
            process.execPath,
            [
                '--expose-gc',
                '--input-type=module',
                '-e',
                `
                import assert from 'node:assert/strict';
                import { setImmediate } from 'node:timers/promises';
                const memories = [];
                const instantiate = WebAssembly.instantiate;
                WebAssembly.instantiate = async (...args) => {
                    const result = await instantiate(...args);
                    for (const value of Object.values((result.instance ?? result).exports))
                        if (value instanceof WebAssembly.Memory) memories.push(new WeakRef(value));
                    return result;
                };
                const { createProResEncoder } = await import(${JSON.stringify(adapterUrl)});
                const closed = [];
                for (let index = 0; index < 3; index++) {
                    const encoder = await createProResEncoder({
                        codec: 'apch', width: 32, height: 24,
                    });
                    await encoder.encode({
                        data: new Uint8Array(32 * 24 * 4).fill(255), format: 'RGBA',
                        width: 32, height: 24, timestamp: 0, duration: 1 / 30,
                    });
                    await encoder.close();
                    closed.push(encoder);
                }
                for (let index = 0; index < 5; index++) { await setImmediate(); globalThis.gc(); }
                assert.equal(memories.length, 3, 'observed each real WASM module');
                assert.equal(memories.filter(memory => memory.deref()).length, 0);
                assert.ok(closed.every(encoder => encoder.closed));
            `,
            ],
            { encoding: 'utf8', timeout: 30000 },
        );
    });
});
