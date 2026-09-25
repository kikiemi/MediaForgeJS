import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
export type MetadataValue = {
    type: 'text';
    value: string;
} | {
    type: 'integer';
    value: bigint;
} | {
    type: 'number';
    value: number;
} | {
    type: 'boolean';
    value: boolean;
} | {
    type: 'date';
    value: string;
} | {
    type: 'binary';
    value: Uint8Array;
    mimeType?: string;
    description?: string;
};
export interface MetadataEntry {
    key: string;
    value: MetadataValue;
    language?: string;
    source?: string;
}
export interface MetadataChapter {
    id?: string;
    startTime: number;
    endTime?: number;
    title?: string;
    language?: string;
    entries?: readonly MetadataEntry[];
}
export interface OpaqueMetadata {
    format: string;
    data: Uint8Array;
}
export interface MediaMetadata {
    entries: MetadataEntry[];
    chapters: MetadataChapter[];
    opaque: OpaqueMetadata[];
    diagnostics: readonly MediaDiagnostic[];
}
export interface MetadataInput {
    entries?: readonly MetadataEntry[];
    chapters?: readonly MetadataChapter[];
    opaque?: readonly OpaqueMetadata[];
}
export interface MetadataOptions extends DiagnosticOptions {
    maxBytes?: number;
    maxEntries?: number;
}
