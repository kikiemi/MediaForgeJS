import type { AttachedPicture, MediaChapter, MediaTags } from '../../core/model/media';
import { mediaTags } from '../../core/model/media-tags';
import {
    boxes,
    decode,
    ILST_KEYS,
    legacyText,
    metaChildren,
    mp4Language,
    QUICKTIME_KEYS,
    u32,
    userDataBoxes,
} from './metadata';
import type { MetadataBox } from './metadata';
import { dataView, fourcc } from '../../core/bytes/byte-fields';

/** QuickTime metadata keys (mdta) of the common text tags. */
const MDTA_KEYS: Readonly<Record<string, string>> = {
    'com.apple.quicktime.title': 'title',
    'com.apple.quicktime.artist': 'artist',
    'com.apple.quicktime.album': 'album',
    'com.apple.quicktime.comment': 'comment',
    'com.apple.quicktime.description': 'description',
    'com.apple.quicktime.genre': 'genre',
    'com.apple.quicktime.composer': 'composer',
    'com.apple.quicktime.copyright': 'copyright',
    'com.apple.quicktime.creationdate': 'date',
};

/** covr data types of the picture formats. */
const COVER_TYPES: Readonly<Record<number, string>> = {
    13: 'image/jpeg',
    14: 'image/png',
    27: 'image/bmp',
};

/** The ID3v1 genres an iTunes gnre atom numbers from 1, as far as ID3v1 itself defines them. */
const ID3V1_GENRES = (
    'Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New ' +
    'Age|Oldies|Other|Pop|R&B|' +
    'Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death ' +
    'Metal|Pranks|Soundtrack|Euro-Techno|Ambient|' +
    'Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound ' +
    'Clip|Gospel|' +
    'Noise|AlternRock|Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental ' +
    'Rock|Ethnic|Gothic|' +
    'Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern ' +
    'Rock|Comedy|Cult|Gangsta|' +
    'Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New ' +
    'Wave|Psychedelic|Rave|Showtunes|' +
    'Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock'
).split('|');

/**
 * The common key of an item list atom of a meta box with handler `kind`, or 'track', 'disc',
 * 'cover', 'genreIndex'.
 */
function itemKey(kind: string, key: string | undefined): string | undefined {
    if (key === undefined) return undefined;
    if (kind === 'mdta') return MDTA_KEYS[key];
    if (key === 'trkn') return 'track';
    if (key === 'gnre') return 'genreIndex';
    if (key === 'disk') return 'disc';
    if (key === 'covr') return 'cover';
    return (
        ILST_KEYS.find(([atom]) => atom === key)?.[1] ??
        QUICKTIME_KEYS.find(([atom]) => atom === key)?.[1]
    );
}

function metaItems(
    bytes: Uint8Array,
    meta: MetadataBox,
    entries: { key: string; value: string }[],
    pictures: AttachedPicture[],
): void {
    const children = metaChildren(bytes, meta);
    const handler = children.find(entry => entry.type === 'hdlr');
    if (!handler || handler.end - handler.payload < 12) return;
    const kind = fourcc(bytes, handler.payload + 8);
    if (kind !== 'mdta' && kind !== 'mdir') return;
    const names: Array<string | undefined> = [];
    const keys = children.find(entry => entry.type === 'keys');
    if (kind === 'mdta' && keys && keys.end - keys.payload >= 8)
        for (const entry of boxes(bytes, keys.payload + 8, keys.end))
            names.push(
                entry.type === 'mdta'
                    ? decode(bytes.subarray(entry.payload, entry.end))
                    : undefined,
            );

    const list = children.find(entry => entry.type === 'ilst');
    if (!list) return;
    for (const item of boxes(bytes, list.payload, list.end)) {
        const key = itemKey(
            kind,
            kind === 'mdta' ? names[u32(bytes, item.start + 4) - 1] : item.type,
        );
        if (!key) continue;
        for (const value of boxes(bytes, item.payload, item.end)) {
            if (value.type !== 'data' || value.end - value.payload < 8) continue;
            const type = u32(bytes, value.payload) & 0xffffff;
            const data = bytes.subarray(value.payload + 8, value.end);
            if (key === 'cover') {
                if (COVER_TYPES[type] && data.length)
                    pictures.push({ data: data.slice(), mimeType: COVER_TYPES[type]!, type: 3 });
            } else if (key === 'genreIndex') {
                const genre =
                    data.length >= 2 ? ID3V1_GENRES[((data[0]! << 8) | data[1]!) - 1] : undefined;
                if (genre && !entries.some(entry => entry.key === 'genre'))
                    entries.push({ key: 'genre', value: genre });
            } else if (key === 'track' || key === 'disc') {
                if (data.length < 6) continue;
                const view = dataView(data);
                const [number, total] = [view.getUint16(2), view.getUint16(4)];
                if (number)
                    entries.push({ key, value: total ? `${number}/${total}` : String(number) });
            } else if (type === 1 || type === 2) {
                const text = decode(data, type === 1 ? 'utf-8' : 'utf-16be');
                if (!entries.some(entry => entry.key === key)) entries.push({ key, value: text });
            }
        }
    }
}

/**
 * Nero chapters (chpl): start times in 100 ns units and titles; each chapter ends where the next
 * starts.
 */
function neroChapters(bytes: Uint8Array, chpl: MetadataBox): MediaChapter[] {
    const view = dataView(bytes);
    let at = chpl.payload + 4 + (bytes[chpl.payload] ? 4 : 0);
    if (at >= chpl.end) return [];
    const count = bytes[at++]!;
    const chapters: MediaChapter[] = [];
    for (let index = 0; index < count && at + 9 <= chpl.end; index++) {
        const start = Number(view.getBigUint64(at)) / 1e7;
        const length = bytes[at + 8]!;
        if (at + 9 + length > chpl.end) break;
        const title = legacyText(bytes.subarray(at + 9, at + 9 + length), false);
        chapters.push({ start, ...(title ? { title } : {}) });
        at += 9 + length;
    }
    return chapters.map((chapter, index) =>
        index + 1 < chapters.length ? { ...chapter, end: chapters[index + 1]!.start } : chapter,
    );
}

/**
 * The movie's tags: iTunes (mdir) and QuickTime (mdta) item lists, QuickTime user data text atoms,
 * cover art (covr) and Nero chapters (chpl).
 */
export function readMp4Tags(
    bytes: Uint8Array,
    start: number,
    end: number,
    { direct, user } = userDataBoxes(bytes, start, end),
): MediaTags | undefined {
    const entries: { key: string; value: string }[] = [];
    const pictures: AttachedPicture[] = [];
    let chapters: MediaChapter[] = [];
    for (const entry of [...direct, ...user])
        if (entry.type === 'meta') metaItems(bytes, entry, entries, pictures);
    const view = dataView(bytes);
    for (const entry of user) {
        if (entry.type === 'chpl' && entry.end - entry.payload >= 5)
            chapters = neroChapters(bytes, entry);
        const key =
            QUICKTIME_KEYS.find(([atom]) => atom === entry.type)?.[1] ??
            (entry.type === 'cprt' ? 'copyright' : undefined);
        if (!key || entries.some(item => item.key === key) || entry.end - entry.payload < 4)
            continue;
        const length = view.getUint16(entry.payload);
        if (length > entry.end - entry.payload - 4) continue;
        const language = view.getUint16(entry.payload + 2);
        let raw = bytes.subarray(entry.payload + 4, entry.payload + 4 + length);
        const stop = raw.indexOf(0);
        if (stop >= 0) raw = raw.subarray(0, stop);
        entries.push({ key, value: legacyText(raw, language < 0x400) });
    }

    return mediaTags(entries, chapters, pictures);
}

/** The common tags MP4 output keeps: the item list text atoms and track/disc numbers. */
export function mp4KeepsTag(key: string): boolean {
    return key === 'track' || key === 'disc' || ILST_KEYS.some(([, common]) => common === key);
}

/** True when MP4 output keeps `tag`: as an ISO 639-2 code, or as an elng box beside its code. */
export function mp4KeepsLanguage(tag: string | undefined): boolean {
    return tag === undefined || /^[a-z]{3}$/.test(tag) || mp4Language(tag).elng.length > 0;
}

/** The BCP 47 tag of an elng box payload, or undefined when it is empty or malformed. */
export function readMp4ExtendedLanguage(
    bytes: Uint8Array,
    start: number,
    end: number,
): string | undefined {
    if (end - start < 5 || u32(bytes, start) !== 0) return undefined;
    const stop = bytes.indexOf(0, start + 4);
    const tag = String.fromCharCode(
        ...bytes.subarray(start + 4, stop < start + 4 || stop > end ? end : stop),
    );
    return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) && tag !== 'und' ? tag : undefined;
}
