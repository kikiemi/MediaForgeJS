import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
import type { AdaptiveQualityOptions } from './adaptive-quality.js';
import type { HlsEncryptionHandler, HlsKeyLoader } from './hls-encryption.js';
import type { HlsKey, HlsPart, HlsPlaylist, HlsSegment, HlsVariant } from './hls-playlist.js';
export interface HlsVariantChange {
    previous?: HlsVariant;
    variant: HlsVariant;
    /** First media sequence to be downloaded from this variant; numbering is variant-local. */
    sequence: number;
    /** Present when the first downloaded unit is a PART; numbering is parent-local. */
    partIndex?: number;
    bandwidthEstimate?: number;
    reason: 'initial' | 'up' | 'down';
}
export interface HlsAdaptiveOptions extends AdaptiveQualityOptions {
    /** Awaited before initial/segment downloads and before delivery of staged PART switches; rejection stops iteration. */
    onVariantChange?: (event: HlsVariantChange) => void | PromiseLike<void>;
}
export interface HlsClientOptions extends DiagnosticOptions {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    maxPlaylistBytes?: number;
    maxSegmentBytes?: number;
    /** Ordered handlers are tried before built-in identity AES-128. */
    encryptionHandlers?: readonly HlsEncryptionHandler[];
    keyLoader?: HlsKeyLoader;
    /** Maximum bytes returned by a key request. Default 65536. */
    maxKeyBytes?: number;
    /** Completed keys retained per iterator; zero disables caching. Default 8. */
    maxCachedKeys?: number;
    /** Bounds segments plus PART entries retained across delta refreshes. Default 100000. */
    maxPlaylistEntries?: number;
    refreshIntervalMs?: number;
    /** Deadline for each resource, including its body. Default 30000 ms. */
    requestTimeoutMs?: number;
    /** Opt-in adaptation after loading a master. PART/live switching requires matching PDT or discontinuity anchors. */
    adaptive?: boolean | HlsAdaptiveOptions;
}
export interface HlsSegmentOptions {
    live?: boolean;
    startSequence?: number;
    signal?: AbortSignal;
    /** Stop normally after this many playlist refreshes; zero reads the loaded snapshot only. */
    maxRefreshes?: number;
    /** Fail after this many refreshes without progress. parts() and adaptive live segments() default to 10. */
    maxIdleRefreshes?: number;
}
export type HlsPartOptions = HlsSegmentOptions;
export type HlsPartData = {
    type: 'part';
    part: HlsPart;
    sequence: number;
    partIndex: number;
    discontinuitySequence: number;
    /** Metadata snapshot of the variant that supplied this PART in adaptive mode. */
    variant?: HlsVariant;
    data: Uint8Array;
    initData?: Uint8Array;
    encryption?: HlsKey;
} | ({
    type: 'segment';
} & HlsSegmentData);
export interface HlsSegmentData {
    segment: HlsSegment;
    data: Uint8Array;
    /** Present for adaptive downloads; metadata snapshot of the variant that supplied this segment. */
    variant?: HlsVariant;
    /** Present when the initialization map changes, including after a discontinuity. */
    initData?: Uint8Array;
    /** Selected key when a handler leaves media or initialization bytes encrypted. */
    encryption?: HlsKey;
}
/** Fetches HLS media; alternative rendition fetching and media decoding remain caller-owned. */
export declare class HlsClient {
    private readonly fetcher;
    private readonly options;
    private readonly context;
    private readonly controller;
    private readonly maxPlaylistBytes;
    private readonly maxSegmentBytes;
    private readonly encryptionHandlers;
    private readonly keyLoader;
    private readonly maxKeyBytes;
    private readonly maxCachedKeys;
    private readonly requestTimeoutMs;
    private readonly adaptiveOptions;
    private readonly onVariantChange;
    private adaptiveMaster;
    private current;
    private playlistUrl;
    private active;
    private loading;
    constructor(options?: HlsClientOptions);
    get playlist(): HlsPlaylist | undefined;
    get diagnostics(): readonly MediaDiagnostic[];
    load(url: string, options?: {
        signal?: AbortSignal;
    }): Promise<HlsPlaylist>;
    refresh(options?: {
        signal?: AbortSignal;
    }): Promise<HlsPlaylist>;
    close(reason?: unknown): void;
    segments(options?: HlsSegmentOptions): AsyncIterableIterator<HlsSegmentData>;
    /** Polls published PARTs; complete segments are fallback units, never duplicates.
     * Identity AES-128 PARTs (including byte ranges) must be independently CBC/PKCS7 encrypted. */
    parts(options?: HlsPartOptions): AsyncIterableIterator<HlsPartData>;
    private readSegments;
    private readMedia;
    private notifyVariant;
    private prepareAdaptive;
    private selectAdaptive;
    private runEncryptionOperation;
    private isBuiltinEncryption;
    private checkEncryption;
    private validateRefresh;
    private readPlaylist;
    private readResource;
    private readResourceBody;
}
