import { micros } from '../codecs/webcodecs/codec';
import { planarToRgba, yuvMatrix } from '../codecs/shared/yuv-rgba';
import { isIdentityGeometry, type VideoGeometry } from './frame-geometry';
import { VideoFrameTransformer, needsRgb, type FramePainter } from './frame-transform';
import { backgroundRgba, transformRgbaRegion } from './rgba-transform';
import type {
    EmitPicture,
    VideoPicture,
    VideoStage,
    VideoStreamInfo,
} from '../core/contracts/stage';
import { Picture, pictureOf, planarVideoFrame } from './picture';

interface TransformOptions {
    /**
     * The CSS colour of the padding of contained pictures and of what fades reveal; default black.
     */
    readonly background?: string;
    /** Canvas readback is frequent, as for RGBA picture output. */
    readonly readable?: boolean;
    /** What to draw over the picture shown at a time in seconds; undefined leaves it untouched. */
    readonly paint?: (timestamp: number) => FramePainter | undefined;
    /**
     * The geometry for a picture whose size differs from the geometry's source, with the same
     * output.
     */
    readonly resolve?: (width: number, height: number) => VideoGeometry;
}

/** Crop region of straight RGBA `data` (width × height pixels), copied row by row. */
function cropRgba(data: Uint8Array, width: number, geometry: VideoGeometry): Uint8ClampedArray {
    const { region } = geometry;
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    if (region.x === 0 && region.y === 0 && region.width === width)
        return pixels.subarray(0, width * region.height * 4);
    const cropped = new Uint8ClampedArray(region.width * region.height * 4);
    for (let row = 0; row < region.height; row++) {
        const from = ((region.y + row) * width + region.x) * 4;
        cropped.set(pixels.subarray(from, from + region.width * 4), row * region.width * 4);
    }
    return cropped;
}

/**
 * Whether a host frame shows its visible pixels one to one, so its RGBA can be transformed without
 * a canvas.
 */
function squarePixels(frame: VideoFrame): boolean {
    const visible = frame.visibleRect;
    return (
        !visible || (visible.width === frame.displayWidth && visible.height === frame.displayHeight)
    );
}

/**
 * Crop, rotation, flips, resize and padding of one geometry, with an optional painter over the
 * result. Host frames pass through untouched, become zero-copy crops or are drawn once on a reused
 * canvas (without a canvas their RGBA is transformed on the CPU); built-in decoder planes and RGBA
 * pictures are transformed on the CPU, converting only the cropped region.
 */
export function transformStage(
    geometry: VideoGeometry,
    options: TransformOptions = {},
): VideoStage {
    const transformer = new VideoFrameTransformer(
        geometry,
        options.readable === true,
        options.background,
    );
    const geometries = new Map<string, VideoGeometry>();
    const transformers = new Map<VideoGeometry, VideoFrameTransformer>([[geometry, transformer]]);
    const geometryFor = (width: number, height: number): VideoGeometry => {
        if (
            (width === geometry.sourceWidth && height === geometry.sourceHeight) ||
            !options.resolve
        )
            return geometry;
        const key = `${width}x${height}`;
        let resolved = geometries.get(key);
        if (!resolved) geometries.set(key, (resolved = options.resolve(width, height)));
        return resolved;
    };
    /**
     * The canvas transform of a host frame's own size: pictures of another size get their own
     * geometry.
     */
    const transformerFor = (frame: VideoFrame): VideoFrameTransformer => {
        const own = geometryFor(frame.displayWidth, frame.displayHeight);
        let found = transformers.get(own);
        if (!found)
            transformers.set(
                own,
                (found = new VideoFrameTransformer(
                    own,
                    options.readable === true,
                    options.background,
                )),
            );
        return found;
    };
    let padding: Uint8Array | undefined;
    const drawFrame = (
        picture: Picture,
        frame: VideoFrame,
        owned: boolean,
        paint: FramePainter | undefined,
        emit: EmitPicture,
    ): void => {
        const transformer = transformerFor(frame);
        const toSdr = picture.data.kind === 'frame' ? picture.data.toSdr : undefined;
        let output: VideoFrame;
        try {
            output = transformer.apply(
                frame,
                micros(picture.timestamp),
                micros(picture.duration),
                paint,
                toSdr,
            );
        } catch (error) {
            if (owned) frame.close();
            throw error;
        }
        if (output === frame && !owned) return emit(picture);
        if (!owned || output !== frame) picture.close();
        if (owned && output !== frame) frame.close();
        // A retimed frame or a view of it keeps the source's colour, so HDR is still reported when
        // it becomes RGBA (hosts such as Firefox output frames without a duration, which retimes
        // every one); a drawn frame is SDR already.
        emit(
            new Picture(
                { kind: 'frame', frame: output, toSdr },
                picture.timestamp,
                picture.duration,
                transformer.readback(),
            ),
        );
    };
    return {
        type: 'video',
        name: 'transform',
        configure: (input: VideoStreamInfo) => ({
            ...input,
            width: geometry.width,
            height: geometry.height,
        }),
        async process(input: VideoPicture, emit: EmitPicture): Promise<void> {
            const picture = pictureOf(input);
            const { data } = picture;
            const paint = options.paint?.(picture.timestamp);

            // Turns, mirrors and chroma-aligned crops of 4:2:0 frames move samples on the planes:
            // exact, in the frame's own colour and depth, with no canvas round trip through RGB.
            if (data.kind === 'frame' && !paint) {
                const transformer = transformerFor(data.frame);
                if (transformer.orients(data.frame)) {
                    let oriented: VideoFrame;
                    try {
                        oriented = await transformer.orient(
                            data.frame,
                            micros(picture.timestamp),
                            micros(picture.duration),
                        );
                    } finally {
                        picture.close();
                    }
                    return emit(
                        new Picture(
                            { kind: 'frame', frame: oriented, toSdr: data.toSdr },
                            picture.timestamp,
                            picture.duration,
                        ),
                    );
                }
            }
            if (
                data.kind === 'frame' &&
                (typeof OffscreenCanvas === 'function' ||
                    paint ||
                    !squarePixels(data.frame) ||
                    transformerFor(data.frame).drawsNothing(data.frame))
            )
                return drawFrame(picture, data.frame, false, paint, emit);
            if (paint && data.kind === 'planar') {
                const frame = planarVideoFrame(
                    data.planar,
                    micros(picture.timestamp),
                    micros(picture.duration),
                );
                return drawFrame(picture, frame, true, paint, emit);
            }
            const own = geometryFor(picture.width, picture.height);

            // Host frames in 4:2:2 or 4:4:4 become RGBA even unchanged, since encoders take 4:2:0
            // or RGB.
            if (isIdentityGeometry(own) && !(data.kind === 'frame' && needsRgb(data.frame)))
                return emit(picture);
            let region: Uint8ClampedArray;
            if (data.kind === 'planar') {
                const { planar } = data;
                const rect = planar.visibleRect;
                region = planarToRgba(
                    planar,
                    {
                        x: rect.x + own.region.x,
                        y: rect.y + own.region.y,
                        width: own.region.width,
                        height: own.region.height,
                    },
                    yuvMatrix(planar.colorSpace?.matrix, rect.width, rect.height),
                    planar.colorSpace?.fullRange === true,
                );
            } else if (data.kind === 'frame') {
                try {
                    region = cropRgba(await picture.rgba(), picture.width, own);
                } catch (error) {
                    picture.close();
                    throw error;
                }
            } else region = cropRgba(data.data, data.width, own);
            const output = transformRgbaRegion(
                region,
                own,
                (padding ??= backgroundRgba(options.background)),
            );
            picture.close();
            emit(
                new Picture(
                    {
                        kind: 'rgba',
                        data: new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
                        width: own.width,
                        height: own.height,
                    },
                    picture.timestamp,
                    picture.duration,
                ),
            );
        },
    };
}

/**
 * Resamples pictures onto a constant rate: each slot shows the latest picture that starts at or
 * before it, or less than a quarter slot after it (which absorbs rounded timestamps), so pictures
 * are dropped or repeated as the source rate demands. A picture that asks for a keyframe asks for
 * it on its first slot. The grid starts at the first picture; the stream ends at `end` seconds when
 * given (the slots that start before it), else one slot after the last picture or at its end,
 * whichever is later.
 */
export function frameRateStage(fps: number, end?: number): VideoStage {
    const stepUs = 1e6 / fps;
    const toleranceUs = stepUs / 4;
    let held: Picture | undefined;
    let shown = false;
    let nextUs = Number.NEGATIVE_INFINITY;
    let lastEndUs = 0;
    let lastStartUs = Number.NEGATIVE_INFINITY;

    /** Emits the held picture on every slot before `limitUs`. */
    const slots = (limitUs: number, emit: EmitPicture): void => {
        while (held && nextUs < limitUs) {
            const timestamp = Math.round(nextUs);
            emit(held.shownAt(timestamp / 1e6, Math.round(stepUs) / 1e6, held.keyframe && !shown));
            shown = true;
            nextUs += stepUs;
        }
    };

    return {
        type: 'video',
        name: 'fps',
        configure: input => ({ ...input, fps }),
        process(input, emit) {
            const picture = pictureOf(input);
            const startUs = micros(picture.timestamp);
            if (nextUs === Number.NEGATIVE_INFINITY) nextUs = startUs;
            slots(startUs - toleranceUs, emit);
            held?.close();
            held = picture;
            shown = false;
            lastStartUs = startUs;
            lastEndUs = Math.max(lastEndUs, startUs + micros(picture.duration));
        },
        flush(emit) {
            const endUs =
                end !== undefined ? micros(end) : Math.max(lastEndUs, lastStartUs + stepUs);
            slots(endUs - toleranceUs, emit);
            held?.close();
            held = undefined;
        },
        close() {
            held?.close();
            held = undefined;
        },
    };
}
