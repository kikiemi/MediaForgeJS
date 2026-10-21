import { MediaForgeError } from '../../core/errors/errors';
import type { VideoFramePlane } from '../../core/contracts/picture';
import { unlabelledColour } from '../../core/codec-config/video/colour-codes';

/** Luma coefficients (Kr, Kb) of the Y'CbCr matrices this converter implements. */
type YuvMatrix = 'bt709' | 'bt601' | 'bt2020';

/** Stored planes of one picture; `layout` holds each plane's byte offset and stride into `data`. */
export interface PlanarPicture {
    readonly format: string;
    readonly data: Uint8Array;
    readonly layout: readonly VideoFramePlane[];
    readonly codedWidth: number;
    readonly codedHeight: number;
}

interface Tables {
    readonly luma: Int32Array;
    readonly redV: Int32Array;
    readonly greenU: Int32Array;
    readonly greenV: Int32Array;
    readonly blueU: Int32Array;
}

const KR_KB: Readonly<Record<YuvMatrix, readonly [number, number]>> = {
    bt709: [0.2126, 0.0722],
    bt601: [0.299, 0.114],
    bt2020: [0.2627, 0.0593],
};
const cache = new Map<string, Tables>();

/** Bit positions that put R, G, B and A in byte order inside one 32-bit word of this platform. */
const SHIFTS = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1 ? [0, 8, 16, 24] : [24, 16, 8, 0];

/** Fixed-point components are biased by 384 so every sum indexes the clamp table from zero. */
const CLAMP_BIAS = 384 << 16;
const CLAMP = Uint8Array.from({ length: 1280 }, (_, index) =>
    Math.max(0, Math.min(255, index - 384)),
);
const [RED_SHIFT, GREEN_SHIFT, BLUE_SHIFT, ALPHA_SHIFT] = SHIFTS as [
    number,
    number,
    number,
    number,
];
const OPAQUE = 255 << ALPHA_SHIFT;

/** One opaque pixel from a 16.16 luma term and chroma terms that already carry CLAMP_BIAS. */
function opaquePixel(base: number, red: number, green: number, blue: number): number {
    return (
        (CLAMP[(base + red) >> 16]! << RED_SHIFT) |
        (CLAMP[(base + green) >> 16]! << GREEN_SHIFT) |
        (CLAMP[(base + blue) >> 16]! << BLUE_SHIFT) |
        OPAQUE
    );
}

/**
 * Opaque 8-bit pictures with horizontally halved chroma: each chroma sample is expanded once for
 * its two columns and, when chroma is also vertically halved, for the two rows that share it.
 */
function subsampledToRgba(
    data: Uint8Array,
    pixels: Uint32Array,
    region: VideoRect,
    yPlane: VideoFramePlane,
    uPlane: VideoFramePlane,
    vPlane: VideoFramePlane | undefined,
    halfHeight: boolean,
    { luma, redV, greenU, greenV, blueU }: Tables,
): void {
    const { x: left, y: top, width, height } = region;
    const nv12 = vPlane === undefined;
    const step = nv12 ? 2 : 1;
    const end = left + width;
    for (let row = 0; row < height;) {
        const y = top + row;
        const rows = halfHeight && (y & 1) === 0 && row + 1 < height ? 2 : 1;
        const yRow = yPlane.offset + y * yPlane.stride;
        const yNext = yRow + yPlane.stride;
        const chromaY = halfHeight ? y >> 1 : y;
        const uRow = uPlane.offset + chromaY * uPlane.stride;
        const vRow = nv12 ? uRow + 1 : vPlane.offset + chromaY * vPlane.stride;
        let target = row * width;
        let x = left;
        while (x < end) {
            const at = (x >> 1) * step;
            const u = data[uRow + at]!;
            const v = data[vRow + at]!;
            const red = redV[v]! + CLAMP_BIAS;
            const green = greenU[u]! + greenV[v]! + CLAMP_BIAS;
            const blue = blueU[u]! + CLAMP_BIAS;
            const pair = (x & 1) === 0 && x + 1 < end;
            pixels[target] = opaquePixel(luma[data[yRow + x]!]!, red, green, blue);
            if (pair)
                pixels[target + 1] = opaquePixel(luma[data[yRow + x + 1]!]!, red, green, blue);
            if (rows === 2) {
                pixels[target + width] = opaquePixel(luma[data[yNext + x]!]!, red, green, blue);
                if (pair)
                    pixels[target + width + 1] = opaquePixel(
                        luma[data[yNext + x + 1]!]!,
                        red,
                        green,
                        blue,
                    );
            }
            const advance = pair ? 2 : 1;
            x += advance;
            target += advance;
        }
        row += rows;
    }
}

const RGB_ORDER: Readonly<Record<string, readonly [number, number, number, boolean]>> = {
    RGBA: [0, 1, 2, true],
    RGBX: [0, 1, 2, false],
    BGRA: [2, 1, 0, true],
    BGRX: [2, 1, 0, false],
};

/** 16.16 fixed-point lookup tables with the rounding offset folded into the luma table. */
function tables(matrix: YuvMatrix, fullRange: boolean): Tables {
    const key = `${matrix}:${fullRange}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const [kr, kb] = KR_KB[matrix];
    const kg = 1 - kr - kb;
    const lumaScale = fullRange ? 1 : 255 / 219;
    const chromaScale = fullRange ? 1 : 255 / 224;
    const fixed = (value: number): number => Math.round(value * 65536);
    const result: Tables = {
        luma: new Int32Array(256),
        redV: new Int32Array(256),
        greenU: new Int32Array(256),
        greenV: new Int32Array(256),
        blueU: new Int32Array(256),
    };
    for (let value = 0; value < 256; value++) {
        const chroma = (value - 128) * chromaScale;
        result.luma[value] = fixed((value - (fullRange ? 0 : 16)) * lumaScale) + 32768;
        result.redV[value] = fixed(2 * (1 - kr) * chroma);
        result.greenU[value] = fixed(((-2 * kb * (1 - kb)) / kg) * chroma);
        result.greenV[value] = fixed(((-2 * kr * (1 - kr)) / kg) * chroma);
        result.blueU[value] = fixed(2 * (1 - kb) * chroma);
    }
    cache.set(key, result);
    return result;
}

function subsampling(
    format: string,
): { readonly x: number; readonly y: number; readonly alpha: boolean } | undefined {
    const match = /^(I420|I422|I444|NV12)(A?)(?:P(10|12))?$/.exec(format);
    if (!match) return undefined;
    return {
        x: match[1] === 'I444' ? 0 : 1,
        y: match[1] === 'I420' || match[1] === 'NV12' ? 1 : 0,
        alpha: match[2] === 'A',
    };
}

/** Matrix for a WebCodecs matrix name; an unnamed matrix is the unlabelled colour's. */
export function yuvMatrix(
    name: string | null | undefined,
    width: number,
    height: number,
): YuvMatrix {
    if (name === 'bt709') return 'bt709';
    if (name === 'smpte170m' || name === 'bt470bg') return 'bt601';
    if (name === 'bt2020-ncl') return 'bt2020';
    return unlabelledColour(width, height) === 'bt709' ? 'bt709' : 'bt601';
}

/** The colour assumed for a Y'CbCr picture that names no matrix: the unlabelled colour. */
export function assumedYuvColour(width: number, height: number): VideoColorSpaceInit {
    const name = unlabelledColour(width, height);
    return { primaries: name, transfer: name, matrix: name, fullRange: false };
}

/** Bits per sample of a planar format name; 8 unless it ends in P10 or P12. */
export function planarBitDepth(format: string): number {
    const match = /P(10|12)$/.exec(format);
    return match ? Number(match[1]) : 8;
}

/** True for formats planarToRgba converts. */
export function isConvertibleFormat(format: string | null | undefined): boolean {
    return !!format && (RGB_ORDER[format] !== undefined || subsampling(format) !== undefined);
}

/**
 * Converts `region` of a stored picture to a new straight-alpha RGBA8 array (region width × height
 * × 4 bytes) with nearest chroma samples. Samples wider than 8 bits are shifted down to 8; RGB
 * formats are reordered.
 */
export function planarToRgba(
    picture: PlanarPicture,
    region: VideoRect,
    matrix: YuvMatrix,
    fullRange: boolean,
): Uint8ClampedArray {
    const { format, data, layout } = picture;
    const { x: left, y: top, width, height } = region;
    if (
        left < 0 ||
        top < 0 ||
        width < 1 ||
        height < 1 ||
        left + width > picture.codedWidth ||
        top + height > picture.codedHeight
    )
        throw new MediaForgeError('Picture region is outside the decoded planes', 'DECODE');
    const output = new Uint8ClampedArray(width * height * 4);
    const order = RGB_ORDER[format];
    if (order) {
        const [red, green, blue, alpha] = order;
        const plane = layout[0]!;
        for (let row = 0; row < height; row++) {
            let source = plane.offset + (top + row) * plane.stride + left * 4;
            let target = row * width * 4;
            for (let column = 0; column < width; column++, source += 4, target += 4) {
                output[target] = data[source + red]!;
                output[target + 1] = data[source + green]!;
                output[target + 2] = data[source + blue]!;
                output[target + 3] = alpha ? data[source + 3]! : 255;
            }
        }
        return output;
    }
    const shape = subsampling(format);
    if (!shape)
        throw new MediaForgeError(`Pixel format ${format} cannot be converted to RGBA`, 'DECODE');
    const { luma, redV, greenU, greenV, blueU } = tables(matrix, fullRange);
    const depth = planarBitDepth(format);
    const nv12 = format.startsWith('NV12');
    const [yPlane, uPlane, vPlane] = layout;
    const aPlane = shape.alpha ? layout[nv12 ? 2 : 3] : undefined;
    if (!yPlane || !uPlane || (!nv12 && !vPlane) || (shape.alpha && !aPlane))
        throw new MediaForgeError(`Pixel format ${format} is missing planes`, 'DECODE');
    if (depth === 8 && !aPlane && shape.x === 1) {
        subsampledToRgba(
            data,
            new Uint32Array(output.buffer, 0, width * height),
            region,
            yPlane,
            uPlane,
            nv12 ? undefined : vPlane,
            shape.y === 1,
            tables(matrix, fullRange),
        );
        return output;
    }
    if (depth === 8) {
        const pixels = new Uint32Array(output.buffer, 0, width * height);
        const [redShift, greenShift, blueShift, alphaShift] = SHIFTS;
        const step = nv12 ? 2 : 1;
        for (let row = 0; row < height; row++) {
            const y = top + row;
            const yRow = yPlane.offset + y * yPlane.stride;
            const uRow = uPlane.offset + (y >> shape.y) * uPlane.stride;
            const vRow = nv12 ? uRow + 1 : vPlane!.offset + (y >> shape.y) * vPlane!.stride;
            const aRow = aPlane ? aPlane.offset + y * aPlane.stride : -1;
            let target = row * width;
            let chroma = -1;
            let red = 0;
            let green = 0;
            let blue = 0;
            for (let x = left, end = left + width; x < end; x++) {
                const at = (x >> shape.x) * step;
                if (at !== chroma) {
                    chroma = at;
                    const u = data[uRow + at]!;
                    const v = data[vRow + at]!;
                    red = redV[v]! + CLAMP_BIAS;
                    green = greenU[u]! + greenV[v]! + CLAMP_BIAS;
                    blue = blueU[u]! + CLAMP_BIAS;
                }
                const base = luma[data[yRow + x]!]!;
                pixels[target++] =
                    (CLAMP[(base + red) >> 16]! << redShift) |
                    (CLAMP[(base + green) >> 16]! << greenShift) |
                    (CLAMP[(base + blue) >> 16]! << blueShift) |
                    ((aRow < 0 ? 255 : data[aRow + x]!) << alphaShift);
            }
        }
        return output;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const shift = depth - 8;
    const sample = (offset: number): number => Math.min(255, view.getUint16(offset, true) >> shift);
    for (let row = 0; row < height; row++) {
        const y = top + row;
        const yRow = yPlane.offset + y * yPlane.stride;
        const uRow = uPlane.offset + (y >> shape.y) * uPlane.stride;
        const vRow = nv12 ? uRow + 2 : vPlane!.offset + (y >> shape.y) * vPlane!.stride;
        const aRow = aPlane ? aPlane.offset + y * aPlane.stride : 0;
        const step = nv12 ? 4 : 2;
        let target = row * width * 4;
        for (let column = 0; column < width; column++, target += 4) {
            const x = left + column;
            const chroma = (x >> shape.x) * step;
            const u = sample(uRow + chroma);
            const v = sample(vRow + chroma);
            const base = luma[sample(yRow + x * 2)]!;
            output[target] = (base + redV[v]!) >> 16;
            output[target + 1] = (base + greenU[u]! + greenV[v]!) >> 16;
            output[target + 2] = (base + blueU[u]!) >> 16;
            output[target + 3] = aPlane ? sample(aRow + x * 2) : 255;
        }
    }
    return output;
}

export interface VideoRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
