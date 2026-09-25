import type { DiagnosticContext } from '../core/diagnostics.js';
import type { SubtitleCue, SubtitleDocument, SubtitleFormat, SubtitleOptions } from './types.js';
export declare function decodeSubtitleInput(input: string | Uint8Array, options: SubtitleOptions, context: DiagnosticContext, format: string, encoding?: string): string;
export declare function subtitleDocument(input: SubtitleDocument | readonly SubtitleCue[], format: SubtitleFormat): SubtitleDocument;
export declare function checkSubtitleOutput(text: string, options: SubtitleOptions): string;
export declare function warnSubtitleConversion(document: SubtitleDocument, target: SubtitleFormat, context: DiagnosticContext): void;
export declare function escapeSubtitleMarkup(text: string): string;
export declare function subtitleTextForFormat(document: SubtitleDocument, cue: SubtitleCue, target: SubtitleFormat, context: DiagnosticContext): string;
