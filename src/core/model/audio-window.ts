import type { TrackInfo } from './track';
import { MediaForgeError } from '../errors/errors';

/**
 * Presentation samples declared by a track's edit at `rate`, never more than `available` coded
 * samples after the leading trim. The MP4 demuxer has already limited the edit to the coded media
 * and reported any overshoot, so the only remaining excess is unit conversion between the media
 * timescale and `rate`, which is absorbed here.
 */
export function editPresentationSamples(
    track: TrackInfo,
    rate: number,
    available: number,
    label: string,
): number {
    if (!Number.isSafeInteger(rate) || rate < 1 || !Number.isSafeInteger(available)) {
        throw new MediaForgeError(
            `${label} presentation window requires an integer sample rate and count`,
            'FORMAT',
        );
    }
    const units = track.editPresentationDurationUnits;
    const scale = track.timescale;
    let valid: number;
    if (units !== undefined && Number.isSafeInteger(scale) && scale! > 0) {
        valid = Number(
            (2n * BigInt(units) * BigInt(rate) + BigInt(scale!)) / (2n * BigInt(scale!)),
        );
    } else if (track.editPresentationDurationSeconds !== undefined) {
        valid = Math.round(track.editPresentationDurationSeconds * rate);
    } else {
        throw new MediaForgeError(`${label} has no presentation edit`, 'FORMAT');
    }
    return Math.min(valid, available);
}

/**
 * Rejects a head+valid window that the coded samples cannot supply; no rounding allowance is
 * applied here.
 */
export function assertPresentationWindow(
    label: string,
    encoded: number,
    head: number,
    valid: number,
): void {
    if (
        !Number.isSafeInteger(encoded) ||
        !Number.isSafeInteger(head) ||
        head < 0 ||
        !Number.isSafeInteger(valid) ||
        valid < 1 ||
        !Number.isSafeInteger(head + valid) ||
        encoded < head + valid
    ) {
        throw new MediaForgeError(
            `${label} edit runs past its ${encoded} encoded samples`,
            'FORMAT',
        );
    }
}

/**
 * Packet-layer seconds an MP4 edit list presents on its track: pictures and samples timed outside
 * it are decoded for reference only. Without an edit list, or without an edit duration, the window
 * is open on that side.
 */
export function editPresentationWindow(track: TrackInfo): {
    readonly start: number;
    readonly end: number;
} {
    if (track.editList === undefined || track.presentationTimestampsIncludeEdits !== true)
        return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
    const start = track.editLeadTimeSeconds ?? 0;
    const duration = track.editPresentationDurationSeconds;
    return { start, end: duration === undefined ? Number.POSITIVE_INFINITY : start + duration };
}

/**
 * True when a picture or packet starting at `timestamp` seconds lies inside `window` (to a
 * microsecond).
 */
export function insidePresentationWindow(
    window: { readonly start: number; readonly end: number },
    timestamp: number,
) {
    return timestamp >= window.start - 1e-6 && timestamp < window.end - 1e-6;
}
