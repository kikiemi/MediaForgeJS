import type { ContainerFormat, EncodedChunk, MatroskaPassThrough } from './media.js';
export interface AudioOutputMuxer {
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    /** Declares the exact source sample count so trailing padding can be trimmed (Ogg granule end / Matroska DiscardPadding). */
    setValidSamples?(samples: number): void;
    setAudioPriming?(primingSamples: number, validSamples: number, presentationTimestamps?: boolean, discardLeadingSamples?: boolean, codecDelaySamples?: number): void;
    /** Supplies the audio decoder configuration (e.g. AAC AudioSpecificConfig) before finalize(). */
    setAudioCodecConfig?(codecConfig: Uint8Array): void;
}
/** A muxer that can also carry video - everything makeMuxer returns. */
export interface OutputMuxer extends AudioOutputMuxer {
    /** Appends one encoded video chunk; `codecConfig` on the first call carries the decoder configuration record. */
    addVideoChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Carries title and UID-scoped tags into MKV/WebM and verbatim Chapters/Attachments into MKV. */
    setMatroskaPassThrough?(pass: MatroskaPassThrough): void;
    /** Appends one subtitle cue chunk to subtitle track `trackIndex`. */
    addSubtitleChunk?(chunk: EncodedChunk, trackIndex?: number): void;
    /** Appends a chunk to the extra (copied) audio track at `index`. */
    addExtraAudioChunk?(index: number, chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Appends a chunk to the extra (copied) video track at `index`. */
    addExtraVideoChunk?(index: number, chunk: EncodedChunk, codecConfig?: Uint8Array): void;
}
/** Video track parameters handed to a muxer. */
export interface VideoTrackConfig {
    rotation?: number;
    id: number;
    type: 'video';
    /** Original Matroska TrackUID, preserved exactly in MKV/WebM. */
    matroskaTrackUid?: bigint;
    default?: boolean;
    forced?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    alphaMode?: boolean;
    /** Codec string (e.g. 'avc1.42C01E', 'mp4a.40.2'). */
    codec: string;
    /** Frame width in pixels. */
    width: number;
    /** Frame height in pixels. */
    height: number;
    /** Display (aspect-corrected) width in pixels. */
    displayWidth?: number;
    /** Display (aspect-corrected) height in pixels. */
    displayHeight?: number;
    /** Pixel aspect ratio numerator. */
    pixelAspectRatioNum?: number;
    /** Pixel aspect ratio denominator. */
    pixelAspectRatioDen?: number;
    /** ISO-639-2 language code or BCP-47 tag; MP4 mdhd stores three-letter codes only. */
    language?: string;
    /** Track-specific nclx colour declaration. */
    colour?: {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    };
    /** Frames per second (0 = unknown). */
    framerate: number;
    /** Decoder configuration record (avcC / AudioSpecificConfig / ...). */
    codecConfig?: Uint8Array;
    presentationStartSeconds?: number;
    /** Presented duration excluding any leading empty edit. */
    presentationDurationSeconds?: number;
    /** Standard MP4 copy: authoritative edit media offset relative to the first coded DTS; requires presentation start and duration. */
    presentationMediaTimeSeconds?: number;
    /** Standard MP4 authoritative copy: ticks per second for sample tables and edit media time. */
    mediaTimescale?: number;
}
/** Audio track parameters handed to a muxer. */
export interface AudioTrackConfig {
    id: number;
    type: 'audio';
    /** Original Matroska TrackUID, preserved exactly in MKV/WebM. */
    matroskaTrackUid?: bigint;
    default?: boolean;
    forced?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    /** Codec string (e.g. 'avc1.42C01E', 'mp4a.40.2'). */
    codec: string;
    /** Sample rate in Hz. */
    sampleRate: number;
    channelCount: number;
    /** ISO-639-2 language code or BCP-47 tag; MP4 mdhd stores three-letter codes only. */
    language?: string;
    /** Leading coded samples skipped by the presentation edit. */
    primingSamples?: number;
    /** Exact number of samples presented after priming. */
    validSamples?: number;
    presentationTimestamps?: boolean;
    discardLeadingSamples?: boolean;
    codecDelaySamples?: number;
    /** Decoder configuration record (avcC / AudioSpecificConfig / ...). */
    codecConfig?: Uint8Array;
    /** Start of the track's presented content on the movie timeline. */
    presentationStartSeconds?: number;
    /** Presented duration excluding any leading empty edit. */
    presentationDurationSeconds?: number;
    /** Standard MP4 copy: authoritative edit media offset relative to the first coded DTS; requires presentation start and duration. */
    presentationMediaTimeSeconds?: number;
    /** Standard MP4 authoritative copy: ticks per second for sample tables and edit media time. */
    mediaTimescale?: number;
}
/** Constructor configuration shared by the container muxers. */
export interface MuxerConfig {
    title?: string;
    /** Text subtitle tracks for mkv output (codec: 'text/utf8' | 'text/ass' | 'text/ssa' | 'text/webvtt'). */
    subtitleTracks?: Array<{
        codec: string;
        codecConfig?: Uint8Array;
        id?: number;
        matroskaTrackUid?: bigint;
        language?: string;
        default?: boolean;
        forced?: boolean;
        name?: string;
        title?: string;
        commentary?: boolean;
    }>;
    format: ContainerFormat;
    /** Layout: 'standard' (single moov / whole file) or 'fragmented' (streamable fMP4 / incremental clusters). */
    mode: 'standard' | 'fragmented';
    /** Fragmented mode: maximum fragment duration in seconds. */
    maxFragmentDuration: number;
    /** Fragmented mode: start fragments on keyframes automatically. */
    autoSync: boolean;
    timestampOffsetSeconds?: number;
    video?: VideoTrackConfig;
    audio?: AudioTrackConfig;
    videoColour?: {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    };
    /** ISO-639 language tag written for the primary audio track. */
    audioLanguage?: string;
    /** Same for the video track. */
    videoLanguage?: string;
    extraVideoTracks?: VideoTrackConfig[];
    /** Copied extra audio tracks (bit-exact pass-through). */
    extraAudioTracks?: AudioTrackConfig[];
    oggCommentPayload?: Uint8Array;
    moovUserData?: Uint8Array;
}
