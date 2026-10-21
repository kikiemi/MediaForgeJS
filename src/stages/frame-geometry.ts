import type { VideoRect } from '../codecs/shared/yuv-rgba';
import { MediaForgeError } from '../core/errors/errors';
import { assertPixels } from '../codecs/image/rgba-image';
import type { OptionNormalizer } from '../core/errors/option-policy';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from './geometry-settings';

interface VideoTransformSettings {
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
}

/**
 * A resolved pixel transform from a stored picture to the output: the source rotation makes it
 * upright, then the crop, the clockwise rotation, the flips in output orientation and the resize
 * apply in that order.
 */
export interface VideoGeometry {
    /** Stored picture size, before any rotation. */
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly width: number;
    readonly height: number;
    /** Region of the stored picture that is drawn. */
    readonly region: VideoRect;
    /** Where the region lands in the output; smaller than the output when contain pads it. */
    readonly target: VideoRect;
    /** Total clockwise rotation from the stored picture to the output. */
    readonly rotation: VideoRotation;
    readonly flipX: boolean;
    readonly flipY: boolean;
}

const ROTATIONS: readonly VideoRotation[] = [0, 90, 180, 270];

/** Clockwise rotation for any multiple of 90 degrees, including negative values. */
export function clockwise(degrees: number): VideoRotation {
    return ROTATIONS[((Math.round(degrees / 90) % 4) + 4) % 4]!;
}

/**
 * Clockwise rotation that makes a stored picture upright from its counter-clockwise display
 * rotation.
 */
export function uprightRotation(displayRotation: number | undefined): VideoRotation {
    return clockwise(-(displayRotation ?? 0));
}

const turned = (rotation: VideoRotation): boolean => rotation === 90 || rotation === 270;

function even(value: number): number {
    return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Maps a rectangle of the picture rotated clockwise by `rotation` back onto the unrotated picture.
 */
function unrotate(
    rect: VideoRect,
    rotation: VideoRotation,
    width: number,
    height: number,
): VideoRect {
    switch (rotation) {
        case 90:
            return {
                x: rect.y,
                y: height - rect.x - rect.width,
                width: rect.height,
                height: rect.width,
            };
        case 180:
            return {
                x: width - rect.x - rect.width,
                y: height - rect.y - rect.height,
                ...size(rect),
            };
        case 270:
            return {
                x: width - rect.y - rect.height,
                y: rect.x,
                width: rect.height,
                height: rect.width,
            };
        default:
            return rect;
    }
}

function size(rect: VideoRect): { width: number; height: number } {
    return { width: rect.width, height: rect.height };
}

/**
 * Width over height of a stored pixel on display, or undefined for square pixels and unknown
 * ratios.
 */
export function pixelAspectOf(info: {
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
}): number | undefined {
    const { pixelAspectRatioNum: num, pixelAspectRatioDen: den } = info;
    if (!num || !den || !Number.isFinite(num / den) || num === den) return undefined;
    return num / den;
}

/** A crop rounded to whole pixels and clamped into the upright picture, at least 1 × 1. */
function clampCrop(crop: VideoCrop, width: number, height: number): VideoRect {
    const x = Math.min(Math.max(0, Math.round(crop.x)), width - 1);
    const y = Math.min(Math.max(0, Math.round(crop.y)), height - 1);
    return {
        x,
        y,
        width: Math.min(Math.max(1, Math.round(crop.width)), width - x),
        height: Math.min(Math.max(1, Math.round(crop.height)), height - y),
    };
}

/**
 * Resolves settings against one stored picture. `evenOutput` rounds the output to even sides for
 * 4:2:0 encoders; without a resize an odd side is trimmed from the crop so pixels stay one to one.
 * A source with non-square pixels (`pixelAspect`, width over height of a stored pixel) is shown at
 * its display shape: sizes, fits and an output without a resize follow the displayed picture in
 * square pixels, while the crop stays in stored pixels. Every repair is noted on `normalizer`,
 * which throws under the strict policy.
 */
export function resolveVideoGeometry(
    source: {
        readonly width: number;
        readonly height: number;
        readonly rotation?: VideoRotation;
        readonly pixelAspect?: number;
    },
    settings: VideoTransformSettings,
    normalizer: OptionNormalizer,
    evenOutput: boolean,
): VideoGeometry {
    const { width: sourceWidth, height: sourceHeight } = source;
    if (
        !Number.isSafeInteger(sourceWidth) ||
        !Number.isSafeInteger(sourceHeight) ||
        sourceWidth < 1 ||
        sourceHeight < 1
    )
        throw new MediaForgeError('Video transforms need the source picture size', 'FORMAT');

    const sourceRotation = source.rotation ?? 0;
    const pixelAspect =
        source.pixelAspect !== undefined &&
        Number.isFinite(source.pixelAspect) &&
        source.pixelAspect > 0
            ? source.pixelAspect
            : 1;
    // Display scale of the upright picture's pixels: non-square pixels stretch the stored
    // horizontal axis.
    const stretchX = turned(sourceRotation) ? 1 : pixelAspect;
    const stretchY = turned(sourceRotation) ? pixelAspect : 1;
    const uprightWidth = turned(sourceRotation) ? sourceHeight : sourceWidth;
    const uprightHeight = turned(sourceRotation) ? sourceWidth : sourceHeight;
    let crop: VideoRect = { x: 0, y: 0, width: uprightWidth, height: uprightHeight };
    if (settings.crop) {
        crop = clampCrop(settings.crop, uprightWidth, uprightHeight);
        const requested = settings.crop;
        if (
            crop.x !== requested.x ||
            crop.y !== requested.y ||
            crop.width !== requested.width ||
            crop.height !== requested.height
        )
            normalizer.note(
                'OPTION_NORMALIZED',
                'crop',
                `crop was clamped to ${crop.width}×${crop.height} at ${crop.x},${crop.y}`,
            );
    }

    const rotate = settings.rotate ?? 0;
    const flip = settings.flip;
    const requestedWidth = settings.width;
    const requestedHeight = settings.height;
    let width: number;
    let height: number;
    /** The crop as displayed, in square pixels, after the rotation. */
    const turnedCrop = (): { width: number; height: number } => {
        const shown = { width: crop.width * stretchX, height: crop.height * stretchY };
        return turned(rotate) ? { width: shown.height, height: shown.width } : shown;
    };
    const round = (value: number): number =>
        evenOutput ? even(value) : Math.max(1, Math.round(value));

    if (requestedWidth === undefined && requestedHeight === undefined && pixelAspect !== 1) {
        const shape = turnedCrop();
        width = round(shape.width);
        height = round(shape.height);
    } else if (requestedWidth === undefined && requestedHeight === undefined) {
        if (evenOutput && (crop.width % 2 !== 0 || crop.height % 2 !== 0)) {
            if (crop.width < 2 || crop.height < 2)
                throw new MediaForgeError('Video output needs at least 2 × 2 pixels', 'FORMAT');
            const trimmed = { ...crop, width: crop.width & ~1, height: crop.height & ~1 };
            normalizer.note(
                'OPTION_NORMALIZED',
                'crop',
                `crop was trimmed to ${trimmed.width}×${trimmed.height} for even sides`,
            );
            crop = trimmed;
        }
        ({ width, height } = turnedCrop());
    } else {
        const shape = turnedCrop();
        width = requestedWidth ?? round((requestedHeight! * shape.width) / shape.height);
        height = requestedHeight ?? round((requestedWidth! * shape.height) / shape.width);
        for (const [option, value] of [
            ['width', width],
            ['height', height],
        ] as const) {
            if (
                evenOutput &&
                value % 2 !== 0 &&
                (option === 'width' ? requestedWidth : requestedHeight) !== undefined
            ) {
                const rounded = even(value);
                normalizer.note(
                    'OPTION_NORMALIZED',
                    option,
                    `${option} ${value} was rounded to the even ${rounded}`,
                );
                if (option === 'width') width = rounded;
                else height = rounded;
            }
        }
    }

    if (width > 16384 || height > 16384)
        throw new MediaForgeError(`Video output ${width}×${height} is too large`, 'FORMAT', {
            hint: 'Keep each side within 16384.',
        });
    // More pixels than 8192×4320 is a size limit: OOM, as for still pictures.
    assertPixels('Video output', width, height);

    let target: VideoRect = { x: 0, y: 0, width, height };
    const fit =
        requestedWidth !== undefined && requestedHeight !== undefined
            ? (settings.fit ?? 'fill')
            : 'fill';
    const shape = turnedCrop();
    if (fit === 'contain') {
        const scale = Math.min(width / shape.width, height / shape.height);
        const drawnWidth = Math.min(width, Math.max(1, Math.round(shape.width * scale)));
        const drawnHeight = Math.min(height, Math.max(1, Math.round(shape.height * scale)));
        target = {
            x: Math.floor((width - drawnWidth) / 2),
            y: Math.floor((height - drawnHeight) / 2),
            width: drawnWidth,
            height: drawnHeight,
        };
    } else if (fit === 'cover') {
        const scale = Math.max(width / shape.width, height / shape.height);
        // The kept part in display units, turned back and returned to stored pixels.
        const keptWidth = Math.min(shape.width, width / scale);
        const keptHeight = Math.min(shape.height, height / scale);
        const shown = turned(rotate)
            ? { width: keptHeight, height: keptWidth }
            : { width: keptWidth, height: keptHeight };
        const kept = {
            width: Math.min(crop.width, Math.max(1, Math.round(shown.width / stretchX))),
            height: Math.min(crop.height, Math.max(1, Math.round(shown.height / stretchY))),
        };
        crop = {
            x: crop.x + Math.floor((crop.width - kept.width) / 2),
            y: crop.y + Math.floor((crop.height - kept.height) / 2),
            ...kept,
        };
    }

    return {
        sourceWidth,
        sourceHeight,
        width,
        height,
        region: unrotate(crop, sourceRotation, sourceWidth, sourceHeight),
        target,
        rotation: clockwise(sourceRotation + rotate),
        flipX: flip === 'horizontal' || flip === 'both',
        flipY: flip === 'vertical' || flip === 'both',
    };
}

/** True when the output is the stored picture unchanged. */
export function isIdentityGeometry(geometry: VideoGeometry): boolean {
    const { region, target } = geometry;
    return (
        geometry.rotation === 0 &&
        !geometry.flipX &&
        !geometry.flipY &&
        region.x === 0 &&
        region.y === 0 &&
        region.width === geometry.sourceWidth &&
        region.height === geometry.sourceHeight &&
        target.width === geometry.width &&
        target.height === geometry.height &&
        geometry.width === geometry.sourceWidth &&
        geometry.height === geometry.sourceHeight
    );
}

/**
 * True when the output is a region of the stored picture at its own size, which a visible rectangle
 * can express.
 */
export function isCropOnlyGeometry(geometry: VideoGeometry): boolean {
    const { region, target } = geometry;
    return (
        geometry.rotation === 0 &&
        !geometry.flipX &&
        !geometry.flipY &&
        target.x === 0 &&
        target.y === 0 &&
        target.width === geometry.width &&
        target.height === geometry.height &&
        region.width === geometry.width &&
        region.height === geometry.height
    );
}
