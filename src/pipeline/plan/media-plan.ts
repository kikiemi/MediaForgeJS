import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import type { MediaTrack } from '../../core/model/media';
import type { MediaPlan, TrackPlan } from '../api-types';

/**
 * Building the one plan model every operation reports: the output format, what happens to each kept
 * track (copied, or encoded with its codec, encoder, output shape and stages) and the seconds the
 * output covers.
 */

/** Seconds the tracks cover, limited to the requested range. */
export function coveredDuration(
    tracks: readonly { readonly duration: number }[],
    start: number | undefined,
    end: number | undefined,
): number | undefined {
    const length = Math.max(0, ...tracks.map(track => track.duration || 0));
    if (!length) return undefined;
    const from = Math.min(start ?? 0, length);
    return Math.max(0, Math.min(end ?? length, length) - from);
}

/** Output seconds of `duration` source seconds played at `speed`. */
export function speedDuration(duration: number | undefined, speed = 1): number | undefined {
    return duration === undefined ? undefined : duration / speed;
}

/** The plan entry of a track whose packets are copied. */
export function copiedTrackPlan(track: Pick<MediaTrack, 'id' | 'type' | 'codec'>): TrackPlan {
    return {
        trackId: track.id,
        type: track.type as TrackPlan['type'],
        action: 'copy',
        sourceCodec: track.codec,
        codec: track.codec,
    };
}

/**
 * The plan of copying `tracks` into `format`, or of packaging them, over the `start`–`end` range.
 */
export function copyPlan(
    format: string,
    tracks: readonly MediaTrack[],
    range: { readonly start?: number; readonly end?: number } = {},
    action: 'copy' | 'package' = 'copy',
): MediaPlan {
    return {
        format,
        action,
        tracks: tracks.map(copiedTrackPlan),
        duration: coveredDuration(tracks, range.start, range.end),
    };
}

/** The tracks of `tracks` that `trackIds` selects, all of them when it names none. */
export function selectedTracks(
    tracks: readonly MediaTrack[],
    trackIds: readonly number[] | undefined,
): readonly MediaTrack[] {
    return tracks.filter(track => trackIds === undefined || trackIds.includes(track.id));
}

/**
 * The plan after the work: audio tracks the host encoder handed over to the library are marked
 * builtin.
 */
export function settledPlan<T extends MediaPlan>(plan: T, warnings: readonly MediaDiagnostic[]): T {
    if (!warnings.some(warning => warning.code === 'AUDIO_ENCODER_FALLBACK')) return plan;
    return {
        ...plan,
        tracks: plan.tracks.map(track =>
            track.type === 'audio' && track.action === 'encode'
                ? { ...track, encoder: 'builtin' }
                : track,
        ),
    };
}
