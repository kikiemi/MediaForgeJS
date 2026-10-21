import type { Mmco, RefListModification, SliceHeader, Sps } from './headers';
import { Picture, REF_LONG, REF_NONE, REF_SHORT, refEntry, type RefEntry } from './picture';
import { PICT_BOTTOM, PICT_FRAME, PICT_TOP, SLICE_B } from './tables';

function otherParity(parity: number): number {
    return parity === PICT_TOP ? PICT_BOTTOM : PICT_TOP;
}

/**
 * Decoded picture buffer state: the reference pictures with their marking (8.2.5), FrameNumWrap and
 * the reference list construction of each slice (8.2.4).
 */
export class ReferenceManager {
    /** Pictures currently holding at least one reference field. */
    readonly references: Picture[] = [];
    maxLongTermFrameIdx = -1;

    /** Clears every reference marking. */
    clear(): void {
        for (const pic of this.references) {
            pic.refTop = REF_NONE;
            pic.refBottom = REF_NONE;
        }
        this.references.length = 0;
        this.maxLongTermFrameIdx = -1;
    }

    private prune(): void {
        for (let i = this.references.length - 1; i >= 0; i--) {
            if (!this.references[i].isReference()) this.references.splice(i, 1);
        }
    }

    /** FrameNumWrap of every short-term reference relative to the current frame_num (8.2.4.1). */
    computeFrameNumWrap(currentFrameNum: number, maxFrameNum: number): void {
        for (const pic of this.references) {
            if (!pic.isShortTerm()) continue;
            pic.frameNumWrap =
                pic.frameNum > currentFrameNum ? pic.frameNum - maxFrameNum : pic.frameNum;
        }
    }

    /** PicNum of a field or frame of `pic` as seen from the current picture (8.2.4.1). */
    private picNum(pic: Picture, parity: number, currentParity: number): number {
        if (currentParity === PICT_FRAME) return pic.frameNumWrap;
        return 2 * pic.frameNumWrap + (parity === currentParity ? 1 : 0);
    }

    private longTermPicNum(pic: Picture, parity: number, currentParity: number): number {
        if (currentParity === PICT_FRAME) return pic.longTermFrameIdx;
        return 2 * pic.longTermFrameIdx + (parity === currentParity ? 1 : 0);
    }

    /**
     * Initial reference picture lists (8.2.4.2) of a slice of `current`, coded with `structure`;
     * `current` may be the second field whose first field is already a reference.
     */
    initialLists(
        header: SliceHeader,
        current: Picture,
        structure: number,
        currentPoc: number,
    ): [RefEntry[], RefEntry[]] {
        const b = header.sliceType === SLICE_B;
        const refs = this.references.filter(pic => pic !== current || structure !== PICT_FRAME);
        const list0: RefEntry[] = [];
        const list1: RefEntry[] = [];
        if (structure === PICT_FRAME) {
            const shortTerm = refs.filter(
                pic => pic.refTop === REF_SHORT && pic.refBottom === REF_SHORT,
            );
            const longTerm = refs.filter(
                pic => pic.refTop === REF_LONG && pic.refBottom === REF_LONG,
            );
            longTerm.sort((a, c) => a.longTermFrameIdx - c.longTermFrameIdx);
            if (!b) {
                shortTerm.sort((a, c) => c.frameNumWrap - a.frameNumWrap);
                for (const pic of shortTerm) list0.push(refEntry(pic, PICT_FRAME, false));
                for (const pic of longTerm) list0.push(refEntry(pic, PICT_FRAME, true));
            } else {
                const before = shortTerm
                    .filter(pic => pic.poc <= currentPoc)
                    .sort((a, c) => c.poc - a.poc);
                const after = shortTerm
                    .filter(pic => pic.poc > currentPoc)
                    .sort((a, c) => a.poc - c.poc);
                for (const pic of before) list0.push(refEntry(pic, PICT_FRAME, false));
                for (const pic of after) list0.push(refEntry(pic, PICT_FRAME, false));
                for (const pic of longTerm) list0.push(refEntry(pic, PICT_FRAME, true));
                for (const pic of after) list1.push(refEntry(pic, PICT_FRAME, false));
                for (const pic of before) list1.push(refEntry(pic, PICT_FRAME, false));
                for (const pic of longTerm) list1.push(refEntry(pic, PICT_FRAME, true));
            }
        } else {
            const parity = structure;
            const shortFrames = refs.filter(
                pic => pic.refTop === REF_SHORT || pic.refBottom === REF_SHORT,
            );
            const longFrames = refs.filter(
                pic => pic.refTop === REF_LONG || pic.refBottom === REF_LONG,
            );
            longFrames.sort((a, c) => a.longTermFrameIdx - c.longTermFrameIdx);
            const refPoc = (pic: Picture, kind: number): number => {
                if (pic === current) return pic.pocOf(otherParity(parity));
                const top = pic.refTop === kind ? pic.topPoc : Number.POSITIVE_INFINITY;
                const bottom = pic.refBottom === kind ? pic.bottomPoc : Number.POSITIVE_INFINITY;
                return Math.min(top, bottom);
            };

            if (!b) {
                shortFrames.sort((a, c) => c.frameNumWrap - a.frameNumWrap);
                alternateFields(shortFrames, parity, REF_SHORT, current, list0);
                alternateFields(longFrames, parity, REF_LONG, current, list0);
            } else {
                const before = shortFrames
                    .filter(pic => refPoc(pic, REF_SHORT) <= currentPoc)
                    .sort((a, c) => refPoc(c, REF_SHORT) - refPoc(a, REF_SHORT));
                const after = shortFrames
                    .filter(pic => refPoc(pic, REF_SHORT) > currentPoc)
                    .sort((a, c) => refPoc(a, REF_SHORT) - refPoc(c, REF_SHORT));
                alternateFields([...before, ...after], parity, REF_SHORT, current, list0);
                alternateFields(longFrames, parity, REF_LONG, current, list0);
                alternateFields([...after, ...before], parity, REF_SHORT, current, list1);
                alternateFields(longFrames, parity, REF_LONG, current, list1);
            }
        }

        if (
            b &&
            list1.length > 1 &&
            list0.length === list1.length &&
            list0.every((e, i) => e.id === list1[i].id)
        ) {
            const first = list1[0];
            list1[0] = list1[1];
            list1[1] = first;
        }

        return [list0, list1];
    }

    /**
     * Applies ref_pic_list_modification (8.2.4.3) to an initial list and truncates it to the active
     * size.
     */
    modifyList(
        list: RefEntry[],
        ops: readonly RefListModification[],
        active: number,
        current: Picture,
        structure: number,
        maxFrameNum: number,
    ): RefEntry[] {
        const frame = structure === PICT_FRAME;
        const currPicNum = frame ? current.frameNum : 2 * current.frameNum + 1;
        const maxPicNum = frame ? maxFrameNum : 2 * maxFrameNum;
        let picNumPred = currPicNum;
        let refIdx = 0;
        const out = list.slice();
        for (const op of ops) {
            let found: RefEntry | undefined;
            if (op.idc === 0 || op.idc === 1) {
                const abs = op.value + 1;
                let noWrap: number;
                if (op.idc === 0) {
                    noWrap = picNumPred - abs;
                    if (noWrap < 0) noWrap += maxPicNum;
                } else {
                    noWrap = picNumPred + abs;
                    if (noWrap >= maxPicNum) noWrap -= maxPicNum;
                }

                picNumPred = noWrap;
                const picNum = noWrap > currPicNum ? noWrap - maxPicNum : noWrap;
                found = this.findShortTerm(picNum, current, structure);
            } else {
                found = this.findLongTerm(op.value, current, structure);
            }

            if (!found) continue;
            out.splice(refIdx, 0, found);
            refIdx++;
            for (let i = refIdx; i < out.length; i++) {
                if (out[i].id === found.id && out[i].longTerm === found.longTerm) {
                    out.splice(i, 1);
                    i--;
                }
            }
        }

        return out.slice(0, active);
    }

    private findShortTerm(
        picNum: number,
        current: Picture,
        structure: number,
    ): RefEntry | undefined {
        for (const pic of this.references) {
            if (structure === PICT_FRAME) {
                if (
                    pic !== current &&
                    pic.refTop === REF_SHORT &&
                    pic.refBottom === REF_SHORT &&
                    pic.frameNumWrap === picNum
                )
                    return refEntry(pic, PICT_FRAME, false);
                continue;
            }
            for (const parity of [PICT_TOP, PICT_BOTTOM]) {
                if (pic === current && parity === structure) continue;
                if (
                    pic.refOf(parity) === REF_SHORT &&
                    this.picNum(pic, parity, structure) === picNum
                )
                    return refEntry(pic, parity, false);
            }
        }
        return undefined;
    }

    private findLongTerm(
        longTermPicNum: number,
        current: Picture,
        structure: number,
    ): RefEntry | undefined {
        for (const pic of this.references) {
            if (structure === PICT_FRAME) {
                if (
                    pic !== current &&
                    pic.refTop === REF_LONG &&
                    pic.refBottom === REF_LONG &&
                    pic.longTermFrameIdx === longTermPicNum
                )
                    return refEntry(pic, PICT_FRAME, true);
                continue;
            }
            for (const parity of [PICT_TOP, PICT_BOTTOM]) {
                if (pic === current && parity === structure) continue;
                if (
                    pic.refOf(parity) === REF_LONG &&
                    this.longTermPicNum(pic, parity, structure) === longTermPicNum
                )
                    return refEntry(pic, parity, true);
            }
        }
        return undefined;
    }

    /** Marks the current picture after decoding (8.2.5); IDR pictures were handled by `markIdr`. */
    mark(header: SliceHeader, current: Picture, structure: number, sps: Sps): boolean {
        let mmco5 = false;
        const secondField =
            structure !== PICT_FRAME &&
            current.refOf(otherParity(structure)) !== REF_NONE &&
            this.references.includes(current);
        if (header.adaptiveMarking) {
            mmco5 = this.applyMmcos(header.mmcos, current, structure, sps);
        } else if (!secondField) {
            this.slidingWindow(current, sps);
        }
        if (structure === PICT_FRAME) {
            if (current.refTop !== REF_LONG) current.refTop = REF_SHORT;
            if (current.refBottom !== REF_LONG) current.refBottom = REF_SHORT;
        } else if (structure === PICT_TOP) {
            if (current.refTop !== REF_LONG) current.refTop = REF_SHORT;
        } else if (current.refBottom !== REF_LONG) current.refBottom = REF_SHORT;
        if (!this.references.includes(current)) this.references.push(current);
        return mmco5;
    }

    markIdr(header: SliceHeader, current: Picture, structure: number): void {
        this.clear();
        if (header.longTermReference) {
            this.maxLongTermFrameIdx = 0;
            current.longTermFrameIdx = 0;
            if (structure !== PICT_BOTTOM) current.refTop = REF_LONG;
            if (structure !== PICT_TOP) current.refBottom = REF_LONG;
        } else {
            this.maxLongTermFrameIdx = -1;
            if (structure !== PICT_BOTTOM) current.refTop = REF_SHORT;
            if (structure !== PICT_TOP) current.refBottom = REF_SHORT;
        }
        this.references.push(current);
    }

    /** Sliding window marking (8.2.5.3). */
    slidingWindow(current: Picture, sps: Sps): void {
        const limit = Math.max(1, sps.numRefFrames);
        for (;;) {
            let shortTerm = 0;
            let longTerm = 0;
            for (const pic of this.references) {
                if (pic === current) continue;
                if (pic.isShortTerm()) shortTerm++;
                else if (pic.isLongTerm()) longTerm++;
            }

            if (shortTerm + longTerm < limit || shortTerm === 0) break;
            let oldest: Picture | undefined;
            for (const pic of this.references) {
                if (pic === current || !pic.isShortTerm()) continue;
                if (!oldest || pic.frameNumWrap < oldest.frameNumWrap) oldest = pic;
            }

            if (!oldest) break;
            if (oldest.refTop === REF_SHORT) oldest.refTop = REF_NONE;
            if (oldest.refBottom === REF_SHORT) oldest.refBottom = REF_NONE;
            this.prune();
        }
    }

    /**
     * Adaptive marking (8.2.5.4); returns whether memory_management_control_operation 5 was
     * present.
     */
    private applyMmcos(
        mmcos: readonly Mmco[],
        current: Picture,
        structure: number,
        sps: Sps,
    ): boolean {
        let mmco5 = false;
        const frame = structure === PICT_FRAME;
        const currPicNum = frame ? current.frameNum : 2 * current.frameNum + 1;
        for (const op of mmcos) {
            switch (op.op) {
                case 1: {
                    const picNum = currPicNum - op.differenceOfPicNums;
                    const entry = this.findShortTerm(picNum, current, structure);
                    if (entry) this.unmark(entry.pic, entry.parity);
                    break;
                }
                case 2: {
                    const entry = this.findLongTerm(op.longTermPicNum, current, structure);
                    if (entry) this.unmark(entry.pic, entry.parity);
                    break;
                }
                case 3: {
                    const picNum = currPicNum - op.differenceOfPicNums;
                    const entry = this.findShortTerm(picNum, current, structure);
                    if (!entry) break;
                    this.freeLongTermIdx(op.longTermFrameIdx, entry.pic);
                    entry.pic.longTermFrameIdx = op.longTermFrameIdx;
                    if (entry.parity === PICT_FRAME)
                        entry.pic.refTop = entry.pic.refBottom = REF_LONG;
                    else if (entry.parity === PICT_TOP) entry.pic.refTop = REF_LONG;
                    else entry.pic.refBottom = REF_LONG;
                    break;
                }
                case 4: {
                    this.maxLongTermFrameIdx = op.maxLongTermFrameIdxPlus1 - 1;
                    for (const pic of this.references) {
                        if (pic.isLongTerm() && pic.longTermFrameIdx > this.maxLongTermFrameIdx) {
                            if (pic.refTop === REF_LONG) pic.refTop = REF_NONE;
                            if (pic.refBottom === REF_LONG) pic.refBottom = REF_NONE;
                        }
                    }
                    break;
                }
                case 5: {
                    for (const pic of this.references) {
                        if (pic === current) continue;
                        pic.refTop = REF_NONE;
                        pic.refBottom = REF_NONE;
                    }

                    this.maxLongTermFrameIdx = -1;
                    mmco5 = true;
                    break;
                }
                case 6: {
                    this.freeLongTermIdx(op.longTermFrameIdx, current);
                    current.longTermFrameIdx = op.longTermFrameIdx;
                    if (frame) current.refTop = current.refBottom = REF_LONG;
                    else if (structure === PICT_TOP) current.refTop = REF_LONG;
                    else current.refBottom = REF_LONG;
                    break;
                }
                default:
                    break;
            }
            this.prune();
        }

        if (!frame) this.slidingWindowIfFull(current, sps);
        else this.slidingWindowIfFull(current, sps);
        return mmco5;
    }

    /** Keeps damaged streams within the reference limit after adaptive marking. */
    private slidingWindowIfFull(current: Picture, sps: Sps): void {
        let count = 0;
        for (const pic of this.references) if (pic !== current && pic.isReference()) count++;
        if (count > Math.max(1, sps.numRefFrames)) this.slidingWindow(current, sps);
    }

    private unmark(pic: Picture, parity: number): void {
        if (parity === PICT_FRAME || parity === PICT_TOP) pic.refTop = REF_NONE;
        if (parity === PICT_FRAME || parity === PICT_BOTTOM) pic.refBottom = REF_NONE;
    }

    /**
     * Frees LongTermFrameIdx `idx` held by another frame or by a field that is not part of `keep`.
     */
    private freeLongTermIdx(idx: number, keep: Picture): void {
        for (const pic of this.references) {
            if (pic === keep || !pic.isLongTerm() || pic.longTermFrameIdx !== idx) continue;
            if (pic.refTop === REF_LONG) pic.refTop = REF_NONE;
            if (pic.refBottom === REF_LONG) pic.refBottom = REF_NONE;
        }
    }
}

/** Alternating-parity field ordering of 8.2.4.2.5 appended to `out`. */
function alternateFields(
    frames: readonly Picture[],
    parity: number,
    kind: number,
    current: Picture,
    out: RefEntry[],
): void {
    const same: RefEntry[] = [];
    const other: RefEntry[] = [];
    const opposite = otherParity(parity);
    for (const pic of frames) {
        if (pic === current) {
            if (pic.refOf(opposite) === kind)
                other.push(refEntry(pic, opposite, kind === REF_LONG));
            continue;
        }
        if (pic.refOf(parity) === kind) same.push(refEntry(pic, parity, kind === REF_LONG));
        if (pic.refOf(opposite) === kind) other.push(refEntry(pic, opposite, kind === REF_LONG));
    }

    let i = 0;
    let j = 0;
    let takeSame = true;
    while (i < same.length || j < other.length) {
        if (takeSame && i < same.length) out.push(same[i++]);
        else if (!takeSame && j < other.length) out.push(other[j++]);
        else if (i < same.length) out.push(same[i++]);
        else out.push(other[j++]);
        takeSame = !takeSame;
    }
}
