// WebAssembly SIMD kernels of the built-in H.264 decoder, written in the WebAssembly text format
// and assembled by scripts/wat.mjs at build time. Each kernel gives the same integers as the
// JavaScript kernel it replaces (src/codecs/h264/inter-pred.ts, transform.ts and deblock.ts). All
// addresses are byte offsets into the imported memory; kernels may read up to 16 bytes past the
// last sample they use, so the caller keeps that much slack after every plane.
//
// Exports:
//   mc_luma(src, srcStride, dst, dstStride, w, h, mode)
//       quarter-sample luma prediction, mode = fx | fy << 2
//   mc_chroma(src, srcStride, dst, dstStride, w, h, fx, fy)
//       eighth-sample chroma prediction of one plane
//   avg(a, aStride, b, bStride, dst, dstStride, w, h)
//       (a + b + 1) >> 1
//   weight2(a, aStride, b, bStride, dst, dstStride, w, h, w0, w1, offset, logWD)
//       explicit or implicit bi-prediction
//   weight1(a, aStride, dst, dstStride, w, h, weight, offset, logWD)
//       explicit single-list prediction
//   idct4_add(coeffs, dst, stride), idct8_add(coeffs, dst, stride)
//       residual of 32-bit coefficients, then cleared
//   dc_add(dc, dst, stride, size)
//       residual of a block with only a DC coefficient
//   deblock_luma_h(q0, step, alpha, beta, bs, tc0)
//       horizontal luma edge: 16 samples across `step`
//   deblock_luma_v(q0, stride, alpha, beta, bs, tc0)
//       vertical luma edge: 16 lines `stride` apart
//   deblock_chroma_h(q0, step, alpha, beta, bs, tc)
//       horizontal chroma edge of 8 samples
//   deblock_chroma_v(q0, stride, alpha, beta, bs, tc)
//       vertical chroma edge of 8 lines
//   deblock_row(...)
//       one macroblock row without MBAFF (scripts/h264-deblock.mjs)
//   residual_mb(scratch, cbp, flags, qp, chromaQp0, chromaQp1, dcContexts, chromaBlocks)
//       CABAC residual of a macroblock (scripts/h264-cabac.mjs)
// `bs`, `tc0` and `tc` pack one byte per four luma lines or two chroma lines, first line group in
// the low byte.
//
// Constant tables live in the first TABLE_BYTES of the memory (data segments written on
// instantiation); each decoding thread has a scratch block laid out as SCRATCH_LAYOUT.

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { compileScalar } from './wasm-scalar.mjs';
import { assembleWat } from './wat.mjs';

/**
 * Bytes at the start of the kernel memory reserved for the tables (TABLE_BYTES in
 * src/codecs/h264/kernels.ts).
 */
export const TABLE_BYTES = 4096;

/**
 * Byte offsets in a thread's scratch block, which src/codecs/h264/kernels.ts repeats: coefficients
 * (512 words), two prediction blocks, the emulated-edge block, DC coefficients (32 words), the
 * coefficient-count cache, the CABAC engine and contexts, the significant positions of a block, the
 * intra mode, direct, reference, vector and mvd caches of the macroblock (two lists each), the
 * dequantisation tables (6 4x4 and 2 8x8 lists of 52 QPs) and the RBSP.
 */
export const SCRATCH_LAYOUT = {
    SCRATCH_COEFFS: 0,
    SCRATCH_PRED_A: 2048,
    SCRATCH_PRED_B: 2560,
    SCRATCH_EDGE: 3072,
    SCRATCH_DC: 4096,
    SCRATCH_NNZ: 4224,
    SCRATCH_CABAC: 4352,
    SCRATCH_CONTEXTS: 4384,
    SCRATCH_INDEX: 5408,
    SCRATCH_INTRA_CACHE: 5504,
    SCRATCH_DIRECT_CACHE: 5552,
    SCRATCH_REF_CACHE: 5600,
    REF_CACHE_BYTES: 48,
    SCRATCH_MV_CACHE: 5696,
    MV_CACHE_BYTES: 160,
    SCRATCH_MVD_CACHE: 6016,
    MVD_CACHE_BYTES: 80,
    SCRATCH_SLICE: 6208,
    SCRATCH_DEQUANT4: 12864,
    DEQUANT4_BYTES: 52 * 16 * 4,
    SCRATCH_DEQUANT8: 12864 + 6 * 52 * 16 * 4,
    DEQUANT8_BYTES: 52 * 64 * 4,
    SCRATCH_BITS: 12864 + 6 * 52 * 16 * 4 + 2 * 52 * 64 * 4,
    BITS_BYTES: 1 << 20,
};

/**
 * Byte offsets in the slice block at SCRATCH_SLICE (SLICE_BLOCK in src/codecs/h264/kernels.ts): the
 * slice parameters and the addresses of the current picture's arrays (S_*, 32-bit words), the state
 * of the macroblock being decoded (M_*), the reference entries of both lists (E_* within each), the
 * explicit weights (six 16-bit values per reference), the implicit weights (bytes by ref0 * 32 +
 * ref1), DistScaleFactor per list 0 index and the DC LevelScale of each 4x4 scaling list by QP % 6.
 */
export const SLICE_LAYOUT = {
    S_B: 0,
    S_MB_WIDTH: 4,
    S_MB_HEIGHT: 8,
    S_FIELD: 12,
    S_STRUCTURE: 16,
    S_CHROMA: 20,
    S_T8X8_MODE: 24,
    S_DIRECT_8X8: 28,
    S_DIRECT_SPATIAL: 32,
    S_ACTIVE0: 36,
    S_ACTIVE1: 40,
    S_WEIGHT_MODE: 44,
    S_LUMA_LOG2: 48,
    S_CHROMA_LOG2: 52,
    S_COL_PARITY: 56,
    S_COL_FIELD_OFFSET: 60,
    S_LUMA_STRIDE: 64,
    S_CHROMA_STRIDE: 68,
    S_LUMA: 72,
    S_CB: 76,
    S_CR: 80,
    S_FLAGS: 84,
    S_SLICE_NUM: 88,
    S_QP: 92,
    S_NZ: 96,
    S_MOTION: 100,
    S_CBP: 104,
    S_DC: 108,
    S_CHROMA_MODE: 112,
    S_DIRECT: 116,
    S_NNZ: 120,
    S_MVD0: 124,
    S_MVD1: 128,
    S_REF0: 132,
    S_REF1: 136,
    S_REFID0: 140,
    S_REFID1: 144,
    S_MV0: 148,
    S_MV1: 152,
    S_SLICE: 156,
    S_CB_QP_OFFSET: 160,
    S_CR_QP_OFFSET: 164,
    S_QP_Y: 168,
    S_LAST_QP_DELTA: 172,
    S_COUNT0: 176,
    S_COUNT1: 180,
    S_COL_FLAGS: 184,
    S_COL_REF0: 188,
    S_COL_REF1: 192,
    S_COL_REFID0: 196,
    S_COL_REFID1: 200,
    S_COL_MV0: 204,
    S_COL_MV1: 208,
    S_WAIT: 212,
    M_X: 224,
    M_Y: 228,
    M_XY: 232,
    M_LEFT: 236,
    M_TOP: 240,
    M_TOPLEFT: 244,
    M_TOPRIGHT: 248,
    M_LEFT_AVAIL: 252,
    M_TOP_AVAIL: 256,
    M_TOPLEFT_AVAIL: 260,
    M_TOPRIGHT_AVAIL: 264,
    M_LUMA: 268,
    M_STRIDE: 272,
    M_CHROMA: 276,
    M_CSTRIDE: 280,
    M_TYPE_FLAGS: 284,
    M_SHAPE: 288,
    M_PART_PRED: 292,
    M_SUB_SHAPE: 296,
    M_SUB_PRED: 300,
    M_DIRECT: 304,
    M_CBP: 308,
    M_T8X8: 312,
    M_DIRECT_UNIFORM: 316,
    M_COL_XY: 320,
    M_COL_XY2: 324,
    M_COL_MIXED: 328,
    M_COL_SHIFT: 332,
    M_REF_PARSED: 336,
    M_CHROMA_X: 344,
    M_CHROMA_Y: 348,
    M_CHROMA_FX: 352,
    M_CHROMA_FY: 356,
    M_BI: 368,
    ENTRIES: 448,
    ENTRY_BYTES: 64,
    ENTRY_LIST_BYTES: 32 * 64,
    E_PRESENT: 0,
    E_ID: 4,
    E_PARITY: 8,
    E_LONG: 12,
    E_LUMA: 16,
    E_STRIDE: 20,
    E_WIDTH: 24,
    E_HEIGHT: 28,
    E_CB: 32,
    E_CR_SHIFT: 36,
    E_CSTRIDE: 40,
    E_CWIDTH: 44,
    E_CHEIGHT: 48,
    WEIGHTS: 4544,
    WEIGHT_LIST_BYTES: 32 * 6 * 2,
    IMPLICIT: 5312,
    DIST_SCALE: 6336,
    LEVEL_DC: 6464,
    SLICE_BYTES: 6656,
};

/** Results of inter_mb. */
export const INTER_RESULTS = {
    MB_DONE: 0,
    MB_SKIPPED: 1,
    MB_INTRA_P: 2,
    MB_INTRA_B: 3,
    ERROR_REF_IDX: -1,
    ERROR_QP_DELTA: -2,
};

/**
 * The numbers of an array literal (or `new XArray([...])`, or nested arrays of them) named `name`
 * in a source file.
 */
function sourceTable(file, name) {
    const path = new URL(`../src/codecs/h264/${file}`, import.meta.url);
    const source = ts.createSourceFile(
        file,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
    );
    const value = node => {
        if (ts.isNumericLiteral(node)) return Number(node.text);
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken)
            return -value(node.operand);
        if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
        if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.arguments?.length === 1)
            return value(node.arguments[0]);
        throw new Error(`h264 kernels: ${name} in ${file} is not a literal table`);
    };
    let found;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText() === name)
            found = value(node.initializer);
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`h264 kernels: ${name} not found in ${file}`);
    return found;
}

/** CABAC and scan tables, from the sources the JavaScript decoder uses. */
function cabacTables() {
    const rangeLps = sourceTable('tables.ts', 'RANGE_LPS');
    const transIdx = sourceTable('tables.ts', 'TRANS_IDX_LPS');
    const blockX = sourceTable('tables.ts', 'BLOCK_X');
    const blockY = sourceTable('tables.ts', 'BLOCK_Y');
    const states = Array.from({ length: 128 }, (_, s) => [s >> 1, s & 1]);
    const [sigFrame, sigField] = sourceTable('slice-decoder.ts', 'SIG_8X8');
    return {
        // rangeTabLPS by (pStateIdx << 1 | valMPS) * 4 + qRangeIdx, and the next state after an MPS
        // (first 128) or an LPS (last 128), as Cabac in cabac.ts.
        LPS_RANGE: states.flatMap(([state]) => rangeLps.slice(state * 4, state * 4 + 4)),
        NEXT_STATE: [
            ...states.map(([state, mps]) => (Math.min(state + 1, 62) << 1) | mps),
            ...states.map(([state, mps]) => (transIdx[state] << 1) | (state === 0 ? mps ^ 1 : mps)),
        ],
        CTX_IDENTITY: Array.from({ length: 64 }, (_, i) => i),
        CTX_CHROMA_DC_422: sourceTable('slice-decoder.ts', 'CTX_CHROMA_DC_422'),
        CHROMA_DC_SCAN_420: sourceTable('slice-decoder.ts', 'CHROMA_DC_SCAN_420'),
        CHROMA_DC_SCAN_422: sourceTable('slice-decoder.ts', 'CHROMA_DC_SCAN_422'),
        ZIGZAG_4X4: sourceTable('tables.ts', 'ZIGZAG_4X4'),
        FIELD_4X4: sourceTable('tables.ts', 'FIELD_4X4'),
        ZIGZAG_8X8: sourceTable('../shared/dct-scan.ts', 'ZIGZAG_8X8'),
        FIELD_8X8: sourceTable('tables.ts', 'FIELD_8X8'),
        SIG_8X8_FRAME: sigFrame,
        SIG_8X8_FIELD: sigField,
        LAST_8X8: sourceTable('slice-decoder.ts', 'LAST_8X8'),
        // Coefficient-count cache position (cacheAt) and raster index of each 4x4 block in coding
        // order.
        BLOCK_CACHE: blockX.map((x, blk) => (blockY[blk] + 1) * 8 + 4 + x),
        BLOCK_RASTER: blockX.map((x, blk) => blockY[blk] * 4 + x),
        // UNIT_SCALE of slice-context.ts: 16 words of 64, little-endian.
        UNIT_SCALE: new Array(16).fill([64, 0, 0, 0]).flat(),
        MVD_SLOT: sourceTable('slice-decoder.ts', 'MVD_SLOT'),
        RASTER_TO_BLOCK: sourceTable('tables.ts', 'RASTER_TO_BLOCK'),
        B_PARTITION_PRED: sourceTable('slice-decoder.ts', 'B_PARTITION_PRED'),
        B_PARTITION_SHAPE: sourceTable('slice-decoder.ts', 'B_PARTITION_SHAPE'),
        B_SUB_PRED: sourceTable('slice-decoder.ts', 'B_SUB_PRED'),
        B_SUB_SHAPE: sourceTable('slice-decoder.ts', 'B_SUB_SHAPE'),
    };
}

/** tC0 by indexA * 4 + bS (Table 8-17). */
function tc0Table() {
    const rows = [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 2],
        [1, 1, 2],
        [1, 1, 2],
        [1, 1, 2],
        [1, 2, 3],
        [1, 2, 3],
        [2, 2, 3],
        [2, 2, 4],
        [2, 3, 4],
        [2, 3, 4],
        [3, 3, 5],
        [3, 4, 6],
        [3, 4, 6],
        [4, 5, 7],
        [4, 5, 8],
        [4, 6, 9],
        [5, 7, 10],
        [6, 8, 11],
        [6, 8, 13],
        [7, 10, 14],
        [8, 11, 16],
        [9, 12, 18],
        [10, 13, 20],
        [11, 15, 23],
        [13, 17, 25],
    ];
    const table = new Array(52 * 4).fill(0);
    rows.forEach((row, i) => row.forEach((value, bs) => (table[(17 + i) * 4 + 1 + bs] = value)));
    return table;
}

/** The tables of the scalar kernels by name. */
const TABLES = {
    // alpha' and beta' by indexA / indexB (Table 8-16).
    ALPHA: [
        ...new Array(16).fill(0),
        4,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        12,
        13,
        15,
        17,
        20,
        22,
        25,
        28,
        32,
        36,
        40,
        45,
        50,
        56,
        63,
        71,
        80,
        90,
        101,
        113,
        127,
        144,
        162,
        182,
        203,
        226,
        255,
        255,
    ],
    BETA: [
        ...new Array(16).fill(0),
        2,
        2,
        2,
        3,
        3,
        3,
        3,
        4,
        4,
        4,
        6,
        6,
        7,
        7,
        8,
        8,
        9,
        9,
        10,
        10,
        11,
        11,
        12,
        12,
        13,
        13,
        14,
        14,
        15,
        15,
        16,
        16,
        17,
        17,
        18,
        18,
    ],
    TC0: tc0Table(),
    // QPc by qPi (Table 8-15).
    CHROMA_QP: [
        ...Array.from({ length: 30 }, (_, i) => i),
        29,
        30,
        31,
        32,
        32,
        33,
        34,
        34,
        35,
        35,
        36,
        36,
        37,
        37,
        37,
        38,
        38,
        38,
        39,
        39,
        39,
        39,
    ],
    // Segments of equal motion along vertical and horizontal edges per motion class
    // (src/codecs/h264/deblock.ts).
    RUN_VERTICAL: [4, 2, 4, 2, 1],
    RUN_HORIZONTAL: [4, 4, 2, 2, 1],
};

/** Addresses of the tables (16-byte aligned from 0) and their data segments. */
function tableLayout() {
    const addresses = {};
    const segments = [];
    let at = 0;
    for (const [name, values] of Object.entries({ ...TABLES, ...cabacTables() })) {
        addresses[name] = at;
        const text = values
            .map(value => `\\${(value & 255).toString(16).padStart(2, '0')}`)
            .join('');
        segments.push(`(data (i32.const ${at}) "${text}")`);
        at += (values.length + 15) & ~15;
    }
    if (at > TABLE_BYTES) throw new Error('h264 kernels: tables exceed TABLE_BYTES');
    return { addresses, segments };
}

/**
 * Macroblock flags and motion classes of src/codecs/h264/picture.ts and deblock.ts, the cache
 * markers, shapes and prediction flags of slice-decoder.ts, picture structures of tables.ts and the
 * emulated-edge stride of inter-pred.ts.
 */
const SCALAR_CONSTANTS = {
    MB_INTRA: 1,
    MB_FIELD: 2,
    MB_DECODED: 4,
    MB_SKIP: 8,
    MB_DIRECT16: 16,
    MB_T8X8: 32,
    MB_PCM: 64,
    PART_NOT_AVAILABLE: -2,
    LIST_NOT_USED: -1,
    PRED_L0: 1,
    SHAPE_16X16: 0,
    SHAPE_16X8: 1,
    SHAPE_8X16: 2,
    SHAPE_8X8: 3,
    SUB_8X8: 0,
    SUB_8X4: 1,
    SUB_4X8: 2,
    SUB_4X4: 3,
    PICT_BOTTOM: 2,
    PICT_FRAME: 3,
    EDGE_STRIDE: 24,
    MOTION_UNIFORM: 0,
    MOTION_16X8: 1,
    MOTION_8X16: 2,
    MOTION_8X8: 3,
    MOTION_4X4: 4,
};

/** Local declarations collected while a function body is generated. */
class Locals {
    constructor() {
        this.types = new Map();
    }

    get(name, type = 'v128') {
        if (!this.types.has(name)) this.types.set(name, type);
        else if (this.types.get(name) !== type)
            throw new Error(`h264 kernels: local ${name} redeclared`);
        return `(local.get $${name})`;
    }

    declarations(params) {
        return [...this.types]
            .filter(([name]) => !params.includes(name))
            .map(([name, type]) => `(local $${name} ${type})`)
            .join(' ');
    }
}

let locals = new Locals();
const v = name => locals.get(name, 'v128');
const i = name => locals.get(name, 'i32');
const setV = (name, expr) => (locals.get(name, 'v128'), `(local.set $${name} ${expr})`);
const setI = (name, expr) => (locals.get(name, 'i32'), `(local.set $${name} ${expr})`);
const c32 = n => `(i32.const ${n})`;
const add = (a, b) => `(i32.add ${a} ${b})`;
const sub = (a, b) => `(i32.sub ${a} ${b})`;
const mul = (a, b) => `(i32.mul ${a} ${b})`;
const splat16 = n => `(v128.const i16x8 ${Array(8).fill(n).join(' ')})`;
const splat32 = n => `(v128.const i32x4 ${Array(4).fill(n).join(' ')})`;
const zero = '(v128.const i32x4 0 0 0 0)';
const op = (name, ...args) => `(${name} ${args.join(' ')})`;

/** i8x16.shuffle selecting 32-bit lanes (0-3 from `a`, 4-7 from `b`). */
function shuffle32(a, b, lanes) {
    const bytes = lanes.flatMap(lane => [lane * 4, lane * 4 + 1, lane * 4 + 2, lane * 4 + 3]);
    return `(i8x16.shuffle ${bytes.join(' ')} ${a} ${b})`;
}

/** Declares a function whose parameters are i32 unless typed as [name, type]. */
function func(name, params, body, exported = true) {
    const declared = params.map(param => (Array.isArray(param) ? param : [param, 'i32']));
    const names = declared.map(([paramName]) => paramName);
    for (const [paramName, type] of declared) locals.get(paramName, type);
    const text = `(func $${name}${exported ? ` (export "${name}")` : ''} ${declared
        .map(([paramName, type]) => `(param $${paramName} ${type})`)
        .join(' ')} ${locals.declarations(names)}\n${body}\n)`;
    locals = new Locals();
    return text;
}

/**
 * Generates a function body with fresh locals: `build` runs before `func` reads the declarations.
 */
function define(name, params, build, exported = true) {
    locals = new Locals();
    for (const param of params) locals.get(...(Array.isArray(param) ? param : [param, 'i32']));
    const body = build();
    return func(name, params, body, exported);
}

// -------------------------------------------------------------------------------------------------
// Luma interpolation (8.4.2.2.1)

/** Six-tap sum (a + f) - 5 (b + e) + 20 (c + d) of 16-bit lanes. */
function tap16(a, b, c, d, e, f) {
    return op(
        'i16x8.add',
        op('i16x8.add', a, f),
        op(
            'i16x8.add',
            op('i16x8.mul', op('i16x8.add', c, d), v('k20')),
            op('i16x8.mul', op('i16x8.add', b, e), v('km5')),
        ),
    );
}

/**
 * The six-tap sum of intermediate 16-bit lanes in two 32-bit halves, rounded (+512 >> 10) back into
 * 16-bit lanes.
 */
function tap32Rounded(a, b, c, d, e, f) {
    const half = (extend, extmul) =>
        op(
            'i32x4.shr_s',
            op(
                'i32x4.add',
                op('i32x4.add', op(extend, op('i16x8.add', a, f)), v('k512')),
                op(
                    'i32x4.add',
                    op(extmul, op('i16x8.add', c, d), v('k20')),
                    op(extmul, op('i16x8.add', b, e), v('km5')),
                ),
            ),
            c32(10),
        );
    return op(
        'i16x8.narrow_i32x4_s',
        half('i32x4.extend_low_i16x8_s', 'i32x4.extmul_low_i16x8_s'),
        half('i32x4.extend_high_i16x8_s', 'i32x4.extmul_high_i16x8_s'),
    );
}

const lumaConstants = () =>
    [
        setV('k20', splat16(20)),
        setV('km5', splat16(-5)),
        setV('k16', splat16(16)),
        setV('k512', splat32(512)),
    ].join('\n');

/** (x + 16) >> 5 of 16-bit lanes saturated to bytes in both halves. */
const round5 = x => {
    const r = op('i16x8.shr_s', op('i16x8.add', x, v('k16')), c32(5));
    return `(i8x16.narrow_i16x8_u ${r} ${r})`;
};
const bytes8 = addr => `(v128.load8x8_u ${addr})`;

/**
 * Stores the low `w` (4 or 8) bytes of a vector at `d`, averaging with the bytes already there when
 * `average`.
 */
function storeRow(value, average) {
    const result = average ? op('i8x16.avgr_u', value, `(v128.load64_zero ${i('d')})`) : value;
    return `${setV('out', result)}
    (if (i32.eq ${i('w')} (i32.const 4))
        (then (v128.store32_lane 0 ${i('d')} ${v('out')}))
        (else (v128.store64_lane 0 ${i('d')} ${v('out')})))`;
}

/**
 * Loops over strips of 8 columns and, within each, `rows` rows; `setup` runs per strip, `row` per
 * row.
 */
function strips(setup, row) {
    return `${setI('x', c32(0))}
(loop $cols
    ${setI('s', add(i('src'), i('x')))}
    ${setI('d', add(i('dst'), i('x')))}
    ${setI('y', i('h'))}
    ${setup}
    (loop $rows
        ${row}
        ${setI('s', add(i('s'), i('ss')))}
        ${setI('d', add(i('d'), i('ds')))}
        (br_if $rows (local.tee $y (i32.sub ${i('y')} (i32.const 1)))))
    (br_if $cols (i32.lt_u (local.tee $x (i32.add ${i('x')} (i32.const 8))) ${i('w')})))`;
}

const MC_PARAMS = ['src', 'ss', 'dst', 'ds', 'w', 'h'];

/** Half sample b of each position (8-241), stored or averaged into `dst`. */
function lumaHorizontal(name, average) {
    return define(
        name,
        MC_PARAMS,
        () => `${lumaConstants()}
${setI('src', sub(i('src'), c32(2)))}
${strips(
    '',
    storeRow(
        round5(tap16(...[0, 1, 2, 3, 4, 5].map(k => bytes8(k ? `offset=${k} ${i('s')}` : i('s'))))),
        average,
    ),
)}`,
        false,
    );
}

/** Half sample h of each position (8-242), stored or averaged into `dst`. */
function lumaVertical(name, average) {
    const rows = [0, 1, 2, 3, 4]
        .map(k => setV(`r${k}`, bytes8(add(i('s'), mul(i('ss'), c32(k - 2))))))
        .join('\n');
    return define(
        name,
        MC_PARAMS,
        () => `${lumaConstants()}
${strips(
    rows,
    `${setV('r5', bytes8(add(i('s'), mul(i('ss'), c32(3)))))}
    ${storeRow(round5(tap16(v('r0'), v('r1'), v('r2'), v('r3'), v('r4'), v('r5'))), average)}
    ${setV('r0', v('r1'))} ${setV('r1', v('r2'))} ${setV('r2', v('r3'))} ${setV('r3', v('r4'))}
      ${setV('r4', v('r5'))}`,
)}`,
        false,
    );
}

/**
 * Centre half sample j (8-243) from horizontal intermediates of rows -2..h+2, stored or averaged
 * into `dst`.
 */
function lumaCentre(name, average) {
    const hraw = row =>
        tap16(
            ...[0, 1, 2, 3, 4, 5].map(k =>
                bytes8(`offset=${k} ${add(i('s'), mul(i('ss'), c32(row)))}`),
            ),
        );
    const setup = [0, 1, 2, 3, 4].map(k => setV(`m${k}`, hraw(k - 2))).join('\n');
    const value = tap32Rounded(v('m0'), v('m1'), v('m2'), v('m3'), v('m4'), v('m5'));
    return define(
        name,
        MC_PARAMS,
        () => `${lumaConstants()}
${setI('src', sub(i('src'), c32(2)))}
${strips(
    setup,
    `${setV('m5', hraw(3))}
    ${setV('j', value)}
    ${storeRow(`(i8x16.narrow_i16x8_u ${v('j')} ${v('j')})`, average)}
    ${setV('m0', v('m1'))} ${setV('m1', v('m2'))} ${setV('m2', v('m3'))} ${setV('m3', v('m4'))}
      ${setV('m4', v('m5'))}`,
)}`,
        false,
    );
}

/** Full samples averaged into `dst` (quarter samples a, c, d, n). */
function lumaFullAverage(name) {
    return define(
        name,
        MC_PARAMS,
        () => strips('', storeRow(`(v128.load64_zero ${i('s')})`, true)),
        false,
    );
}

/** Copies a block of 4, 8 or 16 columns. */
function copyBlock() {
    return define(
        'copy',
        MC_PARAMS,
        () => `(block $done
    (if (i32.eq ${i('w')} (i32.const 16))
        (then
            (loop $r16
                (v128.store ${i('dst')} (v128.load ${i('src')}))
                ${setI('src', add(i('src'), i('ss')))}
                ${setI('dst', add(i('dst'), i('ds')))}
                (br_if $r16 (local.tee $h (i32.sub ${i('h')} (i32.const 1)))))
            (br $done)))
    (if (i32.eq ${i('w')} (i32.const 8))
        (then
            (loop $r8
                (i64.store ${i('dst')} (i64.load ${i('src')}))
                ${setI('src', add(i('src'), i('ss')))}
                ${setI('dst', add(i('dst'), i('ds')))}
                (br_if $r8 (local.tee $h (i32.sub ${i('h')} (i32.const 1)))))
            (br $done)))
    (loop $r4
        (i32.store ${i('dst')} (i32.load ${i('src')}))
        ${setI('src', add(i('src'), i('ss')))}
        ${setI('dst', add(i('dst'), i('ds')))}
        (br_if $r4 (local.tee $h (i32.sub ${i('h')} (i32.const 1))))))`,
        false,
    );
}

/**
 * Dispatches the sixteen fractional positions to the passes above, as MotionCompensator.luma does.
 */
function mcLuma() {
    const call = (fn, src) =>
        `(call $${fn} ${src} ${i('ss')} ${i('dst')} ${i('ds')} ${i('w')} ${i('h')})`;
    const p = i('src');
    const right = add(i('src'), c32(1));
    const below = add(i('src'), i('ss'));
    const cases = [
        call('copy', p),
        `${call('put_h', p)} ${call('avg_full', p)}`,
        call('put_h', p),
        `${call('put_h', p)} ${call('avg_full', right)}`,
        `${call('put_v', p)} ${call('avg_full', p)}`,
        `${call('put_h', p)} ${call('avg_v', p)}`,
        `${call('put_j', p)} ${call('avg_h', p)}`,
        `${call('put_h', p)} ${call('avg_v', right)}`,
        call('put_v', p),
        `${call('put_j', p)} ${call('avg_v', p)}`,
        call('put_j', p),
        `${call('put_j', p)} ${call('avg_v', right)}`,
        `${call('put_v', p)} ${call('avg_full', below)}`,
        `${call('put_h', below)} ${call('avg_v', p)}`,
        `${call('put_j', p)} ${call('avg_h', below)}`,
        `${call('put_h', below)} ${call('avg_v', right)}`,
    ];
    return define('mc_luma', [...MC_PARAMS, 'mode'], () => {
        const labels = cases.map((_, k) => `$m${k}`);
        let text = `(br_table ${labels.join(' ')} $m0 ${i('mode')})`;
        for (let k = 0; k < cases.length; k++)
            text = `(block ${labels[k]} ${text})\n${cases[k]}\n(return)`;
        return text;
    });
}

// -------------------------------------------------------------------------------------------------
// Chroma interpolation (8-266)

function mcChroma() {
    return define('mc_chroma', ['src', 'ss', 'dst', 'ds', 'w', 'h', 'fx', 'fy'], () => {
        const horizontal = addr =>
            op(
                'i16x8.add',
                op('i16x8.mul', bytes8(addr), v('gx')),
                op('i16x8.mul', bytes8(`offset=1 ${addr}`), v('fxv')),
            );
        const value = op(
            'i16x8.shr_u',
            op(
                'i16x8.add',
                op(
                    'i16x8.add',
                    op('i16x8.mul', v('above'), v('gy')),
                    op('i16x8.mul', v('below'), v('fyv')),
                ),
                v('k32'),
            ),
            c32(6),
        );
        return `${setV('gx', op('i16x8.splat', sub(c32(8), i('fx'))))}
${setV('fxv', op('i16x8.splat', i('fx')))}
${setV('gy', op('i16x8.splat', sub(c32(8), i('fy'))))}
${setV('fyv', op('i16x8.splat', i('fy')))}
${setV('k32', splat16(32))}
${setV('above', horizontal(i('src')))}
(loop $rows
    ${setI('src', add(i('src'), i('ss')))}
    ${setV('below', horizontal(i('src')))}
    ${setV('out', `(i8x16.narrow_i16x8_u ${value} ${value})`)}
    (if (i32.eq ${i('w')} (i32.const 8))
        (then (v128.store64_lane 0 ${i('dst')} ${v('out')}))
        (else (if (i32.eq ${i('w')} (i32.const 4))
            (then (v128.store32_lane 0 ${i('dst')} ${v('out')}))
            (else (v128.store16_lane 0 ${i('dst')} ${v('out')})))))
    ${setV('above', v('below'))}
    ${setI('dst', add(i('dst'), i('ds')))}
    (br_if $rows (local.tee $h (i32.sub ${i('h')} (i32.const 1)))))`;
    });
}

// -------------------------------------------------------------------------------------------------
// Bi-prediction and weighted prediction (8.4.2.3)

/** Stores the low `w` bytes (2, 4, 8 or 16) of `out` at `dst`. */
function storeWidth(value) {
    return `${setV('out', value)}
    (if (i32.ge_u ${i('w')} (i32.const 16))
        (then (v128.store ${i('d')} ${v('out')}))
        (else (if (i32.eq ${i('w')} (i32.const 8))
            (then (v128.store64_lane 0 ${i('d')} ${v('out')}))
            (else (if (i32.eq ${i('w')} (i32.const 4))
                (then (v128.store32_lane 0 ${i('d')} ${v('out')}))
                (else (v128.store16_lane 0 ${i('d')} ${v('out')})))))))`;
}

/**
 * Rows of a two-source block: `row` computes one vector of up to 16 samples from the addresses $pa
 * and $pb.
 */
function twoSourceRows(row) {
    return `(loop $rows
    ${setI('pa', i('a'))}
    ${setI('pb', i('b'))}
    ${setI('d', i('dst'))}
    ${setI('x', i('w'))}
    (loop $cols
        ${row}
        ${setI('pa', add(i('pa'), c32(16)))}
        ${setI('pb', add(i('pb'), c32(16)))}
        ${setI('d', add(i('d'), c32(16)))}
        (br_if $cols (i32.gt_s (local.tee $x (i32.sub ${i('x')} (i32.const 16))) (i32.const 0))))
    ${setI('a', add(i('a'), i('as')))}
    ${setI('b', add(i('b'), i('bs')))}
    ${setI('dst', add(i('dst'), i('ds')))}
    (br_if $rows (local.tee $h (i32.sub ${i('h')} (i32.const 1)))))`;
}

function average() {
    return define('avg', ['a', 'as', 'b', 'bs', 'dst', 'ds', 'w', 'h'], () =>
        twoSourceRows(
            storeWidth(op('i8x16.avgr_u', `(v128.load ${i('pa')})`, `(v128.load ${i('pb')})`)),
        ),
    );
}

/**
 * ((a w0 + b w1 + 2^logWD) >> (logWD + 1)) + offset of 8 samples in 32-bit lanes, saturated to
 * bytes.
 */
function weighted2Half(extmul, extend) {
    return op(
        'i32x4.add',
        op(
            'i32x4.shr_s',
            op(
                'i32x4.add',
                op('i32x4.add', op(extmul, v('av'), v('w0v')), op(extmul, v('bv'), v('w1v'))),
                v('round'),
            ),
            i('shift'),
        ),
        v('offv'),
    );
}

function weight2() {
    return define(
        'weight2',
        ['a', 'as', 'b', 'bs', 'dst', 'ds', 'w', 'h', 'w0', 'w1', 'offset', 'logWD'],
        () => {
            const eight = half => {
                const lo = weighted2Half('i32x4.extmul_low_i16x8_s', half);
                const hi = weighted2Half('i32x4.extmul_high_i16x8_s', half);
                return op('i16x8.narrow_i32x4_s', lo, hi);
            };
            return `${setV('w0v', op('i16x8.splat', i('w0')))}
${setV('w1v', op('i16x8.splat', i('w1')))}
${setV('offv', op('i32x4.splat', i('offset')))}
${setV('round', op('i32x4.splat', `(i32.shl (i32.const 1) ${i('logWD')})`))}
${setI('shift', add(i('logWD'), c32(1)))}
${twoSourceRows(`${setV('ra', `(v128.load ${i('pa')})`)}
        ${setV('rb', `(v128.load ${i('pb')})`)}
        ${setV('av', op('i16x8.extend_low_i8x16_u', v('ra')))}
        ${setV('bv', op('i16x8.extend_low_i8x16_u', v('rb')))}
        ${setV('lo', eight())}
        ${setV('av', op('i16x8.extend_high_i8x16_u', v('ra')))}
        ${setV('bv', op('i16x8.extend_high_i8x16_u', v('rb')))}
        ${storeWidth(op('i8x16.narrow_i16x8_u', v('lo'), eight()))}`)}`;
        },
    );
}

function weight1() {
    return define(
        'weight1',
        ['a', 'as', 'dst', 'ds', 'w', 'h', 'weight', 'offset', 'logWD'],
        () => {
            const half = extmul =>
                op(
                    'i32x4.add',
                    op(
                        'i32x4.shr_s',
                        op('i32x4.add', op(extmul, v('av'), v('wv')), v('round')),
                        i('logWD'),
                    ),
                    v('offv'),
                );
            const eight = () =>
                op(
                    'i16x8.narrow_i32x4_s',
                    half('i32x4.extmul_low_i16x8_s'),
                    half('i32x4.extmul_high_i16x8_s'),
                );
            return `${setV('wv', op('i16x8.splat', i('weight')))}
${setV('offv', op('i32x4.splat', i('offset')))}
${setV(
    'round',
    op(
        'i32x4.splat',
        `(if (result i32) (i32.ge_s ${i('logWD')} (i32.const 1)) (then (i32.shl (i32.const 1) ` +
            `(i32.sub ${i('logWD')} (i32.const 1)))) (else (i32.const 0)))`,
    ),
)}
(loop $rows
    ${setI('pa', i('a'))}
    ${setI('d', i('dst'))}
    ${setI('x', i('w'))}
    (loop $cols
        ${setV('ra', `(v128.load ${i('pa')})`)}
        ${setV('av', op('i16x8.extend_low_i8x16_u', v('ra')))}
        ${setV('lo', eight())}
        ${setV('av', op('i16x8.extend_high_i8x16_u', v('ra')))}
        ${storeWidth(op('i8x16.narrow_i16x8_u', v('lo'), eight()))}
        ${setI('pa', add(i('pa'), c32(16)))}
        ${setI('d', add(i('d'), c32(16)))}
        (br_if $cols (i32.gt_s (local.tee $x (i32.sub ${i('x')} (i32.const 16))) (i32.const 0))))
    ${setI('a', add(i('a'), i('as')))}
    ${setI('dst', add(i('dst'), i('ds')))}
    (br_if $rows (local.tee $h (i32.sub ${i('h')} (i32.const 1)))))`;
        },
    );
}

// -------------------------------------------------------------------------------------------------
// Inverse transforms (8.5.12, 8.5.13)

/** Transposes the 4x4 block of 32-bit lanes in locals a0..a3 into b0..b3. */
function transpose4(a, b) {
    return [
        setV('t0', shuffle32(v(a[0]), v(a[1]), [0, 4, 1, 5])),
        setV('t1', shuffle32(v(a[0]), v(a[1]), [2, 6, 3, 7])),
        setV('t2', shuffle32(v(a[2]), v(a[3]), [0, 4, 1, 5])),
        setV('t3', shuffle32(v(a[2]), v(a[3]), [2, 6, 3, 7])),
        setV(b[0], shuffle32(v('t0'), v('t2'), [0, 1, 4, 5])),
        setV(b[1], shuffle32(v('t0'), v('t2'), [2, 3, 6, 7])),
        setV(b[2], shuffle32(v('t1'), v('t3'), [0, 1, 4, 5])),
        setV(b[3], shuffle32(v('t1'), v('t3'), [2, 3, 6, 7])),
    ].join('\n');
}

const add32 = (a, b) => op('i32x4.add', a, b);
const sub32 = (a, b) => op('i32x4.sub', a, b);
const sar32 = (a, n) => op('i32x4.shr_s', a, c32(n));

/** The 4-point inverse transform of d0..d3 into o0..o3 (8-338 to 8-345), all 32-bit lanes. */
function idct4Pass(d, o) {
    return [
        setV('e', add32(v(d[0]), v(d[2]))),
        setV('f', sub32(v(d[0]), v(d[2]))),
        setV('g', sub32(sar32(v(d[1]), 1), v(d[3]))),
        setV('hh', add32(v(d[1]), sar32(v(d[3]), 1))),
        setV(o[0], add32(v('e'), v('hh'))),
        setV(o[1], add32(v('f'), v('g'))),
        setV(o[2], sub32(v('f'), v('g'))),
        setV(o[3], sub32(v('e'), v('hh'))),
    ].join('\n');
}

/**
 * Adds 32-bit residual lanes (already >> 6) to the `count` (4 or 8) bytes at `addr`, saturating to
 * 0-255.
 */
function addRow(addr, lo, hi) {
    const pixels = `(v128.load64_zero ${addr})`;
    const wide = setV('px', op('i16x8.extend_low_i8x16_u', pixels));
    const sum = hi
        ? op(
              'i16x8.narrow_i32x4_s',
              add32(op('i32x4.extend_low_i16x8_u', v('px')), lo),
              add32(op('i32x4.extend_high_i16x8_u', v('px')), hi),
          )
        : op('i16x8.narrow_i32x4_s', add32(op('i32x4.extend_low_i16x8_u', v('px')), lo), zero);
    const bytes = `(i8x16.narrow_i16x8_u ${sum} ${sum})`;
    return `${wide}\n${
        hi
            ? `(v128.store64_lane 0 ${addr} ${bytes})`
            : `(v128.store32_lane 0 ${addr}
      ${bytes})`
    }`;
}

function idct4Add() {
    return define('idct4_add', ['c', 'dst', 'stride'], () => {
        const rows = [0, 1, 2, 3]
            .map(k => setV(`r${k}`, `(v128.load offset=${k * 16} ${i('c')})`))
            .join('\n');
        const clear = [0, 1, 2, 3]
            .map(k => `(v128.store offset=${k * 16} ${i('c')} ${zero})`)
            .join('\n');
        const out = [0, 1, 2, 3]
            .map(k => addRow(add(i('dst'), mul(i('stride'), c32(k))), sar32(v(`y${k}`), 6)))
            .join('\n');
        return `${rows}
${clear}
${transpose4(['r0', 'r1', 'r2', 'r3'], ['c0', 'c1', 'c2', 'c3'])}
${idct4Pass(['c0', 'c1', 'c2', 'c3'], ['x0', 'x1', 'x2', 'x3'])}
${transpose4(['x0', 'x1', 'x2', 'x3'], ['d0', 'd1', 'd2', 'd3'])}
${setV('d0', add32(v('d0'), splat32(32)))}
${idct4Pass(['d0', 'd1', 'd2', 'd3'], ['y0', 'y1', 'y2', 'y3'])}
${out}`;
    });
}

/** The 8-point inverse transform (8-346 to 8-369) of d0..d7 into o0..o7. */
function idct8Pass(d, o) {
    const D = k => v(d[k]);
    return [
        setV('a0', add32(D(0), D(4))),
        setV('a4', sub32(D(0), D(4))),
        setV('a2', sub32(sar32(D(2), 1), D(6))),
        setV('a6', add32(D(2), sar32(D(6), 1))),
        setV('b0', add32(v('a0'), v('a6'))),
        setV('b2', add32(v('a4'), v('a2'))),
        setV('b4', sub32(v('a4'), v('a2'))),
        setV('b6', sub32(v('a0'), v('a6'))),
        setV('a1', sub32(sub32(sub32(D(5), D(3)), D(7)), sar32(D(7), 1))),
        setV('a3', sub32(sub32(add32(D(1), D(7)), D(3)), sar32(D(3), 1))),
        setV('a5', add32(add32(sub32(D(7), D(1)), D(5)), sar32(D(5), 1))),
        setV('a7', add32(add32(add32(D(3), D(5)), D(1)), sar32(D(1), 1))),
        setV('b1', add32(v('a1'), sar32(v('a7'), 2))),
        setV('b7', sub32(v('a7'), sar32(v('a1'), 2))),
        setV('b3', add32(v('a3'), sar32(v('a5'), 2))),
        setV('b5', sub32(sar32(v('a3'), 2), v('a5'))),
        setV(o[0], add32(v('b0'), v('b7'))),
        setV(o[1], add32(v('b2'), v('b5'))),
        setV(o[2], add32(v('b4'), v('b3'))),
        setV(o[3], add32(v('b6'), v('b1'))),
        setV(o[4], sub32(v('b6'), v('b1'))),
        setV(o[5], sub32(v('b4'), v('b3'))),
        setV(o[6], sub32(v('b2'), v('b5'))),
        setV(o[7], sub32(v('b0'), v('b7'))),
    ].join('\n');
}

/**
 * Transposes an 8x8 block of 32-bit lanes held as rows `a` (a[r][0] columns 0-3, a[r][1] columns
 * 4-7) into `b` with the same layout.
 */
function transpose8(a, b) {
    const parts = [];
    for (const [rowBase, colHalf] of [
        [0, 0],
        [0, 1],
        [4, 0],
        [4, 1],
    ]) {
        const source = [0, 1, 2, 3].map(k => a[rowBase + k][colHalf]);
        const target = [0, 1, 2, 3].map(k => b[colHalf * 4 + k][rowBase >> 2]);
        parts.push(transpose4(source, target));
    }
    return parts.join('\n');
}

function idct8Add() {
    return define('idct8_add', ['c', 'dst', 'stride'], () => {
        const names = prefix =>
            [0, 1, 2, 3, 4, 5, 6, 7].map(r => [`${prefix}${r}l`, `${prefix}${r}h`]);
        const rows = names('r');
        const cols = names('c');
        const xs = names('x');
        const ds = names('d');
        const ys = names('y');
        const load = rows
            .map(([lo, hi], r) =>
                [
                    setV(lo, `(v128.load offset=${r * 32} ${i('c')})`),
                    setV(hi, `(v128.load offset=${r * 32 + 16} ${i('c')})`),
                ].join('\n'),
            )
            .join('\n');
        const clear = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
            .map(k => `(v128.store offset=${k * 16} ${i('c')} ${zero})`)
            .join('\n');
        const pass = (input, output) =>
            [0, 1]
                .map(half =>
                    idct8Pass(
                        input.map(pair => pair[half]),
                        output.map(pair => pair[half]),
                    ),
                )
                .join('\n');
        const out = ys
            .map(([lo, hi], r) =>
                addRow(add(i('dst'), mul(i('stride'), c32(r))), sar32(v(lo), 6), sar32(v(hi), 6)),
            )
            .join('\n');
        return `${load}
${clear}
${transpose8(rows, cols)}
${pass(cols, xs)}
${transpose8(xs, ds)}
${setV('d0l', add32(v('d0l'), splat32(32)))}
${setV('d0h', add32(v('d0h'), splat32(32)))}
${pass(ds, ys)}
${out}`;
    });
}

/** Adds (dc + 32) >> 6 to a 4x4 or 8x8 block with saturation. */
function dcAdd() {
    return define('dc_add', ['dc', 'dst', 'stride', 'size'], () => {
        const loop = (label, saturating) => `(loop ${label}
            ${setV('row', `(v128.load64_zero ${i('dst')})`)}
            ${setV('row', op(saturating, v('row'), v('mag')))}
            (if (i32.eq ${i('size')} (i32.const 8))
                (then (v128.store64_lane 0 ${i('dst')} ${v('row')}))
                (else (v128.store32_lane 0 ${i('dst')} ${v('row')})))
            ${setI('dst', add(i('dst'), i('stride')))}
            (br_if ${label} (local.tee $size_left (i32.sub ${i('size_left')} (i32.const 1)))))`;
        return `${setI('value', `(i32.shr_s (i32.add ${i('dc')} (i32.const 32)) (i32.const 6))`)}
(if (i32.eqz ${i('value')}) (then (return)))
${setI('size_left', i('size'))}
(if (i32.gt_s ${i('value')} (i32.const 0))
    (then
        ${setV(
            'mag',
            op(
                'i8x16.splat',
                `(select (i32.const 255) ${i('value')} (i32.gt_s ${i('value')}
            (i32.const 255)))`,
            ),
        )}
        ${loop('$up', 'i8x16.add_sat_u')})
    (else
        ${setV(
            'mag',
            op(
                'i8x16.splat',
                `(select (i32.const 255) (i32.sub (i32.const 0) ${i('value')})
            (i32.lt_s ${i('value')} ` + '(i32.const -255)))',
            ),
        )}
        ${loop('$down', 'i8x16.sub_sat_u')}))`;
    });
}

// -------------------------------------------------------------------------------------------------
// Deblocking (8.7.2.3, 8.7.2.4)

const abs16 = (a, b) => op('i16x8.abs', op('i16x8.sub', a, b));
const lt16 = (a, b) => op('i16x8.lt_s', a, b);
const and = (...xs) => xs.reduce((acc, x) => op('v128.and', acc, x));
const select = (a, b, mask) => op('v128.bitselect', a, b, mask);
const add16 = (...xs) => xs.reduce((acc, x) => op('i16x8.add', acc, x));
const shl16 = (a, n) => op('i16x8.shl', a, c32(n));
const sar16 = (a, n) => op('i16x8.shr_s', a, c32(n));
const clamp16 = (x, lo, hi) => op('i16x8.max_s', op('i16x8.min_s', x, hi), lo);

/**
 * Luma filter of 8 lines whose samples p3..q3 are 16-bit lanes in locals p3..q3; `bsv` and `tcv`
 * hold bS and tC0 per lane, `alphav` and `betav` the thresholds. Leaves the filtered P2..Q2 in
 * locals np2..nq2.
 */
function lumaFilter() {
    return [
        setV(
            'mask',
            and(
                op('i16x8.ne', v('bsv'), zero),
                lt16(abs16(v('p0'), v('q0')), v('alphav')),
                lt16(abs16(v('p1'), v('p0')), v('betav')),
                lt16(abs16(v('q1'), v('q0')), v('betav')),
            ),
        ),
        setV('ap', lt16(abs16(v('p2'), v('p0')), v('betav'))),
        setV('aq', lt16(abs16(v('q2'), v('q0')), v('betav'))),
        // bS < 4 (8-469 to 8-476)
        setV('tc', op('i16x8.sub', op('i16x8.sub', v('tcv'), v('ap')), v('aq'))),
        setV('ntc', op('i16x8.neg', v('tc'))),
        setV(
            'delta',
            clamp16(
                sar16(
                    add16(
                        shl16(op('i16x8.sub', v('q0'), v('p0')), 2),
                        op('i16x8.sub', v('p1'), v('q1')),
                        splat16(4),
                    ),
                    3,
                ),
                v('ntc'),
                v('tc'),
            ),
        ),
        setV('avgpq', op('i16x8.avgr_u', v('p0'), v('q0'))),
        setV('ntc0', op('i16x8.neg', v('tcv'))),
        setV(
            'wp1',
            select(
                op(
                    'i16x8.add',
                    v('p1'),
                    clamp16(
                        sar16(
                            op(
                                'i16x8.sub',
                                op('i16x8.add', v('p2'), v('avgpq')),
                                shl16(v('p1'), 1),
                            ),
                            1,
                        ),
                        v('ntc0'),
                        v('tcv'),
                    ),
                ),
                v('p1'),
                v('ap'),
            ),
        ),
        setV(
            'wq1',
            select(
                op(
                    'i16x8.add',
                    v('q1'),
                    clamp16(
                        sar16(
                            op(
                                'i16x8.sub',
                                op('i16x8.add', v('q2'), v('avgpq')),
                                shl16(v('q1'), 1),
                            ),
                            1,
                        ),
                        v('ntc0'),
                        v('tcv'),
                    ),
                ),
                v('q1'),
                v('aq'),
            ),
        ),
        // bS == 4 (8-477 to 8-490)
        setV(
            'strong',
            lt16(abs16(v('p0'), v('q0')), op('i16x8.add', sar16(v('alphav'), 2), splat16(2))),
        ),
        setV('sp', op('v128.and', v('strong'), v('ap'))),
        setV('sq', op('v128.and', v('strong'), v('aq'))),
        setV('pq', add16(v('p0'), v('q0'))),
        setV(
            'sp0',
            select(
                sar16(add16(v('p2'), shl16(v('p1'), 1), shl16(v('pq'), 1), v('q1'), splat16(4)), 3),
                sar16(add16(shl16(v('p1'), 1), v('p0'), v('q1'), splat16(2)), 2),
                v('sp'),
            ),
        ),
        setV(
            'sp1',
            select(sar16(add16(v('p2'), v('p1'), v('pq'), splat16(2)), 2), v('p1'), v('sp')),
        ),
        setV(
            'sp2',
            select(
                sar16(
                    add16(
                        shl16(v('p3'), 1),
                        op('i16x8.mul', v('p2'), splat16(3)),
                        v('p1'),
                        v('pq'),
                        splat16(4),
                    ),
                    3,
                ),
                v('p2'),
                v('sp'),
            ),
        ),
        setV(
            'sq0',
            select(
                sar16(add16(v('q2'), shl16(v('q1'), 1), shl16(v('pq'), 1), v('p1'), splat16(4)), 3),
                sar16(add16(shl16(v('q1'), 1), v('q0'), v('p1'), splat16(2)), 2),
                v('sq'),
            ),
        ),
        setV(
            'sq1',
            select(sar16(add16(v('q2'), v('q1'), v('pq'), splat16(2)), 2), v('q1'), v('sq')),
        ),
        setV(
            'sq2',
            select(
                sar16(
                    add16(
                        shl16(v('q3'), 1),
                        op('i16x8.mul', v('q2'), splat16(3)),
                        v('q1'),
                        v('pq'),
                        splat16(4),
                    ),
                    3,
                ),
                v('q2'),
                v('sq'),
            ),
        ),
        setV('is4', op('i16x8.eq', v('bsv'), splat16(4))),
        setV(
            'np0',
            select(
                select(v('sp0'), op('i16x8.add', v('p0'), v('delta')), v('is4')),
                v('p0'),
                v('mask'),
            ),
        ),
        setV(
            'nq0',
            select(
                select(v('sq0'), op('i16x8.sub', v('q0'), v('delta')), v('is4')),
                v('q0'),
                v('mask'),
            ),
        ),
        setV('np1', select(select(v('sp1'), v('wp1'), v('is4')), v('p1'), v('mask'))),
        setV('nq1', select(select(v('sq1'), v('wq1'), v('is4')), v('q1'), v('mask'))),
        setV('np2', select(select(v('sp2'), v('p2'), v('is4')), v('p2'), v('mask'))),
        setV('nq2', select(select(v('sq2'), v('q2'), v('is4')), v('q2'), v('mask'))),
    ].join('\n');
}

const SAMPLES = ['p3', 'p2', 'p1', 'p0', 'q0', 'q1', 'q2', 'q3'];

/** Per-lane parameters for 16 lanes, one byte of `packed` per four lanes. */
const perFour = packed =>
    op(
        'i8x16.swizzle',
        op('i32x4.splat', packed),
        '(v128.const i8x16 0 0 0 0 1 1 1 1 2 2 2 2 3 3 3 3)',
    );

/**
 * Filters the 16 lines held as byte vectors in locals P3..Q3 (upper-case), leaving the results in
 * the same locals.
 */
function lumaSixteen() {
    const halves = [
        ['i16x8.extend_low_i8x16_u', 'lo'],
        ['i16x8.extend_high_i8x16_u', 'hi'],
    ];
    const parts = [
        setV('alphav', op('i16x8.splat', i('alpha'))),
        setV('betav', op('i16x8.splat', i('beta'))),
        setV('bs16', perFour(i('bs'))),
        setV('tc16', perFour(i('tc0'))),
    ];
    for (const [extend, suffix] of halves) {
        parts.push(setV('bsv', op(extend, v('bs16'))), setV('tcv', op(extend, v('tc16'))));
        for (const name of SAMPLES) parts.push(setV(name, op(extend, v(name.toUpperCase()))));
        parts.push(lumaFilter());
        for (const name of ['p2', 'p1', 'p0', 'q0', 'q1', 'q2'])
            parts.push(setV(`${name}${suffix}`, v(`n${name}`)));
    }
    for (const name of ['p2', 'p1', 'p0', 'q0', 'q1', 'q2'])
        parts.push(
            setV(name.toUpperCase(), op('i8x16.narrow_i16x8_u', v(`${name}lo`), v(`${name}hi`))),
        );
    return parts.join('\n');
}

function deblockLumaH() {
    return define('deblock_luma_h', ['q', 'step', 'alpha', 'beta', 'bs', 'tc0'], () => {
        const addr = k =>
            k >= 0 ? add(i('q'), mul(i('step'), c32(k))) : sub(i('q'), mul(i('step'), c32(-k)));
        const offsets = { p3: -4, p2: -3, p1: -2, p0: -1, q0: 0, q1: 1, q2: 2, q3: 3 };
        const load = SAMPLES.map(name =>
            setV(name.toUpperCase(), `(v128.load ${addr(offsets[name])})`),
        ).join('\n');
        const store = ['p2', 'p1', 'p0', 'q0', 'q1', 'q2']
            .map(name => `(v128.store ${addr(offsets[name])} ${v(name.toUpperCase())})`)
            .join('\n');
        return `${load}\n${lumaSixteen()}\n${store}`;
    });
}

/**
 * Byte-interleaving shuffles within each 64-bit half: `lo` takes the first half of each, `hi` the
 * second.
 */
function interleave(a, b, width, high) {
    const lanes = [];
    for (const base of [0, 8]) {
        const units = 8 / width;
        for (let k = 0; k < units / 2; k++) {
            const unit = (high ? units / 2 : 0) + k;
            for (let byte = 0; byte < width; byte++) lanes.push(base + unit * width + byte);
            for (let byte = 0; byte < width; byte++) lanes.push(16 + base + unit * width + byte);
        }
    }
    return `(i8x16.shuffle ${lanes.join(' ')} ${a} ${b})`;
}

/**
 * Transposes eight vectors of two 8x8 byte blocks (low and high 64-bit halves) held in locals
 * `from` into `to`: byte c of vector r in either half becomes byte r of vector c in the same half.
 */
function transposeBytes(from, to) {
    const parts = [];
    const level = (input, output, width) => {
        for (let k = 0; k < 4; k++) {
            const [a, b] = [input[2 * k], input[2 * k + 1]];
            parts.push(setV(output[2 * k], interleave(v(a), v(b), width, false)));
            parts.push(setV(output[2 * k + 1], interleave(v(a), v(b), width, true)));
        }
    };
    const l1 = [0, 1, 2, 3, 4, 5, 6, 7].map(k => `u${k}`);
    const l2 = [0, 1, 2, 3, 4, 5, 6, 7].map(k => `w${k}`);
    // Level 1 pairs rows (0,1), (2,3), ...; level 2 pairs the results (0,2), (1,3), ...; level 3
    // pairs (0,4), (1,5), ...
    level(from, l1, 1);
    level([l1[0], l1[2], l1[1], l1[3], l1[4], l1[6], l1[5], l1[7]], l2, 2);
    const reordered = [l2[0], l2[4], l2[1], l2[5], l2[2], l2[6], l2[3], l2[7]];
    const out = [];
    for (let k = 0; k < 4; k++) {
        const [a, b] = [reordered[2 * k], reordered[2 * k + 1]];
        out.push([a, b]);
    }
    for (let k = 0; k < 4; k++) {
        const [a, b] = out[k];
        parts.push(setV(to[2 * k], interleave(v(a), v(b), 4, false)));
        parts.push(setV(to[2 * k + 1], interleave(v(a), v(b), 4, true)));
    }
    return parts.join('\n');
}

function deblockLumaV() {
    return define('deblock_luma_v', ['q', 'stride', 'alpha', 'beta', 'bs', 'tc0'], () => {
        const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(k => `row${k}`);
        const load = rows
            .map((name, k) => {
                const top = add(sub(i('q'), c32(4)), mul(i('stride'), c32(k)));
                const bottom = add(sub(i('q'), c32(4)), mul(i('stride'), c32(k + 8)));
                return setV(name, `(v128.load64_lane 1 ${bottom} (v128.load64_zero ${top}))`);
            })
            .join('\n');
        const upper = SAMPLES.map(name => name.toUpperCase());
        const store = rows
            .map((name, k) => {
                const top = add(sub(i('q'), c32(4)), mul(i('stride'), c32(k)));
                const bottom = add(sub(i('q'), c32(4)), mul(i('stride'), c32(k + 8)));
                return (
                    `(v128.store64_lane 0 ${top} ${v(name)})\n(v128.store64_lane 1 ${bottom} ` +
                    `${v(name)})`
                );
            })
            .join('\n');
        return `${load}
${transposeBytes(rows, upper)}
${lumaSixteen()}
${transposeBytes(upper, rows)}
${store}`;
    });
}

/**
 * Chroma filter (chromaStyleFilteringFlag) of 8 lines in 16-bit locals p1..q1; results in np0, nq0.
 */
function chromaFilter() {
    return [
        setV('alphav', op('i16x8.splat', i('alpha'))),
        setV('betav', op('i16x8.splat', i('beta'))),
        setV(
            'bsv',
            op(
                'i16x8.extend_low_i8x16_u',
                op(
                    'i8x16.swizzle',
                    op('i32x4.splat', i('bs')),
                    '(v128.const i8x16 0 0 1 1 2 2 3 3 0 0 1 1 2 2 3 3)',
                ),
            ),
        ),
        setV(
            'tcv',
            op(
                'i16x8.extend_low_i8x16_u',
                op(
                    'i8x16.swizzle',
                    op('i32x4.splat', i('tc')),
                    '(v128.const i8x16 0 0 1 1 2 2 3 3 0 0 1 1 2 2 3 3)',
                ),
            ),
        ),
        setV(
            'mask',
            and(
                op('i16x8.ne', v('bsv'), zero),
                lt16(abs16(v('p0'), v('q0')), v('alphav')),
                lt16(abs16(v('p1'), v('p0')), v('betav')),
                lt16(abs16(v('q1'), v('q0')), v('betav')),
            ),
        ),
        setV(
            'delta',
            clamp16(
                sar16(
                    add16(
                        shl16(op('i16x8.sub', v('q0'), v('p0')), 2),
                        op('i16x8.sub', v('p1'), v('q1')),
                        splat16(4),
                    ),
                    3,
                ),
                op('i16x8.neg', v('tcv')),
                v('tcv'),
            ),
        ),
        setV('is4', op('i16x8.eq', v('bsv'), splat16(4))),
        setV(
            'np0',
            select(
                select(
                    sar16(add16(shl16(v('p1'), 1), v('p0'), v('q1'), splat16(2)), 2),
                    op('i16x8.add', v('p0'), v('delta')),
                    v('is4'),
                ),
                v('p0'),
                v('mask'),
            ),
        ),
        setV(
            'nq0',
            select(
                select(
                    sar16(add16(shl16(v('q1'), 1), v('q0'), v('p1'), splat16(2)), 2),
                    op('i16x8.sub', v('q0'), v('delta')),
                    v('is4'),
                ),
                v('q0'),
                v('mask'),
            ),
        ),
    ].join('\n');
}

function deblockChromaH() {
    return define('deblock_chroma_h', ['q', 'step', 'alpha', 'beta', 'bs', 'tc'], () => {
        const p0 = sub(i('q'), i('step'));
        return `${setV('p1', bytes8(sub(i('q'), mul(i('step'), c32(2)))))}
${setV('p0', bytes8(p0))}
${setV('q0', bytes8(i('q')))}
${setV('q1', bytes8(add(i('q'), i('step'))))}
${chromaFilter()}
(v128.store64_lane 0 ${p0} (i8x16.narrow_i16x8_u ${v('np0')} ${v('np0')}))
(v128.store64_lane 0 ${i('q')} (i8x16.narrow_i16x8_u ${v('nq0')} ${v('nq0')}))`;
    });
}

function deblockChromaV() {
    return define('deblock_chroma_v', ['q', 'stride', 'alpha', 'beta', 'bs', 'tc'], () => {
        const row = k => add(sub(i('q'), c32(2)), mul(i('stride'), c32(k)));
        let top = '(v128.const i32x4 0 0 0 0)';
        let bottom = top;
        for (let k = 0; k < 4; k++) top = `(v128.load32_lane ${k} ${row(k)} ${top})`;
        for (let k = 0; k < 4; k++) bottom = `(v128.load32_lane ${k} ${row(k + 4)} ${bottom})`;
        const gather = column =>
            op(
                'i16x8.extend_low_i8x16_u',
                `(i8x16.shuffle ${column} ${column + 4} ${column + 8} ${column + 12} ${column + 16}
                  ${column + 20} ${
                      column + 24
                  } ${column + 28} 0 0 0 0 0 0 0 0 ${v('top')} ${v('bottom')})`,
            );
        const pairs = `(i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (i8x16.narrow_i16x8_u
          ${v('np0')} ${v('np0')}) (i8x16.narrow_i16x8_u ${v('nq0')} ${v('nq0')}))`;
        const store = [0, 1, 2, 3, 4, 5, 6, 7]
            .map(
                k =>
                    `(v128.store16_lane ${k} ` +
                    `${add(sub(i('q'), c32(1)), mul(i('stride'), c32(k)))} ${v('pairs')})`,
            )
            .join('\n');
        return `${setV('top', top)}
${setV('bottom', bottom)}
${setV('p1', gather(0))}
${setV('p0', gather(1))}
${setV('q0', gather(2))}
${setV('q1', gather(3))}
${chromaFilter()}
${setV('pairs', pairs)}
${store}`;
    });
}

/** The module text. */
export function h264KernelsWat() {
    const functions = [
        copyBlock(),
        lumaHorizontal('put_h', false),
        lumaHorizontal('avg_h', true),
        lumaVertical('put_v', false),
        lumaVertical('avg_v', true),
        lumaCentre('put_j', false),
        lumaCentre('avg_j', true),
        lumaFullAverage('avg_full'),
        mcLuma(),
        mcChroma(),
        average(),
        weight2(),
        weight1(),
        idct4Add(),
        idct8Add(),
        dcAdd(),
        deblockLumaH(),
        deblockLumaV(),
        deblockChromaH(),
        deblockChromaV(),
    ];
    const { addresses, segments } = tableLayout();
    const source = ['h264-deblock.mjs', 'h264-cabac.mjs', 'h264-inter.mjs']
        .map(file => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
        .join('\n');
    const kernels = [
        'mc_luma',
        'mc_chroma',
        'avg',
        'weight2',
        'weight1',
        'idct4_add',
        'idct8_add',
        'dc_add',
    ];
    const scalar = compileScalar(source, {
        exported: ['deblock_row', 'residual_mb', 'inter_mb'],
        constants: {
            ...SCALAR_CONSTANTS,
            ...SCRATCH_LAYOUT,
            ...SLICE_LAYOUT,
            ...INTER_RESULTS,
            ...addresses,
        },
        externs: {
            deblock_luma_h: 0,
            deblock_luma_v: 0,
            deblock_chroma_h: 0,
            deblock_chroma_v: 0,
            wait_rows: 0,
            ...Object.fromEntries(kernels.map(name => [name, 0])),
        },
    });
    const imports =
        '(import "env" "memory" (memory 1))\n(import "env" "wait_rows" (func $wait_rows (param ' +
        'i32 i32 i32)))';
    return `(module\n${imports}\n${[...functions, ...scalar, ...segments].join('\n')}\n)`;
}

/** The assembled module. */
export function h264Kernels() {
    return assembleWat(h264KernelsWat());
}
