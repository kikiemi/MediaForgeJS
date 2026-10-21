/**
 * WAVE speaker masks of the layouts that FLAC, Vorbis, Opus and WAVE_FORMAT_PCM imply for 1..8
 * channels, with the planes in ascending speaker-bit order (FL FR FC LFE BL BR FLC FRC BC SL SR
 * ...).
 */
export const DEFAULT_CHANNEL_MASKS: readonly number[] = Object.freeze([
    0x4, 0x3, 0x7, 0x33, 0x37, 0x3f, 0x70f, 0x63f,
]);

export function defaultChannelMask(channels: number): number | undefined {
    return DEFAULT_CHANNEL_MASKS[channels - 1];
}

/** A mask describes a layout only when it names exactly one speaker per plane. */
export function layoutMask(channels: number, mask: number | undefined): number | undefined {
    if (mask === undefined || mask === 0) return defaultChannelMask(channels);
    let count = 0;
    for (let bits = mask >>> 0; bits; bits &= bits - 1) count++;
    return count === channels ? mask >>> 0 : defaultChannelMask(channels);
}

/** WAVE speaker bits; the speakers WAVE has no bit for take bits above its own. */
export const FL = 0x1;
export const FR = 0x2;
export const FC = 0x4;
export const LFE = 0x8;
export const BL = 0x10;
export const BR = 0x20;
export const FLC = 0x40;
export const FRC = 0x80;
export const BC = 0x100;
export const SL = 0x200;
export const SR = 0x400;
export const TC = 0x800;
export const TFL = 0x1000;
export const TFC = 0x2000;
export const TFR = 0x4000;
export const TBL = 0x8000;
export const TBR = 0x20000;
export const LSD = 0x1000000;
export const RSD = 0x2000000;
export const LW = 0x4000000;
export const RW = 0x8000000;
export const LFE2 = 0x10000000;

const H = Math.SQRT1_2;

/** The bits of `mask`, lowest first: the WAVE order of its planes. */
export function maskSpeakers(mask: number): number[] {
    const speakers: number[] = [];
    for (let bit = 1; bit <= mask >>> 0; bit *= 2) if (mask & bit) speakers.push(bit);
    return speakers;
}

/**
 * Where a speaker the output lacks goes: the first alternative whose speakers the output has, as
 * those speakers and the weight each takes (swresample's default matrix, which folds to stereo as
 * ITU-R BS.775 does).
 */
const FOLDS: ReadonlyMap<number, readonly (readonly [number, number])[]> = new Map<
    number,
    readonly (readonly [number, number])[]
>([
    [FL, [[FC, H]]],
    [FR, [[FC, H]]],
    [FC, [[FL | FR, H]]],
    [
        FLC,
        [
            [FL, 1],
            [FC, H],
        ],
    ],
    [
        FRC,
        [
            [FR, 1],
            [FC, H],
        ],
    ],
    [
        BC,
        [
            [BL | BR, H],
            [SL | SR, H],
            [FL | FR, 0.5],
            [FC, 0.5],
        ],
    ],
    [
        SL,
        [
            [BL, 1],
            [BC, H],
            [FL, H],
            [FC, 0.5],
        ],
    ],
    [
        SR,
        [
            [BR, 1],
            [BC, H],
            [FR, H],
            [FC, 0.5],
        ],
    ],
    [
        BL,
        [
            [SL, 1],
            [BC, H],
            [FL, H],
            [FC, 0.5],
        ],
    ],
    [
        BR,
        [
            [SR, 1],
            [BC, H],
            [FR, H],
            [FC, 0.5],
        ],
    ],
    [
        LSD,
        [
            [SL, 1],
            [BL, 1],
            [FL, H],
            [FC, 0.5],
        ],
    ],
    [
        RSD,
        [
            [SR, 1],
            [BR, 1],
            [FR, H],
            [FC, 0.5],
        ],
    ],
    [
        LW,
        [
            [FL, 1],
            [FC, H],
        ],
    ],
    [
        RW,
        [
            [FR, 1],
            [FC, H],
        ],
    ],
    [
        TFL,
        [
            [FL, H],
            [FC, 0.5],
        ],
    ],
    [
        TFR,
        [
            [FR, H],
            [FC, 0.5],
        ],
    ],
    [
        TFC,
        [
            [FC, H],
            [FL | FR, 0.5],
        ],
    ],
    [
        TC,
        [
            [FL | FR, 0.5],
            [FC, H],
        ],
    ],
    [
        TBL,
        [
            [BL, H],
            [SL, H],
            [FL, H],
            [FC, 0.5],
        ],
    ],
    [
        TBR,
        [
            [BR, H],
            [SR, H],
            [FR, H],
            [FC, 0.5],
        ],
    ],
    [LFE2, [[LFE, 1]]],
]);

/** Where a speaker without a fold of its own goes: between the fronts, or the centre. */
const ANY_SPEAKER: readonly (readonly [number, number])[] = [
    [FL | FR, 0.5],
    [FC, H],
];

/**
 * The speakers of `mask` that `speaker`, which `mask` lacks, folds into and the weight each takes;
 * undefined for a speaker the output drops (LFE, or nowhere to go). `speaker` 0 is a plane of no
 * known speaker.
 */
export function speakerFold(speaker: number, mask: number): readonly [number, number] | undefined {
    if (speaker === LFE) return undefined;
    const alternatives = FOLDS.get(speaker) ?? ANY_SPEAKER;
    return alternatives.find(([targets]) => (mask & targets) === targets);
}

/**
 * The weight of each source plane in each output plane when `sourceChannels` planes of a layout
 * (a channel mask, see layoutMask) play on `targetChannels` planes of another: a speaker the output
 * has plays as it is, one it lacks folds as speakerFold says. Rows are output planes in WAVE order;
 * planes beyond a layout play as speakers of no known position.
 */
export function mixWeights(
    sourceChannels: number,
    sourceMask: number | undefined,
    targetChannels: number,
    targetMask: number | undefined,
): Float64Array[] {
    const source = layoutMask(sourceChannels, sourceMask);
    const target = layoutMask(targetChannels, targetMask) ?? 0;
    const sourceSpeakers = source === undefined ? [] : maskSpeakers(source);
    const targetSpeakers = maskSpeakers(target);
    const rows = Array.from({ length: targetChannels }, () => new Float64Array(sourceChannels));
    for (let plane = 0; plane < sourceChannels; plane++) {
        const speaker = sourceSpeakers[plane] ?? 0;
        const own = targetSpeakers.indexOf(speaker);
        if (speaker && own >= 0) {
            rows[own]![plane] = 1;
            continue;
        }
        const fold = speakerFold(speaker, target);
        if (!fold) continue;
        for (const into of maskSpeakers(fold[0]))
            rows[targetSpeakers.indexOf(into)]![plane] = fold[1];
    }
    return rows;
}

/**
 * Plane position (WAVE speaker order) of each channel in MPEG element order, where the centre
 * channel leads: AAC channel configurations 1..7 and ALAC use C, (Lc Rc), L R, (Ls Rs), (Cs), LFE
 * for 1..8 channels.
 */
export const ELEMENT_ORDER: readonly (readonly number[])[] = Object.freeze([
    [0],
    [0, 1],
    [2, 0, 1],
    [2, 0, 1, 3],
    [2, 0, 1, 3, 4],
    [2, 0, 1, 4, 5, 3],
    [2, 0, 1, 4, 5, 6, 3],
    [2, 6, 7, 0, 1, 4, 5, 3],
]);

/** WAVE speaker masks of the element-ordered layouts after reordering. */
export const ELEMENT_ORDER_MASKS: readonly number[] = Object.freeze([
    0x4, 0x3, 0x7, 0x107, 0x37, 0x3f, 0x13f, 0xff,
]);

/**
 * Plane position (WAVE speaker order) of each channel in Vorbis order (Vorbis I section 4.3.9, also
 * Opus mapping family 1): L C R for 3, L C R Ls Rs LFE for 6, L C R SL SR BL BR LFE for 8 channels;
 * the masks are DEFAULT_CHANNEL_MASKS.
 */
export const VORBIS_ORDER: readonly (readonly number[])[] = Object.freeze([
    [0],
    [0, 1],
    [0, 2, 1],
    [0, 1, 2, 3],
    [0, 2, 1, 3, 4],
    [0, 2, 1, 4, 5, 3],
    [0, 2, 1, 5, 6, 4, 3],
    [0, 2, 1, 6, 7, 4, 5, 3],
]);
