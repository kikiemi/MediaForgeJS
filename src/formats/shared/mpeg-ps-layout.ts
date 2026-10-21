import { findStartCode } from '../../core/codec-config/video/mpeg-video';

export const PACK = 0xba;

/**
 * Length of a pack header at `at` (MPEG-2 with its stuffing, or MPEG-1) and its 33-bit SCR; null
 * when malformed.
 */
export function parsePackHeader(
    bytes: Uint8Array,
    at: number,
    markers: boolean,
): { length: number; scr: number } | null {
    const b = (index: number): number => bytes[at + index] ?? 0;
    if ((b(4) & 0xc0) === 0x40) {
        if (at + 14 > bytes.length) return null;
        if (markers && !(b(4) & 4 && b(6) & 4 && b(8) & 4 && b(9) & 1 && (b(12) & 3) === 3))
            return null;
        return {
            length: 14 + (b(13) & 7),
            scr:
                ((b(4) >> 3) & 7) * 2 ** 30 +
                (((b(4) & 3) << 13) | (b(5) << 5) | (b(6) >> 3)) * 2 ** 15 +
                (((b(6) & 3) << 13) | (b(7) << 5) | (b(8) >> 3)),
        };
    }

    if ((b(4) & 0xf0) !== 0x20 || at + 12 > bytes.length) return null;
    if (markers && !(b(4) & 1 && b(6) & 1 && b(8) & 1 && b(9) & 0x80 && b(11) & 1)) return null;
    return {
        length: 12,
        scr:
            ((b(4) >> 1) & 7) * 2 ** 30 +
            ((b(5) << 7) | (b(6) >> 1)) * 2 ** 15 +
            ((b(7) << 7) | (b(8) >> 1)),
    };
}

/**
 * A pack header with valid marker bits at the start of the prefix, or one followed by another
 * system start code.
 */
export function probeProgramStream(h: Uint8Array): boolean {
    for (let at = findStartCode(h, 0); at >= 0; at = findStartCode(h, at + 3)) {
        if (h[at + 3] !== PACK) continue;
        const pack = parsePackHeader(h, at, true);
        if (!pack) continue;
        if (at === 0) return true;
        const next = at + pack.length;
        if (
            next + 4 <= h.length &&
            h[next] === 0 &&
            h[next + 1] === 0 &&
            h[next + 2] === 1 &&
            h[next + 3]! >= 0xb9
        )
            return true;
    }
    return false;
}

/**
 * A stream of PES packets without pack headers, as some capture tools write: an audio or video PES
 * whose declared length leads to the next system start code. Checked after MPEG-TS, whose payloads
 * carry PES headers too.
 */
export function probePesStream(h: Uint8Array): boolean {
    for (
        let at = findStartCode(h, 0);
        at >= 0 && at + 6 <= h.length;
        at = findStartCode(h, at + 3)
    ) {
        const id = h[at + 3]!;
        if (id !== 0xbd && (id < 0xc0 || id > 0xef)) continue;
        const next = at + 6 + ((h[at + 4]! << 8) | h[at + 5]!);
        if (
            next > at + 6 &&
            next + 4 <= h.length &&
            h[next] === 0 &&
            h[next + 1] === 0 &&
            h[next + 2] === 1 &&
            h[next + 3]! >= 0xb9
        )
            return true;
    }
    return false;
}
