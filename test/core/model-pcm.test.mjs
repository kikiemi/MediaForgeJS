import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distUrl } from '../helpers/dist-paths.mjs';

// The one rule by which float samples become signed integers (core/model/pcm-quantize): scaled by
// 2^(bits-1), rounded half up, clamped. Every writer of integer PCM from float planes uses it.

const { quantizeSample } = await import(distUrl('esm/core/model/pcm-quantize.js'));

const BITS = [8, 16, 24, 32];

describe('model: PCM quantization', () => {
    test('±1 become the ends of the range, and values beyond them clamp', () => {
        for (const bits of BITS) {
            const scale = 2 ** (bits - 1);
            assert.equal(quantizeSample(1, bits), scale - 1, `${bits} bits`);
            assert.equal(quantizeSample(-1, bits), -scale, `${bits} bits`);
            assert.equal(quantizeSample(1.5, bits), scale - 1, `${bits} bits`);
            assert.equal(quantizeSample(-1.5, bits), -scale, `${bits} bits`);
            assert.equal(quantizeSample(Infinity, bits), scale - 1, `${bits} bits`);
            assert.equal(quantizeSample(-Infinity, bits), -scale, `${bits} bits`);
        }
    });

    test('half a step rounds up, and a sample that is not a number is silence', () => {
        for (const bits of BITS) {
            const step = 2 ** -(bits - 1);
            assert.equal(quantizeSample(0.5 * step, bits), 1, `+0.5 LSB at ${bits} bits`);
            assert.equal(quantizeSample(-0.5 * step, bits), 0, `-0.5 LSB at ${bits} bits`);
            assert.equal(quantizeSample(0.49 * step, bits), 0, `+0.49 LSB at ${bits} bits`);
            assert.equal(quantizeSample(-0.51 * step, bits), -1, `-0.51 LSB at ${bits} bits`);
            assert.equal(quantizeSample(2.5 * step, bits), 3, `+2.5 LSB at ${bits} bits`);
            assert.equal(quantizeSample(-2.5 * step, bits), -2, `-2.5 LSB at ${bits} bits`);
            assert.equal(quantizeSample(NaN, bits), 0, `NaN at ${bits} bits`);
        }
    });

    test('an integer read as integer / 2^(bits-1) quantizes back to itself', () => {
        // 8, 16 and 24 bits through a Float32Array, as the decoders hand samples over: each
        // value of those widths is exact there.
        const planes = new Float32Array(1);
        for (const bits of [8, 16, 24]) {
            const scale = 2 ** (bits - 1);
            for (let value = -scale; value < scale; value++) {
                planes[0] = value / scale;
                const back = quantizeSample(planes[0], bits);
                if (back !== value) assert.fail(`${value} at ${bits} bits came back ${back}`);
            }
        }
        // 32 bits in doubles, the ends and values spread over the range.
        const scale = 2 ** 31;
        for (const value of [-scale, -scale + 1, -1, 0, 1, scale - 2, scale - 1])
            assert.equal(quantizeSample(value / scale, 32), value);
        for (let value = -scale; value < scale; value += 9_999_991)
            assert.equal(quantizeSample(value / scale, 32), value);
    });
});
