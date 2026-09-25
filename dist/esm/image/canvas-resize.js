import { MediaForgeError } from '../core/errors.js';
import { RgbaResizer } from './rgba-resize.js';
export class CanvasImageRenderer {
    canvas;
    context;
    resizer;
    sourceContext;
    constructor(sourceWidth, sourceHeight, width, height, method) {
        if (method === 'lanczos3' && (sourceWidth !== width || sourceHeight !== height)) {
            this.resizer = new RgbaResizer(sourceWidth, sourceHeight, width, height, method);
            const source = new OffscreenCanvas(sourceWidth, sourceHeight);
            const context = source.getContext('2d', { willReadFrequently: true });
            if (!context)
                throw new MediaForgeError('No 2D context', 'ENCODE');
            this.sourceContext = context;
        }
        this.canvas = new OffscreenCanvas(width, height);
        const context = this.canvas.getContext('2d');
        if (!context)
            throw new MediaForgeError('No 2D context', 'ENCODE');
        this.context = context;
        if (method !== undefined) {
            context.imageSmoothingEnabled = method !== 'nearest';
            context.imageSmoothingQuality = 'low';
        }
    }
    async render(bitmap, signal) {
        signal?.throwIfAborted();
        const { width, height } = this.canvas;
        if (this.resizer && this.sourceContext) {
            const source = this.sourceContext;
            source.clearRect(0, 0, source.canvas.width, source.canvas.height);
            source.drawImage(bitmap, 0, 0);
            const input = source.getImageData(0, 0, source.canvas.width, source.canvas.height);
            const output = await this.resizer.resizeAsync(input.data, signal);
            this.context.putImageData(new ImageData(output, width, height), 0, 0);
        }
        else {
            this.context.clearRect(0, 0, width, height);
            this.context.drawImage(bitmap, 0, 0, width, height);
        }
        signal?.throwIfAborted();
        return this.canvas;
    }
}
