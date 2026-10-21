/**
 * DV video (IEC 61834, SMPTE 314M) as AVI and VfW Matroska tracks name it; its frames are coded
 * alone.
 */
export const DV_VIDEO = 'dvvideo';

/**
 * FourCCs of DV in AVI (upper case): DV25, DV50, DVCPRO and DVCPRO HD under their writers' names.
 */
const DV_FOURCCS: ReadonlySet<string> = new Set([
    'DVSD',
    'DVHD',
    'DVSL',
    'DV25',
    'DV50',
    'DVH1',
    'DVCS',
    'CDVC',
    'CDVH',
    'CDV5',
    'DVC ',
    'DVCP',
    'DVPP',
    'DVIS',
    'PDVC',
    'SL25',
    'SLDV',
    'AVD1',
]);

export function isDvFourcc(fourcc: string): boolean {
    return DV_FOURCCS.has(fourcc.toUpperCase());
}

/**
 * The FourCC written for DV: dvsd, as ffmpeg writes every DV stream; readers take the variant from
 * its frames.
 */
export const DV_WRITE_FOURCC = 'dvsd';
