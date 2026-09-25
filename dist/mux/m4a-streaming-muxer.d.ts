import type { Sink } from '../types/io.js';
import { type MP4TrackMetadata } from '../core/mp4-metadata.js';
/** Compact paged sample-size table: four bytes per AAC access unit. */
export declare class M4ASampleSizeLedger {
    private static readonly PAGE_ENTRIES;
    private readonly pages;
    private entries;
    private bytes;
    get length(): number;
    get totalBytes(): number;
    get storageBytes(): number;
    push(size: number): void;
    at(index: number): number;
}
export interface StreamingM4AMuxerOptions {
    readonly sampleRate: number;
    readonly channels: number;
    readonly audioSpecificConfig: Uint8Array;
    readonly primingSamples?: number;
    readonly moovUserData?: Uint8Array;
    readonly audioLanguage?: string;
    readonly title?: string;
    readonly audioTrack?: MP4TrackMetadata;
    /** Required only for non-seekable sinks; populated by a dry encode pass. */
    readonly plannedSizes?: M4ASampleSizeLedger;
    readonly signal?: AbortSignal;
}
/** Audio-only mdat-first M4A muxer that never retains encoded access units. */
export declare class StreamingM4AMuxer {
    private readonly sink;
    private readonly header;
    private readonly sizes;
    private readonly mediaOffset;
    private readonly options;
    private readonly plannedSampleCount;
    private readonly plannedMediaBytes;
    private frameIndex;
    private mediaBytes;
    private finalized;
    private failed;
    private failure;
    constructor(sink: Sink, options: StreamingM4AMuxerOptions);
    private assertOpen;
    addFrame(frame: Uint8Array): void;
    finalize(validSamples: number): Promise<void>;
    get planningBytes(): number;
    get packets(): number;
}
