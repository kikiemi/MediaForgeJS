import { definePlugin } from '../../core/contracts/plugin';
import { vorbisManifest } from './manifest';

/**
 * Vorbis decoding where the host AudioDecoder cannot.
 */
export const vorbis = definePlugin(vorbisManifest, {
    decoders: {
        vorbis: async () => (await import('./track')).vorbisAudioCodec,
    },
});
