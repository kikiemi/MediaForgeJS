import type { ContainerFormat, GainMap } from '../model/media';
import { isoHeadroom } from './gain-map';
import { DemuxError } from '../errors/errors';
import { av1CodecString } from './video/av1-config';
import { hevcCodecString } from './video/hevc-codec';
import { concatBytes } from '../bytes/bytes';
import { u16be, u24le, u32be, u32le } from '../bytes/byte-fields';

/** Container facts of an image read without decoding pixels. */
export interface ImageInfo {
    readonly format: 'avif' | 'heif' | 'webp' | 'jxl';
    readonly width: number;
    readonly height: number;
    /**
     * Frame count of an animation; 1 for stills, undefined when the container does not state it.
     */
    readonly frameCount?: number;
    readonly animated: boolean;
    /** Total animation duration in milliseconds when every frame duration is stored. */
    readonly durationMs?: number;
    /** Total plays; 0 means infinite. Undefined when the container states none. */
    readonly loopCount?: number;
    readonly hasAlpha?: boolean;
    /** Codec of the primary item or animation track (av01, hvc1, vp8, vp8l, jxl). */
    readonly codec: string;
    /** Counter-clockwise rotation in degrees stated by irot. */
    readonly rotation?: number;
    /** Mirror axis stated by imir: 'vertical' flips top-bottom, 'horizontal' flips left-right. */
    readonly mirror?: 'vertical' | 'horizontal';
    readonly bitDepth?: number;
    /** Colour information: nclx triplet or the size of an embedded ICC profile. */
    readonly colour?:
        | { primaries: number; transfer: number; matrix: number; fullRange: boolean }
        | { iccBytes: number };
    readonly frames?: readonly ImageFrameInfo[];
    /** The gain map a 'tmap' item derives the HDR rendition with (ISO 21496-1). */
    readonly gainMap?: GainMap;
}

export interface ImageFrameInfo {
    readonly durationMs: number;
}

interface Box {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly headerSize: number;
}

function u64(bytes: Uint8Array, at: number): number {
    return u32be(bytes, at) * 4294967296 + u32be(bytes, at + 4);
}

function ascii(bytes: Uint8Array, at: number, length = 4): string {
    return String.fromCharCode(...bytes.subarray(at, at + length));
}

function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
    let at = start;
    let count = 0;
    while (at + 8 <= end) {
        if (++count > 65536) throw new DemuxError('ISOBMFF image holds too many boxes');
        let size = u32be(bytes, at);
        let headerSize = 8;
        if (size === 1) {
            if (at + 16 > end) return;
            size = u64(bytes, at + 8);
            headerSize = 16;
        } else if (size === 0) size = end - at;
        if (size < headerSize || at + size > end)
            throw new DemuxError('ISOBMFF image box overruns its parent');
        yield { type: ascii(bytes, at + 4), start: at, end: at + size, headerSize };
        at += size;
    }
}

function child(bytes: Uint8Array, parent: Box, type: string, fullBox = false): Box | undefined {
    for (const box of boxes(
        bytes,
        parent.start + parent.headerSize + (fullBox ? 4 : 0),
        parent.end,
    ))
        if (box.type === type) return box;
    return undefined;
}

interface ItemProperties {
    width?: number;
    height?: number;
    rotation?: number;
    mirror?: 'vertical' | 'horizontal';
    bitDepth?: number;
    colour?: ImageInfo['colour'];
    codec?: string;
    alpha?: boolean;
    /** An auxiliary image that is Apple's HDR gain map. */
    gainMap?: boolean;
}

/**
 * The bytes of item `id` of `meta` when iloc stores them in one place: an extent of the file or of
 * idat.
 */
function itemBytes(bytes: Uint8Array, meta: Box, id: number): Uint8Array | undefined {
    const iloc = child(bytes, meta, 'iloc', true);
    if (!iloc) return undefined;
    let at = iloc.start + iloc.headerSize;
    const version = bytes[at]!;
    const [offsetSize, lengthSize] = [bytes[at + 4]! >> 4, bytes[at + 4]! & 15];
    const [baseSize, indexSize] = [bytes[at + 5]! >> 4, version ? bytes[at + 5]! & 15 : 0];
    at += 6;
    const field = (size: number): number => {
        const value =
            size === 8
                ? u64(bytes, at)
                : size === 4
                  ? u32be(bytes, at)
                  : size === 2
                    ? u16be(bytes, at)
                    : 0;
        at += size;
        return value;
    };
    const count = field(version < 2 ? 2 : 4);
    for (let item = 0; item < count && at < iloc.end; item++) {
        const itemId = field(version < 2 ? 2 : 4);
        const method = version ? field(2) & 15 : 0;
        field(2);
        const base = field(baseSize);
        const extents = field(2);
        const first = { offset: 0, length: 0 };
        for (let extent = 0; extent < extents && at < iloc.end; extent++) {
            field(indexSize);
            const [offset, length] = [field(offsetSize), field(lengthSize)];
            if (!extent) Object.assign(first, { offset, length });
        }
        if (itemId !== id || extents !== 1 || method > 1) continue;
        const idat = method === 1 ? child(bytes, meta, 'idat', true) : undefined;
        const start = (idat ? idat.start + idat.headerSize : 0) + base + first.offset;
        return bytes.subarray(start, Math.min(bytes.length, start + first.length));
    }
    return undefined;
}

/** The aux_type of an alpha plane: MPEG-B CICP (AVIF) and the HEVC form (HEIF). */
const ALPHA_URNS = ['urn:mpeg:mpegB:cicp:systems:auxiliary:alpha', 'urn:mpeg:hevc:2015:auxid:1'];

/** AVIF and HEIF: the primary item's properties from meta, and the animation track from moov. */
function parseHeif(bytes: Uint8Array, format: 'avif' | 'heif'): ImageInfo {
    const top = [...boxes(bytes, 0, bytes.length)];
    const meta = top.find(box => box.type === 'meta');
    if (!meta) throw new DemuxError(`${format} image has no meta box`);
    const pitm = child(bytes, meta, 'pitm', true);
    const primary = pitm
        ? bytes[pitm.start + 8] === 0
            ? u16be(bytes, pitm.start + 12)
            : u32be(bytes, pitm.start + 12)
        : 1;

    const iprp = child(bytes, meta, 'iprp', true);
    const properties: ItemProperties[] = [];
    const associations = new Map<number, number[]>();
    if (iprp) {
        const ipco = child(bytes, iprp, 'ipco');
        if (ipco)
            for (const box of boxes(bytes, ipco.start + ipco.headerSize, ipco.end)) {
                const property: ItemProperties = {};
                const payload = box.start + box.headerSize;
                if (box.type === 'ispe' && box.end - payload >= 12) {
                    property.width = u32be(bytes, payload + 4);
                    property.height = u32be(bytes, payload + 8);
                } else if (box.type === 'irot' && box.end > payload)
                    property.rotation = (bytes[payload]! & 3) * 90;
                else if (box.type === 'imir' && box.end > payload)
                    property.mirror = (bytes[payload]! & 1) === 0 ? 'vertical' : 'horizontal';
                else if (box.type === 'pixi' && box.end - payload >= 6)
                    property.bitDepth = bytes[payload + 5];
                else if (box.type === 'colr' && box.end - payload >= 4) {
                    const kind = ascii(bytes, payload);
                    if (kind === 'nclx' && box.end - payload >= 11)
                        property.colour = {
                            primaries: u16be(bytes, payload + 4),
                            transfer: u16be(bytes, payload + 6),
                            matrix: u16be(bytes, payload + 8),
                            fullRange: (bytes[payload + 10]! & 0x80) !== 0,
                        };
                    else if (kind === 'rICC' || kind === 'prof')
                        property.colour = { iccBytes: box.end - payload - 4 };
                } else if (box.type === 'av1C')
                    property.codec = av1CodecString(bytes.subarray(payload, box.end)) ?? 'av01';
                else if (box.type === 'hvcC')
                    property.codec = hevcCodecString('hvc1', bytes.subarray(payload, box.end));
                else if (box.type === 'auxC') {
                    // aux_type, a null-terminated URN: alpha in its MPEG-B CICP or HEVC form,
                    // or Apple's HDR gain map.
                    const urn = ascii(bytes, payload + 4, box.end - payload - 4).split('\0')[0]!;
                    property.alpha = ALPHA_URNS.includes(urn);
                    property.gainMap = urn.endsWith(':hdrgainmap');
                }

                properties.push(property);
            }

        const ipma = child(bytes, iprp, 'ipma');
        if (ipma) {
            const version = bytes[ipma.start + 8]!;
            const flags = bytes[ipma.start + 11]!;
            let at = ipma.start + 12;
            const entries = u32be(bytes, at);
            at += 4;

            for (let entry = 0; entry < entries && at < ipma.end; entry++) {
                const item = version === 0 ? u16be(bytes, at) : u32be(bytes, at);
                at += version === 0 ? 2 : 4;
                const count = bytes[at++]!;
                const list: number[] = [];
                for (let index = 0; index < count && at < ipma.end; index++) {
                    if (flags & 1) {
                        list.push(u16be(bytes, at) & 0x7fff);
                        at += 2;
                    } else list.push(bytes[at++]! & 0x7f);
                }
                associations.set(item, list);
            }
        }
    }

    // A gain map is the second image a 'tmap' item derives from, in files of the 'tmap' brand.
    const ftyp = top.find(box => box.type === 'ftyp');
    const brands: string[] = [];
    for (let at = ftyp ? ftyp.start + 16 : 0; ftyp && at + 4 <= ftyp.end; at += 4)
        brands.push(ascii(bytes, at));
    const iinf = brands.includes('tmap') ? child(bytes, meta, 'iinf', true) : undefined;
    let toneMap: number | undefined;
    for (const infe of iinf
        ? boxes(bytes, iinf.start + (bytes[iinf.start + 8] ? 16 : 14), iinf.end)
        : []) {
        const v3 = bytes[infe.start + 8] === 3;
        if (ascii(bytes, infe.start + (v3 ? 18 : 16)) === 'tmap')
            toneMap = v3 ? u32be(bytes, infe.start + 12) : u16be(bytes, infe.start + 12);
    }
    let gainMapItem: number | undefined;
    // Auxiliary images and the image each describes; the inputs of the primary when it is a grid.
    const described: [auxiliary: number, image: number][] = [];
    const inputs: number[] = [];
    const iref = child(bytes, meta, 'iref', true);
    if (iref) {
        const version = bytes[iref.start + 8]!;
        for (const box of boxes(bytes, iref.start + 12, iref.end)) {
            const payload = box.start + box.headerSize;
            const from = version === 0 ? u16be(bytes, payload) : u32be(bytes, payload);
            const count = u16be(bytes, payload + (version === 0 ? 2 : 4));
            const first = version === 0 ? u16be(bytes, payload + 4) : u32be(bytes, payload + 6);
            if (box.type === 'auxl' && count > 0) described.push([from, first]);
            if (box.type === 'dimg' && from === toneMap && count === 2)
                gainMapItem =
                    version === 0 ? u16be(bytes, payload + 6) : u32be(bytes, payload + 10);
            if (box.type === 'dimg' && from === primary) {
                const size = version === 0 ? 2 : 4;
                const start = payload + (version === 0 ? 4 : 6);
                for (let at = start; at + size <= box.end && inputs.length < count; at += size)
                    inputs.push(size === 2 ? u16be(bytes, at) : u32be(bytes, at));
            }
        }
    }
    // The auxiliary images of the primary, or of the tiles of a grid primary.
    const auxiliaries = described
        .filter(([, image]) => image === primary || inputs.includes(image))
        .map(([auxiliary]) => auxiliary);

    const itemProperties = (item: number | undefined): ItemProperties => {
        const merged: ItemProperties = {};
        for (const index of (item !== undefined && associations.get(item)) || []) {
            const property = properties[index - 1];
            if (property) Object.assign(merged, property);
        }
        return merged;
    };
    const merged = itemProperties(primary);
    // Apple's HEIC states its gain map as an auxiliary image of the primary instead.
    const map = itemProperties(
        gainMapItem ?? auxiliaries.find(item => itemProperties(item).gainMap),
    );
    const metadata = toneMap === undefined ? undefined : itemBytes(bytes, meta, toneMap);
    const headroom =
        metadata && metadata[0] === 0 ? isoHeadroom(metadata, 1, metadata.length) : undefined;
    const gainMap: GainMap | undefined =
        map.width && map.height
            ? {
                  width: map.width,
                  height: map.height,
                  ...(headroom === undefined ? {} : { headroom }),
              }
            : undefined;

    const hasAlpha = auxiliaries.some(item => itemProperties(item).alpha);

    const moov = top.find(box => box.type === 'moov');
    let frameCount: number | undefined = 1;
    let durationMs: number | undefined;
    let loopCount: number | undefined;
    let frames: ImageFrameInfo[] | undefined;
    let animated = false;
    let codec = merged.codec ?? (format === 'avif' ? 'av01' : 'hvc1');
    if (moov) {
        for (const trak of boxes(bytes, moov.start + moov.headerSize, moov.end)) {
            if (trak.type !== 'trak') continue;
            const mdia = child(bytes, trak, 'mdia');
            const hdlr = mdia && child(bytes, mdia, 'hdlr');
            if (!hdlr || ascii(bytes, hdlr.start + 16) !== 'pict') continue;
            const mdhd = child(bytes, mdia, 'mdhd');
            const stbl = mdia && child(bytes, child(bytes, mdia, 'minf')!, 'stbl');
            if (!mdhd || !stbl) continue;

            const version = bytes[mdhd.start + 8]!;
            const timescale =
                version === 1 ? u32be(bytes, mdhd.start + 28) : u32be(bytes, mdhd.start + 20);
            const stts = child(bytes, stbl, 'stts');
            const stsd = child(bytes, stbl, 'stsd');
            if (stsd && stsd.end - stsd.start >= 24) {
                const entry = ascii(bytes, stsd.start + 20);
                if (entry === 'av01') {
                    const av1C = child(
                        bytes,
                        { type: entry, start: stsd.start + 16, end: stsd.end, headerSize: 86 },
                        'av1C',
                    );
                    codec =
                        (av1C && av1CodecString(bytes.subarray(av1C.start + 8, av1C.end))) ??
                        'av01';
                } else if (entry === 'hvc1' || entry === 'hev1') codec = entry;
            }

            frames = [];
            let total = 0;
            if (stts && timescale > 0) {
                const entries = u32be(bytes, stts.start + 12);
                let at = stts.start + 16;
                for (let index = 0; index < entries && at + 8 <= stts.end; index++) {
                    const count = u32be(bytes, at);
                    const delta = u32be(bytes, at + 4);
                    for (let repeat = 0; repeat < count && frames.length < 1_000_000; repeat++) {
                        frames.push({ durationMs: (delta * 1000) / timescale });
                        total += delta;
                    }
                    at += 8;
                }
            }

            frameCount = frames.length || undefined;
            durationMs = timescale > 0 ? (total * 1000) / timescale : undefined;
            animated = (frameCount ?? 0) > 1;

            const edts = child(bytes, trak, 'edts');
            const elst = edts && child(bytes, edts, 'elst');
            const mvhd = child(bytes, moov, 'mvhd');
            if (elst && mvhd) {
                const elstVersion = bytes[elst.start + 8]!;
                const segment =
                    elstVersion === 1 ? u64(bytes, elst.start + 16) : u32be(bytes, elst.start + 16);
                const movieTimescale =
                    bytes[mvhd.start + 8] === 1
                        ? u32be(bytes, mvhd.start + 28)
                        : u32be(bytes, mvhd.start + 20);
                const flags = u32be(bytes, elst.start + 8) & 0xffffff;
                if (durationMs !== undefined && movieTimescale > 0 && durationMs > 0) {
                    // An edit list with the repeat flag (0x1) loops the animation; its length
                    // states the plays.
                    if (flags & 1) loopCount = 0;
                    else
                        loopCount = Math.max(
                            1,
                            Math.round((segment * 1000) / movieTimescale / durationMs),
                        );
                }
            }

            break;
        }
    }

    if (!merged.width || !merged.height)
        throw new DemuxError(`${format} image declares no ispe dimensions`);
    return {
        format,
        width: merged.width,
        height: merged.height,
        frameCount,
        animated,
        durationMs,
        loopCount,
        hasAlpha,
        codec,
        rotation: merged.rotation,
        mirror: merged.mirror,
        bitDepth: merged.bitDepth,
        colour: merged.colour,
        frames,
        ...(gainMap ? { gainMap } : {}),
    };
}

interface WebpFrame extends ImageFrameInfo {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly blend: boolean;
    readonly dispose: boolean;
    /**
     * Offsets of the frame's ALPH, VP8 or VP8L chunks in the file: [start, end) of each chunk
     * including its header.
     */
    readonly chunks: readonly {
        readonly type: string;
        readonly start: number;
        readonly end: number;
    }[];
}

export interface WebpInfo extends ImageInfo {
    readonly format: 'webp';
    readonly frames?: readonly WebpFrame[];
    /** Chunks of a still image: ALPH, VP8 or VP8L. */
    readonly stillChunks?: readonly {
        readonly type: string;
        readonly start: number;
        readonly end: number;
    }[];
    readonly iccBytes?: number;
    readonly backgroundColor?: number;
}

function* riffChunks(
    bytes: Uint8Array,
    start: number,
    end: number,
): Generator<{ type: string; start: number; end: number }> {
    let at = start;
    while (at + 8 <= end) {
        const size = u32le(bytes, at + 4);
        if (size > end - at - 8) throw new DemuxError('WebP chunk overruns the file');
        yield { type: ascii(bytes, at), start: at, end: at + 8 + size };
        at += 8 + size + (size & 1);
    }
}

function vp8Dimensions(
    bytes: Uint8Array,
    at: number,
    end: number,
): { width: number; height: number } | undefined {
    if (
        end - at < 10 ||
        (bytes[at]! & 1) !== 0 ||
        bytes[at + 3] !== 0x9d ||
        bytes[at + 4] !== 0x01 ||
        bytes[at + 5] !== 0x2a
    )
        return undefined;
    return {
        width: (bytes[at + 6]! | (bytes[at + 7]! << 8)) & 0x3fff,
        height: (bytes[at + 8]! | (bytes[at + 9]! << 8)) & 0x3fff,
    };
}

function vp8lHeader(
    bytes: Uint8Array,
    at: number,
    end: number,
): { width: number; height: number; alpha: boolean } | undefined {
    if (end - at < 5 || bytes[at] !== 0x2f) return undefined;
    const bits = u32le(bytes, at + 1);
    return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
        alpha: ((bits >>> 28) & 1) === 1,
    };
}

function parseWebp(bytes: Uint8Array): WebpInfo {
    if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP')
        throw new DemuxError('Not a WebP file');

    const riffEnd = Math.min(bytes.length, 8 + u32le(bytes, 4));
    let width = 0;
    let height = 0;
    let hasAlpha = false;
    let animated = false;
    let iccBytes: number | undefined;
    let loopCount: number | undefined;
    let backgroundColor: number | undefined;
    let codec = 'vp8';
    const frames: WebpFrame[] = [];
    const stillChunks: { type: string; start: number; end: number }[] = [];
    let durationMs = 0;

    for (const chunk of riffChunks(bytes, 12, riffEnd)) {
        const payload = chunk.start + 8;
        if (chunk.type === 'VP8X') {
            if (chunk.end - payload < 10) throw new DemuxError('WebP VP8X chunk is truncated');
            const flags = bytes[payload]!;
            hasAlpha = (flags & 0x10) !== 0;
            animated = (flags & 0x02) !== 0;
            width = 1 + u24le(bytes, payload + 4);
            height = 1 + u24le(bytes, payload + 7);
        } else if (chunk.type === 'ICCP') iccBytes = chunk.end - payload;
        else if (chunk.type === 'ANIM') {
            if (chunk.end - payload < 6) throw new DemuxError('WebP ANIM chunk is truncated');
            backgroundColor = u32le(bytes, payload);
            loopCount = bytes[payload + 4]! | (bytes[payload + 5]! << 8);
        } else if (chunk.type === 'ANMF') {
            if (chunk.end - payload < 16) throw new DemuxError('WebP ANMF chunk is truncated');
            const flags = bytes[payload + 15]!;
            const frameChunks = [...riffChunks(bytes, payload + 16, chunk.end)].filter(
                inner => inner.type === 'ALPH' || inner.type === 'VP8 ' || inner.type === 'VP8L',
            );
            if (frameChunks.some(inner => inner.type === 'VP8L')) codec = 'vp8l';
            if (frameChunks.some(inner => inner.type === 'ALPH')) hasAlpha = true;
            const duration = u24le(bytes, payload + 12);
            durationMs += duration;
            frames.push({
                x: 2 * u24le(bytes, payload),
                y: 2 * u24le(bytes, payload + 3),
                width: 1 + u24le(bytes, payload + 6),
                height: 1 + u24le(bytes, payload + 9),
                durationMs: duration,
                blend: (flags & 0x02) === 0,
                dispose: (flags & 0x01) !== 0,
                chunks: frameChunks,
            });
        } else if (chunk.type === 'VP8 ' || chunk.type === 'VP8L' || chunk.type === 'ALPH') {
            stillChunks.push(chunk);
            if (chunk.type === 'VP8L') {
                const header = vp8lHeader(bytes, payload, chunk.end);
                if (!header) throw new DemuxError('WebP VP8L header is invalid');
                codec = 'vp8l';
                width ||= header.width;
                height ||= header.height;
                hasAlpha ||= header.alpha;
            } else if (chunk.type === 'VP8 ') {
                const size = vp8Dimensions(bytes, payload, chunk.end);
                if (!size) throw new DemuxError('WebP VP8 key frame header is invalid');
                width ||= size.width;
                height ||= size.height;
            } else hasAlpha = true;
        }
    }

    if (!width || !height) throw new DemuxError('WebP declares no image dimensions');
    if (animated && frames.length === 0) throw new DemuxError('Animated WebP holds no ANMF frames');
    return {
        format: 'webp',
        width,
        height,
        frameCount: animated ? frames.length : 1,
        animated,
        durationMs: animated ? durationMs : undefined,
        loopCount: animated ? loopCount : undefined,
        hasAlpha,
        codec,
        colour: iccBytes !== undefined ? { iccBytes } : undefined,
        frames: animated ? frames : undefined,
        stillChunks: animated ? undefined : stillChunks,
        iccBytes,
        backgroundColor,
    };
}

/**
 * JPEG XL: the codestream SizeHeader and ImageMetadata prefix, in the bare codestream or the
 * ISOBMFF container.
 */
function parseJxl(bytes: Uint8Array): ImageInfo {
    let codestream: Uint8Array | undefined;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) codestream = bytes;
    else {
        const parts: Uint8Array[] = [];
        for (const box of boxes(bytes, 0, bytes.length)) {
            if (box.type === 'jxlc')
                parts.push(bytes.subarray(box.start + box.headerSize, box.end));
            else if (box.type === 'jxlp')
                parts.push(bytes.subarray(box.start + box.headerSize + 4, box.end));
        }
        if (parts.length === 1) codestream = parts[0];
        else if (parts.length > 1) codestream = concatBytes(parts);
    }

    if (!codestream || codestream.length < 4 || codestream[0] !== 0xff || codestream[1] !== 0x0a)
        throw new DemuxError('JPEG XL container holds no codestream');

    let position = 16;
    const read = (count: number): number => {
        let value = 0;
        for (let index = 0; index < count; index++) {
            const byte = position >> 3;
            if (byte >= codestream!.length) throw new DemuxError('JPEG XL header is truncated');
            value |= ((codestream![byte]! >> (position & 7)) & 1) << index;
            position++;
        }
        return value >>> 0;
    };

    const u32Field = (...selectors: [number, number][]): number => {
        const [offset, bits] = selectors[read(2)]!;
        return offset + read(bits);
    };

    const RATIOS: readonly [number, number][] = [
        [1, 1],
        [1, 1],
        [12, 10],
        [4, 3],
        [3, 2],
        [16, 9],
        [5, 4],
        [2, 1],
    ];

    /**
     * A SizeHeader or PreviewHeader: a flag for dimensions stored in eighths (each read by
     * `eighths`) rather than in full (by `full`), the height, a ratio code, and the width when the
     * code is 0.
     */
    const dimensions = (
        eighths: () => number,
        full: () => number,
    ): [width: number, height: number] => {
        const dimension = read(1) ? () => eighths() * 8 : full;
        const height = dimension();
        const ratio = read(3);
        return [
            ratio ? Math.floor((height * RATIOS[ratio]![0]) / RATIOS[ratio]![1]) : dimension(),
            height,
        ];
    };
    const sizeEighths = (): number => read(5) + 1;
    const fullSize = (): number => u32Field([1, 9], [1, 13], [1, 18], [1, 30]);
    const [width, height] = dimensions(sizeEighths, fullSize);

    let animated = false;
    let loopCount: number | undefined;
    let rotation: number | undefined;
    let mirror: ImageInfo['mirror'];
    let bitDepth = 8;
    let hasAlpha = false;
    const allDefault = read(1);
    if (!allDefault) {
        const extraFields = read(1);
        if (extraFields) {
            const orientation = read(3) + 1;
            if (orientation === 2) mirror = 'horizontal';
            else if (orientation === 3) rotation = 180;
            else if (orientation === 4) mirror = 'vertical';
            else if (orientation === 6) rotation = 270;
            else if (orientation === 8) rotation = 90;
            // The intrinsic size, then the preview's.
            if (read(1)) dimensions(sizeEighths, fullSize);
            if (read(1))
                dimensions(
                    () => u32Field([16, 0], [32, 0], [1, 5], [33, 9]),
                    () => u32Field([1, 6], [65, 8], [321, 10], [1345, 12]),
                );

            animated = read(1) === 1;
            if (animated) {
                u32Field([100, 0], [1000, 0], [1, 10], [1, 30]);
                u32Field([1, 0], [1001, 0], [1, 8], [1, 10]);
                loopCount = u32Field([0, 0], [0, 3], [0, 16], [0, 32]);
                read(1);
            }
        }

        const floatSample = read(1);
        if (floatSample) {
            bitDepth = u32Field([32, 0], [16, 0], [24, 0], [1, 6]);
            read(4);
        } else bitDepth = u32Field([8, 0], [10, 0], [12, 0], [1, 6]);
        // modular_16_bit_buffer_sufficient, one bit
        read(1);

        const extraChannels = u32Field([0, 0], [1, 0], [2, 4], [1, 12]);
        for (let index = 0; index < extraChannels; index++) {
            if (read(1)) {
                hasAlpha = true;
                break;
            }
            const type = u32Field([0, 0], [1, 0], [2, 4], [1, 6]);
            if (type === 0) hasAlpha = true;
            break;
        }
    }
    return {
        format: 'jxl',
        width,
        height,
        frameCount: animated ? undefined : 1,
        animated,
        loopCount,
        hasAlpha,
        codec: 'jxl',
        rotation,
        mirror,
        bitDepth,
    };
}

/** Reads the container of an AVIF, HEIF, WebP or JPEG XL image from its complete bytes. */
export function parseImageInfo(bytes: Uint8Array, format: ContainerFormat): ImageInfo {
    if (format === 'avif' || format === 'heif') return parseHeif(bytes, format);
    if (format === 'webp') return parseWebp(bytes);
    if (format === 'jxl') return parseJxl(bytes);
    throw new DemuxError(`No container reader for ${format} images`);
}

/** One RIFF chunk: FourCC `type`, little-endian size and `payload`, padded to an even length. */
export function riffChunk(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length + (payload.length & 1));
    for (let index = 0; index < 4; index++) out[index] = type.charCodeAt(index);
    new DataView(out.buffer).setUint32(4, payload.length, true);
    out.set(payload, 8);
    return out;
}

/** A WebP file: the RIFF header, then `chunks` as riffChunk() makes them. */
export function webpFile(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const body = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(12 + body);
    out.set([0x52, 0x49, 0x46, 0x46]);
    new DataView(out.buffer).setUint32(4, 4 + body, true);
    out.set([0x57, 0x45, 0x42, 0x50], 8);
    let at = 12;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }

    return out;
}

export function parseWebpInfo(bytes: Uint8Array): WebpInfo {
    return parseWebp(bytes);
}
