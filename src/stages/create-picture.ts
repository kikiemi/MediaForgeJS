import { MediaForgeError } from '../core/errors/errors';
import type { VideoPicture } from '../core/contracts/stage';
import { Picture } from './picture';

/**
 * A new picture of straight RGBA8 pixels (width × height × 4 bytes) shown at `timestamp` for
 * `duration` seconds.
 */
export function createPicture(init: {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
    readonly duration: number;
    /** Asks the encoder to start a keyframe at this picture; default false. */
    readonly keyframe?: boolean;
}): VideoPicture {
    const { data, width, height, timestamp, duration, keyframe = false } = init ?? {};
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new MediaForgeError(
            'createPicture width and height must be positive integers',
            'INPUT',
        );
    if (
        !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
        data.length !== width * height * 4
    )
        throw new MediaForgeError('createPicture needs width × height × 4 RGBA bytes', 'INPUT');
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0)
        throw new MediaForgeError('createPicture timing must be finite seconds', 'INPUT');
    if (typeof keyframe !== 'boolean')
        throw new MediaForgeError('createPicture keyframe must be a boolean', 'INPUT');
    const bytes =
        data instanceof Uint8Array
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Picture(
        { kind: 'rgba', data: bytes, width, height },
        timestamp,
        duration,
        undefined,
        keyframe,
    );
}
