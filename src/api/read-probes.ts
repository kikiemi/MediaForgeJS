import type { ProbeTarget } from '../core/model/track';
import { audioFormatCodec } from '../pipeline/plan/format-policy';
import type { FrameOptions, TargetOptions, ThumbnailOptions } from './types';

// How an operation first reads an input its reader can describe from its ends (a large MPEG-TS,
// Matroska or Ogg input). The functions open the input so, and a Media opened otherwise opens it
// again so for the operation; undefined reads the index of the whole input.

/**
 * convert(): a range from the window around it, timed as the index times it for a copy (a target
 * other than an audio file), a whole input once in file order.
 */
export function convertProbe({ start, end, to }: TargetOptions): ProbeTarget {
    return start !== undefined || end !== undefined
        ? {
              range: { start: start ?? 0, end },
              ...(audioFormatCodec(String(to).toLowerCase()) ? {} : { timed: true }),
          }
        : { stream: true };
}

/**
 * frames(): times that rise in one pass from the input's start, or for times of the first video
 * track after its start, from a window around them; others from the index, which earlier times
 * would otherwise read again.
 */
export function framesProbe({ times, trackId }: FrameOptions): ProbeTarget | undefined {
    if (!Array.isArray(times)) return { stream: true };
    if (!times.every((time, index) => index === 0 || time >= times[index - 1]!)) return undefined;
    return times.length > 0 &&
        trackId === undefined &&
        times.every(time => typeof time === 'number' && time >= 0 && Number.isFinite(time))
        ? { around: times[0], through: times.at(-1), stream: true }
        : { stream: true };
}

/** thumbnail(): around the picture of the first video track, and nothing to the input's end. */
export function thumbnailProbe({ time, trackId }: ThumbnailOptions): ProbeTarget | undefined {
    return trackId === undefined
        ? {
              around: typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : 0,
              windowOnly: true,
          }
        : undefined;
}
