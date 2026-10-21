import { demuxAssert } from '../../core/errors/demux-guard';
import { DEMUX_LIMITS } from '../shared/demux-budget';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { iso639Language } from '../shared/language';
import { isoBox, uint32 } from '../shared/iso-box';
import type { MediaTags } from '../../core/model/media';
import { dataView, fourcc } from '../../core/bytes/byte-fields';

export interface MetadataBox {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly payload: number;
}

export interface Mp4TrackMetadata {
    readonly type?: string;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly commentary?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly language?: string;
    /** The 'lhvC', 'vexu' and 'hfov' boxes of a copied spatial video. */
    readonly spatialBoxes?: Uint8Array;
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const roleScheme = 'urn:mpeg:dash:role:2011';
const titleKey = 'com.apple.quicktime.title';
const empty = new Uint8Array(0);

export function u32(bytes: Uint8Array, offset: number): number {
    // A read past the bytes fails as a DataView read does.
    if (!(offset >= 0 && offset + 4 <= bytes.length)) return dataView(bytes).getUint32(offset);
    return (
        ((bytes[offset]! << 24) |
            (bytes[offset + 1]! << 16) |
            (bytes[offset + 2]! << 8) |
            bytes[offset + 3]!) >>>
        0
    );
}

export function boxes(
    bytes: Uint8Array,
    start: number,
    end: number,
    userData = false,
): MetadataBox[] {
    const found: MetadataBox[] = [];
    for (let position = start; position < end;) {
        if (userData && end - position === 4 && u32(bytes, position) === 0) break;
        demuxAssert(position + 8 <= end, 'MP4 metadata box header is truncated');
        let size = u32(bytes, position);
        let header = 8;
        if (size === 1) {
            demuxAssert(position + 16 <= end, 'MP4 metadata extended box header is truncated');
            size = u32(bytes, position + 8) * 0x100000000 + u32(bytes, position + 12);
            header = 16;
        } else if (size === 0) size = end - position;

        demuxAssert(
            Number.isSafeInteger(size) && size >= header && size <= end - position,
            'MP4 metadata box extends past its parent',
        );
        demuxAssert(
            found.length < DEMUX_LIMITS.maxBoxesPerRange,
            'MP4 metadata has too many boxes',
        );
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

/** The boxes of a movie or track box (`direct`) and of its udta boxes. */
export interface UserDataBoxes {
    readonly direct: readonly MetadataBox[];
    readonly user: readonly MetadataBox[];
}

/** The boxes from `start` to `end` of a movie or track box (`direct`) and of its udta boxes. */
export function userDataBoxes(bytes: Uint8Array, start: number, end: number): UserDataBoxes {
    const direct = boxes(bytes, start, end);
    const user: MetadataBox[] = [];
    for (const entry of direct)
        if (entry.type === 'udta')
            for (const child of boxes(bytes, entry.payload, entry.end, true)) user.push(child);
    return { direct, user };
}

/** The boxes of a meta box: the ISO form starts with version and flags, the QuickTime form not. */
export function metaChildren(bytes: Uint8Array, meta: MetadataBox): MetadataBox[] {
    let start = meta.payload;
    demuxAssert(start + 4 <= meta.end, 'meta box is truncated');
    if (u32(bytes, start) === 0) start += 4;
    return boxes(bytes, start, meta.end);
}

export function decode(bytes: Uint8Array, encoding = 'utf-8'): string {
    try {
        return (encoding === 'utf-8' ? utf8 : new TextDecoder(encoding, { fatal: true })).decode(
            bytes,
        );
    } catch {
        throw new DemuxError(`Invalid ${encoding} in MP4 metadata`);
    }
}

function terminated(bytes: Uint8Array, start: number, end: number): { text: string; next: number } {
    const stop = bytes.indexOf(0, start);
    demuxAssert(stop >= start && stop < end, 'MP4 metadata string has no terminator');
    return { text: decode(bytes.subarray(start, stop)), next: stop + 1 };
}

function trackName(bytes: Uint8Array, name: MetadataBox): string {
    demuxAssert(name.end - name.payload >= 7, 'tnam track name is truncated');
    const start = name.payload + 6;
    if (
        (bytes[start] === 0xfe && bytes[start + 1] === 0xff) ||
        (bytes[start] === 0xff && bytes[start + 1] === 0xfe)
    ) {
        let stop = start + 2;
        while (stop + 1 < name.end && (bytes[stop] !== 0 || bytes[stop + 1] !== 0)) stop += 2;
        demuxAssert(stop + 1 < name.end, 'UTF-16 tnam track name has no terminator');
        return decode(
            bytes.subarray(start + 2, stop),
            bytes[start] === 0xfe ? 'utf-16be' : 'utf-16le',
        );
    }
    return terminated(bytes, start, name.end).text;
}

function metadataTitle(bytes: Uint8Array, meta: MetadataBox): string | undefined {
    const entries = metaChildren(bytes, meta);
    const handler = entries.find(entry => entry.type === 'hdlr');
    if (!handler) return;
    demuxAssert(handler.end - handler.payload >= 24, 'metadata hdlr is truncated');
    const kind = fourcc(bytes, handler.payload + 8);
    if (kind !== 'mdta' && kind !== 'mdir') return;
    const names: Array<string | undefined> = [];
    const keys = entries.find(entry => entry.type === 'keys');
    if (kind === 'mdta' && keys) {
        demuxAssert(
            keys.end - keys.payload >= 8 && u32(bytes, keys.payload) === 0,
            'invalid metadata keys header',
        );
        const keyEntries = boxes(bytes, keys.payload + 8, keys.end);
        demuxAssert(
            keyEntries.length === u32(bytes, keys.payload + 4),
            'metadata keys count does not match its entries',
        );
        for (const entry of keyEntries)
            names.push(
                entry.type === 'mdta'
                    ? decode(bytes.subarray(entry.payload, entry.end))
                    : undefined,
            );
    }

    const list = entries.find(entry => entry.type === 'ilst');
    if (!list) return;
    for (const entry of boxes(bytes, list.payload, list.end)) {
        const key = kind === 'mdta' ? names[u32(bytes, entry.start + 4) - 1] : entry.type;
        const isTitle = key === titleKey || key === 'title' || key === '©nam';
        if (!isTitle) continue;
        for (const value of boxes(bytes, entry.payload, entry.end)) {
            if (value.type !== 'data') continue;
            demuxAssert(value.end - value.payload >= 8, 'metadata data value is truncated');
            const encoding = u32(bytes, value.payload);
            if (encoding === 1 || encoding === 2)
                return decode(
                    bytes.subarray(value.payload + 8, value.end),
                    encoding === 1 ? 'utf-8' : 'utf-16be',
                );
        }
    }
}

function readMetadata(
    bytes: Uint8Array,
    { direct, user }: UserDataBoxes,
): { title?: string; user: readonly MetadataBox[] } {
    let title: string | undefined;
    for (const entry of [...direct, ...user]) {
        if (entry.type !== 'meta') continue;
        const value = metadataTitle(bytes, entry);
        if (title === undefined) title = value;
    }
    for (const entry of user) {
        if (entry.type !== '©nam') continue;
        demuxAssert(entry.end - entry.payload >= 4, 'QuickTime title is truncated');
        const view = dataView(bytes);
        const length = view.getUint16(entry.payload);
        demuxAssert(
            length <= entry.end - entry.payload - 4,
            'QuickTime title extends past its box',
        );
        const language = view.getUint16(entry.payload + 2);
        let raw = bytes.subarray(entry.payload + 4, entry.payload + 4 + length);

        // Some writers count a C terminator in the text length; the text ends there.
        const stop = raw.indexOf(0);
        if (stop >= 0) raw = raw.subarray(0, stop);
        const value = decode(raw, language < 0x400 ? 'macintosh' : 'utf-8');
        if (title === undefined) title = value;
    }
    return { title, user };
}

/** The title of a movie or track box from `start` to `end`, whose boxes `walked` are when known. */
export function readMp4Title(
    bytes: Uint8Array,
    start: number,
    end: number,
    walked = userDataBoxes(bytes, start, end),
): string | undefined {
    return readMetadata(bytes, walked).title;
}

/**
 * iTunes gapless information (the com.apple.iTunes iTunSMPB tag), counted in coded samples of the
 * AAC core.
 */
export interface Mp4GaplessInfo {
    /** Encoder delay at the start. */
    readonly priming: number;
    /** Padding after the last valid sample. */
    readonly padding: number;
    /** Valid samples between them; 0 when the tag leaves it out. */
    readonly validSamples: number;
}

function freeformValue(bytes: Uint8Array, entry: MetadataBox): { name?: string; text?: string } {
    let name: string | undefined;
    let text: string | undefined;
    for (const child of boxes(bytes, entry.payload, entry.end)) {
        if (child.type === 'name' && child.end - child.payload >= 4)
            name = legacyText(bytes.subarray(child.payload + 4, child.end), false);
        else if (child.type === 'data' && child.end - child.payload >= 8 && text === undefined)
            text = legacyText(bytes.subarray(child.payload + 8, child.end), false);
    }
    return { name, text };
}

/**
 * The iTunSMPB gapless tag of a movie ("00000000 delay padding total ..." in hexadecimal words), or
 * undefined when it is absent or unreadable; the caller checks the counts against the coded
 * samples.
 */
export function readMp4GaplessInfo(
    bytes: Uint8Array,
    start: number,
    end: number,
    { direct, user } = userDataBoxes(bytes, start, end),
): Mp4GaplessInfo | undefined {
    for (const meta of [...direct, ...user]) {
        if (meta.type !== 'meta') continue;
        const list = metaChildren(bytes, meta).find(entry => entry.type === 'ilst');
        if (!list) continue;
        for (const entry of boxes(bytes, list.payload, list.end)) {
            if (entry.type !== '----') continue;
            const { name, text } = freeformValue(bytes, entry);
            if (name !== 'iTunSMPB' || text === undefined) continue;
            const words = text.trim().split(/\s+/);
            if (
                words.length < 4 ||
                !words.slice(0, 4).every(word => /^[0-9a-f]{1,16}$/i.test(word))
            )
                return;
            const [priming, padding, validSamples] = words
                .slice(1, 4)
                .map(word => parseInt(word, 16));
            if (![priming, padding, validSamples].every(value => Number.isSafeInteger(value)))
                return;
            return { priming: priming!, padding: padding!, validSamples: validSamples! };
        }
    }
    return undefined;
}

export function readMp4TrackMetadata(
    bytes: Uint8Array,
    start: number,
    end: number,
    subtitle: boolean,
): Mp4TrackMetadata {
    const { title: metadataTitle, user } = readMetadata(bytes, userDataBoxes(bytes, start, end));
    let title = metadataTitle;
    let name: string | undefined;
    let forced = false;
    let commentary = false;
    for (const entry of user) {
        if (entry.type === 'tnam') {
            const value = trackName(bytes, entry);
            if (name === undefined) name = value;
        } else if (entry.type === 'name') {
            // The text ends at its first NUL, as ffmpeg reads it.
            const payload = bytes.subarray(entry.payload, entry.end);
            const stop = payload.indexOf(0);
            const value = decode(stop < 0 ? payload : payload.subarray(0, stop));
            if (title === undefined) title = value;
        } else if (entry.type === 'kind') {
            demuxAssert(
                entry.end - entry.payload >= 6 && u32(bytes, entry.payload) === 0,
                'invalid kind box header',
            );
            const scheme = terminated(bytes, entry.payload + 4, entry.end);
            const value = terminated(bytes, scheme.next, entry.end);
            if (scheme.text === roleScheme) {
                if (subtitle && value.text === 'forced-subtitle') forced = true;
                if (value.text === 'commentary') commentary = true;
            }
        }
    }

    return { name, title, forced, commentary };
}

export function legacyText(bytes: Uint8Array, quickTime: boolean): string {
    try {
        return utf8.decode(bytes);
    } catch {
        try {
            return new TextDecoder(quickTime ? 'macintosh' : 'windows-1252').decode(bytes);
        } catch {
            return String.fromCharCode(...bytes);
        }
    }
}

function withoutTrailingNul(bytes: Uint8Array): Uint8Array {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return bytes.subarray(0, end);
}

/** Handler names muxers write by default; they do not name the track. */
const DEFAULT_HANDLER_NAMES = new RegExp(
    '^(?:' +
        [
            String.raw`(?:Sound|Video|Subtitle|Text|Hint|Timed ?Text|Meta(?:data)?)Handler`,
            String.raw`Core Media (?:Audio|Video|Text)`,
            String.raw`(?:GPAC|L-SMASH) ISO \w+ Handler`,
            String.raw`ISO Media file produced by Google Inc\.?`,
            String.raw`Apple (?:Video|Sound|Text|Subtitle) Media Handler`,
        ].join('|') +
        ')$',
    'i',
);

/** True for a handler name a muxer writes by default, which names no track. */
export function isDefaultHandlerName(name: string): boolean {
    return DEFAULT_HANDLER_NAMES.test(name);
}

/**
 * The name field of an hdlr box (ISO C string or QuickTime Pascal string, whichever layout fits),
 * or undefined when it is absent or empty. A length byte that exactly fills the field, or is
 * followed only by NUL padding, marks a Pascal string; a printable first byte in an ISO handler
 * prefers the C string. Never throws: the name is optional.
 */
export function readMp4HandlerName(
    bytes: Uint8Array,
    offset: number,
    size: number,
): string | undefined {
    const start = offset + 32;
    const end = Math.min(offset + size, bytes.length);
    if (start >= end) return;
    const field = bytes.subarray(start, end);
    const component = offset + 16 <= bytes.length ? fourcc(bytes, offset + 12) : '';
    const quickTime = component === 'mhlr' || component === 'dhlr';
    const length = field[0]!;
    const content = field.subarray(1, 1 + length);
    const nul = field.indexOf(0);
    const pascal =
        length > 0 &&
        length < field.length &&
        field.subarray(1 + length).every(value => value === 0) &&
        withoutTrailingNul(content).indexOf(0) < 0;

    const exactFit = pascal && 1 + length === field.length && content.indexOf(0) < 0;
    let text: Uint8Array;
    if (pascal && (length < 0x20 || quickTime || exactFit)) text = withoutTrailingNul(content);
    else if (quickTime && nul < 0 && field.length > 256 && ((field.length - 1) & 0xff) === length)
        // Some writers store only the low byte of a longer Pascal length.
        text = field.subarray(1);
    else if (length > 0 && length < 0x20) {
        const rest = field.subarray(1);
        const stop = rest.indexOf(0);
        text = rest.subarray(0, stop < 0 ? rest.length : stop);
    } else text = field.subarray(0, nul < 0 ? field.length : nul);

    return legacyText(text, quickTime) || undefined;
}

export function validateMp4TrackMetadata(track: Mp4TrackMetadata): void {
    if (track.forced && track.type !== 'subtitle')
        throw new MediaForgeError('MP4 forced disposition requires a subtitle track', 'FORMAT');
    if (track.name !== undefined && (typeof track.name !== 'string' || track.name.includes('\0')))
        throw new MediaForgeError('MP4 track name must be a string without NUL', 'FORMAT');
    if (track.title !== undefined && typeof track.title !== 'string')
        throw new MediaForgeError('MP4 track title must be a string', 'FORMAT');
    for (const value of [track.default, track.forced, track.commentary]) {
        if (value !== undefined && typeof value !== 'boolean')
            throw new MediaForgeError('MP4 track dispositions must be booleans', 'FORMAT');
    }

    // Spatial video boxes go into the sample entry as they are: whole boxes of the three types.
    const boxes = track.spatialBoxes;
    let at = 0;
    while (boxes instanceof Uint8Array && at + 8 <= boxes.length && boxes.length <= 0x10000) {
        const size = dataView(boxes).getUint32(at);
        if (size < 8 || !['lhvC', 'vexu', 'hfov'].includes(latin1Text(boxes, at + 4))) break;
        at += size;
    }
    if (boxes !== undefined && (!(boxes instanceof Uint8Array) || at !== boxes.length))
        throw new MediaForgeError(
            "MP4 spatialBoxes must be whole 'lhvC', 'vexu' or 'hfov' boxes",
            'FORMAT',
        );
}

const latin1Text = (bytes: Uint8Array, at: number): string =>
    String.fromCharCode(...bytes.subarray(at, at + 4));

export function mp4TrackFlags(track: Mp4TrackMetadata | undefined, flags = 3): number {
    return track?.default === false ? flags & ~1 : flags | 1;
}

/**
 * hdlr name field: a NUL-terminated UTF-8 string for ISO files, a Pascal string for QuickTime. The
 * Pascal length is kept below 128 bytes (cut at a character boundary) because common readers
 * compare it as a signed char; the full name travels in the track's tnam box.
 */
function mp4HandlerName(name: string | undefined, quickTime = false): Uint8Array {
    if (!quickTime) return encoder.encode(`${name ?? ''}\0`);
    let value = encoder.encode(name ?? '');
    if (value.length > 127) {
        let cut = 127;
        while (cut > 0 && (value[cut]! & 0xc0) === 0x80) cut--;
        value = value.subarray(0, cut);
    }
    const out = new Uint8Array(value.length + 1);
    out[0] = value.length;
    out.set(value, 1);
    return out;
}

/**
 * hdlr payload after version and flags: component type ('mhlr' for QuickTime media), handler type,
 * name.
 */
export function mp4HandlerPayload(
    handler: string,
    name: string | undefined,
    quickTime = false,
): Uint8Array {
    const field = mp4HandlerName(name, quickTime);
    const out = new Uint8Array(20 + field.length);
    if (quickTime) out.set(encoder.encode('mhlr'), 0);
    out.set(encoder.encode(handler), 4);
    out.set(field, 20);
    return out;
}

/**
 * The ISO 639-2 code an mdhd box stores for a language tag ('und' when unknown), and the ISO/IEC
 * 14496-12 elng box that keeps a BCP 47 tag the code cannot state exactly (pt-BR, zh-Hant, es-419).
 */
export function mp4Language(tag: string | undefined): {
    readonly code: string;
    readonly elng: Uint8Array;
} {
    const code = iso639Language(tag?.trim()) ?? 'und';
    if (
        tag === undefined ||
        /^[a-z]{3}$/.test(tag) ||
        code === 'und' ||
        !/^[A-Za-z0-9-]{1,64}$/.test(tag)
    )
        return { code: /^[a-z]{3}$/.test(code) ? code : 'und', elng: empty };
    return { code, elng: isoBox('elng', uint32(0), encoder.encode(`${tag}\0`)) };
}

/** iTunes item list (ilst) atoms of the common text tags. */
export const ILST_KEYS: readonly (readonly [string, string])[] = [
    ['©nam', 'title'],
    ['©ART', 'artist'],
    ['©alb', 'album'],
    ['aART', 'albumArtist'],
    ['©cmt', 'comment'],
    ['desc', 'description'],
    ['©day', 'date'],
    ['©gen', 'genre'],
    ['©wrt', 'composer'],
    ['cprt', 'copyright'],
];

/**
 * QuickTime user data text atoms of the common text tags (MOV), as ffmpeg reads and writes them.
 */
export const QUICKTIME_KEYS: readonly (readonly [string, string])[] = ILST_KEYS.map(
    ([atom, key]) => [key === 'description' ? '©des' : key === 'copyright' ? '©cpy' : atom, key],
);

function quickTimeText(type: string, value: string): Uint8Array {
    const text = encoder.encode(value);
    const header = new Uint8Array(4);
    const view = new DataView(header.buffer);
    view.setUint16(0, text.length);
    view.setUint16(2, 0x55c4);
    return isoBox(type, header, text);
}

function trackNumber(value: string, track: boolean): Uint8Array | undefined {
    const match = /^\s*(\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(value);
    if (!match) return undefined;
    const out = new Uint8Array(track ? 8 : 6);
    const view = new DataView(out.buffer);
    view.setUint16(2, Math.min(0xffff, Number(match[1])));
    view.setUint16(4, Math.min(0xffff, Number(match[2] ?? 0)));
    return out;
}

/** True for the picture types an MP4 covr item states: JPEG, PNG and BMP. */
export function mp4KeepsPicture(mimeType: string): boolean {
    return /^image\/(?:jpeg|png|bmp)$/.test(mimeType);
}

/**
 * The movie user data of MP4 output: the title and tags as an iTunes item list (MOV: QuickTime text
 * atoms, the item list holding what has no text atom), cover art as covr and chapters as Nero chpl.
 * Empty without either.
 */
export function mp4TitleBox(
    title: string | undefined,
    quickTime = false,
    tags?: MediaTags,
): Uint8Array {
    if (title !== undefined && typeof title !== 'string')
        throw new MediaForgeError('MP4 movie title must be a string', 'FORMAT');
    const entries = [
        ...(title !== undefined ? [{ key: 'title', value: title }] : []),
        ...(tags?.entries ?? []).filter(entry => entry.key !== 'title' || title === undefined),
    ];
    const user: Uint8Array[] = [];
    const items: Uint8Array[] = [];
    const data = (type: number, value: Uint8Array) =>
        isoBox('data', uint32(type), uint32(0), value);
    for (const { key, value } of entries) {
        const bytes = encoder.encode(value);

        // A QuickTime text atom states its length in 16 bits; a longer value goes into the item
        // list, and so does a description, as ffmpeg reads no ©des atom.
        const textAtom =
            quickTime && bytes.length <= 0xffff && key !== 'description'
                ? QUICKTIME_KEYS.find(([, common]) => common === key)
                : undefined;
        const item = ILST_KEYS.find(([, common]) => common === key)?.[0];
        if (textAtom) user.push(quickTimeText(textAtom[0], value));
        else if (item) items.push(isoBox(item, data(1, bytes)));
        else if (key === 'track' || key === 'disc') {
            const number = trackNumber(value, key === 'track');
            if (number) items.push(isoBox(key === 'track' ? 'trkn' : 'disk', data(0, number)));
        }
    }
    const covers = (tags?.pictures ?? []).filter(picture => mp4KeepsPicture(picture.mimeType));
    if (covers.length)
        items.push(
            isoBox(
                'covr',
                ...covers.map(picture =>
                    data(
                        picture.mimeType === 'image/png'
                            ? 14
                            : picture.mimeType === 'image/bmp'
                              ? 27
                              : 13,
                        picture.data,
                    ),
                ),
            ),
        );
    if (items.length)
        user.push(
            isoBox(
                'meta',
                uint32(0),
                isoBox(
                    'hdlr',
                    uint32(0),
                    uint32(0),
                    encoder.encode('mdir'),
                    encoder.encode('appl'),
                    new Uint8Array(9),
                ),
                isoBox('ilst', ...items),
            ),
        );
    const chapters = tags?.chapters ?? [];
    if (chapters.length) {
        const titles = chapters
            .slice(0, 255)
            .map(chapter => encoder.encode(chapter.title ?? '').subarray(0, 255));
        const body = new Uint8Array(9 + titles.reduce((sum, text) => sum + 9 + text.length, 0));
        const view = new DataView(body.buffer);
        body[0] = 1;
        body[8] = titles.length;
        let at = 9;
        titles.forEach((text, index) => {
            view.setBigUint64(at, BigInt(Math.max(0, Math.round(chapters[index]!.start * 1e7))));
            body[at + 8] = text.length;
            body.set(text, at + 9);
            at += 9 + text.length;
        });
        user.push(isoBox('chpl', body));
    }
    return user.length ? isoBox('udta', ...user) : empty;
}

function trackTitleMetadata(title: string, quickTime: boolean): Uint8Array {
    return isoBox(
        'meta',
        ...(quickTime ? [] : [uint32(0)]),
        isoBox('hdlr', uint32(0), uint32(0), encoder.encode('mdta'), new Uint8Array(13)),
        isoBox('keys', uint32(0), uint32(1), isoBox('mdta', encoder.encode(titleKey))),
        isoBox(
            'ilst',
            isoBox('\0\0\0\x01', isoBox('data', uint32(1), uint32(0), encoder.encode(title))),
        ),
    );
}

export function mp4TrackMetadataBoxes(
    track: Mp4TrackMetadata | undefined,
    quickTime = false,
): Uint8Array[] {
    if (!track) return [];
    validateMp4TrackMetadata(track);
    const user: Uint8Array[] = [];
    if (track.name !== undefined) {
        const language = /^[a-z]{3}$/.test(track.language ?? '') ? track.language! : 'und';
        const header = new Uint8Array(6);
        new DataView(header.buffer).setUint16(
            4,
            ((language.charCodeAt(0) - 96) << 10) |
                ((language.charCodeAt(1) - 96) << 5) |
                (language.charCodeAt(2) - 96),
        );
        user.push(isoBox('tnam', header, mp4HandlerName(track.name)));
    }

    if (track.forced)
        user.push(isoBox('kind', uint32(0), encoder.encode(`${roleScheme}\0forced-subtitle\0`)));
    if (track.commentary)
        user.push(isoBox('kind', uint32(0), encoder.encode(`${roleScheme}\0commentary\0`)));
    if (track.title !== undefined) user.push(isoBox('name', encoder.encode(track.title)));
    return [
        ...(user.length ? [isoBox('udta', ...user)] : []),
        ...(track.title === undefined ? [] : [trackTitleMetadata(track.title, quickTime)]),
    ];
}
