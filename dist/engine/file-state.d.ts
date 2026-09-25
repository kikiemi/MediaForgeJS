import type { DiagnosticContext } from '../core/diagnostics.js';
import type { RemuxPlanner, RemuxTrack } from './remux-plan.js';
import type { Source, Sink } from '../types/io.js';
import type { RemuxOptions } from './engine-core.js';
import type { MatroskaPassThrough } from '../types/media.js';
interface MediaFileState {
    readonly source: Source;
    readonly title?: string;
    readonly matroskaPassThrough?: MatroskaPassThrough;
    readonly matroskaUnsupportedTags: boolean;
    readonly tracks: readonly RemuxTrack[];
    readonly signal: AbortSignal;
    readonly diagnostics: DiagnosticContext;
    readonly planner: RemuxPlanner;
    remux(sink: Sink, options: RemuxOptions, diagnostics: DiagnosticContext): Promise<void>;
}
export declare function bindMediaFileState(file: object, state: MediaFileState): void;
export declare function forgetMediaFileState(file: object): void;
export declare function mediaFileState(file: object): MediaFileState;
export {};
