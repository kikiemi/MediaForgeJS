import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import { normalizeMetadata } from './normalized';
import { positiveLimit } from '../../core/errors/limits';
import type {
    MediaMetadata,
    MetadataChapter,
    MetadataEntry,
    MetadataInput,
    MetadataOptions,
} from './types';
import { concatBytes } from '../../core/bytes/bytes';
import type { AttachedPicture, MediaTags } from '../../core/model/media';
import { COMMON_TAG_KEYS, mediaTags } from '../../core/model/media-tags';
import { dataView } from '../../core/bytes/byte-fields';
import { secondsToTicks } from '../../core/model/media-time';

export interface Id3Frame {
    id: string;
    flags: number;
    data: Uint8Array;
}

export interface Id3Tag {
    version: number;
    revision: number;
    flags: number;
    frames: Id3Frame[];
    paddingSize: number;
    trailingData?: Uint8Array;
    opaqueData?: Uint8Array;
    /**
     * Read projection; writeId3Tag writes frames. Use createId3Tag to map edited normalized values.
     */
    metadata: MediaMetadata;
    diagnostics: readonly MediaDiagnostic[];
}

const encoder = new TextEncoder();
const names: Record<string, string> = {
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

function ascii(bytes: Uint8Array): string {
    let result = '';
    for (const byte of bytes) result += String.fromCharCode(byte);
    return result;
}

function syncsafe(bytes: Uint8Array, offset: number): number {
    if (
        offset + 4 > bytes.length ||
        (bytes[offset]! | bytes[offset + 1]! | bytes[offset + 2]! | bytes[offset + 3]!) & 0x80
    ) {
        throw new DemuxError('Invalid ID3 synchsafe integer');
    }
    return (
        bytes[offset]! * 2 ** 21 +
        bytes[offset + 1]! * 2 ** 14 +
        bytes[offset + 2]! * 128 +
        bytes[offset + 3]!
    );
}

function putSyncsafe(bytes: Uint8Array, offset: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff)
        throw new MediaForgeError('ID3 size exceeds 28 bits', 'INPUT');
    for (let i = 3; i >= 0; i--) {
        bytes[offset + i] = value & 127;
        value = Math.floor(value / 128);
    }
}

function concat(
    parts: readonly Uint8Array[],
    maxBytes = 16 * 1024 * 1024,
): Uint8Array<ArrayBuffer> {
    if (parts.reduce((sum, part) => sum + part.length, 0) > maxBytes)
        throw new MediaForgeError('ID3 output exceeds maxBytes', 'INPUT');
    return concatBytes(parts);
}

function text(bytes: Uint8Array, encoding: number): string {
    if (encoding === 0) return ascii(bytes);
    if (encoding === 3) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (encoding !== 1 && encoding !== 2) throw new DemuxError('Unknown ID3 text encoding');
    if (bytes.length % 2) throw new DemuxError('Truncated ID3 UTF-16 text');
    if (encoding === 2) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    if (bytes.length === 0) return '';
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    throw new DemuxError('ID3 UTF-16 text is missing its byte order mark');
}

function terminated(
    bytes: Uint8Array,
    offset: number,
    encoding: number,
): { value: string; end: number } {
    const width = encoding === 1 || encoding === 2 ? 2 : 1;
    for (let end = offset; end + width <= bytes.length; end += width) {
        if (bytes[end] === 0 && (width === 1 || bytes[end + 1] === 0)) {
            return { value: text(bytes.subarray(offset, end), encoding), end: end + width };
        }
    }
    throw new DemuxError('Unterminated ID3 string');
}

/** Removes the 0x00 that ID3v2 unsynchronisation inserts after every 0xFF. */
function resynchronise(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.length);
    let length = 0;
    for (let i = 0; i < bytes.length; i++) {
        out[length++] = bytes[i]!;
        if (bytes[i] === 255 && bytes[i + 1] === 0) i++;
    }
    return out.subarray(0, length);
}

function decodedData(frame: Id3Frame, version: number): Uint8Array | null {
    if (frame.flags & ~(version === 3 ? 0xe0e0 : 0x704f)) return null;
    const flags = frame.flags & 255;
    if (version === 3 ? flags & 0xc0 : flags & 0x0c) return null;
    let bytes = frame.data;
    if (version === 4 && flags & 2) bytes = resynchronise(bytes);
    const prefix = (version === 3 ? flags & 0x20 : flags & 0x40) ? 1 : 0;
    const skip = prefix + (version === 4 && flags & 1 ? 4 : 0);
    if (skip > bytes.length) throw new DemuxError('Truncated ID3 frame prefix');
    return bytes.subarray(skip);
}

/**
 * Whether the frames of a tag body may continue at `offset`: a frame identifier, padding or the end
 * of the body.
 */
function framesContinue(bytes: Uint8Array, offset: number): boolean {
    if (offset >= bytes.length) return offset === bytes.length;
    return bytes[offset] === 0 || /^[A-Z0-9]{4}$/.test(ascii(bytes.subarray(offset, offset + 4)));
}

/**
 * The payload size of the frame at `offset`. ID3v2.4 sizes are synchsafe, but iTunes writes them as
 * plain integers: a size whose synchsafe reading is followed by no frame while its plain reading
 * is, is read plainly (as ffmpeg and TagLib do).
 */
function frameLength(bytes: Uint8Array, offset: number, version: number): number {
    const plain = dataView(bytes).getUint32(offset + 4);
    if (version !== 4) return plain;
    const continues = (length: number): boolean => framesContinue(bytes, offset + 10 + length);
    if ((plain & 0x80808080) === 0 || !continues(plain)) {
        const safe = syncsafe(bytes, offset + 4);
        if (safe === plain || continues(safe) || !continues(plain)) return safe;
    }
    return plain;
}

function readFrame(
    bytes: Uint8Array,
    offset: number,
    version: number,
): { frame: Id3Frame; end: number } {
    if (bytes.length - offset < 10) throw new DemuxError('Truncated ID3 frame header');
    const id = ascii(bytes.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) throw new DemuxError('Invalid ID3 frame identifier');
    const view = dataView(bytes);
    const length = frameLength(bytes, offset, version);
    if (length > bytes.length - offset - 10) throw new DemuxError('Truncated ID3 frame payload');
    const end = offset + 10 + length;
    return {
        frame: {
            id,
            flags: view.getUint16(offset + 8),
            data: new Uint8Array(bytes.subarray(offset + 10, end)),
        },
        end,
    };
}

function frameBytes(frame: Id3Frame, version: number): Uint8Array<ArrayBuffer> {
    if (
        !/^[A-Z0-9]{4}$/.test(frame.id) ||
        !Number.isInteger(frame.flags) ||
        frame.flags < 0 ||
        frame.flags > 65535 ||
        !(frame.data instanceof Uint8Array) ||
        frame.data.length > 16 * 1024 * 1024
    ) {
        throw new MediaForgeError('Invalid ID3 frame', 'INPUT');
    }
    const result = new Uint8Array(10 + frame.data.length);
    result.set(encoder.encode(frame.id));
    const view = new DataView(result.buffer);
    if (version === 4) putSyncsafe(result, 4, frame.data.length);
    else view.setUint32(4, frame.data.length);
    view.setUint16(8, frame.flags);
    result.set(frame.data, 10);
    return result;
}

function project(
    frame: Id3Frame,
    version: number,
    metadata: MediaMetadata,
    maxEntries: number,
): boolean {
    const bytes = decodedData(frame, version);
    if (!bytes) return false;
    const source = `id3v2.${version}:${frame.id}`;
    const add = (key: string, value: string, language?: string): void => {
        if (metadata.entries.length >= maxEntries)
            throw new MediaForgeError('ID3 text values exceed maxEntries', 'INPUT');
        metadata.entries.push({
            key,
            value: { type: 'text', value },
            source,
            ...(language ? { language } : {}),
        });
    };

    const values = (value: string): string[] =>
        value.replace(/\0+$/, '').split('\0', maxEntries - metadata.entries.length + 1);
    if (frame.id.startsWith('T') && frame.id !== 'TXXX') {
        for (const value of values(text(bytes.subarray(1), bytes[0]!)))
            add(names[frame.id] ?? `id3:${frame.id}`, value);
        return true;
    }

    if (frame.id === 'TXXX') {
        const description = terminated(bytes, 1, bytes[0]!);
        for (const value of values(text(bytes.subarray(description.end), bytes[0]!))) {
            add(description.value, value);
        }
        return true;
    }

    if (frame.id === 'COMM' || frame.id === 'USLT') {
        if (bytes.length < 4) throw new DemuxError('Truncated ID3 localized text');
        const description = terminated(bytes, 4, bytes[0]!);
        const key = frame.id === 'COMM' ? 'comment' : 'lyrics';
        add(
            description.value ? `${key}:${description.value}` : key,
            text(bytes.subarray(description.end), bytes[0]!).replace(/\0+$/, ''),
            ascii(bytes.subarray(1, 4)),
        );
        return true;
    }

    if (frame.id.startsWith('W')) {
        if (frame.id === 'WXXX') {
            const description = terminated(bytes, 1, bytes[0]!);
            add(
                `url:${description.value}`,
                ascii(bytes.subarray(description.end)).replace(/\0+$/, ''),
            );
        } else add(`id3:${frame.id}`, ascii(bytes).replace(/\0+$/, ''));
        return true;
    }

    if (frame.id === 'APIC') {
        const mime = terminated(bytes, 1, 0);
        if (mime.end >= bytes.length) throw new DemuxError('Truncated ID3 picture');
        const description = terminated(bytes, mime.end + 1, bytes[0]!);
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
        if (bytes.length - identifier.end < 16) throw new DemuxError('Truncated ID3 chapter');
        const view = dataView(bytes);
        const startTime = view.getUint32(identifier.end) / 1000;
        const endMillis = view.getUint32(identifier.end + 4);
        const chapter: MetadataChapter = {
            id: identifier.value,
            startTime,
            ...(endMillis !== 0xffffffff ? { endTime: endMillis / 1000 } : {}),
        };

        let offset = identifier.end + 16;
        let count = 0;
        while (offset < bytes.length && bytes[offset]) {
            if (++count > 4096) throw new DemuxError('Excessive ID3 chapter subframes');
            const sub = readFrame(bytes, offset, version);
            offset = sub.end;
            if (sub.frame.id === 'TIT2') {
                const payload = decodedData(sub.frame, version);
                if (payload)
                    chapter.title = text(payload.subarray(1), payload[0]!).replace(/\0+$/, '');
            }
        }

        metadata.chapters.push(chapter);
        return false;
    }

    return false;
}

/**
 * Read projection of a v2.3/v2.4 tag that uses tag-level unsynchronisation, an extended header or a
 * footer. The tag stays opaque so it is rewritten byte for byte; only its values are decoded here.
 */
function projectTransformedTag(
    body: Uint8Array,
    version: number,
    flags: number,
    metadata: MediaMetadata,
    maxEntries: number,
    context: DiagnosticContext,
): void {
    if (version === 3 && flags & 0x80) body = resynchronise(body);
    if (flags & 0x40) {
        if (body.length < 4) return;
        const extended =
            version === 3
                ? 4 + new DataView(body.buffer, body.byteOffset, 4).getUint32(0)
                : syncsafe(body, 0);
        if (extended > body.length) return;
        body = body.subarray(extended);
    }
    let offset = 0;
    for (let count = 0; offset < body.length && body[offset] !== 0; count++) {
        if (count >= maxEntries) throw new MediaForgeError('ID3 tag exceeds maxEntries', 'INPUT');
        let parsed: { frame: Id3Frame; end: number };
        try {
            parsed = readFrame(body, offset, version);
        } catch (error) {
            context.recover({
                code: 'ID3_TRAILING_DATA',
                message: error instanceof Error ? error.message : 'Malformed ID3 frame',
                format: 'id3',
            });
            return;
        }

        // In v2.4 the tag flag declares every frame unsynchronised, whether or not the frame
        // repeats it.
        const frame =
            version === 4 && flags & 0x80
                ? { ...parsed.frame, flags: parsed.frame.flags | 2 }
                : parsed.frame;
        try {
            project(frame, version, metadata, maxEntries);
        } catch (error) {
            if (error instanceof MediaForgeError && error.code === 'INPUT') throw error;
            context.recover({
                code: 'ID3_OPAQUE_FRAME',
                message:
                    `Frame ${frame.id}: ` +
                    `${error instanceof Error ? error.message : 'invalid payload'}`,
                format: 'id3',
            });
        }
        offset = parsed.end;
    }
}

export function parseId3Tag(bytes: Uint8Array, options: MetadataOptions = {}): Id3Tag {
    const context = new DiagnosticContext(options, 'compatible');
    const maximum = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const maxEntries = positiveLimit(options.maxEntries, 100000, 'maxEntries');
    if (bytes.length < 10 || ascii(bytes.subarray(0, 3)) !== 'ID3')
        throw new DemuxError('Missing ID3 header');
    const version = bytes[3]!;
    const revision = bytes[4]!;
    const flags = bytes[5]!;
    const size = syncsafe(bytes, 6);
    const total = 10 + size + (version === 4 && flags & 16 ? 10 : 0);
    if (total > maximum || total > bytes.length)
        throw new DemuxError('Truncated or excessive ID3 tag');
    const metadata: MediaMetadata = { entries: [], chapters: [], opaque: [], diagnostics: [] };
    const tag: Id3Tag = {
        version,
        revision,
        flags,
        frames: [],
        paddingSize: 0,
        metadata,
        diagnostics: [],
    };

    if ((version !== 3 && version !== 4) || revision !== 0 || flags & ~0x20) {
        context.warn({
            code: 'ID3_OPAQUE_TAG',
            message: 'ID3 tag is kept as opaque bytes',
            format: 'id3',
        });
        tag.opaqueData = new Uint8Array(bytes.subarray(0, total));
        metadata.opaque.push({ format: `id3v2.${version}`, data: new Uint8Array(tag.opaqueData) });
        if ((version === 3 || version === 4) && revision === 0 && !(flags & 0x0f))
            projectTransformedTag(
                bytes.subarray(10, 10 + size),
                version,
                flags,
                metadata,
                maxEntries,
                context,
            );
    } else {
        const body = bytes.subarray(10, total);
        let offset = 0;
        while (offset < body.length) {
            if (body[offset] === 0 && body.subarray(offset).every(byte => byte === 0)) {
                tag.paddingSize = body.length - offset;
                break;
            }

            if (tag.frames.length >= maxEntries)
                throw new MediaForgeError('ID3 tag exceeds maxEntries', 'INPUT');
            let parsed: { frame: Id3Frame; end: number };
            try {
                parsed = readFrame(body, offset, version);
            } catch (error) {
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
            } catch (error) {
                if (error instanceof MediaForgeError && error.code === 'INPUT') throw error;
                context.recover({
                    code: 'ID3_OPAQUE_FRAME',
                    message:
                        `Frame ${parsed.frame.id}: ` +
                        `${error instanceof Error ? error.message : 'invalid payload'}`,
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

export function writeId3Tag(
    tag: Pick<Id3Tag, 'version' | 'frames'> &
        Partial<Pick<Id3Tag, 'revision' | 'flags' | 'paddingSize' | 'trailingData' | 'opaqueData'>>,
    options: MetadataOptions = {},
): Uint8Array<ArrayBuffer> {
    const maximum = positiveLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const maxEntries = positiveLimit(options.maxEntries, 100000, 'maxEntries');
    if (tag.opaqueData) {
        if (
            tag.frames.length ||
            tag.trailingData ||
            tag.paddingSize ||
            tag.opaqueData.length > maximum
        ) {
            throw new MediaForgeError(
                'Opaque ID3 tags cannot be combined with edited frames',
                'INPUT',
            );
        }
        return new Uint8Array(tag.opaqueData);
    }

    if (
        (tag.version !== 3 && tag.version !== 4) ||
        (tag.revision ?? 0) !== 0 ||
        (tag.flags ?? 0) & ~0x20
    ) {
        throw new MediaForgeError(
            'ID3 writer supports v2.3/v2.4 frames without tag-level transforms',
            'INPUT',
        );
    }

    const padding = tag.paddingSize ?? 0;
    if (
        !Number.isSafeInteger(padding) ||
        padding < 0 ||
        padding > maximum ||
        tag.frames.length > maxEntries
    ) {
        throw new MediaForgeError('Excessive ID3 padding or frame count', 'INPUT');
    }

    let byteLength = 10 + padding + (tag.trailingData?.length ?? 0);
    for (const frame of tag.frames) {
        byteLength += 10 + frame.data.length;
        if (byteLength > maximum) throw new MediaForgeError('ID3 output exceeds maxBytes', 'INPUT');
    }

    const parts = tag.frames.map(frame => frameBytes(frame, tag.version));
    if (tag.trailingData) parts.push(new Uint8Array(tag.trailingData));
    if (padding) parts.push(new Uint8Array(padding));
    const body = concat(parts, maximum - 10);
    const header = new Uint8Array([73, 68, 51, tag.version, 0, tag.flags ?? 0, 0, 0, 0, 0]);
    putSyncsafe(header, 6, body.length);
    return concat([header, body], maximum);
}

function encodedText(value: string, version: 3 | 4, terminate = false): Uint8Array<ArrayBuffer> {
    if (value.includes('\0')) throw new MediaForgeError('ID3 text cannot contain NUL', 'INPUT');
    if (version === 4)
        return concat([encoder.encode(value), ...(terminate ? [new Uint8Array(1)] : [])]);
    const result = new Uint8Array(2 + value.length * 2 + (terminate ? 2 : 0));
    result.set([255, 254]);
    const view = new DataView(result.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), true);
    return result;
}

export function createId3Tag(
    input: MetadataInput,
    options: MetadataOptions & { version?: 3 | 4 } = {},
): Id3Tag {
    const version = options.version ?? 4;
    if (version !== 3 && version !== 4)
        throw new MediaForgeError('ID3 version must be 3 or 4', 'INPUT');
    const context = new DiagnosticContext(options, 'compatible');
    const metadata = normalizeMetadata(input, options);
    const frames: Id3Frame[] = [];
    const marker = new Uint8Array([version === 4 ? 3 : 1]);
    const textFrame = (id: string, value: string): Id3Frame => ({
        id,
        flags: 0,
        data: concat([marker, encodedText(value, version)]),
    });

    const addEntry = (entry: MetadataEntry): void => {
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

        const id = Object.entries(names).find(
            ([frame, key]) => key === entry.key && (version === 4 || frame !== 'TDRC'),
        )?.[0];
        if (id) {
            frames.push(textFrame(id, value));
            return;
        }

        if (
            entry.key === 'comment' ||
            entry.key.startsWith('comment:') ||
            entry.key === 'lyrics' ||
            entry.key.startsWith('lyrics:')
        ) {
            let language = entry.language ?? 'und';
            if (!/^[a-z]{3}$/i.test(language)) {
                context.recover({
                    code: 'ID3_LANGUAGE_LOSS',
                    message: "ID3 text language is not ISO 639; using 'und'",
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
        } else if (/^id3:T[A-Z0-9]{3}$/.test(entry.key))
            frames.push(textFrame(entry.key.slice(4), value));
        else
            frames.push({
                id: 'TXXX',
                flags: 0,
                data: concat([
                    marker,
                    encodedText(entry.key, version, true),
                    encodedText(value, version),
                ]),
            });
    };

    for (const entry of metadata.entries) addEntry(entry);
    const opaqueChapters = new Set<string>();
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
        const chapter = metadata.chapters[index]!;
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
        const milliseconds = (seconds: number): number =>
            secondsToTicks(seconds, 1000, 'ID3 chapter time', { min: 0, max: 0xffffffff });
        const start = milliseconds(chapter.startTime);
        const end = chapter.endTime === undefined ? 0xffffffff : milliseconds(chapter.endTime);
        const timing = new Uint8Array(16).fill(255);
        const view = new DataView(timing.buffer);
        view.setUint32(0, start);
        view.setUint32(4, end);
        const children =
            chapter.title !== undefined
                ? [frameBytes(textFrame('TIT2', chapter.title), version)]
                : [];
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

/** Common tag keys an ID3v2 tag has frames for (description goes into a TXXX frame). */
const ID3_KEYS: ReadonlySet<string> = new Set(
    [...Object.values(names), 'comment', 'description'].filter(key => COMMON_TAG_KEYS.has(key)),
);

/** True when an ID3v2 tag keeps the common tag `key`. */
export function id3KeepsTag(key: string): boolean {
    return ID3_KEYS.has(key);
}

/** The common tags, chapters and pictures of an ID3v2 tag; a malformed tag yields none. */
export function id3MediaTags(bytes: Uint8Array): MediaTags | undefined {
    let metadata: MediaMetadata;
    try {
        metadata = parseId3Tag(bytes).metadata;
    } catch (error) {
        if (error instanceof MediaForgeError) return undefined;
        throw error;
    }
    const entries: { key: string; value: string }[] = [];
    const pictures: AttachedPicture[] = [];
    for (const entry of metadata.entries) {
        const value = entry.value;
        if (value.type === 'binary' && /^artwork(?::\d+)?$/.test(entry.key) && value.mimeType) {
            pictures.push({
                data: value.value,
                mimeType: value.mimeType,
                ...(value.description ? { description: value.description } : {}),
                type: Number(entry.key.split(':')[1] ?? 3),
            });
            continue;
        }
        if (value.type !== 'text' && value.type !== 'date') continue;
        if (ID3_KEYS.has(entry.key) && !entries.some(item => item.key === entry.key))
            entries.push({ key: entry.key, value: value.value });
    }

    // ID3v2.3 states the date as a year (TYER) and the day and month (TDAT, DDMM), which ffmpeg
    // joins.
    const text = (key: string): string | undefined => {
        const found = metadata.entries.find(entry => entry.key === key)?.value;
        return found?.type === 'text' ? found.value : undefined;
    };
    const year = text('year');
    const day = text('id3:TDAT');
    if (year && !entries.some(entry => entry.key === 'date'))
        entries.push({
            key: 'date',
            value: day && /^\d{4}$/.test(day) ? `${year}-${day.slice(2)}-${day.slice(0, 2)}` : year,
        });
    return mediaTags(
        entries,
        metadata.chapters.map(chapter => ({
            start: chapter.startTime,
            ...(chapter.endTime !== undefined ? { end: chapter.endTime } : {}),
            ...(chapter.title !== undefined ? { title: chapter.title } : {}),
        })),
        pictures,
    );
}

/**
 * An ID3v2.4 tag of common tags, chapters (CHAP) and pictures (APIC), or undefined when there is
 * nothing to write.
 */
export function id3TagFromMediaTags(tags: MediaTags | undefined): Uint8Array | undefined {
    if (!tags) return undefined;
    const entries: MetadataEntry[] = [
        ...tags.entries
            .filter(entry => ID3_KEYS.has(entry.key))
            .map(entry => ({
                key: entry.key,
                value: { type: 'text' as const, value: entry.value },
            })),
        ...(tags.pictures ?? []).map(picture => ({
            key: `artwork:${picture.type ?? 3}`,
            value: {
                type: 'binary' as const,
                value: picture.data,
                mimeType: picture.mimeType,
                ...(picture.description ? { description: picture.description } : {}),
            },
        })),
    ];

    const chapters: MetadataChapter[] = (tags.chapters ?? []).map((chapter, index) => ({
        id: `chp${index}`,
        startTime: chapter.start,
        ...(chapter.end !== undefined ? { endTime: chapter.end } : {}),
        ...(chapter.title !== undefined ? { title: chapter.title } : {}),
    }));

    if (!entries.length && !chapters.length) return undefined;
    return writeId3Tag(createId3Tag({ entries, chapters }));
}

/** The TIT2 text of an ID3v2 tag; unparseable tags yield no title rather than a rejection. */
export function id3Title(bytes: Uint8Array): string | undefined {
    if (bytes[3] === 2) return id3v22Title(bytes);
    try {
        const entry = parseId3Tag(bytes).metadata.entries.find(item => item.key === 'title');
        // Leading and trailing spaces belong to the text, as ffmpeg reports it; a blank title is
        // none.
        const title = entry?.value.type === 'text' ? entry.value.value : '';
        return title.trim().length ? title : undefined;
    } catch (error) {
        if (error instanceof MediaForgeError) return undefined;
        throw error;
    }
}

/**
 * The TT2 text of an ID3v2.2 tag (three-character frame ids and sizes), which iTunes still writes.
 * Text in ISO-8859-1 or UTF-16 with a byte order mark; a compressed or malformed tag yields no
 * title.
 */
function id3v22Title(bytes: Uint8Array): string | undefined {
    if (bytes[5]! & 0x40) return undefined;
    let body = bytes.subarray(10);
    if (bytes[5]! & 0x80) {
        const restored: number[] = [];
        for (let index = 0; index < body.length; index++) {
            restored.push(body[index]!);
            if (body[index] === 0xff && body[index + 1] === 0) index++;
        }
        body = Uint8Array.from(restored);
    }

    for (let offset = 0; offset + 6 <= body.length && body[offset] !== 0;) {
        const id = String.fromCharCode(body[offset]!, body[offset + 1]!, body[offset + 2]!);
        const size = (body[offset + 3]! << 16) | (body[offset + 4]! << 8) | body[offset + 5]!;
        const data = body.subarray(offset + 6, offset + 6 + size);
        if (data.length < size) return undefined;
        if (id === 'TT2' && size > 1) {
            const encoding = data[0]!;
            let text = data.subarray(1);
            let decoded: string;
            if (encoding === 0)
                decoded = Array.from(text, byte => String.fromCharCode(byte)).join('');
            else if (encoding === 1 && text.length >= 2 && text.length % 2 === 0) {
                const little = text[0] === 0xff && text[1] === 0xfe;
                if (!little && !(text[0] === 0xfe && text[1] === 0xff)) return undefined;
                text = text.subarray(2);
                decoded = new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(text);
            } else return undefined;

            const title = decoded.replace(/\0.*$/s, '');
            return title.trim().length ? title : undefined;
        }

        offset += 6 + size;
    }

    return undefined;
}
