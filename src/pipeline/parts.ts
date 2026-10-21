import { MediaForgeError } from '../core/errors/errors';
import { OptionNormalizer } from '../core/errors/option-policy';
import { remixStage } from '../stages/audio';
import { AudioStageChain, VideoStageChain, chainedPcmSource, streamOf } from '../stages/chain';
import type {
    AudioPlanes,
    AudioStage,
    VideoPicture,
    VideoStage,
    VideoStreamInfo,
} from '../core/contracts/stage';
import { resolveVideoGeometry } from '../stages/frame-geometry';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../stages/geometry-settings';
import { pictureOf } from '../stages/picture';
import { frameRateStage, transformStage } from '../stages/video';
import { timeStretchStage } from '../stages/time-stretch';

/**
 * The parts every operation is assembled from, as objects an application can put together itself: a
 * video decoder that turns packets into pictures, stages that change pictures or sound, a video
 * encoder that turns pictures into packets, and a muxer that writes packets into a file and encodes
 * PCM into its audio track. convert(), edit() and encodeFrames() run these same decoders, encoders,
 * stages and muxers.
 */

// What every part takes, and sound as the parts pass it: defined with the codecs' parts.
export { warner, type PartOptions, type PcmSource } from './codecs/part-options';
import { warner, type PartOptions, type PcmSource } from './codecs/part-options';

/** Pictures through a row of video stages. */
export interface VideoStages {
    /** The stream the last stage emits. */
    readonly output: VideoStreamInfo;
    /**
     * Runs a picture, which the stages take over, through every stage; resolves the pictures out of
     * the last.
     */
    push(picture: VideoPicture): Promise<VideoPicture[]>;
    /** Flushes every stage in order at the end of the stream. */
    flush(): Promise<VideoPicture[]>;
    /** Closes the stages and the pictures they hold. */
    close(): void;
}

/**
 * Runs pictures of the `input` stream through `stages` in order; each stage is configured once,
 * here.
 */
export function createVideoStages(
    stages: readonly VideoStage[],
    input: VideoStreamInfo,
    options: PartOptions = {},
): VideoStages {
    const ready: VideoPicture[] = [];
    const chain = new VideoStageChain(
        [...stages],
        input,
        picture => {
            ready.push(picture);
        },
        warner(options),
    );
    return {
        output: chain.output,
        async push(picture) {
            await chain.push(pictureOf(picture));
            return ready.splice(0);
        },
        async flush() {
            await chain.finish();
            return ready.splice(0);
        },
        close() {
            chain.close();
            for (const picture of ready.splice(0)) picture.close();
        },
    };
}

/** How `transform` changes pictures: crop, then rotate and flip, then resize. */
export interface TransformOptions {
    /** The region kept, in pixels of the upright picture. */
    readonly crop?: VideoCrop;
    /** Clockwise degrees. */
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    /** Output size; one side alone keeps the aspect ratio. */
    readonly width?: number;
    readonly height?: number;
    /**
     * How the picture fills a size of another shape: 'fill' stretches, 'contain' pads, 'cover'
     * crops.
     */
    readonly fit?: VideoFit;
}

/**
 * A stage that crops, rotates, flips and resizes pictures; its output size follows from the first
 * stream it sees.
 */
export function transform(options: TransformOptions): VideoStage {
    const geometryOf = (width: number, height: number) =>
        resolveVideoGeometry(
            { width, height },
            options,
            new OptionNormalizer('strict', 'transform'),
            false,
        );
    let inner: VideoStage | undefined;
    const ensure = (width: number, height: number): VideoStage =>
        (inner ??= transformStage(geometryOf(width, height), { resolve: geometryOf }));
    return {
        type: 'video',
        name: 'transform',
        configure(input) {
            const geometry = geometryOf(input.width, input.height);
            inner = transformStage(geometry, { resolve: geometryOf });
            return { ...input, width: geometry.width, height: geometry.height };
        },
        process(picture, emit) {
            return ensure(picture.width, picture.height).process(picture, emit);
        },
    };
}

/**
 * A stage that shows the pictures at a constant rate, dropping or repeating them as the source rate
 * demands.
 */
export function frameRate(fps: number): VideoStage {
    if (!Number.isFinite(fps) || fps <= 0)
        throw new MediaForgeError('frameRate needs a positive rate', 'INPUT');
    return frameRateStage(fps);
}

/** A stage that plays pictures `factor` times as fast: 2 halves every time and duration. */
export function speed(factor: number): VideoStage {
    if (!Number.isFinite(factor) || factor <= 0)
        throw new MediaForgeError('speed needs a positive factor', 'INPUT');
    return {
        type: 'video',
        name: 'speed',
        configure: input => (input.fps ? { ...input, fps: input.fps * factor } : input),
        process(picture, emit) {
            emit(picture.retime(picture.timestamp / factor, picture.duration / factor));
            picture.close();
        },
    };
}

/**
 * A stage that plays sound `factor` times as fast at the same pitch (a phase vocoder that keeps
 * attacks sharp); the output holds exactly round(input frames / factor) frames, in step with
 * `speed(factor)` on the pictures.
 */
export function timeStretch(factor: number): AudioStage {
    return timeStretchStage(factor);
}

/** How `remix` changes sound. */
export interface RemixOptions {
    /** Output rate in Hz; default the input's. */
    readonly sampleRate?: number;
    /** Output channels, mixed down or up with ITU-R BS.775 weights; default the input's. */
    readonly channels?: number;
    /** Plays the sound `speed` times as fast, its pitch moving with it; default 1. */
    readonly speed?: number;
}

/** A stage that resamples sound and maps its channels. */
export function remix(options: RemixOptions): AudioStage {
    const factor = options.speed ?? 1;
    if (!Number.isFinite(factor) || factor <= 0)
        throw new MediaForgeError('remix speed must be positive', 'INPUT');
    let inner: AudioStage | undefined;
    return {
        type: 'audio',
        name: 'remix',
        configure(input) {
            const target = {
                sampleRate: options.sampleRate ?? input.sampleRate,
                channels: options.channels ?? input.channels,
            };
            inner = remixStage(target);
            return inner.configure!({
                ...input,
                sampleRate: Math.round(input.sampleRate * factor),
            });
        },
        process(planes, emit) {
            if (!inner) throw new MediaForgeError('Run remix() through stageAudio()', 'INPUT');
            return inner.process(planes, emit);
        },
        flush: emit => inner?.flush?.(emit),
        close: () => inner?.close?.(),
    };
}

/**
 * The sound of `source` after `stages`, read once: the stages are the caller's, so the chain they
 * form, configured now, runs the one read.
 */
export function stageAudio(
    source: PcmSource,
    stages: readonly AudioStage[],
    options: PartOptions = {},
): PcmSource {
    let sink: ((planes: AudioPlanes) => void) | undefined;
    const chain = new AudioStageChain(
        [...stages],
        streamOf(source),
        planes => sink!(planes),
        warner(options),
    );
    return chainedPcmSource(source, chain.output, read => {
        if (sink) throw new MediaForgeError('Staged sound can be read once', 'INPUT');
        sink = read;
        return chain;
    });
}
