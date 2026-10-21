import { isoBox } from '../../shared/iso-box';

/**
 * Text subtitles in plain MP4 and MOV, as ffmpeg's mov_text muxing writes them: a 'sbtl' track of
 * 3GPP timed text ('tx3g' entries) with a null media header, one sample per cue in milliseconds,
 * and the time between cues filled with empty samples, since a timed-text sample lasts until the
 * next.
 */

/** Units per second of a text track. */
export const TEXT_TIMESCALE = 1000;

/** An empty 3GPP timed-text sample: a zero text length, which clears the cue before it. */
export const EMPTY_TEXT_SAMPLE = Uint8Array.of(0, 0);

/** The 'tx3g' sample entry of `body`, the entry after its reserved bytes and data reference. */
export function textSampleEntry(body: Uint8Array): Uint8Array {
    const head = new Uint8Array(8);
    head[7] = 1;
    return isoBox('tx3g', head, body);
}
