import { yieldEventLoop } from '../../core/io/event-loop';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { LANCZOS3, SeparableResizer, TRIANGLE } from './separable-resize';
import { MAX_ANIMATION_PIXELS, assertPixels } from './rgba-image';

const YIELD_INTERVAL_MS = 8;
/** Output pixels the two-sample path resizes between checks of the yield interval. */
const BLOCK_PIXELS = 32768;

/** Linear axes also keep 1 - weight. */
type Axis = {
    first: Uint32Array;
    second?: Uint32Array;
    weight?: Float64Array;
    inverse?: Float64Array;
};

function axis(source: number, target: number, stride: number, linear: boolean): Axis {
    const first = new Uint32Array(target);
    const second = linear ? new Uint32Array(target) : undefined;
    const weight = linear ? new Float64Array(target) : undefined;
    const inverse = linear ? new Float64Array(target) : undefined;
    for (let i = 0; i < target; i++) {
        const position = linear
            ? Math.max(0, Math.min(source - 1, ((i + 0.5) * source) / target - 0.5))
            : Math.min(source - 1, Math.floor((i * source) / target));
        const lower = Math.floor(position);
        first[i] = lower * stride;
        if (second && weight && inverse) {
            second[i] = Math.min(source - 1, lower + 1) * stride;
            weight[i] = position - lower;
            inverse[i] = 1 - weight[i]!;
        }
    }
    return { first, second, weight, inverse };
}

/**
 * Resizes straight RGBA, reusing coordinate tables across equally sized animation frames.
 * 'bilinear' interpolates two samples per axis when enlarging; when either side shrinks, its
 * triangle widens with the reduction and averages every source sample under it, so detail finer
 * than the new grid does not alias. 'lanczos3' widens its kernel the same way.
 */
export class RgbaResizer {
    private readonly x: Axis;
    private readonly y: Axis;
    private readonly separable?: SeparableResizer;

    constructor(
        private readonly sourceWidth: number,
        private readonly sourceHeight: number,
        private readonly width: number,
        private readonly height: number,
        private readonly method: ImageResizeMethod = 'nearest',
    ) {
        for (const side of [sourceWidth, sourceHeight]) {
            if (!Number.isSafeInteger(side) || side < 1) {
                throw new MediaForgeError(
                    'source resize dimensions must be positive safe integers',
                    'INPUT',
                );
            }
        }
        assertPixels('resize source', sourceWidth, sourceHeight, 1, MAX_ANIMATION_PIXELS);
        for (const side of [width, height]) {
            if (!Number.isInteger(side) || side < 1 || side > 16384) {
                throw new MediaForgeError(
                    'resize dimensions must be integers in 1..16384',
                    'FORMAT',
                );
            }
        }
        assertPixels('resize', width, height);
        if (method !== 'nearest' && method !== 'bilinear' && method !== 'lanczos3') {
            throw new MediaForgeError(
                'imageResize must be nearest, bilinear or lanczos3',
                'FORMAT',
            );
        }
        const shrinks = width < sourceWidth || height < sourceHeight;
        if (method === 'lanczos3' || (method === 'bilinear' && shrinks)) {
            const kernel = method === 'lanczos3' ? LANCZOS3 : TRIANGLE;
            this.separable = new SeparableResizer(sourceWidth, sourceHeight, width, height, kernel);
            this.x = this.y = { first: new Uint32Array(0) };
            return;
        }
        const linear = method === 'bilinear';
        this.x = axis(sourceWidth, width, 4, linear);
        this.y = axis(sourceHeight, height, sourceWidth * 4, linear);
    }

    resize(source: Uint8ClampedArray): Uint8ClampedArray {
        this.validateSource(source);
        if (this.separable) {
            const operation = this.separable.resize(source);
            let step = operation.next();
            while (!step.done) step = operation.next();
            return step.value;
        }
        if (this.sourceWidth === this.width && this.sourceHeight === this.height) return source;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        this.resizeRows(source, output, 0, this.height);
        return output;
    }

    /** Yields during heavy filtering so an AbortSignal can interrupt the frame. */
    async resizeAsync(source: Uint8ClampedArray, signal?: AbortSignal): Promise<Uint8ClampedArray> {
        throwIfAborted(signal);
        this.validateSource(source);
        let lastYield = performance.now();
        if (this.separable) {
            const operation = this.separable.resize(source);
            for (;;) {
                throwIfAborted(signal);
                const step = operation.next();
                if (step.done) return step.value;
                if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
                    await yieldEventLoop();
                    lastYield = performance.now();
                }
            }
        }
        if (this.sourceWidth === this.width && this.sourceHeight === this.height) return source;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        const blockRows = Math.max(1, Math.floor(BLOCK_PIXELS / this.width));
        for (let y = 0; y < this.height; y += blockRows) {
            throwIfAborted(signal);
            this.resizeRows(source, output, y, Math.min(this.height, y + blockRows));
            if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
                await yieldEventLoop();
                lastYield = performance.now();
            }
        }
        throwIfAborted(signal);
        return output;
    }

    private validateSource(source: Uint8ClampedArray): void {
        if (source.length !== this.sourceWidth * this.sourceHeight * 4) {
            throw new MediaForgeError('RGBA frame length does not match its dimensions', 'FORMAT');
        }
    }

    private resizeRows(
        source: Uint8ClampedArray,
        output: Uint8ClampedArray,
        firstRow: number,
        lastRow: number,
    ): void {
        if (this.method === 'nearest') {
            for (let y = firstRow, target = firstRow * this.width * 4; y < lastRow; y++) {
                const row = this.y.first[y]!;
                for (let x = 0; x < this.width; x++, target += 4) {
                    const from = row + this.x.first[x]!;
                    output[target] = source[from]!;
                    output[target + 1] = source[from + 1]!;
                    output[target + 2] = source[from + 2]!;
                    output[target + 3] = source[from + 3]!;
                }
            }
            return;
        }
        const width = this.width;
        const xFirst = this.x.first;
        const xSecond = this.x.second!;
        const xWeight = this.x.weight!;
        const xInverse = this.x.inverse!;
        for (let y = firstRow, target = firstRow * width * 4; y < lastRow; y++) {
            const top = this.y.first[y]!;
            const bottom = this.y.second![y]!;
            const wy = this.y.weight![y]!;
            const iy = this.y.inverse![y]!;
            for (let x = 0; x < width; x++, target += 4) {
                const left = xFirst[x]!;
                const right = xSecond[x]!;
                const wx = xWeight[x]!;
                const ix = xInverse[x]!;
                const a = top + left;
                const b = top + right;
                const c = bottom + left;
                const d = bottom + right;
                const wa = ix * iy * source[a + 3]!;
                const wb = wx * iy * source[b + 3]!;
                const wc = ix * wy * source[c + 3]!;
                const wd = wx * wy * source[d + 3]!;
                const alpha = wa + wb + wc + wd;
                output[target + 3] = Math.round(alpha);
                if (alpha > 0) {
                    output[target] = Math.round(
                        (source[a]! * wa + source[b]! * wb + source[c]! * wc + source[d]! * wd) /
                            alpha,
                    );
                    output[target + 1] = Math.round(
                        (source[a + 1]! * wa +
                            source[b + 1]! * wb +
                            source[c + 1]! * wc +
                            source[d + 1]! * wd) /
                            alpha,
                    );
                    output[target + 2] = Math.round(
                        (source[a + 2]! * wa +
                            source[b + 2]! * wb +
                            source[c + 2]! * wc +
                            source[d + 2]! * wd) /
                            alpha,
                    );
                }
            }
        }
    }
}

export type ImageResizeMethod = 'nearest' | 'bilinear' | 'lanczos3';
