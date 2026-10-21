import type { DemuxResult, TrackInfo } from '../../core/model/track';
import { sameBytes } from '../../core/bytes/bytes';
import { rescaleTrims } from './audio-config';

/**
 * Describes the tracks of a window as the open described them from the tracks' first samples (the
 * codec and its configuration, size, colour, rate, channels and encoder delay that the read
 * functions derive), where the window holds the configuration the open read, as an index does;
 * returns the window with the tracks left to describe from their own samples.
 */
export function describedAs(window: DemuxResult, opened: DemuxResult): DemuxResult {
    const first = new Map(
        [...opened.videoTracks, ...opened.audioTracks].map(track => [track.id, track]),
    );
    const left = (track: TrackInfo): boolean => {
        const whole = first.get(track.id);
        if (
            !whole ||
            track.codecConfigurations?.length ||
            whole.codecConfigurations?.length ||
            (track.codecConfig?.length && !sameBytes(track.codecConfig, whole.codecConfig))
        )
            return true;
        track.codec = whole.codec;
        track.codecConfig = whole.codecConfig;
        if (!(track.width > 0 && track.height > 0)) {
            track.width = whole.width;
            track.height = whole.height;
        }
        track.colour ??= whole.colour;
        if (whole.sampleRate) {
            rescaleTrims(track, whole.sampleRate);
            track.sampleRate = whole.sampleRate;
            track.channelCount = whole.channelCount;
        }
        if (
            whole.decoderDelaySamples !== undefined &&
            !track.audioPrimingSamples &&
            !(track.editMediaTimeSeconds ?? 0)
        )
            track.decoderDelaySamples = whole.decoderDelaySamples;
        return false;
    };
    return {
        ...window,
        videoTracks: window.videoTracks.filter(left),
        audioTracks: window.audioTracks.filter(left),
    };
}
