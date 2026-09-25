import type { ParseSubtitleOptions, SubtitleCue, SubtitleDocument, SubtitleFormat, SubtitleFormatInput, SubtitleOptions } from './types.js';
/** Signature detection only; parsing still validates the detected document. */
export declare function detectSubtitleFormat(input: string | Uint8Array, options?: SubtitleOptions): SubtitleFormat | null;
/** DFXP and IMSC use the TTML text subset; no profile conformance is implied. */
export declare function parseSubtitles(input: string | Uint8Array, options?: ParseSubtitleOptions): SubtitleDocument;
export declare function writeSubtitles(document: SubtitleDocument | readonly SubtitleCue[], format: SubtitleFormatInput, options?: SubtitleOptions): string;
