import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import type { ImageResizeMethod } from './rgba-resize';
import { RgbaResizer } from './rgba-resize';

export class CanvasImageRenderer {
    readonly canvas: OffscreenCanvas;
    private readonly context: OffscreenCanvasRenderingContext2D;
    private readonly resizer?: RgbaResizer;
    private readonly sourceContext?: OffscreenCanvasRenderingContext2D;

    constructor(
        sourceWidth: number,
        sourceHeight: number,
        width: number,
        height: number,
        method?: ImageResizeMethod,
    ) {
        // The canvas draws two-sample bilinear at any size; Lanczos and reductions are filtered on
        // the CPU, as without a canvas.
        const shrinks = width < sourceWidth || height < sourceHeight;
        if (
            (method === 'lanczos3' || (method === 'bilinear' && shrinks)) &&
            (sourceWidth !== width || sourceHeight !== height)
        ) {
            this.resizer = new RgbaResizer(sourceWidth, sourceHeight, width, height, method);
            const source = new OffscreenCanvas(sourceWidth, sourceHeight);
            const context = source.getContext('2d', { willReadFrequently: true });
            if (!context) throw new MediaForgeError('No 2D context', 'ENCODE');
            this.sourceContext = context;
        }

        this.canvas = new OffscreenCanvas(width, height);
        const context = this.canvas.getContext('2d');
        if (!context) throw new MediaForgeError('No 2D context', 'ENCODE');
        this.context = context;
        if (method !== undefined) {
            context.imageSmoothingEnabled = method !== 'nearest';
            context.imageSmoothingQuality = 'low';
        }
    }

    async render(
        bitmap: ImageBitmap | OffscreenCanvas,
        signal?: AbortSignal,
    ): Promise<OffscreenCanvas> {
        throwIfAborted(signal);
        const { width, height } = this.canvas;
        if (this.resizer && this.sourceContext) {
            const source = this.sourceContext;
            source.clearRect(0, 0, source.canvas.width, source.canvas.height);
            source.drawImage(bitmap, 0, 0);
            const input = source.getImageData(0, 0, source.canvas.width, source.canvas.height);
            const output = await this.resizer.resizeAsync(input.data, signal);
            this.context.putImageData(
                new ImageData(output as Uint8ClampedArray<ArrayBuffer>, width, height),
                0,
                0,
            );
        } else {
            this.context.clearRect(0, 0, width, height);
            this.context.drawImage(bitmap, 0, 0, width, height);
        }

        throwIfAborted(signal);
        return this.canvas;
    }
}
