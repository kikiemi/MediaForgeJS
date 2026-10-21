import type { TrackInfo } from '../../core/model/track';
import { MediaForgeError } from '../../core/errors/errors';
import type { BuiltinAudioCodec, PacketDecoder } from '../../core/contracts/decoder';
import { createAacDecoder } from './decoder';
import { AAC_SBR_TOOLS } from './sbr-tools';

/**
 * The aac plugin's decoder of one AAC configuration, the track's AudioSpecificConfig: Main and LC
 * with spectral band replication and parametric stereo (HE-AAC, HE-AACv2). Each access unit
 * decodes to one block of planes; a unit that outputs nothing yields none.
 */
export function aacAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const config = track.codecConfig;
    if (!config) throw new MediaForgeError('AAC track has no AudioSpecificConfig', 'DEMUX');
    return {
        create(): PacketDecoder {
            let decoder = createAacDecoder(config, AAC_SBR_TOOLS);
            return {
                decode(packet) {
                    const planes = decoder.decodeFrame(packet);
                    return planes[0]?.length ? [planes] : [];
                },
                reset() {
                    decoder = createAacDecoder(config, AAC_SBR_TOOLS);
                },
            };
        },
    };
}
