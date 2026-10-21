import type { BuiltinVideoCodec, BuiltinVideoDecoderConfig } from '../../core/contracts/decoder';
import { parseRawVideoCodec } from '../../core/codec-config/video/raw-video';

/**
 * The video decoders of the core: uncompressed layouts only, which the core readers already name;
 * the unpacking loads with the first decoder. Compressed codecs decode through the host
 * VideoDecoder, or through the h264, mpeg12 and mpeg4 plugins.
 */
export const coreVideoDecoders: readonly BuiltinVideoCodec[] = Object.freeze([
    Object.freeze({
        id: 'uncompressed',
        supports: (codec: string) => parseRawVideoCodec(codec) !== undefined,
        create: async (config: BuiltinVideoDecoderConfig) =>
            (await import('../../codecs/shared/raw-video')).uncompressedVideoCodec.create(config),
    }),
]);
