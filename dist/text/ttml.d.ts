import type { SubtitleCue, SubtitleDocument, SubtitleOptions } from './types.js';
export interface TtmlTimingParameters {
    frameRate?: number;
    frameRateMultiplier?: number;
    subFrameRate?: number;
    tickRate?: number;
}
/** Media time base only. Returns seconds, or null for an unsupported expression. */
export declare function parseTtmlTimestamp(value: string, parameters?: TtmlTimingParameters): number | null;
export declare function parseTtml(input: string | Uint8Array, options?: SubtitleOptions): SubtitleDocument;
export declare function writeTtml(input: SubtitleDocument | readonly SubtitleCue[], options?: SubtitleOptions): string;
