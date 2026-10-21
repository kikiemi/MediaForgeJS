const MAX_AXIS_WEIGHTS = 262144;
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 64;

/** `weights` hold the kernel values already divided by `norm`. */
type Tap = { start: number; end: number; center: number; norm: number; weights?: Float64Array };

/** A separable resampling kernel: its value at a distance in source samples, and its reach. */
interface Kernel {
    readonly value: (distance: number) => number;
    readonly support: number;
}

type FilterAxis = { scale: number; kernel: Kernel; taps: Tap[] };

type Work = { count: number };

function lanczos3(distance: number): number {
    const x = Math.abs(distance);
    if (x < 1e-12) return 1;
    if (x >= 3) return 0;
    const angle = Math.PI * x;
    return (Math.sin(angle) * Math.sin(angle / 3)) / ((angle * angle) / 3);
}

/** Lanczos with three lobes. */
export const LANCZOS3: Kernel = { value: lanczos3, support: 3 };

/** The triangle of linear interpolation; widened with the reduction, it averages the area. */
export const TRIANGLE: Kernel = {
    value: distance => Math.max(0, 1 - Math.abs(distance)),
    support: 1,
};

function* buildAxis(
    source: number,
    target: number,
    kernel: Kernel,
    work: Work,
): Generator<void, FilterAxis> {
    const scale = Math.max(1, source / target),
        reach = kernel.support * scale,
        taps: Tap[] = [];
    let remaining = MAX_AXIS_WEIGHTS;
    for (let destination = 0; destination < target; destination++) {
        const center = ((destination + 0.5) * source) / target - 0.5;
        const start = Math.max(0, Math.ceil(center - reach));
        const end = Math.min(source - 1, Math.floor(center + reach));
        const length = end - start + 1;
        const weights = length <= remaining ? new Float64Array(length) : undefined;
        if (weights) remaining -= length;
        let norm = 0;
        for (let sample = start; sample <= end; sample++) {
            const weight = kernel.value((sample - center) / scale);
            norm += weight;
            if (weights) weights[sample - start] = weight;
            if ((++work.count & 8191) === 0) yield;
        }
        if (weights)
            for (let index = 0; index < length; index++) weights[index] = weights[index]! / norm;
        taps.push({ start, end, center, norm, weights });
    }
    return { scale, kernel, taps };
}

function weightAt(axis: FilterAxis, tap: Tap, sample: number): number {
    return tap.weights
        ? tap.weights[sample - tap.start]!
        : axis.kernel.value((sample - tap.center) / axis.scale) / tap.norm;
}

/**
 * Filters one source row along the first axis into `row`: alpha-weighted red, green and blue and
 * the alpha of each output sample. A plain function, so the engine optimizes it on its own.
 */
function filterRow(
    source: Uint8ClampedArray,
    rowBase: number,
    sampleStride: number,
    axis: FilterAxis,
    row: Float64Array,
): void {
    const taps = axis.taps;
    for (let x = 0; x < taps.length; x++) {
        const horizontal = taps[x]!,
            target = x * 4;
        const weights = horizontal.weights;
        let red = 0,
            green = 0,
            blue = 0,
            alpha = 0;
        for (let sx = horizontal.start; sx <= horizontal.end; sx++) {
            const index = rowBase + sx * sampleStride;
            const weight = weights
                ? weights[sx - horizontal.start]!
                : weightAt(axis, horizontal, sx);
            const wa = weight * source[index + 3]!;
            red += source[index]! * wa;
            green += source[index + 1]! * wa;
            blue += source[index + 2]! * wa;
            alpha += wa;
        }
        row[target] = red;
        row[target + 1] = green;
        row[target + 2] = blue;
        row[target + 3] = alpha;
    }
}

function accumulateRow(accumulated: Float64Array, row: Float64Array, weight: number): void {
    for (let i = 0; i < accumulated.length; i++) accumulated[i] += row[i]! * weight;
}

/** Writes one output line: straight RGBA from the alpha-weighted sums. */
function storeLine(
    accumulated: Float64Array,
    output: Uint8ClampedArray,
    offset: number,
    step: number,
): void {
    for (let i = 0, target = offset; i < accumulated.length; i += 4, target += step) {
        const alpha = accumulated[i + 3]!;
        output[target + 3] = Math.round(alpha);
        if (output[target + 3]) {
            output[target] = Math.round(accumulated[i]! / alpha);
            output[target + 1] = Math.round(accumulated[i + 1]! / alpha);
            output[target + 2] = Math.round(accumulated[i + 2]! / alpha);
        }
    }
}

/**
 * Separable resampling of straight RGBA with alpha-weighted color, the kernel widened by the
 * reduction on each axis. Bounded coefficient tables persist; pixel row scratch belongs to one
 * frame.
 */
export class SeparableResizer {
    private first?: FilterAxis;
    private second?: FilterAxis;

    constructor(
        private readonly sourceWidth: number,
        private readonly sourceHeight: number,
        private readonly width: number,
        private readonly height: number,
        private readonly kernel: Kernel = LANCZOS3,
    ) {}

    *resize(source: Uint8ClampedArray): Generator<void, Uint8ClampedArray> {
        const work = { count: 0 };
        const transposed = this.sourceHeight * this.width > this.sourceWidth * this.height;
        const firstSource = transposed ? this.sourceHeight : this.sourceWidth;
        const secondSource = transposed ? this.sourceWidth : this.sourceHeight;
        const firstTarget = transposed ? this.height : this.width;
        const secondTarget = transposed ? this.width : this.height;
        const sampleStride = transposed ? this.sourceWidth * 4 : 4;
        const rowStride = transposed ? 4 : this.sourceWidth * 4;
        const xAxis = this.first ?? (yield* buildAxis(firstSource, firstTarget, this.kernel, work));
        this.first = xAxis;
        const yAxis =
            this.second ?? (yield* buildAxis(secondSource, secondTarget, this.kernel, work));
        this.second = yAxis;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        const rowLength = firstTarget * 4;
        const capacity = Math.max(
            1,
            Math.min(MAX_ROWS, Math.floor(MAX_ROW_BYTES / (rowLength * 8))),
        );
        const cacheCapacity = yAxis.taps.some(tap => tap.end - tap.start + 1 > capacity)
            ? Math.max(1, capacity - 1)
            : capacity;
        const rows = new Map<number, Float64Array>();
        const accumulated = new Float64Array(rowLength);
        const rowWork = firstTarget * (xAxis.taps[0]!.end - xAxis.taps[0]!.start + 1);
        let scratch: Float64Array | undefined;
        for (let y = 0; y < secondTarget; y++) {
            accumulated.fill(0);
            const vertical = yAxis.taps[y]!;
            for (let sy = vertical.start; sy <= vertical.end; sy++) {
                const wy = weightAt(yAxis, vertical, sy);
                if (wy === 0) continue;
                let row = rows.get(sy);
                if (!row) {
                    let retain = true;
                    if (rows.size >= cacheCapacity) {
                        const oldest = rows.keys().next().value!;
                        if (oldest < sy) {
                            row = rows.get(oldest)!;
                            rows.delete(oldest);
                        } else {
                            row = scratch ??= new Float64Array(rowLength);
                            retain = false;
                        }
                        row.fill(0);
                    } else {
                        row = new Float64Array(rowLength);
                    }
                    filterRow(source, sy * rowStride, sampleStride, xAxis, row);
                    if (retain) rows.set(sy, row);
                    work.count += rowWork;
                    if (work.count >= 8192) {
                        work.count = 0;
                        yield;
                    }
                }
                accumulateRow(accumulated, row, wy);
                work.count += rowLength;
            }
            if (transposed) storeLine(accumulated, output, y * 4, this.width * 4);
            else storeLine(accumulated, output, y * rowLength, 4);
            work.count += rowLength;
            if (work.count >= 8192) {
                work.count = 0;
                yield;
            }
        }
        return output;
    }
}
