import type { GainMap } from '../model/media';
import { u16be, u16le, u32be, u32le } from '../bytes/byte-fields';

/**
 * Gain maps (ISO 21496-1, and the XMP 'hdrgm' form of Ultra HDR JPEG): a second picture that turns
 * the SDR picture into its HDR rendition. JPEG stores the gain map as a further JPEG listed by the
 * primary's MPF segment; HEIF and AVIF as an item a 'tmap' item derives from.
 */

const XMP = 'http://ns.adobe.com/xap/1.0/\0';
const ISO = 'urn:iso:std:iso:ts:21496:-1\0';

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
    for (let index = 0; index < text.length; index++)
        if (bytes[at + index] !== text.charCodeAt(index)) return false;
    return true;
}

/**
 * The HDR headroom, in stops, of ISO 21496-1 gain map metadata at `at`: minimum and writer
 * version, flags, then the base and alternate headroom as fractions, or numerators over a common
 * denominator when flag 8 is set. Undefined when it states none or a later version.
 */
export function isoHeadroom(bytes: Uint8Array, at: number, end: number): number | undefined {
    const common = (bytes[at + 4]! & 8) !== 0;
    if (at + (common ? 17 : 21) > end || u16be(bytes, at) !== 0) return undefined;
    const denominator = u32be(bytes, at + (common ? 5 : 17));
    return denominator ? u32be(bytes, at + 13) / denominator : undefined;
}

interface JpegHead {
    xmp?: string;
    iso?: readonly [number, number];
    /** Start of the MPF segment's TIFF header, which its offsets count from. */
    mpf?: number;
    width?: number;
    height?: number;
}

/** What the marker segments of the JPEG at `start` state before its first scan. */
function jpegHead(bytes: Uint8Array, start: number): JpegHead {
    const head: JpegHead = {};
    let at = start + 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1]!;
        if (marker === 0xff) {
            at++;
            continue;
        }
        const end = at + 2 + u16be(bytes, at + 2);
        const body = at + 4;
        if (marker === 0xda || end > bytes.length) break;
        if (marker === 0xe1 && startsWith(bytes, body, XMP))
            head.xmp = new TextDecoder().decode(bytes.subarray(body + XMP.length, end));
        else if (marker === 0xe2 && startsWith(bytes, body, 'MPF\0')) head.mpf = body + 4;
        else if (marker === 0xe2 && startsWith(bytes, body, ISO))
            head.iso = [body + ISO.length, end];
        else if (
            (marker & 0xf0) === 0xc0 &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
        ) {
            head.height = u16be(bytes, body + 1);
            head.width = u16be(bytes, body + 3);
        }
        at = end;
    }
    return head;
}

/** Whether a primary JPEG's head says it has a gain map: its XMP or ISO 21496-1 version marker. */
function statesGainMap(head: JpegHead): boolean {
    return head.mpf !== undefined && (!!head.iso || /hdrgm:Version/.test(head.xmp ?? ''));
}

/** Whether the start of a JPEG says it carries a gain map, which a re-encode drops. */
export function jpegStatesGainMap(head: Uint8Array): boolean {
    return statesGainMap(jpegHead(head, 0));
}

/** The second image an MPF segment lists, as a byte offset of the file, or undefined. */
function mpfSecondImage(bytes: Uint8Array, tiff: number): number | undefined {
    const little = bytes[tiff] === 0x49;
    const u16 = little ? u16le : u16be;
    const u32 = little ? u32le : u32be;
    const ifd = tiff + u32(bytes, tiff + 4);
    const count = ifd + 2 <= bytes.length ? u16(bytes, ifd) : 0;
    for (
        let entry = ifd + 2;
        entry < ifd + 2 + count * 12 && entry + 12 <= bytes.length;
        entry += 12
    ) {
        if (u16(bytes, entry) !== 0xb002 || u32(bytes, entry + 4) < 32) continue;
        const second = tiff + u32(bytes, entry + 8) + 16;
        const offset = second + 12 <= bytes.length ? u32(bytes, second + 8) : 0;
        return offset ? tiff + offset : undefined;
    }
    return undefined;
}

/**
 * The gain map of a JPEG (Ultra HDR, ISO 21496-1): its size and headroom from the gain map image's
 * XMP (hdrgm:HDRCapacityMax) or ISO 21496-1 metadata, or undefined when it has none.
 */
export function jpegGainMap(bytes: Uint8Array): GainMap | undefined {
    const primary = jpegHead(bytes, 0);
    if (!statesGainMap(primary)) return undefined;
    const at = mpfSecondImage(bytes, primary.mpf!);
    if (at === undefined || bytes[at] !== 0xff || bytes[at + 1] !== 0xd8) return undefined;
    const map = jpegHead(bytes, at);
    if (!map.width || !map.height) return undefined;
    const stated = /hdrgm:HDRCapacityMax(?:="|>)\s*([-\d.]+)/.exec(map.xmp ?? '')?.[1];
    const headroom = map.iso
        ? isoHeadroom(bytes, ...map.iso)
        : stated === undefined
          ? undefined
          : Number(stated);
    return {
        width: map.width,
        height: map.height,
        ...(headroom !== undefined && Number.isFinite(headroom) ? { headroom } : {}),
    };
}
