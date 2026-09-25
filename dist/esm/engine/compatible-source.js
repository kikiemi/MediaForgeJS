import { RangeSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { awaitWithAbort } from '../core/abort.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
export async function compatibleMp4Source(source, diagnostics, signal) {
    const reader = new ChunkReader(source);
    let offset = 0;
    let movie = false;
    let media = false;
    let fragment = false;
    for (let count = 0; offset < source.size; count++) {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        if (count >= 65536)
            throw new DemuxError('MP4 top-level box count exceeds the inspection budget');
        if ((count & 255) === 0)
            await yieldEventLoop();
        const header = await awaitWithAbort(reader.bytes(offset, 16), signal);
        const ignoreTail = (message) => {
            diagnostics.warn({ code: 'MP4_OPTIONAL_TAIL', message, format: 'mp4', offset });
            return new RangeSource(source, 0, offset);
        };
        if (header.length < 8) {
            if (movie && media)
                return ignoreTail('Ignored incomplete bytes after all complete MP4 boxes');
            throw new DemuxError('Truncated MP4 box header');
        }
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let size = view.getUint32(0);
        const kind = String.fromCharCode(...header.subarray(4, 8));
        const headerSize = size === 1 ? 16 : 8;
        if (size === 1) {
            if (header.length < 16) {
                if (movie && media && fragment && kind === 'moof' && diagnostics.validation === 'compatible')
                    return source;
                if (movie && media && ['free', 'skip', 'uuid', 'mfra'].includes(kind))
                    return ignoreTail(`Ignored truncated optional ${kind} box`);
                throw new DemuxError('Truncated MP4 extended box header');
            }
            const extended = view.getBigUint64(8);
            if (extended > BigInt(Number.MAX_SAFE_INTEGER))
                throw new DemuxError('MP4 box length exceeds the safe integer range');
            size = Number(extended);
        }
        else if (size === 0)
            size = source.size - offset;
        if (size < headerSize || size > source.size - offset) {
            if (movie &&
                media &&
                fragment &&
                kind === 'moof' &&
                size >= headerSize &&
                size > source.size - offset &&
                diagnostics.validation === 'compatible')
                return source;
            if (movie && kind === 'mdat' && size >= headerSize && size > source.size - offset) {
                diagnostics.recover({
                    code: 'MP4_TRUNCATED_MDAT',
                    message: 'MP4 media data extends past EOF; only complete samples from intact movie metadata can be recovered',
                    format: 'mp4',
                    offset,
                });
                return source;
            }
            if (movie && media && ['free', 'skip', 'uuid', 'mfra'].includes(kind))
                return ignoreTail(`Ignored damaged optional ${kind} tail`);
            throw new DemuxError(`Invalid MP4 ${kind} box length`);
        }
        movie ||= kind === 'moov';
        media ||= kind === 'mdat';
        fragment ||= kind === 'moof';
        offset += size;
    }
    return source;
}
