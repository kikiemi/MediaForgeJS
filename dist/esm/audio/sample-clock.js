import { MediaForgeError } from '../core/errors.js';
export function sampleClockTolerance(track, minimum = 0.5) {
    const resolution = track.timestampResolutionSeconds;
    if (resolution === undefined)
        return minimum;
    if (!Number.isFinite(resolution) || resolution <= 0)
        throw new MediaForgeError('Audio timestamp resolution must be positive and finite', 'DEMUX');
    return Math.max(minimum, resolution * track.sampleRate + 1e-7);
}
