import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { patternRgba, transformedPattern } from '../helpers/pattern.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const stage = path => import(distUrl(`esm/stages/${path}.js`));
const geometry = await stage('frame-geometry');
const { snapshotVideoGeometry } = await stage('geometry-options');
const { backgroundRgba, transformRgbaRegion } = await stage('rgba-transform');
const { OptionNormalizer } = await import(distUrl('esm/core/errors/option-policy.js'));

/** Resolves `settings` for a stored picture, returning the geometry and the repairs noted. */
function resolve(source, settings = {}, evenOutput = false, policy = 'lenient') {
    const normalizer = new OptionNormalizer(policy);
    const resolved = geometry.resolveVideoGeometry(source, settings, normalizer, evenOutput);
    return { ...resolved, notes: normalizer.findings.map(finding => finding.option) };
}

/** A small block pattern: 24 × 16 stored pixels in 4 × 4 blocks. */
const SMALL = { width: 24, height: 16, block: 4 };

/** The stored region of the pattern, as transformRgbaRegion takes it. */
function regionOf(resolved) {
    const stored = patternRgba(SMALL.width, SMALL.height, SMALL.block);
    const { x, y, width, height } = resolved.region;
    const region = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const from = ((y + row) * SMALL.width + x) * 4;
        region.set(stored.subarray(from, from + width * 4), row * width * 4);
    }
    return region;
}

/** The pattern after `settings`, as the library transforms it and as the oracle draws it. */
function transformed(settings, upright = 0) {
    const resolved = resolve(
        { width: SMALL.width, height: SMALL.height, rotation: upright },
        settings,
    );
    const actual = transformRgbaRegion(regionOf(resolved), resolved);
    const expected = transformedPattern({
        sourceWidth: SMALL.width,
        sourceHeight: SMALL.height,
        block: SMALL.block,
        upright,
        ...settings,
        width: resolved.width,
        height: resolved.height,
        fit: settings.width !== undefined && settings.height !== undefined ? settings.fit : 'fill',
    });
    return { resolved, actual, expected };
}

describe('stages', () => {
    describe('rotations', () => {
        test('any multiple of 90 degrees reads as a clockwise turn', () => {
            assert.deepEqual(
                [0, 90, -90, 450, 720, 89].map(geometry.clockwise),
                [0, 90, 270, 90, 0, 90],
            );
        });

        test('the upright rotation undoes a counter-clockwise display rotation', () => {
            assert.deepEqual(
                [undefined, 90, 180, 270].map(geometry.uprightRotation),
                [0, 270, 180, 90],
            );
        });

        test('pixel aspect is width over height, undefined when square or unknown', () => {
            const aspect = (num, den) =>
                geometry.pixelAspectOf({ pixelAspectRatioNum: num, pixelAspectRatioDen: den });
            assert.deepEqual(
                [aspect(4, 3), aspect(1, 1), aspect(4, 0), aspect(undefined, 3)],
                [4 / 3, undefined, undefined, undefined],
            );
        });
    });

    describe('geometry', () => {
        test('no settings keep the stored picture as it is', () => {
            const resolved = resolve({ width: 24, height: 16 });
            assert.equal(geometry.isIdentityGeometry(resolved), true);
            assert.equal(geometry.isCropOnlyGeometry(resolved), true);
            assert.deepEqual([resolved.width, resolved.height, resolved.notes], [24, 16, []]);
        });

        test('a crop alone is a region at its own size', () => {
            const resolved = resolve(
                { width: 24, height: 16 },
                { crop: { x: 2, y: 4, width: 8, height: 8 } },
            );
            assert.deepEqual(resolved.region, { x: 2, y: 4, width: 8, height: 8 });
            assert.equal(geometry.isIdentityGeometry(resolved), false);
            assert.equal(geometry.isCropOnlyGeometry(resolved), true);
            const resized = resolve(
                { width: 24, height: 16 },
                { crop: { x: 2, y: 4, width: 8, height: 8 }, width: 16 },
            );
            assert.equal(geometry.isCropOnlyGeometry(resized), false);
        });

        test('the crop is in upright pixels of a rotated source', () => {
            const resolved = resolve(
                { width: 32, height: 16, rotation: 90 },
                { crop: { x: 0, y: 0, width: 16, height: 8 } },
            );
            assert.deepEqual([resolved.width, resolved.height, resolved.rotation], [16, 8, 90]);
            assert.deepEqual(resolved.region, { x: 0, y: 0, width: 8, height: 16 });
        });

        test('a crop outside the picture is clamped and reported', () => {
            const resolved = resolve(
                { width: 24, height: 16 },
                { crop: { x: 20, y: -3, width: 10, height: 8 } },
            );
            assert.deepEqual(resolved.region, { x: 20, y: 0, width: 4, height: 8 });
            assert.deepEqual(resolved.notes, ['crop']);
        });

        test('even output trims an odd crop and rounds an odd size, noting both', () => {
            const trimmed = resolve(
                { width: 24, height: 16 },
                { crop: { x: 1, y: 1, width: 9, height: 7 } },
                true,
            );
            assert.deepEqual([trimmed.width, trimmed.height, trimmed.notes], [8, 6, ['crop']]);
            const rounded = resolve({ width: 16, height: 16 }, { width: 31 }, true);
            assert.deepEqual([rounded.width, rounded.height, rounded.notes], [32, 32, ['width']]);
            const odd = resolve({ width: 16, height: 16 }, { width: 31 }, false);
            assert.deepEqual([odd.width, odd.height, odd.notes], [31, 31, []]);
        });

        test('one side alone keeps the aspect ratio', () => {
            const resolved = resolve({ width: 24, height: 16 }, { height: 8 });
            assert.deepEqual([resolved.width, resolved.height], [12, 8]);
        });

        test('contain centres the picture inside the size; cover keeps its middle', () => {
            const contained = resolve(
                { width: 16, height: 8 },
                { width: 8, height: 8, fit: 'contain' },
            );
            assert.deepEqual(contained.target, { x: 0, y: 2, width: 8, height: 4 });
            const covered = resolve(
                { width: 16, height: 8 },
                { width: 8, height: 8, fit: 'cover' },
            );
            assert.deepEqual(covered.region, { x: 4, y: 0, width: 8, height: 8 });
            assert.deepEqual(covered.target, { x: 0, y: 0, width: 8, height: 8 });
        });

        test('a fit needs both sides; with one it stretches nothing', () => {
            const resolved = resolve({ width: 16, height: 8 }, { width: 8, fit: 'contain' });
            assert.deepEqual([resolved.width, resolved.height], [8, 4]);
            assert.deepEqual(resolved.target, { x: 0, y: 0, width: 8, height: 4 });
        });

        test('non-square pixels are shown at their display shape', () => {
            const resolved = resolve({ width: 16, height: 8, pixelAspect: 2 }, {}, true);
            assert.deepEqual([resolved.width, resolved.height], [32, 8]);
            assert.deepEqual(resolved.region, { x: 0, y: 0, width: 16, height: 8 });
        });

        test('pictures that cannot be made fail with FORMAT', () => {
            assert.throws(() => resolve({ width: 0, height: 8 }), { code: 'FORMAT' });
            assert.throws(() => resolve({ width: 16, height: 8 }, { width: 20000 }), {
                code: 'FORMAT',
                message: /too large/,
            });
            assert.throws(
                () =>
                    resolve(
                        { width: 16, height: 8 },
                        { crop: { x: 0, y: 0, width: 1, height: 4 } },
                        true,
                    ),
                { code: 'FORMAT', message: /2 × 2/ },
            );
        });

        test('an output of more than 8192×4320 pixels fails with OOM, as every size limit', () => {
            assert.throws(() => resolve({ width: 16, height: 8 }, { width: 16000 }), {
                code: 'OOM',
                message: /16000×8000/,
            });
            const largest = resolve({ width: 16, height: 8 }, { width: 8192 });
            assert.deepEqual([largest.width, largest.height], [8192, 4096]);
        });

        test('the strict policy refuses a repair with INPUT', () => {
            assert.throws(
                () =>
                    resolve(
                        { width: 24, height: 16 },
                        { crop: { x: 20, y: 0, width: 10, height: 8 } },
                        false,
                        'strict',
                    ),
                { code: 'INPUT', message: /crop was clamped/ },
            );
        });
    });

    describe('transform pixels', () => {
        const cases = [
            [{}, 0],
            [{ crop: { x: 4, y: 4, width: 12, height: 8 } }, 0],
            [{ rotate: 90 }, 0],
            [{ rotate: 180 }, 0],
            [{ rotate: 270, flip: 'horizontal' }, 0],
            [{ flip: 'vertical' }, 0],
            [{ flip: 'both', rotate: 90 }, 0],
            [{ crop: { x: 4, y: 0, width: 8, height: 12 }, rotate: 90, flip: 'vertical' }, 0],
            [{}, 90],
            [{ crop: { x: 0, y: 4, width: 16, height: 8 } }, 270],
            [{ rotate: 90 }, 180],
        ];
        for (const [settings, upright] of cases)
            test(`turns and crops exactly: ${JSON.stringify(settings)} upright ${upright}`, () => {
                const { actual, expected } = transformed(settings, upright);
                assert.deepEqual([...actual], [...expected.rgba]);
            });

        test('a resize stays close to the oracle inside the blocks', () => {
            const { actual, expected } = transformed({ width: 48, height: 32 });
            let worst = 0;
            expected.mask.forEach((inside, at) => {
                if (inside)
                    for (let channel = 0; channel < 3; channel++)
                        worst = Math.max(
                            worst,
                            Math.abs(actual[at * 4 + channel] - expected.rgba[at * 4 + channel]),
                        );
            });
            assert(worst <= 2, `differs by ${worst}`);
        });

        test('contain pads with the background colour', () => {
            const resolved = resolve(
                { width: 24, height: 16 },
                { width: 24, height: 24, fit: 'contain' },
            );
            const white = transformRgbaRegion(regionOf(resolved), resolved, backgroundRgba('#fff'));
            assert.deepEqual([...white.subarray(0, 4)], [255, 255, 255, 255]);
            const black = transformRgbaRegion(regionOf(resolved), resolved);
            assert.deepEqual([...black.subarray(0, 4)], [0, 0, 0, 255]);
        });

        test('an unchanged region comes back as it is', () => {
            const resolved = resolve({ width: 24, height: 16 });
            const region = regionOf(resolved);
            assert.equal(transformRgbaRegion(region, resolved), region);
        });

        test('pixels at any byte offset turn', () => {
            const resolved = resolve({ width: 24, height: 16 }, { rotate: 90 });
            const backing = new Uint8ClampedArray(24 * 16 * 4 + 1);
            const region = backing.subarray(1);
            region.set(regionOf(resolved));
            const { expected } = transformed({ rotate: 90 });
            assert.deepEqual([...transformRgbaRegion(region, resolved)], [...expected.rgba]);
        });

        test('a region of the wrong length fails with FORMAT', () => {
            const resolved = resolve({ width: 24, height: 16 });
            assert.throws(() => transformRgbaRegion(new Uint8ClampedArray(4), resolved), {
                code: 'FORMAT',
            });
        });
    });

    describe('background colours', () => {
        test('hex colours are read without a canvas, translucent ones over black', () => {
            assert.equal(typeof OffscreenCanvas, 'undefined');
            assert.deepEqual(
                ['#fff', '#102030', '#ff000080', '#0f08', undefined].map(colour => [
                    ...backgroundRgba(colour),
                ]),
                [
                    [255, 255, 255, 255],
                    [16, 32, 48, 255],
                    [128, 0, 0, 255],
                    [0, 136, 0, 255],
                    [0, 0, 0, 255],
                ],
            );
        });

        test('a colour without a canvas to read it is black', () => {
            assert.deepEqual([...backgroundRgba('rebeccapurple')], [0, 0, 0, 255]);
            assert.deepEqual([...backgroundRgba('#12')], [0, 0, 0, 255]);
        });
    });

    describe('geometry options', () => {
        const snapshot = (raw, sized = true) => {
            const normalizer = new OptionNormalizer();
            const result = snapshotVideoGeometry(normalizer, raw, sized);
            return { result, notes: normalizer.findings.map(finding => finding.code) };
        };

        test('aliases name the fits and flips', () => {
            assert.deepEqual(snapshot({ fit: 'letterbox', flip: 'mirror' }).result, {
                crop: undefined,
                rotate: undefined,
                flip: 'horizontal',
                fit: 'contain',
            });
            assert.equal(snapshot({ fit: 'outside', flip: 'xy' }).result.flip, 'both');
            assert.equal(snapshot({ fit: 'outside' }).result.fit, 'cover');
        });

        test('a rotation off the quarter turns is snapped and noted', () => {
            assert.deepEqual(snapshot({ rotate: 100 }), {
                result: { crop: undefined, rotate: 90, flip: undefined, fit: undefined },
                notes: ['OPTION_NORMALIZED'],
            });
            assert.equal(snapshot({ rotate: -90 }).result.rotate, 270);
        });

        test('crops take left and top for x and y; without a size they are dropped', () => {
            assert.deepEqual(
                snapshot({ crop: { left: 2, top: 4, width: 8, height: 6 } }).result.crop,
                {
                    x: 2,
                    y: 4,
                    width: 8,
                    height: 6,
                },
            );
            const dropped = snapshot({ crop: { x: 2, y: 4 } });
            assert.equal(dropped.result.crop, undefined);
            assert(dropped.notes.includes('OPTION_IGNORED'));
            assert.equal(snapshot({ crop: 'center' }).result.crop, undefined);
        });

        test('a fit without both sides is dropped and noted', () => {
            const { result, notes } = snapshot({ fit: 'cover' }, false);
            assert.equal(result.fit, undefined);
            assert.deepEqual(notes, ['OPTION_IGNORED']);
        });
    });
});
