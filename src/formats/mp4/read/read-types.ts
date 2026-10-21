import type { Mp4CodecConfiguration, TrackInfo } from '../../../core/model/track';
import type { FieldOrder, SpatialVideo, VideoColour } from '../../../core/model/media';

// What an MP4 read states about its tracks (sample descriptions, fragment defaults), apart from
// the reading (./descriptions, ./fragments).

/**
 * One self-contained unit of chunk-layout sound: an uncompressed frame, or a compressed packet of a
 * version-1 description (or of a version-0 one of the codecs in QUICKTIME_SOUND_FRAMES).
 */
export interface ChunkAudioUnit {
    readonly samples: number;
    readonly bytes: number;
    /**
     * MPEG audio, whose nominal packet size is an average: each chunk splits at its frame headers
     * instead.
     */
    readonly mpegFrames?: boolean;
}

/** One sample description (stsd entry) as read. */
export interface SampleEntry {
    readonly codecFourCC: string;
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly pixelAspectRatioNum: number;
    readonly pixelAspectRatioDen: number;
    readonly codecConfig: Uint8Array | undefined;
    readonly pcmFrameBytes: number;
    readonly chunkUnit: ChunkAudioUnit | undefined;
    readonly codecTag: string | undefined;
    readonly dolbyVisionConfig: Uint8Array | undefined;
    readonly colour: VideoColour | undefined;
    readonly fieldOrder: FieldOrder | undefined;
    readonly forced: boolean;
    readonly spatial?: SpatialVideo;
    readonly spatialBoxes?: Uint8Array;
}

/**
 * The sample descriptions a track uses: `entries[0]` describes the track, `configIndex` maps each
 * stsd entry to its decoder configuration (-1 for an entry no sample may select), and
 * `configurations` lists the configurations a track switches between, absent when every selected
 * entry describes the same one.
 */
export interface SampleDescriptions {
    readonly entries: readonly SampleEntry[];
    readonly configIndex: Int32Array;
    readonly configurations?: Mp4CodecConfiguration[];
    /**
     * A fragmented track's distinct codecs: which one it uses is known once its fragments are read.
     */
    readonly pending?: boolean;
}

/** What the movie box states about the fragments of an input, and what reading them settles. */
export interface FragmentState {
    readonly trexDefaults: ReadonlyMap<
        number,
        { descriptionIndex: number; duration: number; size: number; flags: number }
    >;
    /** The decode time each track's next fragment continues from. */
    readonly fragmentNextDts: Map<number, number>;
    /** Sample descriptions of fragmented tracks, which each track fragment selects by index. */
    readonly fragmentDescriptions: ReadonlyMap<TrackInfo, SampleDescriptions>;
    /** esds MPEG audio tracks whose layer is read from the first fragment sample. */
    readonly layerPending: Set<TrackInfo>;
}
