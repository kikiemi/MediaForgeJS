import type { SegmentOptions } from '../packet-types';
import { MediaForgeError } from '../../core/errors/errors';
import { assertAbortSignal } from '../../core/io/abort';
import { positiveLimit } from '../../core/errors/limits';

/**
 * Whether a field that segment and remux options share, read once from the options, has a value of
 * the wrong kind.
 */
export function invalidSegmentFields({
    targetDuration,
    requireKeyframe,
    trackIds,
}: SegmentOptions): boolean {
    return (
        (targetDuration !== undefined &&
            (!Number.isFinite(targetDuration) || targetDuration <= 0)) ||
        (requireKeyframe !== undefined && typeof requireKeyframe !== 'boolean') ||
        (trackIds !== undefined && !Array.isArray(trackIds))
    );
}

export function checkBufferLimits({ maxBufferedBytes, maxBufferedSamples }: SegmentOptions): void {
    if (maxBufferedBytes !== undefined) positiveLimit(maxBufferedBytes, 1, 'maxBufferedBytes');
    if (maxBufferedSamples !== undefined)
        positiveLimit(maxBufferedSamples, 1, 'maxBufferedSamples');
}

/** A copy of segment options, checked. */
export function snapshotSegments(options: SegmentOptions): SegmentOptions {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected segment options', 'INPUT');
    const {
        trackIds,
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
    } = options;
    assertAbortSignal(signal);
    if (invalidSegmentFields({ targetDuration, requireKeyframe, trackIds }))
        throw new MediaForgeError('Invalid segment options', 'INPUT');
    checkBufferLimits({ maxBufferedBytes, maxBufferedSamples });
    return {
        trackIds: trackIds?.slice(),
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
    };
}
