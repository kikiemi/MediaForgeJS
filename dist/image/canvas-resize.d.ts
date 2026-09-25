import type { ImageResizeMethod } from '../types/media.js';
export declare class CanvasImageRenderer {
    readonly canvas: OffscreenCanvas;
    private readonly context;
    private readonly resizer?;
    private readonly sourceContext?;
    constructor(sourceWidth: number, sourceHeight: number, width: number, height: number, method?: ImageResizeMethod);
    render(bitmap: ImageBitmap, signal?: AbortSignal): Promise<OffscreenCanvas>;
}
