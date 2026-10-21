// Independent image oracle shared by fixture generation (Node) and the studio page (browser): no
// decoder is used here.
export const PATTERN = Object.freeze({ width: 320, height: 240, block: 16 });

/**
 * Opaque block colour; neighbouring blocks differ in every channel so resampling errors are
 * visible.
 */
export function patternColor(blockX, blockY) {
    return [
        (blockX * 37 + blockY * 11) & 255,
        (blockX * 91 + blockY * 53) & 255,
        (blockX * 17 + blockY * 131) & 255,
        255,
    ];
}

/**
 * RGBA bytes of the pattern drawn at any size; block covers block × block pixels and may be
 * fractional.
 */
export function patternRgba(width = PATTERN.width, height = PATTERN.height, block = PATTERN.block) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const color = patternColor(Math.floor(x / block), Math.floor(y / block));
            rgba.set(color, (y * width + x) * 4);
        }
    }
    return rgba;
}

/** FNV-1a over RGBA bytes, as eight hex digits. */
export function hashRgba(rgba) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < rgba.length; index++) {
        hash ^= rgba[index];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** Mean absolute channel difference between two RGBA buffers of the same size, ignoring alpha. */
export function meanAbsoluteDifference(actual, expected) {
    if (actual.length !== expected.length)
        throw new Error(`pixel buffers differ in size: ${actual.length} vs ${expected.length}`);
    let sum = 0;
    let count = 0;
    for (let index = 0; index < actual.length; index += 4) {
        for (let channel = 0; channel < 3; channel++) {
            sum += Math.abs(actual[index + channel] - expected[index + channel]);
            count++;
        }
    }
    return count ? sum / count : 0;
}

/**
 * Where each output pixel of a transformed pattern comes from, computed independently of the
 * library: the stored picture turns clockwise by `upright` degrees, then `crop` (upright pixels), a
 * clockwise `rotate`, `flip` in the rotated orientation and a `fit` resize to width × height.
 * Returns the expected RGBA and a mask of pixels whose source lies in the central half of a block
 * (or inside padding, 2 px away from the picture), where lossy coding and resampling do not reach.
 */
export function transformedPattern({
    sourceWidth = PATTERN.width,
    sourceHeight = PATTERN.height,
    block = PATTERN.block,
    upright = 0,
    crop,
    rotate = 0,
    flip,
    width,
    height,
    fit = 'fill',
}) {
    const turn = degrees => ((degrees % 360) + 360) % 360;
    const swap = degrees => turn(degrees) === 90 || turn(degrees) === 270;
    const uprightWidth = swap(upright) ? sourceHeight : sourceWidth;
    const uprightHeight = swap(upright) ? sourceWidth : sourceHeight;
    const area = crop ?? { x: 0, y: 0, width: uprightWidth, height: uprightHeight };
    const orientedWidth = swap(rotate) ? area.height : area.width;
    const orientedHeight = swap(rotate) ? area.width : area.height;
    const scaleX = fit === 'fill' ? width / orientedWidth : undefined;
    const pick = fit === 'contain' ? Math.min : Math.max;
    const uniform = pick(width / orientedWidth, height / orientedHeight);
    const sx = scaleX ?? uniform;
    const sy = fit === 'fill' ? height / orientedHeight : uniform;
    /**
     * Inverse of a clockwise turn of a w × h picture: a point of the turned picture back to the
     * original.
     */
    const back = (u, v, degrees, w, h) => {
        switch (turn(degrees)) {
            case 90:
                return [v, h - u];
            case 180:
                return [w - u, h - v];
            case 270:
                return [w - v, u];
            default:
                return [u, v];
        }
    };
    const rgba = new Uint8Array(width * height * 4);
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let u = orientedWidth / 2 + (x + 0.5 - width / 2) / sx;
            let v = orientedHeight / 2 + (y + 0.5 - height / 2) / sy;
            const at = y * width + x;
            if (u < 0 || v < 0 || u >= orientedWidth || v >= orientedHeight) {
                rgba.set([0, 0, 0, 255], at * 4);
                const margin = 2 / Math.min(sx, sy);
                mask[at] =
                    u < -margin ||
                    v < -margin ||
                    u >= orientedWidth + margin ||
                    v >= orientedHeight + margin
                        ? 1
                        : 0;
                continue;
            }
            if (flip === 'horizontal' || flip === 'both') u = orientedWidth - u;
            if (flip === 'vertical' || flip === 'both') v = orientedHeight - v;
            const [cx, cy] = back(u, v, rotate, area.width, area.height);
            const [px, py] = back(cx + area.x, cy + area.y, upright, sourceWidth, sourceHeight);
            const blockX = Math.floor(px / block);
            const blockY = Math.floor(py / block);
            rgba.set(patternColor(blockX, blockY), at * 4);
            const inside = value =>
                Math.abs(value / block - Math.floor(value / block) - 0.5) <= 0.25;
            mask[at] = inside(px) && inside(py) ? 1 : 0;
        }
    }
    return { rgba, mask };
}

/** Mean absolute channel difference over the masked pixels of two RGBA buffers. */
export function maskedDifference(actual, expected, mask) {
    if (actual.length !== expected.length || mask.length * 4 !== actual.length)
        throw new Error(
            `pixel buffers differ in size: ${actual.length}, ${expected.length}, mask ` +
                `${mask.length}`,
        );
    let sum = 0;
    let count = 0;
    for (let index = 0; index < mask.length; index++) {
        if (!mask[index]) continue;
        for (let channel = 0; channel < 3; channel++)
            sum += Math.abs(actual[index * 4 + channel] - expected[index * 4 + channel]);
        count += 3;
    }
    if (!count) throw new Error('the comparison mask selects no pixels');
    return sum / count;
}

/**
 * How far a decoded image is from the pattern: `full` averages every pixel, `interior` only the
 * central half of each block, where resampling ringing and lossy compression at block edges do not
 * reach. A wrong geometry, channel order or blank image moves both; edge artefacts of a correct
 * image move only `full`.
 */
export function patternDifference(actual, width, height, block) {
    if (actual.length !== width * height * 4)
        throw new Error(`pixel buffer does not hold ${width}×${height} RGBA`);
    let fullSum = 0;
    let fullCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;
    for (let y = 0; y < height; y++) {
        const blockY = Math.floor(y / block);
        const insideY = Math.abs((y + 0.5) / block - blockY - 0.5) <= 0.25;
        for (let x = 0; x < width; x++) {
            const blockX = Math.floor(x / block);
            const insideX = Math.abs((x + 0.5) / block - blockX - 0.5) <= 0.25;
            const expected = patternColor(blockX, blockY);
            const index = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const difference = Math.abs(actual[index + channel] - expected[channel]);
                fullSum += difference;
                fullCount++;
                if (insideX && insideY) {
                    interiorSum += difference;
                    interiorCount++;
                }
            }
        }
    }
    return {
        full: fullCount ? fullSum / fullCount : 0,
        interior: interiorCount ? interiorSum / interiorCount : 0,
    };
}

/**
 * The oracle for frame `frame` of a clip whose frame n shows the pattern from x = n × step (see
 * SCROLL in ffmpeg.mjs), after the transform settings of transformedPattern. `sourceWidth` ×
 * `sourceHeight` is the stored picture size.
 */
export function scrolledPattern(
    frame,
    { sourceWidth, sourceHeight, step = 16, crop, ...settings },
) {
    const area = crop ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    return transformedPattern({
        ...settings,
        sourceWidth: sourceWidth + step * frame,
        sourceHeight,
        crop: { ...area, x: area.x + step * frame },
    });
}

/**
 * The frame index of a scrolling clip whose oracle is closest to the picture, with its masked
 * difference; only `candidates` are tried when given.
 */
export function identifyScrolledFrame(rgba, frames, settings, candidates) {
    let best = { frame: -1, difference: Infinity };
    for (const frame of candidates ?? Array.from({ length: frames }, (_, index) => index)) {
        if (frame < 0 || frame >= frames) continue;
        const expected = scrolledPattern(frame, settings);
        const difference = maskedDifference(rgba, expected.rgba, expected.mask);
        if (difference < best.difference) best = { frame, difference };
    }
    return { frame: best.frame, difference: Number(best.difference.toFixed(2)) };
}
