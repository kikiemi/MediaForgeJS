import type {
    ContainerFormat,
    EncodedPacket,
    FieldOrder,
    MatroskaPassThrough,
    MediaTags,
    TrackDispositions,
    VideoColour,
} from '../model/media';
import type { Sink } from '../model/types';
import type { TrackInfo } from '../model/track';

/** The writer contract: the muxers that write tracks into a container or an audio file. */

export interface AudioOutputMuxer {
    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    /**
     * Declares the exact source sample count so trailing padding can be trimmed (Ogg granule end /
     * Matroska DiscardPadding).
     */
    setValidSamples?(samples: number): void;

    /**
     * Declares the leading samples the decoder drops and the samples presented after them. An
     * encoder of a live source declares its priming before the first chunk with `validSamples`
     * undefined and the whole window once the sound ends; Matroska applies the priming at once, MP4
     * waits for the length.
     */
    setAudioPriming?(
        primingSamples: number,
        validSamples: number | undefined,
        presentationTimestamps?: boolean,
        discardLeadingSamples?: boolean,
        codecDelaySamples?: number,
    ): void;
    /**
     * Supplies the audio decoder configuration (e.g. AAC AudioSpecificConfig) before finalize().
     */
    setAudioCodecConfig?(codecConfig: Uint8Array): void;
}

/** A muxer that can also carry video - everything makeMuxer returns. */
export interface OutputMuxer extends AudioOutputMuxer {
    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    /** Replaces the declared video colour with the encoder's before the first video chunk. */
    setVideoColour?(colour: VideoColour): void;
    /**
     * Carries title and UID-scoped tags into MKV/WebM and verbatim Chapters/Attachments into MKV.
     */
    setMatroskaPassThrough?(pass: MatroskaPassThrough): void;
    /** Appends one subtitle cue chunk to subtitle track `trackIndex`. */
    addSubtitleChunk?(chunk: EncodedPacket, trackIndex?: number): void;
    /** Appends a chunk to the extra (copied) audio track at `index`. */
    addExtraAudioChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    /** Appends a chunk to the extra (copied) video track at `index`. */
    addExtraVideoChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
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
    /** Accessibility and origin flags; Matroska stores them. */
    dispositions?: TrackDispositions;
    alphaMode?: boolean;
    /**
     * Packets may carry other decoder configurations (per-sample configurations of the source);
     * standard MP4/MOV writes one sample description per configuration, other containers keep this
     * track's configuration.
     */
    codecConfigChanges?: boolean;
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
    /** Track-specific colour declaration and HDR metadata. */
    colour?: VideoColour;
    /** Interlaced field order or progressive; undefined when unknown. */
    fieldOrder?: FieldOrder;
    /** Frames per second (0 = unknown). */
    framerate: number;
    /** Decoder configuration record (avcC / AudioSpecificConfig / ...). */
    codecConfig?: Uint8Array;
    /** dvcC/dvvC payload written next to the hvcC of a Dolby Vision track. */
    dolbyVisionConfig?: Uint8Array;
    /**
     * The whole 'lhvC', 'vexu' and 'hfov' boxes of a copied spatial video, which MP4-family
     * writers add to its sample entry.
     */
    spatialBoxes?: Uint8Array;

    presentationStartSeconds?: number;
    /** Presented duration excluding any leading empty edit. */
    presentationDurationSeconds?: number;
    /**
     * Standard MP4 copy: authoritative edit media offset relative to the first coded DTS; requires
     * presentation start and duration.
     */
    presentationMediaTimeSeconds?: number;
    /** Standard MP4 authoritative copy: ticks per second for sample tables and edit media time. */
    mediaTimescale?: number;
    /**
     * Standard MP4 authoritative copy in exact integer units; takes precedence over the
     * presentation*Seconds fields.
     */
    presentationEdit?: Mp4PresentationEdit;
}

/**
 * MP4 edit list in the integer units of its source; the muxer rescales movie units with integer
 * arithmetic.
 */
export interface Mp4PresentationEdit {
    /** Leading empty edit in movie timescale units (0 = none). */
    leadMovieUnits: number;
    /** Media edit segment_duration in movie timescale units. */
    movieDuration: number;
    /**
     * Media edit media_time in media timescale units, relative to the first written decode time.
     */
    mediaTimeUnits: number;
    movieTimescale: number;
    mediaTimescale: number;
    /** Source elst version; version 1 is kept on output. */
    version?: 0 | 1;
    /**
     * Media edits after the first, in the same units, which present the packets after each splice.
     */
    splices?: readonly Mp4EditSpliceEntry[];
}

/** A media edit after the first of a copied edit list that skips media. */
export interface Mp4EditSpliceEntry {
    /** segment_duration in movie timescale units. */
    readonly movieDuration: number;
    /** media_time in media timescale units, relative to the first written decode time. */
    readonly mediaTimeUnits: number;
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
    /** Accessibility and origin flags; Matroska stores them. */
    dispositions?: TrackDispositions;
    /**
     * Packets may carry other decoder configurations (per-sample configurations of the source);
     * standard MP4/MOV writes one sample description per configuration, other containers keep this
     * track's configuration.
     */
    codecConfigChanges?: boolean;
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
    /**
     * Standard MP4 copy: authoritative edit media offset relative to the first coded DTS; requires
     * presentation start and duration.
     */
    presentationMediaTimeSeconds?: number;
    /** Standard MP4 authoritative copy: ticks per second for sample tables and edit media time. */
    mediaTimescale?: number;
    /**
     * Standard MP4 authoritative copy in exact integer units; takes precedence over the
     * presentation*Seconds fields.
     */
    presentationEdit?: Mp4PresentationEdit;
}

/** Constructor configuration shared by the container muxers. */
export interface MuxerConfig {
    title?: string;
    /**
     * The input's tags, chapters and pictures, written as far as the container has room for them.
     */
    tags?: MediaTags;
    /**
     * Text subtitle tracks for mkv output (codec: 'text/utf8' | 'text/ass' | 'text/ssa' |
     * 'text/webvtt').
     */
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
        dispositions?: TrackDispositions;
    }>;
    format: ContainerFormat;
    /**
     * Layout: 'standard' (single moov / whole file) or 'fragmented' (streamable fMP4 / incremental
     * clusters).
     */
    mode: 'standard' | 'fragmented';
    /** Fragmented mode: maximum fragment duration in seconds. */
    maxFragmentDuration: number;
    /** Fragmented mode: start fragments on keyframes automatically. */
    autoSync: boolean;

    video?: VideoTrackConfig;
    audio?: AudioTrackConfig;

    videoColour?: VideoColour;
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

export interface MediaMuxerOptions {
    /** Conversion encoders supply decoder configuration with their first output packet. */
    readonly deferCodecConfig?: boolean;
}

/** Creates the writer of one output; it validates known configuration without writing. */
export type ContainerWriterFactory = (
    config: MuxerConfig,
    sink: Sink,
    options?: MediaMuxerOptions,
) => OutputMuxer;

/**
 * Creates the audio file writer of one copied track. `copied` is the track configuration the engine
 * derived for a copy into `format` (its priming and presented samples), for writers that declare
 * them; `tags` are the input's tags, chapters and pictures to write.
 */
export type AudioWriterFactory = (
    format: string,
    track: TrackInfo,
    sink: Sink,
    copied?: () => AudioTrackConfig,
    tags?: MediaTags,
) => AudioOutputMuxer;

/** A container writer part: the formats it writes and, loaded with the first output, its writer. */
export interface ContainerWriterPart {
    readonly kind: 'container';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<ContainerWriterFactory>;
}

/** An audio file writer part: one copied audio track into an audio file of its formats. */
export interface AudioWriterPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<AudioWriterFactory>;
}

export type WriterPart = ContainerWriterPart | AudioWriterPart;
