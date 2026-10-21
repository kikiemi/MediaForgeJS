import { layoutMask, maskSpeakers } from '../../core/model/channel-layout';
import { dolbyChannelMask } from '../../core/codec-config/audio/dolby-layout';
import { MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec, PacketDecoder } from '../../core/contracts/decoder';
import { Ac3Decoder } from './decoder';

/**
 * Built-in AC-3 and E-AC-3 decoding of demuxed packets (raw streams, MP4, Matroska, MPEG-TS/PS,
 * AVI) into planes in WAVE order: the speakers of the track's dac3 or dec3, or the default layout
 * of its channel count.
 */
export function ac3AudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const channels = track.channelCount;
    const most = track.codec === 'ac-3' ? 6 : 8;
    if (track.codec !== 'ac-3' && track.codec !== 'ec-3')
        throw new MediaForgeError(`The ac3 plugin does not decode '${track.codec}'`, 'INPUT');
    if (!(channels >= 1 && channels <= most))
        throw new MediaForgeError(
            `${track.codec === 'ac-3' ? 'AC-3' : 'E-AC-3'} carries one to ${most} channels, ` +
                `not ${channels}`,
            'FORMAT',
        );
    const channelMask = layoutMask(channels, dolbyChannelMask(track.codecConfig, track.codec))!;
    const speakers = maskSpeakers(channelMask);
    return {
        channelMask,
        create(warn): PacketDecoder {
            const decoder = new Ac3Decoder(speakers, track.sampleRate, warn);
            return { decode: packet => decoder.decode(packet), reset: () => decoder.reset() };
        },
    };
}
