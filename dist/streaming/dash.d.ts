import type { DashManifest, DashParseOptions, DashResolveOptions } from './dash-types.js';
export type { DashAdaptationSet, DashByteRange, DashIndexRequest, DashIndexResource, DashManifest, DashParseOptions, DashPeriod, DashRepresentation, DashResolveOptions, DashResource, DashSegment, DashSegmentInfo, DashSegmentOptions, DashTimelineEntry, } from './dash-types.js';
export { iterateDashSegments } from './dash-segments.js';
/** Parses the bounded static MPD addressing subset. No network, playback, ABR, or decryption is performed. */
export declare function parseDashManifest(input: string | Uint8Array, options?: DashParseOptions): DashManifest;
/** Resolves static SegmentBase indexes through the caller's reader; publishes only a complete immutable plan. */
export declare function resolveDashManifest(input: string | Uint8Array, options: DashResolveOptions): Promise<DashManifest>;
