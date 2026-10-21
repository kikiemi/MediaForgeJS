import type { RemuxTrack } from '../media-types';
import { leadingTime } from '../read/track-start';

/**
 * The timeline of a copy, one rule for every output. The first packet the output presents, picture
 * or sound, lands at zero: a trim's in-point in MP4-family output, whose edit lists present it
 * exactly, otherwise the first packet copied (planTrim's origin), and for a whole copy the input's
 * first presented packet (`presentedStart`). What then lies before zero is each writer's to
 * express: MP4 edit lists, the Matroska and Opus codec delays, the wrapping MPEG-TS clock, FLV's
 * signed composition offsets, and each track's own edit in fragmented MP4 and HLS or DASH packages,
 * whose edit lists also go on hiding audio priming. An edit never starts inside a picture: the one
 * shown at its start is presented from there, its decode time unchanged, by the writer that counts
 * both in ticks (presentedFromEdit in MP4; in fragments CmafTiming, for editStartSample).
 */

/**
 * True when `format` keeps the leading samples of `track` from being heard: Opus pre-skip, and a
 * Matroska CodecDelay copied into Matroska. Other priming (AAC, MP3) that only an MP4 edit list
 * hides is played elsewhere.
 */
function discardsLead(format: string, track: RemuxTrack): boolean {
    if (track.type !== 'audio') return false;
    if (track.info.codec.startsWith('opus')) return true;
    return (
        (format === 'mkv' || format === 'webm') && (track.info.matroskaCodecDelaySeconds ?? 0) > 0
    );
}

/**
 * Where the output's zero lies on the input's clock, for outputs without edit lists: the first
 * packet the output presents, picture or sound, lands at zero. Priming that `format` cannot keep
 * unheard is presented, so a track whose priming an MP4 edit list hid starts the timeline with
 * it; decode times of reordered pictures before zero are the writer's to express. planTrim applies
 * the same rule to a range; fragmented MP4 follows the edit lists it writes (fragmentedStart).
 */
export function presentedStart(format: string, tracks: readonly RemuxTrack[]): number {
    const shown = tracks.filter(track => track.type !== 'subtitle');
    const played = shown.filter(track => !discardsLead(format, track));
    return played.length ? leadingTime(played, false) : Math.max(0, leadingTime(shown, false));
}
