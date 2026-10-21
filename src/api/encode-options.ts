import type { FrameStream } from '../recording/frame-streams';
import type { StageRequest, VideoStage } from '../core/contracts/stage';
import type {
    AudioCodecName,
    Bitrate,
    CommonOptions,
    MediaProgress,
    MediaPlan,
    MediaResult,
    VideoCodecName,
    VideoQuality,
} from './types';
import type {
    VideoEncoderBitrateControl,
    VideoEncoderHardwareAcceleration,
    VideoEncoderLatencyMode,
} from '../codecs/webcodecs/video-options';

// The options and results of encodeFrames() and recordStream(), apart from the code that runs
// them (./encode).

/** Pictures and sound to encode; either may be left out. */
export interface EncodeSources {
    readonly video?: FrameStream<VideoFrame>;
    readonly audio?: FrameStream<AudioData>;
}

/** Containers encodeFrames() and recordStream() write. */
export type EncodeTargetFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv';

export interface EncodeVideoSettings {
    /**
     * 'auto' (default) picks the first codec the container carries that this browser encodes at
     * this size.
     */
    readonly codec?: VideoCodecName;
    /**
     * Output size; default the first frame's display size. Other sizes are scaled through
     * OffscreenCanvas.
     */
    readonly width?: number;
    readonly height?: number;
    /** Frame rate for rate control and frames without a duration; default 30. */
    readonly fps?: number;
    /** Bits per second or text such as '2.5M'; default scales with size and rate. */
    readonly bitrate?: Bitrate;
    /** Scales the default bitrate when no bitrate is given. */
    readonly quality?: VideoQuality;
    /** Seconds between keyframes; default 2. */
    readonly keyframeInterval?: number;
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    /** 'quality' (default for encodeFrames) or 'realtime' (default for recordStream). */
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
    /**
     * Processing stages each picture runs through at the output size, like a target's
     * `video.stages`.
     */
    readonly stages?: readonly StageRequest<VideoStage>[];
}

export interface EncodeAudioSettings {
    /**
     * 'auto' (default): AAC for MP4-family output (the host encoder, else the built-in one), Opus
     * for WebM and MKV.
     */
    readonly codec?: AudioCodecName;
    /** Bits per second or text such as '128k'; default 128 kbit/s. */
    readonly bitrate?: Bitrate;
}

export interface EncodeFramesOptions extends Pick<
    CommonOptions,
    'onWarning' | 'optionPolicy' | 'codecPreference'
> {
    /** Output container; default mp4. */
    readonly to?: EncodeTargetFormat | (string & {});
    readonly video?: EncodeVideoSettings;
    /** Audio settings, or false to leave the audio out. */
    readonly audio?: EncodeAudioSettings | false;
    /**
     * Seconds the input is expected to last, for progress; without it progress reports only the
     * media time.
     */
    readonly duration?: number;
    /** Maximum output bytes; default 256 MiB. */
    readonly maxBytes?: number;
    /**
     * Cancels encoding; the call then rejects with code ABORT. Unread frames stay with their
     * source.
     */
    readonly signal?: AbortSignal;
    /** Progress by media time; stage 'encode'. */
    readonly onProgress?: (progress: MediaProgress) => void;
    /** Called once the codecs are chosen, before the first frame is encoded. */
    readonly onPlan?: (plan: MediaPlan) => void;
}

/** A recording in progress: stop() finishes the file, the signal cancels it. */
export interface MediaRecording {
    /** Settles when the recording finishes: after stop(), maxDuration, or when every track ends. */
    readonly result: Promise<MediaResult>;
    /**
     * Stops reading the stream and finishes the file; the tracks keep running and stay yours to
     * stop.
     */
    stop(): Promise<MediaResult>;
}

export interface RecordStreamOptions extends EncodeFramesOptions {
    /** Seconds after which the recording stops on its own. */
    readonly maxDuration?: number;
}
