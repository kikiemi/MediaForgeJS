import { MediaForgeError } from '../core/errors.js';
import { LanczosResizer } from './lanczos-resize.js';
const YIELD_INTERVAL_MS = 8;
const LEGACY_BLOCK_PIXELS = 32768;
function axis(source, target, stride, linear) {
    const first = new Uint32Array(target);
    const second = linear ? new Uint32Array(target) : undefined;
    const weight = linear ? new Float64Array(target) : undefined;
    for (let i = 0; i < target; i++) {
        const position = linear
            ? Math.max(0, Math.min(source - 1, ((i + 0.5) * source) / target - 0.5))
            : Math.min(source - 1, Math.floor((i * source) / target));
        const lower = Math.floor(position);
        first[i] = lower * stride;
        if (second && weight) {
            second[i] = Math.min(source - 1, lower + 1) * stride;
            weight[i] = position - lower;
        }
    }
    return { first, second, weight };
}
export class RgbaResizer {
    sourceWidth;
    sourceHeight;
    width;
    height;
    method;
    x;
    y;
    lanczos;
    constructor(sourceWidth, sourceHeight, width, height, method = 'nearest') {
        this.sourceWidth = sourceWidth;
        this.sourceHeight = sourceHeight;
        this.width = width;
        this.height = height;
        this.method = method;
        for (const side of [sourceWidth, sourceHeight]) {
            if (!Number.isSafeInteger(side) || side < 1) {
                throw new MediaForgeError('source resize dimensions must be positive safe integers', 'FORMAT');
            }
        }
        if (sourceWidth * sourceHeight > 128 * 1024 * 1024) {
            throw new MediaForgeError('source resize dimensions exceed the animation decode pixel budget', 'FORMAT');
        }
        for (const side of [width, height]) {
            if (!Number.isInteger(side) || side < 1 || side > 16384) {
                throw new MediaForgeError('resize dimensions must be integers in 1..16384', 'FORMAT');
            }
        }
        if (width * height > 8192 * 4320) {
            throw new MediaForgeError('resize dimensions exceed the supported pixel budget (8192×4320)', 'FORMAT');
        }
        if (method !== 'nearest' && method !== 'bilinear' && method !== 'lanczos3') {
            throw new MediaForgeError('imageResize must be nearest, bilinear or lanczos3', 'FORMAT');
        }
        if (method === 'lanczos3') {
            this.lanczos = new LanczosResizer(sourceWidth, sourceHeight, width, height);
            this.x = this.y = { first: new Uint32Array(0) };
            return;
        }
        const linear = method === 'bilinear';
        this.x = axis(sourceWidth, width, 4, linear);
        this.y = axis(sourceHeight, height, sourceWidth * 4, linear);
    }
    resize(source) {
        this.validateSource(source);
        if (this.lanczos) {
            const operation = this.lanczos.resize(source);
            let step = operation.next();
            while (!step.done)
                step = operation.next();
            return step.value;
        }
        if (this.sourceWidth === this.width && this.sourceHeight === this.height)
            return source;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        this.resizeRows(source, output, 0, this.height);
        return output;
    }
    async resizeAsync(source, signal) {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        this.validateSource(source);
        let lastYield = performance.now();
        if (this.lanczos) {
            const operation = this.lanczos.resize(source);
            for (;;) {
                if (signal?.aborted)
                    throw new MediaForgeError('Aborted', 'ABORT');
                const step = operation.next();
                if (step.done)
                    return step.value;
                if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    lastYield = performance.now();
                }
            }
        }
        if (this.sourceWidth === this.width && this.sourceHeight === this.height)
            return source;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        const blockRows = Math.max(1, Math.floor(LEGACY_BLOCK_PIXELS / this.width));
        for (let y = 0; y < this.height; y += blockRows) {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            this.resizeRows(source, output, y, Math.min(this.height, y + blockRows));
            if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYield = performance.now();
            }
        }
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return output;
    }
    validateSource(source) {
        if (source.length !== this.sourceWidth * this.sourceHeight * 4) {
            throw new MediaForgeError('RGBA frame length does not match its dimensions', 'FORMAT');
        }
    }
    resizeRows(source, output, firstRow, lastRow) {
        if (this.method === 'nearest') {
            for (let y = firstRow, target = firstRow * this.width * 4; y < lastRow; y++) {
                const row = this.y.first[y];
                for (let x = 0; x < this.width; x++, target += 4) {
                    const from = row + this.x.first[x];
                    output[target] = source[from];
                    output[target + 1] = source[from + 1];
                    output[target + 2] = source[from + 2];
                    output[target + 3] = source[from + 3];
                }
            }
            return;
        }
        for (let y = firstRow, target = firstRow * this.width * 4; y < lastRow; y++) {
            const top = this.y.first[y], bottom = this.y.second[y];
            const wy = this.y.weight[y];
            for (let x = 0; x < this.width; x++, target += 4) {
                const left = this.x.first[x], right = this.x.second[x];
                const wx = this.x.weight[x];
                const a = top + left, b = top + right, c = bottom + left, d = bottom + right;
                const wa = (1 - wx) * (1 - wy) * source[a + 3];
                const wb = wx * (1 - wy) * source[b + 3];
                const wc = (1 - wx) * wy * source[c + 3];
                const wd = wx * wy * source[d + 3];
                const alpha = wa + wb + wc + wd;
                output[target + 3] = Math.round(alpha);
                if (alpha > 0) {
                    for (let channel = 0; channel < 3; channel++) {
                        output[target + channel] = Math.round((source[a + channel] * wa +
                            source[b + channel] * wb +
                            source[c + channel] * wc +
                            source[d + channel] * wd) /
                            alpha);
                    }
                }
            }
        }
    }
}
