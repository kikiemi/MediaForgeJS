import { DEFAULT_CHANNEL_MASKS, VORBIS_ORDER } from '../../core/model/channel-layout';
import { MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import { sampleAt } from '../../core/model/sample-index';
import type { BuiltinAudioCodec, PacketDecoder } from '../../core/contracts/decoder';
import { VorbisDecoder } from './decoder';

/**
 * Built-in Vorbis decoding of demuxed packets (Ogg or Matroska tracks) into planes in WAVE order.
 * Like every Vorbis decoder, the first packet outputs nothing (Vorbis I section 1.3.2); its coded
 * duration is the codec's unoutputLead.
 */
export function vorbisAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const config = track.codecConfig;
    if (!config)
        throw new MediaForgeError(
            'Vorbis track carries no identification and setup headers',
            'FORMAT',
        );
    const probe = new VorbisDecoder(config);
    const { channels } = probe;
    if (channels !== track.channelCount || probe.sampleRate !== track.sampleRate)
        throw new MediaForgeError(
            "Vorbis headers disagree with the track's sample rate or channels",
            'FORMAT',
        );
    const order = channels <= 8 ? VORBIS_ORDER[channels - 1]! : null;
    return {
        ...(order ? { channelMask: DEFAULT_CHANNEL_MASKS[channels - 1] } : {}),
        unoutputLead: Math.max(
            0,
            Math.round((sampleAt(track, 0)?.duration ?? 0) * track.sampleRate),
        ),
        create: (): PacketDecoder => {
            const decoder = new VorbisDecoder(config);
            const ordered: Float32Array[] = new Array<Float32Array>(channels);
            return {
                decode(packet) {
                    const frames = decoder.packetFrames(packet);
                    const out = Array.from({ length: channels }, () => new Float32Array(frames));
                    for (let c = 0; c < channels; c++) ordered[c] = out[order ? order[c]! : c]!;
                    decoder.decode(packet, ordered);
                    return [out];
                },
                reset: () => decoder.reset(),
            };
        },
    };
}
