import { MediaForgeError } from '../errors/errors';

// The times of samples and packets: when one is decoded, and a time in whole ticks of a clock.

/**
 * When a sample or packet is decoded: its decode time, else (in decode order) its presentation
 * time.
 */
export function decodeTime(sample: {
    readonly timestamp: number;
    readonly decodeTimestamp?: number;
}): number {
    return sample.decodeTimestamp ?? sample.timestamp;
}

/**
 * How a time between two ticks becomes one: the nearest (halves up, as Math.round), the one
 * before it or the one after it.
 */
export type TickRounding = 'nearest' | 'floor' | 'ceil';

export interface TickOptions {
    readonly rounding?: TickRounding;
    /** The fewest ticks the field holds; any safe integer by default. */
    readonly min?: number;
    /** The most ticks the field holds; any safe integer by default. */
    readonly max?: number;
}

/**
 * `seconds` as a whole number of ticks of a clock of `rate` ticks per second: a time or a duration
 * a writer, a copy or a package states. A time that is not finite, or whose ticks are no safe
 * integer or fall outside [min, max], fails with MUX naming `what`.
 */
export function secondsToTicks(
    seconds: number,
    rate: number,
    what: string,
    options: TickOptions = {},
): number {
    const {
        rounding = 'nearest',
        min = -Number.MAX_SAFE_INTEGER,
        max = Number.MAX_SAFE_INTEGER,
    } = options;
    const scaled = seconds * rate;
    const ticks =
        rounding === 'floor'
            ? Math.floor(scaled)
            : rounding === 'ceil'
              ? Math.ceil(scaled)
              : Math.round(scaled);
    if (!Number.isSafeInteger(ticks) || ticks < min || ticks > max)
        throw new MediaForgeError(
            `${what} is outside the exact integer range [${min}, ${max}]`,
            'MUX',
        );
    return ticks;
}
