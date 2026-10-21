import type { ContainerFormat } from '../core/model/media';
import { yieldEventLoop } from '../core/io/event-loop';
import { firstFlacFrame, parseFlacFrameHeader } from '../core/codec-config/audio/flac-frame';
import {
    ftypFormat,
    MP4_DECISIVE,
    MP4_TOP_BOXES,
    SNIFF_WINDOW_BYTES,
    type SniffWindowReader,
} from './detection/signatures';
import { indexOfPattern, MXF_PARTITION_KEY, MXF_RUN_IN_LIMIT } from './detection/head-bytes';
import { u32be } from '../core/bytes/byte-fields';

const MAX_MP4_SNIFF_BOXES = 65_536;

/** Bytes after an ID3v2 tag searched for the first frames of the audio it tags. */
const TAGGED_AUDIO_SEARCH_BYTES = 64 * 1024;

/**
 * Formats the sniff prefix does not identify: MP4 boxes that reach a decisive box past it, an MXF
 * run-in longer than it, headerless FLAC whose first whole frame lies past it, or, after an ID3v2
 * tag (`offset` past it), MPEG audio or ADTS frames that start past it, as when damage left part of
 * the tag's picture after the size the tag declares; ffmpeg finds them the same way.
 */
export async function deepSniff(
    reader: SniffWindowReader,
    offset: number,
): Promise<ContainerFormat | null> {
    const found =
        (await sniffMp4FamilyDeep(reader, offset)) ?? (await sniffMxfDeep(reader, offset));
    reader.checkAbort();
    if (found) return found;
    const window = await reader.read(offset, SNIFF_WINDOW_BYTES);
    reader.checkAbort();
    if (confirmedFlacFrames(window)) return 'flac';
    if (offset === 0) return null;
    const { sniffAudioFrameChain } = await import('./stream-format');
    return sniffAudioFrameChain(window.subarray(0, TAGGED_AUDIO_SEARCH_BYTES));
}

/**
 * Whether `h` holds a FLAC frame header that the next frame header found confirms (same stream
 * parameters, next frame or sample number): a headerless stream whose first whole frame lies past
 * the sniff prefix, as large multichannel frames do.
 */
function confirmedFlacFrames(h: Uint8Array): boolean {
    for (let at = firstFlacFrame(h); at >= 0;) {
        const first = parseFlacFrameHeader(h, at)!;
        const next = firstFlacFrame(h, at + first.headerLen);
        if (next < 0) return false;
        const second = parseFlacFrameHeader(h, next)!;
        if (
            second.sampleRate === first.sampleRate &&
            second.channelCount === first.channelCount &&
            second.bitsPerSample === first.bitsPerSample &&
            second.blockingStrategy === first.blockingStrategy &&
            second.codedNumber ===
                first.codedNumber + (first.blockingStrategy ? first.blockSize : 1)
        )
            return true;
        at = next;
    }
    return false;
}

async function sniffMp4FamilyDeep(
    reader: SniffWindowReader,
    start: number,
): Promise<ContainerFormat | null> {
    let pos = start;
    for (let boxes = 0; boxes < MAX_MP4_SNIFF_BOXES && pos + 8 <= reader.size; boxes++) {
        if ((boxes & 255) === 0) {
            reader.checkAbort();
            await yieldEventLoop();
        }

        const head = await reader.read(pos, 16);
        reader.checkAbort();
        if (head.length < 8) return null;

        let size = u32be(head, 0);
        let headerSize = 8;
        const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
        if (!/^[ -~]{4}$/.test(type)) {
            // A first box whose type bytes were overwritten (media data of an old QuickTime movie)
            // counts when its size leads exactly to the movie box.
            if (boxes !== 0 || size < 8 || pos + size + 8 > reader.size) return null;
            const next = await reader.read(pos + size, 8);
            reader.checkAbort();
            return String.fromCharCode(...next.subarray(4, 8)) === 'moov' ? 'mp4' : null;
        }

        if (size === 1) {
            if (head.length < 16) return null;
            headerSize = 16;
            const hi = u32be(head, 8);
            const lo = u32be(head, 12);
            size = hi * 4294967296 + lo;
        }

        if (type === 'ftyp') {
            const boxBytes = await reader.read(pos, Math.min(4096, size >= 16 ? size : 16));
            reader.checkAbort();
            if (boxBytes.length < 12) return 'mp4';
            return ftypFormat(boxBytes, 0);
        }

        if (MP4_DECISIVE.has(type)) return 'mp4';
        if (!MP4_TOP_BOXES.has(type)) return null;
        if (size === 0) return null;
        if (size < headerSize || !Number.isSafeInteger(size)) return null;
        pos += size;
    }
    return null;
}

/** The header partition pack after a run-in longer than the sniff prefix. */
async function sniffMxfDeep(
    reader: SniffWindowReader,
    start: number,
): Promise<ContainerFormat | null> {
    const bytes = await reader.read(start, MXF_RUN_IN_LIMIT + MXF_PARTITION_KEY.length);
    reader.checkAbort();
    return indexOfPattern(bytes, MXF_PARTITION_KEY, MXF_RUN_IN_LIMIT) >= 0 ? 'mxf' : null;
}
