import type { ImageFitMode } from '../types/media.js';
export declare function isImageFitMode(value: unknown): value is ImageFitMode;
export declare function resolveTargetDimensions(srcW: number, srcH: number, requested: {
    width?: number;
    height?: number;
    imageFit?: ImageFitMode;
}): {
    w: number;
    h: number;
};
