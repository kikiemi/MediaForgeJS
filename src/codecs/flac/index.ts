import { definePlugin } from '../../core/contracts/plugin';
import { flacManifest } from './manifest';

/**
 * FLAC decoding and encoding where the host AudioDecoder and AudioEncoder cannot.
 */
export const flac = definePlugin(flacManifest, {
    decoders: {
        flac: async () => (await import('./decoder')).flacAudioCodec,
    },
    encoders: {
        flac: async () => (await import('./encoder')).StreamingFlacEncoder,
    },
});
