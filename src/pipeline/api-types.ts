import type { MediaDiagnostic, ValidationMode, Warn } from '../core/errors/diagnostics';
import type { ErrorCode } from '../core/errors/errors';
import type { BuiltinAudioDecoder } from '../core/contracts/decoder';
import type { MediaTrack } from '../core/model/media';

// The pipeline's types the API shows: what inspect(), check() and the plans report, and the
// settings the operations share. The requests and runners behind them are in ./types.

/**
 * How sound follows a speed change: kept at its pitch by time stretching, or resampled so its pitch
 * follows.
 */
export type AudioSpeedMode = 'preserve-pitch' | 'shift-pitch';

/**
 * Which codec implementation runs first: 'webcodecs' prefers the host WebCodecs decoder or encoder
 * when it supports the configuration, 'builtin' prefers the library's own; the other one takes over
 * when the first is unavailable.
 */
export type CodecPreference = 'webcodecs' | 'builtin';

/** How an audio track is decoded into PCM. */
export interface AudioTrackDecodeOptions {
    /**
     * 'webcodecs' (default) runs a supporting host AudioDecoder first; 'builtin' runs the library
     * decoder first.
     */
    readonly codecPreference?: CodecPreference;
    /**
     * 'strict' refuses recovered (incomplete) tracks; 'compatible' (default) conceals their
     * undecodable packets.
     */
    readonly validation?: ValidationMode;
    readonly signal?: AbortSignal;
    /**
     * AUDIO_DECODER_FALLBACK, AUDIO_FRAME_CONCEALED and decoder reports (AUDIO_FORMAT_CHANGED),
     * each at most once per source.
     */
    readonly onWarning?: Warn;
    /** Only the library decoder runs; for the codec-specific public decoders. */
    readonly builtinOnly?: boolean;
    /** Plugin decoders tried besides the core's; see MediaForgePlugin.audioDecoders. */
    readonly decoders?: readonly BuiltinAudioDecoder[];
}

/**
 * Whether an operation can run on an input, and its plan; unsupported answers carry the error it
 * would fail with.
 */
export type ConvertSupport =
    | {
          readonly supported: true;
          /** What the operation does with each track. */
          readonly plan: MediaPlan;
          readonly warnings: readonly MediaDiagnostic[];
      }
    | {
          readonly supported: false;
          readonly code: ErrorCode;
          /** The message the operation would fail with. */
          readonly reason: string;
          /** What to do instead, where known; the same hint the operation's error would carry. */
          readonly hint?: string;
          /** With code PLUGIN: the plugin to include, such as 'aac'. */
          readonly plugin?: string;
          readonly warnings: readonly MediaDiagnostic[];
      };

/** What a conversion does with one selected track. */
export interface TrackPlan {
    readonly trackId: number;
    readonly type: 'video' | 'audio' | 'subtitle';
    /** `copy` writes the packets unchanged; `encode` decodes and encodes them. */
    readonly action: 'copy' | 'encode';
    /** Codec string of the input track. */
    readonly sourceCodec: string;
    /**
     * Codec string or family written; the host may refine the profile and level when it encodes.
     */
    readonly codec: string;
    /**
     * Who encodes: the host WebCodecs encoder first, the library's own, or a plugin's codec; absent
     * for copies.
     */
    readonly encoder?: 'webcodecs' | 'builtin' | 'plugin';
    /**
     * The processing stages of an encoded track, in order: the target's, then 'speed' and the
     * frame-rate stage 'fps' for video, and 'time-stretch' or 'resample' for
     * sound whose speed changes.
     */
    readonly stages?: readonly string[];
    /** Encoded video: the constant output frame rate, where the output has one. */
    readonly fps?: number;
    /** Encoded video: the output picture size. */
    readonly width?: number;
    readonly height?: number;
    /** Encoded audio: the output rate in Hz and channel count. */
    readonly sampleRate?: number;
    readonly channels?: number;
}

/** What an operation decided for its input: the output format and the treatment of each track. */
export interface MediaPlan {
    /** Canonical output format, such as 'mp4'. */
    readonly format: string;
    /**
     * 'copy' when every track keeps its packets, 'reencode' when at least one is decoded and
     * encoded.
     */
    readonly action: 'copy' | 'reencode' | 'image' | 'package';
    /** Each kept input track and what happens to it; empty for still-image inputs. */
    readonly tracks: readonly TrackPlan[];
    /** Seconds of media the output covers, where known. */
    readonly duration?: number;
}

/** One decoded picture as straight RGBA8; the caller owns `data`. */
export interface Frame {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    /** Presentation time of the picture in seconds; frames() counts it from the input's start. */
    readonly timestamp: number;
}

export interface MediaInfo {
    readonly title?: string;
    readonly format: string;
    /**
     * The tracks. `sampleCount` is absent when inspect() described an MPEG-TS, Matroska, WebM or
     * Ogg input from its head and tail without counting its packets, as it does at any size unless
     * the input is damaged; `sampleCounts: true` counts them.
     */
    readonly tracks: readonly (Omit<MediaTrack, 'sampleCount'> & {
        readonly sampleCount?: number;
    })[];
    readonly warnings: readonly MediaDiagnostic[];
}
