import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { yieldEventLoop } from '../../core/io/event-loop';
import { awaitWithAbort } from '../../core/io/abort';
import { copyOutputBytes } from '../../core/bytes/output-data';
import {
    MAX_ANIMATION_PIXELS,
    assertPixels,
    type AnimatedFrame,
    type AnimatedImage,
    type DecodedImage,
} from './rgba-image';
import type { DecodeOptions } from '../../core/contracts/decoder';
import { parseWebpInfo, riffChunk, webpFile } from '../../core/codec-config/image-info';
import { decodeVp8l, decodeWebpAlpha } from './vp8l-decoder';

type Chunk = { readonly type: string; readonly start: number; readonly end: number };

/** Wraps the ALPH/VP8/VP8L chunks of one frame as a standalone still WebP file. */
function stillWebpOf(
    bytes: Uint8Array,
    chunks: readonly Chunk[],
    width: number,
    height: number,
): Uint8Array {
    const parts: Uint8Array[] = [];
    const alpha = chunks.some(chunk => chunk.type === 'ALPH');
    if (alpha) {
        const vp8x = new Uint8Array(10);
        vp8x[0] = 0x10;
        vp8x[4] = (width - 1) & 0xff;
        vp8x[5] = ((width - 1) >> 8) & 0xff;
        vp8x[6] = ((width - 1) >> 16) & 0xff;
        vp8x[7] = (height - 1) & 0xff;
        vp8x[8] = ((height - 1) >> 8) & 0xff;
        vp8x[9] = ((height - 1) >> 16) & 0xff;
        parts.push(riffChunk('VP8X', vp8x));
    }

    for (const chunk of chunks)
        parts.push(riffChunk(chunk.type, bytes.subarray(chunk.start + 8, chunk.end)));
    return webpFile(parts);
}

/**
 * Decodes the chunks of one WebP frame: VP8L built in, VP8 through the host's createImageBitmap.
 */
async function decodeWebpFrame(
    bytes: Uint8Array,
    chunks: readonly Chunk[],
    width: number,
    height: number,
    signal?: AbortSignal,
): Promise<DecodedImage> {
    throwIfAborted(signal);
    const lossless = chunks.find(chunk => chunk.type === 'VP8L');
    if (lossless) {
        const image = decodeVp8l(bytes.subarray(lossless.start + 8, lossless.end));
        return { data: image.data, width: image.width, height: image.height };
    }

    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined')
        throw new MediaForgeError('Lossy WebP needs the host createImageBitmap', 'DECODE', {
            hint: 'Run in a browser, or use lossless WebP.',
        });
    const still = stillWebpOf(bytes, chunks, width, height);
    const bitmap = await awaitWithAbort(
        createImageBitmap(new Blob([copyOutputBytes(still)], { type: 'image/webp' })),
        signal,
    );
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new MediaForgeError('No 2D context for WebP frames', 'DECODE');
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const alpha = chunks.find(chunk => chunk.type === 'ALPH');
        if (alpha && chunks.some(chunk => chunk.type === 'VP8 ')) {
            // Hosts return premultiplied colour; the ALPH plane restores the exact coverage values.
            const plane = decodeWebpAlpha(
                bytes.subarray(alpha.start + 8, alpha.end),
                bitmap.width,
                bitmap.height,
            );
            if (plane)
                for (let index = 0; index < plane.length; index++)
                    rgba[index * 4 + 3] = plane[index]!;
        }

        return { data: rgba, width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
}

/** Decodes a still WebP, or the first frame of an animated one, to RGBA. */
export async function decodeStillWebp(
    bytes: Uint8Array,
    options: DecodeOptions = {},
): Promise<DecodedImage> {
    const info = parseWebpInfo(bytes);
    const chunks = info.animated ? info.frames![0]!.chunks : info.stillChunks!;
    if (!chunks.length) throw new MediaForgeError('WebP holds no image data', 'DECODE');
    return decodeWebpFrame(bytes, chunks, info.width, info.height, options.signal);
}

/** The options of decodeAnimatedWebp(). */
export interface AnimatedWebpDecodeOptions extends DecodeOptions {
    /** The most pixels over all frames, 128 Mi by default; a larger animation fails with OOM. */
    readonly maxTotalPixels?: number;
}

/**
 * Composes an animated WebP onto its canvas frame by frame (alpha blending and
 * dispose-to-transparent as the ANMF flags state), returning full-canvas frames; a still WebP is
 * one frame.
 */
export async function decodeAnimatedWebp(
    bytes: Uint8Array,
    options: AnimatedWebpDecodeOptions = {},
): Promise<AnimatedImage> {
    const { signal, maxTotalPixels = MAX_ANIMATION_PIXELS } = options;
    const info = parseWebpInfo(bytes);
    const { width, height } = info;
    const frames = info.animated ? info.frames! : [];
    if (!info.animated) {
        const still = await decodeStillWebp(bytes, options);
        return {
            width: still.width,
            height: still.height,
            frames: [{ data: still.data, delayMs: 0 }],
            loopCount: 1,
        };
    }

    assertPixels('WebP', width, height, frames.length, maxTotalPixels);
    const canvas = new Uint8ClampedArray(width * height * 4);
    const out: AnimatedFrame[] = [];
    for (let index = 0; index < frames.length; index++) {
        throwIfAborted(signal);
        if ((index & 7) === 0) await yieldEventLoop();
        const frame = frames[index]!;
        const decoded = await decodeWebpFrame(
            bytes,
            frame.chunks,
            frame.width,
            frame.height,
            signal,
        );

        const w = Math.min(decoded.width, width - frame.x);
        const h = Math.min(decoded.height, height - frame.y);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const source = (y * decoded.width + x) * 4;
                const target = ((frame.y + y) * width + frame.x + x) * 4;
                const alpha = decoded.data[source + 3]!;
                if (!frame.blend || alpha === 255) {
                    canvas[target] = decoded.data[source]!;
                    canvas[target + 1] = decoded.data[source + 1]!;
                    canvas[target + 2] = decoded.data[source + 2]!;
                    canvas[target + 3] = alpha;
                } else if (alpha !== 0) {
                    const dstAlpha = canvas[target + 3]!;
                    const outAlpha = alpha + (dstAlpha * (255 - alpha)) / 255;
                    for (let channel = 0; channel < 3; channel++) {
                        const src = decoded.data[source + channel]!;
                        const dst = canvas[target + channel]!;
                        canvas[target + channel] = Math.round(
                            (src * alpha + (dst * dstAlpha * (255 - alpha)) / 255) / outAlpha,
                        );
                    }

                    canvas[target + 3] = Math.round(outAlpha);
                }
            }
        }

        out.push({ data: canvas.slice(), delayMs: frame.durationMs });
        if (frame.dispose)
            for (let y = 0; y < h; y++)
                canvas.fill(
                    0,
                    ((frame.y + y) * width + frame.x) * 4,
                    ((frame.y + y) * width + frame.x + w) * 4,
                );
    }

    return { width, height, frames: out, loopCount: info.loopCount ?? 0 };
}
