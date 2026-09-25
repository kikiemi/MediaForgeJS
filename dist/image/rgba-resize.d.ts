import type { ImageResizeMethod } from '../types/media.js';
/** Reuses coordinate tables across equally sized animation frames. */
export declare class RgbaResizer {
    private readonly sourceWidth;
    private readonly sourceHeight;
    private readonly width;
    private readonly height;
    private readonly method;
    private readonly x;
    private readonly y;
    private readonly lanczos?;
    constructor(sourceWidth: number, sourceHeight: number, width: number, height: number, method?: ImageResizeMethod);
    resize(source: Uint8ClampedArray): Uint8ClampedArray;
    /** Yields during heavy filtering so an AbortSignal can interrupt the frame. */
    resizeAsync(source: Uint8ClampedArray, signal?: AbortSignal): Promise<Uint8ClampedArray>;
    private validateSource;
    private resizeRows;
}
