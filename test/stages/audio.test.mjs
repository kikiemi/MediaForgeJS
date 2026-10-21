import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { remix, stageAudio, timeStretch } from 'mediaforgejs/parts';
import { distUrl } from '../helpers/dist-paths.mjs';

const { remixStage } = await import(distUrl('esm/stages/audio.js'));
const { timeStretchStage } = await import(distUrl('esm/stages/time-stretch.js'));

/**
 * Sound of the given planes, read in blocks of `block` frames (or of the sizes listed), with the
 * speaker mask given.
 */
function source(planes, sampleRate, block = 1000, channelMask = undefined) {
    const sizes = Array.isArray(block) ? block : [block];
    return {
        sampleRate,
        channels: planes.length,
        estimatedFrames: planes[0].length,
        ...(channelMask !== undefined ? { channelMask } : {}),
        async *chunks() {
            for (let at = 0, k = 0; at < planes[0].length; k++) {
                const size = sizes[k % sizes.length];
                yield planes.map(plane => plane.slice(at, at + size));
                at += size;
            }
        },
    };
}

/** Every plane of a staged sound, joined. */
async function joined(staged) {
    const blocks = [];
    for await (const planes of staged.chunks()) blocks.push(planes);
    return Array.from({ length: staged.channels }, (_, channel) => {
        const plane = new Float32Array(blocks.reduce((sum, planes) => sum + planes[0].length, 0));
        let at = 0;
        for (const planes of blocks) {
            plane.set(planes[channel], at);
            at += planes[channel].length;
        }
        return plane;
    });
}

/** `frames` frames of constant planes. */
const constant = (values, frames = 2000) =>
    values.map(value => new Float32Array(frames).fill(value));

/** Strongest frequency from 100 to 1000 Hz, by 2 Hz, of 4096 samples at `from`. */
function peak(samples, from, sampleRate) {
    let best = 0;
    let found = 0;
    for (let frequency = 100; frequency <= 1000; frequency += 2) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < 4096; i++) {
            const value = samples[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096));
            re += value * Math.cos((2 * Math.PI * frequency * i) / sampleRate);
            im -= value * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
        }
        if (re * re + im * im > best) [best, found] = [re * re + im * im, frequency];
    }
    return found;
}

describe('stages', () => {
    describe('remix', () => {
        const H = Math.SQRT1_2;

        test('5.1 folds to stereo with BS.775 weights, dropping LFE', async () => {
            const [FL, FR, FC, LFE, BL, BR] = [0.1, 0.2, 0.3, 0.9, 0.05, 0.06];
            const planes = constant([FL, FR, FC, LFE, BL, BR]);
            for (const mask of [0x3f, 0x60f, undefined]) {
                const stage = remixStage({ sampleRate: 48000, channels: 2 });
                const [left, right] = await joined(
                    stageAudio(source(planes, 48000, 1000, mask), [stage]),
                );
                const gain = 1 + 2 * H;
                assert(Math.abs(left[100] - (FL + H * FC + H * BL) / gain) < 1e-6, `${mask}`);
                assert(Math.abs(right[100] - (FR + H * FC + H * BR) / gain) < 1e-6, `${mask}`);
            }
        });

        test("remix() folds by the source's speakers, not the usual layout's", async () => {
            // 5.1 without LFE: FL FR FC BL BR BC. The fourth channel is a back left speaker, which
            // the usual 5.1 layout would take for LFE and drop.
            const mask = 0x1 | 0x2 | 0x4 | 0x10 | 0x20 | 0x100;
            const planes = constant([0, 0, 0, 0.4, 0, 0]);
            const stereo = async channelMask => {
                const sound = source(planes, 48000, 1000, channelMask);
                return joined(stageAudio(sound, [remix({ channels: 2 })]));
            };
            const [left, right] = await stereo(mask);
            assert(left[100] > 0.05, `the back left speaker reaches the left: ${left[100]}`);
            assert.equal(right[100], 0);
            const usual = await stereo(undefined);
            assert.deepEqual([usual[0][100], usual[1][100]], [0, 0], 'LFE is dropped');
        });

        test('the speaker mask passes stages that keep the channels, not others', async () => {
            const mask = 0x1 | 0x2 | 0x4 | 0x10 | 0x20 | 0x100;
            const sound = () => source(constant([0, 0, 0, 0, 0, 0]), 48000, 1000, mask);
            const seen = [];
            const probe = {
                type: 'audio',
                name: 'probe',
                configure: input => (seen.push(input.channelMask), input),
                process: (planes, emit) => emit(planes),
            };
            const resampled = stageAudio(sound(), [remix({ sampleRate: 44100 }), probe]);
            assert.deepEqual([resampled.channelMask, seen], [mask, [mask]]);
            const stereo = stageAudio(sound(), [remix({ channels: 2 })]);
            assert.equal(stereo.channelMask, undefined);
            const wrong = stageAudio(source(constant([0, 0]), 48000, 1000, 0x7), []);
            assert.equal(
                stageAudio(wrong, [probe]).channelMask,
                undefined,
                'three bits, two channels',
            );
        });

        test('stereo folds to mono as the mean of its sides', async () => {
            const staged = stageAudio(source(constant([0.2, 0.6]), 48000), [
                remix({ channels: 1 }),
            ]);
            const [mono] = await joined(staged);
            assert(Math.abs(mono[10] - 0.4) < 1e-7);
        });

        test('mono spreads to both sides of stereo', async () => {
            const staged = stageAudio(source(constant([0.25]), 48000), [remix({ channels: 2 })]);
            const [left, right] = await joined(staged);
            assert.deepEqual([left[5], right[5]], [0.25, 0.25]);
        });

        test('a new rate ends at the frame count nearest the input length', async () => {
            const tone = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10));
            const staged = stageAudio(source([tone], 48000, [100, 7, 333]), [
                remix({ sampleRate: 44100 }),
            ]);
            assert.equal(staged.sampleRate, 44100);
            const [plane] = await joined(staged);
            assert.equal(plane.length, Math.round((1000 * 44100) / 48000));
        });

        test('speed plays the sound faster, its pitch moving with it', async () => {
            const tone = Float32Array.from({ length: 48000 }, (_, i) =>
                Math.sin((2 * Math.PI * 440 * i) / 48000),
            );
            const staged = stageAudio(source([tone], 48000), [remix({ speed: 2 })]);
            const [plane] = await joined(staged);
            assert.equal(plane.length, 24000);
            const pitch = peak(plane, 8000, 48000);
            assert(Math.abs(pitch - 880) <= 2, `an octave up (${pitch})`);
        });

        test('a speed that is not positive fails with INPUT', () => {
            assert.throws(() => remix({ speed: 0 }), { code: 'INPUT' });
        });
    });

    describe('time stretch', () => {
        const sampleRate = 48000;
        const length = 48000;
        const spacing = 12000;
        // One second of a 440 Hz tone with a click every quarter second.
        const clicked = Float32Array.from({ length }, (_, i) => {
            const click = i % spacing < 24 ? 0.8 * (1 - (i % spacing) / 24) : 0;
            return 0.3 * Math.sin((2 * Math.PI * 440 * i) / sampleRate) + click;
        });

        for (const factor of [0.5, 2])
            test(`at ${factor} the pitch stays and the attacks stay sharp`, async () => {
                const staged = stageAudio(source([clicked], sampleRate), [timeStretch(factor)]);
                const [samples] = await joined(staged);
                assert.equal(samples.length, Math.round(length / factor), 'the stretched length');
                // Between the first two clicks.
                const pitch = peak(samples, Math.round(spacing / factor) + 1000, sampleRate);
                assert(Math.abs(pitch - 440) <= 2, `the pitch stays at 440 Hz (${pitch})`);
                // Each click lands on its mapped time at full height, as in the source.
                for (let click = 1; click < length / spacing; click++) {
                    const centre = Math.round((click * spacing) / factor);
                    let height = 0;
                    for (let i = centre - 192; i < centre + 192; i++)
                        height = Math.max(height, Math.abs(samples[i]));
                    assert(height > 0.75, `click ${click} keeps its attack (${height.toFixed(2)})`);
                }
            });

        test('the length is exact whatever the block sizes', async () => {
            const tone = clicked.subarray(0, 20011);
            for (const speed of [0.7, 1.5, 3]) {
                const staged = stageAudio(source([tone, tone], sampleRate, [1, 4097, 33, 900]), [
                    timeStretch(speed),
                ]);
                const [left, right] = await joined(staged);
                assert.equal(left.length, Math.round(20011 / speed), `${speed}`);
                assert.deepEqual(left, right, 'channels of the same sound stay the same');
            }
        });

        test('silence stays silent and an empty stream stays empty', async () => {
            const [quiet] = await joined(
                stageAudio(source(constant([0], 5000), sampleRate), [timeStretch(0.8)]),
            );
            assert.equal(quiet.length, 6250);
            assert(quiet.every(value => value === 0));
            const [nothing] = await joined(
                stageAudio(source([new Float32Array(0)], sampleRate), [timeStretch(2)]),
            );
            assert.equal(nothing.length, 0);
        });

        test('speeds outside 0.05 to 20 fail with INPUT', () => {
            for (const speed of [0, 0.04, 21, Number.NaN]) {
                assert.throws(() => timeStretch(speed), { code: 'INPUT' });
                assert.throws(() => timeStretchStage(speed), { code: 'INPUT' });
            }
        });
    });
});
