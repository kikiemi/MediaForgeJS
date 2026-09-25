import type { HlsPartData } from './hls-client.js';
export interface HlsPlaybackOptions {
    /** MSE audio/mp4 or video/mp4 MIME type, including codecs. Otherwise inferred from variant.codecs. */
    mimeType?: string;
    /** Calls media.play() once after the first media append; default true. */
    autoplay?: boolean;
    /** Seconds buffered before pulling another unit; default 30. One unit may exceed this target. */
    bufferAhead?: number;
    /** Seconds of played media retained, rounded back to a known random-access boundary; default 30. */
    bufferBehind?: number;
    /** Source-open and individual append/remove deadline in milliseconds; default 30000. Pauses have no deadline. */
    operationTimeoutMs?: number;
    signal?: AbortSignal;
}
/**
 * Plays complete fMP4 units in order, borrowing each unit until its append completes.
 * Supports one audio and/or video track, complete moof/mdat units, and no edits except a single zero-offset rate-one edit.
 * Preserves A/V presentation offsets and seeks forward across buffered gaps. Pause/resume uses the media element.
 * Resolves after actual ended; completion, failure, or abort closes the iterator and releases the owned MSE attachment.
 */
export declare function playHls(media: HTMLMediaElement, units: AsyncIterable<HlsPartData>, options?: HlsPlaybackOptions): Promise<void>;
