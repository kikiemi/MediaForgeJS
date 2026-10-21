import { MediaForgeError } from '../core/errors/errors';
import { micros } from '../codecs/webcodecs/codec';
import {
    isHdrTransfer,
    isHostFrame,
    type DecodedPicture,
    type DecodeRecovery,
} from '../codecs/webcodecs/video';
import type { PlanarVideoFrame } from '../core/contracts/picture';
import {
    assumedYuvColour,
    isConvertibleFormat,
    planarToRgba,
    yuvMatrix,
} from '../codecs/shared/yuv-rgba';
import type { VideoPicture } from '../core/contracts/stage';

/** The pixels behind a picture: a host frame, a built-in decoder's planes, or straight RGBA8. */
export type PictureData =
    | {
          readonly kind: 'frame';
          readonly frame: VideoFrame;
          /** Reports that the frame's HDR colour becomes SDR, or refuses it by throwing. */
          readonly toSdr?: () => void;
      }
    | { readonly kind: 'planar'; readonly planar: PlanarVideoFrame }
    | {
          readonly kind: 'rgba';
          readonly data: Uint8Array;
          readonly width: number;
          readonly height: number;
          /**
           * The colour the pixels are in; default sRGB, as canvases and image encoders take them.
           */
          readonly colorSpace?: VideoColorSpaceInit;
      };

/** The colour of RGBA pixels that state none: sRGB. */
const SRGB: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'rgb',
    fullRange: true,
};

/**
 * Reads back a canvas while it still holds the picture drawn last; undefined once a later draw
 * replaced it.
 */
export type CanvasReadback = () => Uint8Array | undefined;

let readbackCanvas: OffscreenCanvas | undefined;
let readbackContext: OffscreenCanvasRenderingContext2D | undefined;

const sdrReports = new WeakMap<DecodeRecovery, () => void>();

/**
 * The toSdr of the pictures a decoder with `recovery` makes: one HDR_TO_SDR warning, or a FORMAT
 * error under strict validation.
 */
export function sdrReport(recovery: DecodeRecovery): () => void {
    let report = sdrReports.get(recovery);
    if (!report) {
        let reported = false;
        report = () => {
            if (recovery.strict) throw new MediaForgeError('HDR video would become SDR', 'FORMAT');
            if (reported) return;
            reported = true;
            recovery.warn('HDR_TO_SDR', 'HDR video is converted to SDR');
        };
        sdrReports.set(recovery, report);
    }
    return report;
}

/** Whether a host frame's colour is HDR or wide-gamut, which becomes SDR BT.709 as RGBA8. */
export function isHdrFrame(frame: VideoFrame): boolean {
    const space = frame.colorSpace;
    return (
        isHdrTransfer(space?.transfer as string | null | undefined) ||
        (space?.primaries as string | null | undefined) === 'bt2020'
    );
}

/**
 * Straight RGBA of a host frame's display picture at `width` × `height`, drawn on a shared canvas,
 * whose colour management maps HDR and wide-gamut colour to sRGB; undefined without
 * OffscreenCanvas.
 */
export function canvasRgba(
    frame: VideoFrame,
    width: number,
    height: number,
): Uint8Array | undefined {
    if (typeof OffscreenCanvas !== 'function') return undefined;
    if (!readbackCanvas || readbackCanvas.width !== width || readbackCanvas.height !== height) {
        readbackCanvas = new OffscreenCanvas(width, height);
        readbackContext =
            readbackCanvas.getContext('2d', { alpha: false, willReadFrequently: true }) ??
            undefined;
    }
    if (!readbackContext)
        throw new MediaForgeError('2D canvas context is unavailable for RGBA pictures', 'ENCODE');
    readbackContext.drawImage(frame, 0, 0, width, height);
    const pixels = readbackContext.getImageData(0, 0, width, height).data;
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

/**
 * Straight RGBA of a host frame's display picture: drawn on a shared canvas, or converted on the
 * CPU without one. HDR and wide-gamut colour becomes SDR, reported through `toSdr`.
 */
async function frameRgba(frame: VideoFrame, toSdr?: () => void): Promise<Uint8Array> {
    if (isHdrFrame(frame)) toSdr?.();

    const drawn = canvasRgba(frame, frame.displayWidth, frame.displayHeight);
    if (drawn) return drawn;
    if (!isConvertibleFormat(frame.format))
        throw new MediaForgeError(
            `Pixel format ${frame.format} needs OffscreenCanvas to become RGBA`,
            'DECODE',
        );

    const data = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(data);
    const rect = frame.visibleRect ?? {
        x: 0,
        y: 0,
        width: frame.codedWidth,
        height: frame.codedHeight,
    };
    const rgba = planarToRgba(
        {
            format: frame.format!,
            data,
            layout,
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
        },
        rect,
        yuvMatrix(frame.colorSpace?.matrix, rect.width, rect.height),
        frame.colorSpace?.fullRange === true,
    );
    return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

/** Straight RGBA of the visible region of built-in decoder planes. */
function planarRgba(planar: PlanarVideoFrame): Uint8Array {
    const rect = planar.visibleRect;
    const rgba = planarToRgba(
        planar,
        rect,
        yuvMatrix(planar.colorSpace?.matrix, rect.width, rect.height),
        planar.colorSpace?.fullRange === true,
    );
    return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

/**
 * A host frame of built-in decoder planes at `timestamp`/`duration` microseconds; the caller closes
 * it.
 */
export function planarVideoFrame(
    planar: PlanarVideoFrame,
    timestamp: number,
    duration: number,
): VideoFrame {
    const rect = planar.visibleRect;
    return new VideoFrame(planar.data, {
        format: planar.format,
        codedWidth: planar.codedWidth,
        codedHeight: planar.codedHeight,
        layout: planar.layout.map(plane => ({ offset: plane.offset, stride: plane.stride })),
        visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        displayWidth: planar.displayWidth,
        displayHeight: planar.displayHeight,
        timestamp,
        duration,
        colorSpace:
            planar.format.startsWith('I') && !planar.colorSpace?.matrix
                ? { ...assumedYuvColour(rect.width, rect.height), ...planar.colorSpace }
                : (planar.colorSpace as VideoColorSpaceInit | undefined),
    });
}

/** The picture implementation every stage chain passes along; it owns its host frame. */
export class Picture implements VideoPicture {
    private closed = false;

    constructor(
        readonly data: PictureData,
        readonly timestamp: number,
        readonly duration: number,
        private readonly readback?: CanvasReadback,
        readonly keyframe = false,
    ) {}

    /** A decoder's output at its own timing; host frames move into the picture. */
    static decoded(
        picture: DecodedPicture,
        timestamp: number,
        duration: number,
        toSdr?: () => void,
    ): Picture {
        return isHostFrame(picture)
            ? new Picture({ kind: 'frame', frame: picture, toSdr }, timestamp, duration)
            : new Picture({ kind: 'planar', planar: picture }, timestamp, duration);
    }

    /** A decoder's output the caller keeps: host frames are cloned, planes and pixels shared. */
    static view(data: PictureData, timestamp: number, duration: number): Picture {
        if (data.kind !== 'frame') return new Picture(data, timestamp, duration);
        return new Picture({ ...data, frame: new VideoFrame(data.frame) }, timestamp, duration);
    }

    get width(): number {
        const { data } = this;
        return data.kind === 'frame'
            ? data.frame.displayWidth
            : data.kind === 'planar'
              ? data.planar.visibleRect.width
              : data.width;
    }

    get height(): number {
        const { data } = this;
        return data.kind === 'frame'
            ? data.frame.displayHeight
            : data.kind === 'planar'
              ? data.planar.visibleRect.height
              : data.height;
    }

    get frame(): VideoFrame | undefined {
        return this.data.kind === 'frame' ? this.data.frame : undefined;
    }

    async rgba(): Promise<Uint8Array> {
        if (this.closed) throw new MediaForgeError('The picture is closed', 'INPUT');
        const { data } = this;
        if (data.kind === 'rgba') return data.data;
        if (data.kind === 'planar') return planarRgba(data.planar);
        return this.readback?.() ?? frameRgba(data.frame, data.toSdr);
    }

    retime(timestamp: number, duration: number): Picture {
        return this.shownAt(timestamp, duration, false);
    }

    /**
     * The same pixels at another time, asking for a keyframe when `keyframe` is true; owned
     * separately.
     */
    shownAt(timestamp: number, duration: number, keyframe: boolean): Picture {
        const { data } = this;
        if (data.kind !== 'frame')
            return new Picture(data, timestamp, duration, undefined, keyframe);
        const frame = new VideoFrame(data.frame, {
            timestamp: micros(timestamp),
            duration: micros(duration),
        });
        return new Picture(
            { kind: 'frame', frame, toSdr: data.toSdr },
            timestamp,
            duration,
            undefined,
            keyframe,
        );
    }

    /**
     * A new host frame of the picture at its timing, which the caller closes; RGBA becomes
     * BT.709-labelled RGBA.
     */
    toVideoFrame(): VideoFrame {
        const { data } = this;
        const timestamp = micros(this.timestamp);
        const duration = micros(Math.max(0, this.duration));
        if (data.kind === 'frame') return new VideoFrame(data.frame, { timestamp, duration });
        if (data.kind === 'planar') return planarVideoFrame(data.planar, timestamp, duration);
        return new VideoFrame(data.data, {
            format: 'RGBA',
            codedWidth: data.width,
            codedHeight: data.height,
            timestamp,
            duration,
            colorSpace: data.colorSpace ?? SRGB,
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.data.kind === 'frame') this.data.frame.close();
    }
}

/** The library's picture for a stage's own output, or a picture a stage built from RGBA. */
export function pictureOf(picture: VideoPicture): Picture {
    if (picture instanceof Picture) return picture;
    throw new MediaForgeError(`Stage output must be a picture, not ${typeof picture}`, 'INPUT', {
        hint: 'Return a picture given to the stage, its retime(), or createPicture().',
    });
}
