import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { validateSubtitleCue } from './subtitles';
import { positiveLimit } from '../../core/errors/limits';
import {
    checkSubtitleOutput,
    decodeSubtitleInput,
    subtitleDocument,
    subtitleTextForFormat,
    warnSubtitleConversion,
} from './interchange-utils';
import { parseXml, XML_NS, xmlEscape, type XmlNode } from '../shared/xml';
import type { SubtitleCue, SubtitleDocument, SubtitleOptions, TtmlSpan } from './types';
import { snapshotSubtitleOptions } from './options';

const TTML_NS = 'http://www.w3.org/ns/ttml';
const TTML_OLD_NS = 'http://www.w3.org/2006/10/ttaf1';

export interface TtmlTimingParameters {
    frameRate?: number;
    frameRateMultiplier?: number;
    subFrameRate?: number;
    tickRate?: number;
}

function timingParameters(input: TtmlTimingParameters): Required<TtmlTimingParameters> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new MediaForgeError('Expected TTML timing parameters', 'INPUT');
    const {
        frameRate: frames,
        frameRateMultiplier: multiplier,
        subFrameRate: subframes,
        tickRate: ticks,
    } = input;

    const frameRate = frames ?? 30;
    const frameRateMultiplier = multiplier ?? 1;
    const subFrameRate = subframes ?? 1;
    const tickRate =
        ticks ?? (frames === undefined ? 1 : frameRate * frameRateMultiplier * subFrameRate);
    if (
        !Number.isSafeInteger(frameRate) ||
        frameRate <= 0 ||
        !Number.isSafeInteger(subFrameRate) ||
        subFrameRate <= 0 ||
        !Number.isFinite(frameRateMultiplier) ||
        frameRateMultiplier <= 0 ||
        !Number.isFinite(tickRate) ||
        tickRate <= 0
    ) {
        throw new MediaForgeError('Invalid TTML timing parameters', 'INPUT');
    }

    return { frameRate, frameRateMultiplier, subFrameRate, tickRate };
}

/** Media time base only. Returns seconds, or null for an unsupported expression. */
export function parseTtmlTimestamp(
    value: string,
    parameters: TtmlTimingParameters = {},
): number | null {
    if (typeof value !== 'string')
        throw new MediaForgeError('Expected a TTML timestamp string', 'INPUT');
    const rates = timingParameters(parameters);
    const clock = /^(\d{2,}):([0-5]\d):([0-5]\d)(?:\.(\d+)|:(\d{2,})(?:\.(\d+))?)?$/.exec(
        value.trim(),
    );
    const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(value.trim());
    let seconds: number;
    if (clock) {
        const frames = Number(clock[5] ?? 0);
        const subframes = Number(clock[6] ?? 0);
        if (frames >= rates.frameRate || subframes >= rates.subFrameRate) return null;
        seconds =
            +clock[1]! * 3600 +
            +clock[2]! * 60 +
            +clock[3]! +
            Number(`0.${clock[4] ?? '0'}`) +
            (frames + subframes / rates.subFrameRate) /
                (rates.frameRate * rates.frameRateMultiplier);
    } else if (offset) {
        const units: Record<string, number> = {
            h: 3600,
            m: 60,
            s: 1,
            ms: 0.001,
            f: 1 / (rates.frameRate * rates.frameRateMultiplier),
            t: 1 / rates.tickRate,
        };
        seconds = +offset[1]! * units[offset[2]!]!;
    } else return null;

    return Number.isFinite(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds : null;
}

function attribute(node: XmlNode, name: string, namespace = ''): string | undefined {
    return node.attributes[`${namespace}|${name}`];
}

function isTtml(node: XmlNode): boolean {
    return node.namespace === TTML_NS || node.namespace === TTML_OLD_NS || node.namespace === '';
}

function properties(node: XmlNode, suffix: '#styling' | '#parameter'): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(node.attributes)) {
        if (key.startsWith(`${TTML_NS}${suffix}|`) || key.startsWith(`${TTML_OLD_NS}${suffix}|`))
            result[key.slice(key.indexOf('|') + 1)] = value;
    }
    return result;
}

const INHERITED = new Set([
    'color',
    'direction',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'lineHeight',
    'textAlign',
    'textDecoration',
    'textOutline',
    'visibility',
    'wrapOption',
    'writingMode',
]);

function inherited(style: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(style).filter(([key]) => INHERITED.has(key)));
}

export function parseTtml(
    input: string | Uint8Array,
    options: SubtitleOptions = {},
): SubtitleDocument {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const source = decodeSubtitleInput(input, options, context, 'ttml');
    const root = parseXml(source, options);
    if (root.name !== 'tt' || !isTtml(root))
        throw new DemuxError('Expected a TTML tt document element');
    if (!root.namespace)
        context.recover({
            code: 'TTML_NAMESPACE',
            message: 'TTML namespace is missing',
            format: 'ttml',
        });

    const parameters = properties(root, '#parameter');
    if (parameters.timeBase && parameters.timeBase !== 'media')
        throw new MediaForgeError('Only the TTML media time base is supported', 'FORMAT');
    const multiplier = parameters.frameRateMultiplier?.trim().split(/\s+/);
    if (
        multiplier &&
        (multiplier.length !== 2 || multiplier.some(value => !/^\d+$/.test(value) || +value <= 0))
    ) {
        throw new DemuxError('Invalid TTML frameRateMultiplier');
    }

    for (const key of ['frameRate', 'subFrameRate', 'tickRate']) {
        if (
            parameters[key] !== undefined &&
            (!/^\d+$/.test(parameters[key]!) || +parameters[key]! <= 0)
        ) {
            throw new DemuxError(`Invalid TTML ${key}`);
        }
    }

    const rates = timingParameters({
        frameRate: parameters.frameRate === undefined ? undefined : Number(parameters.frameRate),
        frameRateMultiplier: multiplier ? +multiplier[0]! / +multiplier[1]! : undefined,
        subFrameRate:
            parameters.subFrameRate === undefined ? undefined : Number(parameters.subFrameRate),
        tickRate: parameters.tickRate === undefined ? undefined : Number(parameters.tickRate),
    });

    const document: SubtitleDocument = {
        format: 'ttml',
        cues: [],
        diagnostics: [],
        ttml: {
            styles: Object.create(null),
            regions: Object.create(null),
            parameters,
            language: attribute(root, 'lang', XML_NS),
        },
    };

    const data = document.ttml!;
    const warn = (code: string, message: string): void =>
        context.recover({ code, message, format: 'ttml' });
    const styleNodes = new Map<string, XmlNode>();
    const regionNodes = new Map<string, XmlNode>();
    let blocks = 0;
    const maxBlocks = positiveLimit(options.maxBlocks, 200000, 'maxBlocks');
    const maxCues = positiveLimit(options.maxCues, 100000, 'maxCues');
    const inspect = (node: XmlNode): void => {
        if (++blocks > maxBlocks) throw new MediaForgeError('TTML input exceeds maxBlocks', 'OOM');
        if (
            !isTtml(node) ||
            ![
                'tt',
                'head',
                'styling',
                'style',
                'layout',
                'region',
                'body',
                'div',
                'p',
                'span',
                'br',
            ].includes(node.name)
        ) {
            warn(
                'TTML_ELEMENT_LOSS',
                `Unsupported ${node.name} element is omitted from the text subset`,
            );
            return;
        }

        const whitespace = attribute(node, 'space', XML_NS);
        const container = attribute(node, 'timeContainer');
        if (whitespace !== undefined && whitespace !== 'default' && whitespace !== 'preserve') {
            throw new DemuxError('Invalid TTML xml:space');
        }

        if (container !== undefined && container !== 'par' && container !== 'seq') {
            throw new DemuxError('Invalid TTML timeContainer');
        }

        if (node.name === 'style' || node.name === 'region') {
            const id = attribute(node, 'id', XML_NS);
            if (!id) warn('TTML_ID', `${node.name} without xml:id was omitted`);
            else {
                const map = node.name === 'style' ? styleNodes : regionNodes;
                if (map.has(id)) warn('TTML_ID', `Duplicate ${node.name} identifier was replaced`);
                map.set(id, node);
            }
        }

        for (const key of Object.keys(node.attributes)) {
            const [uri, local] = key.split('|');
            if (uri === `${TTML_NS}#styling` || uri === `${TTML_OLD_NS}#styling`) {
                if (/ruby|backgroundImage|textEmphasis|shear/.test(local!))
                    warn(
                        'TTML_PRESENTATION',
                        `${local} is retained as metadata without presentation processing`,
                    );
            } else if (uri === `${TTML_NS}#parameter` || uri === `${TTML_OLD_NS}#parameter`) {
                if (node !== root)
                    warn('TTML_ATTRIBUTE_LOSS', `Non-root parameter ${local} omitted`);
            } else if (
                !(uri === XML_NS && ['id', 'lang', 'space'].includes(local!)) &&
                !(
                    uri === '' &&
                    ['begin', 'end', 'dur', 'style', 'region', 'timeContainer'].includes(local!)
                )
            ) {
                warn('TTML_ATTRIBUTE_LOSS', `Unsupported attribute ${local} omitted`);
            }
        }

        for (const child of node.children) if (typeof child !== 'string') inspect(child);
    };

    inspect(root);
    const resolving = new Set<string>();
    const resolveStyle = (id: string): Record<string, string> => {
        if (data.styles[id]) return data.styles[id]!;
        if (resolving.has(id) || resolving.size >= 64) {
            warn('TTML_STYLE_REFERENCE', 'Cyclic or excessively deep style reference was omitted');
            return {};
        }

        const node = styleNodes.get(id);
        if (!node) {
            warn('TTML_STYLE_REFERENCE', `Unknown style reference ${id} omitted`);
            return {};
        }

        resolving.add(id);
        const result = resolveNodeStyle(node, {});
        resolving.delete(id);
        data.styles[id] = result;
        return result;
    };

    const resolveNodeStyle = (
        node: XmlNode,
        parent: Record<string, string>,
    ): Record<string, string> => {
        const style = inherited(parent);
        const local: Record<string, string> = {};
        for (const id of (attribute(node, 'style') ?? '').split(/\s+/).filter(Boolean))
            Object.assign(local, resolveStyle(id));
        Object.assign(local, properties(node, '#styling'));
        for (const key of ['fontSize', 'lineHeight']) {
            if (parent[key] && local[key] && /%|em|\binherit\b/.test(local[key]!)) {
                warn(
                    'TTML_RELATIVE_STYLE',
                    `Nested relative ${key} is retained without computing layout-dependent values`,
                );
            }
        }

        const nestedSpan =
            node.name === 'span' &&
            node.children.some(child => typeof child !== 'string' && child.name === 'span');
        if (
            (node.name === 'body' || node.name === 'div' || nestedSpan) &&
            Object.keys(local).some(key => !INHERITED.has(key))
        ) {
            warn(
                'TTML_CONTAINER_STYLE_LOSS',
                'Noninherited container styling may be omitted when flattening text',
            );
        }

        Object.assign(style, local);
        if (Object.keys(style).length > 128)
            throw new MediaForgeError('TTML style exceeds 128 properties', 'OOM');
        return style;
    };

    for (const id of styleNodes.keys()) resolveStyle(id);
    for (const [id, node] of regionNodes) {
        data.regions[id] = resolveNodeStyle(node, {});
        if (['begin', 'end', 'dur'].some(key => attribute(node, key) !== undefined))
            warn('TTML_REGION_TIMING', 'Region timing is omitted');
    }

    const rootStyle = properties(root, '#styling');
    if (Object.keys(rootStyle).length) data.rootStyle = rootStyle;
    const paragraph = (
        node: XmlNode,
        style: Record<string, string>,
        space: string,
        language?: string,
    ): TtmlSpan[] => {
        const spans: Array<TtmlSpan & { preserve: boolean }> = [];
        const append = (
            text: string,
            currentStyle: Record<string, string>,
            preserve: boolean,
            lang?: string,
            region?: string,
        ): void => {
            if (!preserve) {
                text = text.replace(/[\t\r\n ]+/g, ' ');
                const previous = spans[spans.length - 1]?.text ?? '';
                if (!previous || /[ \n]$/.test(previous)) text = text.replace(/^ /, '');
            }
            if (text) spans.push({ text, style: currentStyle, language: lang, region, preserve });
        };

        const trimEnd = (): void => {
            const last = spans[spans.length - 1];
            if (last && !last.preserve) {
                last.text = last.text.replace(/ +$/, '');
                if (!last.text) spans.pop();
            }
        };

        const visit = (
            element: XmlNode,
            currentStyle: Record<string, string>,
            whitespace: string,
            lang?: string,
            region?: string,
        ): void => {
            for (const child of element.children) {
                if (typeof child === 'string')
                    append(child, currentStyle, whitespace === 'preserve', lang, region);
                else if (isTtml(child) && child.name === 'br') {
                    trimEnd();
                    spans.push({
                        text: '\n',
                        style: currentStyle,
                        language: lang,
                        region,
                        preserve: true,
                    });
                } else if (isTtml(child) && child.name === 'span') {
                    if (
                        ['begin', 'end', 'dur', 'timeContainer'].some(
                            key => attribute(child, key) !== undefined,
                        )
                    ) {
                        warn(
                            'TTML_SPAN_TIMING',
                            'Timed spans were flattened to their containing cue interval',
                        );
                    }

                    const childRegion = attribute(child, 'region') ?? region;
                    if (childRegion && !data.regions[childRegion])
                        warn('TTML_REGION_REFERENCE', `Unknown region reference ${childRegion}`);
                    visit(
                        child,
                        resolveNodeStyle(child, currentStyle),
                        attribute(child, 'space', XML_NS) ?? whitespace,
                        attribute(child, 'lang', XML_NS) ?? lang,
                        childRegion,
                    );
                }
            }
        };

        visit(node, style, space, language);
        trimEnd();
        return spans.map(({ preserve: _, ...span }) => span);
    };

    const walk = (
        node: XmlNode,
        sync: number,
        parentEnd: number,
        parentStyle: Record<string, string>,
        parentSpace: string,
        parentRegion?: string,
        parentLanguage?: string,
    ): number => {
        if (!isTtml(node) || !['body', 'div', 'p'].includes(node.name)) return sync;
        const time = (key: string, fallback: number): number => {
            const value = attribute(node, key);
            if (value === undefined) return fallback;
            const parsed = parseTtmlTimestamp(value, rates);
            if (parsed === null) throw new DemuxError(`Invalid TTML ${key}: ${value}`);
            return parsed;
        };

        const start = sync + time('begin', 0);
        const end = Math.min(
            parentEnd,
            sync + time('end', Infinity),
            start + time('dur', Infinity),
        );

        if (!Number.isFinite(start)) {
            warn('TTML_TIMING', 'Cue after an indefinite sequential interval was omitted');
            return end;
        }

        const style = resolveNodeStyle(node, parentStyle);
        const space = attribute(node, 'space', XML_NS) ?? parentSpace;
        if (space !== 'default' && space !== 'preserve')
            throw new DemuxError('Invalid TTML xml:space');
        const region = attribute(node, 'region') ?? parentRegion;
        const language = attribute(node, 'lang', XML_NS) ?? parentLanguage;
        if (region && !data.regions[region])
            warn('TTML_REGION_REFERENCE', `Unknown region reference ${region}`);
        if (node.name === 'p') {
            if (!Number.isFinite(end) || end <= start) {
                warn('TTML_CUE_TIMING', 'Paragraph without a finite positive interval was omitted');
                return end;
            }

            if (document.cues.length >= maxCues)
                throw new MediaForgeError('TTML input exceeds maxCues', 'OOM');
            if (attribute(node, 'timeContainer') === 'seq')
                warn(
                    'TTML_SPAN_TIMING',
                    'Sequential paragraph content was flattened to the cue interval',
                );

            const spans = paragraph(node, style, space, language);
            const text = spans.map(span => span.text).join('');
            const cue: SubtitleCue = {
                startTime: start,
                endTime: end,
                text,
                ttml: { text, style, region, language, spans },
            };

            const id = attribute(node, 'id', XML_NS);
            if (id) cue.id = id;
            document.cues.push(cue);
            return end;
        }

        const container = attribute(node, 'timeContainer') ?? 'par';
        if (container !== 'par' && container !== 'seq')
            throw new DemuxError('Invalid TTML timeContainer');
        let extent = start;
        for (const child of node.children) {
            if (typeof child === 'string') continue;
            const childEnd = walk(
                child,
                container === 'seq' ? extent : start,
                end,
                style,
                space,
                region,
                language,
            );
            extent = Math.max(extent, childEnd);
        }

        return attribute(node, 'end') !== undefined || attribute(node, 'dur') !== undefined
            ? end
            : Math.min(end, extent);
    };

    for (const child of root.children)
        if (typeof child !== 'string' && child.name === 'body') {
            walk(
                child,
                0,
                Infinity,
                rootStyle,
                attribute(root, 'space', XML_NS) ?? 'default',
                undefined,
                data.language,
            );
        }

    document.diagnostics = context.warnings;
    return document;
}

function styleAttributes(style: Record<string, string> | undefined): string {
    return Object.entries(style ?? {})
        .map(([key, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
                throw new MediaForgeError('Invalid TTML style property name', 'INPUT');
            return ` tts:${key}="${xmlEscape(value)}"`;
        })
        .join('');
}

function xmlId(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
        throw new MediaForgeError('TTML output identifiers must be XML NCNames', 'INPUT');
    return xmlEscape(value);
}

export function writeTtml(
    input: SubtitleDocument | readonly SubtitleCue[],
    options: SubtitleOptions = {},
): string {
    options = snapshotSubtitleOptions(options);
    const context = new DiagnosticContext(options, 'compatible');
    const document = subtitleDocument(input, 'ttml');
    warnSubtitleConversion(document, 'ttml', context);
    if (document.cues.length > positiveLimit(options.maxCues, 100000, 'maxCues'))
        throw new MediaForgeError('TTML output exceeds maxCues', 'OOM');
    const data = document.ttml;
    const maxBlocks = positiveLimit(options.maxBlocks, 200000, 'maxBlocks');
    const maxNodes = positiveLimit(options.maxNodes, 200000, 'maxNodes');
    let count = 0;
    const output: string[] = [];
    let bytes = 0;
    const maximum = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const append = (text: string): void => {
        bytes += text.length;
        if (bytes > maximum) throw new MediaForgeError('TTML output exceeds maxBytes', 'OOM');
        if (++count > maxBlocks || count > maxNodes)
            throw new MediaForgeError('TTML output exceeds block or node limit', 'OOM');
        output.push(text);
    };

    const params = Object.entries(data?.parameters ?? {})
        .filter(([key]) => ['cellResolution', 'pixelAspectRatio'].includes(key))
        .map(([key, value]) => ` ttp:${key}="${xmlEscape(value)}"`)
        .join('');
    if (
        data?.parameters.profile ||
        data?.parameters.contentProfiles ||
        data?.parameters.processorProfiles
    ) {
        context.recover({
            code: 'TTML_PROFILE_LOSS',
            message: 'Profile declarations omitted because the output is a TTML text subset',
            format: 'ttml',
        });
    }

    const rootStyle = styleAttributes(data?.rootStyle);
    append(
        `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="${TTML_NS}" ` +
            `xmlns:tts="${TTML_NS}#styling" xmlns:ttp="${TTML_NS}#parameter" ` +
            `xml:lang="${xmlEscape(data?.language ?? '')}" ` +
            `xml:space="preserve"${params}${rootStyle}>\n<head>\n<styling>\n`,
    );
    const ids = new Set<string>();
    const identifier = (value: string): string => {
        if (ids.has(value)) throw new MediaForgeError('Duplicate TTML output identifier', 'INPUT');
        ids.add(value);
        return xmlId(value);
    };

    for (const [id, style] of Object.entries(data?.styles ?? {}))
        append(`<style xml:id="${identifier(id)}"${styleAttributes(style)}/>\n`);
    append('</styling>\n<layout>\n');
    for (const [id, style] of Object.entries(data?.regions ?? {}))
        append(`<region xml:id="${identifier(id)}"${styleAttributes(style)}/>\n`);
    append('</layout>\n</head>\n<body><div>\n');
    const sourceIds = new Set(document.cues.map(cue => cue.id));
    let cueSequence = 0;
    for (const cue of document.cues) {
        validateSubtitleCue(cue);
        const metadata = cue.ttml;
        let cueId = cue.id;
        if (cueId && (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(cueId) || ids.has(cueId))) {
            context.recover({
                code: 'SUBTITLE_ID_LOSS',
                message: 'Cue identifier was replaced with a unique XML NCName',
                format: 'ttml',
            });
            do {
                cueId = `cue_${++cueSequence}`;
            } while (ids.has(cueId) || sourceIds.has(cueId));
        }

        const id = cueId ? ` xml:id="${identifier(cueId)}"` : '';
        const region = metadata?.region ? ` region="${xmlId(metadata.region)}"` : '';
        const language =
            metadata?.language === undefined ? '' : ` xml:lang="${xmlEscape(metadata.language)}"`;
        const timestamp = (value: number): string => {
            if (value > Number.MAX_SAFE_INTEGER / 1000)
                throw new MediaForgeError('TTML timestamp is too large', 'INPUT');
            return value.toFixed(9).replace(/\.?0+$/, '') || '0';
        };

        // A cue shorter than the nanosecond times lasts one nanosecond; strict validation refuses
        // it.
        let end = cue.endTime;
        if (Math.round(end * 1e9) <= Math.round(cue.startTime * 1e9)) {
            if (context.validation === 'strict')
                throw new MediaForgeError(
                    'TTML cue duration is below nanosecond precision',
                    'INPUT',
                );
            context.warn({
                code: 'CUE_LENGTHENED',
                message: 'Cue shorter than 1 ns lasts 1 ns',
                format: 'ttml',
            });
            end = (Math.round(cue.startTime * 1e9) + 1) / 1e9;
        }
        const style = styleAttributes(metadata?.style);
        const times = `begin="${timestamp(cue.startTime)}s" end="${timestamp(end)}s"`;
        append(`<p ${times}${id}${region}${language}${style}>`);
        if (metadata && metadata.text !== cue.text)
            context.recover({
                code: 'TTML_SPAN_STYLE_LOSS',
                message: 'Edited cue text replaces its TTML span styling',
                format: 'ttml',
            });

        const cueText = subtitleTextForFormat(document, cue, 'ttml', context);
        const spans = metadata?.text === cue.text ? metadata.spans : [{ text: cueText }];
        if (spans.length > maxNodes) throw new MediaForgeError('TTML spans exceed maxNodes', 'OOM');
        if (spans.map(span => span.text).join('') !== cueText)
            throw new MediaForgeError('TTML spans do not match cue text', 'INPUT');
        for (const span of spans) {
            const text = xmlEscape(span.text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br/>');
            const style = styleAttributes(
                Object.fromEntries(
                    Object.entries(span.style ?? {}).filter(
                        ([key, value]) => metadata?.style?.[key] !== value,
                    ),
                ),
            );

            const lang =
                span.language === undefined ? '' : ` xml:lang="${xmlEscape(span.language)}"`;
            const region = span.region === undefined ? '' : ` region="${xmlId(span.region)}"`;
            append(style || lang || region ? `<span${style}${lang}${region}>${text}</span>` : text);
        }

        append('</p>\n');
    }

    append('</div></body>\n</tt>\n');
    const result = checkSubtitleOutput(output.join(''), options);
    parseXml(result, options);
    return result;
}
