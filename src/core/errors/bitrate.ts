/**
 * Bits per second, or text with a unit: `128_000`, `'128k'`, `'2.5M'`, `'2500kbps'`. A plain number
 * below 1,000 (audio) or 10,000 (video) is read as kilobits per second and reported with
 * OPTION_NORMALIZED.
 */
export type Bitrate = number | `${number}k` | `${number}M` | `${number}kbps` | `${number}Mbps`;

/** Below these values a bitrate without a unit reads as kilobits per second. */
const KBPS_BELOW = { audio: 1000, video: 10000 } as const;

/** From these values up a bitrate without a unit reads as bits per second without comment. */
const BPS_FROM = { audio: 8000, video: 100000 } as const;

/** The highest bitrate any encoder is asked for; larger requests are lowered to it. */
const BPS_CAP = { audio: 2_000_000, video: 800_000_000 } as const;
/** A number and an optional unit: k or M, then b, bps or bit/s (`'128k'`, `'2.5 Mbps'`). */
const BITRATE_TEXT = /^(\d+(?:\.\d+)?|\.\d+)\s*([km]?(?:bps|bit\/s|b)?)$/i;

/**
 * A bitrate in bits per second, or undefined when `value` is no usable bitrate. Text may carry a
 * unit ('192k', '2.5M', '128 kbps'). A number without one below 1,000 (audio) or 10,000 (video)
 * reads as kilobits per second, and one up to 8,000 (audio) or 100,000 (video) as bits per second;
 * `note` hears both readings and the cap, so the value can be written in bits per second.
 */
export function bitsPerSecond(
    value: number | string,
    kind: 'audio' | 'video',
    note?: (message: string) => void,
): number | undefined {
    let bits: number;
    if (typeof value === 'string') {
        const match = BITRATE_TEXT.exec(value.trim());
        const unit = match?.[2]?.[0]?.toLowerCase();
        if (!unit) return match ? bitsPerSecond(Number(match[1]), kind, note) : undefined;
        bits = Math.round(Number(match![1]) * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1));
    } else {
        if (!(value > 0)) return undefined;
        const kilo = value < KBPS_BELOW[kind];
        bits = Math.round(kilo ? value * 1000 : value);
        if (kilo)
            note?.(
                `${value} was read as ${value} kbit/s (${bits} bits per second); ` +
                    'bitrates are bits per second',
            );
        else if (value < BPS_FROM[kind])
            note?.(
                `${value} was read as ${bits} bits per second; ` +
                    `for kilobits per second write ${Math.round(value)}000`,
            );
    }

    if (!Number.isSafeInteger(bits) || bits < 1) return undefined;
    if (bits > BPS_CAP[kind]) {
        note?.(`${bits} exceeds ${BPS_CAP[kind]} bps and was lowered to it`);
        return BPS_CAP[kind];
    }
    return bits;
}
