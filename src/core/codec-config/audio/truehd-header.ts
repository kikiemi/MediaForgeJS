interface TrueHdAccessUnit {
    /** Access unit bytes from the 12-bit length in 16-bit words. */
    readonly bytes: number;
    /** Format of the major sync that starts the unit, absent for units that carry none. */
    readonly format?: {
        readonly sampleRate: number;
        readonly channels: number;
        readonly samples: number;
    };
}

/**
 * Speakers per bit of a TrueHD channel assignment: L/R, C, LFE, Ls/Rs, Lvh/Rvh, Lc/Rc, Lrs/Rrs, Cs,
 * Ts, ...
 */
const CHANNEL_COUNTS = [2, 1, 1, 2, 2, 2, 2, 1, 1, 2, 2, 1, 1];

function assignedChannels(mask: number): number {
    let total = 0;
    for (let bit = 0; bit < CHANNEL_COUNTS.length; bit++)
        if ((mask >> bit) & 1) total += CHANNEL_COUNTS[bit]!;
    return total;
}

/**
 * Parses the Dolby TrueHD access unit at `offset`; a unit starting with the TrueHD major sync (F8
 * 72 6F BA) also yields the sampling rate, the channel count of the widest presentation and the
 * 40-sample-per-48 kHz unit length.
 */
export function parseTrueHdAccessUnit(data: Uint8Array, offset: number): TrueHdAccessUnit | null {
    if (offset + 4 > data.length) return null;
    const bytes = (((data[offset]! & 15) << 8) | data[offset + 1]!) * 2;
    if (bytes < 4) return null;
    if (
        offset + 12 > data.length ||
        data[offset + 4] !== 0xf8 ||
        data[offset + 5] !== 0x72 ||
        data[offset + 6] !== 0x6f ||
        data[offset + 7] !== 0xba
    )
        return { bytes };

    const rateCode = data[offset + 8]! >> 4;
    if (rateCode === 15 || (rateCode & 7) > 2) return null;
    const sampleRate = ((rateCode & 8) !== 0 ? 44100 : 48000) << (rateCode & 7);
    const sixChannel = ((data[offset + 9]! & 15) << 1) | (data[offset + 10]! >> 7);
    const eightChannel = ((data[offset + 10]! & 31) << 8) | data[offset + 11]!;
    const channels = assignedChannels(eightChannel) || assignedChannels(sixChannel);
    if (!channels) return null;
    return { bytes, format: { sampleRate, channels, samples: 40 << (rateCode & 7) } };
}
