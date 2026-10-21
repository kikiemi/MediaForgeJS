/** The plugins entry, mediaforgejs/plugins: the library's plugins and the plugin contract. */
export { MediaForgeError } from '../../core/errors/errors';
export type {
    ApplicationVideoDecoderFactory,
    ApplicationVideoDecoderPart,
    AudioDecoderFactory,
    AudioDecoderPart,
    AudioEncoderPart,
    CodecMatch,
    DecoderPart,
    EncoderPart,
    LibraryAudioEncoderCodec,
    MediaForgePlugin,
    PluginManifest,
    VideoDecoderFactory,
    VideoDecoderPart,
    VideoEncoderFactory,
    VideoEncoderPart,
} from '../../core/contracts/plugin';
export type {
    DemuxProbe,
    ReadOptions,
    Reader,
    ReaderCapabilities,
    ReaderPart,
} from '../../core/contracts/reader';
export { bindCompactSampleIndex, bindPacketizedReader } from '../../core/model/sample-index';
export type { PacketizedSampleReader, SampleIndex } from '../../core/model/sample-index';
export type {
    PlayerFactory,
    PlayerPart,
    PlayerProtocol,
    PlayerRequest,
    PlayerSettings,
    RenditionChoice,
} from '../../core/contracts/player';
export type {
    AudioWriterFactory,
    AudioWriterPart,
    ContainerWriterFactory,
    ContainerWriterPart,
    WriterPart,
} from '../../core/contracts/writer';
export type {
    BuiltinAudioCodec,
    BuiltinVideoDecoder,
    BuiltinVideoDecoderConfig,
    PacketDecoder,
    VideoCodecDecoder,
    VideoDecoderConfig,
} from '../../core/contracts/decoder';
export type {
    VideoCodecEncoder,
    VideoCodecProvider,
    VideoEncoderConfig,
} from '../../core/contracts/encoder';
export type {
    DecodedVideoFrame,
    PlanarVideoFrame,
    RgbaVideoFrame,
    VideoFramePlane,
} from '../../core/contracts/picture';
export type {
    AudioPlanes,
    AudioStage,
    AudioStreamInfo,
    EmitAudio,
    EmitPicture,
    StageDefinition,
    StageRequest,
    VideoPicture,
    VideoStage,
    VideoStreamInfo,
} from '../../core/contracts/stage';
export { createPicture } from '../../stages/create-picture';
export type { PluginName } from '../../plugins/catalog';
export {
    aac,
    ac3,
    alac,
    allPlugins,
    apv,
    asf,
    avi,
    flac,
    flv,
    h264,
    iamf,
    ivf,
    mpeg12,
    mpeg4,
    mpegAudio,
    mpegPs,
    mxf,
    opus,
    vorbis,
} from '../../plugins/index';
export type { PluginSelection } from '../options/plugin-selection';
