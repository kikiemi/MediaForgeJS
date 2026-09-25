import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
export interface HlsByteRange {
    length: number;
    offset: number;
}
export interface HlsKey {
    method: string;
    uri?: string;
    iv?: string;
    keyFormat?: string;
    keyFormatVersions?: string;
}
export interface HlsMap {
    uri: string;
    byteRange?: HlsByteRange;
    key?: HlsKey;
    /** Up to 64 active KEYFORMAT alternatives in declaration order; key is the last declared alternative. */
    keys?: HlsKey[];
}
export interface HlsPart {
    uri: string;
    duration: number;
    independent?: boolean;
    gap?: boolean;
    byteRange?: HlsByteRange;
    /** Populated by the parser; numbering is local to the parent media sequence. */
    sequence?: number;
    partIndex?: number;
    discontinuitySequence?: number;
    discontinuity?: boolean;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
}
export interface HlsSegment {
    uri: string;
    duration: number;
    title?: string;
    sequence: number;
    discontinuitySequence: number;
    discontinuity?: boolean;
    byteRange?: HlsByteRange;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
    gap?: boolean;
    parts?: HlsPart[];
}
export type HlsAttributes = Record<string, string>;
export interface HlsVariant {
    uri: string;
    bandwidth: number;
    averageBandwidth?: number;
    codecs?: string;
    resolution?: {
        width: number;
        height: number;
    };
    frameRate?: number;
    audio?: string;
    video?: string;
    subtitles?: string;
    closedCaptions?: string;
    iframe?: boolean;
    attributes?: HlsAttributes;
}
export interface HlsRendition {
    type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
    groupId: string;
    name: string;
    uri?: string;
    language?: string;
    default?: boolean;
    autoselect?: boolean;
    forced?: boolean;
    channels?: string;
    instreamId?: string;
    attributes?: HlsAttributes;
}
interface HlsPlaylistBase {
    version?: number;
    independentSegments?: boolean;
    start?: HlsAttributes;
    baseUrl?: string;
    diagnostics?: readonly MediaDiagnostic[];
}
export interface HlsMasterPlaylist extends HlsPlaylistBase {
    type: 'master';
    variants: HlsVariant[];
    renditions: HlsRendition[];
    sessionData?: HlsAttributes[];
    sessionKeys?: HlsKey[];
}
export interface HlsMediaPlaylist extends HlsPlaylistBase {
    type: 'media';
    targetDuration: number;
    mediaSequence: number;
    discontinuitySequence: number;
    segments: HlsSegment[];
    endList: boolean;
    playlistType?: 'EVENT' | 'VOD';
    iframeOnly?: boolean;
    dateRanges?: HlsAttributes[];
    partTarget?: number;
    trailingParts?: HlsPart[];
    preloadHints?: HlsAttributes[];
    serverControl?: HlsAttributes;
    renditionReports?: HlsAttributes[];
    skippedSegments?: number;
}
export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;
export interface HlsParseOptions extends DiagnosticOptions {
    baseUrl?: string;
    /** Reconstruct EXT-X-SKIP from this playlist. Missing skipped history is an error. */
    previousPlaylist?: HlsMediaPlaylist;
    /** Maximum complete segments plus PART entries, including reconstructed history. Default 100000. */
    maxPlaylistEntries?: number;
}
export declare function parseHlsPlaylist(text: string, options?: HlsParseOptions): HlsPlaylist;
export declare function serializeHlsPlaylist(playlist: HlsPlaylist): string;
export {};
