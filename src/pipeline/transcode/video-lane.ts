import { MediaForgeError } from '../../core/errors/errors';
import { sampleAt } from '../../core/model/sample-index';
import { editPresentationWindow } from '../../core/model/audio-window';
import type { FrameTiming } from '../../codecs/webcodecs/video';
import type { MediaFile } from '../read/media-file';
import type { RemuxTrack } from '../media-types';
import type { VideoGeometry } from '../../stages/frame-geometry';
import type { FramePainter } from '../../stages/frame-transform';
import type { ResolvedFade } from './edit-types';
import { VideoStageChain } from '../../stages/chain';
import { Picture, type PictureData } from '../../stages/picture';
import { transformStage } from '../../stages/video';
import { openClipDecoder, releaseData, type DecodeSettings } from '../codecs/video-codecs';
import { decodeTime } from '../../core/model/media-time';
import { disposablePictures } from '../codecs/frame-codecs';
import type { ClipRead } from './shared-read';

/** Decoded pictures waiting for the stage chain. */
const MAX_PENDING_PICTURES = 32;
/**
 * Seconds within which a picture starting after the held one replaces it: the held one only reached
 * the time by a rounded duration (Matroska stores milliseconds), so the picture that starts there
 * is the one shown.
 */
const SUPERSEDED = 0.001;

/** One clip of the video timeline: the source range, its geometry, and where it lands. */
export interface VideoClip {
    readonly file: MediaFile;
    readonly track: RemuxTrack;
    readonly geometry: VideoGeometry;
    /** Packet-layer seconds of the source; `end` is exclusive. */
    readonly start: number;
    readonly end: number;
    readonly speed: number;
    /** Output seconds. */
    readonly offset: number;
    readonly duration: number;
    readonly fade: ResolvedFade;
    /** The read of the clip's input that the lanes of the conversion share. */
    readonly read: ClipRead;
}

/** How a lane decodes and draws its clips. */
export interface VideoLaneSettings extends DecodeSettings {
    readonly background: string;
    /**
     * What to draw over the picture of `clip` shown at an output time; undefined leaves it
     * untouched.
     */
    readonly paint?: (clip: VideoClip, time: number) => FramePainter | undefined;
    readonly onFrame?: (outputTime: number) => void;
    /** Turns decoded pictures into what the encoder takes before any stage runs. */
    readonly prepare?: (data: PictureData) => Promise<PictureData>;
}

/**
 * Decodes each clip from the keyframe at or before its start, keeps the pictures its range and the
 * track's edit list present, places them on the output timeline and runs them through the clip's
 * transform and then through `tail`, the stages shared by every clip.
 */
export async function renderVideoClips(
    clips: readonly VideoClip[],
    tail: VideoStageChain,
    settings: VideoLaneSettings,
): Promise<void> {
    for (const clip of clips) await renderClip(clip, tail, settings);
    settings.lifetime.check();
    await tail.finish();
}

async function renderClip(
    clip: VideoClip,
    tail: VideoStageChain,
    settings: VideoLaneSettings,
): Promise<void> {
    const { lifetime } = settings;
    const info = clip.track.info;
    const trackId = clip.track.description.id;
    const presented = editPresentationWindow(info);
    const from = Math.max(clip.start, presented.start);
    const to = Math.min(clip.end, presented.end);
    const paint = settings.paint;
    const chain = new VideoStageChain(
        [
            transformStage(clip.geometry, {
                background: settings.background,
                paint: paint && (time => paint(clip, time)),
            }),
        ],
        { width: clip.geometry.sourceWidth, height: clip.geometry.sourceHeight },
        picture => tail.push(picture),
    );
    const queue: ({ data: PictureData; timing: FrameTiming } | undefined)[] = [];
    let head = 0;
    let done = false;
    const take = (): { data: PictureData; timing: FrameTiming } | undefined => {
        if (head >= queue.length) return undefined;
        const entry = queue[head];
        queue[head++] = undefined;
        if (head === queue.length) queue.length = head = 0;
        return entry;
    };
    /** Ends a wait for the next picture while the decoder flushes. */
    let wake: (() => void) | undefined;
    const decoder = await openClipDecoder(info, settings, (data, timing) => {
        if (!lifetime.acceptingOutput || done) return releaseData(data);
        if (queue.length - head >= MAX_PENDING_PICTURES) {
            releaseData(data);
            lifetime.record(
                new MediaForgeError('The video decoder exceeded the picture queue budget', 'OOM'),
            );
            return;
        }
        queue.push({ data, timing });
        wake?.();
    });
    const clipEnd = clip.offset + clip.duration;
    // Each picture waits for the next, which replaces it when it starts at the same output time.
    let held: Picture | undefined;
    const show = async (picture: Picture): Promise<void> => {
        await chain.push(picture);
        settings.onFrame?.(picture.timestamp);
    };
    const drain = async (): Promise<void> => {
        for (let entry = take(); entry; entry = take()) {
            const { data, timing } = entry;
            if (timing.timestamp >= to) done = true;
            const shownFrom = Math.max(timing.timestamp, from);
            const shownTo = Math.min(timing.timestamp + Math.max(0, timing.duration), to);
            if (done || shownTo <= from) {
                releaseData(data);
                continue;
            }
            const outputTime = clip.offset + (shownFrom - clip.start) / clip.speed;

            // A picture shown whole at its own speed keeps its exact duration.
            const whole =
                clip.speed === 1 &&
                shownFrom === timing.timestamp &&
                shownTo === timing.timestamp + timing.duration;
            const duration = whole
                ? timing.duration
                : Math.max(
                      0,
                      Math.min(clipEnd, clip.offset + (shownTo - clip.start) / clip.speed) -
                          outputTime,
                  );
            const prepared = settings.prepare ? await settings.prepare(data) : data;
            const picture = new Picture(prepared, outputTime, duration);
            if (held && outputTime - held.timestamp < SUPERSEDED) held.close();
            else if (held) await show(held);
            held = picture;
        }
    };

    // Pictures that end before the clip and that no other picture refers to are not decoded.
    const disposable = disposablePictures(info);

    // Before the first keyframe decoding starts at the first packet, so the decoder reports the
    // packets it drops.
    const keyframe =
        clip.file.findSample(trackId, from, { keyframe: true, mode: 'before' }) ??
        clip.file.findSample(trackId, -Number.MAX_VALUE, { mode: 'after' }) ??
        0;
    const first = sampleAt(info, keyframe)!;

    // Ends a read still pending when the clip stops, so the packet reader can finish.
    const reading = new AbortController();
    const packets = clip.read.packets(clip.track, decodeTime(first), to, reading.signal);
    try {
        for (;;) {
            lifetime.check();
            const step = await lifetime.waitFor(packets.next());
            if (step.done || done) break;
            const packet = step.value;
            if (
                packet.duration > 0 &&
                packet.timestamp + packet.duration <= from &&
                disposable?.(packet.data)
            )
                continue;
            await decoder.decode(packet);
            await drain();
        }
        if (!done) {
            // The pictures of the flush are drained while it runs: a decoder that waits for its
            // pictures back (a GPU decoder) outputs only a few before.
            let flushed = false;
            const flushing = decoder.flush(true).then(() => {
                flushed = true;
            });
            flushing.catch(() => undefined);
            // Every picture is out before the flush settles, so the drain after it is the last.
            for (;;) {
                const ended = flushed;
                await drain();
                if (ended) break;
                if (head < queue.length) continue;
                const output = new Promise<void>(resolve => (wake = resolve));
                await lifetime.waitFor(Promise.race([flushing, output]));
                wake = undefined;
            }
        }
        const last = held;
        held = undefined;
        if (last) await show(last);
    } finally {
        held?.close();
        done = true;
        for (let entry = take(); entry; entry = take()) releaseData(entry.data);
        chain.close();
        reading.abort();
        try {
            await packets.return(undefined);
        } catch {
            // The packet reader of a stopped clip has nothing left to release.
        }
        await decoder.close();
    }
}
