import { MediaForgeError } from '../../core/errors/errors';
import { copyOutputBytes, outputByteLength } from '../../core/bytes/output-data';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import { positiveLimit } from '../../core/errors/limits';
import type { SubtitleCue, SubtitleDocument, SubtitleFormat, SubtitleOptions } from './types';

const encoder = new TextEncoder();

export function decodeSubtitleInput(
    input: string | Uint8Array,
    options: SubtitleOptions,
    context: DiagnosticContext,
    format: string,
    encoding = 'utf-8',
): string {
    const limit = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const length = typeof input === 'string' ? input.length : outputByteLength(input);
    if (length > limit || (typeof input === 'string' && encoder.encode(input).length > limit)) {
        throw new MediaForgeError('Subtitle input exceeds maxBytes', 'OOM');
    }

    let text: string;
    if (typeof input === 'string') text = input;
    else {
        input = copyOutputBytes(input);
        if (input[0] === 0xff && input[1] === 0xfe) encoding = 'utf-16le';
        else if (input[0] === 0xfe && input[1] === 0xff) encoding = 'utf-16be';
        else if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) encoding = 'utf-8';
        else if (input[0] === 0x3c && input[1] === 0 && input[3] === 0) encoding = 'utf-16le';
        else if (input[0] === 0 && input[1] === 0x3c && input[2] === 0) encoding = 'utf-16be';
        else if (
            (format === 'ttml' || format === 'subtitle') &&
            input[0] === 0x3c &&
            input[1] === 0x3f
        ) {
            const declaration = new TextDecoder('ascii').decode(input.subarray(0, 512));
            const label = /^<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/.exec(declaration)?.[1];
            if (label) encoding = label;
        }

        let decoder: TextDecoder;
        try {
            decoder = new TextDecoder(encoding, { fatal: true });
        } catch {
            throw new MediaForgeError(`Unsupported subtitle encoding: ${encoding}`, 'INPUT');
        }

        try {
            text = decoder.decode(input);
        } catch {
            context.recover({
                code: 'TEXT_ENCODING',
                message: 'Invalid encoded subtitle text was replaced',
                format,
            });
            text = new TextDecoder(encoding).decode(input);
        }
    }

    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (text.includes('\0')) {
        context.recover({ code: 'TEXT_NUL', message: 'NUL characters were replaced', format });
        text = text.replace(/\0/g, '\uFFFD');
    }

    return text;
}

export function subtitleDocument(
    input: SubtitleDocument | readonly SubtitleCue[],
    format: SubtitleFormat,
): SubtitleDocument {
    return Array.isArray(input)
        ? { format, cues: input, diagnostics: [] }
        : (input as SubtitleDocument);
}

export function checkSubtitleOutput(text: string, options: SubtitleOptions): string {
    const limit = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    if (text.length > limit || encoder.encode(text).length > limit)
        throw new MediaForgeError('Subtitle output exceeds maxBytes', 'OOM');
    return text;
}

export function warnSubtitleConversion(
    document: SubtitleDocument,
    target: SubtitleFormat,
    context: DiagnosticContext,
): void {
    const assTarget = target === 'ass' || target === 'ssa';
    if (
        (!assTarget && (document.ass || document.cues.some(cue => cue.ass))) ||
        (target !== 'ttml' && (document.ttml || document.cues.some(cue => cue.ttml)))
    ) {
        context.recover({
            code: 'SUBTITLE_STYLE_LOSS',
            message: `Source styling and layout metadata cannot be represented in ${target}`,
            format: target,
        });
    }
    if (target === 'ttml' || assTarget) {
        if (
            document.header ||
            document.headers?.length ||
            document.timestampMap ||
            document.blocks?.some(block => block.type !== 'cue')
        ) {
            context.recover({
                code: 'SUBTITLE_METADATA_LOSS',
                message: `Source headers and blocks cannot be represented in ${target}`,
                format: target,
            });
        }
        if (document.cues.some(cue => cue.settings)) {
            context.recover({
                code: 'SUBTITLE_SETTINGS_LOSS',
                message: `Cue settings cannot be represented in ${target}`,
                format: target,
            });
        }
    }
}

export function escapeSubtitleMarkup(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function subtitleTextForFormat(
    document: SubtitleDocument,
    cue: SubtitleCue,
    target: SubtitleFormat,
    context: DiagnosticContext,
): string {
    const sourceMarkup = document.format === 'webvtt' || document.format === 'srt';
    const targetMarkup = target === 'webvtt' || target === 'srt';
    if (!sourceMarkup && targetMarkup) return escapeSubtitleMarkup(cue.text);
    if (!sourceMarkup || targetMarkup) return cue.text;
    let text = cue.text;
    if (/<[^>]*>/.test(text)) {
        context.recover({
            code: 'SUBTITLE_MARKUP_LOSS',
            message: `Inline source markup was reduced to plain text for ${target}`,
            format: target,
        });
        text = text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '');
    }

    const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: '\u00a0',
        lrm: '\u200e',
        rlm: '\u200f',
    };

    return text.replace(/&([A-Za-z]+|#\d+|#x[0-9a-fA-F]+);/g, (raw, name: string) => {
        if (Object.prototype.hasOwnProperty.call(named, name)) return named[name]!;
        if (!name.startsWith('#')) return raw;
        const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
            ? String.fromCodePoint(code)
            : '\uFFFD';
    });
}
