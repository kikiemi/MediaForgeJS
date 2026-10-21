import { inflateBounded } from '../../../core/io/inflate';
import {
    COMPRESSION_LZO,
    COMPRESSION_ZLIB,
    MAX_DECOMPRESSED_BYTES,
    type ContentCompression,
    type WebMTrack,
} from './track-entry';
import { readVint, vintLength } from '../ebml';
import { laceFrames } from './lacing';

/** Undoes a zlib, LZO1X or header-stripping ContentCompression of one frame or CodecPrivate. */
export async function decompress(
    compression: ContentCompression,
    data: Uint8Array,
    what: string,
    signal: AbortSignal | undefined,
): Promise<Uint8Array> {
    if (compression.algorithm === COMPRESSION_ZLIB)
        return inflateBounded([data], MAX_DECOMPRESSED_BYTES, what, signal);
    if (compression.algorithm === COMPRESSION_LZO)
        return (await import('./lzo')).lzo1xDecompress(data, MAX_DECOMPRESSED_BYTES, what);
    const restored = new Uint8Array(compression.settings.length + data.length);
    restored.set(compression.settings);
    restored.set(data, compression.settings.length);
    return restored;
}

/**
 * The frames of a Block body whose track compresses them with zlib or LZO1X, decompressed in lacing
 * order; `sizes` is scratch for the frame sizes.
 */
export async function decompressFrames(
    buf: Uint8Array,
    start: number,
    end: number,
    tracks: Map<number, WebMTrack>,
    sizes: Float64Array,
    signal: AbortSignal | undefined,
): Promise<Uint8Array[] | undefined> {
    const track = tracks.get(readVint(buf, start, end, 'unsigned'));
    const compression = track?.frameCompression;
    const pos = start + vintLength;
    if (!compression || pos + 3 > end) return undefined;
    const { count, framesStart } = laceFrames(
        buf,
        pos + 3,
        end,
        (buf[pos + 2]! >> 1) & 0x03,
        sizes,
    );

    const frameSizes = Array.from(sizes.subarray(0, count));
    const frames: Uint8Array[] = [];
    for (let i = 0, at = framesStart; i < count; at += frameSizes[i]!, i++)
        frames.push(
            await decompress(
                compression,
                buf.subarray(at, at + frameSizes[i]!),
                'Matroska frame',
                signal,
            ),
        );

    return frames;
}
