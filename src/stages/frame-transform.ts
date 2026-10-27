import { MediaForgeError } from '../core/errors/errors';
import type { VideoGeometry } from './frame-geometry';
import type { VideoRect } from '../codecs/shared/yuv-rgba';
import { isCropOnlyGeometry, isIdentityGeometry } from './frame-geometry';
import { isHdrFrame } from './picture';

/** Chroma sample sizes a visible rectangle must align to. */
function chromaAlignment(format: string | null): { x: number; y: number } | undefined {
    if (!format) return undefined;
    if (/^(I420|NV12)/.test(format)) return { x: 2, y: 2 };
    if (format.startsWith('I422')) return { x: 2, y: 1 };
    if (format.startsWith('I444') || /^(RGB|BGR)/.test(format)) return { x: 1, y: 1 };
    return undefined;
}

/**
 * Whether a host frame becomes RGB even where its geometry changes nothing: 4:2:2 and 4:4:4 frames,
 * since encoders take 4:2:0 or RGB.
 */
export function needsRgb(frame: VideoFrame): boolean {
    return /^I4(22|44)/.test(frame.format ?? '');
}

/** 4:2:0 formats whose planes are turned and mirrored as they are, and their sample sizes. */
const ORIENTED_FORMATS: Readonly<
    Record<string, { readonly unit: number; readonly nv12: boolean }>
> = {
    I420: { unit: 1, nv12: false },
    I420P10: { unit: 2, nv12: false },
    I420P12: { unit: 2, nv12: false },
    NV12: { unit: 1, nv12: true },
};

/** Source column and row of output sample (x, y) of a `width` × `height` plane turned clockwise. */
function turnedSource(
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number,
): [number, number] {
    if (rotation === 90) return [y, height - 1 - x];
    if (rotation === 180) return [width - 1 - x, height - 1 - y];
    if (rotation === 270) return [width - 1 - y, x];
    return [x, y];
}

/**
 * Copies a `width` × `height` plane of `unit`-byte samples into `output`, turned clockwise by
 * `rotation` and then mirrored in the output orientation, as the canvas transform draws it.
 */
function orientPlane(
    input: Uint8Array,
    plane: PlaneLayout,
    size: { readonly width: number; readonly height: number },
    unit: number,
    geometry: VideoGeometry,
    output: Uint8Array,
    outputOffset: number,
): void {
    const { width, height } = size;
    const { rotation, flipX, flipY } = geometry;
    const turned = rotation === 90 || rotation === 270;
    const outWidth = turned ? height : width;
    const outHeight = turned ? width : height;
    for (let y = 0; y < outHeight; y++) {
        const oy = flipY ? outHeight - 1 - y : y;
        let target = outputOffset + y * outWidth * unit;
        for (let x = 0; x < outWidth; x++, target += unit) {
            const [sx, sy] = turnedSource(
                flipX ? outWidth - 1 - x : x,
                oy,
                width,
                height,
                rotation,
            );
            const from = plane.offset + sy * plane.stride + sx * unit;
            output[target] = input[from]!;
            if (unit === 2) output[target + 1] = input[from + 1]!;
        }
    }
}

/**
 * Draws over the transformed picture on its canvas; the transform is reset to the output pixel
 * grid.
 */
export type FramePainter = (context: OffscreenCanvasRenderingContext2D) => void;

/**
 * Applies one geometry to host VideoFrames. Unchanged frames pass through, aligned crops become
 * zero-copy views, turns and mirrors of 4:2:0 frames move their plane samples (`orient()`), and
 * everything else is drawn on one reused OffscreenCanvas, which also serves RGBA readback. 4:2:2
 * and 4:4:4 frames are always drawn, since encoders take 4:2:0 or RGB input.
 * `background` fills the padding of contained pictures.
 */
export class VideoFrameTransformer {
    private canvas?: OffscreenCanvas;
    private context?: OffscreenCanvasRenderingContext2D;
    /** Counts canvas draws, so a readback knows whether the canvas still shows its picture. */
    private draws = 0;
    private readonly identity: boolean;
    private readonly cropOnly: boolean;

    constructor(
        private readonly geometry: VideoGeometry,
        private readonly readable = false,
        private readonly background = '#000',
    ) {
        this.identity = isIdentityGeometry(geometry);
        this.cropOnly = isCropOnlyGeometry(geometry);
    }

    /**
     * Region of the frame's display coordinates that the geometry's stored-picture region covers.
     */
    private sourceRect(frame: VideoFrame): VideoRect {
        const { region, sourceWidth, sourceHeight } = this.geometry;
        const scaleX = frame.displayWidth / sourceWidth;
        const scaleY = frame.displayHeight / sourceHeight;
        return {
            x: region.x * scaleX,
            y: region.y * scaleY,
            width: region.width * scaleX,
            height: region.height * scaleY,
        };
    }

    private displayMatches(frame: VideoFrame): boolean {
        return (
            frame.displayWidth === this.geometry.sourceWidth &&
            frame.displayHeight === this.geometry.sourceHeight
        );
    }

    /**
     * Whether the geometry only crops on the chroma grid, turns and mirrors a 4:2:0 frame of square
     * pixels, which `orient()` does on its planes: exactly, keeping the frame's colour and depth.
     */
    orients(frame: VideoFrame): boolean {
        const shape = ORIENTED_FORMATS[frame.format ?? ''];
        const { region, target, width, height, rotation, flipX, flipY } = this.geometry;
        const visible = frame.visibleRect;
        const turned = rotation === 90 || rotation === 270;
        return (
            !!shape &&
            !!visible &&
            (rotation !== 0 || flipX || flipY) &&
            this.displayMatches(frame) &&
            visible.width === frame.displayWidth &&
            visible.height === frame.displayHeight &&
            target.x === 0 &&
            target.y === 0 &&
            target.width === width &&
            target.height === height &&
            (turned ? region.height : region.width) === width &&
            (turned ? region.width : region.height) === height &&
            [visible.x + region.x, visible.y + region.y, region.width, region.height].every(
                value => value % 2 === 0,
            )
        );
    }

    /**
     * The frame turned and mirrored on its planes as a new frame at `timestamp`/`duration`
     * microseconds, which the caller closes; only for a frame `orients()` accepts.
     */
    async orient(
        frame: VideoFrame,
        timestamp: number,
        duration: number | undefined,
    ): Promise<VideoFrame> {
        const { unit, nv12 } = ORIENTED_FORMATS[frame.format!]!;
        const { region, width, height, rotation } = this.geometry;
        const visible = frame.visibleRect!;
        const rect = {
            x: visible.x + region.x,
            y: visible.y + region.y,
            width: region.width,
            height: region.height,
        };
        const input = new Uint8Array(frame.allocationSize({ rect }));
        const planes = await frame.copyTo(input, { rect });

        // Tightly packed output planes: luma, then U and V, or the interleaved UV pairs of NV12.
        const chroma = { width: rect.width / 2, height: rect.height / 2 };
        const sizes = nv12 ? [rect, chroma] : [rect, chroma, chroma];
        const units = nv12 ? [unit, 2 * unit] : [unit, unit, unit];
        const turned = rotation === 90 || rotation === 270;
        const layout: PlaneLayout[] = [];
        let bytes = 0;
        for (const [index, size] of sizes.entries()) {
            const stride = (turned ? size.height : size.width) * units[index]!;
            layout.push({ offset: bytes, stride });
            bytes += stride * (turned ? size.width : size.height);
        }
        const output = new Uint8Array(bytes);
        for (const [index, size] of sizes.entries())
            orientPlane(
                input,
                planes[index]!,
                size,
                units[index]!,
                this.geometry,
                output,
                layout[index]!.offset,
            );
        return new VideoFrame(output, {
            format: frame.format!,
            codedWidth: width,
            codedHeight: height,
            layout,
            timestamp,
            duration,
            colorSpace: frame.colorSpace.toJSON(),
        });
    }

    /**
     * Whether the frame passes as it is: no change, a format encoders take, the size the geometry
     * expects.
     */
    private unchanged(frame: VideoFrame): boolean {
        return this.identity && !needsRgb(frame) && this.displayMatches(frame);
    }

    /**
     * Whether the geometry is a crop on the frame's chroma grid, which a visible rectangle shows
     * without copying.
     */
    private alignedCrop(frame: VideoFrame): boolean {
        const alignment = chromaAlignment(frame.format);
        const { region } = this.geometry;
        return (
            this.cropOnly &&
            !needsRgb(frame) &&
            !!alignment &&
            !!frame.visibleRect &&
            this.displayMatches(frame) &&
            frame.visibleRect.width === this.geometry.sourceWidth &&
            frame.visibleRect.height === this.geometry.sourceHeight &&
            (frame.visibleRect.x + region.x) % alignment.x === 0 &&
            (frame.visibleRect.y + region.y) % alignment.y === 0
        );
    }

    /** Whether apply() hands back the frame or a zero-copy view of it, drawing nothing. */
    drawsNothing(frame: VideoFrame): boolean {
        return this.unchanged(frame) || this.alignedCrop(frame);
    }

    /**
     * The frame to encode at `timestamp`/`duration` microseconds: `frame` itself when nothing
     * changes, otherwise a new frame. A painter always draws and then paints over the picture. The
     * caller closes `frame` and, when different, the result.
     */
    apply(
        frame: VideoFrame,
        timestamp: number,
        duration: number | undefined,
        paint?: FramePainter,
        toSdr?: () => void,
    ): VideoFrame {
        const retimed = frame.timestamp !== timestamp || (frame.duration ?? undefined) !== duration;
        if (!paint && this.unchanged(frame))
            return retimed ? new VideoFrame(frame, { timestamp, duration }) : frame;
        if (!paint && this.alignedCrop(frame)) {
            const { region } = this.geometry;
            const visible = frame.visibleRect!;
            return new VideoFrame(frame, {
                visibleRect: {
                    x: visible.x + region.x,
                    y: visible.y + region.y,
                    width: region.width,
                    height: region.height,
                },
                displayWidth: region.width,
                displayHeight: region.height,
                timestamp,
                duration,
            });
        }

        this.draw(frame, toSdr);
        if (paint) {
            this.context!.setTransform(1, 0, 0, 1, 0, 0);
            paint(this.context!);
        }
        return new VideoFrame(this.canvas!, { timestamp, duration });
    }

    /**
     * Reads the straight RGBA of the picture drawn last while no later draw replaced it, without
     * drawing it again; undefined once the canvas shows another picture.
     */
    readback(): () => Uint8Array | undefined {
        const draw = this.draws;
        return () => {
            if (draw !== this.draws || !this.context) return undefined;
            const pixels = this.context.getImageData(
                0,
                0,
                this.geometry.width,
                this.geometry.height,
            ).data;
            return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        };
    }

    /**
     * Draws `frame` on the canvas, whose colour management maps HDR and wide-gamut colour to SDR
     * (`toSdr`).
     */
    private draw(frame: VideoFrame, toSdr?: () => void): void {
        if (isHdrFrame(frame)) toSdr?.();

        const { width, height, target, rotation, flipX, flipY } = this.geometry;
        if (!this.context) {
            if (typeof OffscreenCanvas !== 'function')
                throw new MediaForgeError(
                    'OffscreenCanvas is unavailable for video transforms',
                    'ENCODE',
                );
            this.canvas = new OffscreenCanvas(width, height);
            const context = this.canvas.getContext('2d', {
                alpha: false,
                willReadFrequently: this.readable,
            });
            if (!context)
                throw new MediaForgeError(
                    '2D canvas context is unavailable for video transforms',
                    'ENCODE',
                );
            this.context = context;
        }

        const context = this.context;
        this.draws++;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        if (target.width !== width || target.height !== height) {
            context.fillStyle = this.background;
            context.fillRect(0, 0, width, height);
        }

        const turned = rotation === 90 || rotation === 270;
        const drawWidth = turned ? target.height : target.width;
        const drawHeight = turned ? target.width : target.height;
        const source = this.sourceRect(frame);

        context.save();
        context.translate(target.x + target.width / 2, target.y + target.height / 2);
        context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        context.rotate((rotation * Math.PI) / 180);
        const whole =
            source.x === 0 &&
            source.y === 0 &&
            source.width === frame.displayWidth &&
            source.height === frame.displayHeight;
        if (whole) context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        else {
            // WebKit ignores the source rectangle of a VideoFrame (WebKit bug 260459): the whole
            // picture is drawn, scaled and moved so that the rectangle lands on the target, and
            // clipped to it.
            const scaleX = drawWidth / source.width;
            const scaleY = drawHeight / source.height;
            context.beginPath();
            context.rect(-drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            context.clip();
            context.drawImage(
                frame,
                -drawWidth / 2 - source.x * scaleX,
                -drawHeight / 2 - source.y * scaleY,
                frame.displayWidth * scaleX,
                frame.displayHeight * scaleY,
            );
        }
        context.restore();
    }
}
