const PNG_BYTES_PER_PIXEL = 4;
function paethPredictor(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance)
        return left;
    if (upDistance <= upLeftDistance)
        return up;
    return upLeft;
}
function signedByteMagnitude(value) {
    return value < 128 ? value : 256 - value;
}
export function filterPngRgbaScanlines(rgba, width, height) {
    const rowBytes = width * PNG_BYTES_PER_PIXEL;
    const filtered = new Uint8Array((rowBytes + 1) * height);
    const candidate = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
        const sourceOffset = y * rowBytes;
        const previousOffset = sourceOffset - rowBytes;
        const filteredOffset = y * (rowBytes + 1);
        let bestType = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let type = 0; type <= 4 && bestScore > 0; type++) {
            let score = 0;
            let complete = true;
            for (let x = 0; x < rowBytes; x++) {
                const value = rgba[sourceOffset + x];
                let predictor = 0;
                if (type === 1) {
                    predictor = x >= PNG_BYTES_PER_PIXEL ? rgba[sourceOffset + x - PNG_BYTES_PER_PIXEL] : 0;
                }
                else if (type === 2) {
                    predictor = y > 0 ? rgba[previousOffset + x] : 0;
                }
                else if (type === 3) {
                    const left = x >= PNG_BYTES_PER_PIXEL ? rgba[sourceOffset + x - PNG_BYTES_PER_PIXEL] : 0;
                    const up = y > 0 ? rgba[previousOffset + x] : 0;
                    predictor = (left + up) >>> 1;
                }
                else if (type === 4) {
                    const left = x >= PNG_BYTES_PER_PIXEL ? rgba[sourceOffset + x - PNG_BYTES_PER_PIXEL] : 0;
                    const up = y > 0 ? rgba[previousOffset + x] : 0;
                    const upLeft = y > 0 && x >= PNG_BYTES_PER_PIXEL ? rgba[previousOffset + x - PNG_BYTES_PER_PIXEL] : 0;
                    predictor = paethPredictor(left, up, upLeft);
                }
                const residual = (value - predictor) & 0xff;
                candidate[x] = residual;
                score += signedByteMagnitude(residual);
                if (score >= bestScore) {
                    complete = false;
                    break;
                }
            }
            if (complete && score < bestScore) {
                bestType = type;
                bestScore = score;
                filtered.set(candidate, filteredOffset + 1);
            }
        }
        filtered[filteredOffset] = bestType;
    }
    return filtered;
}
