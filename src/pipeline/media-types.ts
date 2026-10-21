import { REMUX_FORMATS } from './plan/format-policy';
import type { TrackInfo } from '../core/model/track';
import type { CountedTrack, TrackType } from '../core/model/media';
import type { MediaPacket, PacketSearchOptions, SegmentOptions } from './packet-types';
import type { Sink } from '../core/model/types';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { ErrorCode } from '../core/errors/errors';

export interface TrimRange {
    readonly start: number;
    readonly end?: number;
}

/**
 * The first packet of one track inside a trim: video starts at a keyframe, audio at a packet
 * boundary.
 */
export interface TrimCut {
    /** Decode time of the first packet, where the packet schedule starts. */
    readonly decodeStart: number;
    /** Presentation time of the first packet. */
    readonly time: number;
    /** Exclusive decode time this track stops at instead of the range end. */
    readonly decodeEnd?: number;
    /**
     * Presentation time packets shown earlier are left out at: the pictures of an open GOP that
     * precede its keyframe and reference the GOP before it, which only an edit list can keep
     * undisplayed.
     */
    readonly shownFrom?: number;
    /** Presentation window a subtitle track's cues are clipped to (clipCue). */
    readonly cueWindow?: CueWindow;
}

/**
 * Where a trimmed copy is shown, in input presentation seconds: from the time its first presented
 * picture or sound shows (the requested start when an edit list presents it exactly) to the range
 * end.
 */
export interface CueWindow {
    readonly from: number;
    readonly to: number;
}

export interface TrimOptions {
    /** Audio starts at the packet at or after `start`: a segment that follows another copy. */
    readonly audioAfter?: boolean;
    /**
     * Exclusive decode time the audio tracks stop at, so they cover reordered video shown past the
     * range end.
     */
    readonly audioEnd?: number;
}

export interface TrimPlan extends TrimRange {
    /**
     * Seconds subtracted from every written packet: the first decode time for ISO output, whose
     * edit list presents the in-point, otherwise the first presented time of the copied pictures
     * and sound.
     */
    readonly origin: number;
    readonly cuts: ReadonlyMap<number, TrimCut>;
    /** Where each track that ends before `start` ends: it copies nothing (strict refuses). */
    readonly ended: ReadonlyMap<number, number>;
    /** Presented seconds from `start` to `end` or to the last packet end. */
    readonly duration: number;
}

/** A packet as the library's own readers take it, with its place in its track's sample table. */
export interface FilePacket extends MediaPacket {
    readonly sampleIndex: number;
}

/** A search of a track's sample table by presentation time (MediaFile.findSample()). */
export type SampleSearchOptions = Omit<PacketSearchOptions, 'signal'>;

export interface RemuxOptions extends SegmentOptions {
    /**
     * The output; an MP4, M4A or M4V copy of a track only fragments carry is written as fragmented
     * MP4 (RemuxPlanner.resolveRemuxFormat).
     */
    readonly format: (typeof REMUX_FORMATS)[number];
    /**
     * Presentation seconds to copy, counted from the input's start (MPEG-TS and program streams
     * start at their clock, not at zero). Video starts at the keyframe at or before `start` and
     * audio at a packet boundary; MP4-family output presents the exact `start` through its edit
     * list, other containers report TRIM_SNAPPED.
     */
    readonly start?: number;
    /**
     * Exclusive presentation end in seconds from the input's start; omitted copies to the end of
     * the input.
     */
    readonly end?: number;
    readonly onProgress?: (progress: {
        readonly packets: number;
        readonly packetBytes: number;
    }) => void;
}

/** A copy of tracks onto an output timeline: their packets within `trim`, moved by `offset`. */
export interface PacketRoute {
    readonly trackIds: readonly number[];
    readonly trim?: TrimPlan;
    /** Seconds added to every routed timestamp after the trim origin is removed. */
    readonly offset?: number;
    readonly route: (packet: FilePacket) => void;
}

/** Routes the packets of a copy to a writer. */
export interface PacketRouteOptions extends PacketRoute {
    readonly signal: AbortSignal;
    readonly sink: Sink;
    readonly onProgress?: RemuxOptions['onProgress'];
}

/**
 * A reader of one track in a shared read: `next()` names the sample it takes next, undefined while
 * it takes none, and `take` gets that packet borrowed, its bytes valid until it returns.
 */
export interface SharedTrackRead {
    readonly trackId: number;
    readonly next: () => number | undefined;
    readonly take: (packet: FilePacket) => void;
}

/**
 * One read of an input for copies and readers: packet by packet it reads the earliest in decode
 * time of what they take next, each packet once. Copies and readers may join `routes` and `reads`
 * while it runs; it ends once none of them takes a packet.
 */
export interface SharedReadOptions {
    readonly routes: readonly PacketRoute[];
    readonly reads: readonly SharedTrackRead[];
    readonly signal: AbortSignal;
    /** The copies' destination, drained as they are routed. */
    readonly sink?: Sink;
    /** Awaited before each packet when it returns a promise: the pace of the consumers. */
    readonly ready?: () => Promise<void> | undefined;
    /** Told once a copy has routed its last packet. */
    readonly routed?: (route: PacketRoute) => void;
    readonly onProgress?: RemuxOptions['onProgress'];
}

export type RemuxSupport =
    | {
          readonly supported: true;
          readonly outputFormat: RemuxOptions['format'];
          readonly layout: 'standard' | 'fragmented' | 'audio';
          /** The tracks the copy writes (checkRemux): a range leaves out those it misses. */
          readonly trackIds?: readonly number[];
          readonly warnings: readonly MediaDiagnostic[];
      }
    | {
          readonly supported: false;
          readonly code: ErrorCode;
          readonly reason: string;
          readonly warnings: readonly MediaDiagnostic[];
      };

export interface RemuxTrack {
    readonly description: CountedTrack;
    readonly info: TrackInfo;
    readonly type: TrackType;
    readonly order?: readonly number[] | Uint32Array;
}

/** Bytes a Blob result may hold unless the caller sets maxBytes. */
export const BLOB_MAX_BYTES = 256 * 1024 * 1024;
