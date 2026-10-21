import { MediaForgeError } from '../../core/errors/errors';

/**
 * Pictures as RGBA: what the image encoders take and the image decoders return, in the shape of
 * ImageData, frames() and createPicture().
 */
export interface RgbaImage {
    /** Straight (not premultiplied) RGBA, row by row. */
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
}

/** A decoded picture: its pixels are a Uint8ClampedArray, as ImageData holds them. */
export interface DecodedImage extends RgbaImage {
    readonly data: Uint8ClampedArray;
}

/** The largest animation decoded when the caller sets no limit, in pixels over all frames. */
export const MAX_ANIMATION_PIXELS = 128 * 1024 * 1024;

/** The largest still picture the library decodes, scales or encodes: 8192×4320 pixels. */
export const MAX_IMAGE_PIXELS = 8192 * 4320;

/** One frame of a decoded animation, the size of the whole canvas. */
export interface AnimatedFrame {
    data: Uint8ClampedArray;
    delayMs: number;
}

export interface AnimatedImage {
    width: number;
    height: number;
    frames: AnimatedFrame[];
    /** Total animation plays; zero means infinite. */
    loopCount: number;
}

/**
 * Refuses `frames` pictures of `width`×`height` with more than `maxPixels` pixels in all with OOM,
 * the code of every size limit; an unusable limit is INPUT. One picture is a still one, whose
 * limit is 8192×4320 unless stated.
 */
export function assertPixels(
    what: string,
    width: number,
    height: number,
    frames = 1,
    maxPixels = MAX_IMAGE_PIXELS,
): void {
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 0)
        throw new MediaForgeError('maxTotalPixels must be a non-negative safe integer', 'INPUT');
    const pixels = frames * width * height;
    if (Number.isSafeInteger(pixels) && pixels <= maxPixels) return;
    const size = `${width}×${height}`;
    const limit = maxPixels === MAX_IMAGE_PIXELS ? '8192×4320' : maxPixels;
    throw frames > 1
        ? new MediaForgeError(`Animated ${what} is too large`, 'OOM', {
              hint: `Use at most ${Math.floor(maxPixels / (width * height))} frames at ${size}.`,
          })
        : new MediaForgeError(`${what} ${size} is too large`, 'OOM', {
              hint: `Keep it within ${limit} pixels.`,
          });
}
