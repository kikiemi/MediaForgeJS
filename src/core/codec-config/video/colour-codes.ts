import type { PlanarVideoColorSpace } from '../../contracts/picture';

/**
 * ISO/IEC 23091-2 colour code points (H.264 Tables E-3 to E-5, MPEG-4 Part 2 Tables 6-8 to 6-10)
 * that WebCodecs can name for the 8-bit pictures of the software decoders.
 */
const PRIMARIES: Readonly<Record<number, VideoColorPrimaries>> = {
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
    7: 'smpte170m',
};
const TRANSFERS: Readonly<Record<number, VideoTransferCharacteristics>> = {
    1: 'bt709',
    6: 'smpte170m',
    13: 'iec61966-2-1',
};
const MATRICES: Readonly<Record<number, VideoMatrixCoefficients>> = {
    0: 'rgb',
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
};

/** The code points a bitstream signals; an absent one counts as 2, unspecified. */
export interface ColourCodes {
    readonly primaries?: number;
    readonly transfer?: number;
    readonly matrix?: number;
    readonly fullRange?: boolean;
}

/**
 * The colour space of `codes`: an unspecified code takes `fallback`'s name, and one WebCodecs has
 * no name for is left out.
 */
export function colourSpaceOf(
    codes: ColourCodes | undefined,
    fallback: Required<Omit<PlanarVideoColorSpace, 'fullRange'>>,
): PlanarVideoColorSpace {
    const pick = <T>(table: Readonly<Record<number, T>>, code: number, name: T): T | undefined =>
        code === 2 ? name : table[code];
    return {
        primaries: pick(PRIMARIES, codes?.primaries ?? 2, fallback.primaries),
        transfer: pick(TRANSFERS, codes?.transfer ?? 2, fallback.transfer),
        matrix: pick(MATRICES, codes?.matrix ?? 2, fallback.matrix),
        fullRange: codes?.fullRange ?? false,
    };
}

/**
 * The colour of a picture that states none: BT.709 for a picture wider than 1024 or taller than 576
 * pixels (HD), BT.601 (SMPTE 170M) otherwise. Decoders and the RGBA conversion assume it alike.
 */
export function unlabelledColour(width: number, height: number): 'bt709' | 'smpte170m' {
    return width > 1024 || height > 576 ? 'bt709' : 'smpte170m';
}
