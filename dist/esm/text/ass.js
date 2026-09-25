import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { subtitleLimit, validateSubtitleCue } from './subtitles.js';
import { checkSubtitleOutput, decodeSubtitleInput, subtitleDocument, subtitleTextForFormat, warnSubtitleConversion, } from './interchange-utils.js';
import { snapshotInterchangeOptions } from './options.js';
const ASS_EVENTS = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
const SSA_EVENTS = ['Marked', ...ASS_EVENTS.slice(1)];
const ASS_STYLES = [
    'Name',
    'Fontname',
    'Fontsize',
    'PrimaryColour',
    'SecondaryColour',
    'OutlineColour',
    'BackColour',
    'Bold',
    'Italic',
    'Underline',
    'StrikeOut',
    'ScaleX',
    'ScaleY',
    'Spacing',
    'Angle',
    'BorderStyle',
    'Outline',
    'Shadow',
    'Alignment',
    'MarginL',
    'MarginR',
    'MarginV',
    'Encoding',
];
const SSA_STYLES = [
    'Name',
    'Fontname',
    'Fontsize',
    'PrimaryColour',
    'SecondaryColour',
    'TertiaryColour',
    'BackColour',
    'Bold',
    'Italic',
    'BorderStyle',
    'Outline',
    'Shadow',
    'Alignment',
    'MarginL',
    'MarginR',
    'MarginV',
    'AlphaLevel',
    'Encoding',
];
export function parseAssTimestamp(value) {
    const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/.exec(value.trim());
    if (!match)
        return null;
    const ticks = ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 100 + +match[4];
    return Number.isSafeInteger(ticks) ? ticks / 100 : null;
}
export function formatAssTimestamp(seconds) {
    const ticks = Math.round(seconds * 100);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(ticks))
        throw new MediaForgeError('Invalid ASS timestamp', 'INPUT');
    const pad = (value) => String(value).padStart(2, '0');
    return `${Math.floor(ticks / 360000)}:${pad(Math.floor(ticks / 6000) % 60)}:${pad(Math.floor(ticks / 100) % 60)}.${pad(ticks % 100)}`;
}
function field(record, name) {
    const key = Object.keys(record).find(key => key.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : record[key];
}
function fields(value, format, textField = false) {
    const textIndex = textField ? format.findIndex(name => name.toLowerCase() === 'text') : -1;
    const parts = [];
    let start = 0;
    for (let i = 0; i < (textIndex < 0 ? format.length - 1 : textIndex); i++) {
        const end = value.indexOf(',', start);
        if (end < 0)
            return null;
        parts.push(value.slice(start, end));
        start = end + 1;
    }
    let end = value.length;
    const trailing = [];
    if (textIndex >= 0)
        for (let i = format.length - 1; i > textIndex; i--) {
            const comma = value.lastIndexOf(',', end - 1);
            if (comma < start)
                return null;
            trailing.unshift(value.slice(comma + 1, end));
            end = comma;
        }
    const middle = value.slice(start, end);
    if (textIndex < 0 && middle.includes(','))
        return null;
    parts.push(middle, ...trailing);
    const result = Object.create(null);
    format.forEach((name, index) => {
        result[name] = index === textIndex ? parts[index] : parts[index].trim();
    });
    return result;
}
function validFormat(format) {
    return (format.length > 0 &&
        format.length <= 128 &&
        format.every(name => /^[A-Za-z][A-Za-z0-9 ]*$/.test(name)) &&
        new Set(format.map(name => name.toLowerCase())).size === format.length);
}
function plainAssText(value, wrap, context) {
    let drawing = false;
    let mode = wrap;
    let output = '';
    const parts = value.split(/(\{[^}]*\})/g);
    for (const part of parts) {
        if (part.startsWith('{') && part.endsWith('}')) {
            const drawingTag = /\\p(\d+)(?:\\|\}|$)/.exec(part);
            if (drawingTag) {
                drawing = +drawingTag[1] > 0;
                if (drawing)
                    context.recover({
                        code: 'ASS_DRAWING',
                        message: 'ASS vector drawing is retained in rawText but excluded from plain text',
                        format: 'ass',
                    });
            }
            const wrappingTag = /\\q([0-3])/.exec(part);
            if (wrappingTag)
                mode = wrappingTag[1];
            continue;
        }
        if (!drawing)
            output += part.replace(/\\([Nnh])/g, (_, char) => char === 'N' || (char === 'n' && mode === '2') ? '\n' : char === 'h' ? '\u00a0' : ' ');
    }
    if (/[{}]/.test(output))
        context.recover({ code: 'ASS_BRACES', message: 'Unmatched ASS braces retained as text', format: 'ass' });
    return output;
}
export function parseAss(input, options = {}) {
    options = snapshotInterchangeOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    if (options.format !== undefined && options.format !== 'ass' && options.format !== 'ssa')
        throw new MediaForgeError('Invalid ASS format', 'INPUT');
    const source = decodeSubtitleInput(input, options, context, options.format ?? 'ass', options.encoding);
    const format = options.format ??
        (/^ScriptType\s*:\s*v4\.00\s*$/im.test(source) || /^\[V4 Styles\]/im.test(source) ? 'ssa' : 'ass');
    const document = {
        format,
        cues: [],
        diagnostics: [],
        ass: {
            scriptInfo: Object.create(null),
            styleFormat: [...(format === 'ssa' ? SSA_STYLES : ASS_STYLES)],
            styles: [],
            eventFormat: [...(format === 'ssa' ? SSA_EVENTS : ASS_EVENTS)],
            comments: [],
        },
    };
    const data = document.ass;
    const maxCues = subtitleLimit(options.maxCues, 100000, 'maxCues');
    const maxBlocks = subtitleLimit(options.maxBlocks, 200000, 'maxBlocks');
    const lines = source.split('\n', maxBlocks + 1);
    if (lines.length > maxBlocks)
        throw new MediaForgeError('ASS input exceeds maxBlocks', 'INPUT');
    let section = '';
    let eventsSeen = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('!:'))
            continue;
        const heading = /^\[([^\]]+)\]$/.exec(trimmed);
        if (heading) {
            section = heading[1].toLowerCase();
            if (section === 'events')
                eventsSeen = true;
            if (!['script info', 'v4 styles', 'v4+ styles', 'events'].includes(section)) {
                context.recover({
                    code: 'ASS_SECTION_LOSS',
                    message: `Unsupported [${heading[1]}] section was omitted`,
                    format,
                });
            }
            continue;
        }
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).replace(/^[ \t]*/, '');
        if (section === 'script info') {
            data.scriptInfo[key] = value.trim();
            continue;
        }
        const styleSection = section === 'v4 styles' || section === 'v4+ styles';
        if ((styleSection || section === 'events') && key.toLowerCase() === 'format') {
            const layout = value.split(',').map(value => value.trim());
            if (!validFormat(layout) ||
                (!styleSection &&
                    ['start', 'end', 'text'].some(key => !layout.some(name => name.toLowerCase() === key)))) {
                throw new MediaForgeError('Invalid ASS Format declaration', 'INPUT');
            }
            if (styleSection) {
                if (data.styles.length)
                    context.recover({
                        code: 'ASS_STYLE_FORMAT',
                        message: 'Changing style formats may omit earlier style fields on serialization',
                        format,
                    });
                data.styleFormat = layout;
            }
            else {
                if (document.cues.length && layout.join(',') !== data.eventFormat.join(',')) {
                    context.recover({
                        code: 'ASS_EVENT_FORMAT',
                        message: 'Changing event formats may omit earlier event fields on serialization',
                        format,
                    });
                }
                data.eventFormat = layout;
            }
            continue;
        }
        if (styleSection && key.toLowerCase() === 'style') {
            const style = fields(value, data.styleFormat);
            if (style)
                data.styles.push(style);
            else
                context.recover({ code: 'ASS_STYLE', message: 'Malformed ASS style omitted', format });
        }
        else if (section === 'events' && key.toLowerCase() === 'comment')
            data.comments.push(value);
        else if (section === 'events' && key.toLowerCase() === 'dialogue') {
            const record = fields(value, data.eventFormat, true);
            const startTime = parseAssTimestamp(record ? (field(record, 'Start') ?? '') : '');
            const endTime = parseAssTimestamp(record ? (field(record, 'End') ?? '') : '');
            if (!record || startTime === null || endTime === null || endTime <= startTime) {
                context.recover({ code: 'ASS_CUE', message: 'Malformed ASS dialogue omitted', format });
                continue;
            }
            if (document.cues.length >= maxCues)
                throw new MediaForgeError('ASS input exceeds maxCues', 'INPUT');
            const rawText = field(record, 'Text');
            const text = plainAssText(rawText, field(data.scriptInfo, 'WrapStyle') ?? '0', context);
            document.cues.push({ startTime, endTime, text, ass: { rawText, text, fields: record } });
        }
        else if (section === 'events')
            context.recover({ code: 'ASS_EVENT_LOSS', message: `Unsupported ASS event ${key} omitted`, format });
    }
    if (!eventsSeen)
        context.recover({ code: 'ASS_EVENTS', message: 'ASS Events section is missing', format });
    if (field(data.scriptInfo, 'Timer') !== undefined && Number(field(data.scriptInfo, 'Timer')) !== 100) {
        context.recover({
            code: 'ASS_TIMER',
            message: 'Nondefault ASS Timer is retained but is not applied to cue times',
            format,
        });
    }
    document.diagnostics = context.warnings;
    return document;
}
function lineValue(value, comma = false) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || (!comma && value.includes(',')))
        throw new MediaForgeError('Invalid ASS field value', 'INPUT');
    return value;
}
export function writeAss(input, options = {}) {
    options = snapshotInterchangeOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const document = subtitleDocument(input, options.format ?? 'ass');
    const format = options.format ?? (document.format === 'ssa' ? 'ssa' : 'ass');
    if (format !== 'ass' && format !== 'ssa')
        throw new MediaForgeError('Invalid ASS format', 'INPUT');
    warnSubtitleConversion(document, format, context);
    if (document.cues.length > subtitleLimit(options.maxCues, 100000, 'maxCues'))
        throw new MediaForgeError('ASS output exceeds maxCues', 'INPUT');
    const sameVariant = !document.ass || document.format === format;
    if (!sameVariant)
        context.recover({
            code: 'ASS_VARIANT_STYLE_LOSS',
            message: 'ASS/SSA variant conversion replaces incompatible styles with a default style',
            format,
        });
    const data = document.ass;
    const styleFormat = sameVariant && data ? data.styleFormat : format === 'ssa' ? SSA_STYLES : ASS_STYLES;
    const eventFormat = sameVariant && data ? data.eventFormat : format === 'ssa' ? SSA_EVENTS : ASS_EVENTS;
    if (!validFormat(styleFormat) ||
        !validFormat(eventFormat) ||
        !['start', 'end', 'text'].every(key => eventFormat.some(name => name.toLowerCase() === key))) {
        throw new MediaForgeError('Invalid ASS output Format declaration', 'INPUT');
    }
    const script = {
        ...(data?.scriptInfo ?? {}),
        ScriptType: format === 'ssa' ? 'v4.00' : 'v4.00+',
    };
    const defaultStyle = {
        Name: 'Default',
        Fontname: 'Arial',
        Fontsize: '20',
        PrimaryColour: '&H00FFFFFF',
        SecondaryColour: '&H000000FF',
        OutlineColour: '&H00000000',
        BackColour: '&H00000000',
        TertiaryColour: '&H00000000',
        ScaleX: '100',
        ScaleY: '100',
        BorderStyle: '1',
        Outline: '1',
        Shadow: '0',
        Alignment: '2',
        MarginL: '10',
        MarginR: '10',
        MarginV: '10',
        Encoding: '1',
    };
    const styles = sameVariant && data?.styles.length ? data.styles : [defaultStyle];
    const maximum = subtitleLimit(options.maxBlocks, 200000, 'maxBlocks');
    if (styles.length + document.cues.length + (data?.comments.length ?? 0) + Object.keys(script).length > maximum)
        throw new MediaForgeError('ASS output exceeds maxBlocks', 'INPUT');
    const output = [
        '[Script Info]',
        ...Object.entries(script)
            .filter(([key]) => key.toLowerCase() !== 'scripttype' || key === 'ScriptType')
            .map(([key, value]) => {
            if (!/^[^:\r\n\0]+$/.test(key))
                throw new MediaForgeError('Invalid ASS script key', 'INPUT');
            return `${key}: ${lineValue(value, true)}`;
        }),
        '',
        format === 'ssa' ? '[V4 Styles]' : '[V4+ Styles]',
        `Format: ${styleFormat.join(', ')}`,
    ];
    for (const style of styles)
        output.push(`Style: ${styleFormat.map(name => lineValue(field(style, name) ?? '0')).join(',')}`);
    output.push('', '[Events]', `Format: ${eventFormat.join(', ')}`);
    for (const comment of data?.comments ?? [])
        output.push(`Comment: ${lineValue(comment, true)}`);
    let bytes = output.join('\n').length;
    const maxBytes = subtitleLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    for (const cue of document.cues) {
        validateSubtitleCue(cue);
        const start = Math.round(cue.startTime * 100);
        const end = Math.round(cue.endTime * 100);
        if (end <= start)
            throw new MediaForgeError('Cue is too short for ASS centisecond timestamps', 'INPUT');
        if (Math.abs(start / 100 - cue.startTime) > 1e-9 || Math.abs(end / 100 - cue.endTime) > 1e-9) {
            context.recover({ code: 'ASS_TIME_PRECISION', message: 'Cue times rounded to ASS centiseconds', format });
        }
        if (cue.id)
            context.recover({ code: 'SUBTITLE_ID_LOSS', message: 'ASS does not preserve cue identifiers', format });
        let text;
        if (cue.ass?.text === cue.text)
            text = cue.ass.rawText;
        else {
            const plainText = subtitleTextForFormat(document, cue, format, context);
            if (cue.ass)
                context.recover({
                    code: 'ASS_OVERRIDE_LOSS',
                    message: 'Edited cue text replaces its ASS override tags',
                    format,
                });
            if (/[{}]|\\[Nnh]/.test(plainText))
                throw new MediaForgeError('Plain text contains reserved ASS braces or escapes; supply explicit ass.rawText', 'INPUT');
            text = plainText
                .replace(/\r\n?/g, '\n')
                .replace(/\n/g, '\\N')
                .replace(/\u00a0/g, '\\h');
        }
        const line = `Dialogue: ${eventFormat
            .map(name => {
            switch (name.toLowerCase()) {
                case 'start':
                    return formatAssTimestamp(cue.startTime);
                case 'end':
                    return formatAssTimestamp(cue.endTime);
                case 'text':
                    return lineValue(text, true);
                default:
                    return lineValue((sameVariant ? field(cue.ass?.fields ?? {}, name) : undefined) ??
                        {
                            style: 'Default',
                            marked: 'Marked=0',
                            layer: '0',
                            marginl: '0',
                            marginr: '0',
                            marginv: '0',
                        }[name.toLowerCase()] ??
                        '');
            }
        })
            .join(',')}`;
        bytes += line.length + 1;
        if (bytes > maxBytes)
            throw new MediaForgeError('ASS output exceeds maxBytes', 'INPUT');
        output.push(line);
    }
    return checkSubtitleOutput(output.join('\n') + '\n', options);
}
