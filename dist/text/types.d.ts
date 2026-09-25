import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
export type SubtitleFormat = 'webvtt' | 'srt' | 'ass' | 'ssa' | 'ttml';
export type SubtitleFormatInput = SubtitleFormat | 'vtt' | 'dfxp' | 'imsc';
export interface AssCueData {
    rawText: string;
    /** Plain text snapshot used to detect edits before preserving override tags. */
    text: string;
    fields: Record<string, string>;
}
export interface AssDocumentData {
    scriptInfo: Record<string, string>;
    styleFormat: string[];
    styles: Record<string, string>[];
    eventFormat: string[];
    comments: string[];
}
export interface TtmlSpan {
    text: string;
    /** TTML styling properties without their namespace prefix; values are not CSS. */
    style?: Record<string, string>;
    language?: string;
    region?: string;
}
export interface TtmlCueData {
    text: string;
    style?: Record<string, string>;
    region?: string;
    language?: string;
    spans: TtmlSpan[];
}
export interface TtmlDocumentData {
    styles: Record<string, Record<string, string>>;
    regions: Record<string, Record<string, string>>;
    parameters: Record<string, string>;
    rootStyle?: Record<string, string>;
    language?: string;
}
export interface SubtitleCue {
    /** Times are in seconds. */
    startTime: number;
    endTime: number;
    text: string;
    id?: string;
    settings?: string;
    ass?: AssCueData;
    ttml?: TtmlCueData;
}
export type SubtitleBlock = {
    type: 'cue';
    cueIndex: number;
} | {
    type: 'note' | 'style' | 'region' | 'unknown';
    text: string;
};
export interface SubtitleTimestampMap {
    localTime: number;
    mpegTimestamp: number;
}
export interface SubtitleDocument {
    format: SubtitleFormat;
    cues: SubtitleCue[];
    blocks?: SubtitleBlock[];
    header?: string;
    headers?: string[];
    timestampMap?: SubtitleTimestampMap;
    ass?: AssDocumentData;
    ttml?: TtmlDocumentData;
    diagnostics: readonly MediaDiagnostic[];
}
export interface SubtitleOptions extends DiagnosticOptions {
    maxBytes?: number;
    maxCues?: number;
    maxBlocks?: number;
    /** Maximum XML nesting, default 64. */
    maxDepth?: number;
    /** Maximum XML elements, text nodes and attributes, default 200000. */
    maxNodes?: number;
}
export interface AssSubtitleOptions extends SubtitleOptions {
    format?: 'ass' | 'ssa';
    /** TextDecoder label for byte input; BOM takes precedence. Default UTF-8. */
    encoding?: string;
}
export interface ParseSubtitleOptions extends SubtitleOptions {
    format?: SubtitleFormatInput;
    encoding?: string;
}
export interface SubtitleTrackConfig {
    codec: 'text/webvtt' | 'text/utf8' | 'wvtt';
    codecConfig?: Uint8Array;
    language?: string;
    label?: string;
    kind?: 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata';
    default?: boolean;
}
