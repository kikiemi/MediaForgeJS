import type { MissingParts } from '../plugins/missing-parts';
import { editPresentationWindow, insidePresentationWindow } from '../../core/model/audio-window';
import type { MediaFile } from '../read/media-file';
import type { FilePacket, RemuxTrack } from '../media-types';
import { mediaFileState } from '../read/file-state';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { MediaForgeError } from '../../core/errors/errors';
import { mimeTypeOf } from '../../formats/shared/mime-types';
import { linkAbortSignals } from '../../core/io/abort';
import { OptionNormalizer } from '../../core/errors/option-policy';
import type { BuiltinVideoCodec } from '../../core/contracts/decoder';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import {
    isHostFrame,
    type DecodeRecovery,
    type FrameTiming,
    hostVideoDecoderConfig,
} from '../../codecs/webcodecs/video';
import { disposablePictures, openFrameDecoder } from '../codecs/frame-codecs';
import type { ClipDecoder } from '../codecs/video-codecs';
import { assertPictureEncoder } from './picture-encoder';
import { indexedFrames, StreamedFrames } from './frame-index';
import type { CodecPreference } from '../api-types';
import { pixelAspectOf, resolveVideoGeometry, uprightRotation } from '../../stages/frame-geometry';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../../stages/geometry-settings';
import { createStages, VideoStageChain, type StageFactory } from '../../stages/chain';
import type { VideoStage } from '../../core/contracts/stage';
import { Picture, sdrReport, type PictureData } from '../../stages/picture';
import { transformStage } from '../../stages/video';
import { decodeTime } from '../../core/model/media-time';

/** Resolved extraction request; the API's FrameOptions documents each field. */
export interface FrameExtraction {
    readonly times?: readonly number[];
    readonly every?: number;
    readonly maxFrames?: number;
    readonly trackId?: number;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly signal?: AbortSignal;
    /** Yield host VideoFrame objects, which the consumer must close, instead of RGBA. */
    readonly videoFrame?: boolean;
    /** Stages each picture runs through after the geometry. */
    readonly stages?: readonly StageFactory<VideoStage>[];
}

/** One resolved picture: its time, geometry, image format and quality. */
export interface ThumbnailExtraction extends FrameExtraction {
    readonly time: number;
    readonly to: 'png' | 'jpeg' | 'webp';
    readonly quality?: number;
}

interface ExtractedFrame {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
}

export interface FrameDecoders {
    readonly decoders: readonly BuiltinVideoCodec[];
    readonly preference: CodecPreference;
    /** Names the plugin that would decode a codec nothing in use decodes; default none. */
    readonly missing?: MissingParts;
    readonly recovery: DecodeRecovery;
    /** Application codecs; the first that decodes the track's codec decodes it. */
    readonly providers?: readonly VideoCodecProvider[];
}

interface Decoded {
    readonly data: PictureData;
    readonly timing: FrameTiming;
}

function release(entry: Decoded | undefined): void {
    if (entry?.data.kind === 'frame') entry.data.frame.close();
}

function videoTrack(file: MediaFile, trackId: number | undefined): RemuxTrack {
    const tracks = mediaFileState(file).tracks;
    const track =
        trackId === undefined
            ? tracks.find(value => value.type === 'video')
            : tracks.find(value => value.description.id === trackId);
    if (trackId !== undefined && !track)
        throw new MediaForgeError(`Unknown track ${trackId}`, 'INPUT');
    if (!track || track.type !== 'video')
        throw new MediaForgeError(
            trackId === undefined
                ? 'The input has no video track'
                : `Track ${trackId} is not a video track`,
            'FORMAT',
        );
    if (!track.description.sampleCount)
        throw new MediaForgeError('The video track has no frames', 'FORMAT');
    return track;
}

/**
 * Decodes the requested pictures of one video track as RGBA. For each requested time the picture
 * presented then is yielded: the last one starting at or before it, or the first picture for
 * earlier times. Decoding continues forward between times and seeks to the keyframe at or before a
 * time only when that skips work or the time lies behind. `every` yields each distinct picture
 * once; without times or an interval every picture is yielded in order.
 */
export function extractFrames(
    file: MediaFile,
    options: FrameExtraction & { readonly videoFrame: true },
    video: FrameDecoders,
    normalizer: OptionNormalizer,
): AsyncGenerator<VideoFrame>;
export function extractFrames(
    file: MediaFile,
    options: FrameExtraction,
    video: FrameDecoders,
    normalizer: OptionNormalizer,
): AsyncGenerator<ExtractedFrame>;
export async function* extractFrames(
    file: MediaFile,
    options: FrameExtraction,
    video: FrameDecoders,
    normalizer: OptionNormalizer,
): AsyncGenerator<ExtractedFrame | VideoFrame> {
    if (options.videoFrame && typeof VideoFrame !== 'function')
        throw new MediaForgeError('This host has no WebCodecs VideoFrame', 'DECODE', {
            hint: "Ask for the default 'rgba' frames, which work everywhere.",
        });
    const track = videoTrack(file, options.trackId);
    const info = track.info;
    // The decoders show the colour pictures; the alpha beside them (VP8 and VP9) is not decoded.
    if (info.alphaMode)
        mediaFileState(file).diagnostics.lose({
            code: 'ALPHA_DROPPED',
            message: 'The pictures are decoded without their alpha channel',
            trackId: track.description.id,
        });
    const sourceRotation = uprightRotation(info.rotation);
    const pixelAspect = pixelAspectOf(info);
    const reported = normalizer.findings.length;
    const geometry = resolveVideoGeometry(
        { width: info.width, height: info.height, rotation: sourceRotation, pixelAspect },
        options,
        normalizer,
        false,
    );
    for (const finding of normalizer.findings.slice(reported))
        video.recovery.warn(finding.code, finding.message);
    const outputs: Picture[] = [];
    const chain = new VideoStageChain(
        [
            transformStage(geometry, {
                readable: !options.videoFrame,
                resolve: (width, height) =>
                    resolveVideoGeometry(
                        { width, height, rotation: sourceRotation, pixelAspect },
                        { ...options, width: geometry.width, height: geometry.height },
                        new OptionNormalizer(),
                        false,
                    ),
            }),
            ...createStages('video', options.stages),
        ],
        { width: info.width, height: info.height },
        picture => {
            outputs.push(picture);
        },
        (code, message) => video.recovery.warn(code, message),
    );

    // Pictures outside the edit list decode as references only, as players present the track.
    const presented = editPresentationWindow(info);
    const limit = options.maxFrames ?? Infinity;
    const linked = linkAbortSignals(mediaFileState(file).signal, options.signal);

    // An input read in one pass (a large one) is searched by reading ahead instead of in an index.
    const index = file.streamed
        ? new StreamedFrames(file, track, linked.signal)
        : indexedFrames(file, track, linked.signal);
    /** The times to yield the pictures of, or every picture. */
    const targetTimes = async (): Promise<readonly number[] | undefined> => {
        if (options.times !== undefined || options.every === undefined) return options.times;
        const firstIndex = (await index.first(false)) ?? 0;
        const start = Math.max(presented.start, index.sample(firstIndex)?.timestamp ?? 0);
        const list: number[] = [];
        for (
            let time = start;
            list.length < Math.min(limit, 1_000_000);
            time = start + list.length * options.every
        ) {
            if (list.length && time >= start + info.duration) break;
            list.push(time);
        }
        return list;
    };
    const lifetime = new CodecLifetime(linked.signal);
    const queue: Decoded[] = [];
    let decoder: ClipDecoder | undefined;
    let packets: AsyncGenerator<FilePacket> | undefined;
    let submitted = Number.NEGATIVE_INFINITY;
    let exhausted = false;
    let flushed = false;
    /** The flush that ends the stream, running while the pictures it outputs are taken. */
    let flushing: Promise<void> | undefined;
    /** Set while a seek flushes: the pictures the decoder outputs then are not shown. */
    let discarding = false;
    /** Ends the wait of peek() for the next picture of a running flush. */
    let wake: (() => void) | undefined;
    /**
     * An earlier keyframe remains to start from, so a decoder that gave no picture yet has not
     * failed.
     */
    let retrying = false;
    let last: Decoded | undefined;
    const seek = async (key: number): Promise<void> => {
        // A decoder that waits for its pictures back (a GPU decoder) finishes a flush only when
        // the pictures it outputs are let go, so each is released as it comes.
        discarding = true;
        try {
            release(last);
            last = undefined;
            for (const entry of queue.splice(0)) release(entry);
            await packets?.return(undefined);
            if (flushing) await flushing;
            else if (submitted !== Number.NEGATIVE_INFINITY && !flushed)
                await decoder!.flush(false);
        } finally {
            discarding = false;
        }
        packets = index.packets(key);
        submitted = Number.NEGATIVE_INFINITY;
        exhausted = false;
        flushed = false;
        flushing = undefined;
    };
    /**
     * Pictures no other picture refers to are not decoded when they start before `skipBefore`:
     * the picture shown at the requested time starts there, so they would only be dropped.
     */
    const disposable = disposablePictures(info);
    let skipBefore = Number.NEGATIVE_INFINITY;
    const peek = async (): Promise<Decoded | undefined> => {
        while (!queue.length) {
            lifetime.check();
            if (exhausted) {
                if (flushed) return undefined;
                // The pictures of the flush are taken while it runs: a decoder that waits for its
                // pictures back (a GPU decoder) outputs only a few before.
                if (!flushing) {
                    flushing = decoder!.flush(!retrying).then(() => {
                        flushed = true;
                    });
                    flushing.catch(() => undefined);
                }
                const output = new Promise<void>(resolve => (wake = resolve));
                await lifetime.waitFor(Promise.race([flushing, output]));
                wake = undefined;
                continue;
            }
            const step = await lifetime.waitFor(packets!.next());
            if (step.done) {
                exhausted = true;
                continue;
            }
            submitted = decodeTime(step.value);
            if (step.value.timestamp < skipBefore && disposable?.(step.value.data)) continue;
            await decoder!.decode(step.value);
        }
        return queue[0];
    };
    const take = async (): Promise<Decoded | undefined> => {
        const entry = await peek();
        if (!entry) return undefined;
        queue.shift();
        if (
            (last && entry.timing.timestamp <= last.timing.timestamp) ||
            !insidePresentationWindow(presented, entry.timing.timestamp)
        ) {
            release(entry);
            return take();
        }
        release(last);
        last = entry;
        return entry;
    };
    /** What the stages still hold at the end of the stream. */
    const finish = async (): Promise<(ExtractedFrame | VideoFrame)[]> => {
        await chain.finish();
        const pictures = outputs.splice(0);
        try {
            return await Promise.all(
                pictures.map(async picture =>
                    options.videoFrame
                        ? picture.toVideoFrame()
                        : {
                              data: (await picture.rgba()).slice(),
                              width: picture.width,
                              height: picture.height,
                              timestamp: picture.timestamp,
                          },
                ),
            );
        } finally {
            for (const picture of pictures) picture.close();
        }
    };
    /** The pictures the stages make of a decoded picture, which stays held for later times. */
    const render = async (entry: Decoded): Promise<(ExtractedFrame | VideoFrame)[]> => {
        await chain.push(Picture.view(entry.data, entry.timing.timestamp, entry.timing.duration));
        const pictures = outputs.splice(0);
        const frames: (ExtractedFrame | VideoFrame)[] = [];
        try {
            for (const picture of pictures) {
                lifetime.check();
                if (options.videoFrame) frames.push(picture.toVideoFrame());
                else {
                    const data = await picture.rgba();
                    frames.push({
                        data: options.stages?.length ? data.slice() : data,
                        width: picture.width,
                        height: picture.height,
                        timestamp: picture.timestamp,
                    });
                }
            }
            return frames;
        } catch (error) {
            for (const frame of frames) (frame as Partial<VideoFrame>).close?.();
            throw error;
        } finally {
            for (const picture of pictures) picture.close();
        }
    };
    const accept = (data: PictureData, timing: FrameTiming): void => {
        if (lifetime.acceptingOutput && !discarding) queue.push({ data, timing });
        else release({ data, timing });
        wake?.();
    };
    try {
        // An application codec decodes as in conversions; its code loads only for its codecs.
        if (video.providers?.some(provider => provider.supportsDecode(info.codec))) {
            const { openClipDecoder } = await import('../codecs/video-codecs');
            decoder = await openClipDecoder(
                info,
                { ...video, lifetime, signal: linked.signal },
                accept,
            );
        } else
            decoder = await openFrameDecoder({
                config: hostVideoDecoderConfig(info),
                decoders: video.decoders,
                preference: video.preference,
                missing: video.missing,
                lifetime,
                recovery: video.recovery,
                output: (picture, timing) =>
                    accept(
                        isHostFrame(picture)
                            ? { kind: 'frame', frame: picture, toSdr: sdrReport(video.recovery) }
                            : { kind: 'planar', planar: picture },
                        timing,
                    ),
                toVideoFrame: false,
            });
        const firstKey = (await index.first(true)) ?? 0;
        /**
         * The keyframe at or before `time` that decoding can start at: a sync sample whose picture
         * header is not intra (QuickTime H.263 tracks list predicted pictures) gives way to the
         * keyframe before it.
         */
        const entryBefore = async (time: number): Promise<number> => {
            let key = (await index.keyframeBefore(time)) ?? firstKey;
            while (key !== firstKey && !(await index.intra(key)))
                key = (await index.keyframeBefore(index.sample(key)!.timestamp - 1e-9)) ?? firstKey;
            return key;
        };
        const targets = await targetTimes();
        await seek(firstKey);
        let yielded = 0;
        if (!targets) {
            while (yielded < limit) {
                const entry = await take();
                if (!entry) break;
                for (const frame of await render(entry)) {
                    yielded++;
                    yield frame;
                    lifetime.check();
                }
            }
            for (const frame of await finish()) yield frame;
            return;
        }

        // `every` yields each picture once, also when times before the first decodable picture seek
        // back to it.
        let shown = Number.NEGATIVE_INFINITY;
        for (const time of targets) {
            if (yielded >= limit) break;
            let key = await entryBefore(time + TIME_SLACK);
            let keySample = index.sample(key)!;
            let seeked =
                (last !== undefined && last.timing.timestamp > time + TIME_SLACK) ||
                (keySample.timestamp > (last?.timing.timestamp ?? Number.NEGATIVE_INFINITY) &&
                    decodeTime(keySample) > submitted &&
                    !exhausted);
            if (seeked) await seek(key);
            let chosen: Decoded | undefined;
            for (let earlier = 0; ; earlier++) {
                const retry =
                    seeked &&
                    key !== firstKey &&
                    keySample.timestamp <= time + TIME_SLACK &&
                    earlier < EARLIER_KEYFRAMES;
                retrying = retry;
                const shown = index.shownAt(time + TIME_SLACK);
                skipBefore =
                    shown !== undefined && insidePresentationWindow(presented, shown)
                        ? shown
                        : Number.NEGATIVE_INFINITY;
                try {
                    for (
                        let ahead = await peek();
                        ahead && ahead.timing.timestamp <= time + TIME_SLACK;
                        ahead = await peek()
                    )
                        await take();
                    chosen = last ?? (await take());
                } finally {
                    retrying = false;
                    skipBefore = Number.NEGATIVE_INFINITY;
                }

                // A keyframe that decodes to no picture by the time (a sequence end code, a sample
                // marked as a sync sample that is not one) gives way to the keyframe before it.
                if (!retry || (chosen && chosen.timing.timestamp <= time + TIME_SLACK)) break;
                key = await entryBefore(keySample.timestamp - 1e-9);
                keySample = index.sample(key)!;
                seeked = true;
                await seek(key);
            }
            if (!chosen)
                throw new MediaForgeError(
                    `No video frame could be decoded near ` +
                        `${Math.round((time - file.timelineStart) * 1000) / 1000} s`,
                    'DECODE',
                );
            if (options.times === undefined && chosen.timing.timestamp <= shown) continue;
            shown = chosen.timing.timestamp;
            for (const frame of await render(chosen)) {
                yielded++;
                yield frame;
                lifetime.check();
            }
        }
        for (const frame of await finish()) yield frame;
    } finally {
        chain.close();
        for (const picture of outputs.splice(0)) picture.close();
        lifetime.stop();
        release(last);
        for (const entry of queue.splice(0)) release(entry);
        try {
            await packets?.return(undefined);
        } catch {}
        try {
            await decoder?.close();
        } catch {}
        try {
            await index.close();
        } catch {}
        linked.dispose();
    }
}

/**
 * Keyframes before the one preceding a time that frame extraction tries when that one decodes to no
 * picture.
 */
const EARLIER_KEYFRAMES = 4;

/**
 * Seconds a picture may start after a requested time and still be the one shown then: a time
 * computed as start + index / fps lands a rounding error before the picture that starts exactly at
 * it (30 + 1 / 12 against 722 / 24).
 */
const TIME_SLACK = 1e-6;

/** Encodes one RGBA frame as PNG anywhere, or as JPEG/WebP through OffscreenCanvas. */
export async function encodeFrameImage(
    frame: ExtractedFrame,
    to: 'png' | 'jpeg' | 'webp',
    quality: number | undefined,
): Promise<Blob> {
    assertPictureEncoder(to, 'thumbnails');
    // The image encoders load with the first picture.
    const { encodeJpeg, encodePng, encodeWebP } = await import('../../codecs/image/encoders');
    const encode = to === 'png' ? encodePng : to === 'jpeg' ? encodeJpeg : encodeWebP;
    return new Blob([await encode(frame, { quality })], { type: mimeTypeOf(to) });
}
