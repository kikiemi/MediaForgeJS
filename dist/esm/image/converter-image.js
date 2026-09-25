import { awaitWithAbort } from '../core/abort.js';
import { IMAGE_FORMATS } from '../core/format-plans.js';
import { yieldEventLoop } from '../core/demux-guard.js';
import { MAX_ANIMATION_PIXELS, validateImageEncodingOptions } from '../core/converter-config.js';
import { MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { sniffImageDimensions, sniffTiffDimensionsAt } from '../core/image-dimensions.js';
import { resolveTargetDimensions } from '../core/image-geometry.js';
import { logger } from '../core/logger.js';
import { RgbaResizer } from './rgba-resize.js';
import { CanvasImageRenderer } from './canvas-resize.js';
import { decodeAnimatedGif, decodeApng } from './animated-reader.js';
import { AnimatedGifEncoder, APNGEncoder, encodeBMP, encodeICO, encodeJPEG, encodePNG, encodeTIFF, encodeWebP, } from './encoders.js';
function addFrameDuration(total, duration) {
    const adjusted = duration - total.error;
    const next = total.elapsed + adjusted;
    total.error = next - total.elapsed - adjusted;
    total.elapsed = next;
    return next;
}
function timingTolerance(first, second) {
    return Number.EPSILON * 4 * Math.max(1, Math.abs(first), Math.abs(second));
}
function animationFrameCount(durationMs, fps) {
    const frames = (durationMs * fps) / 1000;
    const rounded = Math.round(frames);
    return Math.abs(frames - rounded) <= timingTolerance(frames, rounded) ? Math.max(1, rounded) : Math.ceil(frames);
}
export class ConverterImage {
    config;
    host;
    constructor(config, host) {
        this.config = config;
        this.host = host;
    }
    async convertImage(file, format) {
        const fmt = format ?? this.config.outputFormat;
        if (!IMAGE_FORMATS.has(fmt))
            throw new MediaForgeError(`Unsupported image output: ${fmt}`, 'FORMAT');
        validateImageEncodingOptions(this.config, fmt);
        this.config.signal?.throwIfAborted();
        logger.info(`[Converter] Image → ${fmt}`);
        if (fmt === 'gif' || fmt === 'apng') {
            const inputFmt = await this.host.detectFormat(file).catch(error => {
                rethrowIfAbort(error, this.config.signal);
                return null;
            });
            if (inputFmt === 'gif' || inputFmt === 'apng') {
                return this.convertAnimatedImage(file, inputFmt, fmt);
            }
        }
        const head = new Uint8Array(await awaitWithAbort(file.slice(0, 262144).arrayBuffer(), this.config.signal));
        let dims = sniffImageDimensions(head);
        const isTiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
            (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a);
        if (isTiff && !dims) {
            dims = await awaitWithAbort(sniffTiffDimensionsAt(file), this.config.signal);
            if (!dims) {
                throw new MediaForgeError('TIFF does not declare readable dimensions in its first IFD; refusing to decode it blindly', 'FORMAT');
            }
        }
        if (dims && dims.width * dims.height > 8192 * 4320) {
            throw new MediaForgeError(`image ${dims.width}×${dims.height} exceeds the supported pixel budget (8192×4320)`, 'FORMAT');
        }
        const bitmap = await this.bitmap(file);
        try {
            const { w, h } = resolveTargetDimensions(bitmap.width, bitmap.height, this.config);
            if (fmt === 'gif' || fmt === 'apng')
                this.assertAnimatedImageBudget(1, w, h, fmt);
            const renderer = new CanvasImageRenderer(bitmap.width, bitmap.height, w, h, this.config.imageResize);
            const canvas = await renderer.render(bitmap, this.config.signal);
            return await this.finishCanvas(canvas, fmt);
        }
        finally {
            bitmap.close();
        }
    }
    reportProgress(percent, message) {
        this.config.signal?.throwIfAborted();
        this.config.onProgress?.(percent, message);
        this.config.signal?.throwIfAborted();
    }
    bitmap(input, options) {
        const signal = this.config.signal;
        signal?.throwIfAborted();
        if (typeof createImageBitmap !== 'function')
            throw new MediaForgeError('ImageBitmap decoding is unavailable in this environment', 'DECODE');
        const pending = createImageBitmap(input, options).then(bitmap => {
            if (signal?.aborted) {
                bitmap.close();
                throw new MediaForgeError('Aborted', 'ABORT');
            }
            return bitmap;
        });
        return awaitWithAbort(pending, signal);
    }
    finishCanvas(canvas, format) {
        return this.finishImage(this.encodeCanvas(canvas, format));
    }
    async finishImage(pending) {
        const blob = await awaitWithAbort(pending, this.config.signal);
        this.reportProgress(100, 'Conversion complete');
        return blob;
    }
    async encodeCanvas(canvas, format) {
        switch (format) {
            case 'png':
                return encodePNG(canvas);
            case 'jpeg':
                return encodeJPEG(canvas, this.config.imageQuality);
            case 'webp':
                return encodeWebP(canvas, this.config.imageQuality);
            case 'bmp':
                return encodeBMP(canvas);
            case 'tiff':
                return encodeTIFF(canvas);
            case 'ico':
                return encodeICO(canvas);
            case 'gif':
            case 'apng': {
                const context = canvas.getContext('2d');
                if (!context)
                    throw new MediaForgeError('No 2D context', 'ENCODE');
                const data = context.getImageData(0, 0, canvas.width, canvas.height);
                if (format === 'gif') {
                    const encoder = new AnimatedGifEncoder(canvas.width, canvas.height, 0, {
                        dither: this.config.imageDither,
                    });
                    encoder.addFrameData(data, 0);
                    return encoder.encode();
                }
                const encoder = new APNGEncoder(canvas.width, canvas.height, 0, {
                    optimizeFrames: this.config.imageOptimizeFrames,
                });
                await encoder.addFrameRgba(data.data, 0);
                return encoder.encode();
            }
            default:
                throw new MediaForgeError(`Unsupported image output: ${format}`, 'FORMAT');
        }
    }
    async convertAnimatedImage(file, inputFmt, outputFmt) {
        const pixelBudget = this.config.maxAnimationPixels ?? MAX_ANIMATION_PIXELS;
        this.reportProgress(5, 'Decoding animation...');
        const bytes = new Uint8Array(await awaitWithAbort(file.arrayBuffer(), this.config.signal));
        const animation = inputFmt === 'gif'
            ? await decodeAnimatedGif(bytes, pixelBudget, this.config.signal)
            : await decodeApng(bytes, pixelBudget, this.config.signal);
        if (this.config.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        const { w, h } = resolveTargetDimensions(animation.width, animation.height, this.config);
        const fps = this.config.fps;
        if (fps !== undefined && animation.frames.some(frame => frame.delayMs <= 0)) {
            throw new MediaForgeError('fps requires animation frames with non-zero durations', 'FORMAT');
        }
        if (outputFmt === 'gif' && fps !== undefined && fps > 100) {
            throw new MediaForgeError('GIF frame timing supports at most 100 fps', 'FORMAT');
        }
        if (outputFmt === 'gif' && animation.loopCount > 0x10000) {
            throw new MediaForgeError(`GIF supports at most 65536 finite plays; received ${animation.loopCount}`, 'FORMAT');
        }
        const totalTime = { elapsed: 0, error: 0 };
        for (const frame of animation.frames)
            addFrameDuration(totalTime, frame.delayMs);
        const duration = totalTime.elapsed;
        const totalFrames = fps === undefined ? animation.frames.length : animationFrameCount(duration, fps);
        this.assertAnimatedImageBudget(totalFrames, w, h, outputFmt);
        const gif = outputFmt === 'gif'
            ? AnimatedGifEncoder.fromPlayCount(w, h, animation.loopCount, { dither: this.config.imageDither })
            : null;
        const apng = outputFmt === 'gif'
            ? null
            : new APNGEncoder(w, h, animation.loopCount, {
                optimizeFrames: this.config.imageOptimizeFrames,
            });
        const resizer = new RgbaResizer(animation.width, animation.height, w, h, this.config.imageResize);
        let resizedIndex = -1;
        let resized;
        let sourceIndex = 0;
        const sourceTime = { elapsed: animation.frames[0].delayMs, error: 0 };
        for (let index = 0; index < totalFrames; index++) {
            if (this.config.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            if ((index & 7) === 0)
                await yieldEventLoop();
            const time = fps === undefined ? 0 : (index * 1000) / fps;
            if (fps === undefined)
                sourceIndex = index;
            else
                while (sourceIndex + 1 < animation.frames.length &&
                    time >= sourceTime.elapsed - timingTolerance(time, sourceTime.elapsed)) {
                    addFrameDuration(sourceTime, animation.frames[++sourceIndex].delayMs);
                }
            const frame = animation.frames[sourceIndex];
            const delay = fps === undefined ? frame.delayMs : Math.min(1000 / fps, duration - time);
            if (sourceIndex !== resizedIndex) {
                resized = await resizer.resizeAsync(frame.rgba, this.config.signal);
                resizedIndex = sourceIndex;
            }
            const rgba = resized;
            if (gif)
                gif.addFrameData({ data: rgba, width: w, height: h }, delay);
            else
                await awaitWithAbort(apng.addFrameRgba(rgba, delay), this.config.signal);
            this.reportProgress(10 + Math.round((index / totalFrames) * 80), `Frame ${index + 1}/${totalFrames}`);
        }
        this.reportProgress(95, 'Encoding...');
        return this.finishImage(gif ? gif.encode() : apng.encode());
    }
    async videoToImage(file, format) {
        this.config.signal?.throwIfAborted();
        if (typeof document === 'undefined')
            throw new MediaForgeError('Video frame capture requires a browser document', 'DECODE');
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        const url = URL.createObjectURL(file);
        try {
            await this.waitForVideo(video, 'loadeddata', () => false, () => {
                video.src = url;
            });
            if ((format === 'gif' || format === 'apng') && video.duration > 0 && isFinite(video.duration)) {
                return await this.videoToAnimatedImage(video, format);
            }
            await this.seekVideo(video, Math.min(0.1, Math.max(0, video.duration / 2 || 0)));
            this.reportProgress(50, 'Encoding image...');
            const bitmap = await this.bitmap(video);
            try {
                const { w, h } = resolveTargetDimensions(bitmap.width, bitmap.height, this.config);
                if (format === 'gif' || format === 'apng')
                    this.assertAnimatedImageBudget(1, w, h, format);
                const renderer = new CanvasImageRenderer(bitmap.width, bitmap.height, w, h, this.config.imageResize);
                const canvas = await renderer.render(bitmap, this.config.signal);
                return await this.finishCanvas(canvas, format);
            }
            finally {
                bitmap.close();
            }
        }
        finally {
            try {
                video.pause();
            }
            catch { }
            try {
                video.removeAttribute('src');
            }
            catch { }
            try {
                video.load();
            }
            catch { }
            try {
                URL.revokeObjectURL(url);
            }
            catch { }
        }
    }
    assertAnimatedImageBudget(totalFrames, width, height, format) {
        if (!Number.isSafeInteger(totalFrames) ||
            totalFrames < 1 ||
            !Number.isSafeInteger(width) ||
            width < 1 ||
            !Number.isSafeInteger(height) ||
            height < 1) {
            throw new MediaForgeError('Animation frame count and dimensions must be positive safe integers', 'FORMAT');
        }
        const pixelBudget = this.config.maxAnimationPixels ?? MAX_ANIMATION_PIXELS;
        const maxFramesAtSize = Math.floor(pixelBudget / (width * height));
        if (totalFrames <= maxFramesAtSize)
            return;
        throw new MediaForgeError(`animated ${format.toUpperCase()} would hold ${totalFrames}×${width}×${height} pixels, over the ${pixelBudget}-pixel budget; ` +
            `reduce width/height, fps, or duration (at ${width}×${height}, up to ${maxFramesAtSize} frames fit)`, 'FORMAT');
    }
    async videoToAnimatedImage(video, format) {
        if (this.config.fps !== undefined && this.config.fps > 30) {
            throw new MediaForgeError(`animated ${format.toUpperCase()} capture supports at most 30 fps; requested ${this.config.fps}`, 'FORMAT');
        }
        const fps = this.config.fps ?? 10;
        const interval = 1 / fps;
        const delayMs = 1000 / fps;
        const totalFrames = animationFrameCount(video.duration * 1000, fps);
        const { w, h } = resolveTargetDimensions(video.videoWidth, video.videoHeight, this.config);
        if (totalFrames === 0)
            throw new MediaForgeError('Video reports zero duration; no frames to capture', 'DECODE');
        this.assertAnimatedImageBudget(totalFrames, w, h, format);
        const gif = format === 'gif' ? new AnimatedGifEncoder(w, h, 0, { dither: this.config.imageDither }) : null;
        const apng = format === 'gif'
            ? null
            : new APNGEncoder(w, h, 0, {
                optimizeFrames: this.config.imageOptimizeFrames,
            });
        const renderer = this.config.imageResize === 'lanczos3'
            ? new CanvasImageRenderer(video.videoWidth, video.videoHeight, w, h, this.config.imageResize)
            : undefined;
        for (let index = 0; index < totalFrames; index++) {
            if (this.config.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            await this.seekVideo(video, index * interval);
            const bitmap = await this.bitmap(video, renderer
                ? undefined
                : {
                    resizeWidth: w,
                    resizeHeight: h,
                    ...(this.config.imageResize
                        ? {
                            resizeQuality: this.config.imageResize === 'nearest'
                                ? 'pixelated'
                                : 'low',
                        }
                        : {}),
                });
            const frameDelay = Math.min(delayMs, (video.duration - index * interval) * 1000);
            try {
                if (renderer) {
                    const canvas = await renderer.render(bitmap, this.config.signal);
                    const context = canvas.getContext('2d');
                    if (!context)
                        throw new MediaForgeError('No 2D context', 'ENCODE');
                    const data = context.getImageData(0, 0, w, h);
                    if (gif)
                        gif.addFrameData(data, frameDelay);
                    else
                        await awaitWithAbort(apng.addFrameRgba(data.data, frameDelay), this.config.signal);
                }
                else {
                    await awaitWithAbort(gif ? gif.addFrame(bitmap, frameDelay) : apng.addFrame(bitmap, frameDelay), this.config.signal);
                }
            }
            finally {
                bitmap.close();
            }
            this.reportProgress(5 + Math.round((index / totalFrames) * 90), `Frame ${index + 1}/${totalFrames}`);
        }
        this.reportProgress(95, 'Encoding...');
        return this.finishImage(gif ? gif.encode() : apng.encode());
    }
    seekVideo(video, time) {
        return this.waitForVideo(video, 'seeked', () => video.currentTime === time && !video.seeking && video.readyState >= 2, () => {
            video.currentTime = time;
        });
    }
    waitForVideo(video, event, ready, start) {
        const signal = this.config.signal;
        if (signal?.aborted)
            return Promise.reject(new MediaForgeError('Aborted', 'ABORT'));
        if (ready())
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            let frameCallback;
            let eventReady = false;
            let frameReady = typeof video.requestVideoFrameCallback !== 'function' ||
                typeof video.cancelVideoFrameCallback !== 'function';
            const cleanup = () => {
                clearTimeout(timer);
                video.removeEventListener(event, onReady);
                video.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
                if (frameCallback !== undefined)
                    video.cancelVideoFrameCallback(frameCallback);
            };
            const complete = () => {
                if (eventReady && frameReady) {
                    cleanup();
                    resolve();
                }
            };
            const onReady = () => {
                eventReady = true;
                complete();
            };
            const onError = () => {
                cleanup();
                reject(new MediaForgeError(`Video ${event} failed`, 'DECODE'));
            };
            const onAbort = () => {
                cleanup();
                reject(new MediaForgeError('Aborted', 'ABORT'));
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new MediaForgeError(`Video ${event} timeout (10s)`, 'DECODE'));
            }, 10000);
            video.addEventListener(event, onReady, { once: true });
            video.addEventListener('error', onError, { once: true });
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                if (!frameReady)
                    frameCallback = video.requestVideoFrameCallback(() => {
                        frameCallback = undefined;
                        frameReady = true;
                        complete();
                    });
                start?.();
            }
            catch (error) {
                cleanup();
                reject(error);
            }
        });
    }
}
