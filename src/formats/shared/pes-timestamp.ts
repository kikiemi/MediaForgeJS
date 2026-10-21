/** 33-bit PTS/DTS/SCR period in 90 kHz ticks. */
export const PTS_WRAP = 2 ** 33;
const PTS_WRAP_GUARD = 2 * 90000;

/**
 * Unwraps a 33-bit timestamp next to the previous unwrapped value; a first value just below the
 * wrap counts as negative.
 */
export function unwrapTimestamp(raw: number, previous: number | null): number {
    return previous === null
        ? raw > PTS_WRAP - PTS_WRAP_GUARD
            ? raw - PTS_WRAP
            : raw
        : raw + Math.round((previous - raw) / PTS_WRAP) * PTS_WRAP;
}

/**
 * Reads a five-byte PES PTS or DTS whose first nibble is `prefix`; null when the prefix or marker
 * bits are wrong.
 */
export function readPesTimestamp(bytes: Uint8Array, offset: number, prefix: number): number | null {
    if (
        bytes[offset]! >> 4 !== prefix ||
        (bytes[offset]! & 1) === 0 ||
        (bytes[offset + 2]! & 1) === 0 ||
        (bytes[offset + 4]! & 1) === 0
    )
        return null;
    return (
        ((bytes[offset]! >> 1) & 7) * 2 ** 30 +
        bytes[offset + 1]! * 2 ** 22 +
        ((bytes[offset + 2]! >> 1) & 127) * 2 ** 15 +
        bytes[offset + 3]! * 128 +
        (bytes[offset + 4]! >> 1)
    );
}

/** Overlap in seconds that the 90 kHz rounding of a PES timestamp explains. */
const TICK_ROUNDING = 2.5 / 90000;

/**
 * The time of an audio frame whose PES states `stamped` while the previous frame ends at `clock`.
 * Frames do not overlap: a stamp inside the previous frame (by more than 90 kHz rounding, less than
 * a frame) is rounding to a coarser clock, as muxers with millisecond clocks write, and the frame
 * continues the previous one. Later stamps, and earlier ones by a frame or more, are kept.
 */
export function continuedAudioTime(
    clock: number | undefined,
    stamped: number,
    duration: number,
): number {
    return clock !== undefined && clock - stamped > TICK_ROUNDING && clock - stamped < duration
        ? clock
        : stamped;
}
