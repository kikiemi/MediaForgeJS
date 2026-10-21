/**
 * The names mediaforgejs and mediaforgejs/lite share: the option, result, plugin and stage
 * types, Media and the errors. Each entry adds its MediaForge and the functions of a default
 * one.
 */
export type { CapabilityOptions, MediaCapabilities } from './capability-types';
export type {
    EditAudioTrack,
    EditClip,
    EditClipAudio,
    EditClipVideo,
    EditFade,
    EditImageOverlay,
    EditOverlay,
    EditProject,
    EditTextOverlay,
} from '../editing/project';
export type {
    EncodeAudioSettings,
    EncodeFramesOptions,
    EncodeSources,
    EncodeTargetFormat,
    EncodeVideoSettings,
    MediaRecording,
    RecordStreamOptions,
} from './encode-options';
export type {
    FrameCallOptions,
    Input,
    InspectOptions,
    OpenCallOptions,
    ThumbnailCallOptions,
} from './forge';
export { Media } from './media';
export type { Playback, Player, PlayOptions } from './play';
export type { PluginSelection } from './options/plugin-selection';
export type {
    AudioCodecName,
    AudioSettings,
    AudioSpeedMode,
    AudioSpeedSetting,
    AudioTargetFormat,
    Bitrate,
    CommonOptions,
    ConvertOptions,
    ConvertSupport,
    Frame,
    FrameOptions,
    ImageSettings,
    ImageTargetFormat,
    MediaForgeOptions,
    MediaInfo,
    MediaProgress,
    MediaPlan,
    MediaResult,
    OpenOptions,
    PackageResult,
    PackageTargetFormat,
    SinkResult,
    TargetFormat,
    TargetOptions,
    ThumbnailOptions,
    TrackPlan,
    VideoCodecName,
    VideoSettings,
    VideoTargetFormat,
} from './types';
export type { MediaTrack } from '../core/model/media';
export type {
    MediaPacket,
    MediaSegment,
    PacketOptions,
    PacketSearchOptions,
    SegmentOptions,
} from '../pipeline/packet-types';
export type { MediaForgePlugin } from '../core/contracts/plugin';
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
} from '../core/contracts/stage';
export type { VideoQuality } from '../pipeline/plan/encode-settings';
export type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../stages/geometry-settings';
export type { MediaDiagnostic, MetadataPolicy, ValidationMode } from '../core/errors/diagnostics';
export type { ErrorCode, MediaForgeErrorOptions } from '../core/errors/errors';
export { ERROR_CODES, MediaForgeError, isMediaForgeError } from '../core/errors/errors';
export type { FrameStream } from '../recording/frame-streams';
export type { MediaInput, Sink, Source } from '../core/model/types';
export type { PluginName } from '../plugins/catalog';
