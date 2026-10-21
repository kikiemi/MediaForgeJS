import type { VideoQuality } from '../pipeline/plan/encode-settings';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { OptionPolicy } from '../core/errors/option-policy';
import type { Bitrate } from '../core/errors/bitrate';
import type { OpenOptions } from '../core/contracts/reader';
import type { HlsEncryptionOptions } from '../formats/hls/aes';
import type { PackagedFile } from '../pipeline/package/types';
import type { MediaProgress } from '../core/model/media';
import type {
    AudioSpeedMode,
    CodecPreference,
    ConvertSupport,
    Frame,
    MediaInfo,
    MediaPlan,
    TrackPlan,
} from '../pipeline/api-types';
import type { ImageFitMode } from '../pipeline/frames/image-geometry';
import type { GifDitherMode } from '../codecs/image/encoders';
import type { AudioStage, StageRequest, VideoStage } from '../core/contracts/stage';
import type { ImageResizeMethod } from '../codecs/image/rgba-resize';
import type { MediaInput, Sink, Source } from '../core/model/types';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../stages/geometry-settings';
import type {
    VideoEncoderBitrateControl,
    VideoEncoderHardwareAcceleration,
    VideoEncoderLatencyMode,
} from '../codecs/webcodecs/video-options';
import type { PluginSelection } from './options/plugin-selection';

export type { AudioSpeedMode } from '../pipeline/api-types';

/**
 * How the sound follows a speed change: kept at its pitch, its pitch moving with the speed, or left
 * out.
 */
export type AudioSpeedSetting = AudioSpeedMode | 'mute';

/**
 * Containers that hold video (and audio): tracks are copied when they fit and re-encoded otherwise.
 */
export type VideoTargetFormat =
    'mp4' | 'mov' | 'm4v' | 'mkv' | 'webm' | 'ts' | 'fmp4' | '3gp' | 'avi' | 'flv' | 'ivf' | 'apv';

/** Formats that hold audio only. */
export type AudioTargetFormat =
    'mp3' | 'mp2' | 'aac' | 'flac' | 'wav' | 'aiff' | 'au' | 'caf' | 'm4a' | 'ogg' | 'iamf';

/**
 * Still and animated image formats; a video input gives one picture, or an animation for gif and
 * apng.
 */
export type ImageTargetFormat =
    'png' | 'jpeg' | 'webp' | 'gif' | 'apng' | 'bmp' | 'tiff' | 'ico' | 'avif';

/** Segmented streaming presentations, produced by packageMedia(). */
export type PackageTargetFormat = 'hls' | 'dash' | 'hls+dash';

/**
 * A target format name. The listed names autocomplete; aliases and extensions such as 'matroska',
 * '.mp4', 'jpg' or 'm3u8' are accepted too.
 */
export type TargetFormat =
    VideoTargetFormat | AudioTargetFormat | ImageTargetFormat | PackageTargetFormat | (string & {});

/**
 * A video codec by name ('h264', 'hevc', 'vp8', 'vp9', 'av1') or codec string ('avc1.640028',
 * 'vp09.00.10.08'). 'auto' picks the first codec the target container carries that this browser's
 * VideoEncoder accepts.
 */
export type VideoCodecName = 'auto' | 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | (string & {});

/**
 * An audio codec by name or codec string ('mp4a.40.2'). 'auto' picks the first codec the target
 * container carries that the library or the host AudioEncoder can encode.
 */
export type AudioCodecName =
    'auto' | 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | 'pcm' | 'ulaw' | 'alaw' | (string & {});

export type { Bitrate };

/** Video quality when no bitrate is given: scales the default bitrate (×0.5, ×1, ×1.6, ×2.5). */
export type { VideoQuality };

export type { ConvertSupport, Frame, MediaInfo, MediaPlan, MediaProgress, TrackPlan, OpenOptions };

/** Settings shared by every function and by MediaForge, which holds them as defaults. */
export interface CommonOptions {
    /**
     * The plugins to use. By default every plugin of the entry: all of them from 'mediaforgejs',
     * none from 'mediaforgejs/lite'. `{ exclude: ['h264'] }` leaves plugins out,
     * `{ add: [prores] }` adds application plugins, and an array lists exactly the plugins to use.
     */
    readonly plugins?: PluginSelection;
    /** Receives every warning: option repairs, recovered damage and metadata loss. */
    readonly onWarning?: (warning: MediaDiagnostic) => void;
    /** lenient (default) repairs unusable settings and warns; strict rejects them. */
    readonly optionPolicy?: OptionPolicy;
    /**
     * 'webcodecs' (default) decodes and encodes with the host WebCodecs codecs when they support
     * the stream and uses the library's codecs otherwise; 'builtin' prefers the library's codecs.
     */
    readonly codecPreference?: CodecPreference;
    /** How inputs are read: index limits, 'strict' validation, the format to assume. */
    readonly open?: OpenOptions;
}

/** Defaults of a MediaForge instance; every call may override them. */
export type MediaForgeOptions = CommonOptions;

export interface VideoSettings {
    /**
     * Output codec: 'h264', 'hevc', 'vp8', 'vp9', 'av1', a codec string, or 'auto' for the best one
     * the host encodes.
     */
    readonly codec?: VideoCodecName;
    /** Output width in pixels; one side alone keeps the aspect ratio. */
    readonly width?: number;
    /** Output height in pixels. */
    readonly height?: number;
    /** How width and height apply when both are set; omitted stretches like fill. */
    readonly fit?: VideoFit;
    /** Pixels of the upright source kept before rotate, flip and resize; always re-encodes. */
    readonly crop?: VideoCrop;
    /**
     * Clockwise degrees. A copy into MP4/MOV/M4V/3GP/MKV/WebM changes only the display rotation.
     */
    readonly rotate?: VideoRotation;
    /** Always re-encodes. */
    readonly flip?: VideoFlip;
    /**
     * Output frames per second, made by repeating or dropping pictures. With `speed` and no rate,
     * the source's rate is kept, so slow motion plays as smoothly as the source.
     */
    readonly fps?: number;
    /**
     * Playback speed from 0.1 to 10: 0.5 is slow motion lasting twice as long, 2 plays twice as
     * fast. Applies to the whole output: the sound follows as `audio.speed` says. Default 1.
     */
    readonly speed?: number;
    /**
     * Bits per second, or text such as '2.5M'; values below 10,000 are read as kbit/s with a
     * warning.
     */
    readonly bitrate?: Bitrate;
    /** Scales the default bitrate when no bitrate is given. */
    readonly quality?: VideoQuality;
    /** Seconds between keyframes of re-encoded video; default 2, 0 makes every frame a keyframe. */
    readonly keyframeInterval?: number;
    /**
     * Re-encoding turns the source display rotation into pixels and writes rotation 0 (default
     * true).
     */
    readonly autoRotate?: boolean;
    /**
     * Host VideoEncoder hint: 'prefer-hardware', 'prefer-software' or 'no-preference' (default).
     */
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    /** Host VideoEncoder latency: 'quality' (default) or 'realtime'. */
    readonly latencyMode?: VideoEncoderLatencyMode;
    /** Host VideoEncoder rate control: 'variable' or 'constant'. */
    readonly bitrateMode?: VideoEncoderBitrateControl;
    /**
     * Processing stages each picture runs through after crop, rotate, flip and resize, in order: a
     * stage definition, or the name of a plugin's stage (with `options`). Re-encodes the video.
     */
    readonly stages?: readonly StageRequest<VideoStage>[];
}

export interface AudioSettings {
    /**
     * Output codec: 'aac', 'opus', 'flac', 'mp3', a codec string, or 'auto'. For wav, aiff, au and
     * caf targets 'ulaw' or 'alaw' selects G.711 instead of 16-bit PCM.
     */
    readonly codec?: AudioCodecName;
    /** Hz. */
    readonly sampleRate?: number;
    /** 1–8. */
    readonly channels?: number;
    /**
     * Bits per second, or text such as '192k'; values below 1,000 are read as kbit/s with a
     * warning.
     */
    readonly bitrate?: Bitrate;
    /** Variable-bitrate MP3. */
    readonly vbr?: boolean;
    /** Container targets and edits: leave the audio tracks out. */
    readonly mute?: boolean;
    /**
     * How the sound follows `video.speed`: 'preserve-pitch' (default) stretches it in time at the
     * same pitch, 'shift-pitch' resamples it so the pitch moves with the speed, 'mute' leaves it
     * out.
     */
    readonly speed?: AudioSpeedSetting;
    /**
     * Container targets: the sound of this file (its audio, trimmed to the video) instead of the
     * input's own. The video is copied where it can be, and the new sound is encoded once.
     */
    readonly replace?: Source | MediaInput;
    /**
     * Processing stages the sound runs through before it is encoded, like `video.stages`.
     * Re-encodes the audio.
     */
    readonly stages?: readonly StageRequest<AudioStage>[];
}

export interface ImageSettings {
    /** JPEG/WebP quality from 0 to 1. */
    readonly quality?: number;
    /** How width and height apply to a still image: fill (default), inside or scale-down. */
    readonly fit?: ImageFitMode;
    /**
     * Resampling: nearest, bilinear or lanczos3; default lanczos3 for a still picture and bilinear
     * for animations.
     */
    readonly resize?: ImageResizeMethod;
    /** GIF quantization: floyd-steinberg (default) or none. */
    readonly dither?: GifDitherMode;
}

/** What to produce: the format and its settings. */
export interface TargetOptions {
    /**
     * Format name, file extension or alias: mp4, mkv, webm, ts, mp3, wav, flac, png, jpeg, hls,
     * dash and others. Omitted keeps the input's container (mp4 when that cannot be written), as
     * when trimming.
     */
    readonly to?: TargetFormat;
    /**
     * Track IDs from inspect(); default every track (containers) or the only or default audio
     * track.
     */
    readonly trackIds?: readonly number[];
    /**
     * Seconds from the input's start (MPEG-TS clocks rarely begin at zero). Audio targets extract
     * from here to `end`; container targets keep this range, copies starting at the keyframe at or
     * before `start` (exact in MP4-family output through its edit list, TRIM_SNAPPED elsewhere) and
     * re-encodes cutting exactly; still images take the picture at `start`; gif and apng animate
     * from `start` to `end` at `video.fps` (default 10).
     */
    readonly start?: number;
    /** Exclusive end in seconds. */
    readonly end?: number;
    readonly video?: VideoSettings;
    readonly audio?: AudioSettings;
    readonly image?: ImageSettings;
    /**
     * Omitted copies the tracks the target carries and re-encodes the rest; true copies every track
     * or fails; false re-encodes every track.
     */
    readonly copy?: boolean;
    /**
     * false refuses output that holds fewer bits than the source, such as 24-bit sound in 16-bit
     * FLAC or 10-bit video in an 8-bit plugin codec. By default such output is written and the
     * reduction reported as a warning; WAV, AIFF, AU and CAF keep 24-bit and float sources as they
     * are.
     */
    readonly allowPrecisionLoss?: boolean;
    /** Packaging: fmp4 (default) or ts segments. */
    readonly container?: 'fmp4' | 'ts';
    /** Packaging: keyframe-aligned segment goal in seconds; default 6. */
    readonly targetDuration?: number;
    /** HLS packaging: AES-128 whole-segment encryption. */
    readonly encryption?: HlsEncryptionOptions;
    /** HLS packaging: wall-clock time of the first segment. */
    readonly programDateTime?: Date | string | number;
    /**
     * Maximum output bytes; default 256 MiB for Blob results, 1 GiB for collected packages and
     * unlimited with a sink or `onFile`.
     */
    readonly maxBytes?: number;
    /** Writes the output into this sink (closed on success) instead of a Blob. */
    readonly sink?: Sink;
    /**
     * Packaging: receives each playlist, manifest and segment as it is produced, awaited before the
     * next, instead of collecting them in `files`.
     */
    readonly onFile?: (file: PackagedFile) => void | Promise<void>;
    /** Overrides the codec preference for this target. */
    readonly codecPreference?: CodecPreference;
    /** Cancels the operation, which then rejects with code ABORT. */
    readonly signal?: AbortSignal;
    /** Progress from 0 to 1 with the stage and the media time; ends with a report of 1. */
    readonly onProgress?: (progress: MediaProgress) => void;
    /** Called once the input is read and the work is decided, before output is written. */
    readonly onPlan?: (plan: MediaPlan) => void;
}

/** Target settings with the common options of a single call. */
export interface ConvertOptions extends TargetOptions, CommonOptions {}

/**
 * Pictures to decode: every one, one every `every` seconds, or the one shown at each of `times`.
 * Geometry settings match a target's video settings; the source display rotation is applied.
 */
export interface FrameOptions {
    /**
     * 'rgba' (default) yields Frame objects with straight RGBA bytes; 'videoframe' yields WebCodecs
     * VideoFrame objects with microsecond timestamps, which the consumer must close().
     */
    readonly format?: 'rgba' | 'videoframe';
    /**
     * Seconds from the input's start, as `start` and `end` count; frame timestamps count from there
     * too.
     */
    readonly times?: readonly number[];
    readonly every?: number;
    readonly maxFrames?: number;
    readonly trackId?: number;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    /**
     * Processing stages each picture runs through after the geometry, like a target's
     * `video.stages`.
     */
    readonly stages?: readonly StageRequest<VideoStage>[];
    readonly signal?: AbortSignal;
    /** Progress by the time of each picture; stage 'decode'. */
    readonly onProgress?: (progress: MediaProgress) => void;
}

/**
 * One picture as an image file: the one shown at `time` seconds (default 0), as png (default), jpeg
 * or webp.
 */
export interface ThumbnailOptions extends Omit<
    FrameOptions,
    'times' | 'every' | 'maxFrames' | 'onProgress'
> {
    /** Seconds from the input's start; default 0. */
    readonly time?: number;
    /** Default png, which works everywhere; jpeg and webp need OffscreenCanvas. */
    readonly to?: 'png' | 'jpeg' | 'webp';
    /** JPEG/WebP quality from 0 to 1. */
    readonly quality?: number;
}

/** One finished output. */
export interface MediaResult {
    /** The output file, typed with `mimeType`. */
    readonly blob: Blob;
    /** Canonical output format, such as 'mp4'. */
    readonly format: string;
    /** MIME type, such as 'video/mp4'. */
    readonly mimeType: string;
    /**
     * A name to save under: the input file's name with the output extension, or
     * `output.<extension>`.
     */
    readonly filename: string;
    /** What was copied and what was encoded, by which codec. */
    readonly plan: MediaPlan;
    /** Every warning of the operation, also delivered to `onWarning`. */
    readonly warnings: readonly MediaDiagnostic[];
}

/** An output written into the `sink` option instead of a Blob. */
export type SinkResult = Omit<MediaResult, 'blob'>;

/** The files of an HLS or DASH presentation. */
export interface PackageResult {
    /** Every playlist, manifest, initialization and media segment, keyed by file name. */
    readonly files: Map<string, PackagedFile>;
    /** The file a player opens: master.m3u8 for HLS, manifest.mpd for DASH. */
    readonly entry: string;
    readonly format: PackageTargetFormat;
    readonly plan: MediaPlan;
    readonly warnings: readonly MediaDiagnostic[];
}
