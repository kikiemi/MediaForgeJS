import { MediaForgeError } from '../core/errors.js';
export const DASH_NS = 'urn:mpeg:dash:schema:mpd:2011';
export const DASH_U64 = 0xffffffffffffffffn;
export function dashError(message) {
    throw new MediaForgeError(`DASH: ${message}`, 'FORMAT');
}
export function dashLimit(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
        dashError(`invalid ${name}`);
    return result;
}
export function dashInteger(value, name, fallback) {
    if (value === undefined && fallback !== undefined)
        return fallback;
    if (value === undefined || !/^\d{1,20}$/.test(value))
        dashError(`invalid ${name}`);
    const number = BigInt(value);
    if (number > DASH_U64)
        dashError(`${name} exceeds uint64`);
    return number;
}
export function dashAdd(a, b) {
    const scale = a.scale > b.scale ? a.scale : b.scale;
    return { value: a.value * (scale / a.scale) + b.value * (scale / b.scale), scale };
}
export function dashSubtract(a, b) {
    const scale = a.scale > b.scale ? a.scale : b.scale;
    return { value: a.value * (scale / a.scale) - b.value * (scale / b.scale), scale };
}
export function dashCompare(a, b) {
    return a.value * b.scale - b.value * a.scale;
}
export function dashSeconds(value) {
    return Number(value.value) / Number(value.scale);
}
export function dashDuration(value, name) {
    if (value === undefined)
        return undefined;
    const match = /^P(?:(\d{1,15})D)?(?:T(?:(\d{1,15})H)?(?:(\d{1,15})M)?(?:(\d{1,15})(?:\.(\d{1,9}))?S)?)?$/.exec(value);
    if (!match || !match.slice(1).some(Boolean) || value.endsWith('T'))
        dashError(`invalid or unsupported ${name} duration`);
    const scale = 10n ** BigInt(match[5]?.length ?? 0);
    const whole = BigInt(match[1] ?? 0) * 86400n +
        BigInt(match[2] ?? 0) * 3600n +
        BigInt(match[3] ?? 0) * 60n +
        BigInt(match[4] ?? 0);
    const result = { value: whole * scale + BigInt(match[5] ?? 0), scale };
    if (whole > BigInt(Number.MAX_SAFE_INTEGER))
        dashError(`${name} exceeds the supported presentation time range`);
    return result;
}
export function dashNumberTime(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
        dashError(`invalid ${name}`);
    const [digits, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = digits.split('.');
    const shift = Number(exponent) - fraction.length;
    const integer = BigInt(whole + fraction);
    return shift < 0
        ? { value: integer, scale: 10n ** BigInt(-shift) }
        : { value: integer * 10n ** BigInt(shift), scale: 1n };
}
export function dashCeil(value, denominator) {
    return value >= 0n ? (value + denominator - 1n) / denominator : value / denominator;
}
export function dashFloor(value, denominator) {
    return value >= 0n ? value / denominator : -((-value + denominator - 1n) / denominator);
}
export function dashUrl(value, base) {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f\\]/.test(value) || value.length > 65536)
        dashError('invalid resource URL');
    const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/;
    if (absolute.test(value) || (base && absolute.test(base))) {
        let url;
        try {
            url = new URL(value, base);
        }
        catch {
            return dashError('invalid resource URL');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
            dashError('only HTTP(S) or relative resource URLs are supported');
        if (url.href.length > 65536)
            dashError('resource URL exceeds its length limit');
        return url.href;
    }
    if (value.startsWith('//'))
        dashError('protocol-relative URL requires an absolute baseUrl');
    if (!base)
        return value;
    const split = (url) => {
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
    const next = split(value), previous = split(base);
    if (!next.path)
        return previous.path + (next.query || previous.query) + next.hash;
    const path = next.path.startsWith('/')
        ? next.path
        : previous.path.slice(0, previous.path.lastIndexOf('/') + 1) + next.path;
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '.')
            continue;
        if (part === '..' && parts.length && parts.at(-1) !== '..' && (parts.at(-1) !== '' || parts.length > 1))
            parts.pop();
        else if (part !== '..' || !path.startsWith('/'))
            parts.push(part);
    }
    const directory = /(?:^|\/)\.{1,2}$/.test(path) || path.endsWith('/');
    const joined = parts.join('/');
    const result = (joined || (path.startsWith('/') ? '/' : directory ? './' : '')) +
        (directory && joined && !joined.endsWith('/') ? '/' : '') +
        next.query +
        next.hash;
    if (result.length > 65536)
        dashError('resource URL exceeds its length limit');
    return result;
}
export function dashTemplate(value, id, bandwidth, initialization = false) {
    if (!value || value.length > 65536)
        dashError('invalid segment template');
    const tokens = [];
    let maximumLength = 0;
    const append = (token) => {
        maximumLength += typeof token === 'string' ? token.length : Math.max(20, token.width);
        if (maximumLength > 65536)
            dashError('expanded segment template exceeds its length limit');
        tokens.push(token);
    };
    let cursor = 0;
    while (cursor < value.length) {
        const open = value.indexOf('$', cursor);
        if (open < 0) {
            append(value.slice(cursor));
            break;
        }
        if (open > cursor)
            append(value.slice(cursor, open));
        if (value[open + 1] === '$') {
            append('$');
            cursor = open + 2;
            continue;
        }
        const close = value.indexOf('$', open + 1);
        if (close < 0)
            dashError('unterminated segment template identifier');
        const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%0([1-9]\d?)d)?$/.exec(value.slice(open + 1, close));
        if (!match || Number(match[2] ?? 0) > 32)
            dashError('unsupported segment template identifier or width');
        const name = match[1], width = Number(match[2] ?? 0);
        if (name === 'RepresentationID') {
            if (id === undefined || width)
                dashError('RepresentationID requires an id and no numeric format');
            append(id);
        }
        else if (name === 'Bandwidth') {
            if (bandwidth === undefined)
                dashError('Bandwidth template requires bandwidth');
            append(String(bandwidth).padStart(width, '0'));
        }
        else {
            if (initialization)
                dashError('initialization templates cannot use Number or Time');
            append(Object.freeze({ name: name, width }));
        }
        cursor = close + 1;
    }
    return Object.freeze(tokens);
}
export function dashExpand(tokens, number, time) {
    return tokens
        .map(token => typeof token === 'string'
        ? token
        : String(token.name === 'Time' ? time : number).padStart(token.width, '0'))
        .join('');
}
