const PNG_BYTES_PER_PIXEL = 4;

/** |residual| of a filtered byte read as a signed value; the heuristic sums it per row. */
const MAGNITUDE = Uint8Array.from({ length: 256 }, (_, value) =>
    value < 128 ? value : 256 - value,
);

function paethPredictor(left: number, up: number, upLeft: number): number {
    const leftDistance = Math.abs(up - upLeft);
    const upDistance = Math.abs(left - upLeft);
    const upLeftDistance = Math.abs(left + up - 2 * upLeft);
    return leftDistance <= upDistance && leftDistance <= upLeftDistance
        ? left
        : upDistance <= upLeftDistance
          ? up
          : upLeft;
}

type Bytes = Uint8Array | Uint8ClampedArray;

/**
 * Filters each RGBA row with the type (0-4) whose residuals have the smallest sum of signed
 * magnitudes, the lowest type winning ties; each output row is its type byte followed by the
 * residuals. The first row predicts from an all-zero row above.
 */
export function filterPngRgbaScanlines(
    rgba: Bytes,
    width: number,
    height: number,
): Uint8Array<ArrayBuffer> {
    const rowBytes = width * PNG_BYTES_PER_PIXEL;
    const filtered = new Uint8Array((rowBytes + 1) * height);
    const zeroRow = new Uint8Array(rowBytes);
    const scores = new Float64Array(5);
    for (let y = 0; y < height; y++) {
        const current = y * rowBytes;
        const above = y > 0 ? rgba : zeroRow;
        const aboveOffset = y > 0 ? current - rowBytes : 0;
        rowScores(rgba, current, above, aboveOffset, rowBytes, scores);
        let bestType = 0;
        for (let type = 1; type <= 4; type++)
            if (scores[type]! < scores[bestType]!) bestType = type;
        const out = y * (rowBytes + 1);
        filtered[out] = bestType;
        writeRow(rgba, current, above, aboveOffset, rowBytes, bestType, filtered, out + 1);
    }
    return filtered;
}

function rowScores(
    row: Bytes,
    current: number,
    above: Bytes,
    aboveOffset: number,
    rowBytes: number,
    scores: Float64Array,
): void {
    let none = 0;
    let sub = 0;
    let up = 0;
    let average = 0;
    let paeth = 0;
    const lead = Math.min(PNG_BYTES_PER_PIXEL, rowBytes);
    for (let x = 0; x < lead; x++) {
        const value = row[current + x]!;
        const upper = above[aboveOffset + x]!;
        none += MAGNITUDE[value]!;
        sub += MAGNITUDE[value]!;
        up += MAGNITUDE[(value - upper) & 0xff]!;
        average += MAGNITUDE[(value - (upper >>> 1)) & 0xff]!;
        paeth += MAGNITUDE[(value - paethPredictor(0, upper, 0)) & 0xff]!;
    }
    for (let x = PNG_BYTES_PER_PIXEL; x < rowBytes; x++) {
        const value = row[current + x]!;
        const upper = above[aboveOffset + x]!;
        const left = row[current + x - PNG_BYTES_PER_PIXEL]!;
        const upperLeft = above[aboveOffset + x - PNG_BYTES_PER_PIXEL]!;
        none += MAGNITUDE[value]!;
        sub += MAGNITUDE[(value - left) & 0xff]!;
        up += MAGNITUDE[(value - upper) & 0xff]!;
        average += MAGNITUDE[(value - ((left + upper) >>> 1)) & 0xff]!;
        paeth += MAGNITUDE[(value - paethPredictor(left, upper, upperLeft)) & 0xff]!;
    }
    scores[0] = none;
    scores[1] = sub;
    scores[2] = up;
    scores[3] = average;
    scores[4] = paeth;
}

function writeRow(
    row: Bytes,
    current: number,
    above: Bytes,
    aboveOffset: number,
    rowBytes: number,
    type: number,
    out: Uint8Array,
    at: number,
): void {
    const lead = Math.min(PNG_BYTES_PER_PIXEL, rowBytes);
    switch (type) {
        case 0:
            for (let x = 0; x < rowBytes; x++) out[at + x] = row[current + x]!;
            return;
        case 1:
            for (let x = 0; x < lead; x++) out[at + x] = row[current + x]!;
            for (let x = PNG_BYTES_PER_PIXEL; x < rowBytes; x++)
                out[at + x] = (row[current + x]! - row[current + x - PNG_BYTES_PER_PIXEL]!) & 0xff;
            return;
        case 2:
            for (let x = 0; x < rowBytes; x++)
                out[at + x] = (row[current + x]! - above[aboveOffset + x]!) & 0xff;
            return;
        case 3:
            for (let x = 0; x < lead; x++)
                out[at + x] = (row[current + x]! - (above[aboveOffset + x]! >>> 1)) & 0xff;
            for (let x = PNG_BYTES_PER_PIXEL; x < rowBytes; x++) {
                const left = row[current + x - PNG_BYTES_PER_PIXEL]!;
                out[at + x] = (row[current + x]! - ((left + above[aboveOffset + x]!) >>> 1)) & 0xff;
            }
            return;
        default:
            for (let x = 0; x < lead; x++)
                out[at + x] =
                    (row[current + x]! - paethPredictor(0, above[aboveOffset + x]!, 0)) & 0xff;
            for (let x = PNG_BYTES_PER_PIXEL; x < rowBytes; x++) {
                const predictor = paethPredictor(
                    row[current + x - PNG_BYTES_PER_PIXEL]!,
                    above[aboveOffset + x]!,
                    above[aboveOffset + x - PNG_BYTES_PER_PIXEL]!,
                );
                out[at + x] = (row[current + x]! - predictor) & 0xff;
            }
    }
}
