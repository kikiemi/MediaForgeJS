import type { OptionNormalizer } from '../core/errors/option-policy';
import { clockwise } from './frame-geometry';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from './geometry-settings';

/**
 * The geometry options of the transform stage, as targets, frame extractions and edit clips give
 * them.
 */

const FIT_ALIASES: Readonly<Record<string, VideoFit>> = {
    stretch: 'fill',
    pad: 'contain',
    letterbox: 'contain',
    inside: 'contain',
    crop: 'cover',
    outside: 'cover',
};
const FLIP_ALIASES: Readonly<Record<string, VideoFlip>> = {
    h: 'horizontal',
    x: 'horizontal',
    mirror: 'horizontal',
    v: 'vertical',
    y: 'vertical',
    hv: 'both',
    vh: 'both',
    xy: 'both',
};

function cropOf(normalizer: OptionNormalizer, value: unknown): VideoCrop | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        normalizer.ignore('crop', value, 'is not an object with x, y, width and height');
        return undefined;
    }
    const fields = normalizer.keys(value, ['x', 'y', 'width', 'height'], { left: 'x', top: 'y' });
    const x = normalizer.number('crop.x', fields.x ?? 0, { integer: true, min: 0 });
    const y = normalizer.number('crop.y', fields.y ?? 0, { integer: true, min: 0 });
    const width = normalizer.number('crop.width', fields.width, { integer: true, positive: true });
    const height = normalizer.number('crop.height', fields.height, {
        integer: true,
        positive: true,
    });
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
        normalizer.note(
            'OPTION_IGNORED',
            'crop',
            'crop needs a positive width and height and was ignored',
        );
        return undefined;
    }
    return { x, y, width, height };
}

function rotationOf(normalizer: OptionNormalizer, value: unknown): VideoRotation | undefined {
    const degrees = normalizer.number('rotate', value);
    if (degrees === undefined) return undefined;
    const snapped = clockwise(degrees);
    if (snapped !== degrees)
        normalizer.note('OPTION_NORMALIZED', 'rotate', `rotate ${degrees} was read as ${snapped}`);
    return snapped;
}

/**
 * Crop, rotation, flip and fit of a target or frame extraction; unusable values are repaired or
 * dropped, and fit is dropped unless `sized` says both width and height are set.
 */
export function snapshotVideoGeometry(
    normalizer: OptionNormalizer,
    raw: {
        readonly crop?: unknown;
        readonly rotate?: unknown;
        readonly flip?: unknown;
        readonly fit?: unknown;
    },
    sized: boolean,
): { crop?: VideoCrop; rotate?: VideoRotation; flip?: VideoFlip; fit?: VideoFit } {
    let fit = normalizer.choice('fit', raw.fit, ['fill', 'contain', 'cover'], {
        optional: true,
        aliases: FIT_ALIASES,
    });
    if (fit !== undefined && !sized) {
        normalizer.ignore('fit', fit, 'applies when both width and height are set');
        fit = undefined;
    }
    return {
        crop: cropOf(normalizer, raw.crop),
        rotate: rotationOf(normalizer, raw.rotate),
        flip: normalizer.choice('flip', raw.flip, ['horizontal', 'vertical', 'both'], {
            optional: true,
            aliases: FLIP_ALIASES,
        }),
        fit,
    };
}
