import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError } from '../../core/errors/errors';
import { parseXml, XML_NS } from '../shared/xml';
import type { XmlNode } from '../shared/xml';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import {
    DASH_NS,
    DASH_U64,
    dashAdd,
    dashCeil,
    dashCompare,
    dashDuration,
    dashExpand,
    dashInteger,
    dashInvalidArgument,
    dashLimit,
    dashMalformed,
    dashOverLimit,
    dashSeconds,
    dashSubtract,
    dashTemplate,
    dashUnsupported,
    dashUrl,
    registerDashRepresentation,
    type DashFraction,
} from './common';
import { resolveDashIndexes } from './indexed';
import type { DashPendingIndex } from './indexed';
import type {
    DashAdaptationSet,
    DashByteRange,
    DashManifest,
    DashParseOptions,
    DashPeriod,
    DashRepresentation,
    DashResolveOptions,
    DashResource,
    DashSegmentInfo,
    DashTimelineEntry,
} from './types';
import { typedArrayByteLength as byteLength } from '../../core/bytes/typed-array';

export type {
    DashAdaptationSet,
    DashByteRange,
    DashIndexRequest,
    DashIndexResource,
    DashManifest,
    DashParseOptions,
    DashPeriod,
    DashRepresentation,
    DashResolveOptions,
    DashResource,
    DashSegment,
    DashSegmentInfo,
    DashSegmentOptions,
    DashTimelineEntry,
} from './types';

interface Addressing {
    type: 'template' | 'list' | 'base';
    attributes: Record<string, string>;
    timeline?: XmlNode;
    initialization?: XmlNode;
    resources?: XmlNode[];
}

interface Inheritance {
    baseUrl?: string;
    hasBaseUrl?: boolean;
    addressing?: Addressing;
    mimeType?: string;
    codecs?: string;
    language?: string;
    contentType?: DashRepresentation['contentType'];
    width?: number;
    height?: number;
    audioSamplingRate?: number;
}

interface PlanBudget {
    remaining: number;
    remainingUrlCharacters: number;
}

function reservePlanEntries(budget: PlanBudget, count: number): void {
    if (count > budget.remaining) dashOverLimit('manifest exceeds maxPlanEntries');
    budget.remaining -= count;
}

function reserveUrlCharacters(budget: PlanBudget, count: number): void {
    if (count > budget.remainingUrlCharacters)
        dashOverLimit('resolved URL/template text exceeds the 16777216-character budget');
    budget.remainingUrlCharacters -= count;
}

const unsupportedElements = new Set([
    'ContentProtection',
    'SubRepresentation',
    'EssentialProperty',
    'ContentSteering',
    'PatchLocation',
    'Location',
    'LeapSecondInformation',
]);
const addressAttributes = new Set([
    '|timescale',
    '|presentationTimeOffset',
    '|duration',
    '|startNumber',
]);

function attribute(node: XmlNode, name: string): string | undefined {
    return node.attributes[`|${name}`];
}

function children(node: XmlNode, name: string): XmlNode[] {
    return node.children.filter(
        (child): child is XmlNode =>
            typeof child !== 'string' && child.namespace === DASH_NS && child.name === name,
    );
}

/** The one `name` child of `node`: several BaseURL elements are alternatives this parser does
 * not choose between, several of another are malformed. */
function single(node: XmlNode, name: string): XmlNode | undefined {
    const result = children(node, name);
    if (result.length > 1 && name === 'BaseURL')
        dashUnsupported('multiple BaseURL elements at one level are unsupported');
    if (result.length > 1) dashMalformed(`multiple ${name} elements at one level`);
    return result[0];
}

function numberAttribute(node: XmlNode, name: string, fallback?: number): number | undefined {
    const text = attribute(node, name);
    if (text === undefined) return fallback;
    const value = dashInteger(text, name);
    if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) dashMalformed(`invalid ${name}`);
    return Number(value);
}

function contentType(
    value?: string,
    mime?: string,
    codecs?: string,
): DashRepresentation['contentType'] {
    if (value !== undefined) {
        if (value !== 'audio' && value !== 'video' && value !== 'text')
            dashUnsupported(`unsupported contentType ${value}`);
        return value;
    }
    if (mime?.startsWith('audio/')) return 'audio';
    if (mime?.startsWith('video/')) return 'video';
    if (
        mime?.startsWith('text/') ||
        /^(?:wvtt|stpp)(?:[.,]|$)/.test(codecs ?? '') ||
        mime === 'application/ttml+xml'
    )
        return 'text';
    return undefined;
}

function inherit(node: XmlNode, previous: Inheritance, budget: PlanBudget): Inheritance {
    const baseNode = single(node, 'BaseURL');
    let baseUrl = previous.baseUrl;
    if (baseNode) {
        for (const name of ['availabilityTimeOffset', 'availabilityTimeComplete', 'byteRange']) {
            if (attribute(baseNode, name) !== undefined)
                dashUnsupported(`unsupported BaseURL@${name}`);
        }

        if (baseNode.children.some(child => typeof child !== 'string'))
            dashMalformed('BaseURL must contain text only');
        const text = baseNode.children.join('').trim();
        baseUrl = dashUrl(text, baseUrl);
        reserveUrlCharacters(budget, baseUrl.length);
    }

    const template = single(node, 'SegmentTemplate'),
        list = single(node, 'SegmentList'),
        base = single(node, 'SegmentBase');
    if (Number(Boolean(template)) + Number(Boolean(list)) + Number(Boolean(base)) > 1)
        dashMalformed('multiple segment addressing modes at one level');
    let addressing = previous.addressing;
    const addressingNode = template ?? list ?? base;
    if (addressingNode) {
        const type = template ? 'template' : list ? 'list' : 'base';
        const parent = addressing?.type === type ? addressing : undefined;
        for (const name of Object.keys(addressingNode.attributes)) {
            const allowed = base
                ? [
                      '|timescale',
                      '|presentationTimeOffset',
                      '|indexRange',
                      '|indexRangeExact',
                  ].includes(name)
                : addressAttributes.has(name) ||
                  Boolean(template && (name === '|media' || name === '|initialization'));
            if (name.startsWith('|') && !allowed) {
                dashUnsupported(`unsupported ${addressingNode.name}@${name.slice(1)}`);
            }
        }

        for (const child of addressingNode.children) {
            if (
                typeof child !== 'string' &&
                child.namespace === DASH_NS &&
                !(child.name === 'SegmentTimeline' && !base) &&
                child.name !== 'Initialization' &&
                !(list && child.name === 'SegmentURL')
            ) {
                dashUnsupported(`unsupported ${addressingNode.name} child ${child.name}`);
            }
        }

        const resources = children(addressingNode, 'SegmentURL');
        addressing = {
            type,
            attributes: { ...parent?.attributes, ...addressingNode.attributes },
            timeline: single(addressingNode, 'SegmentTimeline') ?? parent?.timeline,
            initialization: single(addressingNode, 'Initialization') ?? parent?.initialization,
            resources: resources.length ? resources : parent?.resources,
        };
    }

    const mimeType = attribute(node, 'mimeType') ?? previous.mimeType;
    const codecs = attribute(node, 'codecs') ?? previous.codecs;
    const kind = attribute(node, 'contentType');
    return {
        baseUrl,
        hasBaseUrl: Boolean(baseNode) || previous.hasBaseUrl,
        addressing,
        mimeType,
        codecs,
        language: attribute(node, 'lang') ?? node.attributes[`${XML_NS}|lang`] ?? previous.language,
        contentType: contentType(kind ?? previous.contentType, mimeType, codecs),
        width: numberAttribute(node, 'width', previous.width),
        height: numberAttribute(node, 'height', previous.height),
        audioSamplingRate: numberAttribute(node, 'audioSamplingRate', previous.audioSamplingRate),
    };
}

function range(value: string | undefined): DashByteRange | undefined {
    if (value === undefined) return undefined;
    const match = /^(\d{1,16})-(\d{1,16})$/.exec(value);
    if (!match) dashMalformed('invalid byte range');
    const start = BigInt(match[1]),
        end = BigInt(match[2]);
    if (end < start) dashMalformed('invalid byte range');
    if (end >= BigInt(Number.MAX_SAFE_INTEGER))
        dashUnsupported('byte range exceeds safe integer precision');
    return Object.freeze({ offset: Number(start), length: Number(end - start + 1n) });
}

function resource(
    node: XmlNode,
    baseUrl: string | undefined,
    sourceName: string,
    rangeName: string,
    budget: PlanBudget,
): DashResource {
    const source = attribute(node, sourceName);
    if (source === undefined && !baseUrl)
        dashMalformed(`${node.name} requires a resource URL or BaseURL`);
    const url = source === undefined ? baseUrl! : dashUrl(source, baseUrl);
    reserveUrlCharacters(budget, url.length);
    const indexSource = attribute(node, 'index'),
        indexRange = attribute(node, 'indexRange');
    if ((indexSource !== undefined || indexRange !== undefined) && node.name !== 'SegmentURL')
        dashUnsupported('unsupported initialization index');
    let index: DashResource['index'];
    if (indexSource !== undefined || indexRange !== undefined) {
        reservePlanEntries(budget, 1);
        const indexUrl = indexSource === undefined ? url : dashUrl(indexSource, baseUrl);
        reserveUrlCharacters(budget, indexUrl.length);
        index = Object.freeze({ url: indexUrl, byteRange: range(indexRange) });
    }

    return Object.freeze({
        url,
        byteRange: range(attribute(node, rangeName)),
        ...(index ? { index } : {}),
    });
}

function timeline(
    address: Addressing,
    timescale: number,
    pto: bigint,
    duration: DashFraction | undefined,
    maxSegments: number,
    diagnostics: DiagnosticContext,
    budget: PlanBudget,
): readonly DashTimelineEntry[] {
    const entries: DashTimelineEntry[] = [];
    let count = 0n;
    const add = (time: bigint, length: bigint, repeats: bigint): void => {
        if (length <= 0n || repeats < 0n || time + length * (repeats + 1n) > DASH_U64)
            dashMalformed('segment timeline exceeds uint64 or has an invalid duration');
        count += repeats + 1n;
        if (count > BigInt(maxSegments)) dashOverLimit('representation exceeds maxSegments');
        reservePlanEntries(budget, 1);
        entries.push(Object.freeze({ time, duration: length, repeat: repeats }));
    };

    if (address.timeline) {
        const nodes = children(address.timeline, 'S');
        if (!nodes.length) dashMalformed('SegmentTimeline has no S entries');
        let cursor = 0n;
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            for (const key of Object.keys(node.attributes))
                if (!['|t', '|d', '|r'].includes(key))
                    dashUnsupported('unsupported SegmentTimeline S attribute');

            const time = dashInteger(attribute(node, 't'), 'S@t', cursor);
            const length = dashInteger(attribute(node, 'd'), 'S@d');
            if (length === 0n) dashMalformed('S@d must be positive');
            if (index && time < cursor) dashMalformed('overlapping or backwards SegmentTimeline');
            if (index && time > cursor)
                diagnostics.recover({
                    code: 'DASH_TIMELINE_GAP',
                    message: 'SegmentTimeline contains a gap',
                    format: 'dash',
                });

            const rawRepeat = attribute(node, 'r');
            let repeats: bigint;
            if (rawRepeat === '-1') {
                const nextTime =
                    index + 1 < nodes.length ? attribute(nodes[index + 1], 't') : undefined;
                if (index + 1 < nodes.length && nextTime === undefined)
                    dashMalformed('negative repeat requires the next S@t');
                if (nextTime !== undefined) {
                    const end = dashInteger(nextTime, 'S@t');
                    if (end <= time || (end - time) % length)
                        dashMalformed('negative repeat must align with the next S@t');
                    repeats = (end - time) / length - 1n;
                } else {
                    if (!duration)
                        dashMalformed(
                            'unbounded negative repeat requires a finite Period duration',
                        );
                    const ticks =
                        duration.value * BigInt(timescale) + (pto - time) * duration.scale;
                    if (ticks <= 0n) dashMalformed('negative repeat starts outside its Period');
                    repeats = dashCeil(ticks, length * duration.scale) - 1n;
                }
            } else repeats = dashInteger(rawRepeat, 'S@r', 0n);

            add(time, length, repeats);
            cursor = time + length * (repeats + 1n);
        }
    } else {
        const length = dashInteger(address.attributes['|duration'], 'segment duration');
        if (!length) dashMalformed('segment duration must be positive');
        const total =
            address.type === 'list'
                ? BigInt(address.resources?.length ?? 0)
                : duration
                  ? dashCeil(duration.value * BigInt(timescale), duration.scale * length)
                  : dashMalformed('duration templates require a finite Period duration');

        if (!total) dashMalformed('representation has no segment references');
        add(pto, length, total - 1n);
    }

    if (address.type === 'list' && count !== BigInt(address.resources?.length ?? 0))
        dashMalformed('SegmentList timeline and resource counts disagree');
    return Object.freeze(entries);
}

function representation(
    node: XmlNode,
    inherited: Inheritance,
    periodIndex: number,
    periodId: string | undefined,
    start: DashFraction,
    duration: DashFraction | undefined,
    maxSegments: number,
    diagnostics: DiagnosticContext,
    budget: PlanBudget,
): DashRepresentation | DashPendingIndex {
    if (attribute(node, 'dependencyId') !== undefined)
        dashUnsupported('dependent Representations are unsupported');
    const state = inherit(node, inherited, budget);
    const address = state.addressing;
    if (!address) dashUnsupported('representation needs a SegmentTemplate or SegmentList');

    const id = attribute(node, 'id');
    const bandwidth = numberAttribute(node, 'bandwidth');
    const timescaleValue = dashInteger(address.attributes['|timescale'], 'timescale', 1n);
    if (timescaleValue === 0n || timescaleValue > 0xffffffffn)
        dashMalformed('timescale must fit a positive uint32');
    const timescale = Number(timescaleValue);
    const pto = dashInteger(
        address.attributes['|presentationTimeOffset'],
        'presentationTimeOffset',
        0n,
    );

    const description = {
        id,
        bandwidth,
        mimeType: state.mimeType,
        codecs: state.codecs,
        language: state.language,
        contentType: state.contentType,
        width: state.width,
        height: state.height,
        audioSamplingRate: state.audioSamplingRate,
        baseUrl: state.baseUrl,
        periodIndex,
        periodId,
        periodStart: dashSeconds(start),
        periodDuration: duration ? dashSeconds(duration) : undefined,
    };

    if (address.type === 'base') {
        if (!state.hasBaseUrl || !state.baseUrl)
            dashUnsupported('SegmentBase requires an explicit BaseURL');
        const byteRange = range(address.attributes['|indexRange']);
        if (!byteRange) dashUnsupported('SegmentBase requires an explicit indexRange');
        const exact = address.attributes['|indexRangeExact'];
        if (exact !== undefined && !['true', 'false', '1', '0'].includes(exact))
            dashMalformed('invalid indexRangeExact');
        const initialization = address.initialization
            ? resource(address.initialization, state.baseUrl, 'sourceURL', 'range', budget)
            : undefined;
        reservePlanEntries(budget, 1);
        reserveUrlCharacters(budget, state.baseUrl.length);
        return Object.freeze({
            kind: 'pending-index',
            description: Object.freeze({ ...description, initialization }),
            index: Object.freeze({ url: state.baseUrl, byteRange }),
            exact: exact === 'true' || exact === '1',
            timescale,
            presentationTimeOffset: pto,
            start,
            duration,
            maxSegments,
        });
    }

    const startNumber = dashInteger(address.attributes['|startNumber'], 'startNumber', 1n);
    const entries = timeline(address, timescale, pto, duration, maxSegments, diagnostics, budget);
    const segmentCount = entries.reduce((count, entry) => count + entry.repeat + 1n, 0n);
    if (startNumber + segmentCount - 1n > DASH_U64) dashMalformed('segment number exceeds uint64');
    let initialization: DashResource | undefined;
    const media = address.type === 'template' ? address.attributes['|media'] : undefined;
    const tokens =
        address.type === 'template' ? dashTemplate(media ?? '', id, bandwidth) : undefined;
    if (tokens) {
        reserveUrlCharacters(
            budget,
            tokens.reduce(
                (count, token) =>
                    count + (typeof token === 'string' ? token.length : Math.max(20, token.width)),
                0,
            ),
        );
        if (segmentCount > 1n && tokens.every(token => typeof token === 'string'))
            dashMalformed('multiple segments require a Number or Time template identifier');
        dashUrl(dashExpand(tokens, startNumber, entries[0].time), state.baseUrl);
        const init = address.attributes['|initialization'];
        if (init !== undefined && address.initialization)
            dashMalformed('multiple initialization addressing forms');
        if (init !== undefined) {
            const url = dashUrl(
                dashExpand(dashTemplate(init, id, bandwidth, true), 0n, 0n),
                state.baseUrl,
            );
            reserveUrlCharacters(budget, url.length);
            initialization = Object.freeze({ url });
        }
    }

    if (address.initialization)
        initialization = resource(
            address.initialization,
            state.baseUrl,
            'sourceURL',
            'range',
            budget,
        );

    if (address.type === 'list') reservePlanEntries(budget, address.resources!.length);
    const resources =
        address.type === 'list'
            ? Object.freeze(
                  address.resources!.map(node =>
                      resource(node, state.baseUrl, 'media', 'mediaRange', budget),
                  ),
              )
            : undefined;

    const segmentInfo: DashSegmentInfo = Object.freeze({
        type: address.type,
        timescale,
        presentationTimeOffset: pto,
        startNumber,
        timeline: entries,
        media,
        resources,
    });

    return registerDashRepresentation(
        { ...description, initialization, segmentInfo, segmentCount },
        { start, duration, maxSegments, media: tokens },
    );
}

/** The baseUrl option as a resource URL; one that is not a URL is an invalid option. */
function optionUrl(value: string): string {
    try {
        return dashUrl(value);
    } catch (error) {
        if (error instanceof DemuxError) dashInvalidArgument('baseUrl is not a valid URL');
        throw error;
    }
}

function sourceText(input: string | Uint8Array, maximum: number): string {
    if (typeof input === 'string') {
        if (input.length > maximum) dashOverLimit('manifest exceeds maxBytes');
        let bytes = 0;
        for (const char of input) {
            const point = char.codePointAt(0)!;
            bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
            if (bytes > maximum) dashOverLimit('manifest exceeds maxBytes');
        }

        return input;
    }

    let length: number;
    try {
        length = byteLength.call(input);
    } catch {
        return dashInvalidArgument('manifest must be a string or Uint8Array');
    }

    assertSourceBytes(input, length, 'DASH manifest');
    if (length > maximum) dashOverLimit('manifest exceeds maxBytes');
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
        return dashMalformed('manifest bytes must be UTF-8');
    }
}

interface DraftAdaptationSet extends Omit<DashAdaptationSet, 'representations'> {
    readonly representations: readonly (DashRepresentation | DashPendingIndex)[];
}

interface DraftPeriod extends Omit<DashPeriod, 'adaptationSets'> {
    readonly adaptationSets: readonly DraftAdaptationSet[];
}

interface DraftManifest extends Omit<DashManifest, 'periods'> {
    readonly periods: readonly DraftPeriod[];
}

function prepareDashManifest(
    input: string | Uint8Array,
    options: DashParseOptions,
    indexed: boolean,
): { draft: DraftManifest; budget: PlanBudget } {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        dashInvalidArgument('invalid parse options');
    const {
        baseUrl,
        maxBytes,
        maxNodes,
        maxDepth,
        maxRepresentations,
        maxSegments,
        maxPlanEntries,
        validation,
        onWarning,
        maxWarnings,
    } = options;

    const diagnostics = new DiagnosticContext({ validation, onWarning, maxWarnings }, 'compatible');
    const bytes = dashLimit(maxBytes, 8 * 1024 * 1024, 'maxBytes', 64 * 1024 * 1024);
    const nodes = dashLimit(maxNodes, 200000, 'maxNodes', 1000000);
    const depth = dashLimit(maxDepth, 64, 'maxDepth', 256);
    const representations = dashLimit(maxRepresentations, 1024, 'maxRepresentations', 100000);
    const segments = dashLimit(maxSegments, 1000000, 'maxSegments', 1000000000);
    const budget = {
        remaining: dashLimit(maxPlanEntries, 200000, 'maxPlanEntries', 1000000),
        remainingUrlCharacters: 16777216,
    };
    if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)))
        dashInvalidArgument('baseUrl must be an absolute HTTP(S) URL');
    const root = parseXml(sourceText(input, bytes), { maxNodes: nodes, maxDepth: depth });
    if (root.name !== 'MPD' || root.namespace !== DASH_NS)
        dashMalformed('expected an MPD in the DASH namespace');
    const type = attribute(root, 'type') ?? 'static';
    if (type !== 'static') dashUnsupported('only static MPDs are supported');
    for (const name of [
        'minimumUpdatePeriod',
        'availabilityStartTime',
        'availabilityEndTime',
        'timeShiftBufferDepth',
    ]) {
        if (attribute(root, name) !== undefined)
            dashUnsupported(`dynamic attribute ${name} is not supported`);
    }

    const pending = [root];
    while (pending.length) {
        const node = pending.pop()!;
        if (!indexed && node.namespace === DASH_NS && node.name === 'SegmentBase')
            dashUnsupported('SegmentBase needs resolveDashManifest, not synchronous parsing');

        if (node.namespace === DASH_NS && unsupportedElements.has(node.name))
            dashUnsupported(
                node.name === 'ContentProtection'
                    ? 'ContentProtection is not supported; encrypted DASH is not planned'
                    : `${node.name} is not supported`,
            );

        if (
            Object.keys(node.attributes).some(key =>
                key.startsWith('http://www.w3.org/1999/xlink|'),
            )
        )
            dashUnsupported('external xlink addressing is not supported');

        if (node.attributes[`${XML_NS}|base`] !== undefined)
            dashUnsupported('xml:base is not supported; use BaseURL');
        for (const child of node.children) if (typeof child !== 'string') pending.push(child);
    }

    const initialBase = baseUrl === undefined ? undefined : optionUrl(baseUrl);
    if (initialBase) reserveUrlCharacters(budget, initialBase.length);
    const rootState = inherit(root, { baseUrl: initialBase }, budget);
    const totalDuration = dashDuration(
        attribute(root, 'mediaPresentationDuration'),
        'mediaPresentationDuration',
    );
    const periodNodes = children(root, 'Period');
    if (!periodNodes.length) dashMalformed('static MPD requires a Period');
    const times = periodNodes.map(node => ({
        start: dashDuration(attribute(node, 'start'), 'Period@start'),
        duration: dashDuration(attribute(node, 'duration'), 'Period@duration'),
    }));
    let count = 0;
    const periods: DraftPeriod[] = [];
    for (let index = 0; index < periodNodes.length; index++) {
        const timing = times[index];
        if (!timing.start) {
            if (!index) timing.start = { value: 0n, scale: 1n };
            else {
                const previous = times[index - 1];
                if (!previous.start || !previous.duration)
                    dashMalformed('Period start cannot be inferred');
                timing.start = dashAdd(previous.start, previous.duration);
            }
        }

        if (!timing.duration) {
            const nextStart = times[index + 1]?.start;
            if (nextStart) timing.duration = dashSubtract(nextStart, timing.start);
            else if (index === times.length - 1 && totalDuration)
                timing.duration = dashSubtract(totalDuration, timing.start);
        }

        if (timing.duration && timing.duration.value <= 0n)
            dashMalformed('Period duration must be positive');
        if (dashSeconds(timing.start) > Number.MAX_SAFE_INTEGER)
            dashUnsupported('Period start exceeds the supported time range');
        if (index) {
            const previous = times[index - 1];
            if (!previous.duration) dashMalformed('preceding Period duration is unknown');
            const difference = dashCompare(
                timing.start,
                dashAdd(previous.start!, previous.duration),
            );
            if (difference < 0n) dashMalformed('Periods overlap');
            if (difference > 0n)
                diagnostics.recover({
                    code: 'DASH_PERIOD_GAP',
                    message: 'MPD contains a gap between Periods',
                    format: 'dash',
                });
        }

        const node = periodNodes[index],
            id = attribute(node, 'id');
        const periodState = inherit(node, rootState, budget);
        const adaptationSets: DraftAdaptationSet[] = [];
        for (const adaptation of children(node, 'AdaptationSet')) {
            const state = inherit(adaptation, periodState, budget);
            const parsed: Array<DashRepresentation | DashPendingIndex> = [];
            const ids = new Set<string>();
            for (const rep of children(adaptation, 'Representation')) {
                if (++count > representations) dashOverLimit('manifest exceeds maxRepresentations');
                const repId = attribute(rep, 'id');
                if (repId !== undefined && ids.has(repId))
                    dashMalformed('duplicate Representation id in an AdaptationSet');
                if (repId !== undefined) ids.add(repId);
                parsed.push(
                    representation(
                        rep,
                        state,
                        index,
                        id,
                        timing.start,
                        timing.duration,
                        segments,
                        diagnostics,
                        budget,
                    ),
                );
            }

            if (!parsed.length) dashUnsupported('AdaptationSet requires a Representation');
            adaptationSets.push(
                Object.freeze({
                    id: attribute(adaptation, 'id'),
                    mimeType: state.mimeType,
                    codecs: state.codecs,
                    language: state.language,
                    contentType: state.contentType,
                    representations: Object.freeze(parsed),
                }),
            );
        }

        if (!adaptationSets.length) dashUnsupported('Period requires an AdaptationSet');
        periods.push(
            Object.freeze({
                id,
                start: dashSeconds(timing.start),
                duration: timing.duration ? dashSeconds(timing.duration) : undefined,
                adaptationSets: Object.freeze(adaptationSets),
            }),
        );
    }

    const last = times.at(-1)!;
    const end = last.duration ? dashAdd(last.start!, last.duration) : undefined;
    if (totalDuration && end && dashCompare(totalDuration, end) !== 0n)
        dashMalformed('MPD duration conflicts with the last Period end');
    const draft: DraftManifest = Object.freeze({
        type: 'static',
        id: attribute(root, 'id'),
        baseUrl: rootState.baseUrl,
        duration: totalDuration ? dashSeconds(totalDuration) : end ? dashSeconds(end) : undefined,
        periods: Object.freeze(periods),
        diagnostics: Object.freeze(diagnostics.warnings),
    });

    return { draft, budget };
}

function finishDashManifest(
    draft: DraftManifest,
    resolved?: ReadonlyMap<DashPendingIndex, DashRepresentation>,
): DashManifest {
    return Object.freeze({
        ...draft,
        periods: Object.freeze(
            draft.periods.map(period =>
                Object.freeze({
                    ...period,
                    adaptationSets: Object.freeze(
                        period.adaptationSets.map(group =>
                            Object.freeze({
                                ...group,
                                representations: Object.freeze(
                                    group.representations.map(rep => {
                                        if (!('kind' in rep)) return rep;
                                        const result = resolved?.get(rep);
                                        if (!result)
                                            dashUnsupported('unresolved SegmentBase index');
                                        return result;
                                    }),
                                ),
                            }),
                        ),
                    ),
                }),
            ),
        ),
    });
}

/**
 * Parses the bounded static MPD addressing subset. No network, playback, ABR, or decryption is
 * performed.
 */
export function parseDashManifest(
    input: string | Uint8Array,
    options: DashParseOptions = {},
): DashManifest {
    return finishDashManifest(prepareDashManifest(input, options, false).draft);
}

/**
 * Resolves static SegmentBase indexes through the caller's reader; publishes only a complete
 * immutable plan.
 */
export async function resolveDashManifest(
    input: string | Uint8Array,
    options: DashResolveOptions,
): Promise<DashManifest> {
    return resolveDashIndexes(options, () => {
        const { draft, budget } = prepareDashManifest(input, options, true);
        const pending: DashPendingIndex[] = [];
        for (const period of draft.periods)
            for (const group of period.adaptationSets) {
                for (const rep of group.representations) if ('kind' in rep) pending.push(rep);
            }
        return {
            pending,
            reserveEntries: (count: number) => reservePlanEntries(budget, count),
            reserveCharacters: (count: number) => reserveUrlCharacters(budget, count),
            finish: (resolved: ReadonlyMap<DashPendingIndex, DashRepresentation>) =>
                finishDashManifest(draft, resolved),
        };
    });
}
