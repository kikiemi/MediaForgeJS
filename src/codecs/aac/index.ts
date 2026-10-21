import { definePlugin } from '../../core/contracts/plugin';
import { aacManifest } from './manifest';

/**
 * AAC decoding (Main, LC, HE-AAC and HE-AACv2) where the host AudioDecoder cannot, as in Node,
 * and AAC-LC encoding where the host AudioEncoder cannot.
 */
export const aac = definePlugin(aacManifest, {
    decoders: {
        aac: async () => (await import('./track')).aacAudioCodec,
    },
    encoders: {
        aac: async () => (await import('./encoder')).StreamingAacLcEncoder,
    },
});
