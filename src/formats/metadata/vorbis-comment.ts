import type { AttachedPicture, MediaTags } from '../../core/model/media';
import { mediaTags } from '../../core/model/media-tags';
import { secondsToTicks } from '../../core/model/media-time';
import { dataView } from '../../core/bytes/byte-fields';
import { MAX_TEXT_METADATA_BYTES, decodeMetadataText } from './metadata-text';

const utf8 = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** Common tag keys and their Vorbis comment field names (FLAC, Ogg). */
const VORBIS_FIELDS: readonly (readonly [string, string])[] = [
    ['title', 'TITLE'],
    ['artist', 'ARTIST'],
    ['album', 'ALBUM'],
    ['albumArtist', 'ALBUMARTIST'],
    ['comment', 'COMMENT'],
    ['description', 'DESCRIPTION'],
    ['date', 'DATE'],
    ['genre', 'GENRE'],
    ['composer', 'COMPOSER'],
    ['copyright', 'COPYRIGHT'],
    ['track', 'TRACKNUMBER'],
    ['disc', 'DISCNUMBER'],
];

/**
 * Reads the TITLE field of a Vorbis-style comment payload (vendor string, then length-prefixed
 * KEY=value pairs).
 */
export function vorbisCommentTitle(payload: Uint8Array): string | undefined {
    return vorbisComment(payload, 'TITLE');
}

/**
 * A Vorbis comment LANGUAGE that is an ISO 639 code or BCP 47 tag; free text such as "English" is
 * left out.
 */
export function vorbisCommentLanguage(payload: Uint8Array): string | undefined {
    const language = vorbisComment(payload, 'LANGUAGE')?.trim();
    return language && /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(language) ? language : undefined;
}

/**
 * The FIELD=value entries of a Vorbis comment payload (a vendor string, then a count of
 * length-prefixed entries), up to the first one the payload cuts.
 */
export function vorbisCommentEntries(payload: Uint8Array): Uint8Array[] {
    const entries: Uint8Array[] = [];
    if (payload.length < 8) return entries;
    const view = dataView(payload);
    let offset = 4 + view.getUint32(0, true);
    if (offset + 4 > payload.length) return entries;
    const count = view.getUint32(offset, true);
    offset += 4;
    for (let index = 0; index < count && offset + 4 <= payload.length; index++) {
        const length = view.getUint32(offset, true);
        offset += 4;
        if (length > payload.length - offset) break;
        entries.push(payload.subarray(offset, offset + length));
        offset += length;
    }
    return entries;
}

/** The first value of one Vorbis comment field (case-insensitive name). */
function vorbisComment(payload: Uint8Array, field: string): string | undefined {
    if (payload.length > MAX_TEXT_METADATA_BYTES) return undefined;
    for (const entry of vorbisCommentEntries(payload)) {
        const separator = entry.indexOf(0x3d);
        if (
            separator === field.length &&
            utf8.decode(entry.subarray(0, separator)).toUpperCase() === field
        )
            return decodeMetadataText(entry.subarray(separator + 1));
    }
    return undefined;
}

/** The body of a FLAC PICTURE block (also the payload of a METADATA_BLOCK_PICTURE comment). */
export function flacPicture(bytes: Uint8Array): AttachedPicture | undefined {
    if (bytes.length < 32) return undefined;
    const view = dataView(bytes);
    let at = 0;
    const field = (): Uint8Array | undefined => {
        if (at + 4 > bytes.length) return undefined;
        const length = view.getUint32(at);
        at += 4;
        if (length > bytes.length - at) return undefined;
        return bytes.subarray(at, (at += length));
    };

    const type = view.getUint32(0);
    at = 4;
    const mime = field();
    const description = field();
    at += 16;
    const data = field();
    if (!mime || !description || !data || !data.length) return undefined;
    return {
        data: data.slice(),
        mimeType: String.fromCharCode(...mime),
        ...(description.length ? { description: utf8.decode(description) } : {}),
        type,
    };
}

/** A FLAC PICTURE block body for `picture`; the size and colour fields are left 0 (unknown). */
export function flacPictureBody(picture: AttachedPicture): Uint8Array {
    const mime = encoder.encode(picture.mimeType);
    const description = encoder.encode(picture.description ?? '');
    const out = new Uint8Array(32 + mime.length + description.length + picture.data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, picture.type ?? 3);
    view.setUint32(4, mime.length);
    out.set(mime, 8);
    let at = 8 + mime.length;
    view.setUint32(at, description.length);
    out.set(description, at + 4);
    at += 4 + description.length + 16;
    view.setUint32(at, picture.data.length);
    out.set(picture.data, at + 4);
    return out;
}

function base64(bytes: Uint8Array): string {
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
}

function unbase64(text: string): Uint8Array | undefined {
    try {
        return Uint8Array.from(atob(text.replace(/\s+/g, '')), character =>
            character.charCodeAt(0),
        );
    } catch {
        return undefined;
    }
}

/** HH:MM:SS.mmm of a chapter time, as Vorbis CHAPTERxxx comments state it. */
function chapterTime(seconds: number): string {
    const total = Math.max(0, secondsToTicks(seconds, 1000, 'Vorbis chapter time'));
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    const hours = pad(Math.floor(total / 3600000));
    const minutes = pad(Math.floor(total / 60000) % 60);
    const secs = pad(Math.floor(total / 1000) % 60);
    return `${hours}:${minutes}:${secs}.${pad(total % 1000, 3)}`;
}

/**
 * The tags of a Vorbis comment payload (vendor string, then length-prefixed FIELD=value pairs): the
 * common fields, METADATA_BLOCK_PICTURE pictures and CHAPTERxxx/CHAPTERxxxNAME chapters.
 */
export function vorbisCommentTags(payload: Uint8Array): MediaTags | undefined {
    const entries: { key: string; value: string }[] = [];
    const pictures: AttachedPicture[] = [];
    const chapters = new Map<string, { start?: number; title?: string }>();
    let year: string | undefined;
    for (const field of vorbisCommentEntries(payload)) {
        const entry = utf8.decode(field);
        const separator = entry.indexOf('=');
        if (separator < 1) continue;
        const name = entry.slice(0, separator).toUpperCase();
        const value = entry.slice(separator + 1);
        const key = VORBIS_FIELDS.find(([, field]) => field === name)?.[0];
        const chapter = /^CHAPTER(\d{1,3})(NAME)?$/.exec(name);
        if (key) entries.push({ key, value });
        else if (name === 'YEAR') year ??= value;
        else if (name === 'METADATA_BLOCK_PICTURE') {
            const bytes = unbase64(value);
            const picture = bytes && flacPicture(bytes);
            if (picture) pictures.push(picture);
        } else if (chapter) {
            const item = chapters.get(chapter[1]!) ?? {};
            if (chapter[2]) item.title = value;
            else {
                const time = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
                if (time)
                    item.start = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
            }
            chapters.set(chapter[1]!, item);
        }
    }

    // Some taggers write the year as YEAR; without a DATE field it is the date.
    if (year !== undefined && !entries.some(entry => entry.key === 'date'))
        entries.push({ key: 'date', value: year });

    // ffmpeg writes a comment as DESCRIPTION; without a COMMENT field it is the comment.
    if (!entries.some(entry => entry.key === 'comment'))
        for (const entry of entries) if (entry.key === 'description') entry.key = 'comment';
    const timed = [...chapters.values()].filter(
        (chapter): chapter is { start: number; title?: string } => chapter.start !== undefined,
    );
    return mediaTags(
        entries,
        timed.map(chapter => ({
            start: chapter.start,
            ...(chapter.title !== undefined ? { title: chapter.title } : {}),
        })),
        pictures,
    );
}

/**
 * A Vorbis comment payload (no framing bit) with `vendor`, the fields of `tags` and, for an Ogg
 * stream, its track's `language` as LANGUAGE (which Ogg readers, this library's and ffmpeg's, take
 * as the stream's language).
 */
export function vorbisCommentPayload(
    vendor: string,
    tags: MediaTags | undefined,
    language?: string,
): Uint8Array {
    const fields: string[] = [];
    for (const { key, value } of tags?.entries ?? []) {
        const name = VORBIS_FIELDS.find(([common]) => common === key)?.[1];
        if (name) fields.push(`${name}=${value}`);
    }

    if (language && language !== 'und') fields.push(`LANGUAGE=${language}`);

    tags?.chapters?.forEach((chapter, index) => {
        const number = String(index + 1).padStart(3, '0');
        fields.push(`CHAPTER${number}=${chapterTime(chapter.start)}`);
        if (chapter.title !== undefined) fields.push(`CHAPTER${number}NAME=${chapter.title}`);
    });

    for (const picture of tags?.pictures ?? [])
        fields.push(`METADATA_BLOCK_PICTURE=${base64(flacPictureBody(picture))}`);

    const parts = [encoder.encode(vendor), ...fields.map(field => encoder.encode(field))];
    const out = new Uint8Array(8 + parts.reduce((sum, part) => sum + 4 + part.length, 0) - 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, parts[0]!.length, true);
    out.set(parts[0]!, 4);
    let at = 4 + parts[0]!.length;
    view.setUint32(at, fields.length, true);
    at += 4;
    for (const part of parts.slice(1)) {
        view.setUint32(at, part.length, true);
        out.set(part, at + 4);
        at += 4 + part.length;
    }
    return out;
}

/** True when the Vorbis comment writer has a field for `key`. */
export function vorbisCommentKeeps(key: string): boolean {
    return VORBIS_FIELDS.some(([common]) => common === key);
}
