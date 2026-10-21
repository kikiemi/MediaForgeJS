import { DiagnosticContext } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { positiveLimit } from '../../core/errors/limits';
import type { SubtitleBlock, SubtitleCue, SubtitleDocument, SubtitleOptions } from './types';
import {
    decodeSubtitleInput,
    subtitleTextForFormat,
    warnSubtitleConversion,
} from './interchange-utils';
import { snapshotSubtitleOptions } from './options';

const encoder = new TextEncoder();

export function parseSubtitleTimestamp(value: string): number | null {
    const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
    if (!match || +match[2]! > 59 || +match[3]! > 59) return null;
    const millis = ((+(match[1] ?? 0) * 60 + +match[2]!) * 60 + +match[3]!) * 1000 + +match[4]!;
    return Number.isSafeInteger(millis) ? millis / 1000 : null;
}

export function formatSubtitleTimestamp(
    seconds: number,
    format: 'webvtt' | 'srt' = 'webvtt',
): string {
    const millis = Math.round(seconds * 1000);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(millis)) {
        throw new MediaForgeError('Subtitle timestamp must be a finite nonnegative time', 'INPUT');
    }
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    const hours = pad(Math.floor(millis / 3600000));
    const minutes = pad(Math.floor(millis / 60000) % 60);
    const wholeSeconds = pad(Math.floor(millis / 1000) % 60);
    const separator = format === 'srt' ? ',' : '.';
    return `${hours}:${minutes}:${wholeSeconds}${separator}${pad(millis % 1000, 3)}`;
}

function parse(
    input: string | Uint8Array,
    format: 'webvtt' | 'srt',
    options: SubtitleOptions,
): SubtitleDocument {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const maxCues = positiveLimit(options.maxCues, 100000, 'maxCues');
    const maxBlocks = positiveLimit(options.maxBlocks, 200000, 'maxBlocks');
    const source = decodeSubtitleInput(input, options, context, format);
    const lines = source.split('\n');
    const document: SubtitleDocument = { format, cues: [], blocks: [], diagnostics: [] };
    let index = 0;
    if (format === 'webvtt') {
        const signature = /^WEBVTT(?:[ \t](.*))?$/.exec(lines[0] ?? '');
        if (!signature || lines[0]!.includes('-->')) {
            context.recover({
                code: 'VTT_SIGNATURE',
                message: 'WebVTT signature is missing or invalid',
                format,
            });
        } else {
            document.header = signature[1] ?? '';
            index++;
            document.headers = [];
            while (index < lines.length && lines[index] !== '') {
                const line = lines[index]!;
                if (line.includes('-->')) {
                    context.recover({
                        code: 'VTT_HEADER_SEPARATOR',
                        message: 'Missing blank line after WebVTT header',
                        format,
                    });
                    break;
                }

                document.headers.push(line);
                if (line.startsWith('X-TIMESTAMP-MAP=')) {
                    const local = /(?:^|,)LOCAL:([^,]+)/.exec(line.slice(16));
                    const mpeg = /(?:^|,)MPEGTS:(\d+)(?:,|$)/.exec(line.slice(16));
                    const localTime = local ? parseSubtitleTimestamp(local[1]!) : null;
                    const mpegTimestamp = mpeg ? Number(mpeg[1]) : NaN;
                    if (
                        localTime !== null &&
                        Number.isSafeInteger(mpegTimestamp) &&
                        mpegTimestamp < 2 ** 33
                    ) {
                        document.timestampMap = { localTime, mpegTimestamp };
                    } else {
                        context.recover({
                            code: 'VTT_TIMESTAMP_MAP',
                            message: 'Invalid timestamp map retained as header text',
                            format,
                        });
                    }
                }

                index++;
            }
        }
    }

    let previousStart = -1;
    while (index < lines.length) {
        if (lines[index] === '') {
            index++;
            continue;
        }

        if (document.blocks!.length >= maxBlocks)
            throw new MediaForgeError('Subtitle input exceeds maxBlocks', 'OOM');
        const firstLine = index;
        const block: string[] = [];
        while (index < lines.length && lines[index] !== '') block.push(lines[index++]!);
        const raw = block.join('\n');
        if (format === 'webvtt' && /^NOTE(?:[ \t]|$)/.test(block[0]!)) {
            document.blocks!.push({ type: 'note', text: raw });
            continue;
        }

        if (
            format === 'webvtt' &&
            (block[0] === 'STYLE' || block[0] === 'REGION') &&
            !block[1]?.includes('-->')
        ) {
            const type = block[0] === 'STYLE' ? 'style' : 'region';
            if (document.cues.length || raw.includes('-->')) {
                context.recover({
                    code: 'VTT_BLOCK_POSITION',
                    message: `${block[0]} block is not valid at line ${firstLine + 1}`,
                    format,
                });
                document.blocks!.push({ type: 'unknown', text: raw });
            } else document.blocks!.push({ type, text: raw });
            continue;
        }

        const timingIndex = block[0]!.includes('-->') ? 0 : 1;
        const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(block[timingIndex] ?? '');
        const startTime = timing ? parseSubtitleTimestamp(timing[1]!) : null;
        const endTime = timing ? parseSubtitleTimestamp(timing[2]!) : null;
        if (startTime === null || endTime === null || endTime <= startTime) {
            context.recover({
                code: 'SUBTITLE_CUE',
                message: `Malformed cue at line ${firstLine + 1} retained as raw text`,
                format,
            });
            document.blocks!.push({ type: 'unknown', text: raw });
            continue;
        }

        if (format === 'webvtt' && (timing![1]!.includes(',') || timing![2]!.includes(','))) {
            context.recover({
                code: 'VTT_TIMESTAMP_SEPARATOR',
                message: 'Comma timestamps were accepted as milliseconds',
                format,
            });
        }

        if (startTime < previousStart)
            context.recover({
                code: 'SUBTITLE_ORDER',
                message: 'Cue starts are out of order; source order retained',
                format,
            });

        previousStart = startTime;
        if (document.cues.length >= maxCues)
            throw new MediaForgeError('Subtitle input exceeds maxCues', 'OOM');
        const cue: SubtitleCue = {
            startTime,
            endTime,
            text: block.slice(timingIndex + 1).join('\n'),
        };

        if (timingIndex) cue.id = block[0];
        if (timing![3]) cue.settings = timing![3];
        document.blocks!.push({ type: 'cue', cueIndex: document.cues.length });
        document.cues.push(cue);
    }

    document.diagnostics = context.warnings;
    return document;
}

export function parseWebVtt(
    input: string | Uint8Array,
    options: SubtitleOptions = {},
): SubtitleDocument {
    return parse(input, 'webvtt', options);
}

export function parseSrt(
    input: string | Uint8Array,
    options: SubtitleOptions = {},
): SubtitleDocument {
    return parse(input, 'srt', options);
}

export function validateSubtitleCue(cue: SubtitleCue): void {
    if (
        !Number.isFinite(cue.startTime) ||
        cue.startTime < 0 ||
        !Number.isFinite(cue.endTime) ||
        cue.endTime <= cue.startTime ||
        typeof cue.text !== 'string'
    ) {
        throw new MediaForgeError('Invalid subtitle cue timing or text', 'INPUT');
    }
    if (
        cue.id !== undefined &&
        (typeof cue.id !== 'string' || /[\r\n\0]/.test(cue.id) || cue.id.includes('-->'))
    ) {
        throw new MediaForgeError('Invalid subtitle cue identifier', 'INPUT');
    }
    if (
        cue.settings !== undefined &&
        (typeof cue.settings !== 'string' || /[\r\n\0]/.test(cue.settings))
    ) {
        throw new MediaForgeError('Invalid subtitle cue settings', 'INPUT');
    }
}

function write(
    document: SubtitleDocument | readonly SubtitleCue[],
    format: 'webvtt' | 'srt',
    options: SubtitleOptions,
): string {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const doc: SubtitleDocument = Array.isArray(document)
        ? { format, cues: document, diagnostics: [] }
        : (document as SubtitleDocument);
    warnSubtitleConversion(doc, format, context);
    if (doc.cues.length > positiveLimit(options.maxCues, 100000, 'maxCues')) {
        throw new MediaForgeError('Subtitle output exceeds maxCues', 'OOM');
    }

    const blocks =
        doc.blocks ?? doc.cues.map((_, cueIndex) => ({ type: 'cue' as const, cueIndex }));
    if (blocks.length > positiveLimit(options.maxBlocks, 200000, 'maxBlocks')) {
        throw new MediaForgeError('Subtitle output exceeds maxBlocks', 'OOM');
    }

    const output: string[] = [];
    const maxBytes = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    let outputBytes = 0;
    const append = (value: string): void => {
        if (value.length > maxBytes - outputBytes)
            throw new MediaForgeError('Subtitle output exceeds maxBytes', 'OOM');
        outputBytes += encoder.encode(value).length + 2;
        if (outputBytes > maxBytes)
            throw new MediaForgeError('Subtitle output exceeds maxBytes', 'OOM');
        output.push(value);
    };

    if (format === 'webvtt') {
        if (/[\r\n\0]/.test(doc.header ?? '') || (doc.header ?? '').includes('-->')) {
            throw new MediaForgeError('Invalid WebVTT header', 'INPUT');
        }

        const headers = (doc.headers ?? []).filter(
            line => !doc.timestampMap || !line.startsWith('X-TIMESTAMP-MAP='),
        );
        if (headers.some(line => /[\r\n\0]/.test(line) || line.includes('-->'))) {
            throw new MediaForgeError('Invalid WebVTT header line', 'INPUT');
        }

        if (doc.timestampMap) {
            const map = doc.timestampMap;
            if (
                !Number.isInteger(map.mpegTimestamp) ||
                map.mpegTimestamp < 0 ||
                map.mpegTimestamp >= 2 ** 33
            ) {
                throw new MediaForgeError('MPEG timestamp must fit 33 bits', 'INPUT');
            }

            const local = formatSubtitleTimestamp(map.localTime);
            headers.push(`X-TIMESTAMP-MAP=LOCAL:${local},MPEGTS:${map.mpegTimestamp}`);
        }

        append([`WEBVTT${doc.header ? ` ${doc.header}` : ''}`, ...headers].join('\n'));
    } else if (doc.header || doc.headers?.length || doc.timestampMap) {
        context.recover({
            code: 'SUBTITLE_HEADER_LOSS',
            message: 'SRT cannot represent WebVTT headers or timestamp maps',
            format,
        });
    }

    const seen = new Set<number>();
    let sequence = 0;
    const emitCue = (cueIndex: number): void => {
        if (!Number.isInteger(cueIndex) || cueIndex < 0 || !doc.cues[cueIndex]) {
            throw new MediaForgeError('Subtitle block references an absent cue', 'INPUT');
        }

        if (seen.has(cueIndex)) return;
        seen.add(cueIndex);
        const cue = doc.cues[cueIndex]!;
        validateSubtitleCue(cue);
        const text = subtitleTextForFormat(doc, cue, format, context).replace(/\r\n?/g, '\n');
        if (text.includes('\n\n') || text.startsWith('\n') || text.includes('\0')) {
            throw new MediaForgeError(
                'Subtitle cue text contains a block separator or NUL',
                'INPUT',
            );
        }

        // A cue shorter than the millisecond timestamps lasts one millisecond; strict validation
        // refuses it.
        let end = cue.endTime;
        if (Math.round(end * 1000) <= Math.round(cue.startTime * 1000)) {
            if (context.validation === 'strict')
                throw new MediaForgeError(
                    'Cue duration is too short for millisecond subtitle timestamps',
                    'INPUT',
                );
            context.warn({
                code: 'CUE_LENGTHENED',
                message: 'Cue shorter than 1 ms lasts 1 ms',
                format,
            });
            end = (Math.round(cue.startTime * 1000) + 1) / 1000;
        }

        sequence++;
        let id = cue.id;
        if (format === 'webvtt' && id !== undefined && /^NOTE(?:[ \t]|$)/.test(id)) {
            context.metadata({
                code: 'SUBTITLE_ID_LOSS',
                message: 'Cue identifier was omitted because it starts a WebVTT NOTE block',
                format,
            });
            id = undefined;
        }

        if (format === 'srt' && (!id || !/^\d+$/.test(id))) {
            if (id)
                context.recover({
                    code: 'SUBTITLE_ID_LOSS',
                    message: 'SRT cue identifier was replaced with a numeric index',
                    format,
                });
            id = String(sequence);
        }

        if (format === 'srt' && doc.format !== 'srt' && cue.settings) {
            context.recover({
                code: 'SUBTITLE_SETTINGS_LOSS',
                message: 'SRT cannot represent WebVTT cue settings',
                format,
            });
        }

        const timing =
            `${formatSubtitleTimestamp(cue.startTime, format)} --> ` +
            `${formatSubtitleTimestamp(end, format)}` +
            ((format === 'webvtt' || doc.format === 'srt') && cue.settings
                ? ` ${cue.settings}`
                : '');

        append([...(id ? [id] : []), timing, text].join('\n'));
    };

    for (const block of blocks) {
        if (block.type === 'cue') emitCue(block.cueIndex);
        else if (format === doc.format) append(block.text);
        else if (format === 'webvtt' && block.type !== 'unknown') append(block.text);
        else
            context.recover({
                code: 'SUBTITLE_BLOCK_LOSS',
                message: `${block.type} block cannot be represented in ${format}`,
                format,
            });
    }

    for (let i = 0; i < doc.cues.length; i++) if (!seen.has(i)) emitCue(i);
    const result = output.join('\n\n') + '\n\n';
    if (encoder.encode(result).length > maxBytes) {
        throw new MediaForgeError('Subtitle output exceeds maxBytes', 'OOM');
    }

    return result;
}

export function writeWebVtt(
    document: SubtitleDocument | readonly SubtitleCue[],
    options: SubtitleOptions = {},
): string {
    return write(document, 'webvtt', options);
}

export function writeSrt(
    document: SubtitleDocument | readonly SubtitleCue[],
    options: SubtitleOptions = {},
): string {
    return write(document, 'srt', options);
}

export function makeWebVttCodecConfig(document?: SubtitleDocument): Uint8Array<ArrayBuffer> {
    const blocks: SubtitleBlock[] = (document?.blocks ?? []).filter(
        block => block.type === 'style' || block.type === 'region',
    );
    return encoder.encode(
        writeWebVtt({
            format: 'webvtt',
            cues: [],
            blocks,
            header: document?.header,
            diagnostics: [],
        }),
    );
}
