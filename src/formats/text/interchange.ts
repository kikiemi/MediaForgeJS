import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { decodeSubtitleInput } from './interchange-utils';
import { snapshotInterchangeOptions, snapshotSubtitleOptions } from './options';
import { parseAss, writeAss } from './ass';
import { parseTtml, writeTtml } from './ttml';
import { parseSrt, parseWebVtt, writeSrt, writeWebVtt } from './subtitles';
import type {
    ParseSubtitleOptions,
    SubtitleCue,
    SubtitleDocument,
    SubtitleFormat,
    SubtitleFormatInput,
    SubtitleOptions,
} from './types';

/** A SubRip cue's start: an optional counter line, then 00:00:01,000 --> 00:00:02,500. */
const SUBRIP_TIME = String.raw`\d{2,}:\d{2}:\d{2}[,.]\d{3}`;
const SUBRIP_CUE_START = new RegExp(
    String.raw`^\s*(?:\d+\s*\n)?${SUBRIP_TIME}[ \t]+-->[ \t]+${SUBRIP_TIME}`,
);

function normalizeFormat(format: SubtitleFormatInput): SubtitleFormat {
    if (format === 'vtt') return 'webvtt';
    if (format === 'dfxp' || format === 'imsc') return 'ttml';
    if (['webvtt', 'srt', 'ass', 'ssa', 'ttml'].includes(format)) return format as SubtitleFormat;
    throw new MediaForgeError('Unsupported subtitle format', 'INPUT');
}

function detectText(source: string): SubtitleFormat | null {
    if (/^WEBVTT(?:[ \t\r\n]|$)/.test(source)) return 'webvtt';
    if (/^\[(?:Script Info|V4\+? Styles|Events)\][ \t]*$/im.test(source)) {
        return /^ScriptType\s*:\s*v4\.00\s*$/im.test(source) || /^\[V4 Styles\]/im.test(source)
            ? 'ssa'
            : 'ass';
    }
    const xml = source.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trimStart();
    if (/^<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|\/?>)/.test(xml)) return 'ttml';
    if (SUBRIP_CUE_START.test(source)) return 'srt';
    return null;
}

/** Signature detection only; parsing still validates the detected document. */
export function detectSubtitleFormat(
    input: string | Uint8Array,
    options: SubtitleOptions = {},
): SubtitleFormat | null {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    return detectText(decodeSubtitleInput(input, options, context, 'subtitle'));
}

/** DFXP and IMSC use the TTML text subset; no profile conformance is implied. */
export function parseSubtitles(
    input: string | Uint8Array,
    options: ParseSubtitleOptions = {},
): SubtitleDocument {
    options = snapshotInterchangeOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const source = decodeSubtitleInput(input, options, context, 'subtitle', options.encoding);
    const format =
        options.format === undefined ? detectText(source) : normalizeFormat(options.format);
    if (!format) throw new DemuxError('Subtitle format could not be detected');
    const parsing = {
        ...options,
        maxWarnings: Math.max(0, (options.maxWarnings ?? 100) - context.warnings.length),
    };
    let document: SubtitleDocument;
    if (format === 'ass' || format === 'ssa') document = parseAss(source, { ...parsing, format });
    else if (format === 'ttml') document = parseTtml(source, parsing);
    else if (format === 'webvtt') document = parseWebVtt(source, parsing);
    else document = parseSrt(source, parsing);
    document.diagnostics = [...context.warnings, ...document.diagnostics];
    return document;
}

export function writeSubtitles(
    document: SubtitleDocument | readonly SubtitleCue[],
    format: SubtitleFormatInput,
    options: SubtitleOptions = {},
): string {
    options = snapshotSubtitleOptions(options);
    const target = normalizeFormat(format);
    if (target === 'ass' || target === 'ssa')
        return writeAss(document, { ...options, format: target });
    if (target === 'ttml') return writeTtml(document, options);
    return target === 'webvtt' ? writeWebVtt(document, options) : writeSrt(document, options);
}
