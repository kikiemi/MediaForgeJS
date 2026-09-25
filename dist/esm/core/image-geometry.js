import { MediaForgeError } from './errors.js';
export function isImageFitMode(value) {
    return value === 'fill' || value === 'inside' || value === 'scale-down';
}
export function resolveTargetDimensions(srcW, srcH, requested) {
    if (!Number.isSafeInteger(srcW) || srcW <= 0 || !Number.isSafeInteger(srcH) || srcH <= 0) {
        throw new MediaForgeError('source image dimensions must be positive safe integers', 'FORMAT');
    }
    const { imageFit } = requested;
    let { width: cw, height: ch } = requested;
    for (const value of [cw, ch]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 16384)) {
            throw new MediaForgeError('requested image dimensions must be positive integers <= 16384', 'FORMAT');
        }
    }
    if (imageFit !== undefined && !isImageFitMode(imageFit)) {
        throw new MediaForgeError('imageFit must be fill, inside or scale-down', 'FORMAT');
    }
    if (imageFit === 'scale-down') {
        if (cw !== undefined)
            cw = Math.min(cw, srcW);
        if (ch !== undefined)
            ch = Math.min(ch, srcH);
    }
    const validated = (w, h) => {
        if (w > 16384 || h > 16384 || w * h > 8192 * 4320) {
            throw new MediaForgeError(`computed output size ${w}×${h} exceeds the supported budget ` +
                '(each side <= 16384, total pixels <= 8192×4320); ' +
                'specify both width and height to control the result', 'FORMAT');
        }
        return { w, h };
    };
    if (cw !== undefined && ch !== undefined) {
        if (imageFit === 'inside' || imageFit === 'scale-down') {
            return cw / srcW <= ch / srcH
                ? validated(cw, Math.min(ch, Math.max(1, Math.round((cw * srcH) / srcW))))
                : validated(Math.min(cw, Math.max(1, Math.round((ch * srcW) / srcH))), ch);
        }
        return validated(cw, ch);
    }
    if (cw !== undefined)
        return validated(cw, Math.max(1, Math.round((cw * srcH) / srcW)));
    if (ch !== undefined)
        return validated(Math.max(1, Math.round((ch * srcW) / srcH)), ch);
    return validated(srcW, srcH);
}
