import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { decodeSubtitleInput } from './interchange-utils.js';
import { snapshotInterchangeOptions, snapshotSubtitleOptions } from './options.js';
import { parseAss, writeAss } from './ass.js';
import { parseTtml, writeTtml } from './ttml.js';
import { parseSrt, parseWebVtt, writeSrt, writeWebVtt } from './subtitles.js';
function normalizeFormat(format) {
    if (format === 'vtt')
        return 'webvtt';
    if (format === 'dfxp' || format === 'imsc')
        return 'ttml';
    if (['webvtt', 'srt', 'ass', 'ssa', 'ttml'].includes(format))
        return format;
    throw new MediaForgeError('Unsupported subtitle format', 'INPUT');
}
function detectText(source) {
    if (/^WEBVTT(?:[ \t\r\n]|$)/.test(source))
        return 'webvtt';
    if (/^\[(?:Script Info|V4\+? Styles|Events)\][ \t]*$/im.test(source)) {
        return /^ScriptType\s*:\s*v4\.00\s*$/im.test(source) || /^\[V4 Styles\]/im.test(source) ? 'ssa' : 'ass';
    }
    const xml = source.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trimStart();
    if (/^<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|\/?>)/.test(xml))
        return 'ttml';
    if (/^\s*(?:\d+\s*\n)?\d{2,}:\d{2}:\d{2}[,.]\d{3}[ \t]+-->[ \t]+\d{2,}:\d{2}:\d{2}[,.]\d{3}/.test(source))
        return 'srt';
    return null;
}
export function detectSubtitleFormat(input, options = {}) {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    return detectText(decodeSubtitleInput(input, options, context, 'subtitle'));
}
export function parseSubtitles(input, options = {}) {
    options = snapshotInterchangeOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const source = decodeSubtitleInput(input, options, context, 'subtitle', options.encoding);
    const format = options.format === undefined ? detectText(source) : normalizeFormat(options.format);
    if (!format)
        throw new MediaForgeError('Subtitle format could not be detected', 'INPUT');
    const parsing = { ...options, maxWarnings: Math.max(0, (options.maxWarnings ?? 100) - context.warnings.length) };
    let document;
    if (format === 'ass' || format === 'ssa')
        document = parseAss(source, { ...parsing, format });
    else if (format === 'ttml')
        document = parseTtml(source, parsing);
    else if (format === 'webvtt')
        document = parseWebVtt(source, parsing);
    else
        document = parseSrt(source, parsing);
    document.diagnostics = [...context.warnings, ...document.diagnostics];
    return document;
}
export function writeSubtitles(document, format, options = {}) {
    options = snapshotSubtitleOptions(options);
    const target = normalizeFormat(format);
    if (target === 'ass' || target === 'ssa')
        return writeAss(document, { ...options, format: target });
    if (target === 'ttml')
        return writeTtml(document, options);
    return target === 'webvtt' ? writeWebVtt(document, options) : writeSrt(document, options);
}
