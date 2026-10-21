// Scalar kernels of the built-in H.264 decoder in the JavaScript subset of scripts/wasm-scalar.mjs,
// compiled into the kernel module by scripts/h264-kernels.mjs (this file is read as text, never
// run). Upper-case names are the constants and table addresses that script defines; load*, store*,
// min and max are the subset's intrinsics, deblock_* the SIMD edge kernels. Each kernel gives the
// samples of the JavaScript code it stands for (src/codecs/h264/deblock.ts).

/** Clip3(0, 51, v). */
function clip51(v) {
    return v < 0 ? 0 : v > 51 ? 51 : v;
}

/** QPc of a macroblock QP and a chroma QP offset (Table 8-15). */
function chroma_qp(qp, offset) {
    return load8u(CHROMA_QP + clip51(qp + offset));
}

/** tC0 of indexA for the four bS bytes of `bs`. */
function tc_pack(indexA, bs) {
    const t = TC0 + indexA * 4;
    return (
        load8u(t + (bs & 3)) |
        (load8u(t + ((bs >> 8) & 3)) << 8) |
        (load8u(t + ((bs >> 16) & 3)) << 16) |
        (load8u(t + ((bs >>> 24) & 3)) << 24)
    );
}

/**
 * One luma edge of 16 lines: vertical when `step` is 1 (lines `lineStep` apart), else horizontal
 * across `step`.
 */
function luma_edge(q, step, lineStep, indexA, indexB, bs) {
    const alpha = load8u(ALPHA + indexA);
    const beta = load8u(BETA + indexB);
    if (alpha === 0 || beta === 0) return;
    if (step === 1) deblock_luma_v(q, lineStep, alpha, beta, bs, tc_pack(indexA, bs));
    else deblock_luma_h(q, step, alpha, beta, bs, tc_pack(indexA, bs));
}

/** One chroma edge of 8 lines (4:2:0), two lines per bS byte. */
function chroma_edge(q, step, lineStep, indexA, indexB, bs) {
    const alpha = load8u(ALPHA + indexA);
    const beta = load8u(BETA + indexB);
    if (alpha === 0 || beta === 0) return;
    const tc = tc_pack(indexA, bs) + 0x01010101;
    if (step === 1) deblock_chroma_v(q, lineStep, alpha, beta, bs, tc);
    else deblock_chroma_h(q, step, alpha, beta, bs, tc);
}

/**
 * Whether two vectors (int16 x, y at addresses a and b) differ by four quarter samples, or `limit`
 * vertically.
 */
function mv_differs(a, b, limit) {
    const dx = load16s(a) - load16s(b);
    const dy = load16s(a + 2) - load16s(b + 2);
    return dx >= 4 || dx <= -4 || dy >= limit || dy <= -limit;
}

/** Motion-based bS between raster 4x4 blocks bp of macroblock p and bq of q (8.7.2.1). */
function motion_bs(p, bp, q, bq, limit, ref0, ref1, mv0, mv1) {
    const b8p = (p * 4 + (bp >> 3) * 2 + ((bp & 3) >> 1)) * 4;
    const b8q = (q * 4 + (bq >> 3) * 2 + ((bq & 3) >> 1)) * 4;
    const p0 = load32(ref0 + b8p);
    const p1 = load32(ref1 + b8p);
    const q0 = load32(ref0 + b8q);
    const q1 = load32(ref1 + b8q);
    const vp = (p * 16 + bp) * 4;
    const vq = (q * 16 + bq) * 4;
    if (
        p0 === q0 &&
        p1 === q1 &&
        load32(mv0 + vp) === load32(mv0 + vq) &&
        load32(mv1 + vp) === load32(mv1 + vq)
    )
        return 0;
    const countP = (p0 >= 0) + (p1 >= 0);
    const countQ = (q0 >= 0) + (q1 >= 0);
    if (countP !== countQ) return 1;
    if (countP === 0) return 0;
    if (countP === 1) {
        if ((p0 >= 0 ? p0 : p1) !== (q0 >= 0 ? q0 : q1)) return 1;
        return mv_differs((p0 >= 0 ? mv0 : mv1) + vp, (q0 >= 0 ? mv0 : mv1) + vq, limit);
    }
    const same = p0 === q0 && p1 === q1;
    if (!same && !(p0 === q1 && p1 === q0)) return 1;
    if (p0 !== p1) {
        if (same)
            return mv_differs(mv0 + vp, mv0 + vq, limit) || mv_differs(mv1 + vp, mv1 + vq, limit);
        return mv_differs(mv0 + vp, mv1 + vq, limit) || mv_differs(mv1 + vp, mv0 + vq, limit);
    }
    const direct = mv_differs(mv0 + vp, mv0 + vq, limit) || mv_differs(mv1 + vp, mv1 + vq, limit);
    const crossed = mv_differs(mv0 + vp, mv1 + vq, limit) || mv_differs(mv1 + vp, mv0 + vq, limit);
    return direct && crossed;
}

/**
 * The motion bS bytes of the edge segments i in `uncoded` (bit per segment) between block pb + i *
 * pStep of macroblock p and qb + i * qStep of q, added to `bs`; runs of `run` segments share
 * motion, so one comparison per run.
 */
function edge_motion_bs(p, pb, pStep, q, qb, qStep, run, uncoded, limit, bs, ref0, ref1, mv0, mv1) {
    let last = -1;
    let value = 0;
    for (let i = 0; i < 4; i++) {
        if (!((uncoded >> i) & 1)) continue;
        const first = i & -run;
        if (first !== last) {
            value = motion_bs(
                p,
                pb + first * pStep,
                q,
                qb + first * qStep,
                limit,
                ref0,
                ref1,
                mv0,
                mv1,
            );
            last = first;
        }
        bs |= value << (i * 8);
    }
    return bs;
}

/**
 * Filters the macroblocks of frame macroblock row `y` of a picture without MBAFF (8.7): a frame
 * picture, or with `field` the rows of one field; `chroma` is 1 for 4:2:0 and 0 for monochrome.
 * `pic` addresses the luma samples, `cb` and `cr` the chroma planes, the other addresses the
 * per-macroblock arrays of the picture.
 */
function deblock_row(
    pic,
    cb,
    cr,
    lumaStride,
    chromaStride,
    mbWidth,
    y,
    field,
    chroma,
    flagsA,
    sliceA,
    filterA,
    nzA,
    qpA,
    motionA,
    ref0,
    ref1,
    mv0,
    mv1,
) {
    const lumaMbStride = field ? lumaStride * 2 : lumaStride;
    const chromaMbStride = field ? chromaStride * 2 : chromaStride;
    const lumaRow = field ? ((y >> 1) * 32 + (y & 1)) * lumaStride : y * 16 * lumaStride;
    const chromaRow = field ? ((y >> 1) * 16 + (y & 1)) * chromaStride : y * 8 * chromaStride;
    const topStep = field ? 2 * mbWidth : mbWidth;
    const hasTop = field ? y >= 2 : y >= 1;
    for (let x = 0; x < mbWidth; x++) {
        const xy = y * mbWidth + x;
        const slice = load32(sliceA + xy * 4);
        if (slice < 0) continue;
        const params = load32(filterA + xy * 4);
        const disable = params & 3;
        if (disable === 1) continue;
        const alphaOffset = ((params >> 2) & 31) - 16;
        const betaOffset = ((params >> 7) & 31) - 16;
        const cbOffset = ((params >> 12) & 31) - 16;
        const crOffset = ((params >> 17) & 31) - 16;
        const flags = load8u(flagsA + xy);
        const fieldMb = flags & MB_FIELD;
        const intra = flags & MB_INTRA;
        const t8x8 = flags & MB_T8X8;
        const limit = fieldMb ? 2 : 4;
        const mbQp = load8u(qpA + xy);
        const luma = pic + lumaRow + x * 16;
        const cbMb = cb + chromaRow + x * 8;
        const crMb = cr + chromaRow + x * 8;
        const cbQp = chroma ? chroma_qp(mbQp, cbOffset) : 0;
        const crQp = chroma ? chroma_qp(mbQp, crOffset) : 0;
        const coded = load16u(nzA + xy * 2);
        const motion = intra ? MOTION_UNIFORM : load8u(motionA + xy);
        const active = intra || coded !== 0 || motion !== 0;
        const innerEdges = load8u(ALPHA + clip51(mbQp + alphaOffset)) !== 0 && active;
        const innerChroma =
            chroma &&
            (load8u(ALPHA + clip51(cbQp + alphaOffset)) !== 0 ||
                load8u(ALPHA + clip51(crQp + alphaOffset)) !== 0) &&
            active;

        // Vertical edges.
        if (x > 0) {
            const left = xy - 1;
            const leftSlice = load32(sliceA + left * 4);
            if (leftSlice >= 0 && !(disable === 2 && leftSlice !== slice)) {
                let bs = 0;
                if (intra || load8u(flagsA + left) & MB_INTRA) bs = 0x04040404;
                else {
                    const leftCoded = load16u(nzA + left * 2);
                    let uncoded = 0;
                    for (let i = 0; i < 4; i++) {
                        if (((coded >> (i * 4)) | (leftCoded >> (i * 4 + 3))) & 1)
                            bs |= 2 << (i * 8);
                        else uncoded |= 1 << i;
                    }
                    if (uncoded) {
                        const run = min(
                            load8u(RUN_VERTICAL + motion),
                            load8u(RUN_VERTICAL + load8u(motionA + left)),
                        );
                        bs = edge_motion_bs(
                            left,
                            3,
                            4,
                            xy,
                            0,
                            4,
                            run,
                            uncoded,
                            limit,
                            bs,
                            ref0,
                            ref1,
                            mv0,
                            mv1,
                        );
                    }
                }
                if (bs) {
                    const leftQp = load8u(qpA + left);
                    const avg = (mbQp + leftQp + 1) >> 1;
                    luma_edge(
                        luma,
                        1,
                        lumaMbStride,
                        clip51(avg + alphaOffset),
                        clip51(avg + betaOffset),
                        bs,
                    );
                    if (chroma) {
                        const cbAvg = (cbQp + chroma_qp(leftQp, cbOffset) + 1) >> 1;
                        const crAvg = (crQp + chroma_qp(leftQp, crOffset) + 1) >> 1;
                        chroma_edge(
                            cbMb,
                            1,
                            chromaMbStride,
                            clip51(cbAvg + alphaOffset),
                            clip51(cbAvg + betaOffset),
                            bs,
                        );
                        chroma_edge(
                            crMb,
                            1,
                            chromaMbStride,
                            clip51(crAvg + alphaOffset),
                            clip51(crAvg + betaOffset),
                            bs,
                        );
                    }
                }
            }
        }
        for (let edge = 1; edge < 4; edge++) {
            if (t8x8 && edge & 1) continue;
            if (!innerEdges && !(innerChroma && edge === 2)) continue;
            let bs = 0;
            if (intra) bs = 0x03030303;
            else {
                const motionEdge =
                    motion === MOTION_4X4 ||
                    (edge === 2 && (motion === MOTION_8X16 || motion === MOTION_8X8));
                let uncoded = 0;
                for (let i = 0; i < 4; i++) {
                    if (((coded >> (i * 4 + edge)) | (coded >> (i * 4 + edge - 1))) & 1)
                        bs |= 2 << (i * 8);
                    else uncoded |= 1 << i;
                }
                if (motionEdge && uncoded) {
                    const run = load8u(RUN_VERTICAL + motion);
                    bs = edge_motion_bs(
                        xy,
                        edge - 1,
                        4,
                        xy,
                        edge,
                        4,
                        run,
                        uncoded,
                        limit,
                        bs,
                        ref0,
                        ref1,
                        mv0,
                        mv1,
                    );
                }
            }
            if (!bs) continue;
            luma_edge(
                luma + edge * 4,
                1,
                lumaMbStride,
                clip51(mbQp + alphaOffset),
                clip51(mbQp + betaOffset),
                bs,
            );
            if (chroma && edge === 2) {
                chroma_edge(
                    cbMb + 4,
                    1,
                    chromaMbStride,
                    clip51(cbQp + alphaOffset),
                    clip51(cbQp + betaOffset),
                    bs,
                );
                chroma_edge(
                    crMb + 4,
                    1,
                    chromaMbStride,
                    clip51(crQp + alphaOffset),
                    clip51(crQp + betaOffset),
                    bs,
                );
            }
        }

        // Horizontal edges.
        if (hasTop) {
            const top = xy - topStep;
            const topSlice = load32(sliceA + top * 4);
            if (topSlice >= 0 && !(disable === 2 && topSlice !== slice)) {
                const topFlags = load8u(flagsA + top);
                let bs = 0;
                if (intra || topFlags & MB_INTRA)
                    bs = fieldMb || topFlags & MB_FIELD ? 0x03030303 : 0x04040404;
                else {
                    const topCoded = load16u(nzA + top * 2);
                    let uncoded = 0;
                    for (let i = 0; i < 4; i++) {
                        if (((coded >> i) | (topCoded >> (12 + i))) & 1) bs |= 2 << (i * 8);
                        else uncoded |= 1 << i;
                    }
                    if (uncoded) {
                        const run = min(
                            load8u(RUN_HORIZONTAL + motion),
                            load8u(RUN_HORIZONTAL + load8u(motionA + top)),
                        );
                        bs = edge_motion_bs(
                            top,
                            12,
                            1,
                            xy,
                            0,
                            1,
                            run,
                            uncoded,
                            limit,
                            bs,
                            ref0,
                            ref1,
                            mv0,
                            mv1,
                        );
                    }
                }
                if (bs) {
                    const topQp = load8u(qpA + top);
                    const avg = (mbQp + topQp + 1) >> 1;
                    luma_edge(
                        luma,
                        lumaMbStride,
                        1,
                        clip51(avg + alphaOffset),
                        clip51(avg + betaOffset),
                        bs,
                    );
                    if (chroma) {
                        const cbAvg = (cbQp + chroma_qp(topQp, cbOffset) + 1) >> 1;
                        const crAvg = (crQp + chroma_qp(topQp, crOffset) + 1) >> 1;
                        chroma_edge(
                            cbMb,
                            chromaMbStride,
                            1,
                            clip51(cbAvg + alphaOffset),
                            clip51(cbAvg + betaOffset),
                            bs,
                        );
                        chroma_edge(
                            crMb,
                            chromaMbStride,
                            1,
                            clip51(crAvg + alphaOffset),
                            clip51(crAvg + betaOffset),
                            bs,
                        );
                    }
                }
            }
        }
        for (let edge = 1; edge < 4; edge++) {
            if (t8x8 && edge & 1) continue;
            if (!innerEdges && !(innerChroma && edge === 2)) continue;
            let bs = 0;
            if (intra) bs = 0x03030303;
            else {
                const motionEdge =
                    motion === MOTION_4X4 ||
                    (edge === 2 && (motion === MOTION_16X8 || motion === MOTION_8X8));
                let uncoded = 0;
                for (let i = 0; i < 4; i++) {
                    if (((coded >> (edge * 4 + i)) | (coded >> ((edge - 1) * 4 + i))) & 1)
                        bs |= 2 << (i * 8);
                    else uncoded |= 1 << i;
                }
                if (motionEdge && uncoded) {
                    const run = load8u(RUN_HORIZONTAL + motion);
                    bs = edge_motion_bs(
                        xy,
                        (edge - 1) * 4,
                        1,
                        xy,
                        edge * 4,
                        1,
                        run,
                        uncoded,
                        limit,
                        bs,
                        ref0,
                        ref1,
                        mv0,
                        mv1,
                    );
                }
            }
            if (!bs) continue;
            const q = luma + edge * 4 * lumaMbStride;
            luma_edge(
                q,
                lumaMbStride,
                1,
                clip51(mbQp + alphaOffset),
                clip51(mbQp + betaOffset),
                bs,
            );
            if (chroma && edge === 2) {
                const c = 4 * chromaMbStride;
                chroma_edge(
                    cbMb + c,
                    chromaMbStride,
                    1,
                    clip51(cbQp + alphaOffset),
                    clip51(cbQp + betaOffset),
                    bs,
                );
                chroma_edge(
                    crMb + c,
                    chromaMbStride,
                    1,
                    clip51(crQp + alphaOffset),
                    clip51(crQp + betaOffset),
                    bs,
                );
            }
        }
    }
}
