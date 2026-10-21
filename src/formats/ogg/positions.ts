import type { Source } from '../../core/model/types';
import { awaitWithAbort } from '../../core/io/abort';
import { oggPageCrc32 } from './crc';
import { u32 } from './comments';
import { readPageHeader } from './pages';
import { narrowToPosition, type PlacedUnit, type PositionSpan } from '../shared/position-search';
import { asciiAt } from '../detection/head-bytes';

/**
 * Where the pages of one logical Ogg stream lie in an input, found from a few reads: the stream's
 * ends, and the pages whose granules bracket a position (RFC 3533; a granule states the samples
 * decoded through the last packet the page completes).
 */

/**
 * Bytes read at each end of an input first: its headers and first audio pages, and its last pages.
 * Ends that do not hold them (large headers, large pages) are read again four times as large, up
 * to OGG_MAX_END_BYTES.
 */
const OGG_END_BYTES = 64 * 1024;
const OGG_MAX_END_BYTES = 256 * 1024;

/** Bytes a search reads at each probe: several pages of the usual size. */
const PROBE_BYTES = 16 * 1024;

/** Probes a search takes at most: an interpolated and a middle one for each halving of an input. */
const MAX_PROBES = 64;

/** The largest Ogg page: its header, 255 lacing values and 255 segments of 255 bytes. */
const MAX_PAGE_BYTES = 27 + 255 + 255 * 255;

/** An Ogg page read whole with a matching CRC. */
export interface OggPageHead {
    readonly start: number;
    readonly end: number;
    readonly flags: number;
    readonly serial: number;
    readonly sequence: number;
    /** Null for a page that completes no packet (all ones in the file). */
    readonly granule: number | null;
}

/**
 * The page at `at` of `bytes` (whose first byte is input byte `base`), when it is whole and its CRC
 * matches.
 */
export function oggPageAt(bytes: Uint8Array, at: number, base: number): OggPageHead | undefined {
    const size = pageBytesAt(bytes, at);
    if (!size || at + size > bytes.length) return undefined;
    const page = bytes.subarray(at, at + size);
    if (oggPageCrc32(page) !== u32(page, 22)) return undefined;
    const lo = u32(page, 6);
    const hi = u32(page, 10);
    return {
        start: base + at,
        end: base + at + size,
        flags: page[5]!,
        serial: u32(page, 14),
        sequence: u32(page, 18),
        granule: lo === 0xffffffff && hi === 0xffffffff ? null : hi * 2 ** 32 + lo,
    };
}

/** The ends of an input that holds one logical stream: where its head pages and tail pages lie. */
export interface OggStreamEnds {
    readonly serial: number;
    /** The end of the whole pages that start the input, the stream still open after them. */
    readonly headEnd: number;
    /** The start of the whole pages that end the input, the first one starting a packet. */
    readonly tailStart: number;
    /** The end of the first of them that completes a packet. */
    readonly tailSettled: number;
    /** The granules reached at the end of the head and on that page. */
    readonly headGranule: number;
    readonly tailGranule: number;
    /** The offsets of the pages of the head and the tail, their CRCs checked. */
    readonly checked: readonly number[];
}

/** Whether the page at `at` of `bytes` completes a packet: a lacing value under 255 ends one. */
function completesPacket(bytes: Uint8Array, at: number): boolean {
    for (let segment = 0; segment < bytes[at + 26]!; segment++)
        if (bytes[at + 27 + segment]! < 255) return true;
    return false;
}

/**
 * The ends of an input of one logical stream, read as OGG_END_BYTES says; undefined for an input
 * of up to twice OGG_MAX_END_BYTES, several streams or a chain, and ends that are damaged or do not
 * close the stream. Links that share a serial, which RFC 3533 rules out, are told apart only where
 * page numbers fall from the head to the tail or between the probes of a search (bisectOggGranule).
 */
export async function oggStreamEnds(
    source: Source,
    signal?: AbortSignal,
): Promise<OggStreamEnds | undefined> {
    if (source.size <= 2 * OGG_MAX_END_BYTES) return undefined;
    for (let bytes = OGG_END_BYTES; bytes <= OGG_MAX_END_BYTES; bytes *= 4) {
        const ends = await streamEndsIn(source, bytes, bytes >= OGG_MAX_END_BYTES, signal);
        if (ends !== null) return ends;
    }
    return undefined;
}

/**
 * The ends of an input from `bytes` at each end (see oggStreamEnds); unless they are the `last`
 * tried, null when they do not hold an audio page after the headers, or the run of pages that
 * closes the stream.
 */
async function streamEndsIn(
    source: Source,
    bytes: number,
    last: boolean,
    signal?: AbortSignal,
): Promise<OggStreamEnds | null | undefined> {
    const size = source.size;
    const head = await awaitWithAbort(source.read(0, bytes), signal);
    const first = oggPageAt(head, 0, 0);
    if (!first || (first.flags & 2) === 0) return undefined;
    let final = first;
    let headGranule = 0;
    const checked = [first.start];
    for (let page = oggPageAt(head, final.end, 0); page; page = oggPageAt(head, final.end, 0)) {
        // One logical stream, still open at the end of the head.
        if (page.serial !== first.serial || (page.flags & 6) !== 0) return undefined;
        final = page;
        headGranule = page.granule ?? headGranule;
        checked.push(page.start);
    }
    if (headGranule <= 0 && !last) return null;
    const headEnd = final.end;
    const tailBase = size - bytes;
    const tail = await awaitWithAbort(source.read(tailBase, bytes), signal);
    let tailStart = -1;
    let settled: OggPageHead | undefined;
    let run: number[] = [];
    for (let at = tail.indexOf(0x4f); at >= 0 && tailStart < 0; at = tail.indexOf(0x4f, at + 1)) {
        // A run of whole pages of the stream to the end of the input, the first starting a packet,
        // the last closing it.
        const page = oggPageAt(tail, at, tailBase);
        if (!page || page.serial !== first.serial || (page.flags & 3) !== 0) continue;
        if (page.sequence <= final.sequence) return undefined;
        settled = completesPacket(tail, at) ? page : undefined;
        run = [page.start];
        let end = page;
        while (end.end < size && (end.flags & 4) === 0) {
            const next = oggPageAt(tail, end.end - tailBase, tailBase);
            if (!next || next.serial !== first.serial || (next.flags & 2) !== 0) break;
            if (!settled && completesPacket(tail, end.end - tailBase)) settled = next;
            run.push(next.start);
            end = next;
        }
        if (end.end === size && (end.flags & 4) !== 0 && settled && settled.granule !== null)
            tailStart = page.start;
    }
    if ((tailStart < 0 || !settled) && !last) return null;
    if (tailStart <= headEnd || !settled) return undefined;
    return {
        serial: first.serial,
        headEnd,
        tailStart,
        tailSettled: settled.end,
        headGranule,
        tailGranule: settled.granule!,
        checked: [...checked, ...run],
    };
}

/**
 * The bytes the page that `bytes` seems to start at `at` needs to be read whole, as far as the
 * bytes there tell (its header, then its lacing values, then its size); 0 when they do not start
 * a page.
 */
function pageBytesAt(bytes: Uint8Array, at: number): number {
    if (at + 5 > bytes.length) return 27;
    if (!asciiAt(bytes, at, 'OggS') || bytes[at + 4]) return 0;
    if (at + 27 > bytes.length) return 27;
    const segments = bytes[at + 26]!;
    if (at + 27 + segments > bytes.length) return 27 + segments;
    let size = 27 + segments;
    for (let index = 0; index < segments; index++) size += bytes[at + 27 + index]!;
    return size;
}

/**
 * The first page of the stream `serial` with a granule that starts in [from, to), read from `from`
 * on in PROBE_BYTES reads (a page that runs past one is read again from its start); null when none
 * does, undefined when a page of another stream, a stream boundary, or more than two pages' worth
 * of bytes without a whole page come first.
 */
async function stampedPage(
    source: Source,
    serial: number,
    from: number,
    to: number,
    signal?: AbortSignal,
): Promise<OggPageHead | null | undefined> {
    const size = source.size;
    let base = from;
    let bytes: Uint8Array = new Uint8Array(0);
    const load = async (offset: number, length: number): Promise<void> => {
        base = offset;
        bytes = await awaitWithAbort(source.read(offset, Math.min(length, size - offset)), signal);
    };
    await load(from, PROBE_BYTES);
    let at = 0;
    let lastPage = from;
    for (;;) {
        const found = bytes.indexOf(0x4f, at);
        if (found >= 0 && base + found >= to) return null;
        if (found < 0) {
            const next = base + bytes.length;
            if (next >= Math.min(size, to)) return null;
            if (next - lastPage > 2 * MAX_PAGE_BYTES) return undefined;
            await load(next, PROBE_BYTES);
            at = 0;
            continue;
        }
        const need = pageBytesAt(bytes, found);
        if (!need || (found + need > bytes.length && base + found + need > size)) {
            at = found + 1;
            continue;
        }
        if (found + need > bytes.length) {
            await load(base + found, Math.max(need, PROBE_BYTES));
            at = 0;
            continue;
        }
        const page = oggPageAt(bytes, found, base);
        if (!page) {
            at = found + 1;
            continue;
        }
        if (page.serial !== serial || (page.flags & 6) !== 0) return undefined;
        if (page.granule !== null) return page;
        lastPage = page.end;
        at = page.end - base;
    }
}

/**
 * The end of the first page from the page boundary `from` that completes a packet begun at or after
 * `from`: the pages before it only continue, or end, a packet begun earlier. Undefined when the
 * bytes there are not whole pages of the stream `serial` within a few pages.
 */
export async function firstPacketPageEnd(
    source: Source,
    serial: number,
    from: number,
    signal?: AbortSignal,
): Promise<number | undefined> {
    let earlier: boolean | undefined;
    for (let at = from, pages = 0; pages < 64; pages++) {
        const page = await awaitWithAbort(readPageHeader(source, at), signal);
        if (!page || page.serial !== serial) return undefined;

        // The packet the first page continues was begun before `from`.
        earlier ??= (page.flags & 1) !== 0;
        for (const lace of page.laces) {
            if (lace === 255) continue;
            if (!earlier) return at + page.size;
            earlier = false;
        }
        at += page.size;
    }
    return undefined;
}

/** The pages of a stream that bracket a granule (see bisectOggGranule). */
export interface OggGranuleBracket {
    /** The start of the last stamped page before the granule, or the span's start when none is. */
    readonly before: number;
    /** The granule reached at the end of that page, or at the span's start. */
    readonly reached: number;
    /** The first stamped page at or after the granule; undefined when none starts in the span. */
    readonly after?: OggPageHead;
}

/** Whether stamped page `first`, at or before `second`, keeps the order of one stream's pages. */
function inOrder(first?: OggPageHead, second?: OggPageHead): boolean {
    return (
        !first ||
        !second ||
        first.start === second.start ||
        (first.sequence < second.sequence && first.granule! <= second.granule!)
    );
}

/** A stamped page found by a search, placed by its granule. */
interface FoundPage extends PlacedUnit {
    readonly page: OggPageHead;
}

/**
 * The pages of the stream `serial` whose granules bracket `granule` in `span` (page boundaries, and
 * the granules reached there): a search whose every probe reads PROBE_BYTES at an offset
 * interpolated from the granules found so far (narrowToPosition) and takes the first whole page
 * with a granule, its sync and CRC checked, then a walk over the span left. Undefined when a probe
 * meets another stream, a stream boundary, a long run without a page, or page numbers or granules
 * that fall as the offsets rise: such an input is read from its index. The offsets of the pages
 * it checks go to `checked`.
 */
export async function bisectOggGranule(
    source: Source,
    serial: number,
    span: PositionSpan,
    granule: number,
    signal?: AbortSignal,
    checked: number[] = [],
): Promise<OggGranuleBracket | undefined> {
    const find = async (at: number, limit: number): Promise<FoundPage | null | undefined> => {
        const page = await stampedPage(source, serial, at, limit, signal);
        if (page) checked.push(page.start);
        return page && { offset: page.start, position: page.granule!, page };
    };
    const narrowed = await narrowToPosition(span, granule, PROBE_BYTES, MAX_PROBES, find, (a, b) =>
        inOrder(a.page, b.page),
    );
    if (!narrowed) return undefined;

    // The span left holds the bracket's pages, read one after the other from its start.
    let below = narrowed.below?.page;
    const above = narrowed.above?.page;
    let before = span.from;
    let reached = span.fromPosition;
    for (let at = narrowed.from; at < span.to;) {
        const page = await stampedPage(source, serial, at, span.to, signal);
        if (page === undefined) return undefined;
        if (page === null) break;
        checked.push(page.start);
        if (!inOrder(below, page) || !inOrder(page, above)) return undefined;
        below = page;
        if (page.granule! >= granule) return { before, reached, after: page };
        before = page.start;
        reached = page.granule!;
        at = page.end;
    }
    return { before, reached };
}
