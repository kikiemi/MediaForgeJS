// The geometry settings targets, frame extractions and edit clips take, apart from the code
// that resolves them (frame-geometry).

/** Rectangle in pixels of the upright source picture, before rotate, flip and resize. */
export interface VideoCrop {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * fill stretches to width × height; contain fits inside and pads with black; cover fills and crops
 * the overflow.
 */
export type VideoFit = 'fill' | 'contain' | 'cover';

/** Clockwise degrees. */
export type VideoRotation = 0 | 90 | 180 | 270;

/** Mirrors the rotated picture: horizontal swaps left and right, vertical swaps top and bottom. */
export type VideoFlip = 'horizontal' | 'vertical' | 'both';
