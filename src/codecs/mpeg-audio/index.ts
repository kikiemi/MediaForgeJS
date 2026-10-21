import { definePlugin } from '../../core/contracts/plugin';
import { mpegAudioManifest } from './manifest';

/**
 * MPEG audio: MP3, MP2 and MP1 decoding where the host AudioDecoder cannot, as in Node, and the
 * MP2 and MP3 encoders, which WebCodecs does not offer.
 */
export const mpegAudio = definePlugin(mpegAudioManifest, {
    decoders: {
        mpegAudio: async () => (await import('./mp3-decoder')).mpegAudioCodec,
    },
    encoders: {
        mp2: async () => (await import('./mp2-encoder')).StreamingMp2Encoder,
        mp3: async () => (await import('./mp3-encoder')).StreamingMp3Encoder,
    },
});
