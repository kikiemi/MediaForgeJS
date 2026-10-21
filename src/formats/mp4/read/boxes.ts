import { demuxAssert, malformedInput } from '../../../core/errors/demux-guard';
import { DEMUX_LIMITS } from '../../shared/demux-budget';

/** A box of a buffer: its type and its range from the size field. */
export interface Box {
    type: string;
    offset: number;
    size: number;
}

export function readU32(d: DataView, o: number): number {
    return d.getUint32(o, false);
}

export function readU16(d: DataView, o: number): number {
    return d.getUint16(o, false);
}

export function ascii(buf: Uint8Array, o: number, len: number): string {
    if (len === 4) return String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[o + i]!);
    return s;
}

/** The big-endian 32-bit number at `o` of `buf`. */
function u32At(buf: Uint8Array, o: number): number {
    return ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
}

/** A box type as the number its header holds; -1 for a type no four bytes spell. */
function fourcc(type: string): number {
    if (type.length !== 4) return -1;
    let code = 0;
    for (let i = 0; i < 4; i++) {
        const char = type.charCodeAt(i);
        if (char > 0xff) return -1;
        code = code * 256 + char;
    }
    return code;
}

export function readFullBoxVersion(
    buf: Uint8Array,
    box: Box,
    version0Size: number,
    version1Size?: number,
): number {
    if (!(box.size >= 12)) malformedInput(`${box.type} box is truncated before version/flags`);
    const version = buf[box.offset + 8]!;
    if (!(version === 0 || (version === 1 && version1Size !== undefined)))
        malformedInput(`unsupported ${box.type} version ${version}`);
    if (!(box.size >= (version === 1 ? version1Size! : version0Size)))
        malformedInput(`version-${version} ${box.type} box is truncated`);
    return version;
}

export function scanBoxes(
    buf: Uint8Array,
    start: number,
    end: number,
    visit?: (type: string, offset: number, size: number) => boolean | void,
): number {
    let count = 0;
    for (let pos = start; pos + 8 <= end;) {
        const size = boxSize(buf, pos, end);
        if (size < 0) break;
        if (!(++count <= DEMUX_LIMITS.maxBoxesPerRange)) boxFlood(start, end);
        if (visit?.(ascii(buf, pos + 4, 4), pos, size) === false) return count;
        pos += size;
    }
    return count;
}

/**
 * The size of the box at `pos` from its size field (64-bit with size 1, to `end` with size 0), or
 * -1 where no box fits there: the walk over the boxes ends.
 */
function boxSize(buf: Uint8Array, pos: number, end: number): number {
    let size = u32At(buf, pos);
    let headerLen = 8;
    if (size === 0) {
        size = end - pos;
    } else if (size === 1) {
        if (pos + 16 > end) return -1;
        size = u32At(buf, pos + 8) * 0x100000000 + u32At(buf, pos + 12);
        headerLen = 16;
    }
    return size < headerLen || !Number.isFinite(size) || pos + size > end ? -1 : size;
}

function boxFlood(start: number, end: number): never {
    return malformedInput(
        `box count exceeds ${DEMUX_LIMITS.maxBoxesPerRange} in a ` +
            `${end - start}-byte range (nested-box flood)`,
    );
}

export function findBoxes(
    buf: Uint8Array,
    start: number,
    end: number,
    requireComplete = false,
): Box[] {
    scanBoxes(buf, start, end);
    const boxes: Box[] = [];
    scanBoxes(buf, start, end, (type, offset, size) => {
        boxes.push({ type, offset, size });
    });
    const last = boxes[boxes.length - 1];
    demuxAssert(
        !requireComplete || (last ? last.offset + last.size : start) === end,
        'fragment box structure is truncated',
    );
    return boxes;
}

/**
 * The ES_Descriptor tree of an esds box (also inside a QuickTime 'wave' wrapper): ES_Descriptor
 * 0x03 holds a DecoderConfigDescriptor 0x04 whose objectTypeIndication is its first byte and whose
 * DecoderSpecificInfo 0x05 holds the AudioSpecificConfig. Descriptor lengths use the expandable
 * form (0x80 continuation bytes).
 */
export function parseEsds(
    buf: Uint8Array,
    start: number,
    end: number,
): { objectType?: number; specificInfo?: Uint8Array } | undefined {
    const esds = findBox(buf, start, end, 'esds');
    if (!esds) {
        const wave = findBox(buf, start, end, 'wave');
        return wave ? parseEsds(buf, wave.offset + 8, wave.offset + wave.size) : undefined;
    }
    const data = buf.subarray(esds.offset + 12, esds.offset + esds.size);
    const descriptor = (
        at: number,
        limit: number,
    ): { tag: number; start: number; end: number } | undefined => {
        if (at >= limit) return undefined;
        const tag = data[at]!;
        let cursor = at + 1;
        let length = 0;
        for (let count = 0; count < 4 && cursor < limit; count++) {
            const byte = data[cursor++]!;
            length = (length << 7) | (byte & 0x7f);
            if ((byte & 0x80) === 0) break;
        }
        // Some writers size the ES_Descriptor for an SL descriptor the box then cuts; the children
        // in the box are read, as FFmpeg reads them.
        return cursor < limit
            ? { tag, start: cursor, end: Math.min(cursor + length, limit) }
            : undefined;
    };
    const es = descriptor(0, data.length);
    if (!es || es.tag !== 0x03) return undefined;

    // ES_ID (2), flags (1) with optional dependsOn (2), URL (1 + length) and OCR (2) fields precede
    // the children.
    let cursor = es.start + 3;
    const flags = data[es.start + 2]!;
    if (flags & 0x80) cursor += 2;
    if (flags & 0x40) cursor += 1 + data[cursor]!;
    if (flags & 0x20) cursor += 2;
    while (cursor < es.end) {
        const child = descriptor(cursor, es.end);
        if (!child) return undefined;
        if (child.tag === 0x04) {
            const result: { objectType?: number; specificInfo?: Uint8Array } = {
                objectType: data[child.start],
            };

            // objectTypeIndication (1), streamType (1), bufferSizeDB (3), maxBitrate (4),
            // avgBitrate (4).
            for (let inner = child.start + 13; inner < child.end;) {
                const info = descriptor(inner, child.end);
                if (!info) break;
                if (info.tag === 0x05) result.specificInfo = data.slice(info.start, info.end);
                inner = info.end;
            }
            return result;
        }
        cursor = child.end;
    }
    return undefined;
}

/**
 * The 'sbgp' box in `start`..`end` that maps samples to audio pre-roll groups ('prol'), or null.
 * Its members (xHE-AAC immediate playout frames) start decoding as sync samples do.
 */
export function preRollGroups(buf: Uint8Array, start: number, end: number): Box | null {
    let found: Box | null = null;
    scanBoxes(buf, start, end, (type, offset, size) => {
        if (type !== 'sbgp' || size < 20 || ascii(buf, offset + 12, 4) !== 'prol') return;
        found = { type, offset, size };
        return false;
    });
    return found;
}

/** Calls `mark` with the number (from 1) of each of the first `count` samples `sbgp` groups. */
export function forEachGroupedSample(
    view: DataView,
    sbgp: Box,
    count: number,
    mark: (sample: number) => void,
): void {
    const end = sbgp.offset + sbgp.size;
    let at = sbgp.offset + (view.getUint8(sbgp.offset + 8) === 1 ? 20 : 16);
    if (at + 4 > end) return;
    const entries = view.getUint32(at);
    let sample = 1;
    for (let entry = 0; entry < entries && at + 12 <= end && sample <= count; entry++) {
        const run = view.getUint32(at + 4);
        const last = Math.min(count, sample + run - 1);
        if (view.getUint32(at + 8))
            for (let member = sample; member <= last; member++) mark(member);
        sample += run;
        at += 8;
    }
}

export function findBox(buf: Uint8Array, start: number, end: number, type: string): Box | null {
    // The type is compared as the number its header holds, without a string per box.
    const code = fourcc(type);
    let count = 0;
    for (let pos = start; pos + 8 <= end;) {
        const size = boxSize(buf, pos, end);
        if (size < 0) break;
        if (!(++count <= DEMUX_LIMITS.maxBoxesPerRange)) boxFlood(start, end);
        if (u32At(buf, pos + 4) === code) return { type, offset: pos, size };
        pos += size;
    }
    return null;
}

/** The first child box of `type` inside `parent`, a box whose payload is boxes. */
export function childBox(buf: Uint8Array, parent: Box, type: string): Box | null {
    return findBox(buf, parent.offset + 8, parent.offset + parent.size, type);
}

/**
 * Types of the boxes found at the top level of MP4 and QuickTime files: a box of another type after
 * a movie box may be the movie box's own bytes, read from a wrong size.
 */
export const TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
    'ftyp',
    'mdat',
    'free',
    'skip',
    'wide',
    'moof',
    'mfra',
    'udta',
    'uuid',
    'meta',
    'sidx',
    'ssix',
    'styp',
    'emsg',
    'prft',
    'pnot',
    'pdin',
    'moov',
    'junk',
]);
