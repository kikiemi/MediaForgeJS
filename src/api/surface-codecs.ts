/**
 * The codecs both scripts carry: the AAC, MP3 and FLAC encoders, which load with their first call,
 * the AAC-LC decoder, G.711, PCM output and the image codecs. mediaforgejs/codecs adds the decoders
 * of MP3, FLAC and ALAC and the MP2 encoder.
 *
 * One shape for all: encoders take planar PCM and options naming its sample rate; the file
 * encoders return the encoded stream and encodeAacLc raw frames. Decode functions take their input
 * and options; those that decode a whole stream are async and stop with `options.signal`.
 */
export { encodeMp3, encodeFlac, encodeAacLc } from './audio-encoders';
export type { AudioEncodeOptions, Mp3EncodeOptions } from './audio-encoders';
export type { AacEncodeResult } from '../codecs/aac/encoder';
export type { DecodeOptions } from '../core/contracts/decoder';
export type { Bitrate } from '../core/errors/bitrate';
import type { AudioTrackDecodeOptions } from '../pipeline/api-types';
import type { EncodedAudioSampleReader } from '../core/contracts/decoder';
export type {
    BuiltinAudioDecoder,
    BuiltinAudioCodec,
    PacketDecoder,
} from '../core/contracts/decoder';
import type { TrackInfo } from '../core/model/track';
import type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';
import { createAudioTrackSource as trackSource } from '../pipeline/codecs/audio-track-decoder';
import { MissingParts } from '../pipeline/plugins/missing-parts';
import { PLUGIN_CATALOG } from '../plugins/catalog';

export type { AudioTrackDecodeOptions, EncodedAudioSampleReader };
export { decodeG711, encodeG711 } from '../codecs/pcm/g711';
export type { G711Codec, G711Options } from '../codecs/pcm/g711';
export { AacLcDecoder, decodeAacFrames } from '../codecs/aac/decoder';
export type { DecodedAac, AacDecodeOptions } from '../codecs/aac/decoder';
export { normalizePcmSource } from '../codecs/pcm/pcm-source';
export type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';
export { encodeReplayablePcm, encodeReplayablePcmToSink } from './audio-output';
export type {
    StreamingSelfHostedAudioFormat,
    StreamingAudioDiagnostics,
    StreamingAudioEncodeOptions,
} from './audio-output';
export {
    sliceAdtsFrames,
    parseAdtsHeader,
    buildAacAsc,
    wrapAdts,
} from '../core/codec-config/audio/adts';
export type { AacFrames } from '../core/codec-config/audio/adts';

const missing = new MissingParts(PLUGIN_CATALOG);

/**
 * Decodes an audio track into replayable PCM: the host AudioDecoder first (unless `codecPreference`
 * is 'builtin'), then the library's decoders and those of `options.decoders`. A codec nothing
 * decodes fails with PLUGIN naming the plugin that would.
 */
export function createAudioTrackSource(
    track: TrackInfo,
    read: EncodedAudioSampleReader,
    options: AudioTrackDecodeOptions = {},
): ReplayablePcmSource {
    return trackSource(track, read, { missing, ...options });
}
export {
    encodePng,
    encodeJpeg,
    encodeWebP,
    encodeBmp,
    encodeTiff,
    encodeIco,
    AnimatedGifEncoder,
    ApngEncoder,
} from '../codecs/image/encoders';
export type {
    AnimationEncoderOptions,
    ApngEncoderOptions,
    GifDitherMode,
    GifEncoderOptions,
    ImageEncodeOptions,
} from '../codecs/image/encoders';
export { AnimatedWebpEncoder } from '../codecs/image/webp-writer';
export type { AnimatedWebpEncoderOptions } from '../codecs/image/webp-writer';
export { RgbaResizer } from '../codecs/image/rgba-resize';
export { parseImageInfo } from '../core/codec-config/image-info';
export type { ImageInfo, ImageFrameInfo } from '../core/codec-config/image-info';
export { decodeVp8l } from '../codecs/image/vp8l-decoder';
export type { Vp8lImage } from '../codecs/image/vp8l-decoder';
export { decodeAnimatedWebp, decodeStillWebp } from '../codecs/image/webp-reader';
export type { AnimatedWebpDecodeOptions } from '../codecs/image/webp-reader';
export type {
    AnimatedFrame,
    AnimatedImage,
    DecodedImage,
    RgbaImage,
} from '../codecs/image/rgba-image';
