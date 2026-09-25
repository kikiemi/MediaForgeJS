import type { AssSubtitleOptions, SubtitleCue, SubtitleDocument } from './types.js';
export declare function parseAssTimestamp(value: string): number | null;
export declare function formatAssTimestamp(seconds: number): string;
export declare function parseAss(input: string | Uint8Array, options?: AssSubtitleOptions): SubtitleDocument;
export declare function writeAss(input: SubtitleDocument | readonly SubtitleCue[], options?: AssSubtitleOptions): string;
