import type { RemuxTrack } from '../media-types';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import { decodeTime } from '../../core/model/media-time';

/**
 * Leading samples inspected for the earliest time; reordered pictures settle within a few frames.
 */
const LEADING_SAMPLES = 32;

/**
 * The earliest presentation or decode time of the tracks' leading samples, or 0 without samples.
 */
export function leadingTime(tracks: readonly RemuxTrack[], decode: boolean): number {
    let earliest = Infinity;
    for (const track of tracks) {
        const count = Math.min(sampleCount(track.info), LEADING_SAMPLES);
        for (let position = 0; position < count; position++) {
            const sample = sampleAt(track.info, track.order?.[position] ?? position);
            if (sample)
                earliest = Math.min(earliest, decode ? decodeTime(sample) : sample.timestamp);
        }
    }
    return Number.isFinite(earliest) ? earliest : 0;
}
