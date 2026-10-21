import { definePlugin, type VideoDecoderFactory } from '../../core/contracts/plugin';
import { mpeg4Manifest } from './manifest';

/**
 * MPEG-4 Part 2 (DivX, Xvid) and H.263 decoding, which WebCodecs does not offer.
 */
export const mpeg4 = definePlugin(mpeg4Manifest, {
    decoders: {
        'mpeg4-part2': async () => {
            const { mpeg4VideoCodec } = await import('./decoder');
            const create: VideoDecoderFactory = config => mpeg4VideoCodec.create(config);
            return create;
        },
    },
});
