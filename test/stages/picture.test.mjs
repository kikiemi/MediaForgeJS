import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPicture } from 'mediaforgejs/parts';
import { createPicture as pluginPicture } from 'mediaforgejs/plugins';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { Picture, isHdrFrame, pictureOf, sdrReport } = await import(
    distUrl('esm/stages/picture.js')
);

const RGBA = { data: new Uint8Array(8), width: 2, height: 1, timestamp: 1, duration: 0.5 };

/** Built-in decoder planes: 2 × 2 I420 without colour information. */
const planar = () => ({
    format: 'I420',
    data: Uint8Array.of(16, 16, 16, 16, 128, 128),
    layout: [
        { offset: 0, stride: 2 },
        { offset: 4, stride: 1 },
        { offset: 5, stride: 1 },
    ],
    codedWidth: 2,
    codedHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    displayWidth: 2,
    displayHeight: 2,
    timestamp: 0,
    duration: 0.04,
    keyFrame: true,
});

const withFrames = async body => {
    const runtime = installVideoCodecs();
    try {
        await body();
        runtime.assertClosed();
    } finally {
        runtime.restore();
    }
};

describe('stages', () => {
    describe('pictures', () => {
        test('createPicture is the same function in parts and plugins', () => {
            assert.equal(createPicture, pluginPicture);
        });

        test('a created picture shows its RGBA at its time', async () => {
            const picture = createPicture(RGBA);
            assert.deepEqual(
                [picture.width, picture.height, picture.timestamp, picture.duration],
                [2, 1, 1, 0.5],
            );
            assert.equal(picture.keyframe, false);
            assert.equal(await picture.rgba(), RGBA.data, 'the pixels are not copied');
            const clamped = createPicture({ ...RGBA, data: new Uint8ClampedArray(8) });
            assert((await clamped.rgba()) instanceof Uint8Array);
        });

        test('createPicture refuses what is not a picture with INPUT', () => {
            for (const init of [
                undefined,
                { ...RGBA, width: 0 },
                { ...RGBA, height: 1.5 },
                { ...RGBA, data: new Uint8Array(4) },
                { ...RGBA, data: [0, 0, 0, 0, 0, 0, 0, 0] },
                { ...RGBA, timestamp: Number.NaN },
                { ...RGBA, duration: -1 },
                { ...RGBA, keyframe: 'yes' },
            ])
                assert.throws(() => createPicture(init), { code: 'INPUT' });
        });

        test('a retimed picture shows the same pixels and is owned apart', async () => {
            const picture = createPicture({ ...RGBA, keyframe: true });
            const later = picture.retime(3, 0.25);
            picture.close();
            assert.deepEqual([later.timestamp, later.duration, later.keyframe], [3, 0.25, false]);
            assert.equal(await later.rgba(), RGBA.data);
            assert.equal(picture.shownAt(4, 1, true).keyframe, true);
        });

        test('a closed picture refuses its pixels; closing twice is harmless', async () => {
            const picture = createPicture(RGBA);
            picture.close();
            picture.close();
            await assert.rejects(picture.rgba(), {
                code: 'INPUT',
                message: 'The picture is closed',
            });
        });

        test('stages must emit pictures of the library, said with a hint', () => {
            const picture = createPicture(RGBA);
            assert.equal(pictureOf(picture), picture);
            assert.throws(
                () => pictureOf({ ...RGBA }),
                error => {
                    assert.equal(error.code, 'INPUT');
                    assert.match(error.hint, /createPicture/);
                    return true;
                },
            );
        });

        test('built-in decoder planes show their visible rectangle as RGBA', async () => {
            const picture = new Picture({ kind: 'planar', planar: planar() }, 0, 0.04);
            assert.deepEqual([picture.width, picture.height, picture.frame], [2, 2, undefined]);
            const rgba = await picture.rgba();
            assert.equal(rgba.length, 16);
            assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 255], 'limited-range black');
        });
    });

    describe('host frames', () => {
        test('decoded host frames move into a picture; a view clones them', () =>
            withFrames(async () => {
                const frame = new VideoFrame(new Uint8Array(8), {
                    format: 'RGBA',
                    codedWidth: 2,
                    codedHeight: 1,
                    timestamp: 0,
                });
                const moved = Picture.decoded(frame, 0, 0.04);
                assert.equal(moved.frame, frame);
                const view = Picture.view({ kind: 'frame', frame }, 0, 0.04);
                assert.notEqual(view.frame, frame);
                moved.close();
                assert.equal(view.frame.closed, false, 'the view outlives the decoded frame');
                view.close();
                assert.equal(Picture.decoded(planar(), 0, 0.04).data.kind, 'planar');
                const pixels = { kind: 'rgba', data: new Uint8Array(8), width: 2, height: 1 };
                assert.equal(Picture.view(pixels, 0, 0.04).data, pixels, 'pixels are shared');
            }));

        test('RGBA pictures become sRGB host frames at their time in microseconds', () =>
            withFrames(async () => {
                const frame = createPicture(RGBA).toVideoFrame();
                assert.deepEqual(
                    [frame.format, frame.timestamp, frame.duration, frame.colorSpace.transfer],
                    ['RGBA', 1000000, 500000, 'iec61966-2-1'],
                );
                frame.close();
            }));

        test('planes without colour become frames in the colour assumed for their size', () =>
            withFrames(async () => {
                const picture = new Picture({ kind: 'planar', planar: planar() }, 0, 0.04);
                const frame = picture.toVideoFrame();
                assert.equal(frame.format, 'I420');
                assert.equal(frame.colorSpace.matrix, 'smpte170m');
                assert.equal(frame.colorSpace.fullRange, false);
                frame.close();
                // A wide picture of 534 lines is HD, as the decoders assume.
                const wide = {
                    ...planar(),
                    visibleRect: { x: 0, y: 0, width: 1280, height: 534 },
                    displayWidth: 1280,
                    displayHeight: 534,
                };
                const hd = new Picture({ kind: 'planar', planar: wide }, 0, 0.04).toVideoFrame();
                assert.equal(hd.colorSpace.matrix, 'bt709');
                hd.close();
            }));

        test('HDR transfers and BT.2020 primaries count as HDR', () => {
            const frame = colorSpace => ({ colorSpace });
            assert.deepEqual(
                [
                    { transfer: 'pq' },
                    { transfer: 'hlg' },
                    { primaries: 'bt2020', transfer: 'bt709' },
                    { primaries: 'bt709', transfer: 'bt709' },
                    undefined,
                ].map(space => isHdrFrame(frame(space))),
                [true, true, true, false, false],
            );
        });

        test('turning HDR into SDR is reported once, or refused when strict', () => {
            const warnings = [];
            const recovery = {
                strict: false,
                warn: (code, message) => warnings.push([code, message]),
            };
            const report = sdrReport(recovery);
            assert.equal(sdrReport(recovery), report, 'one report per decoder');
            report();
            report();
            assert.deepEqual(warnings, [['HDR_TO_SDR', 'HDR video is converted to SDR']]);
            assert.throws(() => sdrReport({ strict: true, warn() {} })(), { code: 'FORMAT' });
        });
    });
});
