/**
 * A unit of an input that a search over the input finds (an Ogg page, a FLAC frame): where it
 * starts, and the position it states (a granule, a first sample), which rises with the offsets.
 */
export interface PlacedUnit {
    readonly offset: number;
    readonly position: number;
}

/** Bytes of an input between two unit boundaries, and the positions reached at each. */
export interface PositionSpan {
    readonly from: number;
    readonly to: number;
    readonly fromPosition: number;
    readonly toPosition: number;
}

/** Where a search for a position narrowed a span to, and the units it found nearest each side. */
export interface NarrowedSpan<T extends PlacedUnit> {
    /** The last unit found before the position (or the span's start): the narrowed span's start. */
    readonly from: number;
    readonly below?: T;
    readonly above?: T;
}

/**
 * Narrows `span` to `close` bytes or fewer that start at the last unit before `position`. Each
 * probe takes the first unit `find` gives at or after an offset (null: none before `limit`;
 * undefined: the bytes there are not the stream's): the offset the positions at the span's ends
 * interpolate, moved `close / 2` past it away from the end the last probe moved, so that the next
 * probe can close the span; after two probes that each leave more than half of it, its middle.
 * Undefined when `find` is, when a unit is out of `ordered` with those found before, or after
 * `maxProbes`.
 */
export async function narrowToPosition<T extends PlacedUnit>(
    span: PositionSpan,
    position: number,
    close: number,
    maxProbes: number,
    find: (at: number, limit: number) => Promise<T | null | undefined>,
    ordered: (first: T, second: T) => boolean,
): Promise<NarrowedSpan<T> | undefined> {
    let { from: lo, to: hi, fromPosition: low, toPosition: high } = span;
    let below: T | undefined;
    let above: T | undefined;
    let rose = false;
    let misses = 0;
    const edge = Math.floor(close / 2);
    for (let probes = 0; hi - lo > close; probes++) {
        if (probes === maxProbes) return undefined;
        const bytes = hi - lo;
        const estimate =
            high > low ? lo + Math.floor((bytes * (position - low)) / (high - low)) : lo;
        const at =
            misses < 2
                ? Math.min(Math.max(estimate + (rose ? edge : -edge), lo + edge), hi - edge)
                : lo + Math.floor(bytes / 2);
        const unit = await find(at, hi);
        if (unit === undefined) return undefined;
        if (unit && ((below && !ordered(below, unit)) || (above && !ordered(unit, above))))
            return undefined;
        rose = unit !== null && unit.position < position;
        if (unit && rose) {
            lo = unit.offset;
            low = unit.position;
            below = unit;
        } else {
            // No unit from the probe to this one is before the position.
            hi = at;
            if (unit) {
                high = unit.position;
                above = unit;
            }
        }
        misses = hi - lo <= bytes / 2 ? 0 : misses + 1;
    }
    return { from: lo, below, above };
}
