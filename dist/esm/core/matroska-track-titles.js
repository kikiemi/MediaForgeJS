import { MediaForgeError } from './errors.js';
import { MATROSKA_METADATA_LIMIT, matroskaTagsElement, parseMatroskaTags } from './matroska-tags.js';
function fields(bytes) {
    const output = [];
    let offset = 0;
    const vint = (id) => {
        let width = 1;
        let mask = 0x80;
        while (!(bytes[offset] & mask)) {
            width++;
            mask >>= 1;
        }
        let value = id ? bytes[offset++] : bytes[offset++] & (mask - 1);
        for (let i = 1; i < width; i++)
            value = value * 256 + bytes[offset++];
        return value;
    };
    while (offset < bytes.length) {
        const id = vint(true);
        const size = vint(false);
        output.push({ id, bytes: bytes.subarray(offset, offset + size) });
        offset += size;
    }
    return output;
}
function titles(tags) {
    const result = new Map();
    const ambiguous = new Set();
    const decoder = new TextDecoder();
    const text = (bytes) => decoder.decode(bytes).replace(/\0+$/, '');
    for (const tag of tags) {
        if (!tag.targets.length || tag.targets.some(target => target.kind !== 'track' || target.uid === 0n))
            continue;
        for (const field of fields(fields(tag.bytes)[0].bytes)) {
            if (field.id !== 0x67c8)
                continue;
            const simple = fields(field.bytes);
            const name = simple.find(item => item.id === 0x45a3);
            const value = simple.find(item => item.id === 0x4487);
            const language = simple.find(item => item.id === 0x447a || item.id === 0x447b);
            const isDefault = simple.find(item => item.id === 0x4484);
            if (!name ||
                text(name.bytes) !== 'TITLE' ||
                !value ||
                (language && !['', 'und'].includes(text(language.bytes))) ||
                (isDefault && !isDefault.bytes.some(byte => byte !== 0)))
                continue;
            const title = text(value.bytes);
            for (const { uid } of tag.targets) {
                if (result.has(uid) && result.get(uid) !== title)
                    ambiguous.add(uid);
                result.set(uid, title);
            }
        }
    }
    for (const uid of ambiguous)
        result.delete(uid);
    return result;
}
export function readMatroskaTrackTitles(bytes) {
    return bytes ? titles(parseMatroskaTags(bytes).tags) : new Map();
}
export function preservesMatroskaTrackTitles(bytes, tracks) {
    const parsed = parseMatroskaTags(bytes);
    if (parsed.unsupported)
        return false;
    const values = new Map(tracks.map(track => [track.matroskaTrackUid, track.title]));
    const text = new TextDecoder();
    return parsed.tags.every(tag => {
        const mapped = titles([tag]);
        if (!tag.targets.length ||
            tag.targets.some(target => target.kind !== 'track' ||
                !mapped.has(target.uid) ||
                mapped.get(target.uid) !== values.get(target.uid)))
            return false;
        return fields(fields(tag.bytes)[0].bytes).every(field => {
            if (field.id === 0xec || field.id === 0xbf)
                return true;
            if (field.id === 0x63c0)
                return fields(field.bytes).every(target => [0x63c5, 0xec, 0xbf].includes(target.id));
            if (field.id !== 0x67c8)
                return false;
            return fields(field.bytes).every(item => {
                if (item.id === 0x45a3)
                    return text.decode(item.bytes).replace(/\0+$/, '') === 'TITLE';
                if (item.id === 0x447a || item.id === 0x447b)
                    return ['und', ''].includes(text.decode(item.bytes).replace(/\0+$/, ''));
                if (item.id === 0x4484)
                    return item.bytes.some(byte => byte !== 0);
                return [0x4487, 0xec, 0xbf].includes(item.id);
            });
        });
    });
}
function element(id, data) {
    let width = 1;
    while (data.length >= 2 ** (7 * width) - 1)
        width++;
    const output = new Uint8Array(id.length + width + data.length);
    output.set(id);
    let size = data.length;
    for (let i = width - 1; i >= 0; i--) {
        output[id.length + i] = size % 256;
        size = Math.floor(size / 256);
    }
    output[id.length] |= 1 << (8 - width);
    output.set(data, id.length + width);
    return output;
}
function concat(...items) {
    const output = new Uint8Array(items.reduce((size, bytes) => size + bytes.length, 0));
    let offset = 0;
    for (const bytes of items) {
        output.set(bytes, offset);
        offset += bytes.length;
    }
    return output;
}
export function mergeMatroskaTrackTitles(bytes, tracks) {
    const parsed = bytes ? parseMatroskaTags(bytes) : { tags: [], unsupported: false };
    if (parsed.unsupported)
        throw new MediaForgeError('Invalid Matroska title metadata', 'FORMAT');
    const existing = titles(parsed.tags);
    const tags = [...parsed.tags];
    for (const { matroskaTrackUid: uid, title } of tracks) {
        if (title === undefined)
            continue;
        if (typeof title !== 'string' ||
            title.includes('\0') ||
            title.length > MATROSKA_METADATA_LIMIT ||
            typeof uid !== 'bigint' ||
            uid < 1n ||
            uid > 0xffffffffffffffffn)
            throw new MediaForgeError('Invalid Matroska track title or UID', 'FORMAT');
        if (existing.has(uid)) {
            if (existing.get(uid) !== title)
                throw new MediaForgeError('Conflicting Matroska track titles', 'FORMAT');
            continue;
        }
        const uidBytes = new Uint8Array(8);
        new DataView(uidBytes.buffer).setBigUint64(0, uid);
        const value = new TextEncoder().encode(title);
        if (value.length > MATROSKA_METADATA_LIMIT)
            throw new MediaForgeError('Matroska track title is too large', 'FORMAT');
        tags.push({
            bytes: element([0x73, 0x73], concat(element([0x63, 0xc0], element([0x63, 0xc5], uidBytes)), element([0x67, 0xc8], concat(element([0x45, 0xa3], new Uint8Array([0x54, 0x49, 0x54, 0x4c, 0x45])), element([0x44, 0x87], value))))),
        });
        existing.set(uid, title);
    }
    return matroskaTagsElement(tags);
}
