import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import { mp4aAudioObjectType } from '../../core/model/codec-strings';
import type { TrackInfo } from '../../core/model/track';
import { sampleAt, sampleCount } from '../../core/model/sample-index';

/**
 * The settings an encoder gets when the request leaves them out: video and audio bitrates, the
 * frame rate and the audio rate and channels. Conversions, edits and encodeFrames() read them here.
 */

/** How much a video quality scales the default bitrate. */
export type VideoQuality = 'low' | 'medium' | 'high' | 'very-high';

/** Default-bitrate multipliers of each video quality. */
export const QUALITY_SCALE: Readonly<Record<VideoQuality, number>> = {
    low: 0.5,
    medium: 1,
    high: 1.6,
    'very-high': 2.5,
};

// The default video bitrate, which the codecs define.
export { defaultVideoBitrate } from '../codecs/video-settings';
import { defaultVideoBitrate } from '../codecs/video-settings';

/** The bitrate of `quality` for a picture: the default bitrate scaled by the quality. */
export function qualityBitrate(
    quality: VideoQuality,
    codec: string,
    width: number,
    height: number,
    framerate: number,
): number {
    return Math.round(
        defaultVideoBitrate(codec, width, height, framerate) * QUALITY_SCALE[quality],
    );
}

// The audio bitrates the encoders take, which the codecs define.
export { DEFAULT_AUDIO_BITRATE, bitrateKbps, optionalKbps } from '../codecs/audio-settings';

/**
 * The MPEG-1 audio rate closest above `rate` (32, 44.1 or 48 kHz); Layer II and III encoders take
 * only these.
 */
function mpegAudioRate(rate: number): number {
    return rate <= 32000 ? 32000 : rate <= 44100 ? 44100 : 48000;
}

/** The AAC sampling frequency closest to `rate`: AAC signals only these 13. */
function aacRate(rate: number): number {
    return AAC_SAMPLE_RATES.reduce((best, value) =>
        Math.abs(value - rate) < Math.abs(best - rate) ? value : best,
    );
}

/**
 * Rate and channels of an audio track, the largest of its codec configurations; 48 kHz stereo when
 * unknown.
 */
export function sourceAudioShape(track: TrackInfo): { rate: number; channels: number } {
    let rate = track.sampleRate || 0;
    let channels = track.channelCount || 0;
    for (const config of track.codecConfigurations ?? []) {
        rate = Math.max(rate, config.sampleRate ?? 0);
        channels = Math.max(channels, config.channelCount ?? 0);
    }
    return { rate: rate || 48000, channels: channels || 2 };
}

/**
 * Output rate and channels of encoded audio: the requested values, else the source's within what
 * `codec` takes. Opus runs at 48 kHz, MP2 and MP3 at an MPEG-1 rate, AAC at the nearest AAC rate;
 * more channels than the codec's encoders carry fold down to stereo.
 */
export function encodedAudioShape(
    sourceRate: number,
    sourceChannels: number,
    codec: string,
    requested: { readonly sampleRate?: number; readonly channels?: number } = {},
): { rate: number; channels: number; downmixed?: boolean } {
    const rate =
        codec === 'opus'
            ? 48000
            : requested.sampleRate ||
              (codec === 'mp2' || codec === 'mp3'
                  ? mpegAudioRate(sourceRate)
                  : sourceRate && (mp4aAudioObjectType(codec) !== null || codec === 'aac')
                    ? aacRate(sourceRate)
                    : sourceRate) ||
              48000;
    if (requested.channels) return { rate, channels: requested.channels };
    const channels = sourceChannels || 2;
    const limit = ['flac', 'pcm', 'ulaw', 'alaw', 'alac'].includes(codec) ? 8 : 2;
    return channels > limit ? { rate, channels: limit, downmixed: true } : { rate, channels };
}

/**
 * The frame rate of the first 121 samples of `track`: their presentation times in order (reordered
 * B-frames count once), the mean of the intervals near the median one, snapped to a whole or NTSC
 * rate it matches; 0 when unknown.
 */
export function measuredFramerate(track: TrackInfo): number {
    const count = Math.min(121, sampleCount(track));
    const times = Float64Array.from(
        { length: count },
        (_, index) => sampleAt(track, index)!.timestamp,
    ).sort();
    const deltas: number[] = [];
    for (let index = 1; index < count; index++) {
        const delta = times[index]! - times[index - 1]!;
        if (delta > 0) deltas.push(delta);
    }
    if (!deltas.length) return 0;
    deltas.sort((a, b) => a - b);

    // The mean of the intervals near the median: millisecond timestamps alternate around the true
    // interval, which the mean recovers, while gaps and doubled frames stay out.
    const median = deltas[deltas.length >> 1]!;
    let sum = 0;
    let near = 0;
    for (const delta of deltas)
        if (Math.abs(delta - median) <= median * 0.25) {
            sum += delta;
            near++;
        }
    const rate = near / sum;

    // A rate within 0.02 % of a whole or an NTSC (×1000/1001) rate is that rate.
    for (const nominal of [Math.round(rate), Math.round(rate * 1.001) / 1.001])
        if (Math.abs(rate - nominal) <= rate * 2e-4) return nominal;
    return rate;
}

/**
 * Frame rate an encoder is configured with: the requested one, else the track's measured rate, else
 * 30.
 */
export function encoderFramerate(fps: number | undefined, track: TrackInfo): number {
    return fps || Math.round(measuredFramerate(track)) || 30;
}
