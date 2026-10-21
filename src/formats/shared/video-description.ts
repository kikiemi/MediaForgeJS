import type { TrackInfo } from '../../core/model/track';
import { avcConfigSps } from '../../core/codec-config/video/video-sps';
import { mpegVideoFamily } from '../../core/model/codec-strings';
import { carriesRotation, isIsoOutput } from './capabilities';

/**
 * Containers that describe a video track's colour, HDR metadata, field order and pixel aspect apart
 * from its stream.
 */
const DESCRIBING_FORMATS: ReadonlySet<string> = new Set([
    'mp4',
    'mov',
    'm4v',
    '3gp',
    'fmp4',
    'mkv',
    'webm',
]);

type VideoDescription = Pick<
    TrackInfo,
    | 'codec'
    | 'codecConfig'
    | 'colour'
    | 'fieldOrder'
    | 'rotation'
    | 'language'
    | 'width'
    | 'height'
    | 'pixelAspectRatioNum'
    | 'pixelAspectRatioDen'
    | 'spatial'
>;

/**
 * What a copy of a video track into `format` loses of what its input container stated about it: the
 * display rotation, the spatial layout outside MP4, and, in a container with no description of its
 * own (MPEG-TS), the language and whatever of the colour, HDR metadata, field order and pixel
 * aspect the coded stream does not state itself. H.264 sequence parameter sets are read for that;
 * MPEG-1/2/4 video always states its aspect and fields; other streams are taken to state none of
 * it.
 */
export function uncarriedVideoDescription(format: string, track: VideoDescription): string[] {
    const lost: string[] = [];
    if (track.rotation && !carriesRotation(format) && format !== 'fmp4')
        lost.push('display rotation');
    // Only MP4-family sample entries hold spatial video (a lost MV-HEVC layer is
    // STEREO_VIEW_DROPPED).
    if (track.spatial && track.spatial.views !== 'layer' && !isIsoOutput(format))
        lost.push('spatial layout');
    if (DESCRIBING_FORMATS.has(format)) return lost;
    if (track.language !== undefined && track.language !== 'und') lost.push('language');
    const mpeg = mpegVideoFamily(track.codec) !== null;
    const coded =
        track.codec.startsWith('avc') && track.codecConfig ? avcConfigSps(track.codecConfig) : null;
    const colour = track.colour;
    const stated = (value: number, codedValue: number | undefined): boolean =>
        value === 2 || value === codedValue;
    if (
        colour &&
        !(
            stated(colour.primaries, coded?.colour?.primaries) &&
            stated(colour.transfer, coded?.colour?.transfer) &&
            stated(colour.matrix, coded?.colour?.matrix) &&
            (colour.fullRange !== true || coded?.colour?.fullRange === true)
        )
    )
        lost.push('colour description');

    if (colour?.mastering || colour?.contentLight)
        lost.push('HDR mastering display and content light levels');
    const interlaced = track.fieldOrder !== undefined && track.fieldOrder !== 'progressive';
    if (interlaced && !mpeg && (!coded || coded.framesOnly)) lost.push('field order');
    const num = track.pixelAspectRatioNum ?? 1;
    const den = track.pixelAspectRatioDen ?? 1;
    const square = coded
        ? num * coded.pixelAspectRatioDen === den * coded.pixelAspectRatioNum
        : num === den;
    if (!square && !mpeg) lost.push('pixel aspect ratio');
    return lost;
}
