import type { MediaProgress } from '../../core/model/media';
import { awaitWithAbort } from '../../core/io/abort';
import { CONTAINER_IMAGE_FORMATS, IMAGE_FORMATS } from '../plan/format-policy';
import { assertPictureEncoder } from './picture-encoder';
import { yieldEventLoop } from '../../core/io/event-loop';
import {
    MediaForgeError,
    abortError,
    rethrowIfAbort,
    throwIfAborted,
} from '../../core/errors/errors';
import { sniffImageDimensions } from '../../formats/images/dimensions';
import { resolveTargetDimensions } from './image-geometry';
import type { ContainerFormat } from '../../core/model/media';
import type { ImageFitMode } from './image-geometry';
import type { GifDitherMode } from '../../codecs/image/encoders';
import type { ImageResizeMethod } from '../../codecs/image/rgba-resize';
import { RgbaResizer } from '../../codecs/image/rgba-resize';
import { CanvasImageRenderer } from '../../codecs/image/canvas-resize';
import { decodeAnimatedGif, decodeApng, decodePng } from '../../codecs/image/animated-reader';
import {
    MAX_ANIMATION_PIXELS,
    MAX_IMAGE_PIXELS,
    assertPixels,
    type AnimatedImage,
    type DecodedImage,
} from '../../codecs/image/rgba-image';
import { decodeAnimatedWebp, decodeStillWebp } from '../../codecs/image/webp-reader';
import { AnimatedWebpEncoder } from '../../codecs/image/webp-writer';
import { decodeImageWithHost, hostDecodesImage } from '../../codecs/image/host-image-decoder';
import { parseImageInfo } from '../../core/codec-config/image-info';
import { jpegStatesGainMap } from '../../core/codec-config/gain-map';
import { detectSourceFormat } from '../../formats/source-format';
import { BlobSource } from '../../core/io/sources/sources';
import {
    AnimatedGifEncoder,
    ApngEncoder,
    canvasImage,
    encodeBmp,
    encodeCanvas,
    encodeIco,
    encodePng,
    encodeTiff,
} from '../../codecs/image/encoders';
import { mimeTypeOf } from '../../formats/shared/mime-types';

/**
 * Resampling of a still picture when the request names none: Lanczos with three lobes, widened when
 * shrinking. Animations take 'bilinear', which is cheaper per frame and averages the same area.
 */
const STILL_RESIZE = 'lanczos3';

/** DECODE for a picture of `format` where this host lacks the `decoder` it needs. */
function needsHostDecoder(format: string, decoder: string): MediaForgeError {
    return new MediaForgeError(`${format} decoding needs the host ${decoder}`, 'DECODE', {
        hint: 'Run in a browser, or give PNG, GIF, TIFF or lossless WebP.',
    });
}

/** A still or animated image conversion: the output format, size and encoder settings. */
interface ImageConvertConfig {
    readonly outputFormat: ContainerFormat;
    /** Pixels; one side alone keeps the aspect ratio. */
    readonly width?: number;
    readonly height?: number;
    /** Frames per second of animated output; default the source timing. */
    readonly fps?: number;
    /** JPEG/WebP quality from 0 to 1 (default 0.9). */
    readonly imageQuality?: number;
    readonly imageFit?: ImageFitMode;
    readonly imageResize?: ImageResizeMethod;
    /** GIF quantization: floyd-steinberg (default) or none. */
    readonly imageDither?: GifDitherMode;
    readonly signal?: AbortSignal;
    /** Percent and message as the conversion advances. */
    readonly onProgress?: (progress: MediaProgress) => void;
    /** Receives one warning per kind of what the output leaves out or approximates. */
    readonly onWarning?: (code: string, message: string) => void;
    /** Strict validation: what the output would leave out or approximate fails with FORMAT. */
    readonly strict?: boolean;
}

/** Whether straight RGBA has a pixel that is not opaque. */
function translucent(rgba: ArrayLike<number>): boolean {
    for (let at = 3; at < rgba.length; at += 4) if (rgba[at] !== 255) return true;
    return false;
}

function addFrameDuration(total: { elapsed: number; error: number }, duration: number): number {
    const adjusted = duration - total.error;
    const next = total.elapsed + adjusted;
    total.error = next - total.elapsed - adjusted;
    total.elapsed = next;
    return next;
}

function timingTolerance(first: number, second: number): number {
    return Number.EPSILON * 4 * Math.max(1, Math.abs(first), Math.abs(second));
}

function animationFrameCount(durationMs: number, fps: number): number {
    const frames = (durationMs * fps) / 1000;
    const rounded = Math.round(frames);
    return Math.abs(frames - rounded) <= timingTolerance(frames, rounded)
        ? Math.max(1, rounded)
        : Math.ceil(frames);
}

/** Converts still and animated images: decoding, resizing and encoding in the output format. */
export class ImageConverter {
    private readonly reported = new Set<string>();

    constructor(private readonly config: ImageConvertConfig) {}

    /** Reports `code` once, or fails with FORMAT under strict validation. */
    private lose(code: string, message: string): void {
        if (this.config.strict) throw new MediaForgeError(message, 'FORMAT');
        if (this.reported.has(code)) return;
        this.reported.add(code);
        this.config.onWarning?.(code, message);
    }

    /**
     * GIF pixels of `rgba`, which keep only full transparency: partial alpha below half becomes
     * transparent and the rest opaque.
     */
    private gifPixels(rgba: Uint8ClampedArray): Uint8ClampedArray {
        let partial = false;
        for (let at = 3; at < rgba.length && !partial; at += 4)
            partial = rgba[at] !== 0 && rgba[at] !== 255;
        if (!partial) return rgba;
        this.lose('ALPHA_REDUCED', 'gif output keeps only full transparency');
        const pixels = new Uint8ClampedArray(rgba);
        for (let at = 3; at < pixels.length; at += 4) pixels[at] = pixels[at]! < 128 ? 0 : 255;
        return pixels;
    }

    /** `canvas` over white when it has transparency, which JPEG cannot keep. */
    private opaque(canvas: OffscreenCanvas): OffscreenCanvas {
        const context = canvas.getContext('2d');
        if (!context) throw new MediaForgeError('No 2D context', 'ENCODE');
        if (!translucent(context.getImageData(0, 0, canvas.width, canvas.height).data))
            return canvas;
        this.lose('ALPHA_DROPPED', 'jpeg output fills transparency with white');
        const flat = new OffscreenCanvas(canvas.width, canvas.height);
        const flatContext = flat.getContext('2d');
        if (!flatContext) throw new MediaForgeError('No 2D context', 'ENCODE');
        flatContext.fillStyle = '#fff';
        flatContext.fillRect(0, 0, flat.width, flat.height);
        flatContext.drawImage(canvas, 0, 0);
        return flat;
    }

    async convertImage(file: File | Blob): Promise<Blob> {
        const fmt = this.config.outputFormat;
        if (!IMAGE_FORMATS.has(fmt))
            throw new MediaForgeError(`Unsupported image output: ${fmt}`, 'FORMAT');
        throwIfAborted(this.config.signal);

        const inputFmt = await detectSourceFormat(new BlobSource(file), this.config.signal).catch(
            error => {
                rethrowIfAbort(error, this.config.signal);
                return null;
            },
        );
        if (fmt === 'gif' || fmt === 'apng' || fmt === 'webp') {
            if (inputFmt === 'gif' || inputFmt === 'apng')
                return this.convertAnimatedImage(file, inputFmt, fmt);
            if (inputFmt && CONTAINER_IMAGE_FORMATS.has(inputFmt)) {
                const bytes = new Uint8Array(
                    await awaitWithAbort(file.arrayBuffer(), this.config.signal),
                );
                if (parseImageInfo(bytes, inputFmt).animated)
                    return this.convertAnimatedImage(file, inputFmt, fmt, bytes);
            }
        }
        assertPictureEncoder(fmt, 'pictures');
        if (inputFmt && CONTAINER_IMAGE_FORMATS.has(inputFmt)) {
            const bytes = new Uint8Array(
                await awaitWithAbort(file.arrayBuffer(), this.config.signal),
            );
            const info = parseImageInfo(bytes, inputFmt);
            this.assertPixelBudget(info.width, info.height);
            if (info.gainMap) this.dropGainMap(fmt);
            const decoded = await this.decodeContainerImage(bytes, inputFmt);
            if (decoded) return this.finishRgba(decoded, fmt);
        }

        const head = new Uint8Array(
            await awaitWithAbort(file.slice(0, 262144).arrayBuffer(), this.config.signal),
        );
        const dims = sniffImageDimensions(head);
        if (dims) this.assertPixelBudget(dims.width, dims.height);
        if (inputFmt === 'jpeg' && jpegStatesGainMap(head)) this.dropGainMap(fmt);
        // TIFF is read whole: the built-in decoder takes a baseline picture wherever its directory
        // lies (refusing one past the pixel budget); other TIFF (JPEG or CCITT compressed, CMYK,
        // ...) goes to the host, as does a damaged one whose size the head declared.
        if (
            (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
            (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
        ) {
            const signal = this.config.signal;
            const bytes = new Uint8Array(await awaitWithAbort(file.arrayBuffer(), signal));
            const { decodeTiff } = await import('../../codecs/image/tiff-decoder');
            const picture = await decodeTiff(bytes, signal).catch(error => {
                if (!dims || typeof createImageBitmap !== 'function' || error?.code !== 'DECODE')
                    throw error;
            });
            if (picture) return this.finishRgba(picture, fmt);
        }

        // The host decodes the other stills where it has createImageBitmap, the library otherwise.
        if (typeof createImageBitmap !== 'function')
            return this.finishRgba(await this.libraryStill(file, inputFmt), fmt);
        const bitmap = await this.bitmap(file);
        try {
            const { w, h } = resolveTargetDimensions(bitmap.width, bitmap.height, this.config);
            if (fmt === 'gif' || fmt === 'apng') this.assertAnimatedImageBudget(1, w, h, fmt);
            const renderer = new CanvasImageRenderer(
                bitmap.width,
                bitmap.height,
                w,
                h,
                this.config.imageResize ?? STILL_RESIZE,
            );
            const canvas = await renderer.render(bitmap, this.config.signal);
            return await this.finishCanvas(canvas, fmt);
        } finally {
            bitmap.close();
        }
    }

    /**
     * The picture of a PNG (an APNG's default image) or of a GIF's first frame, by the library's
     * decoders; the other stills need the host.
     */
    private async libraryStill(file: Blob, format: ContainerFormat | null): Promise<DecodedImage> {
        if (format !== 'png' && format !== 'apng' && format !== 'gif')
            throw needsHostDecoder(format ?? 'This image', 'createImageBitmap');
        const signal = this.config.signal;
        const bytes = new Uint8Array(await awaitWithAbort(file.arrayBuffer(), signal));
        if (format !== 'gif') return decodePng(bytes, MAX_IMAGE_PIXELS, signal);
        const { width, height, frames } = await decodeAnimatedGif(
            bytes,
            MAX_ANIMATION_PIXELS,
            signal,
        );
        return { data: frames[0]!.data, width, height };
    }

    /** Reports that the output, which re-encodes the picture, keeps no gain map. */
    private dropGainMap(format: string): void {
        this.lose('GAIN_MAP_DROPPED', `${format} output keeps no gain map`);
    }

    private assertPixelBudget(width: number, height: number): void {
        assertPixels('Image', width, height);
    }

    /**
     * Pixels of a WebP, AVIF, HEIF or JPEG XL still: the built-in VP8L decoder, then the host
     * ImageDecoder; undefined hands the file to createImageBitmap.
     */
    private async decodeContainerImage(
        bytes: Uint8Array,
        format: ContainerFormat,
    ): Promise<DecodedImage | undefined> {
        const signal = this.config.signal;
        if (format === 'webp') {
            const info = parseImageInfo(bytes, 'webp');
            if (info.codec === 'vp8l' || typeof createImageBitmap !== 'function')
                return decodeStillWebp(bytes, { signal });
            return undefined;
        }
        const type = mimeTypeOf(format);
        const decoded = await decodeImageWithHost(bytes, type, MAX_ANIMATION_PIXELS, signal);
        if (decoded)
            return { data: decoded.frames[0]!.data, width: decoded.width, height: decoded.height };
        if (typeof createImageBitmap !== 'function')
            throw needsHostDecoder(format, 'ImageDecoder or createImageBitmap');
        return undefined;
    }

    /**
     * Draws decoded pixels into the target size, resized by the library for PNG, GIF and APNG,
     * which need no host canvas.
     */
    private async finishRgba(image: DecodedImage, format: ContainerFormat): Promise<Blob> {
        const { data: rgba, width, height } = image;
        const { w, h } = resolveTargetDimensions(width, height, this.config);
        if (format === 'gif' || format === 'apng') this.assertAnimatedImageBudget(1, w, h, format);
        if (
            typeof OffscreenCanvas === 'undefined' ||
            format === 'png' ||
            format === 'gif' ||
            format === 'apng'
        ) {
            const resized =
                w === width && h === height
                    ? rgba
                    : await new RgbaResizer(
                          width,
                          height,
                          w,
                          h,
                          this.config.imageResize ?? STILL_RESIZE,
                      ).resizeAsync(rgba, this.config.signal);
            const picture = { data: resized, width: w, height: h };
            if (format === 'png') return this.finishImage(encodePng(picture), format);
            // The library's own encoders write these on every host; the others need its canvas.
            if (['gif', 'apng', 'bmp', 'tiff', 'ico'].includes(format))
                return this.finishImage(this.encodeStill(picture, format), format);
            throw new MediaForgeError(
                `${format} output needs the host OffscreenCanvas encoder`,
                'ENCODE',
            );
        }

        const source = new OffscreenCanvas(width, height);
        const context = source.getContext('2d');
        if (!context) throw new MediaForgeError('No 2D context', 'ENCODE');
        context.putImageData(
            new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height),
            0,
            0,
        );
        const renderer = new CanvasImageRenderer(
            width,
            height,
            w,
            h,
            this.config.imageResize ?? STILL_RESIZE,
        );
        const canvas = await renderer.render(source, this.config.signal);
        return this.finishCanvas(canvas, format);
    }

    private reportProgress(percent: number, message: string): void {
        throwIfAborted(this.config.signal);
        this.config.onProgress?.({ fraction: percent / 100, message });
        throwIfAborted(this.config.signal);
    }

    private bitmap(input: ImageBitmapSource): Promise<ImageBitmap> {
        const signal = this.config.signal;
        throwIfAborted(signal);
        if (typeof createImageBitmap !== 'function')
            throw new MediaForgeError('This host has no createImageBitmap', 'DECODE');

        const pending = createImageBitmap(input).then(
            bitmap => {
                if (signal?.aborted) {
                    bitmap.close();
                    throw abortError(signal);
                }
                return bitmap;
            },
            (error: unknown) => {
                // Hosts report undecodable images as DOMExceptions (InvalidStateError,
                // EncodingError).
                if (typeof DOMException === 'function' && error instanceof DOMException)
                    throw new MediaForgeError(
                        `The host cannot decode this image: ${error.message}`,
                        'DECODE',
                    );
                throw error;
            },
        );
        return awaitWithAbort(pending, signal);
    }

    private finishCanvas(canvas: OffscreenCanvas, format: ContainerFormat): Promise<Blob> {
        return this.finishImage(this.encodeCanvas(canvas, format), format);
    }

    /** The encoded picture as the result: a Blob of the format's type. */
    private async finishImage(
        pending: Promise<Uint8Array<ArrayBuffer>>,
        format: ContainerFormat,
    ): Promise<Blob> {
        const bytes = await awaitWithAbort(pending, this.config.signal);
        this.reportProgress(100, 'Conversion complete');
        return new Blob([bytes], { type: mimeTypeOf(format) });
    }

    /** What `canvas` shows in `format`: the host encodes its own types, the library the rest. */
    private encodeCanvas(
        canvas: OffscreenCanvas,
        format: ContainerFormat,
    ): Promise<Uint8Array<ArrayBuffer>> {
        const quality = this.config.imageQuality;
        switch (format) {
            case 'png':
            case 'webp':
            case 'avif':
            case 'heif':
            case 'jxl':
                return encodeCanvas(canvas, format, quality);
            case 'jpeg':
                return encodeCanvas(this.opaque(canvas), format, quality);
            default:
                return this.encodeStill(canvasImage(canvas), format);
        }
    }

    /** A picture as BMP, TIFF, ICO, or a one-frame GIF or APNG, by the library's encoders. */
    private async encodeStill(
        picture: DecodedImage,
        format: ContainerFormat,
    ): Promise<Uint8Array<ArrayBuffer>> {
        const { width, height } = picture;
        switch (format) {
            case 'bmp':
                return encodeBmp(picture);
            case 'tiff':
                return encodeTiff(picture);
            case 'ico':
                return encodeIco(picture, { signal: this.config.signal });
            case 'gif': {
                const encoder = new AnimatedGifEncoder(width, height, {
                    dither: this.config.imageDither,
                });
                await encoder.addFrame({ data: this.gifPixels(picture.data), width, height }, 0);
                return encoder.encode();
            }
            case 'apng': {
                const encoder = new ApngEncoder(width, height);
                await encoder.addFrame(picture, 0);
                return encoder.encode();
            }
            default:
                throw new MediaForgeError(`Unsupported image output: ${format}`, 'FORMAT');
        }
    }

    /**
     * Frames of an animated GIF, APNG, WebP, AVIF or JPEG XL: built-in readers first, then the host
     * ImageDecoder.
     */
    private async decodeAnimation(
        bytes: Uint8Array,
        inputFmt: ContainerFormat,
        pixelBudget: number,
    ): Promise<AnimatedImage> {
        const signal = this.config.signal;
        if (inputFmt === 'gif') return decodeAnimatedGif(bytes, pixelBudget, signal);
        if (inputFmt === 'apng') return decodeApng(bytes, pixelBudget, signal);
        const type = mimeTypeOf(inputFmt);
        if (inputFmt === 'webp') {
            const info = parseImageInfo(bytes, 'webp');
            if (info.codec === 'vp8l' || !(await hostDecodesImage(type)))
                return decodeAnimatedWebp(bytes, { maxTotalPixels: pixelBudget, signal });
        }
        const decoded = await decodeImageWithHost(bytes, type, pixelBudget, signal);
        if (decoded) return decoded;
        throw new MediaForgeError(
            `Animated ${inputFmt} decoding needs the host ImageDecoder`,
            'DECODE',
        );
    }

    private async convertAnimatedImage(
        file: File | Blob,
        inputFmt: ContainerFormat,
        outputFmt: 'gif' | 'apng' | 'webp',
        loaded?: Uint8Array,
    ): Promise<Blob> {
        const pixelBudget = MAX_ANIMATION_PIXELS;
        this.reportProgress(5, 'Decoding animation...');
        const bytes =
            loaded ?? new Uint8Array(await awaitWithAbort(file.arrayBuffer(), this.config.signal));
        if (outputFmt === 'webp' && !(await AnimatedWebpEncoder.supported()))
            throw new MediaForgeError(
                'Animated WebP output needs the host WebP encoder',
                'ENCODE',
                {
                    hint: "Ask for 'gif' or 'apng' instead.",
                },
            );
        const animation = await this.decodeAnimation(bytes, inputFmt, pixelBudget);
        throwIfAborted(this.config.signal);

        const { w, h } = resolveTargetDimensions(animation.width, animation.height, this.config);
        let fps = this.config.fps;
        if (fps !== undefined && animation.frames.some(frame => frame.delayMs <= 0)) {
            throw new MediaForgeError(
                'fps requires animation frames with non-zero durations',
                'FORMAT',
            );
        }
        // GIF delays count hundredths of a second and plays at most 65536 times.
        if (outputFmt === 'gif' && fps !== undefined && fps > 100) {
            this.lose('OPTION_NORMALIZED', 'gif holds at most 100 fps; fps is 100');
            fps = 100;
        }
        let loops = animation.loopCount;
        if (outputFmt === 'gif' && loops > 0x10000) {
            this.lose('LOOP_COUNT_REDUCED', 'gif plays at most 65536 times');
            loops = 0x10000;
        }
        const totalTime = { elapsed: 0, error: 0 };
        for (const frame of animation.frames) addFrameDuration(totalTime, frame.delayMs);
        const duration = totalTime.elapsed;
        const totalFrames =
            fps === undefined ? animation.frames.length : animationFrameCount(duration, fps);
        this.assertAnimatedImageBudget(totalFrames, w, h, outputFmt);
        const gif =
            outputFmt === 'gif'
                ? new AnimatedGifEncoder(w, h, {
                      loopCount: loops,
                      dither: this.config.imageDither,
                  })
                : null;
        const webp =
            outputFmt === 'webp'
                ? new AnimatedWebpEncoder(w, h, {
                      loopCount: Math.min(animation.loopCount, 0xffff),
                      quality: this.config.imageQuality,
                  })
                : null;
        const apng =
            outputFmt === 'apng' ? new ApngEncoder(w, h, { loopCount: animation.loopCount }) : null;
        const resizer = new RgbaResizer(
            animation.width,
            animation.height,
            w,
            h,
            this.config.imageResize ?? 'bilinear',
        );
        let resizedIndex = -1;
        let resized: Uint8ClampedArray | undefined;
        let sourceIndex = 0;
        const sourceTime = { elapsed: animation.frames[0]!.delayMs, error: 0 };
        for (let index = 0; index < totalFrames; index++) {
            throwIfAborted(this.config.signal);
            if ((index & 7) === 0) await yieldEventLoop();
            const time = fps === undefined ? 0 : (index * 1000) / fps;
            if (fps === undefined) sourceIndex = index;
            else
                while (
                    sourceIndex + 1 < animation.frames.length &&
                    time >= sourceTime.elapsed - timingTolerance(time, sourceTime.elapsed)
                ) {
                    addFrameDuration(sourceTime, animation.frames[++sourceIndex]!.delayMs);
                }
            const frame = animation.frames[sourceIndex]!;
            const delay = fps === undefined ? frame.delayMs : Math.min(1000 / fps, duration - time);
            if (sourceIndex !== resizedIndex) {
                resized = await resizer.resizeAsync(frame.data, this.config.signal);
                resizedIndex = sourceIndex;
            }
            const picture = { data: resized!, width: w, height: h };
            if (gif) await gif.addFrame({ ...picture, data: this.gifPixels(picture.data) }, delay);
            else if (webp) await awaitWithAbort(webp.addFrame(picture, delay), this.config.signal);
            else await awaitWithAbort(apng!.addFrame(picture, delay), this.config.signal);
            this.reportProgress(
                10 + Math.round((index / totalFrames) * 80),
                `Frame ${index + 1}/${totalFrames}`,
            );
        }
        this.reportProgress(95, 'Encoding...');
        return this.finishImage(
            gif ? gif.encode() : webp ? webp.encode() : apng!.encode(),
            outputFmt,
        );
    }

    assertAnimatedImageBudget(
        totalFrames: number,
        width: number,
        height: number,
        format: string,
    ): void {
        if (
            !Number.isSafeInteger(totalFrames) ||
            totalFrames < 1 ||
            !Number.isSafeInteger(width) ||
            width < 1 ||
            !Number.isSafeInteger(height) ||
            height < 1
        ) {
            throw new MediaForgeError(
                'Animation frame count and dimensions must be positive safe integers',
                'FORMAT',
            );
        }

        assertPixels(format.toUpperCase(), width, height, totalFrames, MAX_ANIMATION_PIXELS);
    }
}
