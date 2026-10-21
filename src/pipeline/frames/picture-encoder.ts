import { MediaForgeError } from '../../core/errors/errors';
import { HOST_ONLY_IMAGE_FORMATS } from '../../codecs/image/host-formats';

/**
 * Fails where pictures of `format` cannot be encoded, before anything is decoded: JPEG, WebP, AVIF,
 * HEIF and JPEG XL go through OffscreenCanvas (`HOST_ONLY_IMAGE_FORMATS`), the library's formats
 * anywhere. `what` names them as the call does: a thumbnail(), or the picture of an image target.
 */
export function assertPictureEncoder(format: string, what: 'thumbnails' | 'pictures'): void {
    if (
        (HOST_ONLY_IMAGE_FORMATS as readonly string[]).includes(format) &&
        (typeof OffscreenCanvas !== 'function' || typeof ImageData !== 'function')
    )
        throw new MediaForgeError(
            `${format.toUpperCase()} ${what} need OffscreenCanvas`,
            'ENCODE',
            {
                hint: what === 'thumbnails' ? "Ask for to: 'png'." : "Ask for 'png'.",
            },
        );
}
