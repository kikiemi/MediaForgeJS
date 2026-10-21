import { MediaForgeError } from '../core/errors/errors';
import { RgbaResizer } from '../codecs/image/rgba-resize';
import type { VideoGeometry } from './frame-geometry';

const resizers = new WeakMap<VideoGeometry, RgbaResizer>();

function resizerFor(geometry: VideoGeometry, width: number, height: number): RgbaResizer {
    let resizer = resizers.get(geometry);
    if (!resizer) {
        resizer = new RgbaResizer(
            width,
            height,
            geometry.target.width,
            geometry.target.height,
            'bilinear',
        );
        resizers.set(geometry, resizer);
    }
    return resizer;
}

const BLACK = Uint8Array.of(0, 0, 0, 255);

/**
 * The opaque RGBA of a CSS colour as an opaque canvas paints it. Without OffscreenCanvas only hex
 * colours are read; anything else is black, as a canvas paints a colour it cannot read.
 */
export function backgroundRgba(colour = '#000'): Uint8Array {
    if (typeof OffscreenCanvas === 'function') {
        const context = new OffscreenCanvas(1, 1).getContext('2d', { alpha: false });
        if (context) {
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return Uint8Array.from(context.getImageData(0, 0, 1, 1).data);
        }
    }
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(colour.trim())?.[1];
    if (!hex) return BLACK;
    const digits = hex.length <= 4 ? [...hex].map(digit => digit + digit) : hex.match(/../g)!;
    const [red, green, blue, alpha = 255] = digits.map(pair => parseInt(pair, 16));
    // An opaque canvas blends a translucent colour over black.
    return Uint8Array.of(
        ...[red!, green!, blue!].map(value => Math.round((value * alpha) / 255)),
        255,
    );
}

/**
 * Applies the rotation, flips, resize and padding of `geometry` to the RGBA of its region, which
 * the caller has already cropped from the stored picture (region width × height × 4 bytes); the
 * padding of a contained picture is `background` (RGBA bytes). Returns the output picture; the
 * input is not modified and may be returned when nothing changes.
 */
export function transformRgbaRegion(
    region: Uint8ClampedArray,
    geometry: VideoGeometry,
    background: Uint8Array = BLACK,
): Uint8ClampedArray {
    const { region: rect, target, rotation, flipX, flipY } = geometry;
    if (region.length !== rect.width * rect.height * 4)
        throw new MediaForgeError('RGBA region length does not match its geometry', 'FORMAT');

    const turned = rotation === 90 || rotation === 270;
    const orientedWidth = turned ? rect.height : rect.width;
    const orientedHeight = turned ? rect.width : rect.height;

    let oriented = region;
    if (rotation !== 0 || flipX || flipY) {
        oriented = new Uint8ClampedArray(region.length);
        // Pixels move as 32-bit words, which need an aligned view.
        const words = region.byteOffset % 4 === 0 ? region : region.slice();
        const source = new Uint32Array(words.buffer, words.byteOffset, words.length >> 2);
        const output = new Uint32Array(oriented.buffer, oriented.byteOffset, oriented.length >> 2);
        const sourceWidth = rect.width;
        const lastX = rect.width - 1;
        const lastY = rect.height - 1;
        let at = 0;

        for (let y = 0; y < orientedHeight; y++) {
            const fy = flipY ? orientedHeight - 1 - y : y;
            const last = at + orientedWidth;
            if (rotation === 90) {
                let from = (lastY - (flipX ? orientedWidth - 1 : 0)) * sourceWidth + fy;
                const step = flipX ? sourceWidth : -sourceWidth;
                for (; at < last; at++, from += step) output[at] = source[from]!;
            } else if (rotation === 180) {
                let from = (lastY - fy) * sourceWidth + lastX - (flipX ? orientedWidth - 1 : 0);
                const step = flipX ? 1 : -1;
                for (; at < last; at++, from += step) output[at] = source[from]!;
            } else if (rotation === 270) {
                let from = (flipX ? orientedWidth - 1 : 0) * sourceWidth + lastX - fy;
                const step = flipX ? -sourceWidth : sourceWidth;
                for (; at < last; at++, from += step) output[at] = source[from]!;
            } else {
                let from = fy * sourceWidth + (flipX ? orientedWidth - 1 : 0);
                const step = flipX ? -1 : 1;
                for (; at < last; at++, from += step) output[at] = source[from]!;
            }
        }
    }

    const scaled =
        orientedWidth === target.width && orientedHeight === target.height
            ? oriented
            : resizerFor(geometry, orientedWidth, orientedHeight).resize(oriented);
    if (target.width === geometry.width && target.height === geometry.height) return scaled;

    const padded = new Uint8ClampedArray(geometry.width * geometry.height * 4);
    new Uint32Array(padded.buffer).fill(new Uint32Array(Uint8Array.from(background).buffer)[0]!);
    for (let y = 0; y < target.height; y++) {
        const from = y * target.width * 4;
        padded.set(
            scaled.subarray(from, from + target.width * 4),
            ((target.y + y) * geometry.width + target.x) * 4,
        );
    }
    return padded;
}
