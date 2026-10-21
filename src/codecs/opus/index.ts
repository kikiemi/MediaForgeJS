import { definePlugin } from '../../core/contracts/plugin';
import { opusManifest } from './manifest';

/**
 * Opus decoding (SILK, CELT and hybrid, up to eight channels) where the host AudioDecoder
 * cannot.
 */
export const opus = definePlugin(opusManifest, {
    decoders: {
        opus: async () => (await import('./track')).opusAudioCodec,
    },
});
