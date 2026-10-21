import type { Frame } from '../pipeline/api-types';
import type { ProbeTarget } from '../core/model/track';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { OptionNormalizer } from '../core/errors/option-policy';
import { withHint } from './hints';
import { framesProbe as framesRead, thumbnailProbe as pictureRead } from './read-probes';
import { readPlan, readWith, type MediaContext, type MediaReading } from './media-reads';
import { progressReporter } from './operation';
import { mediaResult } from './results';
import { warningOf } from './options/options';
import { snapshotFrameOptions, snapshotThumbnailOptions } from './options/requests';
import type { Describe } from './operations';
import type { FrameOptions, MediaResult, ThumbnailOptions } from './types';

// thumbnail() and frames(): they decode pictures and plan no copy, so they load without the
// conversion API (api/operations) and the copy it imports.

export { withHint };

/**
 * What thumbnail() and frames() run once the input is open, started as it opens (as
 * pipeline/plan/operation-loads does for convert()): the decoding of pictures, which loads with
 * these operations, and the PNG encoder for `png`.
 */
function prefetchPictures(png: boolean): void {
    const loads = [
        import('../pipeline/frames/frames'),
        ...(png ? [import('../codecs/image/encoders')] : []),
    ];
    for (const load of loads) load.catch(() => undefined);
}

/** framesProbe(), the code that decodes the pictures loading while the input opens. */
export function framesProbe(settings: FrameOptions): ProbeTarget | undefined {
    prefetchPictures(false);
    return framesRead(settings);
}

/** thumbnailProbe(), the code that decodes and encodes the picture loading as the input opens. */
export function thumbnailProbe(settings: ThumbnailOptions): ProbeTarget | undefined {
    prefetchPictures((settings.to ?? 'png') === 'png');
    return pictureRead(settings);
}

/** Settings of frames() and thumbnail() are read under the option policy of the MediaForge. */
function settingsNormalizer(media: MediaContext, scope: string): OptionNormalizer {
    return new OptionNormalizer(media.session.optionPolicy, scope);
}

/** Option findings reach the caller's listener and the running operation's warnings. */
function forwardFindings(media: MediaContext, normalizer: OptionNormalizer): void {
    for (const finding of normalizer.findings) media.session.warn(warningOf(finding));
}

function isRgbaFrame(frame: Frame | VideoFrame): frame is Frame {
    return (frame as Frame).data instanceof Uint8Array;
}

/** Media.frames() on a snapshot of its settings, read as framesProbe() says. */
export async function* frames(
    reading: MediaReading,
    settings: FrameOptions,
): AsyncGenerator<Frame | VideoFrame> {
    const plan = await readPlan(reading, framesProbe(settings), settings.signal);
    try {
        yield* framesOf(plan.context, settings);
    } finally {
        plan.release();
    }
}

/** frames() of the file it reads. */
async function* framesOf(
    media: MediaContext,
    settings: FrameOptions,
): AsyncGenerator<Frame | VideoFrame> {
    const { onProgress, ...request } = settings;
    const normalizer = settingsNormalizer(media, 'frame options');
    const settled = snapshotFrameOptions(request, normalizer, media.engine.stages);
    forwardFindings(media, normalizer);

    // Requested and reported times count from the input's start; packet times carry an MPEG-TS
    // clock.
    const base = media.file.timelineStart;
    const extraction = settled.times
        ? { ...settled, times: settled.times.map(time => base + time) }
        : settled;
    const track = media.file.tracks.find(candidate =>
        extraction.trackId === undefined
            ? candidate.type === 'video'
            : candidate.id === extraction.trackId,
    );
    const duration = track?.duration || undefined;
    const progress = progressReporter(onProgress, 'decode', duration);
    const count = extraction.times?.length;
    let index = 0;
    try {
        for await (const decoded of media.engine.frames(media.file, extraction) as AsyncGenerator<
            Frame | VideoFrame
        >) {
            const frame = base > 0 ? fromStart(decoded, base) : decoded;
            index++;
            if (progress.callback) {
                const time = Math.max(
                    0,
                    isRgbaFrame(frame) ? frame.timestamp : frame.timestamp / 1e6,
                );
                progress.callback({
                    fraction: count ? index / count : duration ? time / duration : 0,
                    time,
                });
            }
            yield frame;
        }
        progress.finish();
    } catch (error) {
        throw withHint(error, { kind: 'frames' });
    }
}

/**
 * `frame` with its time counted from `base` seconds; a VideoFrame is replaced by a re-timed one.
 */
function fromStart(frame: Frame | VideoFrame, base: number): Frame | VideoFrame {
    if (isRgbaFrame(frame)) return { ...frame, timestamp: frame.timestamp - base };
    try {
        return new VideoFrame(frame, { timestamp: frame.timestamp - Math.round(base * 1e6) });
    } finally {
        frame.close();
    }
}

/** Media.thumbnail() on a snapshot of its settings, read as thumbnailProbe() says. */
export function thumbnail(
    reading: MediaReading,
    settings: ThumbnailOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<MediaResult> {
    return readWith(reading, thumbnailProbe(settings), settings.signal, media =>
        thumbnailOf(media, settings, warnings, describe),
    );
}

/** thumbnail() of the file it reads. */
async function thumbnailOf(
    media: MediaContext,
    settings: ThumbnailOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<MediaResult> {
    describe({ kind: 'image', format: typeof settings.to === 'string' ? settings.to : 'png' });
    const normalizer = settingsNormalizer(media, 'thumbnail options');
    const picture = snapshotThumbnailOptions(settings, normalizer, media.engine.stages);
    forwardFindings(media, normalizer);
    const blob = await media.engine.thumbnail(media.file, {
        ...picture,
        time: media.file.timelineStart + picture.time,
    });
    const format =
        blob.type === 'image/jpeg' ? 'jpeg' : blob.type === 'image/webp' ? 'webp' : 'png';
    return mediaResult(
        blob,
        format,
        { format, action: 'image', tracks: [] },
        warnings,
        media.input,
    );
}
