import type { MediaDiagnostic } from './diagnostics.js';
import type { MatroskaPassThrough } from '../types/media.js';
import type { MatroskaTrackIdentity } from './matroska-tags.js';
interface TrackMetadata {
    readonly id?: number;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly commentary?: boolean;
    readonly alphaMode?: boolean;
}
export declare function trackDispositionLoss(track: TrackMetadata, format: string): Omit<MediaDiagnostic, 'severity'> | undefined;
export declare function matroskaMetadataLoss(pass: MatroskaPassThrough | undefined, unsupportedTags: boolean | undefined, format: string, tracks?: readonly MatroskaTrackIdentity[]): Omit<MediaDiagnostic, 'severity'> | undefined;
export declare function matroskaOutputMetadata(pass: MatroskaPassThrough, format: 'mkv' | 'webm', tracks?: readonly MatroskaTrackIdentity[]): MatroskaPassThrough;
export declare function assertAlphaCopy(track: TrackMetadata, format: string, copied?: boolean): void;
export {};
