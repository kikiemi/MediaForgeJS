import type {
    AttachedPicture,
    MatroskaPassThrough,
    MediaChapter,
    MediaTags,
} from '../../core/model/media';
import { mediaTags } from '../../core/model/media-tags';
import { secondsToTicks } from '../../core/model/media-time';
import { ebmlElement, ebmlString, ebmlUint } from './ebml-write';

/**
 * Common tag keys and the SimpleTag names ffmpeg reads and writes for them in a file-wide
 * (untargeted) Tag.
 */
const TAG_NAMES: readonly (readonly [string, string])[] = [
    ['title', 'TITLE'],
    ['artist', 'ARTIST'],
    ['album', 'ALBUM'],
    ['albumArtist', 'ALBUM_ARTIST'],
    ['comment', 'COMMENT'],
    ['description', 'DESCRIPTION'],
    ['date', 'DATE'],
    ['genre', 'GENRE'],
    ['composer', 'COMPOSER'],
    ['copyright', 'COPYRIGHT'],
    ['track', 'PART_NUMBER'],
    ['disc', 'DISC'],
];

/** Other names of the date, used when DATE is absent. */
const DATE_NAMES = ['DATE_RELEASED', 'DATE_RECORDED'];
const MAX_ELEMENTS = 100_000;

/**
 * The attachment types ffmpeg reports as pictures; other attachments (fonts, other images) stay
 * attachments.
 */
const PICTURE_TYPES = /^image\/(gif|jpeg|png|tiff|bmp|webp)$/i;

/**
 * TagTrackUID, TagChapterUID and TagAttachmentUID: a Tag naming one of them is not file-wide (an
 * edition's is).
 */
const SCOPED_TARGETS = [0x63c5, 0x63c4, 0x63c6];

interface Element {
    readonly id: number;
    readonly start: number;
    readonly end: number;
}

const utf8 = new TextDecoder('utf-8');

/** The children of an EBML master between `start` and `end`; a malformed element ends the list. */
function elements(
    bytes: Uint8Array,
    start: number,
    end: number,
    count: { value: number },
): Element[] {
    const found: Element[] = [];
    let at = start;
    const vint = (id: boolean): number | undefined => {
        const first = bytes[at];
        if (first === undefined || first === 0) return undefined;
        let width = 1;
        while (!(first & (0x80 >> (width - 1)))) width++;
        if (width > (id ? 4 : 8) || at + width > end) return undefined;
        let value = id ? first : first & ((0x80 >> (width - 1)) - 1);
        for (let index = 1; index < width; index++) value = value * 256 + bytes[at + index]!;
        at += width;
        return value;
    };

    while (at < end && ++count.value <= MAX_ELEMENTS) {
        const id = vint(true);
        const size = vint(false);
        if (id === undefined || size === undefined || size > end - at) break;
        found.push({ id, start: at, end: at + size });
        at += size;
    }

    return found;
}

function uint(bytes: Uint8Array, element: Element): number {
    let value = 0;
    for (let at = element.start; at < element.end && at - element.start < 8; at++)
        value = value * 256 + bytes[at]!;
    return value;
}

function text(bytes: Uint8Array, element: Element): string {
    return utf8.decode(bytes.subarray(element.start, element.end)).replace(/\0+$/, '');
}

function payload(bytes: Uint8Array): Element | undefined {
    const [root] = elements(bytes, 0, bytes.length, { value: 0 });
    return root;
}

/**
 * The SimpleTags of the file-wide Tags, those whose Targets name no track, chapter or attachment
 * (as ffmpeg reads them, a Tag of an edition is file-wide too); a later one replaces an earlier
 * one, the segment title among them.
 */
function globalTags(bytes: Uint8Array, entries: { key: string; value: string }[]): void {
    const count = { value: 0 };
    const root = payload(bytes);
    if (!root) return;
    const dates: string[] = [];
    for (const tag of elements(bytes, root.start, root.end, count)) {
        if (tag.id !== 0x7373) continue;
        const fields = elements(bytes, tag.start, tag.end, count);
        const targets = fields.find(field => field.id === 0x63c0);
        const scoped =
            targets &&
            elements(bytes, targets.start, targets.end, count).some(
                field => SCOPED_TARGETS.includes(field.id) && uint(bytes, field) !== 0,
            );

        if (scoped) continue;
        for (const simple of fields) {
            if (simple.id !== 0x67c8) continue;
            const parts = elements(bytes, simple.start, simple.end, count);
            const name = parts.find(part => part.id === 0x45a3);
            const value = parts.find(part => part.id === 0x4487);
            if (!name || !value) continue;
            const tagName = text(bytes, name).toUpperCase();
            const key = TAG_NAMES.find(([, field]) => field === tagName)?.[0];
            const existing = entries.find(entry => entry.key === key);
            if (existing) existing.value = text(bytes, value);
            else if (key) entries.push({ key, value: text(bytes, value) });
            else if (DATE_NAMES.includes(tagName)) dates.push(text(bytes, value));
        }
    }

    if (dates.length && !entries.some(entry => entry.key === 'date'))
        entries.push({ key: 'date', value: dates[0]! });
}

/**
 * The chapters of the first edition: each ChapterAtom's start, end and title, its last ChapString
 * as ffmpeg's.
 */
function chapters(bytes: Uint8Array): MediaChapter[] {
    const count = { value: 0 };
    const root = payload(bytes);
    const edition =
        root && elements(bytes, root.start, root.end, count).find(element => element.id === 0x45b9);
    if (!edition) return [];
    const found: MediaChapter[] = [];
    for (const atom of elements(bytes, edition.start, edition.end, count)) {
        if (atom.id !== 0xb6) continue;
        const fields = elements(bytes, atom.start, atom.end, count);
        const start = fields.find(field => field.id === 0x91);
        const end = fields.find(field => field.id === 0x92);
        const hidden = fields.find(field => field.id === 0x98);
        if (!start || (hidden && uint(bytes, hidden))) continue;
        const display = fields.filter(field => field.id === 0x80).at(-1);
        const string =
            display &&
            elements(bytes, display.start, display.end, count).find(field => field.id === 0x85);
        found.push({
            start: uint(bytes, start) / 1e9,
            ...(end ? { end: uint(bytes, end) / 1e9 } : {}),
            ...(string ? { title: text(bytes, string) } : {}),
        });
    }

    return found;
}

/**
 * Attached images: cover art first (a file named cover.*), as ffmpeg reports image attachments as
 * pictures.
 */
function pictures(bytes: Uint8Array): AttachedPicture[] {
    const count = { value: 0 };
    const root = payload(bytes);
    if (!root) return [];
    const found: (AttachedPicture & { cover: boolean })[] = [];
    for (const file of elements(bytes, root.start, root.end, count)) {
        if (file.id !== 0x61a7) continue;
        const fields = elements(bytes, file.start, file.end, count);
        const mime = fields.find(field => field.id === 0x4660);
        const data = fields.find(field => field.id === 0x465c);
        const name = fields.find(field => field.id === 0x466e);
        const description = fields.find(field => field.id === 0x467e);
        const mimeType = mime ? text(bytes, mime) : '';
        if (!data || !PICTURE_TYPES.test(mimeType)) continue;
        const fileName = name ? text(bytes, name) : '';
        found.push({
            data: bytes.slice(data.start, data.end),
            mimeType,
            ...(description ? { description: text(bytes, description) } : {}),
            type: /^cover\./i.test(fileName) ? 3 : 0,
            cover: /^cover\./i.test(fileName),
        });
    }

    return found
        .sort((a, b) => Number(b.cover) - Number(a.cover))
        .map(({ cover: _, ...picture }) => picture);
}

/**
 * The common tags, chapters and image attachments of Matroska metadata, for writers of other
 * containers.
 */
export function readMatroskaMediaTags(
    pass: MatroskaPassThrough | undefined,
): MediaTags | undefined {
    if (!pass) return undefined;
    const entries: { key: string; value: string }[] = [];
    if (pass.title !== undefined) entries.push({ key: 'title', value: pass.title });
    if (pass.tags) globalTags(pass.tags, entries);
    return mediaTags(
        entries,
        pass.chapters ? chapters(pass.chapters) : [],
        pass.attachments ? pictures(pass.attachments) : [],
    );
}

/** SimpleTags that state how the file was written, which every writer states anew. */
/**
 * The statistics mkvmerge states of each track, which describe the stream as one writer wrote it.
 */
const STATISTICS_TAGS = new Set([
    'BPS',
    'DURATION',
    'NUMBER_OF_FRAMES',
    'NUMBER_OF_BYTES',
    '_STATISTICS_WRITING_APP',
    '_STATISTICS_WRITING_DATE_UTC',
    '_STATISTICS_TAGS',
]);
const WRITER_TAGS = new Set([
    'ENCODER',
    'DURATION',
    'ENCODER_SETTINGS',
    'MAJOR_BRAND',
    'MINOR_VERSION',
    'COMPATIBLE_BRANDS',
]);

/**
 * What Matroska metadata holds beyond the common tags, chapters and pictures other containers take:
 * file-wide tags of other names or nested tags, tags of chapters or attachments, tags of tracks
 * other than their titles and statistics, and attachments that are no picture (fonts).
 */
export function matroskaExtras(pass: MatroskaPassThrough): {
    readonly tags: boolean;
    readonly attachments: boolean;
} {
    let tags = false;
    if (pass.tags) {
        const count = { value: 0 };
        const root = payload(pass.tags);
        for (const tag of root ? elements(pass.tags, root.start, root.end, count) : []) {
            if (tag.id !== 0x7373) continue;
            const fields = elements(pass.tags, tag.start, tag.end, count);
            const targets = fields.find(field => field.id === 0x63c0);
            const targetIds = targets
                ? elements(pass.tags, targets.start, targets.end, count)
                      .filter(
                          field =>
                              SCOPED_TARGETS.includes(field.id) && uint(pass.tags!, field) !== 0,
                      )
                      .map(field => field.id)
                : [];

            if (targetIds.some(id => id !== 0x63c5)) tags = true;
            const ofTrack = targetIds.length > 0;
            for (const simple of fields) {
                if (simple.id !== 0x67c8) continue;
                const parts = elements(pass.tags, simple.start, simple.end, count);
                const name = parts.find(part => part.id === 0x45a3);
                const tagName = name ? text(pass.tags, name).toUpperCase() : '';

                // A track's TITLE (in no particular language) is its title, which other containers
                // keep; its statistics are restated by a writer.
                const language = parts.find(part => part.id === 0x447a || part.id === 0x447b);
                const neutral = !language || ['', 'und'].includes(text(pass.tags, language));
                const kept = ofTrack
                    ? (tagName === 'TITLE' && neutral) || STATISTICS_TAGS.has(tagName)
                    : TAG_NAMES.some(([, field]) => field === tagName) ||
                      DATE_NAMES.includes(tagName) ||
                      WRITER_TAGS.has(tagName);

                if (parts.some(part => part.id === 0x67c8) || !kept) tags = true;
            }
        }
    }

    let attachments = false;
    if (pass.attachments) {
        const count = { value: 0 };
        const root = payload(pass.attachments);
        for (const file of root ? elements(pass.attachments, root.start, root.end, count) : []) {
            if (file.id !== 0x61a7) continue;
            const mime = elements(pass.attachments, file.start, file.end, count).find(
                field => field.id === 0x4660,
            );
            if (!mime || !PICTURE_TYPES.test(text(pass.attachments, mime))) attachments = true;
        }
    }

    return { tags, attachments };
}

/** Nanoseconds of a chapter time in seconds, as ChapterTimeStart and ChapterTimeEnd hold it. */
const nanoseconds = (seconds: number): number =>
    Math.max(0, secondsToTicks(seconds, 1e9, 'Matroska chapter time'));

/** True when Matroska output keeps the common tag `key` as a file-wide SimpleTag. */
export function matroskaKeepsTag(key: string): boolean {
    return TAG_NAMES.some(([common]) => common === key);
}

/**
 * Matroska elements for tags of another container: a file-wide Tag of SimpleTags (the title stays
 * in the segment Info), and for mkv one edition of chapters and the pictures as attachments (the
 * first named cover.*).
 */
export function matroskaMediaTagElements(
    tags: MediaTags | undefined,
    format: string,
): {
    readonly tags?: Uint8Array;
    readonly chapters?: Uint8Array;
    readonly attachments?: Uint8Array;
} {
    if (!tags) return {};
    const simple = tags.entries.flatMap(({ key, value }) => {
        const name =
            key === 'title' ? undefined : TAG_NAMES.find(([common]) => common === key)?.[1];
        return name
            ? [ebmlElement(0x67c8, ebmlString(0x45a3, name), ebmlString(0x4487, value))]
            : [];
    });

    const result: { tags?: Uint8Array; chapters?: Uint8Array; attachments?: Uint8Array } = {};
    if (simple.length)
        result.tags = ebmlElement(
            0x1254c367,
            ebmlElement(0x7373, ebmlElement(0x63c0, ebmlUint(0x68ca, 50)), ...simple),
        );

    if (format !== 'mkv') return result;
    const list = tags.chapters ?? [];
    if (list.length)
        result.chapters = ebmlElement(
            0x1043a770,
            ebmlElement(
                0x45b9,
                ...list.map((chapter, index) =>
                    ebmlElement(
                        0xb6,
                        ebmlUint(0x73c4, index + 1),
                        ebmlUint(0x91, nanoseconds(chapter.start)),
                        ...(chapter.end !== undefined
                            ? [ebmlUint(0x92, nanoseconds(chapter.end))]
                            : []),
                        ...(chapter.title !== undefined
                            ? [
                                  ebmlElement(
                                      0x80,
                                      ebmlString(0x85, chapter.title),
                                      ebmlString(0x437c, 'und'),
                                  ),
                              ]
                            : []),
                    ),
                ),
            ),
        );

    const images = tags.pictures ?? [];
    if (images.length)
        result.attachments = ebmlElement(
            0x1941a469,
            ...images.map((picture, index) => {
                const subtype = /^image\/(\w+)$/.exec(picture.mimeType)?.[1]?.toLowerCase();
                const extension = !subtype || subtype === 'jpeg' ? 'jpg' : subtype;
                return ebmlElement(
                    0x61a7,
                    ...(picture.description ? [ebmlString(0x467e, picture.description)] : []),
                    ebmlString(0x466e, `${index === 0 ? 'cover' : `picture${index}`}.${extension}`),
                    ebmlString(0x4660, picture.mimeType),
                    ebmlElement(0x465c, picture.data),
                    ebmlUint(0x46ae, index + 1),
                );
            }),
        );

    return result;
}
