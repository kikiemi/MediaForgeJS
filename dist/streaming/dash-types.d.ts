import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
import type { SidxIndex } from './sidx.js';
export interface DashParseOptions extends DiagnosticOptions {
    readonly baseUrl?: string;
    readonly maxBytes?: number;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
    readonly maxRepresentations?: number;
    /** Maximum referenced segments per representation, without expanding repeats. Default 1000000. */
    readonly maxSegments?: number;
    /** Maximum materialized timeline entries and list resources across all representations. Default 200000. */
    readonly maxPlanEntries?: number;
}
export interface DashByteRange {
    readonly offset: number;
    readonly length: number;
}
export interface DashResource {
    readonly url: string;
    readonly byteRange?: DashByteRange;
    /** Optional auxiliary index resource; media addressing remains unchanged. */
    readonly index?: DashIndexResource;
}
export interface DashIndexResource {
    readonly url: string;
    readonly byteRange?: DashByteRange;
}
export interface DashIndexRequest extends DashIndexResource {
    readonly byteRange: DashByteRange;
}
export interface DashResolveOptions extends DashParseOptions {
    readonly readIndex: (resource: DashIndexRequest, signal?: AbortSignal) => Uint8Array | Promise<Uint8Array>;
    readonly signal?: AbortSignal;
    /** Total declared index-range bytes. Default 8 MiB, at most 64 MiB. */
    readonly maxIndexBytes?: number;
    /** Total parsed sidx reference records. Default 200000, at most 1000000. */
    readonly maxIndexReferences?: number;
    /** Index reads, performed serially. Default 256, at most 4096. */
    readonly maxIndexRequests?: number;
}
export interface DashTimelineEntry {
    readonly time: bigint;
    readonly duration: bigint;
    /** Resolved nonnegative repeat count; entries remain compressed. */
    readonly repeat: bigint;
}
export interface DashSegmentInfo {
    readonly type: 'template' | 'list';
    readonly timescale: number;
    readonly presentationTimeOffset: bigint;
    readonly startNumber: bigint;
    readonly timeline: readonly DashTimelineEntry[];
    readonly media?: string;
    readonly resources?: readonly DashResource[];
    readonly sourceType?: 'segment-base';
    readonly index?: DashIndexResource;
    readonly sidx?: SidxIndex;
}
export interface DashRepresentation {
    readonly id?: string;
    readonly bandwidth?: number;
    readonly codecs?: string;
    readonly mimeType?: string;
    readonly language?: string;
    readonly contentType?: 'video' | 'audio' | 'text';
    readonly width?: number;
    readonly height?: number;
    readonly audioSamplingRate?: number;
    readonly baseUrl?: string;
    readonly periodIndex: number;
    readonly periodId?: string;
    readonly periodStart: number;
    readonly periodDuration?: number;
    readonly initialization?: DashResource;
    readonly segmentInfo: DashSegmentInfo;
    readonly segmentCount: bigint;
}
export interface DashAdaptationSet {
    readonly id?: string;
    readonly mimeType?: string;
    readonly codecs?: string;
    readonly language?: string;
    readonly contentType?: 'video' | 'audio' | 'text';
    readonly representations: readonly DashRepresentation[];
}
export interface DashPeriod {
    readonly id?: string;
    readonly start: number;
    readonly duration?: number;
    readonly adaptationSets: readonly DashAdaptationSet[];
}
export interface DashManifest {
    readonly type: 'static';
    readonly id?: string;
    readonly baseUrl?: string;
    readonly duration?: number;
    readonly periods: readonly DashPeriod[];
    readonly diagnostics: readonly MediaDiagnostic[];
}
export interface DashSegmentOptions {
    /** Presentation seconds; select segments overlapping [start, end), within their Period. */
    readonly start?: number;
    readonly end?: number;
    /** Maximum selected segment count. Exceeding the limit fails before yielding. */
    readonly maxSegments?: number;
}
export interface DashSegment extends DashResource {
    readonly number: bigint;
    readonly time: bigint;
    readonly duration: bigint;
    readonly timescale: number;
    readonly presentationTime: number;
    readonly presentationDuration: number;
    readonly periodIndex: number;
}
