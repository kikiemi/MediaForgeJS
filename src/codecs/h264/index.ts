import { definePlugin } from '../../core/contracts/plugin';
import { h264Manifest } from './manifest';

/**
 * H.264 decoding (Constrained Baseline to High, 8-bit 4:2:0 and 4:2:2) where the host
 * VideoDecoder cannot.
 */
export const h264 = definePlugin(h264Manifest, {
    decoders: {
        h264: async () => (await import('./decoder')).createH264Decoder,
    },
});
