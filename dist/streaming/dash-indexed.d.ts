import type { DashFraction } from './dash-common.js';
import type { DashIndexRequest, DashManifest, DashRepresentation, DashResolveOptions } from './dash-types.js';
export interface DashPendingIndex {
    readonly kind: 'pending-index';
    readonly description: Omit<DashRepresentation, 'segmentInfo' | 'segmentCount'>;
    readonly index: DashIndexRequest;
    readonly exact: boolean;
    readonly timescale: number;
    readonly presentationTimeOffset: bigint;
    readonly start: DashFraction;
    readonly duration?: DashFraction;
    readonly maxSegments: number;
}
interface PreparedIndexes {
    readonly pending: readonly DashPendingIndex[];
    reserveEntries(count: number): void;
    reserveCharacters(count: number): void;
    finish(resolved: ReadonlyMap<DashPendingIndex, DashRepresentation>): DashManifest;
}
export declare function resolveDashIndexes(options: DashResolveOptions, prepare: () => PreparedIndexes): Promise<DashManifest>;
export {};
