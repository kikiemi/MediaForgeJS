import {
    MP4_DECISIVE,
    MP4_TOP_BOXES,
    SNIFF_PREFIX_BYTES,
    SniffWindowReader,
    ftypFormat,
    id3v2Span,
    isId3v2Header,
} from './detection/signatures';
import { asciiAt, riffForm, startsWith } from './detection/head-bytes';
import { FORMAT_PLUGIN_MANIFESTS } from './format-plugins';
import type { ReaderPart } from '../core/contracts/reader';
import type { ContainerFormat } from '../core/model/media';
import type { Source } from '../core/model/types';
import { DemuxError, MediaForgeError } from '../core/errors/errors';
import { yieldEventLoop } from '../core/io/event-loop';
import { u32be } from '../core/bytes/byte-fields';

const JXL_CONTAINER = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

/** One step of the library's detection: where it is asked, and the format a head is to it. */
export interface FormatSignature {
    /** Lower is asked first. */
    readonly priority: number;
    readonly format: (head: Uint8Array) => string | null;
}

/** A signature that names `format` where `test` holds. */
const signature = (
    priority: number,
    format: string,
    test: (h: Uint8Array) => boolean,
): FormatSignature => ({ priority, format: h => (test(h) ? format : null) });

/** The signatures of the core formats and the images, with gaps for the plugins' between them. */
const CORE_SIGNATURES: readonly FormatSignature[] = [
    signature(10, 'caf', h => h.length >= 8 && asciiAt(h, 0, 'caff')),
    signature(
        20,
        'aiff',
        h => asciiAt(h, 0, 'FORM') && asciiAt(h, 8, 'AIF') && (h[11] === 0x46 || h[11] === 0x43),
    ),
    signature(30, 'au', h => asciiAt(h, 0, '.snd')),
    signature(40, 'wav', h => riffForm(h) === 'WAVE'),
    signature(41, 'webp', h => riffForm(h) === 'WEBP'),
    signature(50, 'wav', h => asciiAt(h, 0, 'RF64') && asciiAt(h, 8, 'WAVE')),
    { priority: 60, format: matroskaFormat },
    signature(70, 'jxl', h => startsWith(h, JXL_CONTAINER)),
    {
        priority: 80,
        format: h => (h.length >= 12 && asciiAt(h, 4, 'ftyp') ? ftypFormat(h, 0) : null),
    },
    signature(120, 'jxl', h => startsWith(h, [0xff, 0x0a])),
    signature(140, 'ogg', h => asciiAt(h, 0, 'OggS')),
    { priority: 150, format: sniffMpegAudioFormat },
    // ADTS: the sync bits and layer 00. FLAC frame headers start like MPEG-2 ADTS headers (0xFFF8,
    // 0xFFF9), so stream-format tells those apart.
    signature(160, 'aac', h => h[0] === 0xff && (h[1]! & 0xf6) === 0xf0 && (h[1]! & 0xfe) !== 0xf8),
    signature(170, 'flac', h => asciiAt(h, 0, 'fLaC')),
    { priority: 180, format: pngFormat },
    signature(190, 'jpeg', h => startsWith(h, [0xff, 0xd8, 0xff])),
    signature(200, 'gif', h => asciiAt(h, 0, 'GIF8')),
    signature(210, 'bmp', h => asciiAt(h, 0, 'BM')),
    signature(
        220,
        'tiff',
        h => startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a]),
    ),
    // At least one image, whose directory entry has its reserved byte zero: MPEG-4 Part 2 video
    // starts with the same four bytes (a video object start code), then another start code.
    signature(
        230,
        'ico',
        h =>
            startsWith(h, [0x00, 0x00, 0x01, 0x00]) &&
            h.length >= 22 &&
            (h[4]! | (h[5]! << 8)) > 0 &&
            h[9] === 0,
    ),
    // A QuickTime movie without ftyp (the movie box first) whose media data holds MPEG audio
    // frames.
    signature(240, 'mp4', mp4BoxesInPrefix),
];

/** Matroska, or WebM when its header does not name Matroska. */
function matroskaFormat(h: Uint8Array): 'mkv' | 'webm' | null {
    if (!startsWith(h, [0x1a, 0x45, 0xdf, 0xa3])) return null;
    const str = new TextDecoder().decode(h.subarray(0, Math.min(64, h.length)));
    return str.includes('matroska') ? 'mkv' : 'webm';
}

/** PNG, or APNG when an animation control chunk comes before the image data. */
function pngFormat(h: Uint8Array): 'png' | 'apng' | null {
    if (!startsWith(h, [0x89, 0x50, 0x4e, 0x47])) return null;
    for (let i = 8; i + 8 < h.length;) {
        const len = u32be(h, i);
        const type = String.fromCharCode(h[i + 4]!, h[i + 5]!, h[i + 6]!, h[i + 7]!);
        if (type === 'acTL') return 'apng';
        if (type === 'IDAT') break;
        if (len > h.length) break;
        i += 12 + len;
    }
    return 'png';
}

/** Reader sniffs the library's detection asks, so a registry does not ask them again. */
const librarySniffs = new WeakSet<object>();

/**
 * The signatures of reader parts with a sniff and a priority (their first format), but for the
 * library's own, which detection asks already.
 */
export function readerSignatures(
    parts: readonly Pick<ReaderPart, 'formats' | 'priority' | 'sniff'>[],
): FormatSignature[] {
    const signatures: FormatSignature[] = [];
    for (const part of parts) {
        const { formats, priority, sniff } = part;
        if (sniff && priority !== undefined && !librarySniffs.has(sniff))
            signatures.push({
                priority,
                format: h => (part.sniff?.(h) === true ? formats[0]! : null),
            });
    }
    return signatures;
}

const PLUGIN_SIGNATURES = readerSignatures(
    FORMAT_PLUGIN_MANIFESTS.flatMap(manifest => manifest.readers ?? []),
);
for (const manifest of FORMAT_PLUGIN_MANIFESTS)
    for (const { sniff } of manifest.readers ?? []) if (sniff) librarySniffs.add(sniff);

/** Every signature of the library, in the order detection asks them. */
const SIGNATURES = [...CORE_SIGNATURES, ...PLUGIN_SIGNATURES].sort(
    (a, b) => a.priority - b.priority,
);

/**
 * The format a signature, header or box layout at the start of `h` states, or null for the
 * elementary streams and unrecognised bytes that stream-format looks at further. `extra` are the
 * signatures of application readers, asked in their places among the library's.
 */
export function signatureFormat(
    h: Uint8Array,
    extra: readonly FormatSignature[] = [],
): ContainerFormat | null {
    const signatures = extra.length
        ? [...SIGNATURES, ...extra].sort((a, b) => a.priority - b.priority)
        : SIGNATURES;
    for (const { format } of signatures) {
        const found = format(h);
        if (found) return found as ContainerFormat;
    }
    return null;
}

/**
 * The format of a source from the bytes after any leading ID3v2 tags, read through a small window;
 * this does not validate the rest of the stream.
 */
export async function detectSourceFormat(
    source: Source,
    signal?: AbortSignal,
    extra: readonly FormatSignature[] = [],
): Promise<ContainerFormat> {
    if (
        !source ||
        typeof source.read !== 'function' ||
        !Number.isSafeInteger(source.size) ||
        source.size < 0
    ) {
        throw new MediaForgeError(
            'source must provide read() and a non-negative safe integer size',
            'INPUT',
        );
    }
    const reader = new SniffWindowReader(source, signal);
    let offset = 0;
    for (let tags = 0; tags < 16; tags++) {
        const header = await reader.read(offset, 10);
        reader.checkAbort();
        if (!isId3v2Header(header)) break;
        const span = id3v2Span(header);
        if (offset + span > reader.size) throw new DemuxError('Truncated ID3v2 tag');
        offset += span;
    }
    const h = await reader.read(offset, SNIFF_PREFIX_BYTES);
    reader.checkAbort();

    // Elementary streams, and the deeper looks for inputs the prefix does not identify, load only
    // for them.
    const fmt = signatureFormat(h, extra) ?? (await import('./stream-format')).streamFormat(h);
    if (!fmt) {
        reader.useDeepWindow();
        const { deepSniff } = await import('./deep-sniff');
        const deep = await deepSniff(reader, offset);
        reader.checkAbort();
        if (deep) return deep;
        throw new DemuxError('Unable to detect file format');
    }
    if (fmt === 'png') {
        reader.useDeepWindow();
        const imageFormat = await sniffApngDeep(reader, offset);
        reader.checkAbort();
        return imageFormat;
    }
    return fmt;
}

function sniffMpegAudioFormat(h: Uint8Array): 'mp1' | 'mp2' | 'mp3' | null {
    let off = 0;
    if (h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
        const size =
            ((h[6]! & 0x7f) << 21) |
            ((h[7]! & 0x7f) << 14) |
            ((h[8]! & 0x7f) << 7) |
            (h[9]! & 0x7f);

        const after = 10 + size + (h[5]! & 0x10 ? 10 : 0);
        if (after + 4 > h.length) return null;
        off = after;
    }

    if (off + 2 > h.length) return null;
    if (off + 3 >= h.length) return null;
    if (h[off] !== 0xff || (h[off + 1]! & 0xe0) !== 0xe0) return null;
    const versionBits = (h[off + 1]! >> 3) & 3;
    if (versionBits === 1) return null;
    const layerBits = (h[off + 1]! >> 1) & 3;
    const bitrateIndex = (h[off + 2]! >> 4) & 0x0f;
    const sampleRateIndex = (h[off + 2]! >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;
    if (layerBits === 1) return 'mp3';
    if (layerBits === 2) return 'mp2';
    if (layerBits === 3) return 'mp1';
    return null;
}

/** Whether `h` starts with top-level MP4 boxes that reach a decisive box inside the prefix. */
function mp4BoxesInPrefix(h: Uint8Array): boolean {
    for (let pos = 0; pos + 8 <= h.length;) {
        const size = u32be(h, pos);
        const type = String.fromCharCode(h[pos + 4]!, h[pos + 5]!, h[pos + 6]!, h[pos + 7]!);
        if (MP4_DECISIVE.has(type)) return size === 0 || size === 1 || size >= 8;
        if (!MP4_TOP_BOXES.has(type) || size < 8) return false;
        pos += size;
    }
    return false;
}
const MAX_PNG_SNIFF_CHUNKS = 1_000_000;

async function sniffApngDeep(reader: SniffWindowReader, start: number): Promise<'png' | 'apng'> {
    let pos = start + 8;
    for (let chunks = 0; chunks < MAX_PNG_SNIFF_CHUNKS && pos + 8 <= reader.size; chunks++) {
        if ((chunks & 255) === 0) {
            reader.checkAbort();
            await yieldEventLoop();
        }
        const head = await reader.read(pos, 8);
        reader.checkAbort();
        if (head.length < 8) return 'png';
        const len = u32be(head, 0);
        const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
        if (type === 'acTL') return 'apng';
        if (type === 'IDAT' || type === 'IEND') return 'png';
        if (len > 0x7fffffff || pos + 12 + len > reader.size + 12) return 'png';
        pos += 12 + len;
    }
    return 'png';
}
