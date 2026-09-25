import type { MediaDiagnostic } from '../core/diagnostics.js';
import type { MediaMetadata, MetadataInput, MetadataOptions } from './types.js';
export interface Id3Frame {
    id: string;
    flags: number;
    data: Uint8Array;
}
export interface Id3Tag {
    version: number;
    revision: number;
    flags: number;
    frames: Id3Frame[];
    paddingSize: number;
    trailingData?: Uint8Array;
    opaqueData?: Uint8Array;
    /** Read projection; writeId3Tag writes frames. Use createId3Tag to map edited normalized values. */
    metadata: MediaMetadata;
    diagnostics: readonly MediaDiagnostic[];
}
export declare function parseId3Tag(bytes: Uint8Array, options?: MetadataOptions): Id3Tag;
export declare function writeId3Tag(tag: Pick<Id3Tag, 'version' | 'frames'> & Partial<Pick<Id3Tag, 'revision' | 'flags' | 'paddingSize' | 'trailingData' | 'opaqueData'>>, options?: MetadataOptions): Uint8Array<ArrayBuffer>;
export declare function createId3Tag(input: MetadataInput, options?: MetadataOptions & {
    version?: 3 | 4;
}): Id3Tag;
