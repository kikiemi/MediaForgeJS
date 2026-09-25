import type { DashRepresentation, DashSegment, DashSegmentOptions } from './dash-types.js';
import type { DashFraction, DashTemplateToken } from './dash-common.js';
export interface DashPlan {
    readonly start: DashFraction;
    readonly duration?: DashFraction;
    readonly maxSegments: number;
    readonly media?: readonly DashTemplateToken[];
}
export declare function registerDashRepresentation(representation: DashRepresentation, plan: DashPlan): DashRepresentation;
/** Lazily locates resources from a parsed or resolved DASH representation; performs no I/O. */
export declare function iterateDashSegments(representation: DashRepresentation, options?: DashSegmentOptions): IterableIterator<DashSegment>;
