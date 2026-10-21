import { definePlugin } from '../../core/contracts/plugin';
import { alacManifest } from './manifest';

/**
 * Apple Lossless decoding, which WebCodecs does not offer.
 */
export const alac = definePlugin(alacManifest, {
    decoders: {
        alac: async () => (await import('./decoder')).alacAudioCodec,
    },
});
