import type { EncodedPacket } from '../core/model/media';
import type { CmafSegment } from '../formats/mp4/write/cmaf';
import type { CmafTrack } from '../formats/mp4/write/cmaf-boxes';

// The packets and segments of an opened input as Media hands them out, apart from the copies and
// reads behind them (./media-types).

export interface MediaPacket extends EncodedPacket {
    readonly trackId: number;
    /** The input's one copy of the decoder configuration, shared by its packets. */
    readonly codecConfig?: Uint8Array;
    /**
     * A leading picture of an open group of pictures (sample_is_leading 1 in an MP4 fragment): it
     * references pictures before the keyframe that starts the group, so a decode that starts at
     * that keyframe drops it.
     */
    readonly leadingDiscard?: boolean;
    /**
     * Decoded for the pictures that reference it but never presented: media an MP4 edit list skips.
     */
    readonly decodeOnly?: boolean;
}

export interface PacketOptions {
    readonly trackIds?: readonly number[];
    /** Inclusive decode time in seconds; does not perform decoder preroll or edit media. */
    readonly start?: number;
    /** Exclusive decode time in seconds. */
    readonly end?: number;
    readonly keyframesOnly?: boolean;
    readonly signal?: AbortSignal;
}

/**
 * The last packet presented at or before `time` (mode 'before', the default) or the first at or
 * after it (mode 'after'); with keyframe: true, the last or first keyframe.
 */
export interface PacketSearchOptions {
    readonly keyframe?: boolean;
    readonly mode?: 'before' | 'after';
    readonly signal?: AbortSignal;
}

export interface SegmentOptions {
    readonly trackIds?: readonly number[];
    readonly targetDuration?: number;
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    /** Reject cuts where any video track starts with a dependent sample. Default false. */
    readonly requireKeyframe?: boolean;
    readonly signal?: AbortSignal;
}

export type MediaSegment =
    | { readonly kind: 'init'; readonly data: Uint8Array; readonly tracks: readonly CmafTrack[] }
    | ({ readonly kind: 'media' } & CmafSegment);
