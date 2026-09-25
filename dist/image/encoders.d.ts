import type { GifDitherMode } from '../types/media.js';
export declare function encodePngFromRgba(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<Uint8Array<ArrayBuffer>>;
/** Encode a canvas to PNG. */
export declare function encodePNG(canvas: OffscreenCanvas): Promise<Blob>;
/** Encode an opaque canvas to JPEG; transparent pixels are rejected with ENCODE. */
export declare function encodeJPEG(canvas: OffscreenCanvas, quality?: number): Promise<Blob>;
/** Encode a canvas to WebP. */
export declare function encodeWebP(canvas: OffscreenCanvas, quality?: number): Promise<Blob>;
/** Encode top-down BMP: 24-bit opaque or 32-bit V5 with alpha; pixel budget 8192x4320. */
export declare function encodeBMP(canvas: OffscreenCanvas): Promise<Blob>;
/** Encode single-strip RGB/RGBA TIFF with unassociated alpha; pixel budget 8192x4320. */
export declare function encodeTIFF(canvas: OffscreenCanvas): Promise<Blob>;
/** Encode PNG-in-ICO at min(width, 256) square; source pixel budget is 8192x4320. */
export declare function encodeICO(canvas: OffscreenCanvas): Promise<Blob>;
export interface GifFrameData {
    readonly data: Uint8ClampedArray | Uint8Array;
    readonly width: number;
    readonly height: number;
}
export interface GifEncoderOptions {
    /** Defaults to Floyd-Steinberg; none maps each pixel independently. */
    readonly dither?: GifDitherMode;
}
export declare class AnimatedGifEncoder {
    private readonly width;
    private readonly height;
    private repeatCount;
    private readonly dither;
    private parts;
    private frameCount;
    private previous;
    private prevClearedCanvas;
    private pending;
    private idealMs;
    private emittedCs;
    /** Legacy loop count: 0 is infinite, 1 is one play, and 2..65535 are extra repetitions. */
    constructor(w: number, h: number, loopCount?: number, options?: GifEncoderOptions);
    /** Total plays: 0 is infinite; 1..65536 play that many times. Invalid values throw ENCODE. */
    static fromPlayCount(w: number, h: number, playCount: number, options?: GifEncoderOptions): AnimatedGifEncoder;
    /** Adds one frame from an ImageBitmap with the given delay in milliseconds. */
    addFrame(source: ImageBitmap, delayMs: number): Promise<void>;
    /** GIF preserves only alpha 0 or 255; partial alpha is rejected before changing encoder state. */
    addFrameData(frame: GifFrameData, delayMs: number): void;
    private emitFrame;
    /** Finalizes the animation and returns the encoded file as a Blob. */
    encode(): Promise<Blob>;
    private writeHeader;
    private buildPalette;
    private ditherRegion;
}
export interface APNGEncoderOptions {
    /** Encode exact RGBA changes as SOURCE rectangles; defaults to false. */
    readonly optimizeFrames?: boolean;
}
/**
 * Frame-by-frame APNG encoder. Add calls reserve their frame order immediately.
 * `encode()` waits for prior additions, rejects overlapping mutations, and clears frames after success for reuse.
 */
export declare class APNGEncoder {
    private readonly width;
    private readonly height;
    private readonly loopCount;
    private readonly optimizeFrames;
    private frames;
    private encoding;
    private previousRgba;
    private optimizationTail;
    constructor(w: number, h: number, loopCount?: number, options?: APNGEncoderOptions);
    /** Adds an ImageBitmap frame as RGBA; additions are rejected while `encode()` is active. */
    addFrame(source: ImageBitmap, delayMs: number): Promise<void>;
    /** Adds exact width*height*4 RGBA bytes; additions are rejected while `encode()` is active. */
    addFrameRgba(rgba: Uint8Array | Uint8ClampedArray, delayMs: number): Promise<void>;
    /** Waits for prior additions, encodes their call order, and rejects concurrent additions or encodes. */
    encode(): Promise<Blob>;
    private assertCanAdd;
    private handledRejection;
    private trackFrame;
    private queueOptimizedFrame;
    private frameRegion;
    private encodeFrames;
}
