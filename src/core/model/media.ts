/** Every container / image format the library can read or write. */
export type ContainerFormat =
    | 'mp4'
    | 'mov'
    | 'webm'
    | 'mkv'
    | 'avi'
    | 'flv'
    | '3gp'
    | 'ts'
    | 'mpeg'
    | 'm4a'
    | 'm4v'
    | 'ogg'
    | 'mp3'
    | 'wav'
    | 'aiff'
    | 'au'
    | 'caf'
    | 'flac'
    | 'aac'
    | 'mp2'
    | 'mp1'
    | 'ac3'
    | 'eac3'
    | 'dts'
    | 'truehd'
    | 'gif'
    | 'apng'
    | 'png'
    | 'jpeg'
    | 'webp'
    | 'bmp'
    | 'tiff'
    | 'ico'
    | 'avif'
    | 'heif'
    | 'jxl'
    | 'asf'
    | 'mxf'
    | 'ivf'
    | 'obu'
    | 'iamf'
    | 'apv';

/** Chunk kind; 'subtitle' carries mkv/webm text cues through addSubtitleChunk. */
export type TrackType = 'video' | 'audio' | 'subtitle';

/**
 * SMPTE ST 2086 mastering display colour volume: CIE 1931 x/y chromaticities and luminance in
 * cd/m².
 */
export interface MasteringDisplay {
    readonly red: readonly [number, number];
    readonly green: readonly [number, number];
    readonly blue: readonly [number, number];
    readonly whitePoint: readonly [number, number];
    readonly maxLuminance: number;
    readonly minLuminance: number;
}

/** H.273 colour description of a video track (2 is unspecified), with its HDR metadata. */
export interface VideoColour {
    primaries: number;
    transfer: number;
    matrix: number;
    /** Undefined when the container leaves the range unspecified. */
    fullRange?: boolean;
    mastering?: MasteringDisplay;
    /** CTA-861.3 maximum content and frame-average light levels (MaxCLL, MaxFALL) in cd/m². */
    contentLight?: { readonly maxContent: number; readonly maxAverage: number };
}

/**
 * Accessibility and origin flags beyond default, forced and commentary, as Matroska stores them.
 */
export interface TrackDispositions {
    readonly hearingImpaired?: boolean;
    readonly visualImpaired?: boolean;
    /** Text descriptions of the picture (Matroska FlagTextDescriptions). */
    readonly textDescriptions?: boolean;
    /** The track is in the content's original language. */
    readonly original?: boolean;
}

/**
 * Progressive, or interlaced fields in coded and displayed order: tt and tb top first, bb and bt
 * bottom first.
 */
export type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

/** A picture attached to a file, such as its cover art. */
export interface AttachedPicture {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly description?: string;
    /** ID3/FLAC picture type; 3 is the front cover. */
    readonly type?: number;
}

/** A chapter: its start and end in seconds from the file's start, and its title. */
export interface MediaChapter {
    readonly start: number;
    readonly end?: number;
    readonly title?: string;
}

/**
 * Descriptive metadata of a whole file: text values by the keys of `mediaforgejs/formats` (title,
 * artist, album, albumArtist, comment, date, genre, composer, copyright, track, disc, description),
 * its chapters and its pictures.
 */
export interface MediaTags {
    readonly entries: readonly { readonly key: string; readonly value: string }[];
    readonly chapters?: readonly MediaChapter[];
    readonly pictures?: readonly AttachedPicture[];
}

export interface MatroskaPassThrough {
    chapters?: Uint8Array;
    attachments?: Uint8Array;
    title?: string;
    /** Complete EBML Tags element; scoped targets retain their original unsigned 64-bit UIDs. */
    tags?: Uint8Array;
}

export interface PcmAudioBuffer {
    /** Sample rate in Hz. */
    readonly sampleRate: number;
    /** Frame count per channel. */
    readonly length: number;
    readonly numberOfChannels: number;
    /** Duration in seconds. */
    readonly duration: number;
    /** Returns the PCM samples for one channel. */
    getChannelData(channel: number): Float32Array;
}

/** One encoded sample (video frame, audio packet, or subtitle cue). */
export interface EncodedPacket {
    readonly data: Uint8Array;
    /** VP8/VP9 alpha bitstream carried by Matroska BlockAdditional ID 1. */
    readonly alphaData?: Uint8Array;
    /** Presentation timestamp in seconds. */
    readonly timestamp: number;
    /** Duration in seconds. */
    readonly duration: number;
    /** True for sync samples. */
    readonly isKeyframe: boolean;
    readonly trackType: TrackType;
    /** Decode timestamp in seconds (B-frame streams). */
    readonly decodeTimestamp?: number;
    /** Presentation minus decode timestamp, in seconds. */
    readonly compositionTimeOffset?: number;
    /**
     * Decoder configuration (avcC, hvcC, sequence header) in effect from this chunk on; a track
     * whose sample descriptions change carries each chunk's own. Built-in decoders apply a
     * configuration that differs from the previous one before the chunk.
     */
    readonly codecConfig?: Uint8Array;
    /**
     * The colour an encoder reported with its decoder configuration, which the container declares
     * for the track.
     */
    readonly colour?: VideoColour;
    /**
     * Decoded samples at the end of this audio packet that are not presented, at the track's
     * sample rate: a Matroska DiscardPadding before the last block, as files joined by FFmpeg's
     * concat demuxer have where each file ends. Decoding drops them; a copy into Matroska keeps
     * them.
     */
    readonly trailingDiscard?: number;
}

/** How a spatial video projects its pictures; 'rectilinear' is ordinary video. */
export type VideoProjection =
    'rectilinear' | 'equirectangular' | 'half-equirectangular' | 'fisheye' | 'parametric';

/**
 * Stereoscopic or immersive video as MP4 and MOV state it (Apple's spatial video, the 'vexu' and
 * 'hfov' boxes): the eye views, how a second view is stored, the camera and the projection.
 */
export interface SpatialVideo {
    /** The eye views the track holds; empty for monoscopic video or views it does not name. */
    readonly eyes: readonly ('left' | 'right')[];
    /**
     * Where the second view is: 'layer' (an MV-HEVC layer, which only MP4-family copies keep),
     * 'side-by-side' or 'over-under' (packed in the picture).
     */
    readonly views?: 'layer' | 'side-by-side' | 'over-under';
    /** The eye to show when only one is shown. */
    readonly heroEye?: 'left' | 'right';
    /** Distance between the centres of the camera lenses, in millimetres. */
    readonly baseline?: number;
    /** Disparity adjustment as a share of a view's width, from -1 to 1. */
    readonly disparityAdjustment?: number;
    readonly projection?: VideoProjection;
    /** Horizontal field of view in degrees. */
    readonly fieldOfView?: number;
}

/**
 * The gain map of a picture (ISO 21496-1, or the XMP form of Ultra HDR JPEG), which renders it on
 * HDR displays: the map's size and the headroom of its HDR rendition in stops above SDR white.
 */
export interface GainMap {
    readonly width: number;
    readonly height: number;
    readonly headroom?: number;
}

/** A track of an input: its kind, codec, shape, labels and length. */
export interface MediaTrack {
    readonly id: number;
    readonly type: TrackType;
    /** Original Matroska TrackUID, independent of the numeric track id. */
    readonly matroskaTrackUid?: bigint;
    /** Track selection dispositions; undefined when the source does not declare them. */
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly commentary?: boolean;
    /** True when video carries a separate VP8/VP9 alpha bitstream. */
    readonly alphaMode?: boolean;
    /** Codec string (e.g. 'avc1.42C01E', 'mp4a.40.2'). */
    readonly codec: string;
    /** Frame width in pixels. */
    readonly width?: number;
    /** Frame height in pixels. */
    readonly height?: number;
    /** Display (aspect-corrected) width in pixels. */
    readonly displayWidth?: number;
    /** Display (aspect-corrected) height in pixels. */
    readonly displayHeight?: number;
    /** Pixel aspect ratio numerator. */
    readonly pixelAspectRatioNum?: number;
    /** Pixel aspect ratio denominator. */
    readonly pixelAspectRatioDen?: number;
    /** Frames per second (0 = unknown). */
    readonly framerate?: number;
    /** Sample rate in Hz. */
    readonly sampleRate?: number;
    /** Channel count, when known. */
    readonly channelCount?: number;
    /** Decoder configuration record (avcC / AudioSpecificConfig / ...). */
    codecConfig?: Uint8Array;
    readonly language?: string;
    /** True when only the surviving, complete samples of a damaged input were recovered. */
    readonly incomplete?: boolean;
    /** Presented seconds. */
    readonly duration: number;
    readonly timescale?: number;
    /**
     * Packets in the track: reported by inspect() where its read counts the packets (MP4, ADTS,
     * MPEG-PS, MP3 and FLAC under 4 MiB, damaged or spliced inputs) and always with
     * `sampleCounts: true`; Media.tracks never carries it.
     */
    readonly sampleCount?: number;
    /**
     * Counter-clockwise display rotation in degrees (90, 180 or 270); absent when pictures are
     * shown as stored.
     */
    readonly rotation?: number;
    /** Stereoscopic or immersive video: absent for ordinary video. */
    readonly spatial?: SpatialVideo;
    /** The gain map of a still picture (JPEG, AVIF, HEIF): absent when it has none. */
    readonly gainMap?: GainMap;
}

/** A track the library indexed: its packets are counted. */
export interface CountedTrack extends MediaTrack {
    readonly sampleCount: number;
}

/** Container formats a re-encode writes; packet copies are defined by RemuxOptions. */
export type OutputContainerFormat = Exclude<
    ContainerFormat,
    'mp1' | 'mpeg' | 'asf' | 'mxf' | 'obu' | 'ac3' | 'eac3' | 'dts' | 'truehd'
>;

/** What an operation is doing when it reports progress. */
export type MediaProgressStage = 'copy' | 'encode' | 'decode' | 'package';

/**
 * One progress report. `fraction` runs from 0 to 1; `MediaForge` and the standalone functions also
 * fill `stage`, `time` and `duration`, never report a smaller fraction than before and finish with
 * a report of 1.
 */
export interface MediaProgress {
    /** Share of the work done, from 0 to 1. */
    readonly fraction: number;
    /** What is being done; set by MediaForge and the standalone functions. */
    readonly stage?: MediaProgressStage;
    /** Seconds of media processed so far, where the duration is known. */
    readonly time?: number;
    /** Seconds of media the operation covers, where known. */
    readonly duration?: number;
    readonly message?: string;
    readonly packets?: number;
    readonly packetBytes?: number;
    /** Package operations: media segments and total bytes emitted so far. */
    readonly segments?: number;
    readonly outputBytes?: number;
}
