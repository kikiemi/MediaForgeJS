import {
    DEFAULT_CHANNEL_MASKS,
    ELEMENT_ORDER_MASKS,
    layoutMask,
} from '../../core/model/channel-layout';
import { dolbyChannelMask } from '../../core/codec-config/audio/dolby-layout';
import { codecFamily } from '../../core/model/codec-strings';
import { MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import { sampleAt } from '../../core/model/sample-index';
import type { BuiltinAudioCodec } from '../../core/contracts/decoder';
import { parseOpusHead } from '../../core/codec-config/audio/opus-head';

/**
 * The decoded layout of a track whose decoder is a plugin: speaker mask of the decoded planes (of
 * an AC-3 or E-AC-3 track, the speakers its dac3 or dec3 states), Opus pre-skip and the Vorbis
 * first block, which no decoder outputs. The host and the plugin decoders present the same samples
 * with it, and it needs no decoder code. Throws FORMAT for an Opus configuration that contradicts
 * the track.
 */
export function trackCodecLayout(
    track: TrackInfo,
): Pick<BuiltinAudioCodec, 'channelMask' | 'preRoll' | 'unoutputLead'> {
    const channels = track.channelCount;
    const family = codecFamily(track.codec);
    if (family === 'opus') {
        const head = parseOpusHead(track.codecConfig, channels);
        if (head.channels !== channels)
            throw new MediaForgeError(
                `Opus header has ${head.channels} channels, but the track has ${channels}`,
                'FORMAT',
            );
        if (track.sampleRate !== 48000)
            throw new MediaForgeError(
                `Opus tracks must be 48000 Hz, not ${track.sampleRate}`,
                'FORMAT',
            );
        return {
            ...(head.mappingFamily === 1
                ? { channelMask: DEFAULT_CHANNEL_MASKS[channels - 1] }
                : {}),
            preRoll: head.preSkip,
        };
    }

    if (family === 'vorbis')
        return {
            ...(channels <= 8 ? { channelMask: DEFAULT_CHANNEL_MASKS[channels - 1] } : {}),
            unoutputLead: Math.max(
                0,
                Math.round((sampleAt(track, 0)?.duration ?? 0) * track.sampleRate),
            ),
        };
    if (family === 'flac') return { channelMask: DEFAULT_CHANNEL_MASKS[channels - 1] };
    if (family === 'alac') return { channelMask: ELEMENT_ORDER_MASKS[channels - 1] };
    if (family === 'ac-3' || family === 'ec-3')
        return {
            channelMask: layoutMask(channels, dolbyChannelMask(track.codecConfig, family)),
        };
    return {};
}
