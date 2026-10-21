// Inter macroblocks of CABAC P and B slices without MBAFF, 4:2:0 or monochrome (the macroblock
// layer of src/codecs/h264/slice-decoder.ts: skip, mb_type, ref_idx, mvd, motion vector and direct
// prediction, coded block pattern, QP delta, residual, motion compensation and the stored
// macroblock state) in the JavaScript subset of scripts/wasm-scalar.mjs, compiled into the kernel
// module by scripts/h264-kernels.mjs (read as text, never run). Upper-case names are constants and
// addresses of that script: the slice block at SCRATCH_SLICE holds the slice parameters (S_*), the
// reference entries (ENTRIES), the weights and the state of the macroblock (M_*). With S_WAIT set,
// other threads decode the references: wait_rows(list, ref, row), imported, returns once macroblock
// row `row` of the reference is final (every row past the last).

/** Cache index of the 4x4 block (x, y) of the macroblock, -1 <= x <= 4, -1 <= y <= 3 (cacheAt). */
function inline_at(x, y) {
    return (y + 1) * 8 + 4 + x;
}

/** Address of reference entry `ref` of `list` in the slice block. */
function inline_entry(sb, list, ref) {
    return sb + ENTRIES + list * ENTRY_LIST_BYTES + ref * ENTRY_BYTES;
}

/** Whether macroblock `xy` exists and belongs to the current slice. */
function available(sb, xy) {
    return xy >= 0 && load32(load32(sb + S_SLICE_NUM) + xy * 4) === load32(sb + S_SLICE);
}

/** Position, sample offsets and neighbours of macroblock (x, y) (setPosition, fillNeighbors). */
function locate(sb, x, y) {
    const mbWidth = load32(sb + S_MB_WIDTH);
    const field = load32(sb + S_FIELD);
    const lumaStride = load32(sb + S_LUMA_STRIDE);
    const chromaStride = load32(sb + S_CHROMA_STRIDE);
    const xy = y * mbWidth + x;
    store32(sb + M_X, x);
    store32(sb + M_Y, y);
    store32(sb + M_XY, xy);
    if (field) {
        store32(sb + M_STRIDE, lumaStride * 2);
        store32(sb + M_LUMA, ((y >> 1) * 32 + (y & 1)) * lumaStride + x * 16);
        store32(sb + M_CSTRIDE, chromaStride * 2);
        store32(sb + M_CHROMA, ((y >> 1) * 16 + (y & 1)) * chromaStride + x * 8);
    } else {
        store32(sb + M_STRIDE, lumaStride);
        store32(sb + M_LUMA, y * 16 * lumaStride + x * 16);
        store32(sb + M_CSTRIDE, chromaStride);
        store32(sb + M_CHROMA, y * 8 * chromaStride + x * 8);
    }
    let top = xy - (field ? mbWidth * 2 : mbWidth);
    if (top < 0) top = -1;
    const topLeft = top >= 0 && x > 0 ? top - 1 : -1;
    const topRight = top >= 0 && x + 1 < mbWidth ? top + 1 : -1;
    const left = x > 0 ? xy - 1 : -1;
    store32(sb + M_TOP, top);
    store32(sb + M_TOPLEFT, topLeft);
    store32(sb + M_TOPRIGHT, topRight);
    store32(sb + M_LEFT, left);
    store32(sb + M_TOP_AVAIL, available(sb, top));
    store32(sb + M_TOPLEFT_AVAIL, available(sb, topLeft));
    store32(sb + M_TOPRIGHT_AVAIL, available(sb, topRight));
    store32(sb + M_LEFT_AVAIL, available(sb, left));
}

// -------------------------------------------------------------------------------------------------
// Caches

/**
 * fillCacheEntry: one neighbouring 4x4 block's reference, vector and mvd into cache position `pos`.
 */
function cache_entry(scratch, sb, list, mb, avail, blk, pos) {
    const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
    const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
    const mvdCache = scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES;
    if (!avail) {
        store8(refCache + pos, PART_NOT_AVAILABLE);
        store32(mvCache + pos * 4, 0);
        store16(mvdCache + pos * 2, 0);
        return;
    }
    if (load8u(load32(sb + S_FLAGS) + mb) & MB_INTRA) {
        store8(refCache + pos, LIST_NOT_USED);
        store32(mvCache + pos * 4, 0);
        store16(mvdCache + pos * 2, 0);
        return;
    }
    const refs = load32(sb + (list ? S_REF1 : S_REF0));
    store8(refCache + pos, load8s(refs + mb * 4 + (blk >> 3) * 2 + ((blk & 3) >> 1)));
    store32(mvCache + pos * 4, load32(load32(sb + (list ? S_MV1 : S_MV0)) + (mb * 16 + blk) * 4));
    const mvd = load32(sb + (list ? S_MVD1 : S_MVD0));
    store16(mvdCache + pos * 2, load16u(mvd + (mb * 8 + load8u(MVD_SLOT + blk)) * 2));
}

/**
 * fillCacheColumn: blocks first, first + step, ... of a neighbour into positions pos, pos +
 * posStep, ...
 */
function cache_column(scratch, sb, list, mb, avail, first, step, pos, posStep) {
    const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
    const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
    const mvdCache = scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES;
    if (!avail || load8u(load32(sb + S_FLAGS) + mb) & MB_INTRA) {
        const ref = avail ? LIST_NOT_USED : PART_NOT_AVAILABLE;
        for (let k = 0; k < 4; k++) {
            const p = pos + k * posStep;
            store8(refCache + p, ref);
            store32(mvCache + p * 4, 0);
            store16(mvdCache + p * 2, 0);
        }
        return;
    }
    const refs = load32(sb + (list ? S_REF1 : S_REF0));
    const b8 = mb * 4 + (first >> 3) * 2 + ((first & 3) >> 1);
    const refA = load8s(refs + b8);
    const refB = load8s(refs + b8 + (step === 1 ? 1 : 2));
    const mvs = load32(sb + (list ? S_MV1 : S_MV0)) + (mb * 16 + first) * 4;
    const mvd = load32(sb + (list ? S_MVD1 : S_MVD0)) + mb * 16;
    for (let k = 0; k < 4; k++) {
        const p = pos + k * posStep;
        store8(refCache + p, k < 2 ? refA : refB);
        store32(mvCache + p * 4, load32(mvs + k * step * 4));
        store16(mvdCache + p * 2, load16u(mvd + load8u(MVD_SLOT + first + k * step) * 2));
    }
}

/**
 * fillPredictionNeighbours: neighbours A, B, C and D of the whole macroblock in the motion cache of
 * `list`.
 */
function prediction_neighbours(scratch, sb, list) {
    cache_entry(scratch, sb, list, load32(sb + M_LEFT), load32(sb + M_LEFT_AVAIL), 3, 11);
    cache_entry(scratch, sb, list, load32(sb + M_TOP), load32(sb + M_TOP_AVAIL), 12, 4);
    cache_entry(scratch, sb, list, load32(sb + M_TOPRIGHT), load32(sb + M_TOPRIGHT_AVAIL), 12, 8);
    cache_entry(scratch, sb, list, load32(sb + M_TOPLEFT), load32(sb + M_TOPLEFT_AVAIL), 15, 3);
}

/** fillCaches of an inter macroblock: coefficient counts, motion of both lists, direct flags. */
function fill_caches(scratch, sb) {
    const nnzCache = scratch + SCRATCH_NNZ;
    const nnz = load32(sb + S_NNZ);
    const top = load32(sb + M_TOP);
    const left = load32(sb + M_LEFT);
    const topAvail = load32(sb + M_TOP_AVAIL);
    const leftAvail = load32(sb + M_LEFT_AVAIL);
    if (topAvail) {
        const base = nnz + top * 32;
        store32(nnzCache + 4, load32(base + 12));
        store8(nnzCache + 44, load8u(base + 18));
        store8(nnzCache + 45, load8u(base + 19));
        store8(nnzCache + 84, load8u(base + 26));
        store8(nnzCache + 85, load8u(base + 27));
    } else {
        store32(nnzCache + 4, 0);
        store16(nnzCache + 44, 0);
        store16(nnzCache + 84, 0);
    }
    for (let i = 0; i < 4; i++)
        store8(nnzCache + (i + 1) * 8 + 3, leftAvail ? load8u(nnz + left * 32 + i * 4 + 3) : 0);
    for (let i = 0; i < 2; i++) {
        store8(
            nnzCache + (6 + i) * 8 + 3,
            leftAvail ? load8u(nnz + left * 32 + 16 + i * 2 + 1) : 0,
        );
        store8(
            nnzCache + (11 + i) * 8 + 3,
            leftAvail ? load8u(nnz + left * 32 + 24 + i * 2 + 1) : 0,
        );
    }
    const bSlice = load32(sb + S_B);
    for (let list = 0; list <= bSlice; list++) {
        cache_column(scratch, sb, list, top, topAvail, 12, 1, 4, 1);
        cache_column(scratch, sb, list, left, leftAvail, 3, 4, 11, 8);
        cache_entry(
            scratch,
            sb,
            list,
            load32(sb + M_TOPRIGHT),
            load32(sb + M_TOPRIGHT_AVAIL),
            12,
            8,
        );
        cache_entry(scratch, sb, list, load32(sb + M_TOPLEFT), load32(sb + M_TOPLEFT_AVAIL), 15, 3);
        const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
        store8(refCache + 12, PART_NOT_AVAILABLE);
        store8(refCache + 20, PART_NOT_AVAILABLE);
        store8(refCache + 28, PART_NOT_AVAILABLE);
    }
    if (bSlice) {
        const direct = scratch + SCRATCH_DIRECT_CACHE;
        const masks = load32(sb + S_DIRECT);
        const topMask = topAvail ? load8u(masks + top) : 0;
        store8(direct + 4, (topMask >> 2) & 1);
        store8(direct + 5, (topMask >> 2) & 1);
        store8(direct + 6, (topMask >> 3) & 1);
        store8(direct + 7, (topMask >> 3) & 1);
        const leftMask = leftAvail ? load8u(masks + left) : 0;
        for (let i = 0; i < 4; i++)
            store8(direct + (i + 1) * 8 + 3, (leftMask >> (1 + 2 * (i >> 1))) & 1);
        store8(direct + 8, 0);
        store8(direct + 3, 0);
        for (let y = 0; y < 4; y++) store32(direct + (y + 1) * 8 + 4, 0);
    }
}

/** clearNnz: no coefficients in the macroblock. */
function clear_nnz(scratch, sb) {
    const nnzCache = scratch + SCRATCH_NNZ;
    for (let y = 1; y <= 4; y++) store32(nnzCache + y * 8 + 4, 0);
    for (let y = 6; y <= 9; y++) store16(nnzCache + y * 8 + 4, 0);
    for (let y = 11; y <= 14; y++) store16(nnzCache + y * 8 + 4, 0);
    store8(load32(sb + S_DC) + load32(sb + M_XY), 0);
}

/** Sets the reference and vector of the w4 x h4 blocks at (x4, y4) (fillMotion). */
function fill_motion(scratch, list, x4, y4, w4, h4, ref, mv) {
    const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
    const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
    for (let y = y4; y < y4 + h4; y++) {
        const p = inline_at(x4, y);
        for (let x = 0; x < w4; x++) {
            store8(refCache + p + x, ref);
            store32(mvCache + (p + x) * 4, mv);
        }
    }
}

/** fillMvd: the absolute mvd pair, each clipped to 255, of the w4 x h4 blocks at (x4, y4). */
function fill_mvd(scratch, list, x4, y4, w4, h4, mvdx, mvdy) {
    const mvdCache = scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES;
    const ax = mvdx < 0 ? -mvdx : mvdx;
    const ay = mvdy < 0 ? -mvdy : mvdy;
    const pair = (ax < 255 ? ax : 255) | ((ay < 255 ? ay : 255) << 8);
    for (let y = y4; y < y4 + h4; y++) {
        const p = inline_at(x4, y);
        for (let x = 0; x < w4; x++) store16(mvdCache + (p + x) * 2, pair);
    }
}

/**
 * A motion vector as the 32-bit word of its components (x low, y high), each clipped to 16 bits.
 */
function pack_mv(x, y) {
    const cx = x < -32768 ? -32768 : x > 32767 ? 32767 : x;
    const cy = y < -32768 ? -32768 : y > 32767 ? 32767 : y;
    return (cx & 0xffff) | (cy << 16);
}

function median(a, b, c) {
    return max(min(a, b), min(max(a, b), c));
}

// -------------------------------------------------------------------------------------------------
// Motion vector prediction (8.4.1.3)

/**
 * predictMv for the partition at (x4, y4) of w4 blocks with reference refIdx; returns the packed
 * vector (median or directional prediction). `firstBlk` is the blkIdx of the partition's first 4x4
 * block.
 */
function predict_mv(scratch, list, x4, y4, w4, refIdx, shape, firstBlk) {
    const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
    const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
    const a = inline_at(x4 - 1, y4);
    const b = inline_at(x4, y4 - 1);
    let c = inline_at(x4 + w4, y4 - 1);
    const cx = x4 + w4;
    const cy = y4 - 1;
    let refC = 0;
    if (cy < 0) refC = load8s(refCache + c);
    else if (cx > 3) refC = PART_NOT_AVAILABLE;
    else
        refC =
            load8u(RASTER_TO_BLOCK + cy * 4 + cx) < firstBlk
                ? load8s(refCache + c)
                : PART_NOT_AVAILABLE;
    if (refC === PART_NOT_AVAILABLE) {
        c = inline_at(x4 - 1, y4 - 1);
        refC = load8s(refCache + c);
    }
    const refA = load8s(refCache + a);
    const refB = load8s(refCache + b);
    if (shape === SHAPE_16X8) {
        if (y4 === 0) {
            if (refB === refIdx) return load32(mvCache + b * 4);
        } else if (refA === refIdx) return load32(mvCache + a * 4);
    } else if (shape === SHAPE_8X16) {
        if (x4 === 0) {
            if (refA === refIdx) return load32(mvCache + a * 4);
        } else if (refC === refIdx) return load32(mvCache + c * 4);
    }
    const matches = (refA === refIdx) + (refB === refIdx) + (refC === refIdx);
    if (matches === 1) {
        const pos = refA === refIdx ? a : refB === refIdx ? b : c;
        return load32(mvCache + pos * 4);
    }
    if (refB === PART_NOT_AVAILABLE && refC === PART_NOT_AVAILABLE && refA !== PART_NOT_AVAILABLE)
        return load32(mvCache + a * 4);
    const mx = median(load16s(mvCache + a * 4), load16s(mvCache + b * 4), load16s(mvCache + c * 4));
    const my = median(
        load16s(mvCache + a * 4 + 2),
        load16s(mvCache + b * 4 + 2),
        load16s(mvCache + c * 4 + 2),
    );
    return (mx & 0xffff) | (my << 16);
}

/** P_Skip motion (8.4.1.1). */
function skip_motion(scratch) {
    const refCache = scratch + SCRATCH_REF_CACHE;
    const mvCache = scratch + SCRATCH_MV_CACHE;
    const refA = load8s(refCache + 11);
    const refB = load8s(refCache + 4);
    let mv = 0;
    if (
        refA !== PART_NOT_AVAILABLE &&
        refB !== PART_NOT_AVAILABLE &&
        !(refA === 0 && load32(mvCache + 44) === 0) &&
        !(refB === 0 && load32(mvCache + 16) === 0)
    )
        mv = predict_mv(scratch, 0, 0, 0, 4, 0, SHAPE_16X16, 0);
    fill_motion(scratch, 0, 0, 0, 4, 4, 0, mv);
    fill_motion(scratch, 1, 0, 0, 4, 4, LIST_NOT_USED, 0);
}

// -------------------------------------------------------------------------------------------------
// Direct prediction (8.4.1.2)

/**
 * Sets the four cache blocks of 8x8 block i8 to the given references and packed vectors of both
 * lists.
 */
function fill_direct8x8(scratch, i8, ref0, mv0, ref1, mv1) {
    const p = inline_at((i8 & 1) * 2, (i8 >> 1) * 2);
    const refs0 = scratch + SCRATCH_REF_CACHE;
    const refs1 = refs0 + REF_CACHE_BYTES;
    const mvs0 = scratch + SCRATCH_MV_CACHE;
    const mvs1 = mvs0 + MV_CACHE_BYTES;
    store16(refs0 + p, (ref0 & 255) | (ref0 << 8));
    store16(refs0 + p + 8, (ref0 & 255) | (ref0 << 8));
    store16(refs1 + p, (ref1 & 255) | (ref1 << 8));
    store16(refs1 + p + 8, (ref1 & 255) | (ref1 << 8));
    store32(mvs0 + p * 4, mv0);
    store32(mvs0 + p * 4 + 4, mv0);
    store32(mvs0 + p * 4 + 32, mv0);
    store32(mvs0 + p * 4 + 36, mv0);
    store32(mvs1 + p * 4, mv1);
    store32(mvs1 + p * 4 + 4, mv1);
    store32(mvs1 + p * 4 + 32, mv1);
    store32(mvs1 + p * 4 + 36, mv1);
}

/**
 * locateColocated: the colocated macroblock(s) and their vertical relation, in the M_COL_* fields.
 */
function locate_colocated(sb) {
    if (load32(sb + S_WAIT))
        wait_rows(1, 0, load32(sb + S_FIELD) ? load32(sb + S_MB_HEIGHT) : load32(sb + M_Y));
    const stride = load32(sb + S_MB_WIDTH);
    const colFlags = load32(sb + S_COL_FLAGS);
    const mbX = load32(sb + M_X);
    const mbY = load32(sb + M_Y);
    const field = load32(sb + S_FIELD);
    let xy = load32(sb + M_XY);
    let mixed = 0;
    let shift = 0;
    let xy2 = 0;
    const colFieldOffset = load32(sb + S_COL_FIELD_OFFSET);
    if (load8u(colFlags + xy + stride * colFieldOffset) & MB_FIELD) {
        if (!field) {
            xy = mbX + ((mbY & ~1) + load32(sb + S_COL_PARITY)) * stride;
            mixed = 1;
            shift = 1;
        } else xy += stride * colFieldOffset;
        xy2 = xy;
    } else if (field) {
        xy = mbX + (mbY & ~1) * stride;
        xy2 = xy + stride;
        mixed = 1;
        shift = -1;
    } else xy2 = xy;
    store32(sb + M_COL_XY, xy);
    store32(sb + M_COL_XY2, xy2);
    store32(sb + M_COL_MIXED, mixed);
    store32(sb + M_COL_SHIFT, shift);
}

/**
 * colBlock(i8, true): raster 4x4 index in the colocated macroblock of the corner of 8x8 block i8.
 */
function col_block(sb, i8) {
    const x8 = i8 & 1;
    const y8 = i8 >> 1;
    if (!load32(sb + M_COL_MIXED)) return y8 * 12 + x8 * 3;
    if (load32(sb + M_COL_SHIFT) === 1) return ((load32(sb + M_Y) & 1 ? 2 : 0) + y8) * 4 + x8 * 3;
    return (y8 ? 2 : 0) * 4 + x8 * 3;
}

function spatial_direct(scratch, sb, mask) {
    let ref0 = -1;
    let ref1 = -1;
    let mv0x = 0;
    let mv0y = 0;
    let mv1x = 0;
    let mv1y = 0;
    for (let list = 0; list < 2; list++) {
        const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
        const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
        const a = 11;
        const b = 4;
        let c = 8;
        let refC = load8s(refCache + c);
        if (refC === PART_NOT_AVAILABLE) {
            c = 3;
            refC = load8s(refCache + c);
        }
        const refA = load8s(refCache + a);
        const refB = load8s(refCache + b);
        let r = -1;
        if (refA >= 0) r = refA;
        if (refB >= 0 && (r < 0 || refB < r)) r = refB;
        if (refC >= 0 && (r < 0 || refC < r)) r = refC;
        let mx = 0;
        let my = 0;
        if (r >= 0) {
            const matches = (refA === r) + (refB === r) + (refC === r);
            if (matches > 1) {
                mx = median(
                    load16s(mvCache + a * 4),
                    load16s(mvCache + b * 4),
                    load16s(mvCache + c * 4),
                );
                my = median(
                    load16s(mvCache + a * 4 + 2),
                    load16s(mvCache + b * 4 + 2),
                    load16s(mvCache + c * 4 + 2),
                );
            } else {
                const pos = refA === r ? a : refB === r ? b : c;
                mx = load16s(mvCache + pos * 4);
                my = load16s(mvCache + pos * 4 + 2);
            }
        }
        if (list) {
            ref1 = r;
            mv1x = mx;
            mv1y = my;
        } else {
            ref0 = r;
            mv0x = mx;
            mv0y = my;
        }
    }
    if (ref0 < 0 && ref1 < 0) {
        ref0 = 0;
        ref1 = 0;
    }
    const mv0 = ref0 >= 0 ? (mv0x & 0xffff) | (mv0y << 16) : 0;
    const mv1 = ref1 >= 0 ? (mv1x & 0xffff) | (mv1y << 16) : 0;
    const col = inline_entry(sb, 1, 0);
    if (!(mv0x | mv0y | mv1x | mv1y) || !load32(col + E_PRESENT) || load32(col + E_LONG)) {
        for (let i8 = 0; i8 < 4; i8++)
            if ((mask >> i8) & 1) fill_direct8x8(scratch, i8, ref0, mv0, ref1, mv1);
        return;
    }
    locate_colocated(sb);
    const colFlags = load32(sb + S_COL_FLAGS);
    const colRef0 = load32(sb + S_COL_REF0);
    const colRef1 = load32(sb + S_COL_REF1);
    const mixed = load32(sb + M_COL_MIXED);
    const shift = load32(sb + M_COL_SHIFT);
    const inference = load32(sb + S_DIRECT_8X8) || mixed;
    const mbY = load32(sb + M_Y);
    for (let i8 = 0; i8 < 4; i8++) {
        if (!((mask >> i8) & 1)) continue;
        fill_direct8x8(scratch, i8, ref0, mv0, ref1, mv1);
        const colXy =
            mixed && shift === -1 && i8 >= 2 ? load32(sb + M_COL_XY2) : load32(sb + M_COL_XY);
        if (load8u(colFlags + colXy) & MB_INTRA) continue;
        const b8 = shift === 1 ? (mbY & 1) * 2 + (i8 & 1) : i8;
        const r0 = load8s(colRef0 + colXy * 4 + b8);
        const r1 = load8s(colRef1 + colXy * 4 + b8);
        let colMv = 0;
        if (r0 === 0) colMv = load32(sb + S_COL_MV0);
        else if (r0 < 0 && r1 === 0) colMv = load32(sb + S_COL_MV1);
        else continue;
        if (inference) {
            const blk = col_block(sb, i8);
            const mx = load16s(colMv + (colXy * 16 + blk) * 4);
            const my = load16s(colMv + (colXy * 16 + blk) * 4 + 2);
            if (mx >= -1 && mx <= 1 && my >= -1 && my <= 1)
                fill_direct8x8(scratch, i8, ref0, ref0 === 0 ? 0 : mv0, ref1, ref1 === 0 ? 0 : mv1);
        } else {
            const x4 = (i8 & 1) * 2;
            const y4 = (i8 >> 1) * 2;
            for (let i4 = 0; i4 < 4; i4++) {
                const bx = x4 + (i4 & 1);
                const by = y4 + (i4 >> 1);
                const blk = by * 4 + bx;
                const mx = load16s(colMv + (colXy * 16 + blk) * 4);
                const my = load16s(colMv + (colXy * 16 + blk) * 4 + 2);
                if (mx >= -1 && mx <= 1 && my >= -1 && my <= 1) {
                    const p = inline_at(bx, by);
                    if (ref0 === 0) store32(scratch + SCRATCH_MV_CACHE + p * 4, 0);
                    if (ref1 === 0) store32(scratch + SCRATCH_MV_CACHE + MV_CACHE_BYTES + p * 4, 0);
                }
            }
        }
    }
}

/**
 * MapColToList0 (8.4.1.2.3): the lowest list 0 index referencing the colocated block's reference
 * id.
 */
function map_col_to_list0(sb, refId, colFieldMb) {
    if (refId < 0) return 0;
    const serial = refId >> 2;
    const parity = refId & 3;
    const field = load32(sb + S_FIELD);
    let want = PICT_FRAME;
    if (field && colFieldMb) want = parity;
    else if (field) want = load32(sb + S_STRUCTURE);
    const count = load32(sb + S_COUNT0);
    for (let i = 0; i < count; i++) {
        const entry = inline_entry(sb, 0, i);
        if (load32(entry + E_ID) >> 2 === serial && load32(entry + E_PARITY) === want) return i;
    }
    return 0;
}

function temporal_direct(scratch, sb, mask) {
    if (!load32(inline_entry(sb, 1, 0) + E_PRESENT)) {
        for (let i8 = 0; i8 < 4; i8++)
            if ((mask >> i8) & 1) fill_direct8x8(scratch, i8, 0, 0, 0, 0);
        return;
    }
    locate_colocated(sb);
    const colFlags = load32(sb + S_COL_FLAGS);
    const mixed = load32(sb + M_COL_MIXED);
    const shift = load32(sb + M_COL_SHIFT);
    const inference = load32(sb + S_DIRECT_8X8) || mixed;
    const mbY = load32(sb + M_Y);
    for (let i8 = 0; i8 < 4; i8++) {
        if (!((mask >> i8) & 1)) continue;
        const x4 = (i8 & 1) * 2;
        const y4 = (i8 >> 1) * 2;
        const colXy =
            mixed && shift === -1 && i8 >= 2 ? load32(sb + M_COL_XY2) : load32(sb + M_COL_XY);
        if (load8u(colFlags + colXy) & MB_INTRA) {
            fill_direct8x8(scratch, i8, 0, 0, 0, 0);
            continue;
        }
        const b8 = shift === 1 ? (mbY & 1) * 2 + (i8 & 1) : i8;
        let colList = 0;
        let refCol = load8s(load32(sb + S_COL_REF0) + colXy * 4 + b8);
        if (refCol < 0) {
            colList = 1;
            refCol = load8s(load32(sb + S_COL_REF1) + colXy * 4 + b8);
        }
        const refIdCol = load32(
            load32(sb + (colList ? S_COL_REFID1 : S_COL_REFID0)) + (colXy * 4 + b8) * 4,
        );
        const colFieldMb = (load8u(colFlags + colXy) & MB_FIELD) !== 0;
        const refIdx0 = map_col_to_list0(sb, refIdCol, colFieldMb);
        const scale = load32(sb + DIST_SCALE + refIdx0 * 4);
        const colMv = load32(sb + (colList ? S_COL_MV1 : S_COL_MV0));
        const blocks = inference ? 1 : 4;
        for (let i4 = 0; i4 < blocks; i4++) {
            const bx = x4 + (i4 & 1);
            const by = y4 + (i4 >> 1);
            const blk = inference ? col_block(sb, i8) : by * 4 + bx;
            const mvColX = load16s(colMv + (colXy * 16 + blk) * 4);
            let mvColY = load16s(colMv + (colXy * 16 + blk) * 4 + 2);
            if (shift === 1) mvColY *= 2;
            else if (shift === -1) mvColY = mvColY < 0 ? -(-mvColY >> 1) : mvColY >> 1;
            const mx = (scale * mvColX + 128) >> 8;
            const my = (scale * mvColY + 128) >> 8;
            const mv0 = pack_mv(mx, my);
            const mv1 = pack_mv(mx - mvColX, my - mvColY);
            if (inference) fill_direct8x8(scratch, i8, refIdx0, mv0, 0, mv1);
            else {
                const p = inline_at(bx, by);
                store8(scratch + SCRATCH_REF_CACHE + p, refIdx0);
                store8(scratch + SCRATCH_REF_CACHE + REF_CACHE_BYTES + p, 0);
                store32(scratch + SCRATCH_MV_CACHE + p * 4, mv0);
                store32(scratch + SCRATCH_MV_CACHE + MV_CACHE_BYTES + p * 4, mv1);
            }
        }
    }
}

/**
 * deriveDirect: the direct motion of the 8x8 blocks in `mask`, marking them in the direct cache.
 */
function derive_direct(scratch, sb, mask) {
    if (load32(sb + S_DIRECT_SPATIAL)) spatial_direct(scratch, sb, mask);
    else temporal_direct(scratch, sb, mask);
    const direct = scratch + SCRATCH_DIRECT_CACHE;
    for (let i = 0; i < 4; i++) {
        if (!((mask >> i) & 1)) continue;
        const p = inline_at((i & 1) * 2, (i >> 1) * 2);
        store16(direct + p, 0x0101);
        store16(direct + p + 8, 0x0101);
    }
}

// -------------------------------------------------------------------------------------------------
// Syntax elements

/** mb_qp_delta (9.3.2.7, 9.3.3.1.1.5); returns 1000 when out of range. */
function qp_delta(scratch, lastDelta) {
    let ctx = lastDelta !== 0;
    let val = 0;
    while (cabac_bin(scratch, 60 + ctx)) {
        ctx = 2 + (ctx >> 1);
        val++;
        if (val > 104) return 1000;
    }
    return val & 1 ? (val + 1) >> 1 : -(val >> 1);
}

/** Neighbour coded_block_pattern for the contexts (neighbourCbp). */
function neighbour_cbp(sb, mb, avail) {
    if (!avail) return 0x0f;
    const flags = load8u(load32(sb + S_FLAGS) + mb);
    if (flags & MB_PCM) return 0x3f;
    if (flags & MB_SKIP) return 0;
    return load8u(load32(sb + S_CBP) + mb);
}

function decode_cbp(scratch, sb) {
    const a = neighbour_cbp(sb, load32(sb + M_LEFT), load32(sb + M_LEFT_AVAIL));
    const b = neighbour_cbp(sb, load32(sb + M_TOP), load32(sb + M_TOP_AVAIL));
    const bitA0 = (a >> 1) & 1;
    const bitA2 = (a >> 3) & 1;
    let cbp = cabac_bin(scratch, 73 + (bitA0 ? 0 : 1) + (b & 4 ? 0 : 2));
    cbp |= cabac_bin(scratch, 73 + (cbp & 1 ? 0 : 1) + (b & 8 ? 0 : 2)) << 1;
    cbp |= cabac_bin(scratch, 73 + (bitA2 ? 0 : 1) + (cbp & 1 ? 0 : 2)) << 2;
    cbp |= cabac_bin(scratch, 73 + (cbp & 4 ? 0 : 1) + (cbp & 2 ? 0 : 2)) << 3;
    if (load32(sb + S_CHROMA)) {
        if (cabac_bin(scratch, 77 + (a & 0x30 ? 1 : 0) + (b & 0x30 ? 2 : 0))) {
            cbp += 16 + 16 * cabac_bin(scratch, 77 + 4 + (a & 0x20 ? 1 : 0) + (b & 0x20 ? 2 : 0));
        }
    }
    return cbp;
}

/** ref_idx (9.3.3.1.1.6); returns 1000 past 32. */
function decode_ref_idx(scratch, list, x4, y4) {
    const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
    const direct = scratch + SCRATCH_DIRECT_CACHE;
    const a = inline_at(x4 - 1, y4);
    const b = inline_at(x4, y4 - 1);
    let ctx = 0;
    if (load8s(refCache + a) > 0 && !load8u(direct + a)) ctx++;
    if (load8s(refCache + b) > 0 && !load8u(direct + b)) ctx += 2;
    if (!cabac_bin(scratch, 54 + ctx)) return 0;
    let ref = 1;
    ctx = 4;
    while (cabac_bin(scratch, 54 + ctx)) {
        ctx = 5;
        ref++;
        if (ref > 32) return 1000;
    }
    return ref;
}

/**
 * One mvd component (9.3.2.3 UEG3, 9.3.3.1.1.7), limited to +-2^20 (vectors are clipped to 16 bits
 * after).
 */
function decode_mvd(scratch, list, x4, y4, comp) {
    const mvdCache = scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES;
    const sum =
        load8u(mvdCache + inline_at(x4 - 1, y4) * 2 + comp) +
        load8u(mvdCache + inline_at(x4, y4 - 1) * 2 + comp);
    const base = comp ? 47 : 40;
    let ctx = sum < 3 ? 0 : sum > 32 ? 2 : 1;
    if (!cabac_bin(scratch, base + ctx)) return 0;
    let mvd = 1;
    ctx = 3;
    while (mvd < 9 && cabac_bin(scratch, base + ctx)) {
        if (ctx < 6) ctx++;
        mvd++;
    }
    if (mvd >= 9) {
        let k = 3;
        let suffix = 0;
        let overflow = 0;
        while (cabac_bypass(scratch)) {
            suffix += 1 << k;
            k++;
            if (k > 24) {
                overflow = 1;
                break;
            }
        }
        if (overflow) suffix = 1 << 20;
        else {
            while (k > 0) {
                k--;
                suffix += cabac_bypass(scratch) << k;
            }
        }
        mvd = min(mvd + suffix, 1 << 20);
    }
    return cabac_bypass(scratch) ? -mvd : mvd;
}

/** B sub_mb_type (9.3.2.5). */
function b_sub_type(scratch) {
    if (!cabac_bin(scratch, 36)) return 0;
    if (!cabac_bin(scratch, 37)) return 1 + cabac_bin(scratch, 39);
    let type = 3;
    if (cabac_bin(scratch, 38)) {
        if (cabac_bin(scratch, 39)) return 11 + cabac_bin(scratch, 39);
        type += 4;
    }
    type += 2 * cabac_bin(scratch, 39);
    type += cabac_bin(scratch, 39);
    return type;
}

/** B mb_type (9.3.2.5): 0..22, or 23 and more for intra. */
function b_mb_type(scratch, ctx) {
    if (!cabac_bin(scratch, 27 + ctx)) return 0;
    if (!cabac_bin(scratch, 27 + 3)) return 1 + cabac_bin(scratch, 27 + 5);
    let bits = cabac_bin(scratch, 27 + 4) << 3;
    bits |= cabac_bin(scratch, 27 + 5) << 2;
    bits |= cabac_bin(scratch, 27 + 5) << 1;
    bits |= cabac_bin(scratch, 27 + 5);
    if (bits < 8) return bits + 3;
    if (bits === 13) return 23;
    if (bits === 14) return 11;
    if (bits === 15) return 22;
    bits = (bits << 1) | cabac_bin(scratch, 27 + 5);
    return bits - 4;
}

/** One motion partition's mvds and vector (readInterPredictionCabac, readSubMvdsCabac). */
function partition_motion(scratch, list, x4, y4, w4, h4, ref, shape) {
    const mvdx = decode_mvd(scratch, list, x4, y4, 0);
    const mvdy = decode_mvd(scratch, list, x4, y4, 1);
    const pred = predict_mv(
        scratch,
        list,
        x4,
        y4,
        w4,
        ref,
        shape,
        load8u(RASTER_TO_BLOCK + y4 * 4 + x4),
    );
    fill_motion(
        scratch,
        list,
        x4,
        y4,
        w4,
        h4,
        ref,
        pack_mv(((pred << 16) >> 16) + mvdx, (pred >> 16) + mvdy),
    );
    fill_mvd(scratch, list, x4, y4, w4, h4, mvdx, mvdy);
}

/** Whether a reference index is coded, and its range (refIdxPresent, refIdxRange without MBAFF). */
function inline_ref_present(sb, list) {
    return load32(sb + (list ? S_ACTIVE1 : S_ACTIVE0)) > 1;
}

/** readInterPredictionCabac; returns 0, or ERROR_REF_IDX. */
function inter_prediction(scratch, sb) {
    const bSlice = load32(sb + S_B);
    const typeFlags = load32(sb + M_TYPE_FLAGS);
    if (typeFlags & MB_DIRECT16) {
        store32(sb + M_DIRECT, 15);
        derive_direct(scratch, sb, 15);
        fill_mvd(scratch, 0, 0, 0, 4, 4, 0, 0);
        fill_mvd(scratch, 1, 0, 0, 4, 4, 0, 0);
        return 0;
    }
    store32(sb + M_DIRECT, 0);
    const shape = load32(sb + M_SHAPE);
    const parsed = sb + M_REF_PARSED;
    if (shape === SHAPE_8X8) {
        let directMask = 0;
        for (let i = 0; i < 4; i++) {
            if (bSlice) {
                const sub = b_sub_type(scratch);
                store8(sb + M_SUB_PRED + i, load8u(B_SUB_PRED + sub));
                store8(sb + M_SUB_SHAPE + i, load8u(B_SUB_SHAPE + sub));
                if (sub === 0) directMask |= 1 << i;
            } else {
                let sub = 0;
                if (cabac_bin(scratch, 21)) sub = 0;
                else if (!cabac_bin(scratch, 22)) sub = 1;
                else sub = cabac_bin(scratch, 23) ? 2 : 3;
                store8(sb + M_SUB_PRED + i, PRED_L0);
                store8(sb + M_SUB_SHAPE + i, sub);
            }
        }
        store32(sb + M_DIRECT, directMask);
        if (directMask) {
            derive_direct(scratch, sb, directMask);
            for (let i = 0; i < 4; i++) {
                if (!((directMask >> i) & 1)) continue;
                fill_mvd(scratch, 0, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
                fill_mvd(scratch, 1, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
            }
        }
        for (let list = 0; list <= bSlice; list++) {
            for (let i = 0; i < 4; i++) {
                if ((directMask >> i) & 1) continue;
                if (!((load8u(sb + M_SUB_PRED + i) >> list) & 1)) {
                    fill_motion(scratch, list, (i & 1) * 2, (i >> 1) * 2, 2, 2, LIST_NOT_USED, 0);
                    continue;
                }
                let ref = 0;
                if (inline_ref_present(sb, list)) {
                    ref = decode_ref_idx(scratch, list, (i & 1) * 2, (i >> 1) * 2);
                    if (ref >= load32(sb + (list ? S_ACTIVE1 : S_ACTIVE0))) return ERROR_REF_IDX;
                }
                fill_motion(scratch, list, (i & 1) * 2, (i >> 1) * 2, 2, 2, ref, 0);
                store8(parsed + list * 4 + i, ref);
            }
        }
        for (let list = 0; list <= bSlice; list++) {
            for (let i = 0; i < 4; i++) {
                if ((directMask >> i) & 1) continue;
                if (!((load8u(sb + M_SUB_PRED + i) >> list) & 1)) {
                    fill_mvd(scratch, list, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
                    continue;
                }
                const ref = load8s(parsed + list * 4 + i);
                const sub = load8u(sb + M_SUB_SHAPE + i);
                const x8 = (i & 1) * 2;
                const y8 = (i >> 1) * 2;
                if (sub === SUB_8X8) partition_motion(scratch, list, x8, y8, 2, 2, ref, SHAPE_8X8);
                else if (sub === SUB_8X4) {
                    partition_motion(scratch, list, x8, y8, 2, 1, ref, SHAPE_8X8);
                    partition_motion(scratch, list, x8, y8 + 1, 2, 1, ref, SHAPE_8X8);
                } else if (sub === SUB_4X8) {
                    partition_motion(scratch, list, x8, y8, 1, 2, ref, SHAPE_8X8);
                    partition_motion(scratch, list, x8 + 1, y8, 1, 2, ref, SHAPE_8X8);
                } else {
                    partition_motion(scratch, list, x8, y8, 1, 1, ref, SHAPE_8X8);
                    partition_motion(scratch, list, x8 + 1, y8, 1, 1, ref, SHAPE_8X8);
                    partition_motion(scratch, list, x8, y8 + 1, 1, 1, ref, SHAPE_8X8);
                    partition_motion(scratch, list, x8 + 1, y8 + 1, 1, 1, ref, SHAPE_8X8);
                }
            }
        }
        return 0;
    }
    const parts = shape === SHAPE_16X16 ? 1 : 2;
    const w4 = shape === SHAPE_8X16 ? 2 : 4;
    const h4 = shape === SHAPE_16X8 ? 2 : 4;
    for (let list = 0; list <= bSlice; list++) {
        for (let p = 0; p < parts; p++) {
            const x4 = shape === SHAPE_8X16 ? p * 2 : 0;
            const y4 = shape === SHAPE_16X8 ? p * 2 : 0;
            if (!((load8u(sb + M_PART_PRED + p) >> list) & 1)) {
                fill_motion(scratch, list, x4, y4, w4, h4, LIST_NOT_USED, 0);
                continue;
            }
            let ref = 0;
            if (inline_ref_present(sb, list)) {
                ref = decode_ref_idx(scratch, list, x4, y4);
                if (ref >= load32(sb + (list ? S_ACTIVE1 : S_ACTIVE0))) return ERROR_REF_IDX;
            }
            fill_motion(scratch, list, x4, y4, w4, h4, ref, 0);
            store8(parsed + list * 4 + p, ref);
        }
    }
    for (let list = 0; list <= bSlice; list++) {
        for (let p = 0; p < parts; p++) {
            const x4 = shape === SHAPE_8X16 ? p * 2 : 0;
            const y4 = shape === SHAPE_16X8 ? p * 2 : 0;
            if (!((load8u(sb + M_PART_PRED + p) >> list) & 1)) {
                fill_mvd(scratch, list, x4, y4, w4, h4, 0, 0);
                continue;
            }
            partition_motion(scratch, list, x4, y4, w4, h4, load8s(parsed + list * 4 + p), shape);
        }
    }
    return 0;
}

/** One bypass bin of the engine in the scratch block. */
function cabac_bypass(scratch) {
    const engine = scratch + SCRATCH_CABAC;
    const bits = scratch + SCRATCH_BITS;
    let value = load32(engine + 4) << 1;
    let bitsNeeded = load32(engine + 12) + 1;
    if (bitsNeeded >= 0) {
        bitsNeeded = -8;
        const pos = load32(engine + 8);
        value |= pos < load32(engine + 16) ? load8u(bits + pos) : 0;
        store32(engine + 8, pos + 1);
    }
    store32(engine + 12, bitsNeeded);
    const scaled = load32(engine) << 7;
    if (value >= scaled) {
        store32(engine + 4, value - scaled);
        return 1;
    }
    store32(engine + 4, value);
    return 0;
}

// -------------------------------------------------------------------------------------------------
// Motion compensation (8.4.2)

/**
 * Copies the w x h area at (x, y) of a plane (origin, size, stride) into the edge block, clamping
 * into the plane.
 */
function emulate(origin, width, height, stride, x, y, w, h, edge) {
    for (let r = 0; r < h; r++) {
        let sy = y + r;
        sy = sy < 0 ? 0 : sy > height - 1 ? height - 1 : sy;
        const row = origin + sy * stride;
        const d = edge + r * EDGE_STRIDE;
        for (let c = 0; c < w; c++) {
            let sx = x + c;
            sx = sx < 0 ? 0 : sx > width - 1 ? width - 1 : sx;
            store8(d + c, load8u(row + sx));
        }
    }
}

/**
 * MotionCompensator.luma: the w x h luma block at integer (x, y) with fractions (fx, fy) into out
 * (outStride).
 */
function mc_luma_block(scratch, entry, x, y, fx, fy, w, h, out, outStride) {
    let stride = load32(entry + E_STRIDE);
    const width = load32(entry + E_WIDTH);
    const height = load32(entry + E_HEIGHT);
    const origin = load32(entry + E_LUMA);
    let address = origin + y * stride + x;
    const left = fx ? 2 : 0;
    const top = fy ? 2 : 0;
    if (x < left || y < top || x + w + (fx ? 3 : 0) > width || y + h + (fy ? 3 : 0) > height) {
        const edge = scratch + SCRATCH_EDGE;
        emulate(origin, width, height, stride, x - 2, y - 2, w + 5, h + 5, edge);
        address = edge + 2 * EDGE_STRIDE + 2;
        stride = EDGE_STRIDE;
    }
    mc_luma(address, stride, out, outStride, w, h, fx | (fy << 2));
}

/** MotionCompensator.chroma: Cb and Cr blocks at integer (x, y) with eighth fractions (fx, fy). */
function mc_chroma_block(scratch, entry, x, y, fx, fy, w, h, cbOut, crOut, outStride) {
    const stride = load32(entry + E_CSTRIDE);
    const width = load32(entry + E_CWIDTH);
    const height = load32(entry + E_CHEIGHT);
    const origin = load32(entry + E_CB);
    const crShift = load32(entry + E_CR_SHIFT);
    if (x < 0 || y < 0 || x + w + 1 > width || y + h + 1 > height) {
        const edge = scratch + SCRATCH_EDGE;
        emulate(origin, width, height, stride, x, y, w + 1, h + 1, edge);
        mc_chroma(edge, EDGE_STRIDE, cbOut, outStride, w, h, fx, fy);
        emulate(origin + crShift, width, height, stride, x, y, w + 1, h + 1, edge);
        mc_chroma(edge, EDGE_STRIDE, crOut, outStride, w, h, fx, fy);
        return;
    }
    const p = origin + y * stride + x;
    mc_chroma(p, stride, cbOut, outStride, w, h, fx, fy);
    mc_chroma(p + crShift, stride, crOut, outStride, w, h, fx, fy);
}

/** Frame luma row of the macroblock's top (mbY * 16, or its field row for field pictures). */
function inline_mb_row(sb) {
    return load32(sb + S_FIELD) ? (load32(sb + M_Y) >> 1) * 16 : load32(sb + M_Y) * 16;
}

/** predictLuma of the partition at (px, py). */
function predict_luma(scratch, sb, entry, px, py, bw, bh, mv, out, outStride) {
    const mvx = (mv << 16) >> 16;
    const mvy = mv >> 16;
    const x = load32(sb + M_X) * 16 + px + (mvx >> 2);
    const y = inline_mb_row(sb) + py + (mvy >> 2);
    mc_luma_block(scratch, entry, x, y, mvx & 3, mvy & 3, bw, bh, out, outStride);
}

/**
 * chromaPosition (8.4.1.4 for 4:2:0): chroma block position of a partition, returning x | y << 16
 * and the fractions in M_CHROMA_FX / M_CHROMA_FY.
 */
function chroma_position(sb, entry, px, py, mv) {
    const mvx = (mv << 16) >> 16;
    let cmvy = mv >> 16;
    const parity = load32(entry + E_PARITY);
    if (load32(sb + S_FIELD) && parity !== PICT_FRAME) {
        const current = load32(sb + S_STRUCTURE);
        if (parity !== current) cmvy += current === PICT_BOTTOM ? 2 : -2;
    }
    store32(sb + M_CHROMA_FX, mvx & 7);
    store32(sb + M_CHROMA_FY, cmvy & 7);
    store32(sb + M_CHROMA_X, load32(sb + M_X) * 8 + px + (mvx >> 3));
    store32(sb + M_CHROMA_Y, (inline_mb_row(sb) >> 1) + py + (cmvy >> 3));
}

function predict_chroma(scratch, sb, entry, px, py, bw, bh, mv, cbOut, crOut, outStride) {
    chroma_position(sb, entry, px, py, mv);
    mc_chroma_block(
        scratch,
        entry,
        load32(sb + M_CHROMA_X),
        load32(sb + M_CHROMA_Y),
        load32(sb + M_CHROMA_FX),
        load32(sb + M_CHROMA_FY),
        bw,
        bh,
        cbOut,
        crOut,
        outStride,
    );
}

/**
 * MotionCompensator.blendFullSamples: false (writing nothing) when a block leaves its reference.
 */
function blend_full(
    a,
    xa,
    ya,
    aStride,
    aWidth,
    aHeight,
    b,
    xb,
    yb,
    bStride,
    bWidth,
    bHeight,
    w,
    h,
    out,
    outStride,
    bi,
) {
    if (xa < 0 || ya < 0 || xa + w > aWidth || ya + h > aHeight) return 0;
    if (xb < 0 || yb < 0 || xb + w > bWidth || yb + h > bHeight) return 0;
    const w0 = load32(bi);
    const w1 = load32(bi + 4);
    const offset = load32(bi + 8);
    const logWD = load32(bi + 12);
    const sa = a + ya * aStride + xa;
    const sb2 = b + yb * bStride + xb;
    if (w0 === w1 && w0 === 1 << logWD && offset === 0)
        avg(sa, aStride, sb2, bStride, out, outStride, w, h);
    else weight2(sa, aStride, sb2, bStride, out, outStride, w, h, w0, w1, offset, logWD);
    return 1;
}

/** combine: the bi-prediction of the prediction blocks at offset s into the picture at `out`. */
function combine(scratch, s, out, stride, w, h, bi) {
    const w0 = load32(bi);
    const w1 = load32(bi + 4);
    const offset = load32(bi + 8);
    const logWD = load32(bi + 12);
    const a = scratch + SCRATCH_PRED_A + s;
    const b = scratch + SCRATCH_PRED_B + s;
    if (w0 === w1 && w0 === 1 << logWD && offset === 0) avg(a, 16, b, 16, out, stride, w, h);
    else weight2(a, 16, b, 16, out, stride, w, h, w0, w1, offset, logWD);
}

/** fillGreyPartition. */
function grey_partition(sb, x, y, w, h) {
    const luma = load32(sb + S_LUMA) + load32(sb + M_LUMA);
    const stride = load32(sb + M_STRIDE);
    for (let r = 0; r < h; r++) fill8(luma + (y + r) * stride + x, 128, w);
    if (!load32(sb + S_CHROMA)) return;
    const cstride = load32(sb + M_CSTRIDE);
    for (let plane = 0; plane < 2; plane++) {
        const base = load32(sb + (plane ? S_CR : S_CB)) + load32(sb + M_CHROMA);
        for (let r = 0; r < h >> 1; r++)
            fill8(base + ((y >> 1) + r) * cstride + (x >> 1), 128, w >> 1);
    }
}

/**
 * awaitRows: waits for the reference rows a partition at row py of height h reads with vertical
 * vector mvy.
 */
function await_rows(sb, list, ref, py, h, mvy) {
    if (load32(sb + S_FIELD)) {
        wait_rows(list, ref, load32(sb + S_MB_HEIGHT));
        return;
    }
    const bottom = load32(sb + M_Y) * 16 + py + (mvy >> 2) + h + 3;
    wait_rows(list, ref, bottom < 0 ? 0 : bottom >> 4);
}

/** predictPartition: motion compensated prediction of the partition at (x, y) of the macroblock. */
function predict_partition(scratch, sb, x, y, w, h) {
    const pos = inline_at(x >> 2, y >> 2);
    const bSlice = load32(sb + S_B);
    const ref0 = load8s(scratch + SCRATCH_REF_CACHE + pos);
    const ref1 = bSlice
        ? load8s(scratch + SCRATCH_REF_CACHE + REF_CACHE_BYTES + pos)
        : LIST_NOT_USED;
    let entry0 = 0;
    let entry1 = 0;
    if (ref0 >= 0 && ref0 < load32(sb + S_COUNT0)) entry0 = inline_entry(sb, 0, ref0);
    if (ref1 >= 0 && ref1 < load32(sb + S_COUNT1)) entry1 = inline_entry(sb, 1, ref1);
    if (!entry0 && !entry1) {
        grey_partition(sb, x, y, w, h);
        return;
    }
    if (load32(sb + S_WAIT)) {
        const mvCache = scratch + SCRATCH_MV_CACHE + pos * 4 + 2;
        if (entry0) await_rows(sb, 0, ref0, y, h, load16s(mvCache));
        if (entry1) await_rows(sb, 1, ref1, y, h, load16s(mvCache + MV_CACHE_BYTES));
    }
    const weightMode = load32(sb + S_WEIGHT_MODE);
    const stride = load32(sb + M_STRIDE);
    const lumaDst = load32(sb + S_LUMA) + load32(sb + M_LUMA) + y * stride + x;
    const chroma = load32(sb + S_CHROMA);
    const cw = w >> 1;
    const ch = h >> 1;
    const cx = x >> 1;
    const cy = y >> 1;
    const cStride = load32(sb + M_CSTRIDE);
    const cbDst = load32(sb + S_CB) + load32(sb + M_CHROMA) + cy * cStride + cx;
    const crDst = load32(sb + S_CR) + load32(sb + M_CHROMA) + cy * cStride + cx;
    const predA = scratch + SCRATCH_PRED_A;
    const predB = scratch + SCRATCH_PRED_B;
    if (!entry0 || !entry1) {
        const list = entry0 ? 0 : 1;
        const entry = entry0 ? entry0 : entry1;
        const ref = list ? ref1 : ref0;
        const mv = load32(scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES + pos * 4);
        if (weightMode === 1) {
            const t = sb + WEIGHTS + list * WEIGHT_LIST_BYTES + ref * 12;
            const logY = load32(sb + S_LUMA_LOG2);
            const lumaWeight = load16s(t);
            const lumaOffset = load16s(t + 2);
            if (lumaWeight !== 1 << logY || lumaOffset !== 0) {
                predict_luma(scratch, sb, entry, x, y, w, h, mv, predA, 16);
                weight1(predA, 16, lumaDst, stride, w, h, lumaWeight, lumaOffset, logY);
            } else predict_luma(scratch, sb, entry, x, y, w, h, mv, lumaDst, stride);
            if (!chroma) return;
            const logC = load32(sb + S_CHROMA_LOG2);
            const cbWeight = load16s(t + 4);
            const cbOffset = load16s(t + 6);
            const crWeight = load16s(t + 8);
            const crOffset = load16s(t + 10);
            if (
                cbWeight !== 1 << logC ||
                cbOffset !== 0 ||
                crWeight !== 1 << logC ||
                crOffset !== 0
            ) {
                predict_chroma(scratch, sb, entry, cx, cy, cw, ch, mv, predA, predA + 8, 16);
                weight1(predA, 16, cbDst, cStride, cw, ch, cbWeight, cbOffset, logC);
                weight1(predA + 8, 16, crDst, cStride, cw, ch, crWeight, crOffset, logC);
                return;
            }
        } else predict_luma(scratch, sb, entry, x, y, w, h, mv, lumaDst, stride);
        if (chroma) predict_chroma(scratch, sb, entry, cx, cy, cw, ch, mv, cbDst, crDst, cStride);
        return;
    }
    const mv0 = load32(scratch + SCRATCH_MV_CACHE + pos * 4);
    const mv1 = load32(scratch + SCRATCH_MV_CACHE + MV_CACHE_BYTES + pos * 4);
    const bi = sb + M_BI;
    if (weightMode === 1) {
        const t0 = sb + WEIGHTS + ref0 * 12;
        const t1 = sb + WEIGHTS + WEIGHT_LIST_BYTES + ref1 * 12;
        for (let c = 0; c < 3; c++) {
            store32(bi + c * 16, load16s(t0 + c * 4));
            store32(bi + c * 16 + 4, load16s(t1 + c * 4));
            store32(bi + c * 16 + 8, (load16s(t0 + c * 4 + 2) + load16s(t1 + c * 4 + 2) + 1) >> 1);
            store32(bi + c * 16 + 12, c ? load32(sb + S_CHROMA_LOG2) : load32(sb + S_LUMA_LOG2));
        }
    } else {
        let w1 = 32;
        if (weightMode === 2) w1 = load8s(sb + IMPLICIT + ref0 * 32 + ref1);
        for (let c = 0; c < 3; c++) {
            store32(bi + c * 16, 64 - w1);
            store32(bi + c * 16 + 4, w1);
            store32(bi + c * 16 + 8, 0);
            store32(bi + c * 16 + 12, 5);
        }
    }
    const mbX = load32(sb + M_X);
    const mbRow = inline_mb_row(sb);
    const mvx0 = (mv0 << 16) >> 16;
    const mvy0 = mv0 >> 16;
    const mvx1 = (mv1 << 16) >> 16;
    const mvy1 = mv1 >> 16;
    let done = 0;
    if (((mvx0 | mvy0 | mvx1 | mvy1) & 3) === 0) {
        const lx = mbX * 16 + x;
        const ly = mbRow + y;
        done = blend_full(
            load32(entry0 + E_LUMA),
            lx + (mvx0 >> 2),
            ly + (mvy0 >> 2),
            load32(entry0 + E_STRIDE),
            load32(entry0 + E_WIDTH),
            load32(entry0 + E_HEIGHT),
            load32(entry1 + E_LUMA),
            lx + (mvx1 >> 2),
            ly + (mvy1 >> 2),
            load32(entry1 + E_STRIDE),
            load32(entry1 + E_WIDTH),
            load32(entry1 + E_HEIGHT),
            w,
            h,
            lumaDst,
            stride,
            bi,
        );
    }
    if (!done) {
        predict_luma(scratch, sb, entry0, x, y, w, h, mv0, predA, 16);
        predict_luma(scratch, sb, entry1, x, y, w, h, mv1, predB, 16);
        combine(scratch, 0, lumaDst, stride, w, h, bi);
    }
    if (!chroma) return;
    chroma_position(sb, entry1, cx, cy, mv1);
    let full = !(load32(sb + M_CHROMA_FX) | load32(sb + M_CHROMA_FY));
    const x1 = load32(sb + M_CHROMA_X);
    const y1 = load32(sb + M_CHROMA_Y);
    if (full) {
        chroma_position(sb, entry0, cx, cy, mv0);
        full = !(load32(sb + M_CHROMA_FX) | load32(sb + M_CHROMA_FY));
    }
    if (full) {
        const x0 = load32(sb + M_CHROMA_X);
        const y0 = load32(sb + M_CHROMA_Y);
        const a = load32(entry0 + E_CB);
        const b = load32(entry1 + E_CB);
        const aStride = load32(entry0 + E_CSTRIDE);
        const bStride = load32(entry1 + E_CSTRIDE);
        const aWidth = load32(entry0 + E_CWIDTH);
        const bWidth = load32(entry1 + E_CWIDTH);
        const aHeight = load32(entry0 + E_CHEIGHT);
        const bHeight = load32(entry1 + E_CHEIGHT);
        if (
            blend_full(
                a,
                x0,
                y0,
                aStride,
                aWidth,
                aHeight,
                b,
                x1,
                y1,
                bStride,
                bWidth,
                bHeight,
                cw,
                ch,
                cbDst,
                cStride,
                bi + 16,
            )
        ) {
            // Cr lies the same distance past Cb in both references of one picture array
            // (MotionCompensator).
            const shift = load32(entry0 + E_CR_SHIFT);
            blend_full(
                a + shift,
                x0,
                y0,
                aStride,
                aWidth,
                aHeight,
                b + shift,
                x1,
                y1,
                bStride,
                bWidth,
                bHeight,
                cw,
                ch,
                crDst,
                cStride,
                bi + 32,
            );
            return;
        }
    }
    predict_chroma(scratch, sb, entry0, cx, cy, cw, ch, mv0, predA, predA + 8, 16);
    predict_chroma(scratch, sb, entry1, cx, cy, cw, ch, mv1, predB, predB + 8, 16);
    combine(scratch, 0, cbDst, cStride, cw, ch, bi + 16);
    combine(scratch, 8, crDst, cStride, cw, ch, bi + 32);
}

/**
 * Whether every 4x4 block of the size x size area at (x4, y4) has the same references and vectors.
 */
function uniform_motion(scratch, x4, y4, size) {
    const ref0 = scratch + SCRATCH_REF_CACHE;
    const ref1 = ref0 + REF_CACHE_BYTES;
    const mv0 = scratch + SCRATCH_MV_CACHE;
    const mv1 = mv0 + MV_CACHE_BYTES;
    const first = inline_at(x4, y4);
    const r0 = load8s(ref0 + first);
    const r1 = load8s(ref1 + first);
    const a = load32(mv0 + first * 4);
    const b = load32(mv1 + first * 4);
    for (let y = y4; y < y4 + size; y++) {
        const p = inline_at(x4, y);
        for (let x = 0; x < size; x++) {
            if (load32(mv0 + (p + x) * 4) !== a || load32(mv1 + (p + x) * 4) !== b) return 0;
            if (load8s(ref0 + p + x) !== r0 || load8s(ref1 + p + x) !== r1) return 0;
        }
    }
    return 1;
}

function predict_direct(scratch, sb, mask) {
    const uniform = mask === 15 && uniform_motion(scratch, 0, 0, 4);
    store32(sb + M_DIRECT_UNIFORM, uniform);
    if (uniform) {
        predict_partition(scratch, sb, 0, 0, 16, 16);
        return;
    }
    const inference = load32(sb + S_DIRECT_8X8);
    for (let i8 = 0; i8 < 4; i8++) {
        if (!((mask >> i8) & 1)) continue;
        const x = (i8 & 1) * 8;
        const y = (i8 >> 1) * 8;
        if (inference || uniform_motion(scratch, x >> 2, y >> 2, 2))
            predict_partition(scratch, sb, x, y, 8, 8);
        else {
            predict_partition(scratch, sb, x, y, 4, 4);
            predict_partition(scratch, sb, x + 4, y, 4, 4);
            predict_partition(scratch, sb, x, y + 4, 4, 4);
            predict_partition(scratch, sb, x + 4, y + 4, 4, 4);
        }
    }
}

/** motionCompensate: predicts every partition of the macroblock from the motion in the caches. */
function motion_compensate(scratch, sb) {
    const typeFlags = load32(sb + M_TYPE_FLAGS);
    const shape = load32(sb + M_SHAPE);
    if (typeFlags & (MB_DIRECT16 | MB_SKIP)) {
        if (load32(sb + S_B)) predict_direct(scratch, sb, 15);
        else predict_partition(scratch, sb, 0, 0, 16, 16);
        return;
    }
    if (shape === SHAPE_16X16) predict_partition(scratch, sb, 0, 0, 16, 16);
    else if (shape === SHAPE_16X8) {
        predict_partition(scratch, sb, 0, 0, 16, 8);
        predict_partition(scratch, sb, 0, 8, 16, 8);
    } else if (shape === SHAPE_8X16) {
        predict_partition(scratch, sb, 0, 0, 8, 16);
        predict_partition(scratch, sb, 8, 0, 8, 16);
    } else {
        const direct = load32(sb + M_DIRECT);
        for (let i8 = 0; i8 < 4; i8++) {
            const x = (i8 & 1) * 8;
            const y = (i8 >> 1) * 8;
            if ((direct >> i8) & 1) {
                predict_direct(scratch, sb, 1 << i8);
                continue;
            }
            const sub = load8u(sb + M_SUB_SHAPE + i8);
            if (sub === SUB_8X8) predict_partition(scratch, sb, x, y, 8, 8);
            else if (sub === SUB_8X4) {
                predict_partition(scratch, sb, x, y, 8, 4);
                predict_partition(scratch, sb, x, y + 4, 8, 4);
            } else if (sub === SUB_4X8) {
                predict_partition(scratch, sb, x, y, 4, 8);
                predict_partition(scratch, sb, x + 4, y, 4, 8);
            } else {
                predict_partition(scratch, sb, x, y, 4, 4);
                predict_partition(scratch, sb, x + 4, y, 4, 4);
                predict_partition(scratch, sb, x, y + 4, 4, 4);
                predict_partition(scratch, sb, x + 4, y + 4, 4, 4);
            }
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Residual reconstruction of inter macroblocks

/** QPc of the macroblock QP for chroma plane `plane` (chromaQp). */
function chroma_qp_of(sb, qp, plane) {
    const qpi = qp + load32(sb + (plane ? S_CR_QP_OFFSET : S_CB_QP_OFFSET));
    return load8u(CHROMA_QP + (qpi < 0 ? 0 : qpi > 51 ? 51 : qpi));
}

/**
 * addBlock4x4 / addBlock8x8 of the coefficients at `coeffs` with `count` coded to the samples at
 * `dst`.
 */
function add_block(coeffs, count, dst, stride, size) {
    const dc = load32(coeffs);
    if (count === 1 && dc !== 0) {
        store32(coeffs, 0);
        dc_add(dc, dst, stride, size);
    } else if (size === 4) idct4_add(coeffs, dst, stride);
    else idct8_add(coeffs, dst, stride);
}

/** addInterResidual: luma blocks, then the chroma DC transform and blocks (4:2:0). */
function add_inter_residual(scratch, sb, cbp, t8x8, qp) {
    const nnzCache = scratch + SCRATCH_NNZ;
    const coeffs = scratch + SCRATCH_COEFFS;
    const stride = load32(sb + M_STRIDE);
    const luma = load32(sb + S_LUMA) + load32(sb + M_LUMA);
    if (cbp & 15) {
        if (t8x8) {
            for (let i8 = 0; i8 < 4; i8++) {
                const count = load8u(nnzCache + inline_at((i8 & 1) * 2, (i8 >> 1) * 2));
                if (!count) continue;
                add_block(
                    coeffs + i8 * 256,
                    count,
                    luma + (i8 >> 1) * 8 * stride + (i8 & 1) * 8,
                    stride,
                    8,
                );
            }
        } else {
            for (let blk = 0; blk < 16; blk++) {
                const count = load8u(nnzCache + load8u(BLOCK_CACHE + blk));
                if (!count) continue;
                const raster = load8u(BLOCK_RASTER + blk);
                const o = luma + (raster >> 2) * 4 * stride + (raster & 3) * 4;
                add_block(coeffs + raster * 64, count, o, stride, 4);
            }
        }
    }
    if (!load32(sb + S_CHROMA) || !(cbp & 48)) return;
    const dcs = scratch + SCRATCH_DC;
    const cStride = load32(sb + M_CSTRIDE);
    for (let plane = 0; plane < 2; plane++) {
        const qpc = chroma_qp_of(sb, qp, plane);
        const scale = load32(sb + LEVEL_DC + ((4 + plane) * 6 + (qpc % 6)) * 4);
        const dc = dcs + (16 + plane * 8) * 4;
        const c0 = load32(dc);
        const c1 = load32(dc + 4);
        const c2 = load32(dc + 8);
        const c3 = load32(dc + 12);
        const shift = (qpc / 6) | 0;
        store32(dc, (((c0 + c1 + c2 + c3) * scale) << shift) >> 5);
        store32(dc + 4, (((c0 - c1 + c2 - c3) * scale) << shift) >> 5);
        store32(dc + 8, (((c0 + c1 - c2 - c3) * scale) << shift) >> 5);
        store32(dc + 12, (((c0 - c1 - c2 + c3) * scale) << shift) >> 5);
        const base = load32(sb + (plane ? S_CR : S_CB)) + load32(sb + M_CHROMA);
        const cacheBase = nnzCache + (plane ? 88 : 48);
        for (let b = 0; b < 4; b++) {
            const bx = b & 1;
            const by = b >> 1;
            const o = base + by * 4 * cStride + bx * 4;
            const dcValue = load32(dc + b * 4);
            if (load8u(cacheBase + by * 8 + 4 + bx)) {
                const block = coeffs + (256 + (plane * 8 + b) * 16) * 4;
                store32(block, dcValue);
                idct4_add(block, o, cStride);
            } else if (dcValue) dc_add(dcValue, o, cStride, 4);
        }
        fill8(dc, 0, 32);
    }
}

// -------------------------------------------------------------------------------------------------
// Storing the macroblock

/** motionClassOf. */
function motion_class(sb) {
    const typeFlags = load32(sb + M_TYPE_FLAGS);
    if (typeFlags & (MB_SKIP | MB_DIRECT16)) {
        if (!load32(sb + S_B) || load32(sb + M_DIRECT_UNIFORM)) return MOTION_UNIFORM;
        return load32(sb + S_DIRECT_8X8) ? MOTION_8X8 : MOTION_4X4;
    }
    const shape = load32(sb + M_SHAPE);
    if (shape === SHAPE_16X16) return MOTION_UNIFORM;
    if (shape === SHAPE_16X8) return MOTION_16X8;
    if (shape === SHAPE_8X16) return MOTION_8X16;
    const direct = load32(sb + M_DIRECT);
    const inference = load32(sb + S_DIRECT_8X8);
    for (let i = 0; i < 4; i++) {
        if ((direct >> i) & 1 ? !inference : load8u(sb + M_SUB_SHAPE + i) !== SUB_8X8)
            return MOTION_4X4;
    }
    return MOTION_8X8;
}

/** storeMacroblock of an inter macroblock. */
function store_mb(scratch, sb, skipped) {
    const xy = load32(sb + M_XY);
    const t8x8 = load32(sb + M_T8X8);
    const typeFlags = load32(sb + M_TYPE_FLAGS);
    const flags =
        typeFlags | (t8x8 ? MB_T8X8 : 0) | (load32(sb + S_FIELD) ? MB_FIELD : 0) | MB_DECODED;
    store8(load32(sb + S_FLAGS) + xy, flags);
    store8(load32(sb + S_QP) + xy, load32(sb + S_QP_Y));
    store8(load32(sb + S_CBP) + xy, load32(sb + M_CBP));
    store8(load32(sb + S_CHROMA_MODE) + xy, 0);
    const nnzCache = scratch + SCRATCH_NNZ;
    const nnz = load32(sb + S_NNZ) + xy * 32;
    let mask = 0;
    if (skipped) {
        fill8(nnz, 0, 32);
        store8(load32(sb + S_DC) + xy, 0);
    } else {
        for (let row = 0; row < 4; row++) {
            store32(nnz + row * 4, load32(nnzCache + 12 + row * 8));
            store16(nnz + 16 + row * 2, load16u(nnzCache + 52 + row * 8));
            store16(nnz + 24 + row * 2, load16u(nnzCache + 92 + row * 8));
        }
        for (let i = 0; i < 16; i++)
            if (load8u(nnzCache + inline_at(i & 3, i >> 2))) mask |= 1 << i;
        if (t8x8) {
            for (let i8 = 0; i8 < 4; i8++) {
                const bits = 0x33 << ((i8 >> 1) * 8 + (i8 & 1) * 2);
                if (mask & bits) mask |= bits;
            }
        }
    }
    store16(load32(sb + S_NZ) + xy * 2, mask);
    const bSlice = load32(sb + S_B);
    for (let list = 0; list < 2; list++) {
        const refs = load32(sb + (list ? S_REF1 : S_REF0)) + xy * 4;
        const refIds = load32(sb + (list ? S_REFID1 : S_REFID0)) + xy * 16;
        const mvs = load32(sb + (list ? S_MV1 : S_MV0)) + xy * 64;
        const mvd = load32(sb + (list ? S_MVD1 : S_MVD0)) + xy * 16;
        if (list > bSlice) {
            store32(refs, -1);
            for (let i = 0; i < 4; i++) store32(refIds + i * 4, -1);
            fill8(mvs, 0, 64);
            fill8(mvd, 0, 16);
            continue;
        }
        const refCache = scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES;
        const count = load32(sb + (list ? S_COUNT1 : S_COUNT0));
        for (let i8 = 0; i8 < 4; i8++) {
            const ref = load8s(refCache + inline_at((i8 & 1) * 2, (i8 >> 1) * 2));
            if (ref >= 0) {
                store8(refs + i8, ref);
                store32(
                    refIds + i8 * 4,
                    ref < count ? load32(inline_entry(sb, list, ref) + E_ID) : -1,
                );
            } else {
                store8(refs + i8, -1);
                store32(refIds + i8 * 4, -1);
            }
        }
        const mvCache = scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES;
        for (let row = 0; row < 4; row++)
            copy8(mvs + row * 16, mvCache + inline_at(0, row) * 4, 16);
        if (skipped) fill8(mvd, 0, 16);
        else {
            const mvdCache = scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES;
            copy8(mvd, mvdCache + inline_at(0, 3) * 2, 8);
            store16(mvd + 8, load16u(mvdCache + inline_at(3, 0) * 2));
            store16(mvd + 10, load16u(mvdCache + inline_at(3, 1) * 2));
            store16(mvd + 12, load16u(mvdCache + inline_at(3, 2) * 2));
        }
    }
    const directMask = load32(sb + S_DIRECT) + xy;
    if (skipped) store8(directMask, bSlice ? 15 : 0);
    else store8(directMask, load32(sb + M_DIRECT));
    store8(load32(sb + S_MOTION) + xy, motion_class(sb));
}

// -------------------------------------------------------------------------------------------------
// The macroblock

/**
 * Decodes macroblock (x, y) of a CABAC P or B slice without MBAFF: returns MB_DONE, MB_SKIPPED,
 * MB_INTRA_P or MB_INTRA_B once the mb_type prefix of an intra macroblock is read (the caller
 * decodes the rest), or an ERROR_*.
 */
function inter_mb(scratch, x, y) {
    const sb = scratch + SCRATCH_SLICE;
    locate(sb, x, y);
    const bSlice = load32(sb + S_B);
    const flags = load32(sb + S_FLAGS);
    const left = load32(sb + M_LEFT);
    const top = load32(sb + M_TOP);
    const leftAvail = load32(sb + M_LEFT_AVAIL);
    const topAvail = load32(sb + M_TOP_AVAIL);
    let ctx = bSlice ? 24 : 11;
    if (leftAvail && !(load8u(flags + left) & MB_SKIP)) ctx++;
    if (topAvail && !(load8u(flags + top) & MB_SKIP)) ctx++;
    if (cabac_bin(scratch, ctx)) {
        store32(sb + M_CBP, 0);
        store32(sb + M_T8X8, 0);
        store32(sb + S_LAST_QP_DELTA, 0);
        store32(sb + M_SHAPE, SHAPE_16X16);
        store32(sb + M_DIRECT, 0);
        store32(sb + M_DIRECT_UNIFORM, 0);
        if (bSlice) {
            store32(sb + M_TYPE_FLAGS, MB_SKIP | MB_DIRECT16);
            store32(sb + M_DIRECT, 15);
            if (load32(sb + S_DIRECT_SPATIAL)) {
                prediction_neighbours(scratch, sb, 0);
                prediction_neighbours(scratch, sb, 1);
            }
            derive_direct(scratch, sb, 15);
        } else {
            store32(sb + M_TYPE_FLAGS, MB_SKIP);
            prediction_neighbours(scratch, sb, 0);
            skip_motion(scratch);
        }
        motion_compensate(scratch, sb);
        store_mb(scratch, sb, 1);
        return MB_SKIPPED;
    }
    store32(sb + M_DIRECT_UNIFORM, 0);
    if (bSlice) {
        let typeCtx = 0;
        if (leftAvail && !(load8u(flags + left) & (MB_SKIP | MB_DIRECT16))) typeCtx++;
        if (topAvail && !(load8u(flags + top) & (MB_SKIP | MB_DIRECT16))) typeCtx++;
        const type = b_mb_type(scratch, typeCtx);
        if (type >= 23) return MB_INTRA_B;
        if (type === 0) {
            store32(sb + M_TYPE_FLAGS, MB_DIRECT16);
            store32(sb + M_SHAPE, SHAPE_16X16);
        } else {
            store32(sb + M_TYPE_FLAGS, 0);
            if (type === 22) store32(sb + M_SHAPE, SHAPE_8X8);
            else {
                store32(sb + M_SHAPE, load8u(B_PARTITION_SHAPE + type));
                store8(sb + M_PART_PRED, load8u(B_PARTITION_PRED + type * 2));
                store8(sb + M_PART_PRED + 1, load8u(B_PARTITION_PRED + type * 2 + 1));
            }
        }
    } else {
        if (cabac_bin(scratch, 14)) return MB_INTRA_P;
        let type = 0;
        if (cabac_bin(scratch, 15)) type = cabac_bin(scratch, 17) ? 1 : 2;
        else type = cabac_bin(scratch, 16) ? 3 : 0;
        store32(sb + M_TYPE_FLAGS, 0);
        store32(sb + M_SHAPE, type);
        store32(sb + M_PART_PRED, 0x01010101);
    }
    fill_caches(scratch, sb);
    const error = inter_prediction(scratch, sb);
    if (error) return error;
    const cbp = decode_cbp(scratch, sb);
    store32(sb + M_CBP, cbp);
    let t8x8 = 0;
    if (cbp & 15 && load32(sb + S_T8X8_MODE) && no_sub_smaller_than_8x8(sb)) {
        let t8Ctx = 0;
        if (leftAvail && load8u(flags + left) & MB_T8X8) t8Ctx++;
        if (topAvail && load8u(flags + top) & MB_T8X8) t8Ctx++;
        t8x8 = cabac_bin(scratch, 399 + t8Ctx);
    }
    store32(sb + M_T8X8, t8x8);
    let qp = load32(sb + S_QP_Y);
    if (cbp & 63) {
        const delta = qp_delta(scratch, load32(sb + S_LAST_QP_DELTA));
        if (delta === 1000) return ERROR_QP_DELTA;
        store32(sb + S_LAST_QP_DELTA, delta);
        qp = (((qp + delta + 52) % 52) + 52) % 52;
        store32(sb + S_QP_Y, qp);
        clear_nnz(scratch, sb);
        let dcContexts = 0;
        if (load32(sb + S_CHROMA) && cbp & 48)
            dcContexts = (dc_context(sb, 2) << 4) | (dc_context(sb, 4) << 8);
        const chroma = load32(sb + S_CHROMA);
        const dcFlags = residual_mb(
            scratch,
            cbp,
            (t8x8 ? 4 : 0) | (load32(sb + S_FIELD) ? 8 : 0),
            qp,
            chroma ? chroma_qp_of(sb, qp, 0) : 0,
            chroma ? chroma_qp_of(sb, qp, 1) : 0,
            dcContexts,
            chroma ? 4 : 0,
        );
        store8(load32(sb + S_DC) + load32(sb + M_XY), dcFlags);
    } else {
        store32(sb + S_LAST_QP_DELTA, 0);
        clear_nnz(scratch, sb);
    }
    motion_compensate(scratch, sb);
    add_inter_residual(scratch, sb, cbp, t8x8, qp);
    store_mb(scratch, sb, 0);
    return MB_DONE;
}

/** noSubMbSmallerThan8x8. */
function no_sub_smaller_than_8x8(sb) {
    if (load32(sb + M_TYPE_FLAGS) & MB_DIRECT16) return load32(sb + S_DIRECT_8X8);
    if (load32(sb + M_SHAPE) !== SHAPE_8X8) return 1;
    const bSlice = load32(sb + S_B);
    for (let i = 0; i < 4; i++) {
        if (bSlice && load8u(sb + M_SUB_PRED + i) === 0) {
            if (!load32(sb + S_DIRECT_8X8)) return 0;
        } else if (load8u(sb + M_SUB_SHAPE + i) !== SUB_8X8) return 0;
    }
    return 1;
}

/** dcCbfContext(bit, false) of an inter macroblock. */
function dc_context(sb, bit) {
    const flags = load32(sb + S_FLAGS);
    const dcFlags = load32(sb + S_DC);
    let ctx = 0;
    if (load32(sb + M_LEFT_AVAIL)) {
        const left = load32(sb + M_LEFT);
        if (load8u(flags + left) & MB_PCM || load8u(dcFlags + left) & bit) ctx++;
    }
    if (load32(sb + M_TOP_AVAIL)) {
        const top = load32(sb + M_TOP);
        if (load8u(flags + top) & MB_PCM || load8u(dcFlags + top) & bit) ctx += 2;
    }
    return ctx;
}
