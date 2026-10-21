import { DemuxError } from '../../../core/errors/errors';
import { demuxAssert } from '../../../core/errors/demux-guard';
import { inflateBounded } from '../../../core/io/inflate';
import { ascii, childBox, readU32, scanBoxes, TOP_LEVEL_TYPES, type Box } from './boxes';
import type { Mp4ReadContext } from './descriptions';
import type { Source } from '../../../core/model/types';
import type { MediaDiagnostic } from '../../../core/errors/diagnostics';
import { dataView } from '../../../core/bytes/byte-fields';

/**
 * Containers of a track whose complete children stay readable when the box is cut by the end of the
 * input.
 */
const CUT_TRACK_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

/**
 * A movie box cut by the end of the input. It is kept, sized to its complete children, when the cut
 * falls after mvhd inside a trak or a trailing optional child (udta, meta, free, skip); any other
 * cut is fatal. A cut trak keeps the complete boxes before the cut, as ffmpeg reads them, so a
 * track whose sample tables are complete stays readable and one that lost them is skipped. Metadata
 * containers (udta, meta, ilst) cut by the end keep their complete items.
 */
export async function truncatedMoov(
    context: Mp4ReadContext,
    pos: number,
    available: number,
): Promise<Uint8Array> {
    const moov = (await context.source.read(pos, available)).slice();
    const dv = new DataView(moov.buffer);
    demuxAssert(readU32(dv, 0) !== 1, 'moov box extends past EOF');

    let offset = 8;
    let movieHeader = false;
    let tracks = 0;
    let cutTrack = false;

    for (;;) {
        if (offset + 8 > available) {
            // The end falls between children (or inside the next child's header): every child read
            // is whole.
            demuxAssert(movieHeader && tracks > 0, 'moov box extends past EOF');
            break;
        }

        const size = readU32(dv, offset);
        const type = ascii(moov, offset + 4, 4);
        demuxAssert(size >= 8, 'moov box extends past EOF');
        if (offset + size > available) {
            demuxAssert(
                movieHeader &&
                    (type === 'trak' ||
                        (tracks > 0 && ['udta', 'meta', 'free', 'skip'].includes(type))),
                'moov box extends past EOF',
            );
            cutTrack = type === 'trak';
            break;
        }

        movieHeader ||= type === 'mvhd';
        if (type === 'trak') tracks++;
        offset += size;
    }

    context.recover({
        code: 'MP4_TRUNCATED_MOOV',
        format: 'mp4',
        offset: pos + offset,
        message: cutTrack
            ? 'Kept the whole boxes of a track box cut by the end of the input'
            : 'Ignored optional movie metadata cut by the end of the input',
    });

    const end = cutTrack
        ? keepCompleteBoxes(moov, dv, offset, available)
        : offset + 8 > available
          ? offset
          : keepCompleteMetadata(moov, dv, offset, available);
    dv.setUint32(0, end);
    return moov.subarray(0, end);
}

/**
 * The end of a track container box at `start` cut before `limit`, resized to its complete children:
 * a cut child container keeps its own complete children the same way, and a cut leaf box is
 * dropped.
 */
function keepCompleteBoxes(buf: Uint8Array, dv: DataView, start: number, limit: number): number {
    let child = start + 8;
    while (child + 8 <= limit) {
        const size = readU32(dv, child);
        if (size < 8) break;
        if (child + size <= limit) {
            child += size;
            continue;
        }
        if (CUT_TRACK_CONTAINERS.has(ascii(buf, child + 4, 4)))
            child = keepCompleteBoxes(buf, dv, child, limit);
        break;
    }
    dv.setUint32(start, child - start);
    return child;
}

/**
 * The end of a metadata container (udta, meta, ilst) at `start` that `limit` cuts, kept to its
 * complete children and resized in place; any other box, or one without a complete child, ends
 * where it starts.
 */
function keepCompleteMetadata(buf: Uint8Array, dv: DataView, start: number, limit: number): number {
    const type = ascii(buf, start + 4, 4);
    if (type !== 'udta' && type !== 'meta' && type !== 'ilst') return start;
    // An ISO meta box carries version and flags; the QuickTime form starts with its first child.
    let child =
        start + (type === 'meta' && start + 12 <= limit && readU32(dv, start + 8) === 0 ? 12 : 8);
    while (child + 8 <= limit) {
        const size = readU32(dv, child);
        if (size < 8) break;
        if (child + size > limit) {
            child = keepCompleteMetadata(buf, dv, child, limit);
            break;
        }
        child += size;
    }
    child = Math.min(child, limit);
    if (child <= start + 8) return start;
    dv.setUint32(start, child - start);
    return child;
}

/**
 * The movie box a QuickTime compressed movie box stores: its `cmov` holds dcom 'zlib' and cmvd with
 * the uncompressed size. `reserve` counts the movie box against the index budget.
 */
export async function uncompressedMoov(
    context: Mp4ReadContext,
    moov: Uint8Array,
    cmov: Box,
    reserve: boolean,
): Promise<Uint8Array> {
    const dcom = childBox(moov, cmov, 'dcom');
    const cmvd = childBox(moov, cmov, 'cmvd');
    demuxAssert(
        dcom && dcom.size >= 12 && cmvd && cmvd.size >= 12,
        'compressed moov lacks dcom or cmvd',
    );
    const method = ascii(moov, dcom.offset + 8, 4);
    if (method !== 'zlib')
        throw new DemuxError(`QuickTime compressed movie box method '${method}' is not supported`);
    if (typeof DecompressionStream !== 'function')
        throw new DemuxError('QuickTime compressed movie box needs DecompressionStream');
    const size = readU32(dataView(moov), cmvd.offset + 8);
    demuxAssert(
        size >= 8 && size <= 64 * 1024 * 1024,
        'compressed moov declares an implausible size',
    );
    const inflated = await inflateBounded(
        [moov.subarray(cmvd.offset + 12, cmvd.offset + cmvd.size)],
        size,
        'QuickTime compressed movie box',
        context.signal,
    );

    demuxAssert(
        inflated.length >= 8 && ascii(inflated, 4, 4) === 'moov',
        'compressed moov holds no movie box',
    );
    if (reserve) context.budget.reserveBytes(inflated.length, 'MP4 movie metadata');
    return inflated;
}

/**
 * Boxes whose payload is boxes: a damaged child, lost or duplicated, changes the size each box on
 * the way up to the movie box should have. stsd, a full box with an entry count, holds sample
 * entries, which are boxes too.
 */
const CONTAINERS = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'edts',
    'dinf',
    'udta',
    'mvex',
    'tref',
    'stsd',
]);

/** Where the child boxes of a sample entry may start: visual, then sound version 0, 1 and 2. */
const SAMPLE_ENTRY_CHILDREN_AT = [86, 36, 52, 72];

/** The largest movie box a repair reads. */
const MOVIE_REPAIR_CAP = 64 * 1024 * 1024;

/** Bytes past the declared end of a movie box searched for the box that follows it. */
const REPAIR_SEARCH_BYTES = 1024 * 1024;

/** Positions where a following box may start that a repair tries. */
const REPAIR_CANDIDATES = 32;

/** Depth of boxes a repair walks. */
const REPAIR_DEPTH = 10;

/** Sets of boxes to resize a repair checks for well-formed tracks. */
const REPAIR_PLANS = 64;

/**
 * Each set of boxes to resize such that the children from `pos` reach `end` exactly once one box
 * among them, at any depth, and every box holding it give up `delta` bytes of their sizes (take
 * `-delta` more when negative); with `delta` 0, the one empty set when they reach `end` as
 * they are. Sets that take fewer boxes as damaged come first.
 */
function* resizedChildren(
    buf: Uint8Array,
    dv: DataView,
    pos: number,
    end: number,
    delta: number,
    entries: boolean,
    depth: number,
    count = 0,
): Generator<number[]> {
    if (pos === end) {
        if (delta === 0) yield [];
        return;
    }

    if (pos > end || count >= 4096 || pos + 8 > buf.length) return;
    const size = readU32(dv, pos);
    if (size < 8) return;
    if (pos + size <= end)
        yield* resizedChildren(buf, dv, pos + size, end, delta, entries, depth, count + 1);
    if (delta === 0 || depth >= REPAIR_DEPTH) return;
    for (const inner of resizedBox(buf, dv, pos, size, delta, entries, depth + 1))
        for (const rest of resizedChildren(
            buf,
            dv,
            pos + size - delta,
            end,
            0,
            entries,
            depth,
            count + 1,
        ))
            yield [...inner, ...rest];
}

/**
 * Each set of boxes to resize when the box at `start` of `size` bytes and the box among its
 * children that lost or gained `delta` bytes give them up: the box itself, and the chain of
 * children down to the damage. `entry` marks a sample entry, whose child boxes follow fields of
 * their own.
 */
function* resizedBox(
    buf: Uint8Array,
    dv: DataView,
    start: number,
    size: number,
    delta: number,
    entry: boolean,
    depth: number,
): Generator<number[]> {
    const type = ascii(buf, start + 4, 4);
    const firsts = entry
        ? SAMPLE_ENTRY_CHILDREN_AT
        : [CONTAINERS.has(type) ? (type === 'stsd' ? 16 : 8) : undefined];
    const end = start + size - delta;
    for (const first of firsts) {
        if (first === undefined || end < start + first || end > buf.length) continue;
        const entries = type === 'stsd';
        if (fits(resizedChildren(buf, dv, start + first, end, 0, entries, depth))) yield [start];
        for (const nested of resizedChildren(buf, dv, start + first, end, delta, entries, depth))
            yield [start, ...nested];
    }
}

/** Whether a search finds a set of boxes to resize. */
function fits(plans: Iterable<number[]>): boolean {
    for (const plan of plans) return !!plan;
    return false;
}

/** Types of the boxes a movie box holds directly. */
const MOVIE_CHILDREN = new Set([
    'mvhd',
    'trak',
    'udta',
    'meta',
    'mvex',
    'iods',
    'free',
    'skip',
    'cmov',
    'uuid',
    'clip',
    'ctab',
    'prfl',
    'htka',
    'pssh',
    'wide',
]);

/**
 * Where the children of the movie box in `bytes` stop being movie children of sound sizes: where a
 * damaged size field would have it end.
 */
function movieChildrenEnd(bytes: Uint8Array, dv: DataView): number {
    let pos = 8;
    while (pos + 8 <= bytes.length && MOVIE_CHILDREN.has(ascii(bytes, pos + 4, 4))) {
        const size = readU32(dv, pos);
        if (size < 8 || pos + size > bytes.length) break;
        pos += size;
    }
    return pos;
}

/**
 * Moves the chunk offsets of the tracks of `moov` that point at or past `from` by `-delta` bytes:
 * the media after a movie box that lost or gained bytes moved with them.
 */
function shiftChunkOffsets(moov: Uint8Array, dv: DataView, from: number, delta: number): void {
    const inside = (box: Box, type: string): Box | null => childBox(moov, box, type);
    scanBoxes(moov, 8, moov.length, (type, offset, size) => {
        if (type !== 'trak') return;
        const mdia = inside({ type, offset, size }, 'mdia');
        const minf = mdia && inside(mdia, 'minf');
        const stbl = minf && inside(minf, 'stbl');
        if (!stbl) return;
        const stco = inside(stbl, 'stco');
        const co64 = inside(stbl, 'co64');
        const table = stco ?? co64;
        if (!table || table.size < 16) return;
        const width = stco ? 4 : 8;
        const count = Math.min(readU32(dv, table.offset + 12), (table.size - 16) / width);
        for (let index = 0; index < count; index++) {
            const at = table.offset + 16 + index * width;
            const offset = stco
                ? readU32(dv, at)
                : readU32(dv, at) * 0x100000000 + readU32(dv, at + 4);
            if (offset < from || offset - delta < 0) continue;
            const moved = offset - delta;
            if (stco) dv.setUint32(at, moved);
            else {
                dv.setUint32(at, Math.floor(moved / 0x100000000));
                dv.setUint32(at + 4, moved >>> 0);
            }
        }
    });
}

/**
 * The bytes of a movie box at `start` of the input resized to end with `bytes`: its children reach
 * that end as they are (its size field was damaged), or once one box among them, lost or
 * duplicated, is accounted for in the sizes of the boxes that hold it; the chunk offsets of media
 * after the box then move with the bytes it lost or gained. Undefined when neither explains the
 * difference.
 */
function movieBoxEndingAt(
    bytes: Uint8Array,
    start: number,
    declared: number,
): { moov: Uint8Array; resized: boolean } | undefined {
    const moov = bytes.slice();
    const dv = new DataView(moov.buffer);
    const delta = declared - moov.length;
    if (fits(resizedChildren(moov, dv, 8, moov.length, 0, false, 1))) {
        dv.setUint32(0, moov.length);
        if (tracksWellFormed(moov, dv)) return { moov, resized: false };

        // Boxes that only chain to the end by chance: a box inside a track may explain it.
        dv.setUint32(0, declared);
    }

    if (readU32(dv, 0) !== declared) return undefined;

    // A box among its children lost or gained the bytes (the movie box's own size alone was tried
    // above): the first set of boxes to resize that leaves every track well formed.
    let tried = 0;
    for (const nested of resizedChildren(moov, dv, 8, moov.length, delta, false, 1)) {
        if (++tried > REPAIR_PLANS) break;
        const sizes = [0, ...nested].map(at => readU32(dv, at));
        for (const at of [0, ...nested]) dv.setUint32(at, readU32(dv, at) - delta);
        if (tracksWellFormed(moov, dv)) {
            shiftChunkOffsets(moov, dv, start + declared, delta);
            return { moov, resized: true };
        }

        [0, ...nested].forEach((at, index) => dv.setUint32(at, sizes[index]!));
    }

    return undefined;
}

/** Boxes of a track whose children always fill them exactly. */
const TRACK_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

/**
 * Whether every track box of a repaired movie box holds boxes that fill each track container
 * exactly: a repair that explains the sizes by chance leaves some container that does not.
 */
function tracksWellFormed(moov: Uint8Array, dv: DataView): boolean {
    const filled = (start: number, end: number, depth: number): boolean => {
        for (let pos = start; pos < end;) {
            if (pos + 8 > end) return false;
            const size = readU32(dv, pos);
            if (size < 8 || pos + size > end) return false;
            const type = ascii(moov, pos + 4, 4);
            if (
                TRACK_CONTAINERS.has(type) &&
                (depth > REPAIR_DEPTH || !filled(pos + 8, pos + size, depth + 1))
            )
                return false;
            pos += size;
        }
        return true;
    };

    let tracks = 0;
    let well = true;
    scanBoxes(moov, 8, moov.length, (type, offset, size) => {
        if (type !== 'trak') return;
        tracks++;
        if (!filled(offset + 8, offset + size, 1)) well = false;
    });
    return well && tracks > 0;
}

/** A movie box repaired to end where the box after it starts, as `repairedMovieBox` finds it. */
/** The recovery a movie box repair reports. */
export function movieRepaired(start: number): Omit<MediaDiagnostic, 'severity'> {
    return {
        code: 'MP4_MOVIE_REPAIRED',
        format: 'mp4',
        offset: start,
        message: `Repaired the sizes of the movie box at byte ${start}`,
    };
}

export interface RepairedMovieBox {
    /** The movie box with its sizes repaired, as long as the input holds from its start. */
    readonly bytes: Uint8Array;
    /** Where the box after it, or the end of the input, starts. */
    readonly end: number;
    /** Whether boxes inside it were resized, not only its own size. */
    readonly resized: boolean;
}

/**
 * A movie box at `start` whose declared size disagrees with where the box after it starts: a box
 * among its children was lost or duplicated by damage, so the sizes of the boxes holding it claim
 * too much or too little, or its own size field was damaged. The box that follows is looked for
 * where a known top-level box header, or the end of the input, lies near the declared end; the
 * movie box is repaired when its children then account for every byte, as ffmpeg reads such a
 * file. Undefined when no such end is found.
 */
export async function repairedMovieBox(
    source: Source,
    start: number,
    declared: number,
): Promise<RepairedMovieBox | undefined> {
    if (declared < 8) return undefined;
    const limit = Math.min(
        source.size,
        start + Math.min(declared, MOVIE_REPAIR_CAP) + REPAIR_SEARCH_BYTES,
    );
    const bytes = await source.read(start, limit - start);
    if (bytes.length !== limit - start || bytes.length < 16 || ascii(bytes, 4, 4) !== 'moov')
        return undefined;
    const dv = dataView(bytes);

    // A movie box whose boxes fill it as declared is intact: the damage lies after it.
    const intact = bytes.subarray(0, declared);
    if (
        declared <= bytes.length &&
        fits(resizedChildren(intact, dv, 8, declared, 0, false, 1)) &&
        tracksWellFormed(intact, dv)
    )
        return undefined;
    const following = (at: number): boolean => {
        if (at + 8 > bytes.length || !TOP_LEVEL_TYPES.has(ascii(bytes, at + 4, 4))) return false;
        const size = readU32(dv, at);
        return (size >= 8 && start + at + size <= source.size) || size === 0 || size === 1;
    };

    const candidates: number[] = [];
    for (let at = 16; at + 8 <= bytes.length; at++) if (following(at)) candidates.push(start + at);
    if (limit === source.size) candidates.push(limit);
    const target = start + declared;
    candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);

    // Where its own children stop comes first: a damaged size field leaves them intact.
    const natural = movieChildrenEnd(bytes, dv);
    if (natural === bytes.length || following(natural)) candidates.unshift(start + natural);
    for (const end of candidates.slice(0, REPAIR_CANDIDATES)) {
        if (end === target || end - start > MOVIE_REPAIR_CAP) continue;
        const repaired = movieBoxEndingAt(bytes.subarray(0, end - start), start, declared);
        if (repaired) return { bytes: repaired.moov, end, resized: repaired.resized };
    }

    return undefined;
}
