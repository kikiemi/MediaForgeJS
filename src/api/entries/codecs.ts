/**
 * mediaforgejs/codecs: the audio and image codecs as standalone functions and classes.
 */
export * from '../surface-codecs';
export { encodeMp2 } from '../audio-encoders';
export {
    decodeFlac,
    decodeFlacFrame,
    flacSamplesToFloat,
    parseFlacStreamInfo,
} from '../../codecs/flac/decoder';
export type {
    DecodedFlac,
    DecodedFlacFrame,
    FlacFrameDecodeOptions,
    FlacStreamInfo,
} from '../../codecs/flac/decoder';
export {
    StreamingMp3Decoder,
    decodeMp3,
    isMp3InfoFrame,
    parseMp3FrameHeader,
} from '../../codecs/mpeg-audio/mp3-decoder';
export type { DecodedMp3, Mp3FrameHeader } from '../../codecs/mpeg-audio/mp3-decoder';
export { createFlacTrackPcmSource, createMp3TrackPcmSource } from '../audio-track-sources';
export { AlacDecoder, parseAlacConfig } from '../../codecs/alac/decoder';
export type { AlacConfig } from '../../codecs/alac/decoder';
