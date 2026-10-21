/**
 * The parts the functions of 'mediaforgejs' are assembled from, to build a pipeline of your own:
 * open() reads an input into tracks and packets, a decoder turns packets into pictures and
 * decodeAudio() a track into PCM, stages change pictures and sound, an encoder turns pictures back
 * into packets, and a muxer writes packets into a file and encodes PCM into its audio track.
 * createParts({ plugins }) gives the same parts with a choice of plugins.
 */
import { createParts } from '../parts';

export { Media } from '../media';
export { createParts, createVideoDecoder, decodeAudio } from '../parts';
export type { AudioDecodeOptions, Parts, PartsOptions } from '../parts';
export {
    createVideoStages,
    frameRate,
    remix,
    speed,
    stageAudio,
    timeStretch,
    transform,
} from '../../pipeline/parts';
export type {
    PartOptions,
    PcmSource,
    RemixOptions,
    TransformOptions,
    VideoStages,
} from '../../pipeline/parts';
export type {
    EncodeAudioOptions,
    Muxer,
    MuxerAudioTrack,
    MuxerOptions,
    MuxerVideoTrack,
    VideoDecoderOptions,
    VideoDecoderPart,
    VideoEncoderOptions,
    VideoEncoderPart,
} from '../../pipeline/codecs/part-options';
export { createPicture } from '../../stages/create-picture';
export type {
    AudioPlanes,
    AudioStage,
    AudioStreamInfo,
    EmitAudio,
    EmitPicture,
    VideoPicture,
    VideoStage,
    VideoStreamInfo,
} from '../../core/contracts/stage';
export type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../../stages/geometry-settings';
export type { EncodedPacket } from '../../core/model/media';
export type { MediaTrack } from '../../core/model/media';
export type { MediaPacket, PacketOptions } from '../../pipeline/packet-types';
export type { MediaDiagnostic } from '../../core/errors/diagnostics';
export type { Sink, Source } from '../../core/model/types';

/** The parts with every plugin of the library; createParts() binds them to a choice of plugins. */
export const { open, createVideoEncoder, createMuxer } = createParts();
