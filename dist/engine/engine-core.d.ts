import type { Source, Sink } from '../types/io.js';
import type { MediaInput, TrackDescriptor, EncodedChunk } from '../types/media.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
import { DiagnosticContext, type DiagnosticOptions, type MediaDiagnostic } from '../core/diagnostics.js';
import { type ErrorCode } from '../core/errors.js';
import type { CmafSegment, CmafTrack } from '../streaming/cmaf.js';
import { CodecRegistry } from '../codecs/registry.js';
import { type MediaFormat, type MediaWriters } from './formats.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
export type { MediaFormat, MediaMuxer, MediaAudioMuxer } from './formats.js';
export interface MediaTrack extends TrackDescriptor {
    readonly language?: string;
    /** True when only the surviving, complete samples of a damaged input were recovered. */
    readonly incomplete?: boolean;
    readonly duration: number;
    readonly timescale?: number;
    readonly sampleCount: number;
}
export interface MediaPacket extends EncodedChunk {
    readonly trackId: number;
    readonly sampleIndex: number;
    readonly codecConfig?: Uint8Array;
    readonly leadingDiscard?: boolean;
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
export interface SampleSearchOptions {
    readonly keyframe?: boolean;
    readonly mode?: 'before' | 'after';
}
export interface MediaOpenOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format?: string;
    readonly signal?: AbortSignal;
    /** Recover complete, timed AVI packets after truncation. Strict validation still rejects damage. */
    readonly aviRecovery?: 'complete-packets';
    readonly maxPacketBytes?: number;
    /** Retained input pages. Default 4 MiB; zero disables the engine cache. */
    readonly cacheBytes?: number;
    /** Aligned page size. Default 64 KiB. */
    readonly readPageBytes?: number;
}
/** Custom demuxers return indexed encoded samples; samples with data need no source reads. */
export interface MediaDemuxer {
    readonly formats: readonly string[];
    demux(source: Source, options: MediaOpenOptions): Promise<MP4DemuxResult>;
}
export interface MediaEngineOptions {
    readonly codecs?: CodecRegistry;
    readonly demuxers?: readonly MediaDemuxer[];
    /** Only these format modules are installed by the core entry point. */
    readonly formats?: readonly MediaFormat[];
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
export type MediaSegment = {
    readonly kind: 'init';
    readonly data: Uint8Array;
    readonly tracks: readonly CmafTrack[];
} | ({
    readonly kind: 'media';
} & CmafSegment);
declare const REMUX_FORMATS: readonly ["mp4", "mov", "m4a", "m4v", "3gp", "mkv", "webm", "ts", "flv", "avi", "fmp4", "aac", "mp1", "mp2", "mp3", "wav", "aiff", "au", "caf", "flac", "ogg"];
export interface RemuxOptions extends SegmentOptions {
    readonly format: (typeof REMUX_FORMATS)[number];
    /** MP4/M4A/M4V layout; auto uses fragmented MP4 for supported codecs/subtitles unavailable in the standard writer. */
    readonly mp4Mode?: 'auto' | 'standard' | 'fragmented';
    readonly onProgress?: (progress: {
        readonly packets: number;
        readonly packetBytes: number;
    }) => void;
}
export type RemuxSupport = {
    readonly supported: true;
    readonly outputFormat: RemuxOptions['format'];
    readonly layout: 'standard' | 'fragmented' | 'audio';
    readonly warnings: readonly MediaDiagnostic[];
} | {
    readonly supported: false;
    readonly code: ErrorCode;
    readonly reason: string;
    readonly warnings: readonly MediaDiagnostic[];
};
export interface RemuxValidationOptions {
    readonly maxBytes?: number;
}
/** Portable encoded-packet engine; sources and sinks remain caller-owned. */
export declare class MediaEngine {
    readonly codecs: CodecRegistry;
    private readonly demuxers;
    private readonly ownedDemuxers;
    private readonly formatDemuxers;
    protected readonly writers: MediaWriters;
    constructor(options?: MediaEngineOptions);
    registerDemuxer(demuxer: MediaDemuxer): void;
    private addDemuxer;
    open(input: Source | MediaInput, options?: MediaOpenOptions): Promise<MediaFile>;
    protected createFile(source: Source, format: string, result: MP4DemuxResult, diagnostics: DiagnosticContext, maxPacketBytes: number, maxSamples: number, releaseSource: () => void, maxIndexBytes: number): MediaFile;
    remux(file: MediaFile, sink: Sink, options: RemuxOptions): Promise<void>;
}
export declare class MediaFile {
    private source;
    private readonly diagnostics;
    private readonly maxPacketBytes;
    private releaseSource?;
    private readonly writers;
    private readonly maxIndexBytes;
    readonly format: string;
    readonly title?: string;
    private readonly indexed;
    private readonly descriptions;
    private readonly byId;
    private readonly lifetime;
    private matroskaPassThrough?;
    private readonly matroskaUnsupportedTags;
    private retainedIndexBytes;
    private remuxPlan;
    constructor(source: Source, format: string, result: MP4DemuxResult, diagnostics: DiagnosticContext, maxPacketBytes: number, maxSamples: number, releaseSource?: (() => void) | undefined, writers?: MediaWriters, maxIndexBytes?: number);
    get tracks(): readonly MediaTrack[];
    get warnings(): readonly MediaDiagnostic[];
    /** Cancels pending reads/iterators; does not close the borrowed Source. */
    close(): void;
    private track;
    private allocateSampleOrder;
    private selected;
    /** Finds a presentation-time sample, optionally the preceding random-access sample. */
    findSample(trackId: number, time: number, options?: SampleSearchOptions): number | undefined;
    readPacket(trackId: number, sampleIndex: number, signal?: AbortSignal): Promise<MediaPacket>;
    private readIndexedPacket;
    packets(options?: PacketOptions): AsyncGenerator<MediaPacket>;
    private iteratePackets;
    segments(options?: SegmentOptions): AsyncGenerator<MediaSegment>;
    private iterateSegments;
    /** Checks track/configuration compatibility without source reads, output writes or warning callbacks; packet validity is checked during remux. */
    checkRemux(options: RemuxOptions): RemuxSupport;
    validateRemux(options: RemuxOptions, validation?: RemuxValidationOptions): Promise<RemuxSupport>;
    remux(sink: Sink, options: RemuxOptions): Promise<void>;
    private executeRemux;
    toBlob(options: RemuxOptions & {
        readonly maxBytes?: number;
    }): Promise<Blob>;
}
