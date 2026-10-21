import type { MediaFile } from '../read/media-file';
import { mediaFileState } from '../read/file-state';
import { MediaForgeError } from '../../core/errors/errors';
import { OptionNormalizer, resolveOptionPolicy } from '../../core/errors/option-policy';
import type { BuiltinVideoCodec } from '../../core/contracts/decoder';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import {
    encodeFrameImage,
    extractFrames,
    type FrameDecoders,
    type FrameExtraction,
    type ThumbnailExtraction,
} from './frame-extract';
import type { CodecPreference, Frame } from '../api-types';

/**
 * The decoders frame extraction tries on `file`, with damage reported through the file's warnings.
 */
export function frameDecoders(
    file: MediaFile,
    decoders: readonly BuiltinVideoCodec[],
    preference: CodecPreference,
    providers: readonly VideoCodecProvider[],
): FrameDecoders {
    const diagnostics = mediaFileState(file).diagnostics;
    return {
        decoders,
        preference,
        providers,
        missing: mediaFileState(file).missing,
        recovery: {
            strict: diagnostics.validation === 'strict',
            warn: (code, message) => diagnostics.warn({ code, message }),
        },
    };
}

/**
 * Repairs of settings that do not fit the input follow the file's validation: strict rejects,
 * otherwise they warn.
 */
function repairsFor(file: MediaFile, scope: string): OptionNormalizer {
    return new OptionNormalizer(
        resolveOptionPolicy(mediaFileState(file).diagnostics.validation),
        scope,
    );
}

/** The pictures of `file` as Frame RGBA or VideoFrame objects. */
export function fileFrames(
    file: MediaFile,
    extraction: FrameExtraction,
    decoders: FrameDecoders,
): AsyncGenerator<Frame | VideoFrame> {
    return extractFrames(file, extraction, decoders, repairsFor(file, 'frame options'));
}

/** One picture of `file` as a PNG, JPEG or WebP Blob; JPEG and WebP need OffscreenCanvas. */
export async function fileThumbnail(
    file: MediaFile,
    thumbnail: ThumbnailExtraction,
    decoders: FrameDecoders,
): Promise<Blob> {
    const { time, to, quality, ...geometry } = thumbnail;
    const frames = extractFrames(
        file,
        { ...geometry, times: [time], maxFrames: 1 },
        decoders,
        repairsFor(file, 'thumbnail options'),
    );
    try {
        const first = await frames.next();
        if (first.done)
            throw new MediaForgeError(
                'No video frame could be decoded for the thumbnail',
                'DECODE',
            );
        return await encodeFrameImage(first.value, to, quality);
    } finally {
        await frames.return(undefined);
    }
}
