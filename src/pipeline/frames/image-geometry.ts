import { MediaForgeError } from '../../core/errors/errors';
import { assertPixels } from '../../codecs/image/rgba-image';

function isImageFitMode(value: unknown): value is ImageFitMode {
    return value === 'fill' || value === 'inside' || value === 'scale-down';
}

/**
 * A computed output size: past 16384 pixels a side is FORMAT, past 8192×4320 pixels in all OOM, the
 * code of every size limit.
 */
function checkedOutputSize(w: number, h: number): { w: number; h: number } {
    if (w > 16384 || h > 16384) {
        throw new MediaForgeError(`Output size ${w}×${h} is too large`, 'FORMAT', {
            hint: 'Set both width and height.',
        });
    }
    assertPixels('Output size', w, h);
    return { w, h };
}

export function resolveTargetDimensions(
    srcW: number,
    srcH: number,
    requested: { width?: number; height?: number; imageFit?: ImageFitMode },
): { w: number; h: number } {
    if (!Number.isSafeInteger(srcW) || srcW <= 0 || !Number.isSafeInteger(srcH) || srcH <= 0) {
        throw new MediaForgeError(
            'source image dimensions must be positive safe integers',
            'FORMAT',
        );
    }

    const { imageFit } = requested;
    let { width: cw, height: ch } = requested;
    for (const value of [cw, ch]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 16384)) {
            throw new MediaForgeError(
                'requested image dimensions must be positive integers <= 16384',
                'FORMAT',
            );
        }
    }
    if (imageFit !== undefined && !isImageFitMode(imageFit)) {
        throw new MediaForgeError('imageFit must be fill, inside or scale-down', 'FORMAT');
    }

    if (imageFit === 'scale-down') {
        if (cw !== undefined) cw = Math.min(cw, srcW);
        if (ch !== undefined) ch = Math.min(ch, srcH);
    }

    if (cw !== undefined && ch !== undefined) {
        if (imageFit === 'inside' || imageFit === 'scale-down') {
            return cw / srcW <= ch / srcH
                ? checkedOutputSize(cw, Math.min(ch, Math.max(1, Math.round((cw * srcH) / srcW))))
                : checkedOutputSize(Math.min(cw, Math.max(1, Math.round((ch * srcW) / srcH))), ch);
        }
        return checkedOutputSize(cw, ch);
    }

    if (cw !== undefined) return checkedOutputSize(cw, Math.max(1, Math.round((cw * srcH) / srcW)));
    if (ch !== undefined) return checkedOutputSize(Math.max(1, Math.round((ch * srcW) / srcH)), ch);
    return checkedOutputSize(srcW, srcH);
}

export type ImageFitMode = 'fill' | 'inside' | 'scale-down';
