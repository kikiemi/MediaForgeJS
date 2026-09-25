import type { MatroskaPassThrough } from '../types/media.js';
export declare const MATROSKA_METADATA_LIMIT: number;
type TargetKind = 'track' | 'edition' | 'chapter' | 'attachment';
interface Tag {
    bytes: Uint8Array;
    targets: Array<{
        kind: TargetKind;
        uid: bigint;
    }>;
}
interface ParsedTags {
    tags: Tag[];
    unsupported: boolean;
}
export interface MatroskaTrackIdentity {
    readonly matroskaTrackUid?: bigint;
    readonly title?: string;
}
export declare function matroskaUid(bytes: Uint8Array, start?: number, end?: number): bigint;
export declare function parseMatroskaTags(bytes: Uint8Array, payload?: boolean): ParsedTags;
export declare function matroskaTagsElement(tags: readonly {
    bytes: Uint8Array;
}[]): Uint8Array | undefined;
export declare function matroskaScopedUids(bytes: Uint8Array, kind: 'chapters' | 'attachments'): Map<TargetKind, Set<bigint>>;
export declare function filterMatroskaTags(pass: MatroskaPassThrough, format: string, tracks?: readonly MatroskaTrackIdentity[]): {
    tags?: Uint8Array;
    unsupported: boolean;
};
export {};
