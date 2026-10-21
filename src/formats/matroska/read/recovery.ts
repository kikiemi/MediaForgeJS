import { DemuxError, throwIfAborted } from '../../../core/errors/errors';
import { demuxAssert } from '../../../core/errors/demux-guard';
import { CHUNK_BYTES } from '../../../core/io/sources/chunk-reader';
import { u32be } from '../../../core/bytes/byte-fields';
import { ID, LEVEL1_IDS, newHeader, readHeaderLocal, readVint, type ParsedHeader } from '../ebml';
import type { WebMTrack } from './track-entry';
import { readsPastDamage, recoverDamage, type MatroskaReadContext } from './read-context';

/**
 * The next of the four-byte element `ids` at or after `from`, scanning in pages; -1 when none
 * remains.
 */
export async function findLevel1(
    context: MatroskaReadContext,
    from: number,
    end: number,
    ids: readonly number[],
): Promise<number> {
    for (let pos = from; pos + 4 <= end;) {
        throwIfAborted(context.signal);
        const page = await context.reader.bytes(pos, Math.min(CHUNK_BYTES, end - pos));
        for (let index = 0; index + 4 <= page.length; index++) {
            if (ids.includes(u32be(page, index))) return pos + index;
        }
        if (page.length < 4) break;
        pos += page.length - 3;
    }
    return -1;
}

/** The Segment after an EBML header whose damaged size runs to the end of the input. */
export async function segmentAfterDamagedHeader(
    context: MatroskaReadContext,
    from: number,
    fileEnd: number,
): Promise<number> {
    const found = await findLevel1(context, from, fileEnd, [ID.Segment]);
    demuxAssert(found >= 0, 'no Matroska Segment found');
    return found;
}

/**
 * Finds the next Cluster element ID after `from` so damaged bytes inside a segment can be skipped.
 * Cluster IDs are four bytes, so the scan is bounded by the segment and reads in fixed pages.
 */
async function findNextCluster(
    context: MatroskaReadContext,
    from: number,
    segEnd: number,
): Promise<number> {
    const pattern = [0x1f, 0x43, 0xb6, 0x75];
    for (let pos = from; pos + 4 <= segEnd;) {
        throwIfAborted(context.signal);
        const page = await context.reader.bytes(pos, Math.min(CHUNK_BYTES, segEnd - pos));
        for (let index = 0; index + 4 <= page.length; index++) {
            if (
                page[index] === pattern[0] &&
                page[index + 1] === pattern[1] &&
                page[index + 2] === pattern[2] &&
                page[index + 3] === pattern[3]
            )
                return pos + index;
        }
        if (page.length < 4) break;
        pos += page.length - 3;
    }
    return -1;
}

/**
 * The next block header in [from, clusterEnd) that names a known track and whose time (on the
 * cluster's clock `clusterTs`) does not go back more than a second behind the track's latest frame:
 * bytes inside damaged data can look like a block header, and a time far behind the track shows
 * they do. -1 when none remains.
 */
async function findNextBlock(
    context: MatroskaReadContext,
    from: number,
    clusterEnd: number,
    tracks: Map<number, WebMTrack>,
    clusterTs: number,
    tsScaleNs: number,
): Promise<number> {
    const header = newHeader();
    for (let base = from; base + 8 <= clusterEnd;) {
        throwIfAborted(context.signal);
        const page = await context.reader.bytes(base, Math.min(CHUNK_BYTES, clusterEnd - base));
        for (let index = 0; index + 8 <= page.length; index++) {
            const id = page[index];
            if (id !== ID.SimpleBlock && id !== ID.BlockGroup) continue;
            try {
                readHeaderLocal(page, index, clusterEnd - base, page.length, header);
            } catch {
                continue;
            }

            if (header.unknown || header.dataEnd - header.dataStart < 4) continue;
            let blockStart = header.dataStart;
            if (id === ID.BlockGroup) {
                if (page[blockStart] !== ID.Block) continue;
                try {
                    readHeaderLocal(page, blockStart, header.dataEnd, page.length, header);
                } catch {
                    continue;
                }
                blockStart = header.dataStart;
            }

            if (blockStart + 4 > page.length) continue;
            try {
                const track = tracks.get(readVint(page, blockStart, page.length, 'unsigned'));
                if (!track) continue;
                const at = blockStart + Math.clz32(page[blockStart]!) - 23;
                if (at + 2 > page.length) continue;
                const rel = ((page[at]! << 24) | (page[at + 1]! << 16)) >> 16;
                const seconds = ((clusterTs + rel * track.timestampScale) * tsScaleNs) / 1e9;
                if (seconds >= track.index.latestTimestamp - 1) return base + index;
            } catch {
                continue;
            }
        }

        if (page.length < 16) break;
        base += page.length - 15;
    }
    return -1;
}

/** Skips damaged bytes at `pos` inside a segment; returns the next Cluster or the segment end. */
export async function recoverAt(
    context: MatroskaReadContext,
    pos: number,
    segEnd: number,
    error: unknown,
): Promise<number> {
    if (!readsPastDamage(context.diagnostics) || !(error instanceof DemuxError)) throw error;
    const next = await findNextCluster(context, pos + 1, segEnd);
    recoverDamage(
        context.diagnostics,
        'MATROSKA_RESYNCHRONIZED',
        next >= 0
            ? `Skipped ${next - pos} damaged bytes at byte ${pos}; resumed at the next Cluster`
            : `Ignored ${segEnd - pos} damaged bytes at byte ${pos} and after`,
        pos,
    );
    return next >= 0 ? next : segEnd;
}

/**
 * Where reading resumes after a top-level element header at `pos` failed to read. `stray` is the
 * start of the element just skipped when its ID is no segment child: a stray byte before a
 * top-level element reads as such an element and swallows that element's header, so damage found
 * after it resynchronises from its start, as FFmpeg resynchronises from the element it failed in.
 * Before the first Cluster, reading resumes at the next top-level element; a damaged Segment size
 * can end the segment early, and its elements then continue past that end.
 */
export async function resumeAfterHeader(
    context: MatroskaReadContext,
    error: unknown,
    at: { readonly pos: number; readonly stray: number | undefined; readonly clustersSeen: number },
    segEnd: number,
    fileEnd: number,
): Promise<{ pos: number; segEnd: number }> {
    const { pos, stray } = at;
    if (
        stray !== undefined &&
        readsPastDamage(context.diagnostics) &&
        error instanceof DemuxError
    ) {
        const next = await findLevel1(context, stray + 1, segEnd, LEVEL1_IDS);
        if (next >= 0 && next < pos) {
            recoverDamage(
                context.diagnostics,
                'MATROSKA_RESYNCHRONIZED',
                `Skipped ${next - stray} bytes of an unknown element at byte ${stray}`,
                stray,
            );
            return { pos: next, segEnd };
        }
    }

    if (!at.clustersSeen) {
        let next =
            readsPastDamage(context.diagnostics) && error instanceof DemuxError
                ? await findLevel1(context, pos + 1, segEnd, LEVEL1_IDS)
                : -1;
        if (
            next < 0 &&
            readsPastDamage(context.diagnostics) &&
            error instanceof DemuxError &&
            segEnd < fileEnd
        ) {
            next = await findLevel1(context, pos + 1, fileEnd, LEVEL1_IDS);
            if (next >= 0) segEnd = fileEnd;
        }

        if (next < 0) throw error;
        recoverDamage(
            context.diagnostics,
            'MATROSKA_RESYNCHRONIZED',
            `Skipped ${next - pos} damaged bytes at byte ${pos}; resumed at the next element`,
            pos,
        );
        return { pos: next, segEnd };
    }

    return { pos: await recoverAt(context, pos, segEnd, error), segEnd };
}

/**
 * Where reading resumes after damage inside the sized cluster `h`, which failed at `failedAt`: at
 * the next block whose header names a known track and fits the cluster, read on with `parseFrom`
 * (from a block, on the clock of the cluster), with video resuming at a keyframe; otherwise at the
 * next cluster.
 */
export async function resumeInCluster(
    context: MatroskaReadContext,
    error: unknown,
    cluster: { readonly h: ParsedHeader; readonly failedAt: number; readonly clusterTs: number },
    tracks: Map<number, WebMTrack>,
    segEnd: number,
    tsScaleNs: number,
    parseFrom: (block: number) => Promise<number>,
    failurePosition: () => number,
): Promise<number> {
    const { h, failedAt } = cluster;
    const clusterEnd = h.unknown ? segEnd : h.dataEnd;
    const block =
        readsPastDamage(context.diagnostics) && error instanceof DemuxError && !h.unknown
            ? await findNextBlock(
                  context,
                  failedAt + 1,
                  clusterEnd,
                  tracks,
                  cluster.clusterTs,
                  tsScaleNs,
              )
            : -1;

    if (block < 0) return recoverAt(context, failedAt, segEnd, error);
    recoverDamage(
        context.diagnostics,
        'MATROSKA_RESYNCHRONIZED',
        `Skipped ${block - failedAt} damaged bytes at byte ${failedAt}; resumed at the next block`,
        failedAt,
    );

    // Pictures after the skipped bytes may reference ones lost in them: video resumes at a
    // keyframe.
    for (const track of tracks.values()) if (track.type === 1) track.awaitKeyframe = true;
    return parseFrom(block).catch(async inner =>
        recoverAt(context, failurePosition(), segEnd, inner),
    );
}
