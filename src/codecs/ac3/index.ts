import { definePlugin } from '../../core/contracts/plugin';
import { ac3Manifest } from './manifest';

/**
 * AC-3 and E-AC-3 (Dolby Digital and Dolby Digital Plus, 7.1 with a dependent substream) decoding
 * where the host AudioDecoder cannot.
 */
export const ac3 = definePlugin(ac3Manifest, {
    decoders: {
        ac3: async () => (await import('./track')).ac3AudioCodec,
    },
});
