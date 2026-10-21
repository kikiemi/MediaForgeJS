import { definePlugin, type VideoDecoderFactory } from '../../core/contracts/plugin';
import { mpeg12Manifest } from './manifest';

/**
 * MPEG-1 and MPEG-2 video decoding (DVD, broadcast MPEG-TS), which WebCodecs does not offer.
 */
export const mpeg12 = definePlugin(mpeg12Manifest, {
    decoders: {
        mpeg2video: async () => {
            const { mpeg12VideoCodec } = await import('./decoder');
            const create: VideoDecoderFactory = config => mpeg12VideoCodec.create(config);
            return create;
        },
    },
});
