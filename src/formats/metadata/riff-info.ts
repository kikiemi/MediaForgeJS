import type { MediaTags } from '../../core/model/media';
import { mediaTags } from '../../core/model/media-tags';
import { dataView, fourcc } from '../../core/bytes/byte-fields';
import { decodeMetadataText } from './metadata-text';

const utf8 = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** Common tag keys and their RIFF INFO chunk IDs (WAV, AVI), as ffmpeg maps them. */
const INFO_FIELDS: readonly (readonly [string, string])[] = [
    ['title', 'INAM'],
    ['artist', 'IART'],
    ['album', 'IPRD'],
    ['comment', 'ICMT'],
    ['date', 'ICRD'],
    ['genre', 'IGNR'],
    ['copyright', 'ICOP'],
    ['track', 'IPRT'],
];

/** Reads INAM from a RIFF LIST/INFO payload (fourcc, size, text chunks with even padding). */
export function riffInfoTitle(payload: Uint8Array): string | undefined {
    if (payload.length < 4 || fourcc(payload) !== 'INFO') return undefined;
    const view = dataView(payload);
    for (let offset = 4; offset + 8 <= payload.length;) {
        const size = view.getUint32(offset + 4, true);
        if (size > payload.length - offset - 8) return undefined;
        if (fourcc(payload, offset) === 'INAM')
            return decodeMetadataText(payload.subarray(offset + 8, offset + 8 + size));
        offset += 8 + size + (size & 1);
    }
    return undefined;
}

/** The common tags of a RIFF LIST/INFO payload (after the 'INFO' type). */
export function riffInfoTags(payload: Uint8Array): MediaTags | undefined {
    const view = dataView(payload);
    const entries: { key: string; value: string }[] = [];
    for (let at = 0; at + 8 <= payload.length;) {
        const id = fourcc(payload, at);
        const size = view.getUint32(at + 4, true);
        if (size > payload.length - at - 8) break;
        const key = INFO_FIELDS.find(([, field]) => field === id)?.[0];
        const value = utf8.decode(payload.subarray(at + 8, at + 8 + size)).replace(/\0+$/, '');
        if (key && value.trim()) entries.push({ key, value });
        at += 8 + size + (size & 1);
    }
    return mediaTags(entries);
}

/**
 * A complete RIFF LIST/INFO chunk with the text tags RIFF INFO has fields for, or undefined when
 * there are none.
 */
export function riffInfoChunk(tags: MediaTags | undefined): Uint8Array | undefined {
    const fields = (tags?.entries ?? []).flatMap(({ key, value }) => {
        const id = INFO_FIELDS.find(([common]) => common === key)?.[1];
        return id ? [[id, encoder.encode(`${value}\0`)] as const] : [];
    });
    if (!fields.length) return undefined;

    const size = 4 + fields.reduce((sum, [, text]) => sum + 8 + text.length + (text.length & 1), 0);
    const out = new Uint8Array(8 + size);
    const view = new DataView(out.buffer);
    out.set(encoder.encode('LIST'), 0);
    view.setUint32(4, size, true);
    out.set(encoder.encode('INFO'), 8);

    let at = 12;
    for (const [id, text] of fields) {
        out.set(encoder.encode(id), at);
        view.setUint32(at + 4, text.length, true);
        out.set(text, at + 8);
        at += 8 + text.length + (text.length & 1);
    }
    return out;
}

/** True when RIFF INFO has a field for `key`. */
export function riffInfoKeeps(key: string): boolean {
    return INFO_FIELDS.some(([common]) => common === key);
}
