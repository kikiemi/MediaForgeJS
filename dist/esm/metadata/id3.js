import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { metadataLimit, normalizeMetadata } from './normalized.js';
const encoder = new TextEncoder();
const names = {
    TIT2: 'title',
    TPE1: 'artist',
    TPE2: 'albumArtist',
    TALB: 'album',
    TRCK: 'track',
    TPOS: 'disc',
    TCON: 'genre',
    TDRC: 'date',
    TYER: 'year',
    TCOP: 'copyright',
    TCOM: 'composer',
    TENC: 'encoder',
    TSSE: 'encodingSoftware',
    TLAN: 'language',
    TBPM: 'bpm',
};
function ascii(bytes) {
    let result = '';
    for (const byte of bytes)
        result += String.fromCharCode(byte);
    return result;
}
function syncsafe(bytes, offset) {
    if (offset + 4 > bytes.length ||
        (bytes[offset] | bytes[offset + 1] | bytes[offset + 2] | bytes[offset + 3]) & 0x80) {
        throw new MediaForgeError('Invalid ID3 synchsafe integer', 'DEMUX');
    }
    return bytes[offset] * 2 ** 21 + bytes[offset + 1] * 2 ** 14 + bytes[offset + 2] * 128 + bytes[offset + 3];
}
function putSyncsafe(bytes, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff)
        throw new MediaForgeError('ID3 size exceeds 28 bits', 'INPUT');
    for (let i = 3; i >= 0; i--) {
        bytes[offset + i] = value & 127;
        value = Math.floor(value / 128);
    }
}
function concat(parts, maxBytes = 16 * 1024 * 1024) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (length > maxBytes)
        throw new MediaForgeError('ID3 output exceeds maxBytes', 'INPUT');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}
function text(bytes, encoding) {
    if (encoding === 0)
        return ascii(bytes);
    if (encoding === 3)
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (encoding !== 1 && encoding !== 2)
        throw new MediaForgeError('Unknown ID3 text encoding', 'DEMUX');
    if (bytes.length % 2)
        throw new MediaForgeError('Truncated ID3 UTF-16 text', 'DEMUX');
    if (encoding === 2)
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    if (bytes.length === 0)
        return '';
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    throw new MediaForgeError('ID3 UTF-16 text is missing its byte order mark', 'DEMUX');
}
function terminated(bytes, offset, encoding) {
    const width = encoding === 1 || encoding === 2 ? 2 : 1;
    for (let end = offset; end + width <= bytes.length; end += width) {
        if (bytes[end] === 0 && (width === 1 || bytes[end + 1] === 0)) {
            return { value: text(bytes.subarray(offset, end), encoding), end: end + width };
        }
    }
    throw new MediaForgeError('Unterminated ID3 string', 'DEMUX');
}
function decodedData(frame, version) {
    if (frame.flags & ~(version === 3 ? 0xe0e0 : 0x704f))
        return null;
    const flags = frame.flags & 255;
    if (version === 3 ? flags & 0xc0 : flags & 0x0c)
        return null;
    let bytes = frame.data;
    if (version === 4 && flags & 2) {
        const copy = new Uint8Array(bytes.length);
        let length = 0;
        for (let i = 0; i < bytes.length; i++) {
            copy[length++] = bytes[i];
            if (bytes[i] === 255 && bytes[i + 1] === 0)
                i++;
        }
        bytes = copy.subarray(0, length);
    }
    const prefix = (version === 3 ? flags & 0x20 : flags & 0x40) ? 1 : 0;
    const skip = prefix + (version === 4 && flags & 1 ? 4 : 0);
    if (skip > bytes.length)
        throw new MediaForgeError('Truncated ID3 frame prefix', 'DEMUX');
    return bytes.subarray(skip);
}
function readFrame(bytes, offset, version) {
    if (bytes.length - offset < 10)
        throw new MediaForgeError('Truncated ID3 frame header', 'DEMUX');
    const id = ascii(bytes.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id))
        throw new MediaForgeError('Invalid ID3 frame identifier', 'DEMUX');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = version === 4 ? syncsafe(bytes, offset + 4) : view.getUint32(offset + 4);
    if (length > bytes.length - offset - 10)
        throw new MediaForgeError('Truncated ID3 frame payload', 'DEMUX');
    const end = offset + 10 + length;
    return {
        frame: { id, flags: view.getUint16(offset + 8), data: new Uint8Array(bytes.subarray(offset + 10, end)) },
        end,
    };
}
function frameBytes(frame, version) {
    if (!/^[A-Z0-9]{4}$/.test(frame.id) ||
        !Number.isInteger(frame.flags) ||
        frame.flags < 0 ||
        frame.flags > 65535 ||
        !(frame.data instanceof Uint8Array) ||
        frame.data.length > 16 * 1024 * 1024) {
        throw new MediaForgeError('Invalid ID3 frame', 'INPUT');
    }
    const result = new Uint8Array(10 + frame.data.length);
    result.set(encoder.encode(frame.id));
    const view = new DataView(result.buffer);
    if (version === 4)
        putSyncsafe(result, 4, frame.data.length);
    else
        view.setUint32(4, frame.data.length);
    view.setUint16(8, frame.flags);
    result.set(frame.data, 10);
    return result;
}
function project(frame, version, metadata, maxEntries) {
    const bytes = decodedData(frame, version);
    if (!bytes)
        return false;
    const source = `id3v2.${version}:${frame.id}`;
    const add = (key, value, language) => {
        if (metadata.entries.length >= maxEntries)
            throw new MediaForgeError('ID3 text values exceed maxEntries', 'INPUT');
        metadata.entries.push({ key, value: { type: 'text', value }, source, ...(language ? { language } : {}) });
    };
    const values = (value) => value.replace(/\0+$/, '').split('\0', maxEntries - metadata.entries.length + 1);
    if (frame.id.startsWith('T') && frame.id !== 'TXXX') {
        for (const value of values(text(bytes.subarray(1), bytes[0])))
            add(names[frame.id] ?? `id3:${frame.id}`, value);
        return true;
    }
    if (frame.id === 'TXXX') {
        const description = terminated(bytes, 1, bytes[0]);
        for (const value of values(text(bytes.subarray(description.end), bytes[0]))) {
            add(description.value, value);
        }
        return true;
    }
    if (frame.id === 'COMM' || frame.id === 'USLT') {
        if (bytes.length < 4)
            throw new MediaForgeError('Truncated ID3 localized text', 'DEMUX');
        const description = terminated(bytes, 4, bytes[0]);
        const key = frame.id === 'COMM' ? 'comment' : 'lyrics';
        add(description.value ? `${key}:${description.value}` : key, text(bytes.subarray(description.end), bytes[0]).replace(/\0+$/, ''), ascii(bytes.subarray(1, 4)));
        return true;
    }
    if (frame.id.startsWith('W')) {
        if (frame.id === 'WXXX') {
            const description = terminated(bytes, 1, bytes[0]);
            add(`url:${description.value}`, ascii(bytes.subarray(description.end)).replace(/\0+$/, ''));
        }
        else
            add(`id3:${frame.id}`, ascii(bytes).replace(/\0+$/, ''));
        return true;
    }
    if (frame.id === 'APIC') {
        const mime = terminated(bytes, 1, 0);
        if (mime.end >= bytes.length)
            throw new MediaForgeError('Truncated ID3 picture', 'DEMUX');
        const description = terminated(bytes, mime.end + 1, bytes[0]);
        metadata.entries.push({
            key: `artwork:${bytes[mime.end]}`,
            source,
            value: {
                type: 'binary',
                value: new Uint8Array(bytes.subarray(description.end)),
                mimeType: mime.value,
                description: description.value,
            },
        });
        return true;
    }
    if (frame.id === 'CHAP') {
        const identifier = terminated(bytes, 0, 0);
        if (bytes.length - identifier.end < 16)
            throw new MediaForgeError('Truncated ID3 chapter', 'DEMUX');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const startTime = view.getUint32(identifier.end) / 1000;
        const endMillis = view.getUint32(identifier.end + 4);
        const chapter = {
            id: identifier.value,
            startTime,
            ...(endMillis !== 0xffffffff ? { endTime: endMillis / 1000 } : {}),
        };
        let offset = identifier.end + 16;
        let count = 0;
        while (offset < bytes.length && bytes[offset]) {
            if (++count > 4096)
                throw new MediaForgeError('Excessive ID3 chapter subframes', 'DEMUX');
            const sub = readFrame(bytes, offset, version);
            offset = sub.end;
            if (sub.frame.id === 'TIT2') {
                const payload = decodedData(sub.frame, version);
                if (payload)
                    chapter.title = text(payload.subarray(1), payload[0]).replace(/\0+$/, '');
            }
        }
        metadata.chapters.push(chapter);
        return false;
    }
    return false;
}
export function parseId3Tag(bytes, options = {}) {
    const context = new DiagnosticContext(options, 'compatible');
    const maximum = metadataLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const maxEntries = metadataLimit(options.maxEntries, 100000, 'maxEntries');
    if (bytes.length < 10 || ascii(bytes.subarray(0, 3)) !== 'ID3')
        throw new MediaForgeError('Missing ID3 header', 'DEMUX');
    const version = bytes[3];
    const revision = bytes[4];
    const flags = bytes[5];
    const size = syncsafe(bytes, 6);
    const total = 10 + size + (version === 4 && flags & 16 ? 10 : 0);
    if (total > maximum || total > bytes.length)
        throw new MediaForgeError('Truncated or excessive ID3 tag', 'DEMUX');
    const metadata = { entries: [], chapters: [], opaque: [], diagnostics: [] };
    const tag = { version, revision, flags, frames: [], paddingSize: 0, metadata, diagnostics: [] };
    if ((version !== 3 && version !== 4) || revision !== 0 || flags & ~0x20) {
        context.warn({
            code: 'ID3_OPAQUE_TAG',
            message: 'ID3 version, unsynchronization or extended structure retained as an opaque tag',
            format: 'id3',
        });
        tag.opaqueData = new Uint8Array(bytes.subarray(0, total));
        metadata.opaque.push({ format: `id3v2.${version}`, data: new Uint8Array(tag.opaqueData) });
    }
    else {
        const body = bytes.subarray(10, total);
        let offset = 0;
        while (offset < body.length) {
            if (body[offset] === 0 && body.subarray(offset).every(byte => byte === 0)) {
                tag.paddingSize = body.length - offset;
                break;
            }
            if (tag.frames.length >= maxEntries)
                throw new MediaForgeError('ID3 tag exceeds maxEntries', 'INPUT');
            let parsed;
            try {
                parsed = readFrame(body, offset, version);
            }
            catch (error) {
                context.recover({
                    code: 'ID3_TRAILING_DATA',
                    message: error instanceof Error ? error.message : 'Malformed ID3 frame',
                    format: 'id3',
                    offset: offset + 10,
                });
                tag.trailingData = new Uint8Array(body.subarray(offset));
                break;
            }
            tag.frames.push(parsed.frame);
            let known = false;
            try {
                known = project(parsed.frame, version, metadata, maxEntries);
            }
            catch (error) {
                if (error instanceof MediaForgeError && error.code === 'INPUT')
                    throw error;
                context.recover({
                    code: 'ID3_OPAQUE_FRAME',
                    message: `Frame ${parsed.frame.id}: ${error instanceof Error ? error.message : 'invalid payload'}`,
                    format: 'id3',
                    offset: offset + 10,
                });
            }
            if (!known)
                metadata.opaque.push({
                    format: `id3v2.${version}/frame`,
                    data: new Uint8Array(body.subarray(offset, parsed.end)),
                });
            offset = parsed.end;
        }
    }
    tag.diagnostics = context.warnings;
    metadata.diagnostics = context.warnings;
    return tag;
}
export function writeId3Tag(tag, options = {}) {
    const maximum = metadataLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const maxEntries = metadataLimit(options.maxEntries, 100000, 'maxEntries');
    if (tag.opaqueData) {
        if (tag.frames.length || tag.trailingData || tag.paddingSize || tag.opaqueData.length > maximum) {
            throw new MediaForgeError('Opaque ID3 tags cannot be combined with edited frames', 'INPUT');
        }
        return new Uint8Array(tag.opaqueData);
    }
    if ((tag.version !== 3 && tag.version !== 4) || (tag.revision ?? 0) !== 0 || (tag.flags ?? 0) & ~0x20) {
        throw new MediaForgeError('ID3 writer supports v2.3/v2.4 frames without tag-level transforms', 'INPUT');
    }
    const padding = tag.paddingSize ?? 0;
    if (!Number.isSafeInteger(padding) || padding < 0 || padding > maximum || tag.frames.length > maxEntries) {
        throw new MediaForgeError('Excessive ID3 padding or frame count', 'INPUT');
    }
    let byteLength = 10 + padding + (tag.trailingData?.length ?? 0);
    for (const frame of tag.frames) {
        byteLength += 10 + frame.data.length;
        if (byteLength > maximum)
            throw new MediaForgeError('ID3 output exceeds maxBytes', 'INPUT');
    }
    const parts = tag.frames.map(frame => frameBytes(frame, tag.version));
    if (tag.trailingData)
        parts.push(new Uint8Array(tag.trailingData));
    if (padding)
        parts.push(new Uint8Array(padding));
    const body = concat(parts, maximum - 10);
    const header = new Uint8Array([73, 68, 51, tag.version, 0, tag.flags ?? 0, 0, 0, 0, 0]);
    putSyncsafe(header, 6, body.length);
    return concat([header, body], maximum);
}
function encodedText(value, version, terminate = false) {
    if (value.includes('\0'))
        throw new MediaForgeError('ID3 text cannot contain NUL', 'INPUT');
    if (version === 4)
        return concat([encoder.encode(value), ...(terminate ? [new Uint8Array(1)] : [])]);
    const result = new Uint8Array(2 + value.length * 2 + (terminate ? 2 : 0));
    result.set([255, 254]);
    const view = new DataView(result.buffer);
    for (let i = 0; i < value.length; i++)
        view.setUint16(2 + i * 2, value.charCodeAt(i), true);
    return result;
}
export function createId3Tag(input, options = {}) {
    const version = options.version ?? 4;
    if (version !== 3 && version !== 4)
        throw new MediaForgeError('ID3 version must be 3 or 4', 'INPUT');
    const context = new DiagnosticContext(options, 'compatible');
    const metadata = normalizeMetadata(input, options);
    const frames = [];
    const marker = new Uint8Array([version === 4 ? 3 : 1]);
    const textFrame = (id, value) => ({
        id,
        flags: 0,
        data: concat([marker, encodedText(value, version)]),
    });
    const addEntry = (entry) => {
        if (entry.value.type === 'binary') {
            if (!/^artwork(?::\d+)?$/.test(entry.key)) {
                context.recover({
                    code: 'ID3_VALUE_LOSS',
                    message: `Binary field '${entry.key}' has no ID3 mapping`,
                    format: 'id3',
                });
                return;
            }
            const pictureType = entry.key.includes(':') ? Number(entry.key.split(':')[1]) : 3;
            const mime = entry.value.mimeType ?? 'application/octet-stream';
            if (pictureType > 255 || !/^[\x20-\x7E]+$/.test(mime))
                throw new MediaForgeError('Invalid ID3 picture type or MIME type', 'INPUT');
            frames.push({
                id: 'APIC',
                flags: 0,
                data: concat([
                    marker,
                    encoder.encode(mime),
                    new Uint8Array([0, pictureType]),
                    encodedText(entry.value.description ?? '', version, true),
                    entry.value.value,
                ]),
            });
            return;
        }
        const value = String(entry.value.value);
        if (entry.value.type !== 'text' && entry.value.type !== 'date') {
            context.recover({
                code: 'ID3_TYPE_COERCION',
                message: `Field '${entry.key}' becomes ID3 text`,
                format: 'id3',
            });
        }
        const id = Object.entries(names).find(([frame, key]) => key === entry.key && (version === 4 || frame !== 'TDRC'))?.[0];
        if (id) {
            frames.push(textFrame(id, value));
            return;
        }
        if (entry.key === 'comment' ||
            entry.key.startsWith('comment:') ||
            entry.key === 'lyrics' ||
            entry.key.startsWith('lyrics:')) {
            let language = entry.language ?? 'und';
            if (!/^[a-z]{3}$/i.test(language)) {
                context.recover({
                    code: 'ID3_LANGUAGE_LOSS',
                    message: 'ID3 localized text needs a three-letter ISO-639 language; using und',
                    format: 'id3',
                });
                language = 'und';
            }
            frames.push({
                id: entry.key.startsWith('comment') ? 'COMM' : 'USLT',
                flags: 0,
                data: concat([
                    marker,
                    encoder.encode(language.toLowerCase()),
                    encodedText(entry.key.split(':').slice(1).join(':'), version, true),
                    encodedText(value, version),
                ]),
            });
        }
        else if (/^id3:T[A-Z0-9]{3}$/.test(entry.key))
            frames.push(textFrame(entry.key.slice(4), value));
        else
            frames.push({
                id: 'TXXX',
                flags: 0,
                data: concat([marker, encodedText(entry.key, version, true), encodedText(value, version)]),
            });
    };
    for (const entry of metadata.entries)
        addEntry(entry);
    const opaqueChapters = new Set();
    for (const opaque of metadata.opaque) {
        if (opaque.format !== `id3v2.${version}/frame`) {
            context.recover({
                code: 'ID3_OPAQUE_LOSS',
                message: `Opaque '${opaque.format}' is incompatible with this ID3 tag`,
                format: 'id3',
            });
            continue;
        }
        const parsed = readFrame(opaque.data, 0, version);
        if (parsed.end !== opaque.data.length)
            throw new MediaForgeError('Opaque ID3 frame has trailing bytes', 'INPUT');
        if (parsed.frame.id === 'CHAP')
            opaqueChapters.add(terminated(parsed.frame.data, 0, 0).value);
        frames.push(parsed.frame);
    }
    for (let index = 0; index < metadata.chapters.length; index++) {
        const chapter = metadata.chapters[index];
        const id = chapter.id ?? `chapter-${index + 1}`;
        if (opaqueChapters.has(id)) {
            context.warn({
                code: 'ID3_CHAPTER_OPAQUE',
                message: `Chapter '${id}' retained from its original opaque frame`,
                format: 'id3',
            });
            continue;
        }
        if (!/^[\x01-\x7F]+$/.test(id))
            throw new MediaForgeError('ID3 chapter identifiers must be ASCII', 'INPUT');
        const start = Math.round(chapter.startTime * 1000);
        const end = chapter.endTime === undefined ? 0xffffffff : Math.round(chapter.endTime * 1000);
        if (start > 0xffffffff || end > 0xffffffff)
            throw new MediaForgeError('ID3 chapter times exceed 32-bit milliseconds', 'INPUT');
        const timing = new Uint8Array(16).fill(255);
        const view = new DataView(timing.buffer);
        view.setUint32(0, start);
        view.setUint32(4, end);
        const children = chapter.title !== undefined ? [frameBytes(textFrame('TIT2', chapter.title), version)] : [];
        if (chapter.entries?.length || chapter.language)
            context.recover({
                code: 'ID3_CHAPTER_FIELDS_LOSS',
                message: 'Chapter language and extra normalized entries have no mapping',
                format: 'id3',
            });
        frames.push({
            id: 'CHAP',
            flags: 0,
            data: concat([encoder.encode(id), new Uint8Array(1), timing, ...children]),
        });
    }
    const result = parseId3Tag(writeId3Tag({ version, frames }, options), options);
    result.diagnostics = [...metadata.diagnostics, ...context.warnings, ...result.diagnostics];
    result.metadata.diagnostics = result.diagnostics;
    return result;
}
