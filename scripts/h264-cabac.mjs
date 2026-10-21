// CABAC residual decoding of the built-in H.264 decoder (9.3; Cabac.residual in
// src/codecs/h264/cabac.ts and readResidualCabac in slice-decoder.ts) in the JavaScript subset of
// scripts/wasm-scalar.mjs, compiled into the kernel module by scripts/h264-kernels.mjs (read as
// text, never run). Upper-case names are constants and table addresses of that script. The engine
// state lives in the thread's scratch block at SCRATCH_CABAC as range, value, pos, bitsNeeded and
// end (i32), the context variables at SCRATCH_CONTEXTS and the RBSP at SCRATCH_BITS, bytes at or
// past `end` reading as zero. Decisions are decoded without a branch on the bin: the LPS case is
// selected by a mask.

/**
 * One decision bin with the context variable at address `at` (9.3.3.2.1), updating the caller's
 * range, value, pos and bitsNeeded (the engine of Cabac.decodeBin) and reading `bits` below `end`.
 */
function inline_decide(at) {
    const s = load8u(at);
    const lps = load8u(LPS_RANGE + (s << 2) + ((range >> 6) & 3));
    range -= lps;
    const lpsMask = ((range << 7) - value - 1) >> 31;
    value -= (range << 7) & lpsMask;
    range += (lps - range) & lpsMask;
    store8(at, load8u(NEXT_STATE + (s | (lpsMask & 128))));
    const shift = clz32(range) - 23;
    range <<= shift;
    value <<= shift;
    bitsNeeded += shift;
    if (bitsNeeded >= 0) {
        value |= (pos < end ? load8u(bits + pos) : 0) << bitsNeeded;
        pos++;
        bitsNeeded -= 8;
    }
    return (s & 1) ^ (lpsMask & 1);
}

/** One bypass bin (9.3.3.2.3) of the caller's engine. */
function inline_bypass() {
    value <<= 1;
    bitsNeeded++;
    if (bitsNeeded >= 0) {
        bitsNeeded = -8;
        value |= pos < end ? load8u(bits + pos) : 0;
        pos++;
    }
    const oneMask = ((range << 7) - value - 1) >> 31;
    value -= (range << 7) & oneMask;
    return oneMask & 1;
}

/** One decision bin of context `ctx` of the engine in the scratch block. */
function cabac_bin(scratch, ctx) {
    const engine = scratch + SCRATCH_CABAC;
    const bits = scratch + SCRATCH_BITS;
    let range = load32(engine);
    let value = load32(engine + 4);
    let pos = load32(engine + 8);
    let bitsNeeded = load32(engine + 12);
    const end = load32(engine + 16);
    const bin = inline_decide(scratch + SCRATCH_CONTEXTS + ctx);
    store32(engine, range);
    store32(engine + 4, value);
    store32(engine + 8, pos);
    store32(engine + 12, bitsNeeded);
    return bin;
}

/**
 * residual_block_cabac after its coded_block_flag: the significance map with contexts sigCtx +
 * sigMap[i] and lastCtx + lastMap[i], then the levels from absCtx with at most gt1Max for the
 * greater-than-one count; the level of coded position i lands at out + 4 * p, p = scan[i], as
 * (level * scale[p] + 32) >> 6 (32-bit words). Returns the coefficient count.
 */
function residual_block(
    scratch,
    sigCtx,
    lastCtx,
    sigMap,
    lastMap,
    numCoeff,
    absCtx,
    gt1Max,
    out,
    scan,
    scale,
) {
    const engine = scratch + SCRATCH_CABAC;
    const contexts = scratch + SCRATCH_CONTEXTS;
    const bits = scratch + SCRATCH_BITS;
    const index = scratch + SCRATCH_INDEX;
    let range = load32(engine);
    let value = load32(engine + 4);
    let pos = load32(engine + 8);
    let bitsNeeded = load32(engine + 12);
    const end = load32(engine + 16);
    const last = numCoeff - 1;
    let count = 0;
    let i = 0;
    for (; i < last; i++) {
        if (!inline_decide(contexts + sigCtx + load8u(sigMap + i))) continue;
        store8(index + count, i);
        count++;
        if (inline_decide(contexts + lastCtx + load8u(lastMap + i))) break;
    }
    if (i === last) {
        store8(index + count, last);
        count++;
    }
    let eq1 = 1;
    let gt1 = 0;
    for (let k = count - 1; k >= 0; k--) {
        let level = 1;
        if (!inline_decide(contexts + absCtx + (gt1 !== 0 ? 0 : eq1 < 4 ? eq1 : 4))) eq1++;
        else {
            const ctx = contexts + absCtx + 5 + (gt1 < gt1Max ? gt1 : gt1Max);
            level = 2;
            while (level < 15) {
                if (!inline_decide(ctx)) break;
                level++;
            }
            if (level >= 15) {
                // The UEG0 suffix in bypass bins (Cabac.decodeExpGolombBypass(0)).
                let k = 0;
                let suffix = 0;
                let overflow = 0;
                while (inline_bypass()) {
                    suffix += 1 << k;
                    k++;
                    if (k > 24) {
                        overflow = 1;
                        break;
                    }
                }
                if (overflow) suffix = 0x7fffffff;
                else {
                    while (k > 0) {
                        k--;
                        suffix += inline_bypass() << k;
                    }
                }
                level += suffix;
            }
            gt1++;
        }
        if (inline_bypass()) level = -level;
        const p = load8u(scan + load8u(index + k));
        store32(out + p * 4, (level * load32(scale + p * 4) + 32) >> 6);
    }
    store32(engine, range);
    store32(engine + 4, value);
    store32(engine + 8, pos);
    store32(engine + 12, bitsNeeded);
    return count;
}

/**
 * The residual of one macroblock (readResidualCabac): `flags` has bit 0 Intra16x16, bit 1 intra,
 * bit 2 the 8x8 transform and bit 3 a field macroblock; `dcContexts` the coded_block_flag ctxIdxInc
 * of the luma, Cb and Cr DC blocks in bits 0-3, 4-7 and 8-11; `chromaBlocks` 4, 8, or 0 without
 * chroma. Fills the coefficients, the DC coefficients and the coefficient counts in the scratch
 * block and returns the DC flags (bit 0 luma, 1 Cb, 2 Cr).
 */
function residual_mb(scratch, cbp, flags, qp, chromaQp0, chromaQp1, dcContexts, chromaBlocks) {
    const i16 = flags & 1;
    const intra = flags & 2;
    const field = (flags >> 3) & 1;
    const nnz = scratch + SCRATCH_NNZ;
    const coeffs = scratch + SCRATCH_COEFFS;
    const dc = scratch + SCRATCH_DC;
    const scan4 = field ? FIELD_4X4 : ZIGZAG_4X4;
    let dcFlags = 0;
    if (i16 && cabac_bin(scratch, 85 + (dcContexts & 15))) {
        const sig = field ? 277 : 105;
        residual_block(
            scratch,
            sig,
            field ? 338 : 166,
            CTX_IDENTITY,
            CTX_IDENTITY,
            16,
            227,
            4,
            dc,
            scan4,
            UNIT_SCALE,
        );
        dcFlags |= 1;
    }
    if (cbp & 15) {
        if (flags & 4) {
            const scale = scratch + SCRATCH_DEQUANT8 + (intra ? 0 : DEQUANT8_BYTES) + qp * 256;
            const sigMap = field ? SIG_8X8_FIELD : SIG_8X8_FRAME;
            const scan8 = field ? FIELD_8X8 : ZIGZAG_8X8;
            for (let i8 = 0; i8 < 4; i8++) {
                if (!((cbp >> i8) & 1)) continue;
                const out = coeffs + i8 * 256;
                const count = residual_block(
                    scratch,
                    field ? 436 : 402,
                    field ? 451 : 417,
                    sigMap,
                    LAST_8X8,
                    64,
                    426,
                    4,
                    out,
                    scan8,
                    scale,
                );
                const p = nnz + ((i8 >> 1) * 2 + 1) * 8 + 4 + (i8 & 1) * 2;
                store8(p, count);
                store8(p + 1, count);
                store8(p + 8, count);
                store8(p + 9, count);
            }
        } else {
            const cbfBase = i16 ? 89 : 93;
            const sig = i16 ? (field ? 292 : 120) : field ? 306 : 134;
            const lastCtx = i16 ? (field ? 353 : 181) : field ? 367 : 195;
            const absCtx = i16 ? 237 : 247;
            const numCoeff = i16 ? 15 : 16;
            const scan = scan4 + i16;
            const scale = scratch + SCRATCH_DEQUANT4 + (intra ? 0 : 3 * DEQUANT4_BYTES) + qp * 64;
            for (let blk = 0; blk < 16; blk++) {
                if (!((cbp >> (blk >> 2)) & 1)) continue;
                const pos = nnz + load8u(BLOCK_CACHE + blk);
                if (
                    !cabac_bin(
                        scratch,
                        cbfBase + (load8u(pos - 1) !== 0) + (load8u(pos - 8) !== 0) * 2,
                    )
                )
                    continue;
                const out = coeffs + load8u(BLOCK_RASTER + blk) * 64;
                const count = residual_block(
                    scratch,
                    sig,
                    lastCtx,
                    CTX_IDENTITY,
                    CTX_IDENTITY,
                    numCoeff,
                    absCtx,
                    4,
                    out,
                    scan,
                    scale,
                );
                store8(pos, count);
            }
        }
    }
    if (chromaBlocks && cbp & 48) {
        const map = chromaBlocks === 4 ? CTX_IDENTITY : CTX_CHROMA_DC_422;
        const scan = chromaBlocks === 4 ? CHROMA_DC_SCAN_420 : CHROMA_DC_SCAN_422;
        for (let plane = 0; plane < 2; plane++) {
            if (!cabac_bin(scratch, 97 + ((dcContexts >> (4 + plane * 4)) & 15))) continue;
            const out = dc + (16 + plane * 8) * 4;
            residual_block(
                scratch,
                field ? 321 : 149,
                field ? 382 : 210,
                map,
                map,
                chromaBlocks,
                257,
                3,
                out,
                scan,
                UNIT_SCALE,
            );
            dcFlags |= 2 << plane;
        }
    }
    if (chromaBlocks && cbp & 32) {
        for (let plane = 0; plane < 2; plane++) {
            const cacheBase = nnz + (plane ? 88 : 48);
            const chromaQp = plane ? chromaQp1 : chromaQp0;
            const scale =
                scratch +
                SCRATCH_DEQUANT4 +
                ((intra ? 1 : 4) + plane) * DEQUANT4_BYTES +
                chromaQp * 64;
            for (let b = 0; b < chromaBlocks; b++) {
                const pos = cacheBase + (b >> 1) * 8 + 4 + (b & 1);
                if (
                    !cabac_bin(scratch, 101 + (load8u(pos - 1) !== 0) + (load8u(pos - 8) !== 0) * 2)
                )
                    continue;
                const out = coeffs + (256 + (plane * 8 + b) * 16) * 4;
                const count = residual_block(
                    scratch,
                    field ? 324 : 152,
                    field ? 385 : 213,
                    CTX_IDENTITY,
                    CTX_IDENTITY,
                    15,
                    266,
                    4,
                    out,
                    scan4 + 1,
                    scale,
                );
                store8(pos, count);
            }
        }
    }
    return dcFlags;
}
