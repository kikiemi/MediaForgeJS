import { MediaForgeError } from '../../core/errors/errors';
import type { GifDitherMode } from '../../codecs/image/encoders';
import { mimeTypeOf } from '../../formats/shared/mime-types';
import { ANIMATED_IMAGE_FORMATS, FRAME_IMAGE_FORMATS } from '../plan/format-policy';
import { assertPictureEncoder } from './picture-encoder';
import type { Engine } from '../engine';
import type { MediaFile } from '../read/media-file';
import type { FrameExtraction } from './frame-extract';

/** Frames per second of gif and apng animations taken from video when none is set. */
const ANIMATION_FPS = 10;

/** Pictures one animation may hold. */
const MAX_ANIMATION_FRAMES = 2000;

/** A picture or animation taken from the video of an input, its settings resolved by the API. */
export interface PictureTarget {
    readonly format: string;
    /** Output size, fit, crop, rotation and flip of the picture. */
    readonly geometry: Omit<
        FrameExtraction,
        'times' | 'every' | 'maxFrames' | 'videoFrame' | 'trackId'
    >;
    /** Animations: pictures per second; default 10. */
    readonly fps?: number;
    /** JPEG and WebP quality from 0 to 1. */
    readonly quality?: number;
    /** GIF quantization. */
    readonly dither?: GifDitherMode;
    /** Seconds from the input's start of the picture, or of the first picture of an animation. */
    readonly start?: number;
    /** Exclusive end of an animation in seconds. */
    readonly end?: number;
}

/**
 * Fails where a picture of `format` cannot be taken from a video, before anything is decoded: a
 * format of stills only, or one whose encoder this host lacks.
 */
function assertPictureFormat(format: string): void {
    if (ANIMATED_IMAGE_FORMATS.has(format)) return;
    if (!(FRAME_IMAGE_FORMATS as readonly string[]).includes(format))
        throw new MediaForgeError(`${format} pictures are taken from still images only`, 'FORMAT', {
            hint: "Ask for a 'png', 'jpeg' or 'webp' picture, or a 'gif' or 'apng' animation.",
        });
    assertPictureEncoder(format, 'pictures');
}

/**
 * Fails as takePicture() would before encoding: the format is not taken from a video, its encoder
 * is missing, or no picture decodes at `start`.
 */
export async function checkPicture(
    engine: Engine,
    file: MediaFile,
    target: PictureTarget,
): Promise<void> {
    assertPictureFormat(target.format);
    // The picture is only decoded: a host frame is closed unread rather than converted to RGBA.
    const pictures = engine.frames(file, {
        times: [file.timelineStart + (target.start ?? 0)],
        signal: target.geometry.signal,
        videoFrame: typeof VideoFrame === 'function',
    });
    try {
        const first = await pictures.next();
        if (first.done)
            throw new MediaForgeError(
                'No video picture could be decoded at the requested time',
                'DECODE',
            );
        if (typeof VideoFrame === 'function' && first.value instanceof VideoFrame)
            first.value.close();
    } finally {
        await pictures.return(undefined);
    }
}

/**
 * The picture at `start` (default 0 s), or a gif or apng animation of the pictures from `start` to
 * `end`.
 */
export async function takePicture(
    engine: Engine,
    file: MediaFile,
    target: PictureTarget,
): Promise<Blob> {
    // Target seconds count from the input's start; frame times are packet times, which carry an
    // MPEG-TS clock.
    const base = file.timelineStart;
    if (ANIMATED_IMAGE_FORMATS.has(target.format)) return animation(engine, file, target, base);
    assertPictureFormat(target.format);
    return engine.thumbnail(file, {
        ...target.geometry,
        to: target.format as (typeof FRAME_IMAGE_FORMATS)[number],
        time: base + (target.start ?? 0),
        quality: target.quality,
    });
}

async function animation(
    engine: Engine,
    file: MediaFile,
    target: PictureTarget,
    base: number,
): Promise<Blob> {
    const format = target.format as 'gif' | 'apng';
    const fps = target.fps ?? ANIMATION_FPS;
    const track = file.tracks.find(candidate => candidate.type === 'video');
    if (!track) throw new MediaForgeError('The input has no video track', 'FORMAT');

    const start = target.start ?? 0;
    const end = Math.min(target.end ?? track.duration, track.duration);
    if (end <= start)
        throw new MediaForgeError(
            `${format} animation from ${start} s to ${end} s is empty`,
            'INPUT',
        );
    const count = Math.ceil((end - start) * fps - 1e-9);
    if (count > MAX_ANIMATION_FRAMES)
        throw new MediaForgeError(
            `${format} animation has more than ${MAX_ANIMATION_FRAMES} frames`,
            'FORMAT',
            { hint: 'Shorten the range or lower video.fps.' },
        );

    const times = Array.from({ length: count }, (_, index) => base + start + index / fps);
    const delay = 1000 / fps;
    const { AnimatedGifEncoder, ApngEncoder } = await import('../../codecs/image/encoders');
    let gif: InstanceType<typeof AnimatedGifEncoder> | undefined;
    let apng: InstanceType<typeof ApngEncoder> | undefined;

    for await (const frame of engine.frames(file, { ...target.geometry, times })) {
        if (format === 'gif') {
            gif ??= new AnimatedGifEncoder(frame.width, frame.height, {
                ...(target.dither ? { dither: target.dither } : {}),
            });
            await gif.addFrame(frame, delay);
        } else {
            apng ??= new ApngEncoder(frame.width, frame.height);
            await apng.addFrame(frame, delay);
        }
    }

    const encoder = gif ?? apng;
    if (!encoder)
        throw new MediaForgeError('No video frame could be decoded for the animation', 'DECODE');
    return new Blob([await encoder.encode()], { type: mimeTypeOf(format) });
}
