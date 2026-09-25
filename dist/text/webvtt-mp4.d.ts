import type { MediaDiagnostic } from '../core/diagnostics.js';
import type { EncodedChunk } from '../types/media.js';
import type { SubtitleCue, SubtitleDocument, SubtitleOptions, SubtitleTrackConfig } from './types.js';
export interface WebVttSampleCue {
    text: string;
    id?: string;
    settings?: string;
    unknownBoxes?: readonly Uint8Array[];
}
export interface WebVttSample {
    cues: WebVttSampleCue[];
    empty: boolean;
    unknownBoxes: Uint8Array[];
    diagnostics: readonly MediaDiagnostic[];
}
export declare function encodeWebVttSample(cues: readonly WebVttSampleCue[], unknownBoxes?: readonly Uint8Array[]): Uint8Array<ArrayBuffer>;
export declare function decodeWebVttSample(data: Uint8Array, options?: SubtitleOptions): WebVttSample;
export declare function encodeWebVttBlock(cue: WebVttSampleCue): Uint8Array<ArrayBuffer>;
export declare function decodeWebVttBlock(data: Uint8Array): WebVttSampleCue;
export declare function subtitleTrackConfig(document: SubtitleDocument, options?: Omit<SubtitleTrackConfig, 'codecConfig'>): SubtitleTrackConfig;
export declare function toSubtitleChunks(document: SubtitleDocument | readonly SubtitleCue[], codec?: SubtitleTrackConfig['codec'], options?: {
    startTime?: number;
    endTime?: number;
    maxSamples?: number;
    maxBytes?: number;
}): EncodedChunk[];
