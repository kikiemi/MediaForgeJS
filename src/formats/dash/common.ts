import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import type { DashRepresentation } from './types';

export interface DashFraction {
    readonly value: bigint;
    readonly scale: bigint;
}
export const DASH_NS = 'urn:mpeg:dash:schema:mpd:2011';
export const DASH_U64 = 0xffffffffffffffffn;

// A manifest or index that does not follow ISO/IEC 23009-1 is malformed (DEMUX), one that uses
// what this parser does not plan is unsupported (FORMAT), an invalid argument or option is INPUT,
// and a manifest past a size limit is OOM.

/** Refuses a manifest or index that does not follow ISO/IEC 23009-1. */
export function dashMalformed(message: string): never {
    throw new DemuxError(`DASH: ${message}`);
}

/** Refuses a manifest that uses what this parser does not plan. */
export function dashUnsupported(message: string): never {
    throw new MediaForgeError(`DASH: ${message}`, 'FORMAT');
}

export function dashInvalidArgument(message: string): never {
    throw new MediaForgeError(`DASH: ${message}`, 'INPUT');
}

export function dashOverLimit(message: string): never {
    throw new MediaForgeError(`DASH: ${message}`, 'OOM');
}

/** An option of at most `maximum`, `fallback` when it is not given. */
export function dashLimit(
    value: number | undefined,
    fallback: number,
    name: string,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
        dashInvalidArgument(`invalid ${name}`);
    return result;
}

export function dashInteger(value: string | undefined, name: string, fallback?: bigint): bigint {
    if (value === undefined && fallback !== undefined) return fallback;
    if (value === undefined || !/^\d{1,20}$/.test(value)) dashMalformed(`invalid ${name}`);
    const number = BigInt(value);
    if (number > DASH_U64) dashMalformed(`${name} exceeds uint64`);
    return number;
}

export function dashAdd(a: DashFraction, b: DashFraction): DashFraction {
    const scale = a.scale > b.scale ? a.scale : b.scale;
    return { value: a.value * (scale / a.scale) + b.value * (scale / b.scale), scale };
}

export function dashSubtract(a: DashFraction, b: DashFraction): DashFraction {
    const scale = a.scale > b.scale ? a.scale : b.scale;
    return { value: a.value * (scale / a.scale) - b.value * (scale / b.scale), scale };
}

export function dashCompare(a: DashFraction, b: DashFraction): bigint {
    return a.value * b.scale - b.value * a.scale;
}

export function dashSeconds(value: DashFraction): number {
    return Number(value.value) / Number(value.scale);
}

/** An ISO 8601 duration of days, hours, minutes and seconds: P1DT2H3M4.5S. */
const ISO_DURATION = new RegExp(
    String.raw`^P(?:(\d{1,15})D)?` +
        String.raw`(?:T(?:(\d{1,15})H)?(?:(\d{1,15})M)?(?:(\d{1,15})(?:\.(\d{1,9}))?S)?)?$`,
);

/** An xs:duration: a sign, years and months, longer numbers and seconds of any precision. */
const XS_DURATION = new RegExp(
    String.raw`^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?` +
        String.raw`(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$`,
);

export function dashDuration(value: string | undefined, name: string): DashFraction | undefined {
    if (value === undefined) return undefined;
    const match = ISO_DURATION.exec(value);
    if (!match || !match.slice(1).some(Boolean) || value.endsWith('T')) {
        if (XS_DURATION.test(value)) dashUnsupported(`unsupported ${name} duration`);
        dashMalformed(`invalid ${name} duration`);
    }
    const scale = 10n ** BigInt(match[5]?.length ?? 0);
    const whole =
        BigInt(match[1] ?? 0) * 86400n +
        BigInt(match[2] ?? 0) * 3600n +
        BigInt(match[3] ?? 0) * 60n +
        BigInt(match[4] ?? 0);
    const result = { value: whole * scale + BigInt(match[5] ?? 0), scale };
    if (whole > BigInt(Number.MAX_SAFE_INTEGER))
        dashUnsupported(`${name} exceeds the supported presentation time range`);
    return result;
}

export function dashNumberTime(value: number, name: string): DashFraction {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER
    )
        dashInvalidArgument(`invalid ${name}`);
    const [digits, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = digits.split('.');
    const shift = Number(exponent) - fraction.length;
    const integer = BigInt(whole + fraction);
    return shift < 0
        ? { value: integer, scale: 10n ** BigInt(-shift) }
        : { value: integer * 10n ** BigInt(shift), scale: 1n };
}

export function dashCeil(value: bigint, denominator: bigint): bigint {
    return value >= 0n ? (value + denominator - 1n) / denominator : value / denominator;
}

export function dashFloor(value: bigint, denominator: bigint): bigint {
    return value >= 0n ? value / denominator : -((-value + denominator - 1n) / denominator);
}

/** `value` resolved against `base`; a URL longer than 65536 characters is past a size limit. */
export function dashUrl(value: string, base?: string): string {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f\\]/.test(value))
        dashMalformed('invalid resource URL');
    if (value.length > 65536) dashOverLimit('resource URL exceeds its length limit');

    const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/;
    if (absolute.test(value) || (base && absolute.test(base))) {
        let url: URL;
        try {
            url = new URL(value, base);
        } catch {
            return dashMalformed('invalid resource URL');
        }

        if (url.protocol !== 'https:' && url.protocol !== 'http:')
            dashUnsupported('only HTTP(S) or relative resource URLs are supported');
        if (url.href.length > 65536) dashOverLimit('resource URL exceeds its length limit');
        return url.href;
    }

    if (value.startsWith('//'))
        dashInvalidArgument('a protocol-relative URL needs an absolute baseUrl');
    if (!base) return value;
    const split = (url: string): { path: string; query: string; hash: string } => {
        const hashAt = url.indexOf('#');
        const hash = hashAt < 0 ? '' : url.slice(hashAt);
        const before = hashAt < 0 ? url : url.slice(0, hashAt);
        const queryAt = before.indexOf('?');
        return {
            path: queryAt < 0 ? before : before.slice(0, queryAt),
            query: queryAt < 0 ? '' : before.slice(queryAt),
            hash,
        };
    };

    const next = split(value),
        previous = split(base);
    if (!next.path) return previous.path + (next.query || previous.query) + next.hash;
    const path = next.path.startsWith('/')
        ? next.path
        : previous.path.slice(0, previous.path.lastIndexOf('/') + 1) + next.path;
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '.') continue;
        if (
            part === '..' &&
            parts.length &&
            parts.at(-1) !== '..' &&
            (parts.at(-1) !== '' || parts.length > 1)
        )
            parts.pop();
        else if (part !== '..' || !path.startsWith('/')) parts.push(part);
    }

    const directory = /(?:^|\/)\.{1,2}$/.test(path) || path.endsWith('/');
    const joined = parts.join('/');
    const result =
        (joined || (path.startsWith('/') ? '/' : directory ? './' : '')) +
        (directory && joined && !joined.endsWith('/') ? '/' : '') +
        next.query +
        next.hash;

    if (result.length > 65536) dashOverLimit('resource URL exceeds its length limit');
    return result;
}

export type DashTemplateToken =
    string | { readonly name: 'Number' | 'Time'; readonly width: number };

export function dashTemplate(
    value: string,
    id: string | undefined,
    bandwidth: number | undefined,
    initialization = false,
): readonly DashTemplateToken[] {
    if (!value) dashMalformed('empty segment template');
    if (value.length > 65536) dashOverLimit('segment template exceeds its length limit');
    const tokens: DashTemplateToken[] = [];
    let maximumLength = 0;
    const append = (token: DashTemplateToken): void => {
        maximumLength += typeof token === 'string' ? token.length : Math.max(20, token.width);
        if (maximumLength > 65536)
            dashOverLimit('expanded segment template exceeds its length limit');
        tokens.push(token);
    };

    let cursor = 0;
    while (cursor < value.length) {
        const open = value.indexOf('$', cursor);
        if (open < 0) {
            append(value.slice(cursor));
            break;
        }

        if (open > cursor) append(value.slice(cursor, open));
        if (value[open + 1] === '$') {
            append('$');
            cursor = open + 2;
            continue;
        }

        const close = value.indexOf('$', open + 1);
        if (close < 0) dashMalformed('unterminated segment template identifier');
        const identifier = value.slice(open + 1, close);
        const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%0([1-9]\d?)d)?$/.exec(
            identifier,
        );
        if (!match || Number(match[2] ?? 0) > 32) {
            if (
                /^(?:RepresentationID|Bandwidth|Number|Time|SubNumber)(?:%0\d+d)?$/.test(identifier)
            )
                dashUnsupported(`unsupported segment template identifier $${identifier}$`);
            dashMalformed('invalid segment template identifier');
        }
        const name = match[1],
            width = Number(match[2] ?? 0);
        if (name === 'RepresentationID') {
            if (id === undefined || width)
                dashMalformed('RepresentationID requires an id and no numeric format');
            append(id);
        } else if (name === 'Bandwidth') {
            if (bandwidth === undefined) dashMalformed('Bandwidth template requires bandwidth');
            append(String(bandwidth).padStart(width, '0'));
        } else {
            if (initialization) dashMalformed('initialization templates cannot use Number or Time');
            append(Object.freeze({ name: name as 'Number' | 'Time', width }));
        }

        cursor = close + 1;
    }

    return Object.freeze(tokens);
}

export function dashExpand(
    tokens: readonly DashTemplateToken[],
    number: bigint,
    time: bigint,
): string {
    return tokens
        .map(token =>
            typeof token === 'string'
                ? token
                : String(token.name === 'Time' ? time : number).padStart(token.width, '0'),
        )
        .join('');
}

/** Where the segments of a representation lie, which iterateDashSegments() reads. */
export interface DashPlan {
    readonly start: DashFraction;
    readonly duration?: DashFraction;
    readonly maxSegments: number;
    readonly media?: readonly DashTemplateToken[];
}

const plans = new WeakMap<DashRepresentation, DashPlan>();

/** Freezes a representation the manifest readers made and keeps its plan. */
export function registerDashRepresentation(
    representation: DashRepresentation,
    plan: DashPlan,
): DashRepresentation {
    Object.freeze(representation);
    plans.set(representation, plan);
    return representation;
}

/** The plan of a representation the manifest readers made; undefined for any other object. */
export const dashPlan = (representation: DashRepresentation): DashPlan | undefined =>
    plans.get(representation);
