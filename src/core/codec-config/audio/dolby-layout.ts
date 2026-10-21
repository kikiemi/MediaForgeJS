/** WAVE speakers of the AC-3 audio coding modes: 1+1, 1/0, 2/0, 3/0, 2/1, 3/1, 2/2 and 3/2. */
const ACMOD_MASKS = [0x3, 0x4, 0x3, 0x7, 0x103, 0x107, 0x603, 0x607];
/**
 * WAVE speakers of the dec3 chan_loc bits 0 to 7 (ETSI TS 102 366 F.6): Lc/Rc, Lrs/Rrs, Cs, Ts,
 * Lsd/Rsd and Lw/Rw (no WAVE speakers), Vhl/Vhr and Vhc; LFE2 (bit 8) has none either.
 */
const LOCATION_MASKS = [0xc0, 0x30, 0x100, 0x800, 0, 0, 0x5000, 0x2000];

/**
 * The WAVE speaker mask of the channels an AC-3 (dac3) or E-AC-3 (dec3) configuration states: the
 * coding mode's speakers and LFE, and the locations a dependent substream adds. Undefined without
 * one.
 */
export function dolbyChannelMask(
    config: Uint8Array | undefined,
    codec: string,
): number | undefined {
    // dac3: fscod bsid bsmod (8 + 3 bits), then acmod and lfeon.
    if (codec === 'ac-3')
        return config?.length === 3
            ? ACMOD_MASKS[(config[1]! >> 3) & 7]! | (config[1]! & 4 ? 0x8 : 0)
            : undefined;
    // dec3: data_rate and num_ind_sub (2 bytes), then of the first independent substream fscod
    // bsid reserved (1 byte), asvc bsmod acmod lfeon, reserved num_dep_sub and chan_loc.
    if (codec !== 'ec-3' || !config || config.length < 5) return undefined;
    let mask = ACMOD_MASKS[(config[3]! >> 1) & 7]! | (config[3]! & 1 ? 0x8 : 0);
    if ((config[4]! >> 1) & 15 && config.length > 5)
        for (let bit = 0; bit < 8; bit++)
            if ((((config[4]! & 1) << 8) | config[5]!) & (1 << bit)) mask |= LOCATION_MASKS[bit]!;
    return mask;
}
