import type { SpatialVideo } from '../../core/model/media';

export type PackageContainer = 'fmp4' | 'ts';

export type PackagedFileKind = 'init' | 'segment' | 'playlist' | 'manifest' | 'key';

export interface PackageSegmentTiming {
    readonly timescale: number;
    /** Decode time of the first sample in ticks of timescale. */
    readonly time: bigint;
    /** Exact sum of the sample durations in ticks of timescale. */
    readonly duration: bigint;
}

export interface PackagedFile {
    readonly kind: PackagedFileKind;
    /** Relative name inside the package; never contains a directory separator. */
    readonly name: string;
    /** Owned bytes; the consumer may retain or modify them. */
    readonly data: Uint8Array;
    readonly representation?: string;
    /** Media segments: the number used in the file name. */
    readonly number?: number;
    readonly timing?: PackageSegmentTiming;
}

export interface PackageProgress {
    /** Packets read over the selected sample count. */
    readonly fraction: number;
    readonly packets: number;
    readonly packetBytes: number;
    /** Media segments and total bytes emitted so far. */
    readonly segments: number;
    readonly bytes: number;
}

export interface PackageOptions {
    /** Video and audio tracks; defaults to every video and audio track. */
    readonly trackIds?: readonly number[];
    /** Goal in seconds, cut at the next reference keyframe. Default 6, between 0.1 and 3600. */
    readonly targetDuration?: number;
    /**
     * Media segments across all representations. Default 100000; exceeding fails with code OUTPUT.
     */
    readonly maxSegments?: number;
    /**
     * Emitted bytes across all files; exceeding fails with code OOM. Unlimited unless set;
     * collecting defaults to 1 GiB.
     */
    readonly maxTotalBytes?: number;
    /**
     * Pending bytes of one segment before the next keyframe. Default 128 MiB (ten seconds at 100
     * Mbit/s); exceeding fails with code OOM.
     */
    readonly maxBufferedBytes?: number;
    /** Pending samples of one segment. Default 100000. */
    readonly maxBufferedSamples?: number;
    readonly signal?: AbortSignal;
    /** Invoked after each packet; throwing stops the package. */
    readonly onProgress?: (progress: PackageProgress) => void;
}

export interface PackagedSegment {
    readonly name: string;
    readonly number: number;
    readonly bytes: number;
    readonly timing: PackageSegmentTiming;
}

export interface PackagedRepresentation {
    readonly id: string;
    readonly type: 'video' | 'audio' | 'muxed';
    readonly trackIds: readonly number[];
    /** RFC 6381 codec strings of the contained tracks. */
    readonly codecs: readonly string[];
    readonly init?: string;
    /** HLS media playlist name when one was written. */
    readonly playlist?: string;
    readonly segments: readonly PackagedSegment[];
    /** Peak media segment bitrate in bits per second. */
    readonly bandwidth: number;
    /** Mean media segment bitrate in bits per second. */
    readonly averageBandwidth: number;
    /** Seconds covered by the media segments. */
    readonly duration: number;
    /** Ticks per second of the segment timings. */
    readonly timescale: number;
    readonly width?: number;
    readonly height?: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    /** Reduced frames-per-second fraction of the video track. */
    readonly frameRate?: { readonly num: number; readonly den: number };
    readonly sampleRate?: number;
    readonly channelCount?: number;
    readonly language?: string;
    readonly name?: string;
    /** The spatial video of the video track, when the segments keep it (fMP4). */
    readonly spatial?: SpatialVideo;
}

export interface PackageSummary {
    readonly representations: readonly PackagedRepresentation[];
    /** Files and bytes emitted, including playlists and manifests. */
    readonly files: number;
    readonly bytes: number;
    /** Longest representation in seconds. */
    readonly duration: number;
    /** Integer seconds not exceeded by any media segment. */
    readonly targetDuration: number;
}

export interface ResolvedPackageOptions {
    readonly trackIds?: readonly number[];
    readonly targetDuration: number;
    readonly maxSegments: number;
    readonly maxTotalBytes: number;
    readonly maxBufferedBytes: number;
    readonly maxBufferedSamples: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: PackageProgress) => void;
}

export interface PackageNaming {
    readonly init: (representation: string) => string;
    readonly segment: (representation: string, number: number) => string;
    readonly firstNumber: number;
}

/** Emitted files are counted here; playlists and manifests are accepted after the segments. */
export interface PackageLedger {
    readonly representations: readonly PackagedRepresentation[];
    readonly files: number;
    readonly bytes: number;
    accept(file: PackagedFile): PackagedFile;
}
