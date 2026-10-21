import type { Source } from '../../../core/model/types';
import { BufferSource, RangeSource } from '../../../core/io/sources/sources';
import { ConcatSource } from '../../../core/io/sources/concat-source';
import { WindowReader, type ByteReader } from '../../../core/io/sources/chunk-reader';
import { uncachedReads } from '../../../core/io/sources/cached-source';
import { DiagnosticContext } from '../../../core/errors/diagnostics';
import { awaitWithAbort } from '../../../core/io/abort';
import { DemuxError, throwIfAborted } from '../../../core/errors/errors';
import { DEMUX_LIMITS } from '../../shared/demux-budget';
import { yieldEventLoop } from '../../../core/io/event-loop';
import { TOP_LEVEL_TYPES } from './boxes';
import { dataView } from '../../../core/bytes/byte-fields';

/**
 * The top-level boxes a complete walk read, by offset: each box's header bytes and, for a fragment
 * header (moof) that came with the walk's read, the whole box. The demuxer reads them from here
 * instead of walking again.
 */
const walkedBoxes = new WeakMap<Source, Map<number, Uint8Array>>();

/**
 * A reader of `source` that answers reads at walked box offsets from the walk and reads the rest
 * through `fallback`. The walk is handed over once.
 */
export function walkedBoxReader(source: Source, fallback: ByteReader): ByteReader {
    const boxes = walkedBoxes.get(source);
    walkedBoxes.delete(source);
    if (!boxes) return fallback;
    return {
        size: fallback.size,
        bytes(pos, len) {
            const view = boxes.get(pos);
            const count = Math.min(len, fallback.size - pos);
            return view && count >= 0 && count <= view.length
                ? Promise.resolve(view.subarray(0, count))
                : fallback.bytes(pos, len);
        },
    };
}

/**
 * The input with the movie box at `start` of `declared` bytes repaired to end where the box after
 * it starts (see repairedMovieBox), or undefined when compatible reading does not apply or no such
 * end explains the box.
 */
async function withRepairedMovie(
    source: Source,
    diagnostics: DiagnosticContext,
    start: number,
    declared: number,
): Promise<Source | undefined> {
    if (diagnostics.validation !== 'compatible') return undefined;
    const { repairedMovieBox, movieRepaired } = await import('./movie-repair');
    const repaired = await repairedMovieBox(source, start, declared);
    if (!repaired) return undefined;
    diagnostics.recover(movieRepaired(start));
    const parts: Source[] = [
        new RangeSource(source, 0, start),
        new BufferSource(repaired.bytes, { copy: false }),
    ];
    if (repaired.end < source.size)
        parts.push(new RangeSource(source, repaired.end, source.size - repaired.end));
    return new ConcatSource(parts);
}

/** Inspects top-level boxes; recovery never invents missing metadata or media bytes. */
export async function compatibleMp4Source(
    source: Source,
    diagnostics: DiagnosticContext,
    signal?: AbortSignal,
    repaired = false,
): Promise<Source> {
    const reader = new WindowReader(source.size, uncachedReads(source));
    let offset = 0;
    let movie = false;
    let media = false;
    let fragment = false;
    /** The last movie box, while only boxes of unknown types followed it. */
    let movieBox: { start: number; size: number } | undefined;
    const boxes = new Map<number, Uint8Array>();
    for (let count = 0; offset < source.size; count++) {
        throwIfAborted(signal);
        if (count >= DEMUX_LIMITS.maxTopLevelBoxes)
            throw new DemuxError('MP4 top-level box count exceeds the inspection budget');
        if (count > 0 && (count & 255) === 0) await yieldEventLoop();
        const header = await awaitWithAbort(reader.bytes(offset, 16), signal);
        const ignoreTail = (message: string): Source => {
            diagnostics.warn({ code: 'MP4_OPTIONAL_TAIL', message, format: 'mp4', offset });
            return new RangeSource(source, 0, offset);
        };
        if (header.length < 8) {
            if (movie && media)
                return ignoreTail('Ignored incomplete bytes after all complete MP4 boxes');
            throw new DemuxError('Truncated MP4 box header');
        }
        const view = dataView(header);
        let size = view.getUint32(0);
        const kind = String.fromCharCode(...header.subarray(4, 8));
        const headerSize = size === 1 ? 16 : 8;
        if (size === 1) {
            if (header.length < 16) {
                if (
                    movie &&
                    media &&
                    fragment &&
                    kind === 'moof' &&
                    diagnostics.validation === 'compatible'
                )
                    return source;
                if (movie && media && ['free', 'skip', 'uuid', 'mfra'].includes(kind))
                    return ignoreTail(`Ignored truncated optional ${kind} box`);
                throw new DemuxError('Truncated MP4 extended box header');
            }
            const extended = view.getBigUint64(8);
            if (extended > BigInt(Number.MAX_SAFE_INTEGER))
                throw new DemuxError('MP4 box length exceeds the safe integer range');
            size = Number(extended);
        } else if (size === 0) size = source.size - offset;
        if (size < headerSize || size > source.size - offset) {
            // A movie box whose size disagrees with where the next box starts, so that the walk
            // went on inside it or inside the media: one of its own boxes was lost or duplicated,
            // or its size field was damaged.
            const repairedSource =
                !repaired &&
                movieBox &&
                (await withRepairedMovie(source, diagnostics, movieBox.start, movieBox.size));
            if (repairedSource)
                return compatibleMp4Source(repairedSource, diagnostics, signal, true);
            if (
                movie &&
                media &&
                fragment &&
                kind === 'moof' &&
                size >= headerSize &&
                size > source.size - offset &&
                diagnostics.validation === 'compatible'
            )
                return source;
            if (movie && kind === 'mdat' && size >= headerSize && size > source.size - offset) {
                diagnostics.recover({
                    code: 'MP4_TRUNCATED_MDAT',
                    message: 'MP4 media data is cut by the end of the input',
                    format: 'mp4',
                    offset,
                });
                return source;
            }

            // A movie box after the media, cut by the end of the input: the demuxer keeps it when
            // only trailing optional children (udta, meta, free) are lost and reports the recovery
            // itself.
            if (
                !movie &&
                media &&
                kind === 'moov' &&
                size >= headerSize &&
                size > source.size - offset
            )
                return source;
            if (movie && media && ['free', 'skip', 'uuid', 'mfra'].includes(kind))
                return ignoreTail(`Ignored damaged optional ${kind} tail`);
            if (movie && media && !fragment && size >= headerSize) {
                diagnostics.recover({
                    code: 'MP4_TRUNCATED_TAIL',
                    message: `Ignored a ${kind} box cut by the end of the input`,
                    format: 'mp4',
                    offset,
                });
                return new RangeSource(source, 0, offset);
            }

            // A movie box before the media whose size field runs past the end.
            const resized =
                !repaired &&
                kind === 'moov' &&
                size >= headerSize &&
                (await withRepairedMovie(source, diagnostics, offset, size));
            if (resized) return compatibleMp4Source(resized, diagnostics, signal, true);

            // A box after a complete movie box whose header damage made unreadable: the samples
            // are read where the movie box places them, as ffmpeg reads them.
            if (movie && !fragment && diagnostics.validation === 'compatible') {
                diagnostics.recover({
                    code: 'MP4_DAMAGED_BOX',
                    message: `Ignored a damaged box at byte ${offset} and what follows it`,
                    format: 'mp4',
                    offset,
                });
                return source;
            }
            throw new DemuxError(`Invalid MP4 ${kind} box length`);
        }
        if (kind === 'moov') movieBox = { start: offset, size };
        else if (TOP_LEVEL_TYPES.has(kind)) movieBox = undefined;
        movie ||= kind === 'moov';
        media ||= kind === 'mdat';
        fragment ||= kind === 'moof';
        boxes.set(offset, (kind === 'moof' && reader.retained(offset, size)) || header.slice());
        offset += size;
    }
    walkedBoxes.set(source, boxes);
    return source;
}
