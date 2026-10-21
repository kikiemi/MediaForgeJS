import { H264_KERNELS_BASE64 } from './kernels-binary';
import { inflateBase64 } from '../../core/bytes/inflate-raw';

/**
 * Exports of the WebAssembly SIMD kernels (scripts/h264-kernels.mjs). Addresses are byte offsets
 * into the kernel memory; each kernel gives the same samples as the JavaScript kernel it stands
 * for.
 */
export interface H264Kernels {
    mc_luma(
        src: number,
        srcStride: number,
        dst: number,
        dstStride: number,
        w: number,
        h: number,
        mode: number,
    ): void;
    mc_chroma(
        src: number,
        srcStride: number,
        dst: number,
        dstStride: number,
        w: number,
        h: number,
        fx: number,
        fy: number,
    ): void;
    avg(
        a: number,
        aStride: number,
        b: number,
        bStride: number,
        dst: number,
        dstStride: number,
        w: number,
        h: number,
    ): void;
    weight2(
        a: number,
        aStride: number,
        b: number,
        bStride: number,
        dst: number,
        dstStride: number,
        w: number,
        h: number,
        w0: number,
        w1: number,
        offset: number,
        logWD: number,
    ): void;
    weight1(
        a: number,
        aStride: number,
        dst: number,
        dstStride: number,
        w: number,
        h: number,
        weight: number,
        offset: number,
        logWD: number,
    ): void;
    idct4_add(coeffs: number, dst: number, stride: number): void;
    idct8_add(coeffs: number, dst: number, stride: number): void;
    dc_add(dc: number, dst: number, stride: number, size: number): void;
    deblock_luma_h(
        q0: number,
        step: number,
        alpha: number,
        beta: number,
        bs: number,
        tc0: number,
    ): void;
    deblock_luma_v(
        q0: number,
        stride: number,
        alpha: number,
        beta: number,
        bs: number,
        tc0: number,
    ): void;
    deblock_chroma_h(
        q0: number,
        step: number,
        alpha: number,
        beta: number,
        bs: number,
        tc: number,
    ): void;
    deblock_chroma_v(
        q0: number,
        stride: number,
        alpha: number,
        beta: number,
        bs: number,
        tc: number,
    ): void;
    /**
     * Filters frame macroblock row `y` of a picture without MBAFF (a frame, or with `field` one
     * field's rows), 4:2:0 with `chroma` or monochrome: samples at `luma`, `cb`, `cr`, then the
     * picture's per-macroblock arrays.
     */
    deblock_row(
        luma: number,
        cb: number,
        cr: number,
        lumaStride: number,
        chromaStride: number,
        mbWidth: number,
        y: number,
        field: number,
        chroma: number,
        flags: number,
        sliceNum: number,
        filterParams: number,
        nzMask: number,
        qp: number,
        motionClass: number,
        refId0: number,
        refId1: number,
        mv0: number,
        mv1: number,
    ): void;
    /**
     * Decodes macroblock (x, y) of a CABAC P or B slice without MBAFF (4:2:0 or monochrome)
     * described by the slice block, from the engine state in the scratch block: MB_DONE,
     * MB_SKIPPED, MB_INTRA_P (3 in a B slice) after the mb_type prefix of an intra macroblock, or
     * an ERROR_*.
     */
    inter_mb(scratch: number, x: number, y: number): number;
    /**
     * CABAC residual of a macroblock from the engine, contexts and RBSP in the scratch block at
     * `scratch`: `flags` has bit 0 Intra16x16, bit 1 intra, bit 2 the 8x8 transform, bit 3 a field
     * macroblock; `dcContexts` the DC coded_block_flag ctxIdxInc of luma, Cb and Cr in bits 0-3,
     * 4-7, 8-11. Returns the DC flags.
     */
    residual_mb(
        scratch: number,
        cbp: number,
        flags: number,
        qp: number,
        chromaQp0: number,
        chromaQp1: number,
        dcContexts: number,
        chromaBlocks: number,
    ): number;
}

/**
 * Kernel memory as one decoding thread sees it: the kernels bound to it, and the scratch block of
 * that thread laid out at the SCRATCH_* offsets (SCRATCH_LAYOUT in scripts/h264-kernels.mjs): 512
 * coefficients, two 16x16 prediction blocks, the emulated-edge block, 32 DC coefficients, the
 * coefficient-count cache, the CABAC engine and contexts, the dequantisation tables and the RBSP of
 * the slice.
 */
export interface KernelMemory {
    readonly kernels: H264Kernels;
    readonly buffer: ArrayBufferLike;
    /** The whole memory as bytes, current after growth. */
    readonly bytes: Uint8Array;
    readonly scratch: number;
}

/** Bytes at the start of every kernel memory holding the kernels' constant tables. */
const TABLE_BYTES = 4096;
export const SCRATCH_COEFFS = 0;
export const COEFF_COUNT = 512;
export const SCRATCH_PRED_A = 2048;
export const SCRATCH_PRED_B = 2560;
export const PRED_BYTES = 256;
export const SCRATCH_EDGE = 3072;
export const SCRATCH_DC = 4096;
export const SCRATCH_NNZ = 4224;

/** CABAC engine: range, value, pos, bitsNeeded and end as 32-bit words. */
export const SCRATCH_CABAC = 4352;
export const SCRATCH_CONTEXTS = 4384;

/**
 * Macroblock caches: intra modes (40), direct flags (40), references (2 x 40), vectors (2 x 80
 * 16-bit), mvds (2 x 80).
 */
export const SCRATCH_INTRA_CACHE = 5504;
export const SCRATCH_DIRECT_CACHE = 5552;
export const SCRATCH_REF_CACHE = 5600;
export const REF_CACHE_BYTES = 48;
export const SCRATCH_MV_CACHE = 5696;
export const MV_CACHE_BYTES = 160;
export const SCRATCH_MVD_CACHE = 6016;
export const MVD_CACHE_BYTES = 80;

/** The slice block of inter_mb, laid out as SLICE_BLOCK. */
export const SCRATCH_SLICE = 6208;
export const SCRATCH_DEQUANT4 = 12864;

/** 4x4 lists of dequant4 for the 52 QPs, then the two 8x8 lists of dequant8. */
export const DEQUANT4_BYTES = 52 * 16 * 4;
export const SCRATCH_DEQUANT8 = SCRATCH_DEQUANT4 + 6 * DEQUANT4_BYTES;
const DEQUANT8_BYTES = 52 * 64 * 4;
export const SCRATCH_BITS = SCRATCH_DEQUANT8 + 2 * DEQUANT8_BYTES;

/**
 * Byte offsets in the slice block (SLICE_LAYOUT in scripts/h264-kernels.mjs): slice parameters and
 * the addresses of the current picture's arrays (S_*), the macroblock being decoded (M_*), the
 * reference entries (E_* within each of ENTRY_BYTES), the explicit weights (six 16-bit values per
 * reference), the implicit weights (bytes), DistScaleFactor per list 0 index and the DC LevelScale
 * of each 4x4 scaling list by QP % 6.
 */
export const SLICE_BLOCK = {
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
} as const;

/**
 * Results of inter_mb: decoded, skipped, an intra macroblock of a P slice (3: of a B slice) after
 * its mb_type prefix, errors.
 */
export const MB_DONE = 0;
export const MB_SKIPPED = 1;
export const MB_INTRA_P = 2;
export const ERROR_REF_IDX = -1;
export const ERROR_QP_DELTA = -2;

/**
 * RBSP bytes a slice may have for the kernels; larger slices decode their residual in JavaScript.
 */
export const BITS_BYTES = 1 << 20;
export const SCRATCH_BYTES = SCRATCH_BITS + BITS_BYTES;

const PAGE_BYTES = 65536;

/**
 * Kernels read up to 16 bytes past the last sample they use; every block keeps this much after it.
 */
const SLACK_BYTES = 64;

/** Pages a shared memory may grow to (2 GiB): shared memories reserve their maximum up front. */
const SHARED_MAXIMUM_PAGES = 32768;

/**
 * Compiled kernels without and with a shared memory import: undefined until the first attempt, null
 * when the host lacks WebAssembly SIMD (or shared memory) or the build carries no kernels.
 */
const compiled: [WebAssembly.Module | null | undefined, WebAssembly.Module | null | undefined] = [
    undefined,
    undefined,
];
const compiling: [
    Promise<WebAssembly.Module | null> | null,
    Promise<WebAssembly.Module | null> | null,
] = [null, null];
let enabled = true;

/** The kernel module's bytes, inflated on first use; null where they are unusable. */
let kernelData: Uint8Array<ArrayBuffer> | null | undefined;

function kernelBytes(): Uint8Array<ArrayBuffer> | null {
    if (kernelData !== undefined) return kernelData;
    if (!H264_KERNELS_BASE64 || typeof WebAssembly !== 'object' || typeof atob !== 'function')
        return (kernelData = null);
    try {
        const bytes = inflateBase64(H264_KERNELS_BASE64);
        return (kernelData = WebAssembly.validate(bytes) ? bytes : null);
    } catch {
        return (kernelData = null);
    }
}

/**
 * The kernel module with its memory import declared shared, which threads need: in the import
 * section (id 2, after the type section) the import `env.memory` of limits {min 1} gets {min 1,
 * max, shared}.
 */
function sharedVariant(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
    // Sections start after the 8-byte header; the type section's size is one LEB128 value.
    let at = 8;
    if (bytes[at] !== 1) return null;
    let size = 0;
    let shift = 0;
    for (at++; bytes[at] & 0x80; at++, shift += 7) size |= (bytes[at] & 0x7f) << shift;
    size |= bytes[at++] << shift;
    at += size;

    // The import section is small enough for a one-byte size before and after the change.
    if (bytes[at] !== 2 || bytes[at + 1] & 0x80) return null;
    const entry = [3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 0, 1];
    const end = at + 2 + bytes[at + 1];
    let found = -1;
    for (let i = at + 2; i + entry.length <= end && found < 0; i++) {
        if (entry.every((value, k) => bytes[i + k] === value)) found = i;
    }
    if (found < 0) return null;
    const limits = [
        3,
        1,
        (SHARED_MAXIMUM_PAGES & 0x7f) | 0x80,
        ((SHARED_MAXIMUM_PAGES >> 7) & 0x7f) | 0x80,
        SHARED_MAXIMUM_PAGES >> 14,
    ];
    const grown = limits.length - 2;
    if (bytes[at + 1] + grown > 127) return null;
    const out = new Uint8Array(bytes.length + grown);
    out.set(bytes.subarray(0, found + entry.length - 2));
    out[at + 1] = bytes[at + 1] + grown;
    out.set(limits, found + entry.length - 2);
    out.set(bytes.subarray(found + entry.length), found + entry.length - 2 + limits.length);
    return WebAssembly.validate(out) ? out : null;
}

/** Receives the kernels' wait_rows calls on this thread (list, reference index, macroblock row). */
let rowWaiter: ((list: number, ref: number, row: number) => void) | null = null;

/** Sets the function waiting for reference rows while the kernels decode on this thread. */
export function setRowWaiter(
    waiter: ((list: number, ref: number, row: number) => void) | null,
): void {
    rowWaiter = waiter;
}

/** The imports of a kernel instance on `memory`. */
export function kernelImports(memory: WebAssembly.Memory): WebAssembly.Imports {
    return {
        env: {
            memory,
            wait_rows: (list: number, ref: number, row: number) => rowWaiter!(list, ref, row),
        },
    };
}

function moduleBytes(shared: boolean): Uint8Array<ArrayBuffer> | null {
    const bytes = kernelBytes();
    return bytes && shared ? sharedVariant(bytes) : bytes;
}

/**
 * The kernel module, compiled once and asynchronously: browsers refuse synchronous compilation of
 * larger modules.
 */
function compileKernels(shared: boolean): Promise<WebAssembly.Module | null> {
    const index = shared ? 1 : 0;
    const known = compiled[index];
    if (known !== undefined) return Promise.resolve(known);
    compiling[index] ??= (async () => {
        const bytes = moduleBytes(shared);
        try {
            compiled[index] = bytes ? await WebAssembly.compile(bytes) : null;
        } catch {
            compiled[index] = null;
        }
        return compiled[index]!;
    })();
    return compiling[index]!;
}

/**
 * The kernel module compiled on this thread now, or null (and retryable asynchronously) where that
 * is refused.
 */
export function kernelModule(shared: boolean): WebAssembly.Module | null {
    const index = shared ? 1 : 0;
    const known = compiled[index];
    if (known !== undefined) return known;
    const bytes = moduleBytes(shared);
    if (!bytes) return (compiled[index] = null);
    try {
        return (compiled[index] = new WebAssembly.Module(bytes));
    } catch {
        // A host may refuse synchronous compilation on its main thread: stay retryable
        // asynchronously.
        return null;
    }
}

/**
 * Selects the WebAssembly SIMD kernels (the default where the host supports them) or the JavaScript
 * kernels for decoders created afterwards; both decode the same samples.
 */
export function setH264KernelsEnabled(enable: boolean): void {
    enabled = enable;
}

/**
 * The kernel memory of one decoder: the kernels' tables, the main thread's scratch, then blocks
 * allocated upwards. A memory that is not shared replaces its buffer when it grows, so the owner
 * re-creates its views whenever `generation` changes; a shared memory keeps every view valid for
 * the bytes it covers.
 */
export class KernelArena implements KernelMemory {
    readonly scratch = TABLE_BYTES;
    private top = TABLE_BYTES + SCRATCH_BYTES;
    /** The highest `top` so far: no byte above it was written. */
    private reached = this.top;
    private view: Uint8Array;
    /**
     * Counts the growths; views of a memory that is not shared made before the latest one are
     * detached.
     */
    generation = 0;

    constructor(
        readonly memory: WebAssembly.Memory,
        readonly kernels: H264Kernels,
        readonly shared: boolean,
    ) {
        this.view = new Uint8Array(memory.buffer);
    }

    get buffer(): ArrayBufferLike {
        return this.memory.buffer;
    }

    get bytes(): Uint8Array {
        if (this.view.buffer !== this.memory.buffer) this.view = new Uint8Array(this.memory.buffer);
        return this.view;
    }

    /**
     * Reserves `size` bytes (64-byte aligned, followed by slack) and returns their address; they
     * read as zero.
     */
    allocate(size: number): number {
        const base = this.top;
        this.top += ((size + 63) & ~63) + SLACK_BYTES;
        this.reached = Math.max(this.reached, this.top);
        const missing = this.top - this.memory.buffer.byteLength;
        if (missing > 0) {
            this.memory.grow(Math.ceil(missing / PAGE_BYTES));
            this.generation++;
        }
        this.bytes.fill(0, base, base + size);
        return base;
    }

    /**
     * Releases every allocation and zeroes the scratch and what they held, as in a new memory of
     * this size.
     */
    clear(): void {
        this.bytes.fill(0, this.scratch, this.reached);
        this.top = this.reached = TABLE_BYTES + SCRATCH_BYTES;
    }

    /** Releases the allocations made after `mark` (a value of `top` taken before them). */
    releaseTo(mark: number): void {
        this.top = mark;
    }

    get mark(): number {
        return this.top;
    }
}

/** A kernel memory holding the tables and the main thread's scratch block. */
function newMemory(shared: boolean): WebAssembly.Memory {
    const initial = Math.ceil((TABLE_BYTES + SCRATCH_BYTES) / PAGE_BYTES);
    return new WebAssembly.Memory(
        shared ? { initial, maximum: SHARED_MAXIMUM_PAGES, shared: true } : { initial },
    );
}

/**
 * A kernel memory with instantiated kernels, shared between threads with `shared`; null to decode
 * with the JavaScript kernels (or, with `shared`, where memory cannot be shared). Compiled and
 * instantiated asynchronously, without the size limits some hosts put on synchronous compilation.
 */
export async function createKernelArena(shared: boolean): Promise<KernelArena | null> {
    if (!enabled || (shared && typeof SharedArrayBuffer !== 'function')) return null;
    const module = await compileKernels(shared);
    if (!module) return null;
    try {
        const memory = newMemory(shared);
        const instance = await WebAssembly.instantiate(module, kernelImports(memory));
        return new KernelArena(memory, instance.exports as unknown as H264Kernels, shared);
    } catch {
        return null;
    }
}
