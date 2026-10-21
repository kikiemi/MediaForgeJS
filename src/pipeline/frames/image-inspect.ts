import type { Source, MediaInput } from '../../core/model/types';
import type { ContainerFormat, GainMap } from '../../core/model/media';
import type { MediaTrack } from '../../core/model/media';
import type { MediaInfo } from '../api-types';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';
import { CONTAINER_IMAGE_FORMATS, IMAGE_FORMATS } from '../plan/format-policy';
import { prefetchOpening } from '../read/reader-modules';
import { withTrackJson } from '../../formats/metadata/track-json';
import { sourceOf } from '../../core/io/sources/sources';

const MAX_INSPECTED_IMAGE_BYTES = 256 * 1024 * 1024;

/** The media formats whose readers detection started loading. */
const prefetched = new Set<string>();

/**
 * `format` (an input's, as open() detects it) where it is an image's, which its converter reads
 * whole; undefined for a media input, whose reader starts loading. It loads with the engine, so
 * detecting an input loads none of the conversion code.
 */
export function imageFormatOf(format: string): ContainerFormat | undefined {
    if (IMAGE_FORMATS.has(format as ContainerFormat)) return format as ContainerFormat;
    if (!prefetched.has(format)) {
        prefetched.add(format);
        prefetchOpening(format);
    }
    return undefined;
}

/** The container facts of an image input in `format` as an inspection with one picture track. */
export async function inspectImageInput(
    input: Source | MediaInput,
    format: ContainerFormat,
    signal?: AbortSignal,
): Promise<MediaInfo> {
    const source = sourceOf(input);

    if (source.size > MAX_INSPECTED_IMAGE_BYTES)
        throw new MediaForgeError('Image exceeds the 256 MiB inspection limit', 'OOM');
    const bytes = await awaitWithAbort(source.read(0, source.size), signal);
    throwIfAborted(signal);

    let width = 0;
    let height = 0;
    let codec: string = format;
    let sampleCount = 1;
    let duration = 0;
    let framerate: number | undefined;
    let rotation: number | undefined;
    let gainMap: GainMap | undefined;
    if (CONTAINER_IMAGE_FORMATS.has(format)) {
        const { parseImageInfo } = await import('../../core/codec-config/image-info');
        const info = parseImageInfo(bytes, format);
        width = info.width;
        height = info.height;
        codec = info.codec;
        sampleCount = info.frameCount ?? (info.animated ? 0 : 1);
        duration = (info.durationMs ?? 0) / 1000;
        if (info.frameCount && info.durationMs)
            framerate = (info.frameCount * 1000) / info.durationMs;
        rotation = info.rotation || undefined;
        gainMap = info.gainMap;
    } else {
        const { sniffImageDimensions } = await import('../../formats/images/dimensions');
        const dims = sniffImageDimensions(bytes.subarray(0, 262144));
        width = dims?.width ?? 0;
        height = dims?.height ?? 0;
        if (format === 'jpeg') {
            codec = 'mjpeg';
            const { jpegGainMap } = await import('../../core/codec-config/gain-map');
            gainMap = jpegGainMap(bytes);
        }
    }

    const track: MediaTrack = withTrackJson({
        id: 1,
        type: 'video',
        codec,
        width: width || undefined,
        height: height || undefined,
        framerate,
        ...(rotation ? { rotation } : {}),
        ...(gainMap ? { gainMap } : {}),
        duration,
        sampleCount,
    });
    return { format, tracks: [Object.freeze(track)], warnings: [] };
}
