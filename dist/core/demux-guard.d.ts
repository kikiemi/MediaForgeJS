import type { Source } from '../types/io.js';
export declare const DEMUX_LIMITS: {
    readonly maxSamplesPerTrack: 1000000;
    readonly maxSamplesTotal: 1000000;
    readonly maxTracks: 64;
    readonly maxTableEntries: 1000000;
    readonly maxBoxesPerRange: 16384;
    readonly maxBoxDepth: 32;
};
export interface DemuxBudgetOptions {
    /** Maximum sample-index entries across all tracks. */
    readonly maxSamples?: number;
    /** Estimated index-allocation budget in bytes; defaults to 128 MiB. Excludes media payloads. */
    readonly maxIndexBytes?: number;
}
export interface ResolvedDemuxBudget {
    readonly maxSamples: number;
    readonly maxIndexBytes: number;
}
export declare function resolveDemuxBudget(options?: DemuxBudgetOptions, defaultMaxSamples?: number): ResolvedDemuxBudget;
/** Conservative allocation estimates, independent of payload compression and file padding. */
export declare class DemuxIndexBudget {
    readonly limits: ResolvedDemuxBudget;
    private samples;
    private bytes;
    constructor(limits: ResolvedDemuxBudget);
    checkSamples(count: number, context?: string): void;
    reserveSamples(count: number, estimatedBytesPerSample?: number, context?: string): void;
    reserveBytes(bytes: number, context?: string): void;
}
export declare function objectSampleLedgerEntryLimit(_inputBytes: number): number;
export declare function demuxAssert(condition: unknown, message: string): asserts condition;
export declare function readExact(source: Source, offset: number, length: number): Promise<Uint8Array>;
export declare function yieldEventLoop(): Promise<void>;
