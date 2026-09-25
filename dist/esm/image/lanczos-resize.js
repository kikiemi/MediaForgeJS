const MAX_AXIS_WEIGHTS = 262144;
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 64;
function kernel(distance) {
    const x = Math.abs(distance);
    if (x < 1e-12)
        return 1;
    if (x >= 3)
        return 0;
    const angle = Math.PI * x;
    return (Math.sin(angle) * Math.sin(angle / 3)) / ((angle * angle) / 3);
}
function* buildAxis(source, target, work) {
    const scale = Math.max(1, source / target), taps = [];
    let remaining = MAX_AXIS_WEIGHTS;
    for (let destination = 0; destination < target; destination++) {
        const center = ((destination + 0.5) * source) / target - 0.5;
        const start = Math.max(0, Math.ceil(center - 3 * scale));
        const end = Math.min(source - 1, Math.floor(center + 3 * scale));
        const length = end - start + 1;
        const weights = length <= remaining ? new Float64Array(length) : undefined;
        if (weights)
            remaining -= length;
        let norm = 0;
        for (let sample = start; sample <= end; sample++) {
            const weight = kernel((sample - center) / scale);
            norm += weight;
            if (weights)
                weights[sample - start] = weight;
            if ((++work.count & 8191) === 0)
                yield;
        }
        taps.push({ start, end, center, norm, weights });
    }
    return { scale, taps };
}
function weightAt(axis, tap, sample) {
    return (tap.weights ? tap.weights[sample - tap.start] : kernel((sample - tap.center) / axis.scale)) / tap.norm;
}
export class LanczosResizer {
    sourceWidth;
    sourceHeight;
    width;
    height;
    first;
    second;
    constructor(sourceWidth, sourceHeight, width, height) {
        this.sourceWidth = sourceWidth;
        this.sourceHeight = sourceHeight;
        this.width = width;
        this.height = height;
    }
    *resize(source) {
        const work = { count: 0 };
        const transposed = this.sourceHeight * this.width > this.sourceWidth * this.height;
        const firstSource = transposed ? this.sourceHeight : this.sourceWidth;
        const secondSource = transposed ? this.sourceWidth : this.sourceHeight;
        const firstTarget = transposed ? this.height : this.width;
        const secondTarget = transposed ? this.width : this.height;
        const sampleStride = transposed ? this.sourceWidth * 4 : 4;
        const rowStride = transposed ? 4 : this.sourceWidth * 4;
        const xAxis = this.first ?? (yield* buildAxis(firstSource, firstTarget, work));
        this.first = xAxis;
        const yAxis = this.second ?? (yield* buildAxis(secondSource, secondTarget, work));
        this.second = yAxis;
        const output = new Uint8ClampedArray(this.width * this.height * 4);
        const rowLength = firstTarget * 4;
        const capacity = Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_ROW_BYTES / (rowLength * 8))));
        const cacheCapacity = yAxis.taps.some(tap => tap.end - tap.start + 1 > capacity)
            ? Math.max(1, capacity - 1)
            : capacity;
        const rows = new Map();
        const accumulated = new Float64Array(rowLength);
        let scratch;
        for (let y = 0; y < secondTarget; y++) {
            accumulated.fill(0);
            const vertical = yAxis.taps[y];
            for (let sy = vertical.start; sy <= vertical.end; sy++) {
                const wy = weightAt(yAxis, vertical, sy);
                if (wy === 0)
                    continue;
                let row = rows.get(sy);
                if (!row) {
                    let retain = true;
                    if (rows.size >= cacheCapacity) {
                        const oldest = rows.keys().next().value;
                        if (oldest < sy) {
                            row = rows.get(oldest);
                            rows.delete(oldest);
                        }
                        else {
                            row = scratch ??= new Float64Array(rowLength);
                            retain = false;
                        }
                        row.fill(0);
                    }
                    else {
                        row = new Float64Array(rowLength);
                    }
                    for (let x = 0; x < firstTarget; x++) {
                        const horizontal = xAxis.taps[x], target = x * 4;
                        let red = 0, green = 0, blue = 0, alpha = 0;
                        for (let sx = horizontal.start; sx <= horizontal.end; sx++) {
                            const index = sy * rowStride + sx * sampleStride;
                            const wa = weightAt(xAxis, horizontal, sx) * source[index + 3];
                            red += source[index] * wa;
                            green += source[index + 1] * wa;
                            blue += source[index + 2] * wa;
                            alpha += wa;
                            if ((++work.count & 8191) === 0)
                                yield;
                        }
                        row[target] = red;
                        row[target + 1] = green;
                        row[target + 2] = blue;
                        row[target + 3] = alpha;
                    }
                    if (retain)
                        rows.set(sy, row);
                }
                for (let i = 0; i < rowLength; i++) {
                    accumulated[i] += row[i] * wy;
                    if ((++work.count & 8191) === 0)
                        yield;
                }
            }
            const offset = y * rowLength;
            for (let i = 0; i < rowLength; i += 4) {
                const alpha = accumulated[i + 3];
                const target = transposed ? i * this.width + y * 4 : offset + i;
                output[target + 3] = Math.round(alpha);
                if (output[target + 3]) {
                    output[target] = Math.round(accumulated[i] / alpha);
                    output[target + 1] = Math.round(accumulated[i + 1] / alpha);
                    output[target + 2] = Math.round(accumulated[i + 2] / alpha);
                }
                if ((++work.count & 8191) === 0)
                    yield;
            }
        }
        return output;
    }
}
