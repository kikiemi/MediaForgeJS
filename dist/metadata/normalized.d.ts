import type { MetadataInput, MetadataOptions, MediaMetadata } from './types.js';
export declare function metadataLimit(value: number | undefined, fallback: number, name: string): number;
export declare function normalizeMetadata(input: MetadataInput, options?: MetadataOptions): MediaMetadata;
