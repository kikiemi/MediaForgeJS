import { MediaForgeError } from '../../core/errors/errors';
import { demuxAssert, malformedInput } from '../../core/errors/demux-guard';
import { DEMUX_LIMITS } from '../shared/demux-budget';
import { type ByteReader } from '../../core/io/sources/chunk-reader';

import { MATROSKA_METADATA_LIMIT } from '../metadata/matroska-values';

export const ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    Info: 0x1549a966,
    TimestampScale: 0x2ad7b1,
    Title: 0x7ba9,
    Tags: 0x1254c367,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    FlagDefault: 0x88,
    FlagForced: 0x55aa,
    FlagCommentary: 0x55af,
    FlagHearingImpaired: 0x55ab,
    FlagVisualImpaired: 0x55ac,
    FlagTextDescriptions: 0x55ad,
    FlagOriginal: 0x55ae,
    Name: 0x536e,
    AlphaMode: 0x53c0,
    BlockAdditions: 0x75a1,
    BlockMore: 0xa6,
    BlockAddID: 0xee,
    BlockAdditional: 0xa5,
    BlockAdditionMapping: 0x41e4,
    BlockAddIDType: 0x41e7,
    BlockAddIDExtraData: 0x41ed,
    Language: 0x22b59c,
    LanguageIETF: 0x22b59d,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    CodecDelay: 0x56aa,
    ContentEncodings: 0x6d80,
    ContentEncoding: 0x6240,
    ContentEncodingScope: 0x5032,
    ContentEncodingType: 0x5033,
    ContentCompression: 0x5034,
    ContentCompAlgo: 0x4254,
    ContentCompSettings: 0x4255,
    TrackTimestampScale: 0x23314f,
    DefaultDuration: 0x23e383,
    Video: 0xe0,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,
    DisplayWidth: 0x54b0,
    DisplayHeight: 0x54ba,
    DisplayUnit: 0x54b2,
    Colour: 0x55b0,
    Projection: 0x7670,
    ColourSpace: 0x2eb524,
    ProjectionType: 0x7671,
    ProjectionPoseYaw: 0x7673,
    ProjectionPosePitch: 0x7674,
    ProjectionPoseRoll: 0x7675,
    MatrixCoefficients: 0x55b1,
    Range: 0x55b9,
    TransferCharacteristics: 0x55ba,
    Primaries: 0x55bb,
    MaxCLL: 0x55bc,
    MaxFALL: 0x55bd,
    MasteringMetadata: 0x55d0,
    FlagInterlaced: 0x9a,
    FieldOrder: 0x9d,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    OutputSamplingFrequency: 0x78b5,
    Channels: 0x9f,
    BitDepth: 0x6264,
    Cluster: 0x1f43b675,
    ClusterTimestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    ReferenceBlock: 0xfb,
    BlockDuration: 0x9b,
    DiscardPadding: 0x75a2,
    Chapters: 0x1043a770,
    Attachments: 0x1941a469,
} as const;

export const SEGMENT_CHILD_IDS = new Set<number>([
    ID.Info,
    ID.Tracks,
    ID.Cluster,
    ID.Chapters,
    ID.Attachments,
    0x114d9b74,
    0x1c53bb6b,
    ID.Tags,
    0xec,
    0xbf,
]);

/** Four-byte IDs of the top-level elements a damaged segment is resynchronised on. */
export const LEVEL1_IDS: readonly number[] = [
    ID.Info,
    ID.Tracks,
    ID.Cluster,
    ID.Chapters,
    ID.Attachments,
    ID.Tags,
    0x114d9b74,
    0x1c53bb6b,
];
export const CLUSTER_CHILD_IDS = new Set<number>([
    ID.ClusterTimestamp,
    ID.SimpleBlock,
    ID.BlockGroup,
    0xa7,
    0xab,
    0x5854,
    0xec,
    0xbf,
]);

/** An EBML element: its ID and the bounds of its data. */
export interface Element {
    id: number;
    dataStart: number;
    dataEnd: number;
}

/** An element header as read from the input; `unknown` marks an unknown size. */
export interface ParsedHeader {
    id: number;
    dataStart: number;
    dataEnd: number;
    unknown: boolean;
    headerLen: number;
}

export function newHeader(): ParsedHeader {
    return { id: 0, dataStart: 0, dataEnd: 0, unknown: false, headerLen: 0 };
}

/** Byte length and unknown-size marker of the vint returned by the latest `readVint` call. */
export let vintLength = 0;
let vintUnknown = false;

export function readVint(
    buf: Uint8Array,
    pos: number,
    end: number,
    kind: 'id' | 'size' | 'unsigned' | 'signed',
): number {
    demuxAssert(pos < end, 'EBML vint past EOF');
    const first = buf[pos]!;
    demuxAssert(first !== 0, 'invalid EBML vint (zero lead byte)');
    let length = 1;
    let mask = 0x80;
    while ((first & mask) === 0) {
        length++;
        mask >>= 1;
    }

    demuxAssert(length <= 8 && pos + length <= end, 'EBML vint truncated');
    demuxAssert(kind !== 'id' || length <= 4, 'Matroska element ID exceeds four bytes');
    vintLength = length;
    vintUnknown = kind === 'size' && isUnknownSizeBytes(buf, pos, length);
    if (vintUnknown) return 0;
    if (kind === 'signed' && length === 8) {
        let wide = 0n;
        for (let i = 1; i < length; i++) wide = wide * 256n + BigInt(buf[pos + i]!);
        wide -= (1n << 55n) - 1n;
        demuxAssert(
            wide >= BigInt(Number.MIN_SAFE_INTEGER) && wide <= BigInt(Number.MAX_SAFE_INTEGER),
            'EBML lace delta exceeds the safe integer range',
        );
        return Number(wide);
    }

    let value = kind === 'id' ? first : first & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i]!;
    if (kind === 'signed') value -= 2 ** (length * 7 - 1) - 1;
    demuxAssert(Number.isSafeInteger(value), 'EBML vint exceeds the safe integer range');
    return value;
}

function isUnknownSizeBytes(buf: Uint8Array, pos: number, length: number): boolean {
    const first = buf[pos]!;
    const mask = 0x80 >> (length - 1);
    if ((first & (mask - 1)) !== mask - 1) return false;
    for (let i = 1; i < length; i++) if (buf[pos + i] !== 0xff) return false;
    return true;
}

/** `limit` bounds the header bytes themselves; `parentEnd` bounds the element's data. */
export function readHeaderLocal(
    buf: Uint8Array,
    pos: number,
    parentEnd: number,
    limit: number,
    out: ParsedHeader,
): ParsedHeader {
    const id = readVint(buf, pos, limit, 'id');
    const idLength = vintLength;
    const size = readVint(buf, pos + idLength, limit, 'size');
    const sizeLength = vintLength;
    const unknown = vintUnknown;
    const dataStart = pos + idLength + sizeLength;
    const dataEnd = unknown ? parentEnd : dataStart + size;
    if (dataEnd > parentEnd) malformedInput(`EBML element 0x${id.toString(16)} exceeds its parent`);
    out.id = id;
    out.dataStart = dataStart;
    out.dataEnd = dataEnd;
    out.unknown = unknown;
    out.headerLen = idLength + sizeLength;
    return out;
}

export function* elements(
    buf: Uint8Array,
    start: number,
    end: number,
    limit = buf.length,
): Generator<Element> {
    const header = newHeader();
    let pos = start;
    let count = 0;
    while (pos < end) {
        const h = readHeaderLocal(buf, pos, end, limit, header);
        if (h.unknown)
            malformedInput(
                `unknown-size EBML element 0x${h.id.toString(16)} inside a sized container`,
            );
        const dataEnd = h.dataEnd;
        yield { id: h.id, dataStart: h.dataStart, dataEnd };
        demuxAssert(++count <= DEMUX_LIMITS.maxTableEntries, 'EBML element count exceeds limit');
        pos = dataEnd;
    }
}

/** Positions in [from, end) that hold the Cluster ID, first ones first; at most 64. */
export async function clusterIds(reader: ByteReader, from: number, end: number): Promise<number[]> {
    const found: number[] = [];
    for (let pos = from; pos + 4 <= end && found.length < 64;) {
        const page = await reader.bytes(pos, Math.min(256 * 1024, end - pos));
        for (let index = 0; index + 4 <= page.length && found.length < 64; index++)
            if (
                page[index] === 0x1f &&
                page[index + 1] === 0x43 &&
                page[index + 2] === 0xb6 &&
                page[index + 3] === 0x75
            )
                found.push(pos + index);
        if (page.length < 4) break;
        pos += page.length - 3;
    }
    return found;
}

export function readUint(
    buf: Uint8Array,
    start: number,
    end: number,
    defaultValue: number,
): number {
    const len = end - start;
    demuxAssert(len <= 8, 'EBML unsigned integer exceeds eight bytes');
    if (len === 0) return defaultValue;
    let v = 0;
    for (let i = start; i < end; i++) v = v * 256 + buf[i]!;
    demuxAssert(Number.isSafeInteger(v), 'EBML unsigned integer exceeds the safe integer range');
    return v;
}

export function uintOf(buf: Uint8Array, el: Element, defaultValue = 0): number {
    return readUint(buf, el.dataStart, el.dataEnd, defaultValue);
}

export function floatOf(buf: Uint8Array, el: Element, defaultValue = 0): number {
    const len = el.dataEnd - el.dataStart;
    demuxAssert(len === 0 || len === 4 || len === 8, 'EBML float has an invalid byte length');
    if (len === 0) return defaultValue;
    const dv = new DataView(buf.buffer, buf.byteOffset + el.dataStart);
    const value = len === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
    demuxAssert(Number.isFinite(value), 'EBML float exceeds the finite range');
    return value;
}

export function asciiOf(buf: Uint8Array, el: Element): string {
    let s = '';
    for (let i = el.dataStart; i < el.dataEnd; i++) {
        const c = buf[i]!;
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

export const MAX_METADATA_BYTES = MATROSKA_METADATA_LIMIT;
export const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function utf8Of(buf: Uint8Array, el: Element): string {
    demuxAssert(
        el.dataEnd - el.dataStart <= MAX_METADATA_BYTES,
        'Matroska text exceeds the metadata byte limit',
    );
    try {
        const text = UTF8.decode(buf.subarray(el.dataStart, el.dataEnd)).replace(/\0+$/, '');
        demuxAssert(!text.includes('\0'), 'Matroska text contains an embedded NUL');
        return text;
    } catch (error) {
        if (error instanceof MediaForgeError) throw error;
        malformedInput('Matroska text is not valid UTF-8');
    }
}
