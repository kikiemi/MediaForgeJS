import { demuxAssert, DEMUX_LIMITS } from './demux-guard.js';
import { DemuxError, MediaForgeError } from './errors.js';
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const roleScheme = 'urn:mpeg:dash:role:2011';
const titleKey = 'com.apple.quicktime.title';
const empty = new Uint8Array(0);
function fourcc(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}
function boxes(bytes, start, end, userData = false) {
    const found = [];
    for (let position = start; position < end;) {
        if (userData && end - position === 4 && u32(bytes, position) === 0)
            break;
        demuxAssert(position + 8 <= end, 'MP4 metadata box header is truncated');
        let size = u32(bytes, position);
        let header = 8;
        if (size === 1) {
            demuxAssert(position + 16 <= end, 'MP4 metadata extended box header is truncated');
            size = u32(bytes, position + 8) * 0x100000000 + u32(bytes, position + 12);
            header = 16;
        }
        else if (size === 0)
            size = end - position;
        demuxAssert(Number.isSafeInteger(size) && size >= header && size <= end - position, 'MP4 metadata box extends past its parent');
        demuxAssert(found.length < DEMUX_LIMITS.maxBoxesPerRange, 'MP4 metadata has too many boxes');
        found.push({
            type: fourcc(bytes, position + 4),
            start: position,
            end: position + size,
            payload: position + header,
        });
        position += size;
    }
    return found;
}
function decode(bytes, encoding = 'utf-8') {
    try {
        return (encoding === 'utf-8' ? utf8 : new TextDecoder(encoding, { fatal: true })).decode(bytes);
    }
    catch {
        throw new DemuxError(`Invalid ${encoding} in MP4 metadata`);
    }
}
function terminated(bytes, start, end) {
    const stop = bytes.indexOf(0, start);
    demuxAssert(stop >= start && stop < end, 'MP4 metadata string has no terminator');
    return { text: decode(bytes.subarray(start, stop)), next: stop + 1 };
}
function trackName(bytes, name) {
    demuxAssert(name.end - name.payload >= 7, 'tnam track name is truncated');
    const start = name.payload + 6;
    if ((bytes[start] === 0xfe && bytes[start + 1] === 0xff) || (bytes[start] === 0xff && bytes[start + 1] === 0xfe)) {
        let stop = start + 2;
        while (stop + 1 < name.end && (bytes[stop] !== 0 || bytes[stop + 1] !== 0))
            stop += 2;
        demuxAssert(stop + 1 < name.end, 'UTF-16 tnam track name has no terminator');
        return decode(bytes.subarray(start + 2, stop), bytes[start] === 0xfe ? 'utf-16be' : 'utf-16le');
    }
    return terminated(bytes, start, name.end).text;
}
function metadataTitle(bytes, meta) {
    let start = meta.payload;
    demuxAssert(start + 4 <= meta.end, 'meta box is truncated');
    if (u32(bytes, start) === 0)
        start += 4;
    const entries = boxes(bytes, start, meta.end);
    const handler = entries.find(entry => entry.type === 'hdlr');
    if (!handler)
        return;
    demuxAssert(handler.end - handler.payload >= 24, 'metadata hdlr is truncated');
    const kind = fourcc(bytes, handler.payload + 8);
    if (kind !== 'mdta' && kind !== 'mdir')
        return;
    const names = [];
    const keys = entries.find(entry => entry.type === 'keys');
    if (kind === 'mdta' && keys) {
        demuxAssert(keys.end - keys.payload >= 8 && u32(bytes, keys.payload) === 0, 'invalid metadata keys header');
        const keyEntries = boxes(bytes, keys.payload + 8, keys.end);
        demuxAssert(keyEntries.length === u32(bytes, keys.payload + 4), 'metadata keys count does not match its entries');
        for (const entry of keyEntries)
            names.push(entry.type === 'mdta' ? decode(bytes.subarray(entry.payload, entry.end)) : undefined);
    }
    const list = entries.find(entry => entry.type === 'ilst');
    if (!list)
        return;
    for (const entry of boxes(bytes, list.payload, list.end)) {
        const key = kind === 'mdta' ? names[u32(bytes, entry.start + 4) - 1] : entry.type;
        const isTitle = key === titleKey || key === 'title' || key === '©nam';
        if (!isTitle)
            continue;
        for (const value of boxes(bytes, entry.payload, entry.end)) {
            if (value.type !== 'data')
                continue;
            demuxAssert(value.end - value.payload >= 8, 'metadata data value is truncated');
            const encoding = u32(bytes, value.payload);
            if (encoding === 1 || encoding === 2)
                return decode(bytes.subarray(value.payload + 8, value.end), encoding === 1 ? 'utf-8' : 'utf-16be');
        }
    }
}
function readMetadata(bytes, start, end) {
    const direct = boxes(bytes, start, end);
    const user = direct
        .filter(entry => entry.type === 'udta')
        .flatMap(entry => boxes(bytes, entry.payload, entry.end, true));
    let title;
    for (const entry of [...direct, ...user]) {
        if (entry.type !== 'meta')
            continue;
        const value = metadataTitle(bytes, entry);
        if (title === undefined)
            title = value;
    }
    for (const entry of user) {
        if (entry.type !== '©nam')
            continue;
        demuxAssert(entry.end - entry.payload >= 4, 'QuickTime title is truncated');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const length = view.getUint16(entry.payload);
        demuxAssert(length <= entry.end - entry.payload - 4, 'QuickTime title extends past its box');
        const language = view.getUint16(entry.payload + 2);
        const raw = bytes.subarray(entry.payload + 4, entry.payload + 4 + length);
        const value = decode(raw, language < 0x400 ? 'macintosh' : 'utf-8');
        if (title === undefined)
            title = value;
    }
    return { title, user };
}
export function readMP4Title(bytes, start, end) {
    return readMetadata(bytes, start, end).title;
}
export function readMP4TrackMetadata(bytes, start, end, subtitle) {
    const { title: metadataTitle, user } = readMetadata(bytes, start, end);
    let title = metadataTitle;
    let name;
    let forced = false;
    let commentary = false;
    for (const entry of user) {
        if (entry.type === 'tnam') {
            const value = trackName(bytes, entry);
            if (name === undefined)
                name = value;
        }
        else if (entry.type === 'name') {
            const value = decode(bytes.subarray(entry.payload, entry.end));
            if (title === undefined)
                title = value;
        }
        else if (entry.type === 'kind') {
            demuxAssert(entry.end - entry.payload >= 6 && u32(bytes, entry.payload) === 0, 'invalid kind box header');
            const scheme = terminated(bytes, entry.payload + 4, entry.end);
            const value = terminated(bytes, scheme.next, entry.end);
            if (scheme.text === roleScheme) {
                if (subtitle && value.text === 'forced-subtitle')
                    forced = true;
                if (value.text === 'commentary')
                    commentary = true;
            }
        }
    }
    return { name, title, forced, commentary };
}
export function readMP4HandlerName(bytes, offset, size) {
    const start = offset + 32;
    const end = offset + size;
    if (start >= end)
        return;
    if (fourcc(bytes, offset + 12) === 'mhlr' || fourcc(bytes, offset + 12) === 'dhlr') {
        const length = bytes[start];
        demuxAssert(length <= end - start - 1, 'QuickTime handler name is truncated');
        if (!length)
            return;
        const value = bytes.subarray(start + 1, start + 1 + length);
        try {
            return utf8.decode(value);
        }
        catch {
            return decode(value, 'macintosh');
        }
    }
    const zero = bytes.indexOf(0, start);
    const text = decode(bytes.subarray(start, zero < 0 || zero >= end ? end : zero));
    return text || undefined;
}
function atom(type, ...parts) {
    const length = parts.reduce((total, part) => total + part.length, 8);
    if (length > 0xffffffff)
        throw new MediaForgeError('MP4 metadata exceeds the box size limit', 'MUX');
    const out = new Uint8Array(length);
    new DataView(out.buffer).setUint32(0, length);
    for (let index = 0; index < 4; index++)
        out[index + 4] = type.charCodeAt(index);
    let offset = 8;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function word(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    return out;
}
export function validateMP4TrackMetadata(track) {
    if (track.forced && track.type !== 'subtitle')
        throw new MediaForgeError('MP4 forced disposition requires a subtitle track', 'MUX');
    if (track.name !== undefined && (typeof track.name !== 'string' || track.name.includes('\0')))
        throw new MediaForgeError('MP4 track name must be a string without NUL', 'MUX');
    if (track.title !== undefined && typeof track.title !== 'string')
        throw new MediaForgeError('MP4 track title must be a string', 'MUX');
    for (const value of [track.default, track.forced, track.commentary]) {
        if (value !== undefined && typeof value !== 'boolean')
            throw new MediaForgeError('MP4 track dispositions must be booleans', 'MUX');
    }
}
export function snapshotMP4TrackMetadata(track, type) {
    if (track === undefined)
        return undefined;
    if (!track || typeof track !== 'object' || Array.isArray(track))
        throw new MediaForgeError('Expected MP4 track metadata', 'MUX');
    const { name, title, default: isDefault, forced, commentary, language } = track;
    const snapshot = { type, name, title, default: isDefault, forced, commentary, language };
    validateMP4TrackMetadata(snapshot);
    return Object.freeze(snapshot);
}
export function mp4TrackFlags(track, flags = 3) {
    return track?.default === false ? flags & ~1 : flags | 1;
}
export function mp4HandlerName(name) {
    return encoder.encode(`${name ?? ''}\0`);
}
export function mp4TitleBox(title, quickTime = false) {
    if (title === undefined)
        return empty;
    if (typeof title !== 'string')
        throw new MediaForgeError('MP4 movie title must be a string', 'MUX');
    const value = encoder.encode(title);
    if (quickTime && value.length <= 0xffff) {
        const header = new Uint8Array(4);
        const view = new DataView(header.buffer);
        view.setUint16(0, value.length);
        view.setUint16(2, 0x55c4);
        return atom('udta', atom('©nam', header, value));
    }
    return atom('udta', atom('meta', word(0), atom('hdlr', word(0), word(0), encoder.encode('mdir'), encoder.encode('appl'), new Uint8Array(9)), atom('ilst', atom('©nam', atom('data', word(1), word(0), value)))));
}
function trackTitleMetadata(title, quickTime) {
    return atom('meta', ...(quickTime ? [] : [word(0)]), atom('hdlr', word(0), word(0), encoder.encode('mdta'), new Uint8Array(13)), atom('keys', word(0), word(1), atom('mdta', encoder.encode(titleKey))), atom('ilst', atom('\0\0\0\x01', atom('data', word(1), word(0), encoder.encode(title)))));
}
export function mp4TrackMetadataBoxes(track, quickTime = false) {
    if (!track)
        return [];
    validateMP4TrackMetadata(track);
    const user = [];
    if (track.name !== undefined) {
        const language = /^[a-z]{3}$/.test(track.language ?? '') ? track.language : 'und';
        const header = new Uint8Array(6);
        new DataView(header.buffer).setUint16(4, ((language.charCodeAt(0) - 96) << 10) |
            ((language.charCodeAt(1) - 96) << 5) |
            (language.charCodeAt(2) - 96));
        user.push(atom('tnam', header, mp4HandlerName(track.name)));
    }
    if (track.forced)
        user.push(atom('kind', word(0), encoder.encode(`${roleScheme}\0forced-subtitle\0`)));
    if (track.commentary)
        user.push(atom('kind', word(0), encoder.encode(`${roleScheme}\0commentary\0`)));
    if (track.title !== undefined)
        user.push(atom('name', encoder.encode(track.title)));
    return [
        ...(user.length ? [atom('udta', ...user)] : []),
        ...(track.title === undefined ? [] : [trackTitleMetadata(track.title, quickTime)]),
    ];
}
