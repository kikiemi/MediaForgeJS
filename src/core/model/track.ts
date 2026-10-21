import type { DiagnosticContext, Warn } from '../errors/diagnostics';
import type { Aes3Unwrap } from '../codec-config/audio/aes3';
import type {
    FieldOrder,
    MatroskaPassThrough,
    MediaTags,
    SpatialVideo,
    TrackDispositions,
    VideoColour,
} from './media';

/** One elst entry in its stored integer units; media_time -1 marks an empty edit. */
export interface Mp4EditListEntry {
    /** segment_duration in movie timescale units. */
    segmentDuration: number;
    /** media_time in media timescale units. */
    mediaTime: number;
}

/** Exact elst contents; the edit*Seconds fields are derived from these integers. */
export interface Mp4EditList {
    version: 0 | 1;
    movieTimescale: number;
    mediaTimescale: number;
    entries: readonly Mp4EditListEntry[];
}

/**
 * A splice of an edit list that skips media: from `start` (packet-layer seconds) on, the media
 * timeline of the first edit runs `shift` seconds after the packets.
 */
export interface Mp4EditSplice {
    readonly start: number;
    readonly shift: number;
}

export interface TrackInfo {
    id?: number;
    /** Original Matroska TrackUID; full unsigned 64-bit identity independent of TrackNumber. */
    matroskaTrackUid?: bigint;
    language?: string;
    default?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    forced?: boolean;
    /**
     * Hearing- and visual-impaired, text-description and original-language flags, when the
     * container states them.
     */
    dispositions?: TrackDispositions;
    alphaMode?: boolean;
    colour?: VideoColour;
    /** Interlaced field order or progressive, when the container or bitstream states it. */
    fieldOrder?: FieldOrder;
    opusTrailingPaddingSamples?: number;
    audioTrailingPaddingSamples?: number;
    /** Explicit coded audio prefix discard, independent of presentation timestamp origin. */
    audioPrimingSamples?: number;
    /**
     * Leading decoded samples the bitstream itself marks as encoder delay (libfaac's 1024 in AAC)
     * on a track that states no priming or edit; decoders discard them.
     */
    decoderDelaySamples?: number;
    /** Some declared samples were unavailable and omitted during recovery. */
    incomplete?: boolean;
    matroskaCodecDelaySeconds?: number;
    /** Duration of the optional leading empty MP4 edit. */
    editLeadTimeSeconds?: number;

    editAbsoluteMediaTimeSeconds?: number;
    /** Signed shift from the media timeline to the movie timeline. */
    editTimelineShiftSeconds?: number;
    editMediaTimeSeconds?: number;
    editPresentationDurationSeconds?: number;
    /** Exact MP4 edit list backing the edit*Seconds fields. */
    editList?: Mp4EditList;
    /**
     * The splices of an edit list of several media edits that skip media, in order. The packets are
     * timed as presented, the samples between two edits that decoding needs are `decodeOnly`, and
     * the window of the edit*Seconds fields covers every edit.
     */
    editSplices?: readonly Mp4EditSplice[];
    /**
     * Presented media units of the edit after limiting it to the coded media; exact where seconds
     * are not.
     */
    editPresentationDurationUnits?: number;

    presentationTimestampsIncludeEdits?: boolean;
    codec: string;
    /**
     * Container FourCC of an MPEG-4 Part 2 track (AVI or Matroska VFW FourCC, MP4 sample entry
     * type); decoders use it to recognise encoders whose bitstream carries no identifying user
     * data.
     */
    codecTag?: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate: number;
    channelCount: number;
    duration: number;
    samples: Sample[];
    codecConfig?: Uint8Array;
    codecConfigurations?: Mp4CodecConfiguration[];
    /** dvcC/dvvC payload of a Dolby Vision HEVC track, kept next to its hvcC on copy. */
    dolbyVisionConfig?: Uint8Array;
    /** Stereoscopic or immersive video, as the sample entry states it. */
    spatial?: SpatialVideo;
    /**
     * The whole 'lhvC', 'vexu' and 'hfov' boxes of the sample entry of a spatial video, which
     * MP4-family copies write back after the decoder configuration.
     */
    spatialBoxes?: Uint8Array;
    timescale?: number;
    timestampResolutionSeconds?: number;
}

export interface Mp4CodecConfiguration {
    codec: string;
    codecConfig: Uint8Array;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate?: number;
    channelCount?: number;
    samplesPerAccessUnit?: number;
}

export interface Sample {
    proResHeaderless?: boolean;
    leadingDiscard?: boolean;
    /** Decoded samples at the end of the packet that are not presented (EncodedPacket). */
    trailingDiscard?: number;
    /** Decoded for the pictures that reference it but never presented: media an edit list skips. */
    decodeOnly?: boolean;
    /** Explicit source framing; avoids guessing when Annex B bytes also resemble NAL lengths. */
    nalUnitFormat?: 'annexb' | 'avcc';
    /** SMPTE 331M AES3 sound element unwrapped to PCM when the packet is read. */
    aes3?: Aes3Unwrap;
    /** Source range of the Matroska VP8/VP9 alpha bitstream. */
    alphaOffset?: number;
    alphaSize?: number;
    offset: number;
    size: number;
    timestamp: number;
    duration: number;
    isKeyframe: boolean;
    decodeTimestamp?: number;
    compositionTimeOffset?: number;
    codecConfigIndex?: number;
    data?: Uint8Array;
    /**
     * Packetized sample (MPEG-TS): `offset` is the transport packet that starts the PES holding the
     * first byte, and this many elementary-stream bytes precede the sample there; `size` is the
     * sample size as read.
     */
    packetSkip?: number;
    /**
     * Elementary-stream bytes of a packetized sample before its reader's conversion; `size` when
     * absent.
     */
    packetBytes?: number;
}

/**
 * A probe's reading of an input its reader describes with less work than its index: the tracks
 * with their durations and the samples of the reads it made. With `packets`, those samples are a
 * contiguous window of the input that may be read (a picture's surroundings, a range to copy);
 * otherwise they only describe the tracks.
 */
export interface ProbedInput {
    readonly result: DemuxResult;
    readonly packets: boolean;
    /**
     * The tracks state how many samples they hold, as an index would count them (an MP4's tables
     * do): inspect() reports their counts.
     */
    readonly counted?: boolean;
    /**
     * The index of the whole input from what the probe read (where an MP4's tables lie), without
     * describing it again; its warnings go to `diagnostics`. A probe that gives it gives no stream,
     * window or windowTracks: every read of the input reads that index.
     */
    readonly index?: (
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
    ) => Promise<DemuxResult>;
    /**
     * Packet-layer seconds where the whole input starts: the earliest presentation time of its
     * head.
     */
    readonly start?: number;
    /**
     * Every sample of the input in one pass in file order, the samples of one window of the input
     * at a time: `track` is the position of a sample's track in `result` (video, then audio, then
     * subtitle tracks), and each sample holds its bytes.
     */
    readonly stream?: (
        signal?: AbortSignal,
        warn?: Warn,
    ) => AsyncGenerator<readonly StreamedSample[]>;
    /** The window of `packets` holds every sample from the input's start on. */
    readonly fromStart?: boolean;
    /** Where the window of `packets` ends in the input: none of its samples' bytes lie past it. */
    readonly end?: number;
    /**
     * The probe of another target from what this one read (the head, the tail and where the
     * clusters or the decode times lie), without reading them again; undefined where no window
     * holds its samples.
     */
    readonly window?: (
        target: ProbeTarget,
        signal?: AbortSignal,
    ) => Promise<ProbedInput | undefined>;
    /**
     * The tracks of the window `window` gives for the samples around a time (`target.around`),
     * parsed by the reader from that window's own structures alone and kept in compact indexes,
     * without the demux of a window: a fragmented MP4's moof boxes, with the movie box and the
     * fragment index (tfra) the probe read. Undefined where only the window's demux decides (a
     * fragment without a tfdt, damage, a track that switches sample descriptions).
     */
    readonly windowTracks?: (
        target: ProbeTarget,
        signal?: AbortSignal,
    ) => Promise<DemuxResult | undefined>;
}

/**
 * A sample of a probe's stream with its bytes, and the position of its track in the probe's result.
 */
export interface StreamedSample {
    readonly track: number;
    readonly sample: Sample & { readonly data: Uint8Array };
    /** The decoder configuration of the window the sample was read in, where its track has one. */
    readonly codecConfig?: Uint8Array;
    /** The bytes of the sample's alpha bitstream, where it has one. */
    readonly alphaData?: Uint8Array;
}

/**
 * What a probe reads besides the tracks: the samples around the pictures shown from `around`
 * through `through` seconds (default `around`), the samples a copy of `range` reads (both from the
 * input's start), or a `stream` of every sample. With `fromStart` the samples of `range` are those
 * from the input's start to after the range (a conversion decodes them from there). With `around`
 * and `stream`, a window that would start the input is a stream instead.
 */
export interface ProbeTarget {
    readonly around?: number;
    readonly through?: number;
    /**
     * The samples are timed as an index times them where their window alone may not tell (the
     * decode times of reordered Matroska video): those of a packet found by time, and of a range a
     * copy writes.
     */
    readonly timed?: boolean;
    readonly range?: {
        readonly start: number;
        readonly end?: number;
        readonly fromStart?: boolean;
    };
    readonly stream?: boolean;
    /**
     * With `stream`, the pass is that of packets(), which hands each packet on and writes nothing:
     * a reader may stream an input that a copy reads whole (FLAC), as a copy of a stream is
     * written otherwise (an MP4 copy in fragments).
     */
    readonly packetsOnly?: boolean;
    /**
     * Only the window around `around` is read after the head: the input is not described to its
     * end (its tail, which tells the tracks' durations and the metadata after the clusters, is left
     * unread), as a picture needs no more. Readers that cannot place the window otherwise read the
     * tail.
     */
    readonly windowOnly?: boolean;
}

export interface DemuxResult {
    title?: string;
    videoTracks: TrackInfo[];
    audioTracks: TrackInfo[];
    subtitleTracks?: TrackInfo[];
    matroskaPassThrough?: MatroskaPassThrough;
    matroskaUnsupportedTags?: boolean;
    /** The file's tags, chapters and pictures, in the common keys every writer maps to its own. */
    tags?: MediaTags;
}
