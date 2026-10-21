import type { RemuxOptions } from '../media-types';
import { REMUX_FORMATS } from './copy-formats';
import { MediaForgeError } from '../../core/errors/errors';
import { assertAbortSignal } from '../../core/io/abort';
import { checkBufferLimits, invalidSegmentFields } from '../read/segment-options';

/** A copy of remux options, checked. */
export function snapshotRemux(options: RemuxOptions): RemuxOptions {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected remux options', 'INPUT');
    const {
        format,
        trackIds,
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
        onProgress,
        start,
        end,
    } = options;

    assertAbortSignal(signal);
    if (!REMUX_FORMATS.includes(format)) {
        throw new MediaForgeError('Unsupported remux format', 'FORMAT');
    }
    if (
        invalidSegmentFields({ targetDuration, requireKeyframe, trackIds }) ||
        (onProgress !== undefined && typeof onProgress !== 'function')
    )
        throw new MediaForgeError('Invalid remux options', 'INPUT');
    if (
        (start !== undefined && (!Number.isFinite(start) || start < 0)) ||
        (end !== undefined && (!Number.isFinite(end) || end <= (start ?? 0)))
    )
        throw new MediaForgeError(
            'start must be a nonnegative number of seconds and end must follow it',
            'INPUT',
        );
    checkBufferLimits({ maxBufferedBytes, maxBufferedSamples });

    return {
        format,
        trackIds: trackIds?.slice(),
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
        onProgress,
        start,
        end,
    };
}
