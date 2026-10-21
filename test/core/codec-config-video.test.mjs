import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    BASELINE_FIXTURE,
    CROPPED_FIXTURE,
    HIGH_FIXTURE,
    INTERLACED_FIXTURE,
    annexB,
    avcC,
    lengthPrefixed,
    pictures,
} from '../helpers/h264-fixtures.mjs';
import { INTERLACED_FIXTURE as MPEG2_FIXTURE, MPEG1_FIXTURE } from '../helpers/mpeg2-fixtures.mjs';
import { SIMPLE_FIXTURE } from '../helpers/mpeg4-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const module = path => import(distUrl(`esm/core/codec-config/video/${path}.js`));
const annexb = await module('annexb');
const sps = await module('video-sps');
const av1 = await module('av1-config');
const vp9 = await module('vp9-config');
const { isVp8Keyframe, isVp9Keyframe } = await module('vpx-frame');
const { colourSpaceOf, unlabelledColour } = await module('colour-codes');
const raw = await module('raw-video');
const mpeg = await module('mpeg-video');

const unitsOf = fixture => pictures(fixture.bytes())[0];
const spsOf = fixture => unitsOf(fixture).find(unit => (unit[0] & 31) === 7);
const BT601 = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m' };

describe('codec-config', () => {
    describe('Annex B and length-prefixed NAL units', () => {
        const units = unitsOf(BASELINE_FIXTURE);
        const stream = annexB(units);

        test('recognizes Annex B start codes of three and four bytes', () => {
            assert.equal(annexb.isAnnexB(stream), true);
            assert.equal(annexb.isAnnexB(Uint8Array.of(0, 0, 1, 0x67)), true);
            assert.equal(annexb.isAnnexB(lengthPrefixed(units)), false);
        });

        test('splits Annex B into its NAL units', () => {
            assert.deepEqual(annexb.splitAnnexBNals(stream), units);
        });

        test('converts Annex B to length-prefixed units of any length size', () => {
            assert.deepEqual(annexb.annexBToAvcc(stream), lengthPrefixed(units));
            const two = annexb.annexBToAvcc(stream, 2);
            assert.deepEqual(annexb.splitLengthPrefixedNals(two, 2), units);
        });

        test('walks length-prefixed data only when the lengths tile it', () => {
            const prefixed = lengthPrefixed(units);
            assert.equal(annexb.isValidAvccWalk(prefixed), true);
            assert.equal(annexb.isValidAvccWalk(prefixed.subarray(0, prefixed.length - 1)), false);
            assert.equal(annexb.isLengthPrefixed(prefixed, 4), true);
        });

        test('builds the avcC of the parameter sets in Annex B', () => {
            const built = annexb.buildAvcCFromAnnexB(stream);
            assert.deepEqual(built, avcC(units));
            assert.equal(
                annexb.buildAvcCFromAnnexB(annexB(units.filter(unit => (unit[0] & 31) !== 7))),
                null,
            );
        });

        test('turns an avcC back into in-band parameter sets before a sample', () => {
            const config = avcC(units);
            const slices = lengthPrefixed(units.filter(unit => (unit[0] & 31) === 5));
            const sample = annexb.prependAvcConfigToSample(config, slices);
            assert.deepEqual(
                annexb.splitLengthPrefixedNals(sample, 4).map(unit => unit[0] & 31),
                [7, 8, ...units.filter(unit => (unit[0] & 31) === 5).map(() => 5)],
            );
        });

        test('a non-reference picture is disposable, a reference one is not', () => {
            const reference = lengthPrefixed([Uint8Array.of(0x41, 0x9a)]);
            const disposable = lengthPrefixed([Uint8Array.of(0x01, 0x9e)]);
            assert.equal(annexb.isDisposableAvcPicture(reference, 4), false);
            assert.equal(annexb.isDisposableAvcPicture(disposable, 4), true);
        });
    });

    describe('H.264 sequence parameter sets', () => {
        test('reads the picture size and frames-only flag', () => {
            const parsed = sps.parseH264Sps(spsOf(BASELINE_FIXTURE));
            assert.deepEqual([parsed.width, parsed.height, parsed.framesOnly], [64, 48, true]);
            assert.equal(sps.parseH264Sps(spsOf(INTERLACED_FIXTURE)).framesOnly, false);
        });

        test('applies cropping and the sample aspect ratio', () => {
            const parsed = sps.parseH264Sps(spsOf(CROPPED_FIXTURE));
            assert.deepEqual(
                [
                    parsed.width,
                    parsed.height,
                    parsed.pixelAspectRatioNum,
                    parsed.pixelAspectRatioDen,
                ],
                [70, 46, 16, 11],
            );
            // The display aspect ratio, reduced: 70 x 16/11 : 46.
            assert.deepEqual([parsed.displayWidth, parsed.displayHeight], [560, 253]);
        });

        test('reads the VUI colour description', () => {
            assert.deepEqual(sps.parseH264Sps(spsOf(BASELINE_FIXTURE)).colour, {
                primaries: 1,
                transfer: 1,
                matrix: 1,
                fullRange: false,
            });
        });

        test('names the codec string from profile, constraints and level', () => {
            for (const fixture of [BASELINE_FIXTURE, HIGH_FIXTURE, INTERLACED_FIXTURE])
                assert.equal(
                    sps.avcCodecStringFromSps(spsOf(fixture)),
                    fixture.codec.toLowerCase(),
                );
            assert.equal(sps.avcCodecString([0x67, 0x64, 0x00, 0x28], 'avc3'), 'avc3.640028');
        });

        test('reads the SPS of an avcC', () => {
            assert.equal(sps.avcConfigSps(avcC(unitsOf(HIGH_FIXTURE))).width, 64);
        });

        test('a cut parameter set reads as nothing', () => {
            assert.equal(sps.parseH264Sps(spsOf(BASELINE_FIXTURE).subarray(0, 4)), null);
        });

        test('emulation prevention bytes are removed from the payload', () => {
            assert.deepEqual(
                [...sps.nalToRbsp(Uint8Array.of(0x67, 0, 0, 3, 1, 5), 1)],
                [0, 0, 1, 5],
            );
        });

        test('display dimensions keep whole numbers where they can', () => {
            assert.deepEqual(sps.displayDimensions(64, 48, 1, 1), { num: 64, den: 48 });
            assert.deepEqual(sps.displayDimensions(720, 480, 8, 9), { num: 640, den: 480 });
            // Neither side scales to whole pixels: the ratio, reduced.
            assert.deepEqual(sps.displayDimensions(70, 46, 16, 11), { num: 560, den: 253 });
        });
    });

    describe('AV1', () => {
        test('LEB128 sizes read what they write', () => {
            for (const value of [0, 1, 127, 128, 300, 2 ** 21, 2 ** 32 - 1]) {
                const bytes = av1.leb128Bytes(value);
                assert.deepEqual(av1.leb128(bytes, 0, bytes.length), {
                    value,
                    length: bytes.length,
                });
            }
        });

        test('splits a temporal unit into OBUs by their sizes', () => {
            const obu = (type, payload) =>
                Uint8Array.of((type << 3) | 2, payload.length, ...payload);
            const unit = new Uint8Array([...obu(2, []), ...obu(1, [1, 2, 3]), ...obu(6, [4])]);
            assert.equal(av1.isAv1LowOverhead(unit), true, 'a delimiter, then a sequence header');
            assert.deepEqual(
                av1.splitAv1Obus(unit).map(item => [item.type, item.payloadStart, item.end]),
                [
                    [2, 2, 2],
                    [1, 4, 7],
                    [6, 9, 10],
                ],
            );
            assert.equal(av1.splitAv1Obus(unit.subarray(0, 8)), undefined, 'an OBU past the end');
        });

        test('names the codec string of an av1C', () => {
            // av1C: marker and version, profile 0 level 8, tier 0, 8-bit 4:2:0.
            assert.equal(
                av1.av1CodecString(Uint8Array.of(0x81, 0x08, 0x0c, 0x00)),
                'av01.0.08M.08',
            );
            assert.equal(av1.av1CodecString(undefined), undefined);
        });
    });

    describe('VP8 and VP9', () => {
        test('reads VP9 features from a codec string and back', () => {
            assert.equal(vp9.vp9CodecFromConfig('vp09.02.51.10', undefined), 'vp09.02.51.10');
            const config = vp9.vpcCFor('vp09.00.31.08', undefined);
            assert(vp9.isVpcC(config));
            assert.deepEqual(
                [
                    vp9.parseVpcC(config).profile,
                    vp9.parseVpcC(config).level,
                    vp9.parseVpcC(config).bitDepth,
                ],
                [0, 31, 8],
            );
        });

        test('a VP9 profile 1 stream uses 4:4:4 by default', () => {
            const config = vp9.vpcCFor('vp09.01.31.08', undefined);
            assert.equal(vp9.parseVpcC(config).chromaSubsampling, 3);
        });

        test('keyframes are told by their first bytes', () => {
            assert.equal(isVp8Keyframe(Uint8Array.of(0x50, 0x42, 0, 0x9d, 0x01, 0x2a)), true);
            assert.equal(isVp8Keyframe(Uint8Array.of(0x51, 0x42, 0)), false);
            assert.equal(isVp9Keyframe(Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00)), true);
            assert.equal(isVp9Keyframe(Uint8Array.of(0x86, 0x00)), false);
        });
    });

    describe('colour code points', () => {
        test('maps H.273 code points to WebCodecs names', () => {
            assert.deepEqual(
                colourSpaceOf({ primaries: 1, transfer: 1, matrix: 1, fullRange: true }, BT601),
                {
                    primaries: 'bt709',
                    transfer: 'bt709',
                    matrix: 'bt709',
                    fullRange: true,
                },
            );
        });

        test('an unspecified code takes the fallback; an unknown one is left out', () => {
            assert.deepEqual(colourSpaceOf({ primaries: 2, transfer: 99, matrix: 0 }, BT601), {
                primaries: 'smpte170m',
                transfer: undefined,
                matrix: 'rgb',
                fullRange: false,
            });
            assert.deepEqual(colourSpaceOf(undefined, BT601), { ...BT601, fullRange: false });
        });

        test('a picture without colour is BT.709 above 1024x576, BT.601 otherwise', () => {
            assert.deepEqual(
                [
                    [1280, 534],
                    [720, 1080],
                    [1024, 576],
                    [720, 480],
                ].map(([width, height]) => unlabelledColour(width, height)),
                ['bt709', 'bt709', 'smpte170m', 'smpte170m'],
            );
        });
    });

    describe('raw video', () => {
        test('names the layout of FourCCs and bitmaps', () => {
            assert.equal(raw.rawVideoCodecForFourcc('IYUV'), 'raw.I420');
            assert.equal(raw.rawVideoCodecForFourcc('2vuy'), 'raw.UYVY');
            assert.equal(raw.rawVideoCodecForFourcc('avc1'), undefined);
            assert.equal(
                raw.rawVideoCodecForBitmap(0, 8, 2),
                'raw.PAL8.flip',
                'positive height is bottom-up',
            );
            assert.equal(raw.rawVideoCodecForBitmap(0, 24, -2), 'raw.BGR24');
            assert.equal(raw.rawVideoCodecForBitmap(1, 8, 2), undefined, 'RLE is not raw');
        });

        test('reads the layout and orientation of a raw codec string', () => {
            assert.deepEqual(raw.parseRawVideoCodec('raw.PAL8.flip'), {
                layout: 'PAL8',
                bottomUp: true,
            });
            assert.equal(raw.isPalettedRawVideo('raw.PAL4'), true);
            assert.equal(raw.isPalettedRawVideo('raw.BGRX'), false);
            assert.equal(raw.parseRawVideoCodec('raw.NOPE'), undefined);
        });
    });

    describe('MPEG-1/2 and MPEG-4 Part 2', () => {
        test('finds start codes from an offset', () => {
            const bytes = Uint8Array.of(9, 0, 0, 1, 0xb3, 0, 0, 1, 0xb8);
            assert.equal(mpeg.findStartCode(bytes, 0), 1);
            assert.equal(mpeg.findStartCode(bytes, 2), 5);
            assert.equal(mpeg.findStartCode(bytes, 6), -1);
        });

        test('reads size and aspect of an MPEG-1 sequence header', () => {
            const config = mpeg.mpegVideoConfig('mpeg12', MPEG1_FIXTURE.bytes());
            const parsed = mpeg.parseMpegVideoConfig('mpeg12', config);
            assert.deepEqual([parsed.width, parsed.height], [70, 46]);
        });

        test('reads the type of each picture', () => {
            const types = [];
            const bytes = MPEG2_FIXTURE.bytes();
            for (
                let at = mpeg.findStartCode(bytes, 0);
                at >= 0;
                at = mpeg.findStartCode(bytes, at + 4)
            )
                if (bytes[at + 3] === 0)
                    types.push(mpeg.inspectMpegPicture('mpeg12', bytes.subarray(at)).type);
            assert.deepEqual(types.slice(0, 4), [
                mpeg.PICTURE_I,
                mpeg.PICTURE_P,
                mpeg.PICTURE_B,
                mpeg.PICTURE_B,
            ]);
        });

        test('names MPEG video codec strings by object type', () => {
            assert.equal(mpeg.mpegVideoCodec(0x6a), 'mp4v.6a');
            assert.equal(mpeg.mpegVideoCodec(0x61), 'mp4v.61');
            assert.equal(
                mpeg.mpegVideoCodec(0x20, mpeg.mpegVideoConfig('mpeg4', SIMPLE_FIXTURE.bytes())),
                SIMPLE_FIXTURE.codec,
            );
            assert.equal(mpeg.mpegVideoCodec(0x40), null);
        });

        test('names VfW FourCCs of MPEG-4 Part 2 and H.264', () => {
            assert.equal(mpeg.vfwVideoCodec('XVID')?.startsWith('mp4v.20'), true);
            assert.equal(mpeg.isVfwAvcFourcc('H264'), true);
            assert.equal(mpeg.isVfwAvcFourcc('XVID'), false);
        });
    });
});
