import { MediaForgeError } from '../core/errors.js';
function gcd(a, b) {
    while (b !== 0n)
        [a, b] = [b, a % b];
    return a;
}
function ratio(width, height) {
    const divisor = gcd(width, height);
    width /= divisor;
    height /= divisor;
    if (width > BigInt(Number.MAX_SAFE_INTEGER) || height > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MediaForgeError('Matroska display aspect ratio exceeds the safe integer range', 'FORMAT');
    }
    return { width: Number(width), height: Number(height), unit: 3 };
}
function exactFraction(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent === 0 ? 0n : 1n << 52n);
    const shift = exponent === 0 ? -1074 : exponent - 1075;
    return shift >= 0 ? [mantissa << BigInt(shift), 1n] : [mantissa, 1n << BigInt(-shift)];
}
export function normalizeMatroskaDisplay(video) {
    const { width, height, displayWidth, displayHeight, pixelAspectRatioNum, pixelAspectRatioDen } = video;
    for (const [name, value] of [
        ['width', width],
        ['height', height],
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new MediaForgeError(`Matroska video ${name} must be a positive safe integer`, 'FORMAT');
        }
    }
    for (const [name, value] of [
        ['displayWidth', displayWidth],
        ['displayHeight', displayHeight],
    ]) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)) {
            throw new MediaForgeError(`Matroska video ${name} must be finite, positive and within the safe integer range`, 'FORMAT');
        }
    }
    for (const value of [pixelAspectRatioNum, pixelAspectRatioDen]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
            throw new MediaForgeError('Matroska pixel aspect ratio components must be positive safe integers', 'FORMAT');
        }
    }
    if ((pixelAspectRatioNum === undefined) !== (pixelAspectRatioDen === undefined)) {
        throw new MediaForgeError('Matroska pixel aspect ratio requires both numerator and denominator', 'FORMAT');
    }
    const hasDisplay = displayWidth !== undefined || displayHeight !== undefined;
    const dw = displayWidth ?? width;
    const dh = displayHeight ?? height;
    if (hasDisplay && Number.isSafeInteger(dw) && Number.isSafeInteger(dh)) {
        return { width: dw, height: dh, unit: 0 };
    }
    if (pixelAspectRatioNum !== undefined && pixelAspectRatioDen !== undefined) {
        const num = BigInt(width) * BigInt(pixelAspectRatioNum);
        const den = BigInt(height) * BigInt(pixelAspectRatioDen);
        const aspect = Number(num) / Number(den);
        if (!hasDisplay || Math.abs(dw - dh * aspect) <= (1 + aspect) / 65536) {
            if (!hasDisplay && pixelAspectRatioNum === pixelAspectRatioDen)
                return undefined;
            if (!hasDisplay &&
                num % BigInt(pixelAspectRatioDen) === 0n &&
                num / BigInt(pixelAspectRatioDen) <= BigInt(Number.MAX_SAFE_INTEGER)) {
                return { width: Number(num / BigInt(pixelAspectRatioDen)), height, unit: 0 };
            }
            return ratio(num, den);
        }
    }
    if (!hasDisplay)
        return undefined;
    const [wn, wd] = exactFraction(dw);
    const [hn, hd] = exactFraction(dh);
    return ratio(wn * hd, hn * wd);
}
