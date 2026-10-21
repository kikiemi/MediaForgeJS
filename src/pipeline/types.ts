import type { HlsEncryptionOptions } from '../formats/hls/aes';
import type { Sink } from '../core/model/types';
import type { MediaProgress, OutputContainerFormat, MediaTags } from '../core/model/media';
import type { TrackInfo } from '../core/model/track';
import type { DiagnosticContext, Warn } from '../core/errors/diagnostics';
import type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';
import type { MediaFile } from './read/media-file';
import type { RemuxOptions } from './media-types';
import type {
    AudioSpeedMode,
    AudioTrackDecodeOptions,
    CodecPreference,
    MediaPlan,
} from './api-types';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../stages/geometry-settings';
import type { StageFactory } from '../stages/chain';
import type { PcmSampleFormat } from '../codecs/pcm/encoder';
import type { AudioStage, VideoStage } from '../core/contracts/stage';
import type {
    VideoEncoderBitrateControl,
    VideoEncoderHardwareAcceleration,
    VideoEncoderLatencyMode,
} from '../codecs/webcodecs/video-options';

export type AudioFileFormat = 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp3';

/**
 * Sample coding of PCM container output: 16-bit linear (default) or G.711 companding in WAV, AU and
 * CAF.
 */
export type PcmCoding = 'pcm' | 'ulaw' | 'alaw';

export interface AudioFileRequest {
    readonly operation: 'audio';
    readonly format: AudioFileFormat;
    readonly trackId?: number;
    readonly sampleRate?: number;
    readonly channels?: number;
    /** Bits per second, like every other bitrate. */
    readonly bitrate?: number;
    readonly vbr?: boolean;
    /**
     * wav, aiff, au and caf only: 'ulaw' or 'alaw' writes 8-bit G.711 codes instead of 16-bit PCM.
     */
    readonly codec?: PcmCoding;
    /** Stages the sound runs through before it is encoded. */
    readonly stages?: readonly StageFactory<AudioStage>[];
    /**
     * False refuses a format that cannot keep the source precision, such as 24-bit sound into
     * 16-bit FLAC.
     */
    readonly allowPrecisionLoss?: boolean;
    /** Inclusive presentation time in seconds, after input trim metadata. */
    readonly start?: number;
    /** Exclusive presentation time in seconds. */
    readonly end?: number;
    /** Overrides the workflow's codecPreference for this request. */
    readonly codecPreference?: CodecPreference;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
}

export interface CopyRequest extends Omit<RemuxOptions, 'onProgress'> {
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly operation: 'remux';
}

export interface ConvertRequest {
    readonly operation: 'convert';
    readonly format: OutputContainerFormat;
    readonly videoCodec?: string;
    readonly audioCodec?: string;
    readonly width?: number;
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
    /** Seconds between keyframes of re-encoded video; default 2, 0 makes every frame a keyframe. */
    readonly keyframeInterval?: number;
    /**
     * Re-encoding turns the source display rotation into pixels and writes rotation 0 (default
     * true).
     */
    readonly autoRotate?: boolean;
    /**
     * Constant output frame rate, made by repeating or dropping pictures; with a speed and no rate,
     * the source's rate is kept.
     */
    readonly fps?: number;
    /**
     * Playback speed of the output, from 0.1 to 10: 0.5 plays at half speed and lasts twice as
     * long; default 1.
     */
    readonly speed?: number;
    /** How the sound follows a speed other than 1; default 'preserve-pitch'. */
    readonly audioSpeed?: AudioSpeedMode;
    /** Bits per second of re-encoded video. */
    readonly videoBitrate?: number;
    /** Host VideoEncoder hint; default 'no-preference'. */
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    /** Host VideoEncoder latency mode; default 'quality'. */
    readonly latencyMode?: VideoEncoderLatencyMode;
    /** Host VideoEncoder rate control; default the host's ('variable' in current browsers). */
    readonly bitrateMode?: VideoEncoderBitrateControl;
    /** Permit reduction to 8-bit RGBA when a registered video codec requires it. */
    readonly allowPrecisionLoss?: boolean;
    /** Bits per second of re-encoded audio. */
    readonly audioBitrate?: number;
    readonly audioSampleRate?: number;
    readonly audioChannels?: number;
    /** Stages the pictures run through after the geometry; any re-encodes the video. */
    readonly videoStages?: readonly StageFactory<VideoStage>[];
    /** Stages the sound runs through; any re-encodes the audio. */
    readonly audioStages?: readonly StageFactory<AudioStage>[];
    readonly trackIds?: readonly number[];
    /**
     * Overrides the workflow's codecPreference for this request; video and audio codec stages read
     * it.
     */
    readonly codecPreference?: CodecPreference;
    /**
     * Decodes and encodes every selected track, also one the other settings leave as it is
     * (`copy: false`).
     */
    readonly reencode?: boolean;
    /**
     * Presentation seconds to keep. A copy starts at the keyframe at or before `start` (MP4-family
     * output presents the exact time through its edit list); a re-encode cuts exactly.
     */
    readonly start?: number;
    /** Exclusive presentation end in seconds. */
    readonly end?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
}

export type OperationRequest = CopyRequest | AudioFileRequest | ConvertRequest;

/** Multi-file HLS/DASH VOD output; served by package() rather than the single-sink methods. */
export interface PackageRequest {
    readonly operation: 'package';
    /** hls+dash writes one demuxed CMAF segment set with both a DASH manifest and HLS playlists. */
    readonly format: 'hls' | 'dash' | 'hls+dash';
    /** HLS only. Default fmp4; ts is multiplexed MPEG-TS. */
    readonly container?: 'fmp4' | 'ts';
    /** Keyframe-aligned goal in seconds. Default 6. */
    readonly targetDuration?: number;
    readonly trackIds?: readonly number[];
    /**
     * HLS fMP4: separate video and audio playlists with an audio rendition group. Always on for
     * DASH.
     */
    readonly demuxed?: boolean;
    /** Default 100000; exceeding fails with code OUTPUT. */
    readonly maxSegments?: number;
    /**
     * Bytes across all files; exceeding fails with code OOM. Unlimited when iterating, 1 GiB by
     * default when collecting.
     */
    readonly maxTotalBytes?: number;
    /** Pending bytes of one segment before the next keyframe. Default 128 MiB. */
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    /** HLS only: AES-128 whole-segment encryption announced by EXT-X-KEY. */
    readonly encryption?: HlsEncryptionOptions;
    /** HLS only: wall-clock time of the first segment, written as EXT-X-PROGRAM-DATE-TIME. */
    readonly programDateTime?: Date | string | number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
}

export interface ConversionRunner {
    /**
     * The plan of `request`; a request that cannot run throws why. Warnings go to `diagnostics`.
     */
    probe(file: MediaFile, request: ConvertRequest, diagnostics: DiagnosticContext): MediaPlan;
    /**
     * Whether write() copies the tracks of `request` as a copy of the file does, rather than
     * through the timeline that copies and encodes lanes; a request that cannot run throws why.
     */
    copies(file: MediaFile, request: ConvertRequest): boolean;
    write(
        file: MediaFile,
        sink: Sink,
        request: ConvertRequest,
        diagnostics: DiagnosticContext,
    ): Promise<void>;
}

export interface AudioTrackDecoder {
    readonly codecs: readonly string[];
    /**
     * Must validate known configuration without reading packets; return a replayable, lazy source.
     */
    createSource(
        track: TrackInfo,
        readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>,
        options?: AudioTrackDecodeOptions,
    ): ReplayablePcmSource;
}

export interface AudioFileConfig {
    readonly format: AudioFileFormat;
    readonly sampleRate: number;
    readonly channels: number;
    readonly estimatedFrames: number;
    readonly bitrateKbps?: number;
    readonly vbr?: boolean;
    readonly codec?: PcmCoding;
    /** Linear PCM output: the sample coding chosen from the source; default s16. */
    readonly sampleFormat?: PcmSampleFormat;
    readonly codecPreference?: CodecPreference;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    /** Receives encoding warnings such as AUDIO_ENCODER_FALLBACK. */
    readonly onWarning?: Warn;
    /** The input's tags, chapters and pictures, for the formats that write them. */
    readonly tags?: MediaTags;
}

export interface AudioFileWriter {
    readonly formats: readonly AudioFileFormat[];
    /** Checks known output configuration without source reads or output writes. */
    check(config: AudioFileConfig): void;
    encode(source: ReplayablePcmSource, sink: Sink, config: AudioFileConfig): Promise<void>;
}

export interface BlobOptions {
    /**
     * Maximum generated bytes. Blob defaults to 256 MiB; check/write/stream have no default byte
     * cap.
     */
    readonly maxBytes?: number;
}
