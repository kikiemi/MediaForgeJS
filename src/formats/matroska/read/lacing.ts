import { demuxAssert } from '../../../core/errors/demux-guard';
import { readVint, vintLength } from '../ebml';

/**
 * Frame sizes of a Block body after its header (`lacing`: 0 none, 1 Xiph, 2 fixed, 3 EBML): fills
 * `sizes` and returns the count and where the first frame starts.
 */
export function laceFrames(
    buf: Uint8Array,
    pos: number,
    end: number,
    lacing: number,
    sizes: Float64Array,
): { count: number; framesStart: number } {
    let count = 1;
    if (lacing === 0) sizes[0] = end - pos;
    else {
        demuxAssert(pos < end, 'laced block truncated');
        count = buf[pos]! + 1;
        pos += 1;
        if (lacing === 2) {
            const total = end - pos;
            demuxAssert(total % count === 0, 'fixed lacing size mismatch');
            const each = total / count;
            for (let i = 0; i < count; i++) sizes[i] = each;
        } else if (lacing === 1) {
            let total = 0;
            for (let i = 0; i < count - 1; i++) {
                let size = 0;
                for (;;) {
                    demuxAssert(pos < end, 'Xiph lacing truncated');
                    const b = buf[pos]!;
                    pos += 1;
                    size += b;
                    if (b !== 255) break;
                }

                sizes[i] = size;
                total += size;
            }
            sizes[count - 1] = end - pos - total;
        } else {
            const first = readVint(buf, pos, end, 'unsigned');
            pos += vintLength;
            sizes[0] = first;
            let prev = first;
            let total = first;
            for (let i = 1; i < count - 1; i++) {
                const d = readVint(buf, pos, end, 'signed');
                pos += vintLength;
                prev += d;
                demuxAssert(Number.isSafeInteger(prev) && prev >= 0, 'EBML lacing invalid size');
                sizes[i] = prev;
                total += prev;
            }

            sizes[count - 1] = end - pos - total;
        }
    }

    const framesStart = pos;
    for (let i = 0; i < count; i++) {
        const size = sizes[i]!;
        demuxAssert(size >= 0 && pos + size <= end, 'laced frame exceeds block');
        pos += size;
    }

    return { count, framesStart };
}
