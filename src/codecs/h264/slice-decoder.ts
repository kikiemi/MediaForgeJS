import type { BitReader } from './bit-reader';
import { Cabac } from './cabac';
import {
    type DeblockInput,
    deblockRowCount,
    deblockRows,
    MOTION_16X8,
    MOTION_4X4,
    MOTION_8X16,
    MOTION_8X8,
    MOTION_UNIFORM,
} from './deblock';
import { coeffTokenTable, readResidualCavlc } from './cavlc';
import {
    AVAIL_A,
    AVAIL_A_LOW,
    AVAIL_B,
    AVAIL_C,
    AVAIL_D,
    predIntra16x16,
    predIntra4x4,
    predIntra8x8,
    predIntraChroma,
} from './intra-pred';
import {
    blendsInLanes,
    MotionCompensator,
    putAverage,
    putBiWeighted,
    putBlendWords,
    putWeighted,
} from './inter-pred';
import {
    COEFF_COUNT,
    type H264Kernels,
    type KernelMemory,
    BITS_BYTES,
    DEQUANT4_BYTES,
    ERROR_QP_DELTA,
    ERROR_REF_IDX,
    MB_DONE,
    MB_INTRA_P,
    MB_SKIPPED,
    SCRATCH_SLICE,
    setRowWaiter,
    SLICE_BLOCK,
    PRED_BYTES,
    SCRATCH_BITS,
    SCRATCH_CABAC,
    SCRATCH_COEFFS,
    SCRATCH_CONTEXTS,
    SCRATCH_DC,
    SCRATCH_DEQUANT4,
    SCRATCH_DEQUANT8,
    SCRATCH_DIRECT_CACHE,
    SCRATCH_INTRA_CACHE,
    SCRATCH_MV_CACHE,
    SCRATCH_MVD_CACHE,
    SCRATCH_NNZ,
    SCRATCH_REF_CACHE,
    MV_CACHE_BYTES,
    MVD_CACHE_BYTES,
    REF_CACHE_BYTES,
    SCRATCH_PRED_A,
    SCRATCH_PRED_B,
} from './kernels';
import {
    filterParams,
    MB_DECODED,
    MB_DIRECT16,
    MB_FIELD,
    MB_INTRA,
    MB_INTRA16,
    MB_PCM,
    MB_SKIP,
    MB_T8X8,
    type Picture,
    type RefEntry,
} from './picture';
import { type ScalingTables, type SliceContext, UNIT_SCALE } from './slice-context';
import {
    BLOCK_X,
    BLOCK_Y,
    CBP_INTER,
    CBP_INTER_MONO,
    CBP_INTRA,
    CBP_INTRA_MONO,
    CHROMA_QP,
    FIELD_4X4,
    FIELD_8X8,
    PICT_BOTTOM,
    PICT_FRAME,
    PICT_TOP,
    RASTER_TO_BLOCK,
    SLICE_B,
    SLICE_I,
    SLICE_P,
    SLICE_SI,
    SLICE_SP,
    ZIGZAG_4X4,
} from './tables';
import { ZIGZAG_8X8 } from '../shared/dct-scan';
import {
    chromaDcTransform420,
    chromaDcTransform422,
    dc4x4Add,
    dc8x8Add,
    idct4x4Add,
    idct8x8Add,
    lumaDcTransform,
} from './transform';

/** Reference index cache markers. */
const PART_NOT_AVAILABLE = -2;
const LIST_NOT_USED = -1;

/** Partition shapes. */
const SHAPE_16X16 = 0;
const SHAPE_16X8 = 1;
const SHAPE_8X16 = 2;
const SHAPE_8X8 = 3;

/** Sub-macroblock shapes. */
const SUB_8X8 = 0;
const SUB_8X4 = 1;
const SUB_4X8 = 2;
const SUB_4X4 = 3;

/** Bits of the per-partition prediction flags: bit 0 list 0, bit 1 list 1. */
const PRED_L0 = 1;

/**
 * B macroblock partition prediction flags (Table 7-14) indexed by mb_type 1..22: partition 0,
 * partition 1 and shape.
 */
const B_PARTITION_PRED = new Uint8Array([
    0, 0, 1, 0, 2, 0, 3, 0, 1, 1, 1, 1, 2, 2, 2, 2, 1, 2, 1, 2, 2, 1, 2, 1, 1, 3, 1, 3, 2, 3, 2, 3,
    3, 1, 3, 1, 3, 2, 3, 2, 3, 3, 3, 3, 3, 3,
]);
const B_PARTITION_SHAPE = new Uint8Array([
    0, 0, 0, 0, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 3,
]);

/** B sub-macroblock types (Table 7-18): prediction flags and shape, index 1..12. */
const B_SUB_PRED = new Uint8Array([0, 1, 2, 3, 1, 1, 2, 2, 3, 3, 1, 2, 3]);
const B_SUB_SHAPE = new Uint8Array([0, 0, 0, 0, 1, 2, 1, 2, 1, 2, 3, 3, 3]);

/** Coded block category context bases (Table 9-34 / 9.3.3.1.3). */
const CBF_BASE = [85, 89, 93, 97, 101, 1012];
const SIG_BASE = [
    [105, 120, 134, 149, 152, 402],
    [277, 292, 306, 321, 324, 436],
];
const LAST_BASE = [
    [166, 181, 195, 210, 213, 417],
    [338, 353, 367, 382, 385, 451],
];
const ABS_BASE = [227, 237, 247, 257, 266, 426];
const SIG_8X8 = [
    new Uint8Array([
        0, 1, 2, 3, 4, 5, 5, 4, 4, 3, 3, 4, 4, 4, 5, 5, 4, 4, 4, 4, 3, 3, 6, 7, 7, 7, 8, 9, 10, 9,
        8, 7, 7, 6, 11, 12, 13, 11, 6, 7, 8, 9, 14, 10, 9, 8, 6, 11, 12, 13, 11, 6, 9, 14, 10, 9,
        11, 12, 13, 11, 14, 10, 12,
    ]),
    new Uint8Array([
        0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 7, 7, 8, 4, 5, 6, 9, 10, 10, 8, 11, 12, 11, 9, 9, 10, 10,
        8, 11, 12, 11, 9, 9, 10, 10, 8, 11, 12, 11, 9, 9, 10, 10, 8, 13, 13, 9, 9, 10, 10, 8, 13,
        13, 9, 9, 10, 10, 14, 14, 14, 14, 14,
    ]),
];
const LAST_8X8 = new Uint8Array([
    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8,
]);
const CAT_I16_DC = 0;
const CAT_I16_AC = 1;
const CAT_LUMA_4X4 = 2;
const CAT_CHROMA_DC = 3;
const CAT_CHROMA_AC = 4;
const CAT_LUMA_8X8 = 5;

/** Cache index of the 4x4 block at (x, y) in 4x4 units, -1 <= x <= 4, -1 <= y <= 3. */
function cacheAt(x: number, y: number): number {
    return (y + 1) * 8 + 4 + x;
}

/**
 * Interleaved 4x4 scans of the 8x8 CAVLC coefficient groups: raster position of coefficient i of
 * group g.
 */
const SCAN_8X8_CAVLC: Uint8Array[][] = [ZIGZAG_8X8, FIELD_8X8].map(scan =>
    [0, 1, 2, 3].map(group => {
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = scan[4 * i + group];
        return out;
    }),
);

/** Raster 4x4 block index of blkIdx (z-order). */
const BLOCK_RASTER = new Uint8Array(16);
for (let i = 0; i < 16; i++) BLOCK_RASTER[i] = BLOCK_Y[i] * 4 + BLOCK_X[i];

const CHROMA_BLOCK_X = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]);
const CHROMA_BLOCK_Y = new Uint8Array([0, 0, 1, 1, 2, 2, 3, 3]);

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Slot of a raster 4x4 block in the stored mvd pairs of a macroblock: bottom row 0..3, right column
 * 4..6.
 */
const MVD_SLOT = new Uint8Array([7, 7, 7, 4, 7, 7, 7, 5, 7, 7, 7, 6, 0, 1, 2, 3]);

/** A motion vector as the 32-bit word of its two 16-bit components in memory order (x first). */
function packMv(x: number, y: number): number {
    return LITTLE_ENDIAN ? (x & 0xffff) | (y << 16) : (x << 16) | (y & 0xffff);
}

/** Two bytes as the 16-bit word of their memory order (x first). */
function packPair(x: number, y: number): number {
    return LITTLE_ENDIAN ? x | (y << 8) : (x << 8) | y;
}

/** Clips a motion vector component to the range storable in 16 bits. */
function clipMv(v: number): number {
    return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function median(a: number, b: number, c: number): number {
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

interface SliceResult {
    /** Macroblocks decoded in this slice (0 when none could be). */
    readonly decoded: number;
    /** Set when the slice ended early on damaged data. */
    readonly error: string | null;
}

/**
 * Macroblock layer decoder for one picture at a time. Per-macroblock arrays cover the current
 * picture in frame macroblock coordinates; field pictures and MBAFF pairs interleave their
 * macroblocks by row parity.
 */
export class SliceDecoder {
    mbWidth = 0;
    mbHeight = 0;
    mbCount = 0;
    chromaFormat = 1;
    /** Chroma block height in samples per macroblock (8 or 16) and 4x4 blocks per chroma plane. */
    private chromaMbHeight = 8;
    private chromaBlocks = 4;
    private lumaStride = 0;
    private chromaStride = 0;
    private lumaData: Uint8Array = new Uint8Array(0);
    /** `lumaData` saturating stores to 0-255. */
    private clamped: Uint8ClampedArray = new Uint8ClampedArray(0);
    /** `lumaData` as 32-bit words. */
    private lumaWords: Uint32Array = new Uint32Array(0);
    private chromaBase = 0;
    private crBase = 0;

    /**
     * The current picture's macroblock QP, slice index, filter parameters, coded blocks and motion
     * classes.
     */
    qp: Uint8Array = new Uint8Array(0);
    sliceNum: Int32Array = new Int32Array(0);
    private filterParams: Int32Array = new Int32Array(0);
    nzMask: Uint16Array = new Uint16Array(0);
    motionClass: Uint8Array = new Uint8Array(0);
    /** The current picture's macroblock state (Picture.cbp and the arrays after it). */
    private cbp: Uint8Array = new Uint8Array(0);
    private dcFlags: Uint8Array = new Uint8Array(0);
    private chromaMode: Uint8Array = new Uint8Array(0);
    private intraModes: Int8Array = new Int8Array(0);
    private nnz: Uint8Array = new Uint8Array(0);
    private mvd: readonly [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
    /** `mvd` with one (x, y) pair per element, `nnz` as 16-bit and 32-bit words. */
    private mvd16: [Uint16Array, Uint16Array] = [new Uint16Array(0), new Uint16Array(0)];
    private nnz16: Uint16Array = new Uint16Array(0);
    private nnz32: Uint32Array = new Uint32Array(0);
    private directMask: Uint8Array = new Uint8Array(0);
    /** Filter input of the picture or field being decoded, and the rows it has filtered so far. */
    private deblock: DeblockInput | null = null;
    private deblockedRows = 0;
    /** Macroblocks decoded in a row from the first, in raster order. */
    private decodedPrefix = 0;
    /**
     * Set while other threads decode the references: returns once macroblock row `row` of `picture`
     * is final (every row for a row past the last).
     */
    refWait: ((picture: Picture, row: number) => void) | null = null;
    /**
     * Set for a frame picture other threads read: receives the count of leading macroblock rows now
     * final.
     */
    onRows: ((rows: number) => void) | null = null;

    private readonly cabac = new Cabac();
    private readonly mc = new MotionCompensator();
    /**
     * WebAssembly kernels and their memory, which then holds the coefficients, predictions and
     * pictures.
     */
    private memory: KernelMemory | null = null;
    private kernels: H264Kernels | null = null;
    /** Addresses of this thread's coefficients and prediction blocks in the kernel memory. */
    private coeffAddress = 0;
    private predAAddress = 0;
    private predBAddress = 0;
    /** Address of the current picture's samples in the kernel memory. */
    private picBase = 0;
    private coeffs: Int32Array = new Int32Array(COEFF_COUNT);
    private dcCoeffs: Int32Array = new Int32Array(16 + 2 * 8);
    private predAWords: Uint32Array = new Uint32Array(PRED_BYTES / 4);
    private predBWords: Uint32Array = new Uint32Array(PRED_BYTES / 4);
    private predA: Uint8Array = new Uint8Array(this.predAWords.buffer);
    private predB: Uint8Array = new Uint8Array(this.predBWords.buffer);

    private nnzCache: Uint8Array = new Uint8Array(120);
    private nnzCache16: Uint16Array = new Uint16Array(this.nnzCache.buffer);
    private nnzCache32: Uint32Array = new Uint32Array(this.nnzCache.buffer);
    /**
     * The kernels' CABAC engine block, and the RBSP of the slice copied to kernel memory (CABAC
     * slices it fits).
     */
    private engine: Int32Array = new Int32Array(8);
    private bits: Uint8Array = new Uint8Array(0);
    /**
     * The bytes the CABAC engine reads, and whether the kernels decode the residuals of the slice.
     */
    private cabacData: Uint8Array = new Uint8Array(0);
    private kernelResidual = false;
    /** Scaling tables last copied to kernel memory. */
    private kernelScaling: ScalingTables | null = null;
    /** The kernels' slice block (inter_mb) as 32-bit, 16-bit and 8-bit values. */
    private sliceWords: Int32Array = new Int32Array(0);
    private sliceHalves: Int16Array = new Int16Array(0);
    private sliceBytes: Int8Array = new Int8Array(0);
    /** Whether the kernels decode the inter macroblocks of the slice (inter_mb). */
    private kernelInter = false;
    /** Macroblock caches (in the scratch block with the kernels). */
    private intraCache: Int8Array = new Int8Array(40);
    private refCache: [Int8Array, Int8Array] = [new Int8Array(40), new Int8Array(40)];
    private mvCache: [Int16Array, Int16Array] = [new Int16Array(80), new Int16Array(80)];
    /** `mvCache` with one (x, y) vector per element. */
    private mvCache32 = this.mvCache.map(cache => new Int32Array(cache.buffer)) as [
        Int32Array,
        Int32Array,
    ];
    private mvdCache: [Uint8Array, Uint8Array] = [new Uint8Array(80), new Uint8Array(80)];
    /** `mvdCache` with one (x, y) pair of absolute differences per element. */
    private mvdCache16 = this.mvdCache.map(cache => new Uint16Array(cache.buffer)) as [
        Uint16Array,
        Uint16Array,
    ];
    private directCache: Uint8Array = new Uint8Array(40);
    private readonly subShape = new Uint8Array(4);
    private readonly subPred = new Uint8Array(4);
    private readonly partPred = new Uint8Array(4);
    private readonly refIdxParsed = new Int8Array(8);
    private readonly mvTmp = new Int32Array(2);
    private readonly leftBlock = new Uint8Array(4);
    private readonly leftMb = new Int32Array(2);

    private ctx!: SliceContext;
    private picture!: Picture;
    private br!: BitReader;
    private cabacMode = false;
    private sliceType = SLICE_I;
    private mbaff = false;
    private fieldPicture = false;
    private constrainedIntra = false;
    private transform8x8Mode = false;
    private direct8x8Inference = false;
    private numRefActive = [0, 0];
    private qpY = 0;
    private lastQpDelta = 0;
    private mbSkipRun = -1;
    private prevMbSkipped = false;
    private nextMbSkipped = false;
    private nextMbField = false;

    private mbX = 0;
    private mbY = 0;
    private mbXy = 0;
    private mbField = false;
    private lumaOffset = 0;
    private mbStride = 0;
    private chromaOffset = 0;
    private mbChromaStride = 0;
    private topXy = -1;
    private topLeftXy = -1;
    private topRightXy = -1;
    private topAvail = false;
    private topLeftAvail = false;
    private topRightAvail = false;
    private leftAvail = [false, false];
    private topLeftPartition = 3;
    private mbType = 0;
    private mbTypeFlags = 0;
    private i16Mode = 0;
    private mbCbp = 0;
    private transform8x8 = false;
    private mbChromaMode = 0;
    private partShape = SHAPE_16X16;
    private lists: readonly [readonly RefEntry[], readonly RefEntry[]] = [[], []];
    private mbDirect = 0;

    /**
     * Decodes with the WebAssembly kernels of `memory`, which must hold the pictures, using its
     * scratch block for coefficients and predictions; or in JavaScript when null.
     */
    useKernels(memory: KernelMemory | null): void {
        this.memory = memory;
        this.kernels = memory ? memory.kernels : null;
        this.mc.useKernels(memory);
        if (!memory) return;
        this.coeffAddress = memory.scratch + SCRATCH_COEFFS;
        this.predAAddress = memory.scratch + SCRATCH_PRED_A;
        this.predBAddress = memory.scratch + SCRATCH_PRED_B;
        this.rebind();
    }

    /** Re-creates the views of the kernel memory after it grew. */
    rebind(): void {
        const memory = this.memory;
        if (!memory) return;
        const buffer = memory.buffer;
        this.coeffs = new Int32Array(buffer, this.coeffAddress, COEFF_COUNT);
        this.predAWords = new Uint32Array(buffer, this.predAAddress, PRED_BYTES / 4);
        this.predBWords = new Uint32Array(buffer, this.predBAddress, PRED_BYTES / 4);
        this.predA = new Uint8Array(buffer, this.predAAddress, PRED_BYTES);
        this.predB = new Uint8Array(buffer, this.predBAddress, PRED_BYTES);
        const scratch = memory.scratch;
        this.dcCoeffs = new Int32Array(buffer, scratch + SCRATCH_DC, 32);
        this.nnzCache = new Uint8Array(buffer, scratch + SCRATCH_NNZ, 120);
        this.nnzCache16 = new Uint16Array(buffer, scratch + SCRATCH_NNZ, 60);
        this.nnzCache32 = new Uint32Array(buffer, scratch + SCRATCH_NNZ, 30);
        this.engine = new Int32Array(buffer, scratch + SCRATCH_CABAC, 8);
        this.bits = new Uint8Array(buffer, scratch + SCRATCH_BITS, BITS_BYTES);
        this.cabac.state = new Uint8Array(buffer, scratch + SCRATCH_CONTEXTS, 1024);
        this.sliceWords = new Int32Array(
            buffer,
            scratch + SCRATCH_SLICE,
            SLICE_BLOCK.SLICE_BYTES >> 2,
        );
        this.sliceHalves = new Int16Array(
            buffer,
            scratch + SCRATCH_SLICE,
            SLICE_BLOCK.SLICE_BYTES >> 1,
        );
        this.sliceBytes = new Int8Array(buffer, scratch + SCRATCH_SLICE, SLICE_BLOCK.SLICE_BYTES);
        this.intraCache = new Int8Array(buffer, scratch + SCRATCH_INTRA_CACHE, 40);
        this.directCache = new Uint8Array(buffer, scratch + SCRATCH_DIRECT_CACHE, 40);
        const lists = [0, 1];
        this.refCache = lists.map(
            list => new Int8Array(buffer, scratch + SCRATCH_REF_CACHE + list * REF_CACHE_BYTES, 40),
        ) as [Int8Array, Int8Array];
        this.mvCache = lists.map(
            list => new Int16Array(buffer, scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES, 80),
        ) as [Int16Array, Int16Array];
        this.mvCache32 = lists.map(
            list => new Int32Array(buffer, scratch + SCRATCH_MV_CACHE + list * MV_CACHE_BYTES, 40),
        ) as [Int32Array, Int32Array];
        this.mvdCache = lists.map(
            list =>
                new Uint8Array(buffer, scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES, 80),
        ) as [Uint8Array, Uint8Array];
        this.mvdCache16 = lists.map(
            list =>
                new Uint16Array(buffer, scratch + SCRATCH_MVD_CACHE + list * MVD_CACHE_BYTES, 40),
        ) as [Uint16Array, Uint16Array];
        this.kernelScaling = null;
        if (this.picture) this.bindPicture(this.picture);
    }

    configure(mbWidth: number, mbHeight: number, chromaFormat: number): void {
        this.mbWidth = mbWidth;
        this.mbHeight = mbHeight;
        this.mbCount = mbWidth * mbHeight;
        this.chromaFormat = chromaFormat;
        this.chromaMbHeight = chromaFormat === 2 ? 16 : 8;
        this.chromaBlocks = chromaFormat === 2 ? 8 : chromaFormat === 1 ? 4 : 0;
    }

    /**
     * Resets the per-picture macroblock state before the first slice of a picture or field;
     * `deblock` describes the filtering applied to macroblock rows as soon as decoding no longer
     * needs their unfiltered samples.
     */
    startPicture(picture: Picture, deblock: DeblockInput): void {
        this.picture = picture;
        this.deblock = deblock;
        this.deblockedRows = 0;
        this.decodedPrefix = 0;
        this.bindPicture(picture);
        this.sliceNum.fill(-1);
    }

    private bindPicture(picture: Picture): void {
        this.lumaStride = picture.lumaStride;
        this.chromaStride = picture.chromaStride;
        this.lumaData = picture.data;
        this.lumaWords = picture.words;
        this.clamped = picture.clamped;
        this.picBase = picture.base;
        this.chromaBase = picture.chromaOffset;
        this.crBase = picture.crOffset;
        this.qp = picture.qp;
        this.sliceNum = picture.sliceNum;
        this.filterParams = picture.filterParams;
        this.nzMask = picture.nzMask;
        this.motionClass = picture.motionClass;
        this.cbp = picture.cbp;
        this.dcFlags = picture.dcFlags;
        this.chromaMode = picture.chromaMode;
        this.intraModes = picture.intraModes;
        const nnz = picture.nnz;
        this.nnz = nnz;
        this.nnz16 = new Uint16Array(nnz.buffer, nnz.byteOffset, nnz.length >> 1);
        this.nnz32 = new Uint32Array(nnz.buffer, nnz.byteOffset, nnz.length >> 2);
        this.mvd = picture.mvd;
        this.mvd16 = [0, 1].map(list => {
            const mvd = picture.mvd[list];
            return new Uint16Array(mvd.buffer, mvd.byteOffset, mvd.length >> 1);
        }) as [Uint16Array, Uint16Array];
        this.directMask = picture.directMask;
    }

    /** Decodes the macroblocks of one slice; stops early on damaged data. */
    decodeSlice(ctx: SliceContext, br: BitReader): SliceResult {
        this.ctx = ctx;
        this.br = br;
        this.picture = ctx.picture;
        const header = ctx.header;
        const pps = ctx.pps;
        this.cabacMode = pps.cabac;
        this.sliceType = header.sliceType;
        this.mbaff = ctx.mbaff;
        this.fieldPicture = ctx.structure !== PICT_FRAME;
        this.constrainedIntra = pps.constrainedIntraPred;
        this.transform8x8Mode = pps.transform8x8Mode;
        this.direct8x8Inference = ctx.sps.direct8x8Inference;
        this.numRefActive = [header.numRefIdxActive[0], header.numRefIdxActive[1]];
        this.qpY = pps.picInitQp + header.sliceQpDelta;
        this.lastQpDelta = 0;
        this.mbSkipRun = -1;
        this.prevMbSkipped = false;
        this.nextMbSkipped = false;
        this.nextMbField = false;
        this.lists = ctx.refList;
        this.coeffs.fill(0);
        this.dcCoeffs.fill(0);

        // Only B slices mark direct blocks (ref_idx contexts); other slices read the cleared cache.
        if (this.sliceType !== SLICE_B) this.directCache.fill(0);
        const mbWidth = this.mbWidth;
        const mbaff = this.mbaff;
        let mbAddr = header.firstMb * (mbaff ? 2 : 1);
        const totalMbs = this.fieldPicture ? this.mbCount >> 1 : this.mbCount;
        if (mbAddr >= totalMbs) return { decoded: 0, error: 'first_mb_in_slice out of range' };
        this.kernelResidual = false;
        if (this.cabacMode) {
            br.align();

            // The kernels read the RBSP from their memory: the engine then decodes from that copy.
            this.kernelResidual = this.kernels !== null && br.byteLength <= BITS_BYTES;
            if (this.kernelResidual) {
                this.bits.set(br.data.subarray(0, br.byteLength));
                this.useScaling(ctx.scaling);
            }
            this.cabacData = this.kernelResidual ? this.bits : br.data;
            this.cabac.init(this.cabacData, br.pos >> 3, br.byteLength);
            this.cabac.initContexts(
                this.qpY,
                this.sliceType === SLICE_I || this.sliceType === SLICE_SI,
                header.cabacInitIdc,
            );
        }
        this.kernelInter =
            this.kernelResidual &&
            !mbaff &&
            this.chromaFormat <= 1 &&
            (this.sliceType === SLICE_P || this.sliceType === SLICE_B);
        if (this.kernelInter) {
            this.describeSlice(ctx);
            setRowWaiter(this.refWait !== null ? this.waitRows : null);
        }
        let decoded = 0;
        let error: string | null = null;
        let inferredField = false;
        const filter = filterParams(
            header.disableDeblockingFilterIdc,
            header.alphaOffset,
            header.betaOffset,
            pps.chromaQpOffset[0],
            pps.chromaQpOffset[1],
        );
        try {
            for (;;) {
                let x: number;
                let y: number;
                if (mbaff) {
                    const pair = mbAddr >> 1;
                    x = pair % mbWidth;
                    y = 2 * Math.floor(pair / mbWidth) + (mbAddr & 1);
                } else if (this.fieldPicture) {
                    x = mbAddr % mbWidth;
                    y = 2 * Math.floor(mbAddr / mbWidth) + (ctx.structure === PICT_BOTTOM ? 1 : 0);
                } else {
                    x = mbAddr % mbWidth;
                    y = Math.floor(mbAddr / mbWidth);
                }
                if (y >= this.mbHeight) break;
                const row = mbaff || this.fieldPicture ? y >> 1 : y;
                if (row - 1 > this.deblockedRows) this.deblockUpTo(row - 1);
                const xy = y * mbWidth + x;
                if (this.sliceNum[xy] >= 0) {
                    error = 'slice overlaps decoded macroblocks';
                    break;
                }
                this.mbX = x;
                this.mbY = y;
                this.mbXy = xy;
                if (mbaff && (mbAddr & 1) === 0) inferredField = this.inferFieldFlag(xy);
                this.mbField = this.fieldPicture || (mbaff && inferredField);
                const skipped = this.decodeMacroblock(mbaff && (mbAddr & 1) === 1);
                if (mbaff && (mbAddr & 1) === 0) inferredField = this.mbField;
                decoded++;
                this.sliceNum[xy] = ctx.sliceNum;
                this.filterParams[xy] = filter;
                if (xy === this.decodedPrefix) {
                    let next = xy + 1;
                    while (next < this.mbCount && this.sliceNum[next] >= 0) next++;
                    this.decodedPrefix = next;
                }
                this.picture.mbFlags[xy] |= MB_DECODED | (this.mbField ? MB_FIELD : 0);
                this.prevMbSkipped = skipped;
                if (this.cabacMode) {
                    if (!mbaff || mbAddr & 1) {
                        if (this.cabac.decodeTerminate()) break;
                    }
                    if (this.cabac.bytePosition > br.byteLength + 2) {
                        error = 'slice data overrun';
                        break;
                    }
                } else if (this.mbSkipRun <= 0 && !br.moreRbspData()) break;
                else if (br.pos > br.end + 32) {
                    error = 'slice data overrun';
                    break;
                }
                mbAddr++;
                if (mbAddr >= totalMbs) break;
            }
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        }
        return { decoded, error };
    }

    private deblockUpTo(row: number): void {
        deblockRows(this.deblock!, this.deblockedRows, row);
        this.deblockedRows = row;
        // Filtering a row changes the last lines of the row above; rows after an undecoded
        // macroblock may still be concealed.
        if (this.onRows !== null)
            this.onRows(Math.min(row, Math.floor(this.decodedPrefix / this.mbWidth)) - 1);
    }

    /**
     * Conceals the macroblocks of the picture or field that no slice decoded by copying them from
     * `source` (grey without one); returns their count.
     */
    concealMissing(structure: number, source: Picture | null): number {
        const picture = this.picture;
        const sliceNum = this.sliceNum;
        const flags = picture.mbFlags;
        const mbWidth = picture.mbWidth;
        const mbaff = this.deblock?.mbaff ?? false;
        let missing = 0;
        for (let y = 0; y < picture.mbHeight; y++) {
            if (structure !== PICT_FRAME && (y & 1) !== (structure === PICT_BOTTOM ? 1 : 0))
                continue;
            for (let x = 0; x < mbWidth; x++) {
                const xy = y * mbWidth + x;
                if (sliceNum[xy] >= 0) continue;
                if (!missing && source && this.refWait !== null)
                    this.refWait(source, this.mbHeight);
                missing++;

                // In an MBAFF pair whose other macroblock was decoded as a field macroblock, this
                // one is its other field.
                const pair = xy + ((y & 1) === 0 ? mbWidth : -mbWidth);
                const field =
                    structure !== PICT_FRAME ||
                    (mbaff && sliceNum[pair] >= 0 && (flags[pair] & MB_FIELD) !== 0);
                this.concealMacroblock(picture, source, x, y, field);
            }
        }
        return missing;
    }

    /**
     * Copies (or greys) macroblock (x, y), a field macroblock of every other line in a field
     * picture.
     */
    private concealMacroblock(
        picture: Picture,
        source: Picture | null,
        x: number,
        y: number,
        field: boolean,
    ): void {
        const data = picture.data;
        const cHeight = picture.chromaFormat === 2 ? 16 : 8;
        const stride = field ? picture.lumaStride * 2 : picture.lumaStride;
        const cStride = field ? picture.chromaStride * 2 : picture.chromaStride;
        const lumaBase = field
            ? ((y >> 1) * 32 + (y & 1)) * picture.lumaStride + x * 16
            : y * 16 * picture.lumaStride + x * 16;
        const chromaBase = field
            ? ((y >> 1) * cHeight * 2 + (y & 1)) * picture.chromaStride + x * 8
            : y * cHeight * picture.chromaStride + x * 8;
        for (let r = 0; r < 16; r++) {
            const o = lumaBase + r * stride;
            if (source) data.set(source.data.subarray(o, o + 16), o);
            else data.fill(128, o, o + 16);
        }
        for (let r = 0; r < cHeight; r++) {
            for (const base of [picture.chromaOffset, picture.crOffset]) {
                const o = base + chromaBase + r * cStride;
                if (source) data.set(source.data.subarray(o, o + 8), o);
                else data.fill(128, o, o + 8);
            }
        }
        const xy = y * picture.mbWidth + x;
        picture.mbFlags[xy] = MB_DECODED | MB_INTRA | (field ? MB_FIELD : 0);
        picture.ref[0].fill(-1, xy * 4, xy * 4 + 4);
        picture.ref[1].fill(-1, xy * 4, xy * 4 + 4);
        picture.refId[0].fill(-1, xy * 4, xy * 4 + 4);
        picture.refId[1].fill(-1, xy * 4, xy * 4 + 4);
        picture.mv[0].fill(0, xy * 32, xy * 32 + 32);
        picture.mv[1].fill(0, xy * 32, xy * 32 + 32);
        this.nnz.fill(0, xy * 32, xy * 32 + 32);
        this.nzMask[xy] = 0;
    }

    /**
     * Filters the rows of the picture or field not filtered yet; called once all of its slices are
     * decoded.
     */
    finishPicture(): void {
        if (this.deblock) this.deblockUpTo(deblockRowCount(this.deblock));
        this.deblock = null;
    }

    /**
     * mb_field_decoding_flag inference from the left, then the above pair in the same slice
     * (7.4.4).
     */
    private inferFieldFlag(xy: number): boolean {
        const sliceNum = this.ctx.sliceNum;
        const flags = this.picture.mbFlags;
        if (this.mbX > 0 && this.sliceNum[xy - 1] === sliceNum)
            return (flags[xy - 1] & MB_FIELD) !== 0;
        if (this.mbY >= 2 && this.sliceNum[xy - this.mbWidth] === sliceNum)
            return (flags[xy - this.mbWidth] & MB_FIELD) !== 0;
        return false;
    }

    /**
     * Writes the slice block the kernels decode inter macroblocks from: the slice parameters, the
     * current picture's arrays, the reference entries and the weights.
     */
    private describeSlice(ctx: SliceContext): void {
        const words = this.sliceWords;
        const block = SLICE_BLOCK;
        const set = (at: number, value: number) => (words[at >> 2] = value);
        const pic = ctx.picture;
        const header = ctx.header;
        const pps = ctx.pps;
        const bSlice = header.sliceType === SLICE_B;
        const weights = header.weights;
        const explicit = weights !== null && (!bSlice || pps.weightedBipredIdc === 1);
        const base = pic.base;
        set(block.S_B, bSlice ? 1 : 0);
        set(block.S_MB_WIDTH, this.mbWidth);
        set(block.S_MB_HEIGHT, this.mbHeight);
        set(block.S_FIELD, this.fieldPicture ? 1 : 0);
        set(block.S_STRUCTURE, ctx.structure);
        set(block.S_CHROMA, this.chromaFormat);
        set(block.S_T8X8_MODE, this.transform8x8Mode ? 1 : 0);
        set(block.S_DIRECT_8X8, this.direct8x8Inference ? 1 : 0);
        set(block.S_DIRECT_SPATIAL, header.directSpatialMvPred ? 1 : 0);
        set(block.S_ACTIVE0, header.numRefIdxActive[0]);
        set(block.S_ACTIVE1, header.numRefIdxActive[1]);
        set(block.S_WEIGHT_MODE, explicit ? 1 : bSlice && pps.weightedBipredIdc === 2 ? 2 : 0);
        set(block.S_LUMA_LOG2, weights ? weights.lumaLog2Denom : 0);
        set(block.S_CHROMA_LOG2, weights ? weights.chromaLog2Denom : 0);
        set(block.S_COL_PARITY, ctx.colParity);
        set(block.S_COL_FIELD_OFFSET, ctx.colFieldOffset);
        set(block.S_LUMA_STRIDE, pic.lumaStride);
        set(block.S_CHROMA_STRIDE, pic.chromaStride);
        set(block.S_LUMA, base);
        set(block.S_CB, base + pic.chromaOffset);
        set(block.S_CR, base + pic.crOffset);
        set(block.S_FLAGS, pic.mbFlags.byteOffset);
        set(block.S_SLICE_NUM, pic.sliceNum.byteOffset);
        set(block.S_QP, pic.qp.byteOffset);
        set(block.S_NZ, pic.nzMask.byteOffset);
        set(block.S_MOTION, pic.motionClass.byteOffset);
        set(block.S_CBP, pic.cbp.byteOffset);
        set(block.S_DC, pic.dcFlags.byteOffset);
        set(block.S_CHROMA_MODE, pic.chromaMode.byteOffset);
        set(block.S_DIRECT, pic.directMask.byteOffset);
        set(block.S_NNZ, pic.nnz.byteOffset);
        set(block.S_MVD0, pic.mvd[0].byteOffset);
        set(block.S_MVD1, pic.mvd[1].byteOffset);
        set(block.S_REF0, pic.ref[0].byteOffset);
        set(block.S_REF1, pic.ref[1].byteOffset);
        set(block.S_REFID0, pic.refId[0].byteOffset);
        set(block.S_REFID1, pic.refId[1].byteOffset);
        set(block.S_MV0, pic.mv[0].byteOffset);
        set(block.S_MV1, pic.mv[1].byteOffset);
        set(block.S_SLICE, ctx.sliceNum);
        set(block.S_CB_QP_OFFSET, pps.chromaQpOffset[0]);
        set(block.S_CR_QP_OFFSET, pps.chromaQpOffset[1]);
        set(block.S_WAIT, this.refWait !== null ? 1 : 0);
        for (let list = 0; list < 2; list++) {
            const entries = ctx.refList[list];
            const count = Math.min(entries.length, 32);
            set(list ? block.S_COUNT1 : block.S_COUNT0, count);
            for (let i = 0; i < Math.max(count, 1); i++) {
                const at = block.ENTRIES + list * block.ENTRY_LIST_BYTES + i * block.ENTRY_BYTES;
                const entry = entries[i];
                set(at + block.E_PRESENT, entry ? 1 : 0);
                if (!entry) continue;
                set(at + block.E_ID, entry.id);
                set(at + block.E_PARITY, entry.parity);
                set(at + block.E_LONG, entry.longTerm ? 1 : 0);
                set(at + block.E_LUMA, entry.luma.base + entry.luma.offset);
                set(at + block.E_STRIDE, entry.luma.stride);
                set(at + block.E_WIDTH, entry.luma.width);
                set(at + block.E_HEIGHT, entry.luma.height);
                set(at + block.E_CB, entry.cb.base + entry.cb.offset);
                set(at + block.E_CR_SHIFT, entry.cr.offset - entry.cb.offset);
                set(at + block.E_CSTRIDE, entry.cb.stride);
                set(at + block.E_CWIDTH, entry.cb.width);
                set(at + block.E_CHEIGHT, entry.cb.height);
            }
        }
        const col = ctx.refList[1][0]?.pic;
        if (col) {
            set(block.S_COL_FLAGS, col.mbFlags.byteOffset);
            set(block.S_COL_REF0, col.ref[0].byteOffset);
            set(block.S_COL_REF1, col.ref[1].byteOffset);
            set(block.S_COL_REFID0, col.refId[0].byteOffset);
            set(block.S_COL_REFID1, col.refId[1].byteOffset);
            set(block.S_COL_MV0, col.mv[0].byteOffset);
            set(block.S_COL_MV1, col.mv[1].byteOffset);
        }
        if (explicit) {
            this.sliceHalves.set(weights.table[0], block.WEIGHTS >> 1);
            this.sliceHalves.set(weights.table[1], (block.WEIGHTS + block.WEIGHT_LIST_BYTES) >> 1);
        }
        if (ctx.implicitWeights) this.sliceBytes.set(ctx.implicitWeights, block.IMPLICIT);
        words.set(ctx.distScale.subarray(0, 32), block.DIST_SCALE >> 2);
    }

    /**
     * Waits for row `row` of reference `ref` of list `list` of the slice (wait_rows of the
     * kernels).
     */
    private readonly waitRows = (list: number, ref: number, row: number): void =>
        this.refWait!(this.ctx.refList[list][ref].pic, row);

    /**
     * decodeMacroblock by the kernels (inter_mb), continuing in JavaScript for intra macroblocks.
     */
    private decodeKernelMacroblock(): boolean {
        const words = this.sliceWords;
        const qpAt = SLICE_BLOCK.S_QP_Y >> 2;
        const deltaAt = SLICE_BLOCK.S_LAST_QP_DELTA >> 2;
        words[qpAt] = this.qpY;
        words[deltaAt] = this.lastQpDelta;
        const cabac = this.cabac;
        cabac.save(this.engine);
        const result = this.kernels!.inter_mb(this.memory!.scratch, this.mbX, this.mbY);
        cabac.restore(this.engine);
        this.qpY = words[qpAt];
        this.lastQpDelta = words[deltaAt];
        if (result === MB_DONE) return false;
        if (result === MB_SKIPPED) return true;
        if (result === ERROR_REF_IDX) throw new Error('ref_idx out of range');
        if (result === ERROR_QP_DELTA) throw new Error('mb_qp_delta out of range');

        // An intra macroblock whose mb_type prefix the kernels read.
        this.setPosition();
        this.fillNeighbors();
        this.decodeIntraMbType(this.decodeIMbTypeCabac(result === MB_INTRA_P ? 17 : 32, false));
        this.decodeMbCabacRest();
        return false;
    }

    /** Decodes one macroblock at the current position; returns whether it was skipped. */
    private decodeMacroblock(bottomOfPair: boolean): boolean {
        if (this.kernelInter) return this.decodeKernelMacroblock();
        const mbaff = this.mbaff;
        const br = this.br;
        const intraSlice = this.sliceType === SLICE_I || this.sliceType === SLICE_SI;
        let skipped = false;
        let located = false;
        if (!intraSlice) {
            if (this.cabacMode) {
                if (mbaff && bottomOfPair && this.prevMbSkipped) {
                    skipped = this.nextMbSkipped;
                    if (!skipped) this.mbField = this.nextMbField;
                } else if (!mbaff) {
                    // Without MBAFF the skip flag's neighbours A and B are the macroblock's own
                    // left and top.
                    this.setPosition();
                    this.fillNeighbors();
                    located = true;
                    const flags = this.picture.mbFlags;
                    let ctx = this.sliceType === SLICE_B ? 24 : 11;
                    if (this.leftAvail[0] && !(flags[this.leftMb[0]] & MB_SKIP)) ctx++;
                    if (this.topAvail && !(flags[this.topXy] & MB_SKIP)) ctx++;
                    skipped = this.cabac.decodeBin(ctx) === 1;
                } else {
                    this.setPosition();
                    skipped = this.cabac.decodeBin(this.skipContext()) === 1;
                }
                if (skipped && mbaff && !bottomOfPair) {
                    const savedX = this.mbX;
                    const savedY = this.mbY;
                    const savedXy = this.mbXy;
                    this.mbY = savedY + 1;
                    this.mbXy = savedXy + this.mbWidth;
                    this.setPosition();
                    this.nextMbSkipped = this.cabac.decodeBin(this.skipContext()) === 1;
                    if (!this.nextMbSkipped) {
                        this.nextMbField = this.cabac.decodeBin(70 + this.fieldContext()) === 1;
                        this.mbField = this.nextMbField;
                    }
                    this.mbX = savedX;
                    this.mbY = savedY;
                    this.mbXy = savedXy;
                }
            } else {
                if (this.mbSkipRun < 0) {
                    this.mbSkipRun = br.ue();
                    if (this.mbSkipRun > this.mbCount) throw new Error('mb_skip_run out of range');
                }
                if (this.mbSkipRun > 0) {
                    this.mbSkipRun--;
                    skipped = true;
                    if (mbaff && !bottomOfPair && this.mbSkipRun === 0 && br.moreRbspData()) {
                        this.mbField = br.read1() === 1;
                    }
                } else this.mbSkipRun = -1;
            }
        }
        if (!skipped && mbaff && (!bottomOfPair || this.prevMbSkipped)) {
            if (this.cabacMode) {
                if (!(bottomOfPair && this.prevMbSkipped)) {
                    this.setPosition();
                    this.mbField = this.cabac.decodeBin(70 + this.fieldContext()) === 1;
                }
            } else if (!(bottomOfPair && this.prevMbSkipped)) this.mbField = br.read1() === 1;
        }
        if (!located) {
            this.setPosition();
            this.fillNeighbors();
        }
        if (skipped) {
            this.decodeSkip();
            return true;
        }
        if (this.cabacMode) this.decodeMbCabac();
        else this.decodeMbCavlc();
        return false;
    }

    /** Sample offsets and strides of the current macroblock. */
    private setPosition(): void {
        const x = this.mbX;
        const y = this.mbY;
        if (this.mbField) {
            this.mbStride = this.lumaStride * 2;
            this.lumaOffset = ((y >> 1) * 32 + (y & 1)) * this.lumaStride + x * 16;
            this.mbChromaStride = this.chromaStride * 2;
            this.chromaOffset =
                ((y >> 1) * this.chromaMbHeight * 2 + (y & 1)) * this.chromaStride + x * 8;
        } else {
            this.mbStride = this.lumaStride;
            this.lumaOffset = y * 16 * this.lumaStride + x * 16;
            this.mbChromaStride = this.chromaStride;
            this.chromaOffset = y * this.chromaMbHeight * this.chromaStride + x * 8;
        }
    }

    private available(xy: number): boolean {
        return xy >= 0 && this.sliceNum[xy] === this.ctx.sliceNum;
    }

    /** mb_skip_flag ctxIdxInc (9.3.3.1.1.1) from the left and above macroblocks. */
    private skipContext(): number {
        const flags = this.picture.mbFlags;
        let a: number;
        let b: number;
        const xy = this.mbXy;
        const stride = this.mbWidth;
        if (this.mbaff) {
            const pairXy = this.mbX + (this.mbY & ~1) * stride;
            a = pairXy - 1;
            if (this.mbY & 1 && this.available(a) && this.mbField === ((flags[a] & MB_FIELD) !== 0))
                a += stride;
            if (this.mbField) {
                b = pairXy - stride;
                if (!(this.mbY & 1) && this.available(b) && flags[b] & MB_FIELD) b -= stride;
            } else b = this.mbX + (this.mbY - 1) * stride;
        } else {
            a = xy - 1;
            b = xy - (this.fieldPicture ? 2 * stride : stride);
        }
        let ctx = 0;
        if (this.mbX > 0 && this.available(a) && !(flags[a] & MB_SKIP)) ctx++;
        if (b >= 0 && this.available(b) && !(flags[b] & MB_SKIP)) ctx++;
        return (this.sliceType === SLICE_B ? 24 : 11) + ctx;
    }

    /** mb_field_decoding_flag ctxIdxInc from the left and above pairs. */
    private fieldContext(): number {
        const flags = this.picture.mbFlags;
        const pairXy = this.mbX + (this.mbY & ~1) * this.mbWidth;
        let ctx = 0;
        if (this.mbX > 0 && this.available(pairXy - 1) && flags[pairXy - 1] & MB_FIELD) ctx++;
        const above = pairXy - 2 * this.mbWidth;
        if (above >= 0 && this.available(above) && flags[above] & MB_FIELD) ctx++;
        return ctx;
    }

    /** Neighbouring macroblock addresses and the left block mapping (6.4.12). */
    private fillNeighbors(): void {
        const stride = this.mbWidth;
        const xy = this.mbXy;
        const flags = this.picture.mbFlags;
        const left = this.leftMb;
        const leftBlock = this.leftBlock;
        let topXy = xy - (this.mbField ? stride * 2 : stride);
        let topLeftXy = topXy - 1;
        let topRightXy = topXy + 1;
        left[0] = left[1] = xy - 1;
        leftBlock[0] = 0;
        leftBlock[1] = 1;
        leftBlock[2] = 2;
        leftBlock[3] = 3;
        this.topLeftPartition = 3;
        if (this.mbaff) {
            const leftField = this.mbX > 0 && (flags[xy - 1] & MB_FIELD) !== 0;
            const curField = this.mbField;
            if (this.mbY & 1) {
                if (leftField !== curField) {
                    left[0] = left[1] = xy - stride - 1;
                    if (curField) {
                        left[1] += stride;
                        leftBlock[0] = 0;
                        leftBlock[1] = 2;
                        leftBlock[2] = 0;
                        leftBlock[3] = 2;
                    } else {
                        topLeftXy += stride;
                        this.topLeftPartition = 1;
                        leftBlock[0] = 2;
                        leftBlock[1] = 2;
                        leftBlock[2] = 3;
                        leftBlock[3] = 3;
                    }
                }
            } else {
                if (curField) {
                    if (topXy >= 0) {
                        if (this.mbX > 0 && !(flags[topXy - 1] & MB_FIELD)) topLeftXy += stride;
                        if (this.mbX + 1 < stride && !(flags[topXy + 1] & MB_FIELD))
                            topRightXy += stride;
                        if (!(flags[topXy] & MB_FIELD)) topXy += stride;
                    }
                }
                if (leftField !== curField) {
                    if (curField) {
                        left[1] += stride;
                        leftBlock[0] = 0;
                        leftBlock[1] = 2;
                        leftBlock[2] = 0;
                        leftBlock[3] = 2;
                    } else {
                        leftBlock[0] = 0;
                        leftBlock[1] = 0;
                        leftBlock[2] = 1;
                        leftBlock[3] = 1;
                    }
                }
            }
        }
        this.topXy = topXy >= 0 ? topXy : -1;
        this.topLeftXy = topXy >= 0 && this.mbX > 0 ? topLeftXy : -1;
        this.topRightXy = topXy >= 0 && this.mbX + 1 < stride ? topRightXy : -1;
        if (this.mbX === 0) left[0] = left[1] = -1;
        this.topAvail = this.available(this.topXy);
        this.topLeftAvail = this.available(this.topLeftXy);
        this.topRightAvail = this.available(this.topRightXy);
        this.leftAvail[0] = this.available(left[0]);
        this.leftAvail[1] = this.available(left[1]);
    }

    /**
     * Fills the neighbour caches for the current macroblock; `intra` selects the
     * unavailable-neighbour markers.
     */
    private fillCaches(intra: boolean, needMotion: boolean): void {
        const nnz = this.nnz;
        const nnzCache = this.nnzCache;
        const left = this.leftMb;
        const leftBlock = this.leftBlock;
        const topXy = this.topXy;
        const flags = this.picture.mbFlags;
        const unavailableNnz = this.cabacMode ? (intra ? 64 : 0) : 64;
        if (this.topAvail) {
            const base = topXy * 32;
            nnzCache[4] = nnz[base + 12];
            nnzCache[5] = nnz[base + 13];
            nnzCache[6] = nnz[base + 14];
            nnzCache[7] = nnz[base + 15];
            if (this.chromaFormat === 2) {
                nnzCache[5 * 8 + 4] = nnz[base + 16 + 6];
                nnzCache[5 * 8 + 5] = nnz[base + 16 + 7];
                nnzCache[10 * 8 + 4] = nnz[base + 24 + 6];
                nnzCache[10 * 8 + 5] = nnz[base + 24 + 7];
            } else {
                nnzCache[5 * 8 + 4] = nnz[base + 16 + 2];
                nnzCache[5 * 8 + 5] = nnz[base + 16 + 3];
                nnzCache[10 * 8 + 4] = nnz[base + 24 + 2];
                nnzCache[10 * 8 + 5] = nnz[base + 24 + 3];
            }
        } else {
            nnzCache[4] = nnzCache[5] = nnzCache[6] = nnzCache[7] = unavailableNnz;
            nnzCache[5 * 8 + 4] = nnzCache[5 * 8 + 5] = unavailableNnz;
            nnzCache[10 * 8 + 4] = nnzCache[10 * 8 + 5] = unavailableNnz;
        }
        for (let i = 0; i < 4; i++) {
            const mb = left[i >> 1];
            const avail = this.leftAvail[i >> 1];
            const row = leftBlock[i];
            if (avail) {
                const base = mb * 32;
                nnzCache[(i + 1) * 8 + 3] = nnz[base + row * 4 + 3];
            } else nnzCache[(i + 1) * 8 + 3] = unavailableNnz;
        }
        for (let i = 0; i < 2; i++) {
            const mb = left[i];
            const avail = this.leftAvail[i];
            const row = this.chromaFormat === 2 ? leftBlock[i * 2] : leftBlock[i * 2] >> 1;
            if (this.chromaFormat === 2) {
                for (let k = 0; k < 2; k++) {
                    const crow = leftBlock[i * 2 + k];
                    nnzCache[(6 + i * 2 + k) * 8 + 3] = avail
                        ? nnz[mb * 32 + 16 + crow * 2 + 1]
                        : unavailableNnz;
                    nnzCache[(11 + i * 2 + k) * 8 + 3] = avail
                        ? nnz[mb * 32 + 24 + crow * 2 + 1]
                        : unavailableNnz;
                }
            } else {
                nnzCache[(6 + i) * 8 + 3] = avail
                    ? nnz[mb * 32 + 16 + row * 2 + 1]
                    : unavailableNnz;
                nnzCache[(11 + i) * 8 + 3] = avail
                    ? nnz[mb * 32 + 24 + row * 2 + 1]
                    : unavailableNnz;
            }
        }
        if (intra) {
            const modes = this.intraModes;
            const intraCache = this.intraCache;
            const cip = this.constrainedIntra;
            if (this.topAvail) {
                const topIntra = (flags[topXy] & MB_INTRA) !== 0;
                if (topIntra && !(flags[topXy] & (MB_INTRA16 | MB_PCM))) {
                    intraCache[4] = modes[topXy * 16 + 12];
                    intraCache[5] = modes[topXy * 16 + 13];
                    intraCache[6] = modes[topXy * 16 + 14];
                    intraCache[7] = modes[topXy * 16 + 15];
                } else {
                    const v = !topIntra && cip ? -1 : 2;
                    intraCache[4] = intraCache[5] = intraCache[6] = intraCache[7] = v;
                }
            } else intraCache[4] = intraCache[5] = intraCache[6] = intraCache[7] = -1;
            for (let i = 0; i < 4; i++) {
                const mb = left[i >> 1];
                if (this.leftAvail[i >> 1]) {
                    const leftIntra = (flags[mb] & MB_INTRA) !== 0;
                    if (leftIntra && !(flags[mb] & (MB_INTRA16 | MB_PCM))) {
                        intraCache[(i + 1) * 8 + 3] = modes[mb * 16 + leftBlock[i] * 4 + 3];
                    } else intraCache[(i + 1) * 8 + 3] = !leftIntra && cip ? -1 : 2;
                } else intraCache[(i + 1) * 8 + 3] = -1;
            }
        }
        if (!needMotion) return;
        const listCount = this.sliceType === SLICE_B ? 2 : 1;
        const directMask = this.directMask;
        const directCache = this.directCache;
        for (let list = 0; list < listCount; list++) {
            if (this.mbaff) {
                for (let i = 0; i < 4; i++)
                    this.fillCacheEntry(list, topXy, this.topAvail, 12 + i, 4 + i);
                for (let i = 0; i < 4; i++) {
                    const mb = left[i >> 1];
                    this.fillCacheEntry(
                        list,
                        mb,
                        this.leftAvail[i >> 1],
                        leftBlock[i] * 4 + 3,
                        (i + 1) * 8 + 3,
                    );
                }
            } else {
                this.fillCacheColumn(list, topXy, this.topAvail, 12, 1, 4, 1);
                this.fillCacheColumn(list, left[0], this.leftAvail[0], 3, 4, cacheAt(-1, 0), 8);
            }
            this.fillCacheEntry(list, this.topRightXy, this.topRightAvail, 12, 8);
            this.fillCacheEntry(
                list,
                this.topLeftXy,
                this.topLeftAvail,
                this.topLeftPartition * 4 + 3,
                3,
            );
            const refCache = this.refCache[list];
            refCache[cacheAt(4, 0)] =
                refCache[cacheAt(4, 1)] =
                refCache[cacheAt(4, 2)] =
                    PART_NOT_AVAILABLE;
        }
        if (this.sliceType === SLICE_B) {
            directCache[4] = directCache[5] = this.topAvail ? (directMask[topXy] >> 2) & 1 : 0;
            directCache[6] = directCache[7] = this.topAvail ? (directMask[topXy] >> 3) & 1 : 0;
            for (let i = 0; i < 4; i++) {
                const mb = left[i >> 1];
                directCache[(i + 1) * 8 + 3] = this.leftAvail[i >> 1]
                    ? (directMask[mb] >> (1 + 2 * (leftBlock[i] >> 1))) & 1
                    : 0;
            }
            directCache[8] = 0;
            directCache[3] = 0;
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) directCache[cacheAt(x, y)] = 0;
        }
    }

    /**
     * Fills only the neighbours A, B, C and D of the whole macroblock in the motion cache of
     * `list`: all that the motion vector prediction of skipped macroblocks reads.
     */
    private fillPredictionNeighbours(list: number): void {
        this.fillCacheEntry(
            list,
            this.leftMb[0],
            this.leftAvail[0],
            this.leftBlock[0] * 4 + 3,
            cacheAt(-1, 0),
        );
        this.fillCacheEntry(list, this.topXy, this.topAvail, 12, cacheAt(0, -1));
        this.fillCacheEntry(list, this.topRightXy, this.topRightAvail, 12, cacheAt(4, -1));
        this.fillCacheEntry(
            list,
            this.topLeftXy,
            this.topLeftAvail,
            this.topLeftPartition * 4 + 3,
            cacheAt(-1, -1),
        );
    }

    /**
     * fillCacheEntry for the four blocks `first`, `first + step`, ... of one neighbour of the same
     * kind (frame or field) into cache positions `cachePos`, `cachePos + cacheStep`, ...: its
     * bottom row or right column.
     */
    private fillCacheColumn(
        list: number,
        mb: number,
        avail: boolean,
        first: number,
        step: number,
        cachePos: number,
        cacheStep: number,
    ): void {
        const refCache = this.refCache[list];
        const mvCache = this.mvCache32[list];
        const mvdOn = this.cabacMode;
        const c1 = cachePos + cacheStep;
        const c2 = c1 + cacheStep;
        const c3 = c2 + cacheStep;
        if (!avail || this.picture.mbFlags[mb] & MB_INTRA) {
            const ref = avail ? LIST_NOT_USED : PART_NOT_AVAILABLE;
            refCache[cachePos] = refCache[c1] = refCache[c2] = refCache[c3] = ref;
            mvCache[cachePos] = mvCache[c1] = mvCache[c2] = mvCache[c3] = 0;
            if (mvdOn) {
                const mvdCache = this.mvdCache16[list];
                mvdCache[cachePos] = mvdCache[c1] = mvdCache[c2] = mvdCache[c3] = 0;
            }
            return;
        }
        const refs = this.picture.ref[list];
        const b8 = mb * 4 + (first >> 3) * 2 + ((first & 3) >> 1);

        // Bottom row (step 1): 8x8 blocks 2, 2, 3, 3; right column (step 4): 1, 1, 3, 3.
        const b8Next = b8 + (step === 1 ? 1 : 2);
        refCache[cachePos] = refCache[c1] = refs[b8];
        refCache[c2] = refCache[c3] = refs[b8Next];
        const mvs = this.picture.mv32[list];
        const v = mb * 16 + first;
        mvCache[cachePos] = mvs[v];
        mvCache[c1] = mvs[v + step];
        mvCache[c2] = mvs[v + 2 * step];
        mvCache[c3] = mvs[v + 3 * step];
        if (mvdOn) {
            const mvdCache = this.mvdCache16[list];
            const mvds = this.mvd16[list];
            const slot = mb * 8;
            mvdCache[cachePos] = mvds[slot + MVD_SLOT[first]];
            mvdCache[c1] = mvds[slot + MVD_SLOT[first + step]];
            mvdCache[c2] = mvds[slot + MVD_SLOT[first + 2 * step]];
            mvdCache[c3] = mvds[slot + MVD_SLOT[first + 3 * step]];
        }
    }

    /**
     * Copies one 4x4 block's motion data of a neighbour into the cache, converting between field
     * and frame units.
     */
    private fillCacheEntry(
        list: number,
        mb: number,
        avail: boolean,
        blockRaster: number,
        cachePos: number,
    ): void {
        const refCache = this.refCache[list];
        const mvCache = this.mvCache32[list];
        const mvdOn = this.cabacMode;
        if (!avail) {
            refCache[cachePos] = PART_NOT_AVAILABLE;
            mvCache[cachePos] = 0;
            if (mvdOn) this.mvdCache16[list][cachePos] = 0;
            return;
        }
        const flags = this.picture.mbFlags[mb];
        if (flags & MB_INTRA) {
            refCache[cachePos] = LIST_NOT_USED;
            mvCache[cachePos] = 0;
            if (mvdOn) this.mvdCache16[list][cachePos] = 0;
            return;
        }
        const ref =
            this.picture.ref[list][mb * 4 + (blockRaster >> 3) * 2 + ((blockRaster & 3) >> 1)];
        const v = mb * 16 + blockRaster;
        if (this.mbaff && ref >= 0 && ((flags & MB_FIELD) !== 0) !== this.mbField) {
            this.fillScaledEntry(list, ref, v, mb * 8 + MVD_SLOT[blockRaster], cachePos);
            return;
        }
        refCache[cachePos] = ref;
        mvCache[cachePos] = this.picture.mv32[list][v];
        if (mvdOn)
            this.mvdCache16[list][cachePos] = this.mvd16[list][mb * 8 + MVD_SLOT[blockRaster]];
    }

    /**
     * fillCacheEntry for a neighbour of the other of field and frame (MBAFF): scales references and
     * vertical units.
     */
    private fillScaledEntry(
        list: number,
        ref: number,
        v: number,
        slot: number,
        cachePos: number,
    ): void {
        const mvs = this.picture.mv[list];
        const mvds = this.mvd[list];
        let mvy = mvs[v * 2 + 1];
        let mvdy = this.cabacMode ? mvds[slot * 2 + 1] : 0;
        if (this.mbField) {
            ref *= 2;
            mvy = mvy < 0 ? -(-mvy >> 1) : mvy >> 1;
            mvdy >>= 1;
        } else {
            ref >>= 1;
            mvy *= 2;
            mvdy = Math.min(255, mvdy * 2);
        }
        const mvCache = this.mvCache[list];
        this.refCache[list][cachePos] = ref;
        mvCache[cachePos * 2] = mvs[v * 2];
        mvCache[cachePos * 2 + 1] = mvy;
        if (this.cabacMode) {
            const mvdCache = this.mvdCache[list];
            mvdCache[cachePos * 2] = mvds[slot * 2];
            mvdCache[cachePos * 2 + 1] = mvdy;
        }
    }

    /** The reference lists of the current macroblock (field lists for MBAFF field macroblocks). */
    private currentLists(): readonly [readonly RefEntry[], readonly RefEntry[]] {
        if (this.mbaff && this.mbField && this.ctx.fieldRefList)
            return this.ctx.fieldRefList[this.mbY & 1];
        return this.ctx.refList;
    }

    // ---------------------------------------------------------------------------------------------
    // Skipped macroblocks

    private decodeSkip(): void {
        this.mbTypeFlags = MB_SKIP;
        this.mbCbp = 0;
        this.mbChromaMode = 0;
        this.transform8x8 = false;
        this.lastQpDelta = 0;
        this.lists = this.currentLists();
        this.partShape = SHAPE_16X16;
        this.mbDirect = 0;
        if (this.sliceType === SLICE_B) {
            this.mbTypeFlags |= MB_DIRECT16;
            this.mbDirect = 15;
            if (this.ctx.header.directSpatialMvPred) {
                this.fillPredictionNeighbours(0);
                this.fillPredictionNeighbours(1);
            }
            this.deriveDirect(15);
        } else {
            this.fillPredictionNeighbours(0);
            this.partPred[0] = PRED_L0;
            this.deriveSkipMv();
        }
        this.motionCompensate();
        this.storeMacroblock(true);
    }

    /** P_Skip motion vector (8.4.1.1). */
    private deriveSkipMv(): void {
        const refCache = this.refCache[0];
        const mvCache = this.mvCache[0];
        const a = cacheAt(-1, 0);
        const b = cacheAt(0, -1);
        let mvx = 0;
        let mvy = 0;
        const refA = refCache[a];
        const refB = refCache[b];
        if (
            refA !== PART_NOT_AVAILABLE &&
            refB !== PART_NOT_AVAILABLE &&
            !(refA === 0 && mvCache[a * 2] === 0 && mvCache[a * 2 + 1] === 0) &&
            !(refB === 0 && mvCache[b * 2] === 0 && mvCache[b * 2 + 1] === 0)
        ) {
            this.predictMv(0, 0, 0, 4, 0, SHAPE_16X16, 0);
            mvx = this.mvTmp[0];
            mvy = this.mvTmp[1];
        }
        this.fillMotion(0, 0, 0, 4, 4, 0, mvx, mvy);
        this.fillRef(1, 0, 0, 4, 4, LIST_NOT_USED);
    }

    // ---------------------------------------------------------------------------------------------
    // Motion vector prediction

    /**
     * Median or directional prediction (8.4.1.3) for the partition at (x4, y4) of w4 x h4 blocks
     * with reference `refIdx`; the result lands in `mvTmp`. `firstBlk` is the blkIdx of the
     * partition's first 4x4 block.
     */
    private predictMv(
        list: number,
        x4: number,
        y4: number,
        w4: number,
        refIdx: number,
        shape: number,
        firstBlk: number,
    ): void {
        const refCache = this.refCache[list];
        const mvCache = this.mvCache[list];
        const a = cacheAt(x4 - 1, y4);
        const b = cacheAt(x4, y4 - 1);
        let c = cacheAt(x4 + w4, y4 - 1);
        let refC: number;
        const cx = x4 + w4;
        const cy = y4 - 1;
        if (cy < 0) refC = refCache[c];
        else if (cx > 3) refC = PART_NOT_AVAILABLE;
        else refC = RASTER_TO_BLOCK[cy * 4 + cx] < firstBlk ? refCache[c] : PART_NOT_AVAILABLE;
        if (refC === PART_NOT_AVAILABLE) {
            if (
                this.mbaff &&
                x4 === 0 &&
                y4 > 0 &&
                refCache[a] !== PART_NOT_AVAILABLE &&
                this.leftPairMixed()
            ) {
                c = cacheAt(-2, 0);
                refC = this.mixedDiagonal(list, y4, c);
            } else {
                c = cacheAt(x4 - 1, y4 - 1);
                refC = refCache[c];
            }
        }
        const refA = refCache[a];
        const refB = refCache[b];
        const out = this.mvTmp;
        if (shape === SHAPE_16X8) {
            if (y4 === 0) {
                if (refB === refIdx) {
                    out[0] = mvCache[b * 2];
                    out[1] = mvCache[b * 2 + 1];
                    return;
                }
            } else if (refA === refIdx) {
                out[0] = mvCache[a * 2];
                out[1] = mvCache[a * 2 + 1];
                return;
            }
        } else if (shape === SHAPE_8X16) {
            if (x4 === 0) {
                if (refA === refIdx) {
                    out[0] = mvCache[a * 2];
                    out[1] = mvCache[a * 2 + 1];
                    return;
                }
            } else if (refC === refIdx) {
                out[0] = mvCache[c * 2];
                out[1] = mvCache[c * 2 + 1];
                return;
            }
        }
        const matches =
            (refA === refIdx ? 1 : 0) + (refB === refIdx ? 1 : 0) + (refC === refIdx ? 1 : 0);
        if (matches === 1) {
            const pos = refA === refIdx ? a : refB === refIdx ? b : c;
            out[0] = mvCache[pos * 2];
            out[1] = mvCache[pos * 2 + 1];
            return;
        }
        if (
            refB === PART_NOT_AVAILABLE &&
            refC === PART_NOT_AVAILABLE &&
            refA !== PART_NOT_AVAILABLE
        ) {
            out[0] = mvCache[a * 2];
            out[1] = mvCache[a * 2 + 1];
            return;
        }
        out[0] = median(mvCache[a * 2], mvCache[b * 2], mvCache[c * 2]);
        out[1] = median(mvCache[a * 2 + 1], mvCache[b * 2 + 1], mvCache[c * 2 + 1]);
    }

    /**
     * Whether the left macroblock pair of an MBAFF macroblock is coded as the other of frame and
     * field.
     */
    private leftPairMixed(): boolean {
        const leftTop = this.mbX - 1 + (this.mbY & ~1) * this.mbWidth;
        return ((this.picture.mbFlags[leftTop] & MB_FIELD) !== 0) !== this.mbField;
    }

    /**
     * Neighbour D (6.4.12.2, Table 6-4) of a left-column partition below the first row when the
     * left pair is coded as the other of frame and field: its row lies in the other field or frame
     * macroblock of the left pair than neighbour A. Stores the vector at cache position `c` and
     * returns the reference index in current units.
     */
    private mixedDiagonal(list: number, y4: number, c: number): number {
        const pic = this.picture;
        const stride = this.mbWidth;
        const leftTop = this.mbX - 1 + (this.mbY & ~1) * stride;
        let xy: number;
        let row: number;
        if (this.mbField) {
            xy = y4 === 3 ? leftTop + stride : leftTop;
            row = y4 === 2 ? 3 : 1;
        } else {
            xy = leftTop + stride;
            row = (this.mbY & 1) * 2 + (y4 === 3 ? 1 : 0);
        }
        const mvCache = this.mvCache[list];
        mvCache[c * 2] = 0;
        mvCache[c * 2 + 1] = 0;
        const refs = pic.ref[list];
        if (
            pic.mbFlags[xy] & MB_INTRA ||
            (refs[xy * 4] & refs[xy * 4 + 1] & refs[xy * 4 + 2] & refs[xy * 4 + 3]) < 0
        )
            return LIST_NOT_USED;
        const ref = refs[xy * 4 + 1 + (row & 2)];
        const mvx = pic.mv[list][xy * 32 + (row * 4 + 3) * 2];
        const mvy = pic.mv[list][xy * 32 + (row * 4 + 3) * 2 + 1];
        mvCache[c * 2] = mvx;
        if (this.mbField) {
            mvCache[c * 2 + 1] = mvy < 0 ? -(-mvy >> 1) : mvy >> 1;
            return ref * 2;
        }
        mvCache[c * 2 + 1] = mvy * 2;
        return ref >> 1;
    }

    private fillMotion(
        list: number,
        x4: number,
        y4: number,
        w4: number,
        h4: number,
        ref: number,
        mvx: number,
        mvy: number,
    ): void {
        const refCache = this.refCache[list];
        const mvCache = this.mvCache32[list];
        const word = packMv(mvx, mvy);
        for (let y = y4; y < y4 + h4; y++) {
            const p = cacheAt(x4, y);
            for (let x = 0; x < w4; x++) {
                refCache[p + x] = ref;
                mvCache[p + x] = word;
            }
        }
    }

    private fillRef(
        list: number,
        x4: number,
        y4: number,
        w4: number,
        h4: number,
        ref: number,
    ): void {
        this.fillMotion(list, x4, y4, w4, h4, ref, 0, 0);
    }

    private fillMvd(
        list: number,
        x4: number,
        y4: number,
        w4: number,
        h4: number,
        mvdx: number,
        mvdy: number,
    ): void {
        const mvdCache = this.mvdCache16[list];
        const ax = mvdx < 0 ? -mvdx : mvdx;
        const ay = mvdy < 0 ? -mvdy : mvdy;
        const pair = packPair(ax < 255 ? ax : 255, ay < 255 ? ay : 255);
        for (let y = y4; y < y4 + h4; y++) {
            const p = cacheAt(x4, y);
            for (let x = 0; x < w4; x++) mvdCache[p + x] = pair;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Direct prediction

    /**
     * Derives the direct-mode motion of the 8x8 blocks in `mask` (bit per 8x8), spatial or temporal
     * (8.4.1.2).
     */
    private deriveDirect(mask: number): void {
        if (this.ctx.header.directSpatialMvPred) this.deriveSpatialDirect(mask);
        else this.deriveTemporalDirect(mask);
        const directCache = this.directCache;
        for (let i = 0; i < 4; i++) {
            if (!(mask & (1 << i))) continue;
            const p = cacheAt((i & 1) * 2, (i >> 1) * 2);
            directCache[p] = directCache[p + 1] = directCache[p + 8] = directCache[p + 9] = 1;
        }
    }

    /**
     * Colocated macroblock lookup (8.4.1.2.1): sets `colXy` and `colFieldRows` describing which 4x4
     * rows of the colocated data the current 8x8 rows map to, and whether the vertical scale
     * differs.
     */
    private colXy = 0;
    private colXy2 = 0;
    private colMixed = false;
    private colVertShift = 0;

    private locateColocated(): Picture {
        const ref1 = this.lists[1][0];
        const col = ref1.pic;
        if (this.refWait !== null)
            this.refWait(col, this.mbaff || this.fieldPicture ? this.mbHeight : this.mbY);
        const stride = this.mbWidth;
        const colFlags = col.mbFlags;
        let xy = this.mbXy;
        this.colMixed = false;
        this.colVertShift = 0;

        // A field of the other parity is read at its own macroblock: the current macroblock of a
        // second field whose first field is the colocated picture holds no data yet.
        if (colFlags[xy + stride * this.ctx.colFieldOffset] & MB_FIELD) {
            if (!this.mbField) {
                xy = this.mbX + ((this.mbY & ~1) + this.ctx.colParity) * stride;
                this.colMixed = true;
                this.colVertShift = 1;
            } else {
                xy += stride * this.ctx.colFieldOffset;
            }
            this.colXy = this.colXy2 = xy;
        } else if (this.mbField) {
            xy = this.mbX + (this.mbY & ~1) * stride;
            this.colXy = xy;
            this.colXy2 = xy + stride;
            this.colMixed = true;
            this.colVertShift = -1;
        } else {
            this.colXy = this.colXy2 = xy;
        }
        return col;
    }

    /** Raster 4x4 index and 8x8 index in the colocated macroblock for the current 8x8 block i8. */
    private colBlock(i8: number, corner: boolean): number {
        const x8 = i8 & 1;
        const y8 = i8 >> 1;
        if (!this.colMixed) return corner ? y8 * 3 * 4 + x8 * 3 : y8 * 2 * 4 + x8 * 2;
        if (this.colVertShift === 1) {
            const row = (this.mbY & 1 ? 2 : 0) + y8;
            return row * 4 + x8 * 3;
        }
        return (y8 ? 2 : 0) * 4 + x8 * 3;
    }

    /** Spatial direct references and vectors of lists 0 and 1. */
    private readonly spatialRef = new Int32Array(2);
    private readonly spatialMvx = new Int32Array(2);
    private readonly spatialMvy = new Int32Array(2);

    /**
     * Sets the four cache blocks of the 8x8 block i8 to the given references and packed vectors of
     * both lists.
     */
    private fillDirect8x8(i8: number, ref0: number, mv0: number, ref1: number, mv1: number): void {
        const p = cacheAt((i8 & 1) * 2, (i8 >> 1) * 2);
        const refs0 = this.refCache[0];
        const refs1 = this.refCache[1];
        const mvs0 = this.mvCache32[0];
        const mvs1 = this.mvCache32[1];
        refs0[p] = refs0[p + 1] = refs0[p + 8] = refs0[p + 9] = ref0;
        refs1[p] = refs1[p + 1] = refs1[p + 8] = refs1[p + 9] = ref1;
        mvs0[p] = mvs0[p + 1] = mvs0[p + 8] = mvs0[p + 9] = mv0;
        mvs1[p] = mvs1[p + 1] = mvs1[p + 8] = mvs1[p + 9] = mv1;
    }

    private deriveSpatialDirect(mask: number): void {
        const ref = this.spatialRef;
        const mvx = this.spatialMvx;
        const mvy = this.spatialMvy;
        mvx[0] = mvx[1] = mvy[0] = mvy[1] = 0;
        for (let list = 0; list < 2; list++) {
            const refCache = this.refCache[list];
            const mvCache = this.mvCache[list];
            const a = cacheAt(-1, 0);
            const b = cacheAt(0, -1);
            let c = cacheAt(4, -1);
            let refC = refCache[c];
            if (refC === PART_NOT_AVAILABLE) {
                c = cacheAt(-1, -1);
                refC = refCache[c];
            }
            const refA = refCache[a];
            const refB = refCache[b];
            let r = -1;
            if (refA >= 0) r = refA;
            if (refB >= 0 && (r < 0 || refB < r)) r = refB;
            if (refC >= 0 && (r < 0 || refC < r)) r = refC;
            ref[list] = r;
            if (r >= 0) {
                const matches = (refA === r ? 1 : 0) + (refB === r ? 1 : 0) + (refC === r ? 1 : 0);
                if (matches > 1) {
                    mvx[list] = median(mvCache[a * 2], mvCache[b * 2], mvCache[c * 2]);
                    mvy[list] = median(mvCache[a * 2 + 1], mvCache[b * 2 + 1], mvCache[c * 2 + 1]);
                } else {
                    const pos = refA === r ? a : refB === r ? b : c;
                    mvx[list] = mvCache[pos * 2];
                    mvy[list] = mvCache[pos * 2 + 1];
                }
            }
        }
        if (ref[0] < 0 && ref[1] < 0) {
            ref[0] = ref[1] = 0;
        }
        const ref0 = ref[0];
        const ref1 = ref[1];
        const mv0 = ref0 >= 0 ? packMv(mvx[0], mvy[0]) : 0;
        const mv1 = ref1 >= 0 ? packMv(mvx[1], mvy[1]) : 0;
        const colRef = this.lists[1][0];
        if (!(mvx[0] | mvy[0] | mvx[1] | mvy[1]) || !colRef || colRef.longTerm) {
            for (let i8 = 0; i8 < 4; i8++)
                if (mask & (1 << i8)) this.fillDirect8x8(i8, ref0, mv0, ref1, mv1);
            return;
        }
        const col = this.locateColocated();
        const colRef0 = col.ref[0];
        const colRef1 = col.ref[1];
        const inference = this.direct8x8Inference || this.colMixed;
        for (let i8 = 0; i8 < 4; i8++) {
            if (!(mask & (1 << i8))) continue;
            this.fillDirect8x8(i8, ref0, mv0, ref1, mv1);
            const colXy =
                this.colMixed && this.colVertShift === -1 && i8 >= 2 ? this.colXy2 : this.colXy;
            if (col.mbFlags[colXy] & MB_INTRA) continue;
            const b8 = this.colVertShift === 1 ? (this.mbY & 1) * 2 + (i8 & 1) : i8;
            const r0 = colRef0[colXy * 4 + b8];
            const r1 = colRef1[colXy * 4 + b8];
            let colMv: Int16Array;
            if (r0 === 0) colMv = col.mv[0];
            else if (r0 < 0 && r1 === 0) colMv = col.mv[1];
            else continue;

            // colZeroFlag: references at index 0 take a zero vector where the colocated vector is
            // within +-1.
            if (inference) {
                const blk = this.colBlock(i8, true);
                const mx = colMv[colXy * 32 + blk * 2];
                const my = colMv[colXy * 32 + blk * 2 + 1];
                if (mx >= -1 && mx <= 1 && my >= -1 && my <= 1) {
                    this.fillDirect8x8(i8, ref0, ref0 === 0 ? 0 : mv0, ref1, ref1 === 0 ? 0 : mv1);
                }
            } else {
                const x4 = (i8 & 1) * 2;
                const y4 = (i8 >> 1) * 2;
                for (let i4 = 0; i4 < 4; i4++) {
                    const bx = x4 + (i4 & 1);
                    const by = y4 + (i4 >> 1);
                    const blk = by * 4 + bx;
                    const mx = colMv[colXy * 32 + blk * 2];
                    const my = colMv[colXy * 32 + blk * 2 + 1];
                    if (mx >= -1 && mx <= 1 && my >= -1 && my <= 1) {
                        const p = cacheAt(bx, by);
                        if (ref0 === 0) this.mvCache32[0][p] = 0;
                        if (ref1 === 0) this.mvCache32[1][p] = 0;
                    }
                }
            }
        }
    }

    private deriveTemporalDirect(mask: number): void {
        const ref1 = this.lists[1][0];
        if (!ref1) {
            for (let i8 = 0; i8 < 4; i8++) if (mask & (1 << i8)) this.fillDirect8x8(i8, 0, 0, 0, 0);
            return;
        }
        const col = this.locateColocated();
        const list0 = this.lists[0];
        const fieldMb = this.mbField;
        const distScale =
            this.mbaff && fieldMb && this.ctx.distScaleField
                ? this.ctx.distScaleField[this.mbY & 1]
                : this.ctx.distScale;
        const inference = this.direct8x8Inference || this.colMixed;
        for (let i8 = 0; i8 < 4; i8++) {
            if (!(mask & (1 << i8))) continue;
            const x4 = (i8 & 1) * 2;
            const y4 = (i8 >> 1) * 2;
            const colXy =
                this.colMixed && this.colVertShift === -1 && i8 >= 2 ? this.colXy2 : this.colXy;
            if (col.mbFlags[colXy] & MB_INTRA) {
                this.fillDirect8x8(i8, 0, 0, 0, 0);
                continue;
            }
            const b8 = this.colVertShift === 1 ? (this.mbY & 1) * 2 + (i8 & 1) : i8;
            let colList = 0;
            let refCol = col.ref[0][colXy * 4 + b8];
            if (refCol < 0) {
                colList = 1;
                refCol = col.ref[1][colXy * 4 + b8];
            }
            const refIdCol = col.refId[colList][colXy * 4 + b8];
            const colFieldMb = (col.mbFlags[colXy] & MB_FIELD) !== 0;
            const refIdx0 = this.mapColToList0(refIdCol, list0, colFieldMb, fieldMb);
            const scale = distScale[refIdx0];
            const colMv = col.mv[colList];
            const blocks = inference ? 1 : 4;
            for (let i4 = 0; i4 < blocks; i4++) {
                const bx = x4 + (i4 & 1);
                const by = y4 + (i4 >> 1);
                const blk = inference ? this.colBlock(i8, true) : by * 4 + bx;
                const mvColX = colMv[colXy * 32 + blk * 2];
                let mvColY = colMv[colXy * 32 + blk * 2 + 1];
                if (this.colVertShift === 1) mvColY *= 2;
                else if (this.colVertShift === -1)
                    mvColY = mvColY < 0 ? -(-mvColY >> 1) : mvColY >> 1;
                const mx = (scale * mvColX + 128) >> 8;
                const my = (scale * mvColY + 128) >> 8;
                const mv0 = packMv(clipMv(mx), clipMv(my));
                const mv1 = packMv(clipMv(mx - mvColX), clipMv(my - mvColY));
                if (inference) this.fillDirect8x8(i8, refIdx0, mv0, 0, mv1);
                else {
                    const p = cacheAt(bx, by);
                    this.refCache[0][p] = refIdx0;
                    this.refCache[1][p] = 0;
                    this.mvCache32[0][p] = mv0;
                    this.mvCache32[1][p] = mv1;
                }
            }
        }
    }

    /**
     * MapColToList0 (8.4.1.2.3): the lowest index of RefPicList0 referencing the colocated block's
     * reference.
     */
    private mapColToList0(
        refId: number,
        list0: readonly RefEntry[],
        colFieldMb: boolean,
        curFieldMb: boolean,
    ): number {
        if (refId < 0) return 0;
        const serial = refId >> 2;
        const parity = refId & 3;
        let wantParity: number;
        if (curFieldMb && colFieldMb) wantParity = parity;
        else if (curFieldMb)
            wantParity = this.mbaff ? (this.mbY & 1 ? PICT_BOTTOM : PICT_TOP) : this.ctx.structure;
        else wantParity = PICT_FRAME;
        for (let i = 0; i < list0.length; i++) {
            const entry = list0[i];
            if (
                entry.id >> 2 === serial &&
                (wantParity === PICT_FRAME
                    ? entry.parity === PICT_FRAME
                    : entry.parity === wantParity)
            )
                return i;
        }
        return 0;
    }

    // ---------------------------------------------------------------------------------------------
    // CAVLC macroblock layer

    private decodeMbCavlc(): void {
        const br = this.br;
        let mbType = br.ue();
        const sliceType = this.sliceType;
        if (sliceType === SLICE_I) {
            this.decodeIntraMbType(mbType);
        } else if (sliceType === SLICE_SI) {
            if (mbType === 0) throw new Error('SI macroblocks are not supported');
            this.decodeIntraMbType(mbType - 1);
        } else if (sliceType === SLICE_P || sliceType === SLICE_SP) {
            if (mbType >= 5) this.decodeIntraMbType(mbType - 5);
            else this.setPMbType(mbType);
        } else {
            if (mbType >= 23) this.decodeIntraMbType(mbType - 23);
            else this.setBMbType(mbType);
        }
        const intra = (this.mbTypeFlags & MB_INTRA) !== 0;
        if (this.mbTypeFlags & MB_PCM) {
            this.decodePcmCavlc();
            return;
        }
        this.fillCaches(intra, !intra);
        this.transform8x8 = false;
        if (intra) {
            if (!(this.mbTypeFlags & MB_INTRA16)) {
                if (this.transform8x8Mode) this.transform8x8 = br.read1() === 1;
                this.readIntraModesCavlc();
            }
            if (this.chromaFormat !== 0) {
                this.mbChromaMode = br.ue();
                if (this.mbChromaMode > 3) throw new Error('intra_chroma_pred_mode out of range');
            }
        } else {
            this.lists = this.currentLists();
            this.readInterPredictionCavlc();
        }
        let cbp: number;
        if (this.mbTypeFlags & MB_INTRA16) cbp = this.mbCbp;
        else {
            const code = br.ue();
            if (code > 47) throw new Error('coded_block_pattern out of range');
            if (this.chromaFormat === 1 || this.chromaFormat === 2)
                cbp = intra ? CBP_INTRA[code] : CBP_INTER[code];
            else {
                if (code > 15) throw new Error('coded_block_pattern out of range');
                cbp = intra ? CBP_INTRA_MONO[code] : CBP_INTER_MONO[code];
            }
            this.mbCbp = cbp;
            if (cbp & 15 && this.transform8x8Mode && !intra && this.noSubMbSmallerThan8x8()) {
                this.transform8x8 = br.read1() === 1;
            }
        }
        if (cbp & 15 || cbp & 48 || this.mbTypeFlags & MB_INTRA16) {
            const delta = br.se();
            if (delta < -26 || delta > 25) throw new Error('mb_qp_delta out of range');
            this.lastQpDelta = delta;
            this.qpY = (((this.qpY + delta + 52) % 52) + 52) % 52;
            this.readResidualCavlc();
        } else {
            this.lastQpDelta = 0;
            this.clearNnz();
        }
        this.reconstruct();
        this.storeMacroblock(false);
    }

    private noSubMbSmallerThan8x8(): boolean {
        if (this.mbTypeFlags & MB_DIRECT16) return this.direct8x8Inference;
        if (this.partShape !== SHAPE_8X8) return true;
        for (let i = 0; i < 4; i++) {
            if (this.sliceType === SLICE_B && this.subPred[i] === 0) {
                if (!this.direct8x8Inference) return false;
            } else if (this.subShape[i] !== SUB_8X8) return false;
        }
        return true;
    }

    private decodeIntraMbType(type: number): void {
        if (type > 25) throw new Error('mb_type out of range');
        this.partShape = SHAPE_16X16;
        if (type === 0) {
            this.mbTypeFlags = MB_INTRA;
            this.mbCbp = 0;
        } else if (type === 25) {
            this.mbTypeFlags = MB_INTRA | MB_PCM;
            this.mbCbp = 0x2f;
        } else {
            this.mbTypeFlags = MB_INTRA | MB_INTRA16;
            this.i16Mode = (type - 1) & 3;
            const chroma = Math.floor((type - 1) / 4) % 3;
            this.mbCbp = (type >= 13 ? 15 : 0) | (chroma << 4);
        }
    }

    private setPMbType(type: number): void {
        this.mbTypeFlags = 0;
        this.partShape =
            type === 0
                ? SHAPE_16X16
                : type === 1
                  ? SHAPE_16X8
                  : type === 2
                    ? SHAPE_8X16
                    : SHAPE_8X8;
        this.mbType = type;
        this.partPred[0] = this.partPred[1] = this.partPred[2] = this.partPred[3] = PRED_L0;
    }

    private setBMbType(type: number): void {
        this.mbTypeFlags = 0;
        this.mbType = type;
        if (type === 0) {
            this.mbTypeFlags = MB_DIRECT16;
            this.partShape = SHAPE_16X16;
            return;
        }
        if (type === 22) {
            this.partShape = SHAPE_8X8;
            return;
        }
        this.partShape = B_PARTITION_SHAPE[type];
        this.partPred[0] = B_PARTITION_PRED[type * 2];
        this.partPred[1] = B_PARTITION_PRED[type * 2 + 1];
    }

    private readIntraModesCavlc(): void {
        const br = this.br;
        const blocks = this.transform8x8 ? 4 : 16;
        for (let i = 0; i < blocks; i++) {
            const flag = br.read1();
            const rem = flag ? -1 : br.read(3);
            this.setIntraMode(i, rem);
        }
    }

    /**
     * Stores the predicted or remaining intra mode of block i (4x4 blkIdx or 8x8 index) into the
     * cache.
     */
    private setIntraMode(i: number, rem: number): void {
        const cache = this.intraCache;
        let x: number;
        let y: number;
        if (this.transform8x8) {
            x = (i & 1) * 2;
            y = (i >> 1) * 2;
        } else {
            x = BLOCK_X[i];
            y = BLOCK_Y[i];
        }
        const a = cache[cacheAt(x - 1, y)];
        const b = cache[cacheAt(x, y - 1)];
        const predicted = a < 0 || b < 0 ? 2 : Math.min(a, b);
        const mode = rem < 0 ? predicted : rem < predicted ? rem : rem + 1;
        if (this.transform8x8) {
            cache[cacheAt(x, y)] =
                cache[cacheAt(x + 1, y)] =
                cache[cacheAt(x, y + 1)] =
                cache[cacheAt(x + 1, y + 1)] =
                    mode;
        } else cache[cacheAt(x, y)] = mode;
    }

    private refIdxPresent(list: number): boolean {
        return this.numRefActive[list] > 1 || (this.mbField && !this.fieldPicture);
    }

    private refIdxRange(list: number): number {
        return this.numRefActive[list] * (this.mbField && !this.fieldPicture ? 2 : 1);
    }

    private readInterPredictionCavlc(): void {
        const br = this.br;
        const bSlice = this.sliceType === SLICE_B;
        const listCount = bSlice ? 2 : 1;
        if (this.mbTypeFlags & MB_DIRECT16) {
            this.mbDirect = 15;
            this.deriveDirect(15);
            return;
        }
        this.mbDirect = 0;
        if (this.partShape === SHAPE_8X8) {
            let directMask = 0;
            for (let i = 0; i < 4; i++) {
                const sub = br.ue();
                if (bSlice) {
                    if (sub > 12) throw new Error('sub_mb_type out of range');
                    this.subPred[i] = B_SUB_PRED[sub];
                    this.subShape[i] = B_SUB_SHAPE[sub];
                    if (sub === 0) directMask |= 1 << i;
                } else {
                    if (sub > 3) throw new Error('sub_mb_type out of range');
                    this.subPred[i] = PRED_L0;
                    this.subShape[i] = sub;
                }
            }
            this.mbDirect = directMask;
            if (directMask) this.deriveDirect(directMask);
            const allRef0 = !bSlice && this.mbType === 4;
            for (let list = 0; list < listCount; list++) {
                for (let i = 0; i < 4; i++) {
                    if (directMask & (1 << i) || !(this.subPred[i] & (1 << list))) continue;
                    let ref = 0;
                    if (!allRef0 && this.refIdxPresent(list)) {
                        ref = br.te(this.refIdxRange(list) - 1);
                        if (ref >= this.refIdxRange(list)) throw new Error('ref_idx out of range');
                    }
                    this.refIdxParsed[list * 4 + i] = ref;
                }
            }
            for (let list = 0; list < listCount; list++) {
                for (let i = 0; i < 4; i++) {
                    if (directMask & (1 << i)) continue;
                    if (!(this.subPred[i] & (1 << list))) {
                        this.fillRef(list, (i & 1) * 2, (i >> 1) * 2, 2, 2, LIST_NOT_USED);
                        continue;
                    }
                    const ref = this.refIdxParsed[list * 4 + i];
                    this.readSubMvdsCavlc(list, i, ref);
                }
            }
            return;
        }
        const parts = this.partShape === SHAPE_16X16 ? 1 : 2;
        for (let list = 0; list < listCount; list++) {
            for (let p = 0; p < parts; p++) {
                if (!(this.partPred[p] & (1 << list))) continue;
                let ref = 0;
                if (this.refIdxPresent(list)) {
                    ref = br.te(this.refIdxRange(list) - 1);
                    if (ref >= this.refIdxRange(list)) throw new Error('ref_idx out of range');
                }
                this.refIdxParsed[list * 4 + p] = ref;
            }
        }
        for (let list = 0; list < listCount; list++) {
            for (let p = 0; p < parts; p++) {
                const x4 = this.partShape === SHAPE_8X16 ? p * 2 : 0;
                const y4 = this.partShape === SHAPE_16X8 ? p * 2 : 0;
                const w4 = this.partShape === SHAPE_8X16 ? 2 : 4;
                const h4 = this.partShape === SHAPE_16X8 ? 2 : 4;
                if (!(this.partPred[p] & (1 << list))) {
                    this.fillRef(list, x4, y4, w4, h4, LIST_NOT_USED);
                    continue;
                }
                const ref = this.refIdxParsed[list * 4 + p];
                const mvdx = br.se();
                const mvdy = br.se();
                this.predictMv(list, x4, y4, w4, ref, this.partShape, RASTER_TO_BLOCK[y4 * 4 + x4]);
                this.fillMotion(
                    list,
                    x4,
                    y4,
                    w4,
                    h4,
                    ref,
                    clipMv(this.mvTmp[0] + mvdx),
                    clipMv(this.mvTmp[1] + mvdy),
                );
            }
        }
    }

    private readSubMvdsCavlc(list: number, i8: number, ref: number): void {
        const br = this.br;
        const shape = this.subShape[i8];
        const x8 = (i8 & 1) * 2;
        const y8 = (i8 >> 1) * 2;
        const count = shape === SUB_8X8 ? 1 : shape === SUB_4X4 ? 4 : 2;
        for (let s = 0; s < count; s++) {
            let x4 = x8;
            let y4 = y8;
            let w4 = 2;
            let h4 = 2;
            if (shape === SUB_8X4) {
                y4 += s;
                h4 = 1;
            } else if (shape === SUB_4X8) {
                x4 += s;
                w4 = 1;
            } else if (shape === SUB_4X4) {
                x4 += s & 1;
                y4 += s >> 1;
                w4 = h4 = 1;
            }
            const mvdx = br.se();
            const mvdy = br.se();
            this.predictMv(list, x4, y4, w4, ref, SHAPE_8X8, RASTER_TO_BLOCK[y4 * 4 + x4]);
            this.fillMotion(
                list,
                x4,
                y4,
                w4,
                h4,
                ref,
                clipMv(this.mvTmp[0] + mvdx),
                clipMv(this.mvTmp[1] + mvdy),
            );
        }
    }

    private decodePcmCavlc(): void {
        const br = this.br;
        br.align();
        this.readPcmSamples(br.data, br.pos >> 3);
        br.pos += this.pcmBytes() * 8;
        this.finishPcm();
    }

    private pcmBytes(): number {
        return 256 + 2 * this.chromaBlocks * 16;
    }

    /**
     * pcm_sample_luma and pcm_sample_chroma from byte `offset` of the RBSP; bytes past its end read
     * as zero.
     */
    private readPcmSamples(data: Uint8Array, offset: number): void {
        const luma = this.lumaData;
        const end = this.br.byteLength;
        let p = offset;
        for (let y = 0; y < 16; y++) {
            const d = this.lumaOffset + y * this.mbStride;
            for (let x = 0; x < 16; x++, p++) luma[d + x] = p < end ? data[p] : 0;
        }
        if (this.chromaFormat === 0) return;
        for (let plane = 0; plane < 2; plane++) {
            const base = (plane ? this.crBase : this.chromaBase) + this.chromaOffset;
            for (let y = 0; y < this.chromaMbHeight; y++) {
                const d = base + y * this.mbChromaStride;
                for (let x = 0; x < 8; x++, p++) luma[d + x] = p < end ? data[p] : 0;
            }
        }
    }

    private finishPcm(): void {
        this.fillCaches(true, false);
        this.mbCbp = 0x2f;
        this.transform8x8 = false;
        this.mbChromaMode = 0;
        this.lastQpDelta = 0;
        const nnzCache = this.nnzCache;
        for (let i = 0; i < 16; i++) nnzCache[cacheAt(i & 3, i >> 2)] = 16;
        for (let i = 0; i < 16; i++) nnzCache[48 + (i >> 1) * 8 + 4 + (i & 1)] = 16;
        for (let i = 0; i < 16; i++) nnzCache[88 + (i >> 1) * 8 + 4 + (i & 1)] = 16;
        this.storeMacroblock(false);
        this.qp[this.mbXy] = 0;
        this.dcFlags[this.mbXy] = 7;
    }

    // ---------------------------------------------------------------------------------------------
    // CAVLC residual

    private clearNnz(): void {
        const nnzCache = this.nnzCache;
        for (let y = 1; y <= 4; y++) for (let x = 4; x < 8; x++) nnzCache[y * 8 + x] = 0;
        for (let y = 6; y <= 9; y++) for (let x = 4; x < 6; x++) nnzCache[y * 8 + x] = 0;
        for (let y = 11; y <= 14; y++) for (let x = 4; x < 6; x++) nnzCache[y * 8 + x] = 0;
        this.dcFlags[this.mbXy] = 0;
    }

    /** nC for a luma or chroma block from the neighbouring counts in the cache (9.2.1). */
    private nC(pos: number): number {
        const nnzCache = this.nnzCache;
        const a = nnzCache[pos - 1];
        const b = nnzCache[pos - 8];
        if (a < 64 && b < 64) return (a + b + 1) >> 1;
        if (a < 64) return a;
        if (b < 64) return b;
        return 0;
    }

    private readResidualCavlc(): void {
        const br = this.br;
        const coeffs = this.coeffs;
        const nnzCache = this.nnzCache;
        const cbp = this.mbCbp;
        const field = this.mbField;
        const scan4 = field ? FIELD_4X4 : ZIGZAG_4X4;
        const intra = (this.mbTypeFlags & MB_INTRA) !== 0;
        const qp = this.qpY;
        const scaling = this.ctx.scaling;
        this.clearNnz();
        const i16 = (this.mbTypeFlags & MB_INTRA16) !== 0;
        let dcFlags = 0;
        if (i16) {
            const total = readResidualCavlc(
                br,
                this.dcCoeffs,
                0,
                scan4,
                0,
                16,
                coeffTokenTable(this.nC(cacheAt(0, 0))),
                UNIT_SCALE,
                0,
            );
            if (total < 0) throw new Error('damaged Intra16x16 DC block');
            if (total > 0) dcFlags |= 1;
        }
        if (cbp & 15) {
            if (this.transform8x8) {
                const scans = SCAN_8X8_CAVLC[field ? 1 : 0];
                const scale = scaling.dequant8[intra ? 0 : 1];
                for (let i8 = 0; i8 < 4; i8++) {
                    if (!(cbp & (1 << i8))) continue;
                    for (let g = 0; g < 4; g++) {
                        const blk = i8 * 4 + g;
                        const pos = cacheAt(BLOCK_X[blk], BLOCK_Y[blk]);
                        const total = readResidualCavlc(
                            br,
                            coeffs,
                            i8 * 64,
                            scans[g],
                            0,
                            16,
                            coeffTokenTable(this.nC(pos)),
                            scale,
                            qp * 64,
                        );
                        if (total < 0) throw new Error('damaged luma block');
                        nnzCache[pos] = total;
                    }
                }
            } else {
                const scale = scaling.dequant4[intra ? 0 : 3];
                const first = i16 ? 1 : 0;
                const count = i16 ? 15 : 16;
                for (let i8 = 0; i8 < 4; i8++) {
                    if (!(cbp & (1 << i8))) continue;
                    for (let g = 0; g < 4; g++) {
                        const blk = i8 * 4 + g;
                        const pos = cacheAt(BLOCK_X[blk], BLOCK_Y[blk]);
                        const total = readResidualCavlc(
                            br,
                            coeffs,
                            BLOCK_RASTER[blk] * 16,
                            scan4,
                            first,
                            count,
                            coeffTokenTable(this.nC(pos)),
                            scale,
                            qp * 16,
                        );
                        if (total < 0) throw new Error('damaged luma block');
                        nnzCache[pos] = total;
                    }
                }
            }
        }
        if (this.chromaFormat !== 0 && cbp & 48) {
            const blocks = this.chromaBlocks;
            for (let plane = 0; plane < 2; plane++) {
                const total = readResidualCavlc(
                    br,
                    this.dcCoeffs,
                    16 + plane * 8,
                    blocks === 4 ? CHROMA_DC_SCAN_420 : CHROMA_DC_SCAN_422,
                    0,
                    blocks,
                    blocks === 4 ? 4 : 5,
                    UNIT_SCALE,
                    0,
                );
                if (total < 0) throw new Error('damaged chroma DC block');
                if (total > 0) dcFlags |= 2 << plane;
            }
        }
        if (this.chromaFormat !== 0 && cbp & 32) {
            const blocks = this.chromaBlocks;
            for (let plane = 0; plane < 2; plane++) {
                const cacheBase = plane ? 88 : 48;
                const scale = scaling.dequant4[(intra ? 1 : 4) + plane];
                const scaleOffset = this.chromaQp(plane) * 16;
                for (let b = 0; b < blocks; b++) {
                    const pos = cacheBase + CHROMA_BLOCK_Y[b] * 8 + 4 + CHROMA_BLOCK_X[b];
                    const total = readResidualCavlc(
                        br,
                        coeffs,
                        256 + (plane * 8 + b) * 16,
                        scan4,
                        1,
                        15,
                        coeffTokenTable(this.nC(pos)),
                        scale,
                        scaleOffset,
                    );
                    if (total < 0) throw new Error('damaged chroma AC block');
                    nnzCache[pos] = total;
                }
            }
        }
        this.dcFlags[this.mbXy] = dcFlags;
    }

    // ---------------------------------------------------------------------------------------------
    // CABAC macroblock layer

    private decodeMbCabac(): void {
        const cabac = this.cabac;
        const sliceType = this.sliceType;
        const flags = this.picture.mbFlags;
        if (sliceType === SLICE_I || sliceType === SLICE_SI) {
            if (sliceType === SLICE_SI) throw new Error('SI macroblocks are not supported');
            this.decodeIntraMbType(this.decodeIMbTypeCabac(3, true));
        } else if (sliceType === SLICE_P || sliceType === SLICE_SP) {
            if (cabac.decodeBin(14)) this.decodeIntraMbType(this.decodeIMbTypeCabac(17, false));
            else {
                let type: number;
                if (cabac.decodeBin(15)) type = cabac.decodeBin(17) ? 1 : 2;
                else type = cabac.decodeBin(16) ? 3 : 0;
                this.setPMbType(type);
            }
        } else {
            let ctx = 0;
            const left = this.leftMb[0];
            if (this.leftAvail[0] && !(flags[left] & (MB_SKIP | MB_DIRECT16))) ctx++;
            if (this.topAvail && !(flags[this.topXy] & (MB_SKIP | MB_DIRECT16))) ctx++;
            const type = this.decodeBMbTypeCabac(ctx);
            if (type >= 23) this.decodeIntraMbType(this.decodeIMbTypeCabac(32, false));
            else this.setBMbType(type);
        }
        this.decodeMbCabacRest();
    }

    /** decodeMbCabac after mb_type. */
    private decodeMbCabacRest(): void {
        const cabac = this.cabac;
        const intra = (this.mbTypeFlags & MB_INTRA) !== 0;
        if (this.mbTypeFlags & MB_PCM) {
            const start = Math.ceil(this.cabac.bitsConsumed / 8);
            this.readPcmSamples(this.br.data, start);
            this.cabac.init(this.cabacData, start + this.pcmBytes(), this.br.byteLength);
            this.finishPcm();
            return;
        }
        this.fillCaches(intra, !intra);
        this.transform8x8 = false;
        if (intra) {
            if (!(this.mbTypeFlags & MB_INTRA16)) {
                if (this.transform8x8Mode)
                    this.transform8x8 = cabac.decodeBin(399 + this.transform8x8Context()) === 1;
                const blocks = this.transform8x8 ? 4 : 16;
                for (let i = 0; i < blocks; i++) {
                    let rem = -1;
                    if (!cabac.decodeBin(68)) {
                        rem = cabac.decodeBin(69);
                        rem |= cabac.decodeBin(69) << 1;
                        rem |= cabac.decodeBin(69) << 2;
                    }
                    this.setIntraMode(i, rem);
                }
            }
            if (this.chromaFormat !== 0) this.mbChromaMode = this.decodeChromaModeCabac();
        } else {
            this.lists = this.currentLists();
            this.readInterPredictionCabac();
        }
        let cbp: number;
        if (this.mbTypeFlags & MB_INTRA16) cbp = this.mbCbp;
        else {
            cbp = this.decodeCbpCabac();
            this.mbCbp = cbp;
            if (cbp & 15 && this.transform8x8Mode && !intra && this.noSubMbSmallerThan8x8()) {
                this.transform8x8 = cabac.decodeBin(399 + this.transform8x8Context()) === 1;
            }
        }
        if (cbp & 15 || cbp & 48 || this.mbTypeFlags & MB_INTRA16) {
            const delta = this.decodeQpDeltaCabac();
            this.lastQpDelta = delta;
            this.qpY = (((this.qpY + delta + 52) % 52) + 52) % 52;
            this.readResidualCabac();
        } else {
            this.lastQpDelta = 0;
            this.clearNnz();
        }
        this.reconstruct();
        this.storeMacroblock(false);
    }

    private decodeIMbTypeCabac(base: number, intraSlice: boolean): number {
        const cabac = this.cabac;
        const flags = this.picture.mbFlags;
        let ctx = 0;
        if (intraSlice) {
            const left = this.leftMb[0];
            if (
                this.leftAvail[0] &&
                (flags[left] & (MB_INTRA16 | MB_PCM) || !(flags[left] & MB_INTRA))
            )
                ctx++;
            if (
                this.topAvail &&
                (flags[this.topXy] & (MB_INTRA16 | MB_PCM) || !(flags[this.topXy] & MB_INTRA))
            )
                ctx++;
            if (!cabac.decodeBin(base + ctx)) return 0;
        } else if (!cabac.decodeBin(base)) return 0;
        if (cabac.decodeTerminate()) return 25;
        const s = base + (intraSlice ? 2 : 0);
        const k = intraSlice ? 1 : 0;
        let type = 1;
        type += 12 * cabac.decodeBin(s + 1);
        if (cabac.decodeBin(s + 2)) type += 4 + 4 * cabac.decodeBin(s + 2 + k);
        type += 2 * cabac.decodeBin(s + 3 + k);
        type += cabac.decodeBin(s + 3 + 2 * k);
        return type;
    }

    private decodeBMbTypeCabac(ctx: number): number {
        const cabac = this.cabac;
        if (!cabac.decodeBin(27 + ctx)) return 0;
        if (!cabac.decodeBin(27 + 3)) return 1 + cabac.decodeBin(27 + 5);
        let bits = cabac.decodeBin(27 + 4) << 3;
        bits |= cabac.decodeBin(27 + 5) << 2;
        bits |= cabac.decodeBin(27 + 5) << 1;
        bits |= cabac.decodeBin(27 + 5);
        if (bits < 8) return bits + 3;
        if (bits === 13) return 23;
        if (bits === 14) return 11;
        if (bits === 15) return 22;
        bits = (bits << 1) | cabac.decodeBin(27 + 5);
        return bits - 4;
    }

    private transform8x8Context(): number {
        const flags = this.picture.mbFlags;
        let ctx = 0;
        if (this.leftAvail[0] && flags[this.leftMb[0]] & MB_T8X8) ctx++;
        if (this.topAvail && flags[this.topXy] & MB_T8X8) ctx++;
        return ctx;
    }

    private decodeChromaModeCabac(): number {
        const cabac = this.cabac;
        const flags = this.picture.mbFlags;
        const chromaMode = this.chromaMode;
        let ctx = 0;
        const left = this.leftMb[0];
        if (
            this.leftAvail[0] &&
            flags[left] & MB_INTRA &&
            !(flags[left] & MB_PCM) &&
            chromaMode[left] !== 0
        )
            ctx++;
        if (
            this.topAvail &&
            flags[this.topXy] & MB_INTRA &&
            !(flags[this.topXy] & MB_PCM) &&
            chromaMode[this.topXy] !== 0
        )
            ctx++;
        if (!cabac.decodeBin(64 + ctx)) return 0;
        if (!cabac.decodeBin(64 + 3)) return 1;
        if (!cabac.decodeBin(64 + 3)) return 2;
        return 3;
    }

    private decodeQpDeltaCabac(): number {
        const cabac = this.cabac;
        let ctx = this.lastQpDelta !== 0 ? 1 : 0;
        let val = 0;
        while (cabac.decodeBin(60 + ctx)) {
            ctx = 2 + (ctx >> 1);
            val++;
            if (val > 104) throw new Error('mb_qp_delta out of range');
        }
        return val & 1 ? (val + 1) >> 1 : -(val >> 1);
    }

    /**
     * Neighbour coded_block_pattern as seen for the coded_block_pattern contexts (9.3.3.1.1.4):
     * luma bits 0..3, chroma value in bits 4..5; unavailable and I_PCM neighbours read as all
     * coded, skipped ones as uncoded.
     */
    private neighbourCbp(mb: number, avail: boolean): number {
        if (!avail) return 0x0f;
        const flags = this.picture.mbFlags[mb];
        if (flags & MB_PCM) return 0x3f;
        if (flags & MB_SKIP) return 0;
        return this.cbp[mb];
    }

    private decodeCbpCabac(): number {
        const cabac = this.cabac;
        const leftBlock = this.leftBlock;
        const a0 = this.neighbourCbp(this.leftMb[0], this.leftAvail[0]);
        const a1 = this.neighbourCbp(this.leftMb[1], this.leftAvail[1]);
        const b = this.neighbourCbp(this.topXy, this.topAvail);
        const bitA0 = (a0 >> ((leftBlock[0] >> 1) * 2 + 1)) & 1;
        const bitA2 = (a1 >> ((leftBlock[2] >> 1) * 2 + 1)) & 1;
        let cbp = 0;
        let ctx = (bitA0 ? 0 : 1) + (b & 4 ? 0 : 2);
        cbp |= cabac.decodeBin(73 + ctx);
        ctx = (cbp & 1 ? 0 : 1) + (b & 8 ? 0 : 2);
        cbp |= cabac.decodeBin(73 + ctx) << 1;
        ctx = (bitA2 ? 0 : 1) + (cbp & 1 ? 0 : 2);
        cbp |= cabac.decodeBin(73 + ctx) << 2;
        ctx = (cbp & 4 ? 0 : 1) + (cbp & 2 ? 0 : 2);
        cbp |= cabac.decodeBin(73 + ctx) << 3;
        if (this.chromaFormat === 1 || this.chromaFormat === 2) {
            ctx = (a0 & 0x30 ? 1 : 0) + (b & 0x30 ? 2 : 0);
            if (cabac.decodeBin(77 + ctx)) {
                ctx = 4 + (a0 & 0x20 ? 1 : 0) + (b & 0x20 ? 2 : 0);
                cbp += 16 + 16 * cabac.decodeBin(77 + ctx);
            }
        }
        return cbp;
    }

    private readInterPredictionCabac(): void {
        const bSlice = this.sliceType === SLICE_B;
        const listCount = bSlice ? 2 : 1;
        if (this.mbTypeFlags & MB_DIRECT16) {
            this.mbDirect = 15;
            this.deriveDirect(15);
            this.fillMvd(0, 0, 0, 4, 4, 0, 0);
            this.fillMvd(1, 0, 0, 4, 4, 0, 0);
            return;
        }
        this.mbDirect = 0;
        const cabac = this.cabac;
        if (this.partShape === SHAPE_8X8) {
            let directMask = 0;
            for (let i = 0; i < 4; i++) {
                if (bSlice) {
                    const sub = this.decodeBSubTypeCabac();
                    this.subPred[i] = B_SUB_PRED[sub];
                    this.subShape[i] = B_SUB_SHAPE[sub];
                    if (sub === 0) directMask |= 1 << i;
                } else {
                    let sub: number;
                    if (cabac.decodeBin(21)) sub = 0;
                    else if (!cabac.decodeBin(22)) sub = 1;
                    else sub = cabac.decodeBin(23) ? 2 : 3;
                    this.subPred[i] = PRED_L0;
                    this.subShape[i] = sub;
                }
            }
            this.mbDirect = directMask;
            if (directMask) {
                this.deriveDirect(directMask);
                for (let i = 0; i < 4; i++) {
                    if (!(directMask & (1 << i))) continue;
                    this.fillMvd(0, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
                    this.fillMvd(1, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
                }
            }
            for (let list = 0; list < listCount; list++) {
                for (let i = 0; i < 4; i++) {
                    if (directMask & (1 << i)) continue;
                    if (!(this.subPred[i] & (1 << list))) {
                        this.fillRef(list, (i & 1) * 2, (i >> 1) * 2, 2, 2, LIST_NOT_USED);
                        continue;
                    }
                    let ref = 0;
                    if (this.refIdxPresent(list)) {
                        ref = this.decodeRefIdxCabac(list, (i & 1) * 2, (i >> 1) * 2);
                        if (ref >= this.refIdxRange(list)) throw new Error('ref_idx out of range');
                    }
                    this.fillRef(list, (i & 1) * 2, (i >> 1) * 2, 2, 2, ref);
                    this.refIdxParsed[list * 4 + i] = ref;
                }
            }
            for (let list = 0; list < listCount; list++) {
                for (let i = 0; i < 4; i++) {
                    if (directMask & (1 << i) || !(this.subPred[i] & (1 << list))) {
                        if (!(directMask & (1 << i)))
                            this.fillMvd(list, (i & 1) * 2, (i >> 1) * 2, 2, 2, 0, 0);
                        continue;
                    }
                    this.readSubMvdsCabac(list, i, this.refIdxParsed[list * 4 + i]);
                }
            }
            return;
        }
        const parts = this.partShape === SHAPE_16X16 ? 1 : 2;
        for (let list = 0; list < listCount; list++) {
            for (let p = 0; p < parts; p++) {
                const x4 = this.partShape === SHAPE_8X16 ? p * 2 : 0;
                const y4 = this.partShape === SHAPE_16X8 ? p * 2 : 0;
                const w4 = this.partShape === SHAPE_8X16 ? 2 : 4;
                const h4 = this.partShape === SHAPE_16X8 ? 2 : 4;
                if (!(this.partPred[p] & (1 << list))) {
                    this.fillRef(list, x4, y4, w4, h4, LIST_NOT_USED);
                    continue;
                }
                let ref = 0;
                if (this.refIdxPresent(list)) {
                    ref = this.decodeRefIdxCabac(list, x4, y4);
                    if (ref >= this.refIdxRange(list)) throw new Error('ref_idx out of range');
                }
                this.fillRef(list, x4, y4, w4, h4, ref);
                this.refIdxParsed[list * 4 + p] = ref;
            }
        }
        for (let list = 0; list < listCount; list++) {
            for (let p = 0; p < parts; p++) {
                const x4 = this.partShape === SHAPE_8X16 ? p * 2 : 0;
                const y4 = this.partShape === SHAPE_16X8 ? p * 2 : 0;
                const w4 = this.partShape === SHAPE_8X16 ? 2 : 4;
                const h4 = this.partShape === SHAPE_16X8 ? 2 : 4;
                if (!(this.partPred[p] & (1 << list))) {
                    this.fillMvd(list, x4, y4, w4, h4, 0, 0);
                    continue;
                }
                const ref = this.refIdxParsed[list * 4 + p];
                const mvdx = this.decodeMvdCabac(list, x4, y4, 0);
                const mvdy = this.decodeMvdCabac(list, x4, y4, 1);
                this.predictMv(list, x4, y4, w4, ref, this.partShape, RASTER_TO_BLOCK[y4 * 4 + x4]);
                this.fillMotion(
                    list,
                    x4,
                    y4,
                    w4,
                    h4,
                    ref,
                    clipMv(this.mvTmp[0] + mvdx),
                    clipMv(this.mvTmp[1] + mvdy),
                );
                this.fillMvd(list, x4, y4, w4, h4, mvdx, mvdy);
            }
        }
    }

    private readSubMvdsCabac(list: number, i8: number, ref: number): void {
        const shape = this.subShape[i8];
        const x8 = (i8 & 1) * 2;
        const y8 = (i8 >> 1) * 2;
        const count = shape === SUB_8X8 ? 1 : shape === SUB_4X4 ? 4 : 2;
        for (let s = 0; s < count; s++) {
            let x4 = x8;
            let y4 = y8;
            let w4 = 2;
            let h4 = 2;
            if (shape === SUB_8X4) {
                y4 += s;
                h4 = 1;
            } else if (shape === SUB_4X8) {
                x4 += s;
                w4 = 1;
            } else if (shape === SUB_4X4) {
                x4 += s & 1;
                y4 += s >> 1;
                w4 = h4 = 1;
            }
            const mvdx = this.decodeMvdCabac(list, x4, y4, 0);
            const mvdy = this.decodeMvdCabac(list, x4, y4, 1);
            this.predictMv(list, x4, y4, w4, ref, SHAPE_8X8, RASTER_TO_BLOCK[y4 * 4 + x4]);
            this.fillMotion(
                list,
                x4,
                y4,
                w4,
                h4,
                ref,
                clipMv(this.mvTmp[0] + mvdx),
                clipMv(this.mvTmp[1] + mvdy),
            );
            this.fillMvd(list, x4, y4, w4, h4, mvdx, mvdy);
        }
    }

    private decodeBSubTypeCabac(): number {
        const cabac = this.cabac;
        if (!cabac.decodeBin(36)) return 0;
        if (!cabac.decodeBin(37)) return 1 + cabac.decodeBin(39);
        let type = 3;
        if (cabac.decodeBin(38)) {
            if (cabac.decodeBin(39)) return 11 + cabac.decodeBin(39);
            type += 4;
        }
        type += 2 * cabac.decodeBin(39);
        type += cabac.decodeBin(39);
        return type;
    }

    private decodeRefIdxCabac(list: number, x4: number, y4: number): number {
        const cabac = this.cabac;
        const refCache = this.refCache[list];
        const directCache = this.directCache;
        const a = cacheAt(x4 - 1, y4);
        const b = cacheAt(x4, y4 - 1);
        let ctx = 0;
        if (refCache[a] > 0 && !directCache[a]) ctx++;
        if (refCache[b] > 0 && !directCache[b]) ctx += 2;
        if (!cabac.decodeBin(54 + ctx)) return 0;
        let ref = 1;
        ctx = 4;
        while (cabac.decodeBin(54 + ctx)) {
            ctx = 5;
            ref++;
            if (ref > 32) throw new Error('ref_idx out of range');
        }
        return ref;
    }

    private decodeMvdCabac(list: number, x4: number, y4: number, comp: number): number {
        const cabac = this.cabac;
        const mvdCache = this.mvdCache[list];
        const sum =
            mvdCache[cacheAt(x4 - 1, y4) * 2 + comp] + mvdCache[cacheAt(x4, y4 - 1) * 2 + comp];
        const base = comp ? 47 : 40;
        let ctx = sum < 3 ? 0 : sum > 32 ? 2 : 1;
        if (!cabac.decodeBin(base + ctx)) return 0;
        let mvd = 1;
        ctx = 3;
        while (mvd < 9 && cabac.decodeBin(base + ctx)) {
            if (ctx < 6) ctx++;
            mvd++;
        }
        if (mvd >= 9) mvd += cabac.decodeExpGolombBypass(3);
        return cabac.decodeBypass() ? -mvd : mvd;
    }

    // ---------------------------------------------------------------------------------------------
    // CABAC residual

    /** coded_block_flag ctxIdxInc of a DC block from the neighbouring macroblocks' DC flags. */
    private dcCbfContext(bit: number, intra: boolean): number {
        const flags = this.picture.mbFlags;
        let ctx = 0;
        const left = this.leftMb[0];
        if (this.leftAvail[0]) {
            if (flags[left] & MB_PCM || this.dcFlags[left] & bit) ctx++;
        } else if (intra) ctx++;
        if (this.topAvail) {
            if (flags[this.topXy] & MB_PCM || this.dcFlags[this.topXy] & bit) ctx += 2;
        } else if (intra) ctx += 2;
        return ctx;
    }

    /**
     * Copies the dequantisation tables of `scaling` to kernel memory unless they are there already.
     */
    private useScaling(scaling: ScalingTables): void {
        if (this.kernelScaling === scaling) return;
        this.kernelScaling = scaling;
        for (let list = 0; list < 6; list++) {
            for (let q = 0; q < 6; q++)
                this.sliceWords[(SLICE_BLOCK.LEVEL_DC >> 2) + list * 6 + q] =
                    scaling.level4[list][q * 16];
        }
        const buffer = this.memory!.buffer;
        const scratch = this.memory!.scratch;
        for (let i = 0; i < 6; i++)
            new Int32Array(buffer, scratch + SCRATCH_DEQUANT4 + i * DEQUANT4_BYTES, 52 * 16).set(
                scaling.dequant4[i],
            );
        for (let i = 0; i < 2; i++)
            new Int32Array(buffer, scratch + SCRATCH_DEQUANT8 + i * 4 * 52 * 64, 52 * 64).set(
                scaling.dequant8[i],
            );
    }

    /** readResidualCabac by the kernels, from the engine state handed over in kernel memory. */
    private readResidualKernel(): void {
        this.clearNnz();
        const flagsIn = this.mbTypeFlags;
        const intra = (flagsIn & MB_INTRA) !== 0;
        const i16 = (flagsIn & MB_INTRA16) !== 0;
        const cbp = this.mbCbp;
        const chroma = this.chromaFormat !== 0 && (cbp & 48) !== 0;
        let dcContexts = 0;
        if (i16) dcContexts = this.dcCbfContext(1, intra);
        if (chroma)
            dcContexts |= (this.dcCbfContext(2, intra) << 4) | (this.dcCbfContext(4, intra) << 8);
        const flags =
            (i16 ? 1 : 0) | (intra ? 2 : 0) | (this.transform8x8 ? 4 : 0) | (this.mbField ? 8 : 0);
        const engine = this.engine;
        const cabac = this.cabac;
        cabac.save(engine);
        const dcFlags = this.kernels!.residual_mb(
            this.memory!.scratch,
            cbp,
            flags,
            this.qpY,
            this.chromaFormat !== 0 ? this.chromaQp(0) : 0,
            this.chromaFormat !== 0 ? this.chromaQp(1) : 0,
            dcContexts,
            this.chromaFormat !== 0 ? this.chromaBlocks : 0,
        );
        cabac.restore(engine);
        this.dcFlags[this.mbXy] = dcFlags;
    }

    private readResidualCabac(): void {
        if (this.kernelResidual) {
            this.readResidualKernel();
            return;
        }
        const cabac = this.cabac;
        const coeffs = this.coeffs;
        const nnzCache = this.nnzCache;
        const cbp = this.mbCbp;
        const field = this.mbField ? 1 : 0;
        const scan4 = field ? FIELD_4X4 : ZIGZAG_4X4;
        const intra = (this.mbTypeFlags & MB_INTRA) !== 0;
        const qp = this.qpY;
        const scaling = this.ctx.scaling;
        const sigBase = SIG_BASE[field];
        const lastBase = LAST_BASE[field];
        this.clearNnz();
        const i16 = (this.mbTypeFlags & MB_INTRA16) !== 0;
        let dcFlags = 0;
        if (i16 && cabac.decodeBin(CBF_BASE[CAT_I16_DC] + this.dcCbfContext(1, intra))) {
            cabac.residual(
                sigBase[CAT_I16_DC],
                lastBase[CAT_I16_DC],
                CTX_IDENTITY,
                CTX_IDENTITY,
                16,
                ABS_BASE[CAT_I16_DC],
                4,
                this.dcCoeffs,
                0,
                scan4,
                0,
                UNIT_SCALE,
                0,
            );
            dcFlags |= 1;
        }
        if (cbp & 15) {
            if (this.transform8x8) {
                const scan8 = field ? FIELD_8X8 : ZIGZAG_8X8;
                const scale = scaling.dequant8[intra ? 0 : 1];
                for (let i8 = 0; i8 < 4; i8++) {
                    if (!(cbp & (1 << i8))) continue;
                    const count = cabac.residual(
                        sigBase[CAT_LUMA_8X8],
                        lastBase[CAT_LUMA_8X8],
                        SIG_8X8[field],
                        LAST_8X8,
                        64,
                        ABS_BASE[CAT_LUMA_8X8],
                        4,
                        coeffs,
                        i8 * 64,
                        scan8,
                        0,
                        scale,
                        qp * 64,
                    );
                    const p = cacheAt((i8 & 1) * 2, (i8 >> 1) * 2);
                    nnzCache[p] = nnzCache[p + 1] = nnzCache[p + 8] = nnzCache[p + 9] = count;
                }
            } else {
                const cat = i16 ? CAT_I16_AC : CAT_LUMA_4X4;
                const cbfBase = CBF_BASE[cat];
                const sig = sigBase[cat];
                const lastCtx = lastBase[cat];
                const absCtx = ABS_BASE[cat];
                const first = i16 ? 1 : 0;
                const numCoeff = i16 ? 15 : 16;
                const scale = scaling.dequant4[intra ? 0 : 3];
                const scaleOffset = qp * 16;
                for (let i8 = 0; i8 < 4; i8++) {
                    if (!(cbp & (1 << i8))) continue;
                    for (let g = 0; g < 4; g++) {
                        const blk = i8 * 4 + g;
                        const pos = cacheAt(BLOCK_X[blk], BLOCK_Y[blk]);
                        if (
                            !cabac.decodeBin(
                                cbfBase + (nnzCache[pos - 1] ? 1 : 0) + (nnzCache[pos - 8] ? 2 : 0),
                            )
                        )
                            continue;
                        nnzCache[pos] = cabac.residual(
                            sig,
                            lastCtx,
                            CTX_IDENTITY,
                            CTX_IDENTITY,
                            numCoeff,
                            absCtx,
                            4,
                            coeffs,
                            BLOCK_RASTER[blk] * 16,
                            scan4,
                            first,
                            scale,
                            scaleOffset,
                        );
                    }
                }
            }
        }
        if (this.chromaFormat !== 0 && cbp & 48) {
            const blocks = this.chromaBlocks;
            for (let plane = 0; plane < 2; plane++) {
                if (
                    !cabac.decodeBin(CBF_BASE[CAT_CHROMA_DC] + this.dcCbfContext(2 << plane, intra))
                )
                    continue;
                cabac.residual(
                    sigBase[CAT_CHROMA_DC],
                    lastBase[CAT_CHROMA_DC],
                    blocks === 4 ? CTX_IDENTITY : CTX_CHROMA_DC_422,
                    blocks === 4 ? CTX_IDENTITY : CTX_CHROMA_DC_422,
                    blocks,
                    ABS_BASE[CAT_CHROMA_DC],
                    3,
                    this.dcCoeffs,
                    16 + plane * 8,
                    blocks === 4 ? CHROMA_DC_SCAN_420 : CHROMA_DC_SCAN_422,
                    0,
                    UNIT_SCALE,
                    0,
                );
                dcFlags |= 2 << plane;
            }
        }
        if (this.chromaFormat !== 0 && cbp & 32) {
            const blocks = this.chromaBlocks;
            const cbfBase = CBF_BASE[CAT_CHROMA_AC];
            for (let plane = 0; plane < 2; plane++) {
                const cacheBase = plane ? 88 : 48;
                const scale = scaling.dequant4[(intra ? 1 : 4) + plane];
                const scaleOffset = this.chromaQp(plane) * 16;
                for (let b = 0; b < blocks; b++) {
                    const pos = cacheBase + CHROMA_BLOCK_Y[b] * 8 + 4 + CHROMA_BLOCK_X[b];
                    if (
                        !cabac.decodeBin(
                            cbfBase + (nnzCache[pos - 1] ? 1 : 0) + (nnzCache[pos - 8] ? 2 : 0),
                        )
                    )
                        continue;
                    nnzCache[pos] = cabac.residual(
                        sigBase[CAT_CHROMA_AC],
                        lastBase[CAT_CHROMA_AC],
                        CTX_IDENTITY,
                        CTX_IDENTITY,
                        15,
                        ABS_BASE[CAT_CHROMA_AC],
                        4,
                        coeffs,
                        256 + (plane * 8 + b) * 16,
                        scan4,
                        1,
                        scale,
                        scaleOffset,
                    );
                }
            }
        }
        this.dcFlags[this.mbXy] = dcFlags;
    }

    // ---------------------------------------------------------------------------------------------
    // Reconstruction

    private chromaQp(plane: number): number {
        const offset = this.ctx.pps.chromaQpOffset[plane];
        let qpi = this.qpY + offset;
        qpi = qpi < 0 ? 0 : qpi > 51 ? 51 : qpi;
        return CHROMA_QP[qpi];
    }

    /**
     * Adds the residual of the 4x4 block whose `count` scaled coefficients are at coeffs[offset] to
     * the samples at `o`, through the DC shortcut when only the DC is coded; leaves the
     * coefficients cleared.
     */
    private addBlock4x4(offset: number, count: number, o: number, stride: number): void {
        const coeffs = this.coeffs;
        const dc = coeffs[offset];
        if (count === 1 && dc !== 0) {
            coeffs[offset] = 0;
            this.addDc(dc, o, stride, 4);
        } else this.idct4(offset, o, stride);
    }

    /** idct4x4Add of the coefficients at `offset` to the picture samples at `o`. */
    private idct4(offset: number, o: number, stride: number): void {
        const kernels = this.kernels;
        if (kernels !== null)
            kernels.idct4_add(this.coeffAddress + offset * 4, this.picBase + o, stride);
        else idct4x4Add(this.coeffs, offset, this.clamped, o, stride);
    }

    /** dc4x4Add or dc8x8Add (`size` 4 or 8) to the picture samples at `o`. */
    private addDc(dc: number, o: number, stride: number, size: number): void {
        const kernels = this.kernels;
        if (kernels !== null) kernels.dc_add(dc, this.picBase + o, stride, size);
        else if (size === 4) dc4x4Add(dc, this.clamped, o, stride);
        else dc8x8Add(dc, this.clamped, o, stride);
    }

    /**
     * Adds the residual of the 8x8 block i8 when it has coefficients, as addBlock4x4 does for 4x4
     * blocks.
     */
    private addBlock8x8(i8: number, o: number, stride: number): void {
        const nnzCache = this.nnzCache;
        const p = cacheAt((i8 & 1) * 2, (i8 >> 1) * 2);
        const count = this.cabacMode
            ? nnzCache[p]
            : nnzCache[p] + nnzCache[p + 1] + nnzCache[p + 8] + nnzCache[p + 9];
        if (count === 0) return;
        const coeffs = this.coeffs;
        const offset = i8 * 64;
        const dc = coeffs[offset];
        if (count === 1 && dc !== 0) {
            coeffs[offset] = 0;
            this.addDc(dc, o, stride, 8);
        } else if (this.kernels !== null)
            this.kernels.idct8_add(this.coeffAddress + offset * 4, this.picBase + o, stride);
        else idct8x8Add(coeffs, offset, this.clamped, o, stride);
    }

    private intraAvailability(): number {
        const flags = this.picture.mbFlags;
        const cip = this.constrainedIntra;
        const usable = (xy: number, avail: boolean) =>
            avail && (!cip || (flags[xy] & MB_INTRA) !== 0);
        let a = 0;
        if (usable(this.leftMb[0], this.leftAvail[0])) a |= 1;
        if (usable(this.leftMb[1], this.leftAvail[1])) a |= 2;
        if (this.mbaff && !this.mbField && cip && a && this.leftPairMixed()) {
            const pairTop = this.mbX - 1 + (this.mbY & ~1) * this.mbWidth;
            if (!(flags[pairTop] & MB_INTRA) || !(flags[pairTop + this.mbWidth] & MB_INTRA)) a = 0;
        }
        let avail = 0;
        if (a === 3) avail |= AVAIL_A;
        if (usable(this.topXy, this.topAvail)) avail |= AVAIL_B;
        if (usable(this.topRightXy, this.topRightAvail)) avail |= AVAIL_C;
        if (usable(this.topLeftXy, this.topLeftAvail)) avail |= AVAIL_D;
        this.leftUsable = a;
        return avail;
    }

    private leftUsable = 0;

    private reconstruct(): void {
        const flags = this.mbTypeFlags;
        if (flags & MB_INTRA) this.reconstructIntra();
        else {
            this.motionCompensate();
            this.addInterResidual();
        }
    }

    private reconstructIntra(): void {
        const data = this.lumaData;
        const stride = this.mbStride;
        const mbAvail = this.intraAvailability();
        const leftUsable = this.leftUsable;
        const qp = this.qpY;
        const nnzCache = this.nnzCache;
        const coeffs = this.coeffs;
        if (this.mbTypeFlags & MB_INTRA16) {
            if (
                !predIntra16x16(
                    this.i16Mode,
                    data,
                    this.lumaOffset,
                    stride,
                    this.lumaOffset - stride,
                    mbAvail,
                )
            )
                throw new Error('Intra16x16 prediction mode needs unavailable neighbours');
            const dc = this.dcCoeffs;
            lumaDcTransform(dc, 0, this.ctx.scaling.level4[0][(qp % 6) * 16], qp);
            for (let blk = 0; blk < 16; blk++) {
                const raster = BLOCK_RASTER[blk];
                const offset = raster * 16;
                const x = BLOCK_X[blk];
                const y = BLOCK_Y[blk];
                const o = this.lumaOffset + y * 4 * stride + x * 4;
                const dcValue = dc[raster];
                if (nnzCache[cacheAt(x, y)]) {
                    coeffs[offset] = dcValue;
                    this.idct4(offset, o, stride);
                } else if (dcValue) this.addDc(dcValue, o, stride, 4);
            }
            dc.fill(0, 0, 16);
        } else if (this.transform8x8) {
            for (let i8 = 0; i8 < 4; i8++) {
                const x8 = i8 & 1;
                const y8 = i8 >> 1;
                const o = this.lumaOffset + y8 * 8 * stride + x8 * 8;
                let avail = 0;
                if (x8 > 0 ? true : leftUsable & (1 << y8)) avail |= AVAIL_A;
                if (y8 > 0 || mbAvail & AVAIL_B) avail |= AVAIL_B;
                if (y8 === 0 ? (x8 === 0 ? mbAvail & AVAIL_B : mbAvail & AVAIL_C) : x8 === 0)
                    avail |= AVAIL_C;
                if (x8 > 0 && y8 > 0) avail |= AVAIL_D;
                else if (x8 === 0 && y8 === 0) {
                    if (mbAvail & AVAIL_D) avail |= AVAIL_D;
                } else if (x8 === 0) {
                    if (leftUsable & 1) avail |= AVAIL_D;
                } else if (mbAvail & AVAIL_B) avail |= AVAIL_D;
                const mode = this.intraCache[cacheAt(x8 * 2, y8 * 2)];
                if (!predIntra8x8(mode, data, o, stride, o - stride, avail))
                    throw new Error('Intra8x8 prediction mode needs unavailable neighbours');
                this.addBlock8x8(i8, o, stride);
            }
        } else {
            for (let blk = 0; blk < 16; blk++) {
                const x = BLOCK_X[blk];
                const y = BLOCK_Y[blk];
                const o = this.lumaOffset + y * 4 * stride + x * 4;
                let avail = 0;
                if (x > 0 ? true : leftUsable & (1 << (y >> 1))) avail |= AVAIL_A;
                if (y > 0 || mbAvail & AVAIL_B) avail |= AVAIL_B;
                if (y === 0) {
                    if (x < 3 ? mbAvail & AVAIL_B : mbAvail & AVAIL_C) avail |= AVAIL_C;
                } else if (x < 3 && RASTER_TO_BLOCK[(y - 1) * 4 + x + 1] < blk) avail |= AVAIL_C;
                if (x > 0 && y > 0) avail |= AVAIL_D;
                else if (x === 0 && y === 0) {
                    if (mbAvail & AVAIL_D) avail |= AVAIL_D;
                } else if (x === 0) {
                    if (leftUsable & (1 << ((y - 1) >> 1))) avail |= AVAIL_D;
                } else if (mbAvail & AVAIL_B) avail |= AVAIL_D;
                const mode = this.intraCache[cacheAt(x, y)];
                if (!predIntra4x4(mode, data, o, stride, o - stride, avail))
                    throw new Error('Intra4x4 prediction mode needs unavailable neighbours');
                const count = nnzCache[cacheAt(x, y)];
                if (count) this.addBlock4x4(BLOCK_RASTER[blk] * 16, count, o, stride);
            }
        }
        if (this.chromaFormat === 0) return;
        for (let plane = 0; plane < 2; plane++) {
            const base = (plane ? this.crBase : this.chromaBase) + this.chromaOffset;
            if (
                !predIntraChroma(
                    this.mbChromaMode,
                    data,
                    base,
                    this.mbChromaStride,
                    base - this.mbChromaStride,
                    (mbAvail & ~AVAIL_A) |
                        (leftUsable & 1 ? AVAIL_A : 0) |
                        (leftUsable & 2 ? AVAIL_A_LOW : 0),
                    this.chromaMbHeight,
                )
            )
                throw new Error('chroma prediction mode needs unavailable neighbours');
        }
        this.addChromaResidual(true);
    }

    /** Adds the chroma residual of the current macroblock (DC transform, then AC blocks). */
    private addChromaResidual(intra: boolean): void {
        if (this.chromaFormat === 0) return;
        const coeffs = this.coeffs;
        const dc = this.dcCoeffs;
        const nnzCache = this.nnzCache;
        const cbp = this.mbCbp;
        const stride = this.mbChromaStride;
        const blocks = this.chromaBlocks;
        const scaling = this.ctx.scaling;
        if (!(cbp & 48)) return;
        for (let plane = 0; plane < 2; plane++) {
            const qpc = this.chromaQp(plane);
            const table = scaling.level4[(intra ? 1 : 4) + plane];
            const dcOffset = 16 + plane * 8;
            if (blocks === 4) chromaDcTransform420(dc, dcOffset, table[(qpc % 6) * 16], qpc);
            else {
                const qpdc = qpc + 3;
                chromaDcTransform422(dc, dcOffset, table[(qpdc % 6) * 16], qpdc);
            }
            const base = (plane ? this.crBase : this.chromaBase) + this.chromaOffset;
            const cacheBase = plane ? 88 : 48;
            for (let b = 0; b < blocks; b++) {
                const x = CHROMA_BLOCK_X[b];
                const y = CHROMA_BLOCK_Y[b];
                const o = base + y * 4 * stride + x * 4;
                const dcValue = dc[dcOffset + b];
                if (nnzCache[cacheBase + y * 8 + 4 + x]) {
                    const offset = 256 + (plane * 8 + b) * 16;
                    coeffs[offset] = dcValue;
                    this.idct4(offset, o, stride);
                } else if (dcValue) this.addDc(dcValue, o, stride, 4);
            }
            dc.fill(0, dcOffset, dcOffset + 8);
        }
    }

    private addInterResidual(): void {
        const cbp = this.mbCbp;
        const nnzCache = this.nnzCache;
        const stride = this.mbStride;
        if (cbp & 15) {
            if (this.transform8x8) {
                for (let i8 = 0; i8 < 4; i8++) {
                    this.addBlock8x8(
                        i8,
                        this.lumaOffset + (i8 >> 1) * 8 * stride + (i8 & 1) * 8,
                        stride,
                    );
                }
            } else {
                for (let blk = 0; blk < 16; blk++) {
                    const x = BLOCK_X[blk];
                    const y = BLOCK_Y[blk];
                    const count = nnzCache[cacheAt(x, y)];
                    if (!count) continue;
                    this.addBlock4x4(
                        BLOCK_RASTER[blk] * 16,
                        count,
                        this.lumaOffset + y * 4 * stride + x * 4,
                        stride,
                    );
                }
            }
        }
        this.addChromaResidual(false);
    }

    // ---------------------------------------------------------------------------------------------
    // Inter prediction

    /** Predicts every partition of the current macroblock from the motion in the caches. */
    private motionCompensate(): void {
        const shape = this.partShape;
        if (this.mbTypeFlags & MB_DIRECT16 || this.mbTypeFlags & MB_SKIP) {
            if (this.sliceType === SLICE_B) {
                this.predictDirectBlocks(15);
                return;
            }
            this.predictPartition(0, 0, 16, 16);
            return;
        }
        if (shape === SHAPE_16X16) this.predictPartition(0, 0, 16, 16);
        else if (shape === SHAPE_16X8) {
            this.predictPartition(0, 0, 16, 8);
            this.predictPartition(0, 8, 16, 8);
        } else if (shape === SHAPE_8X16) {
            this.predictPartition(0, 0, 8, 16);
            this.predictPartition(8, 0, 8, 16);
        } else {
            for (let i8 = 0; i8 < 4; i8++) {
                const x = (i8 & 1) * 8;
                const y = (i8 >> 1) * 8;
                if (this.mbDirect & (1 << i8)) {
                    this.predictDirectBlocks(1 << i8);
                    continue;
                }
                const sub = this.subShape[i8];
                if (sub === SUB_8X8) this.predictPartition(x, y, 8, 8);
                else if (sub === SUB_8X4) {
                    this.predictPartition(x, y, 8, 4);
                    this.predictPartition(x, y + 4, 8, 4);
                } else if (sub === SUB_4X8) {
                    this.predictPartition(x, y, 4, 8);
                    this.predictPartition(x + 4, y, 4, 8);
                } else {
                    this.predictPartition(x, y, 4, 4);
                    this.predictPartition(x + 4, y, 4, 4);
                    this.predictPartition(x, y + 4, 4, 4);
                    this.predictPartition(x + 4, y + 4, 4, 4);
                }
            }
        }
    }

    /**
     * Predicts direct 8x8 blocks, as one partition wherever neighbouring blocks share their motion.
     */
    private predictDirectBlocks(mask: number): void {
        this.directUniform = mask === 15 && this.uniformMotion(0, 0, 4);
        if (this.directUniform) {
            this.predictPartition(0, 0, 16, 16);
            return;
        }
        for (let i8 = 0; i8 < 4; i8++) {
            if (!(mask & (1 << i8))) continue;
            const x = (i8 & 1) * 8;
            const y = (i8 >> 1) * 8;
            if (this.direct8x8Inference || this.uniformMotion(x >> 2, y >> 2, 2))
                this.predictPartition(x, y, 8, 8);
            else {
                this.predictPartition(x, y, 4, 4);
                this.predictPartition(x + 4, y, 4, 4);
                this.predictPartition(x, y + 4, 4, 4);
                this.predictPartition(x + 4, y + 4, 4, 4);
            }
        }
    }

    /**
     * Whether the motion of a whole direct-predicted macroblock came out the same for all its
     * blocks.
     */
    private directUniform = false;

    /**
     * Whether every 4x4 block of the size x size area at (x4, y4) has the same references and
     * vectors.
     */
    private uniformMotion(x4: number, y4: number, size: number): boolean {
        const ref0 = this.refCache[0];
        const ref1 = this.refCache[1];
        const mv0 = this.mvCache32[0];
        const mv1 = this.mvCache32[1];
        const first = cacheAt(x4, y4);
        const r0 = ref0[first];
        const r1 = ref1[first];
        const a = mv0[first];
        const b = mv1[first];
        for (let y = y4; y < y4 + size; y++) {
            const p = cacheAt(x4, y);
            for (let x = 0; x < size; x++) {
                if (
                    mv0[p + x] !== a ||
                    mv1[p + x] !== b ||
                    ref0[p + x] !== r0 ||
                    ref1[p + x] !== r1
                )
                    return false;
            }
        }
        return true;
    }

    /**
     * Motion compensated prediction of a partition at luma position (x, y) inside the macroblock.
     */
    private predictPartition(x: number, y: number, w: number, h: number): void {
        const pos = cacheAt(x >> 2, y >> 2);
        const bSlice = this.sliceType === SLICE_B;
        const ref0 = this.refCache[0][pos];
        const ref1 = bSlice ? this.refCache[1][pos] : LIST_NOT_USED;
        const lists = this.lists;
        const entry0 = ref0 >= 0 ? lists[0][ref0] : undefined;
        const entry1 = ref1 >= 0 ? lists[1][ref1] : undefined;
        if (entry0 === undefined && entry1 === undefined) {
            this.fillGreyPartition(x, y, w, h);
            return;
        }
        if (this.refWait !== null) {
            if (entry0 !== undefined) this.awaitRows(entry0, y, h, this.mvCache[0][pos * 2 + 1]);
            if (entry1 !== undefined) this.awaitRows(entry1, y, h, this.mvCache[1][pos * 2 + 1]);
        }
        const weights = this.ctx.header.weights;
        const explicit = weights !== null && (!bSlice || this.ctx.pps.weightedBipredIdc === 1);
        const data = this.lumaData;
        const words = this.lumaWords;
        const predA = this.predA;
        const predB = this.predB;
        const lumaDst = this.lumaOffset + y * this.mbStride + x;
        const stride = this.mbStride;
        const chroma = this.chromaFormat !== 0;
        const cw = w >> 1;
        const ch = this.chromaFormat === 2 ? h : h >> 1;
        const cx = x >> 1;
        const cy = this.chromaFormat === 2 ? y : y >> 1;
        const cStride = this.mbChromaStride;
        const cbDst = this.chromaBase + this.chromaOffset + cy * cStride + cx;
        const crDst = cbDst + (this.crBase - this.chromaBase);
        if (entry0 === undefined || entry1 === undefined) {
            const list = entry0 !== undefined ? 0 : 1;
            const entry = entry0 ?? entry1!;
            const mvx = this.mvCache[list][pos * 2];
            const mvy = this.mvCache[list][pos * 2 + 1];
            if (explicit) {
                const t = weights.table[list];
                const r = this.weightRef(list ? ref1 : ref0) * 6;
                const logY = weights.lumaLog2Denom;
                if (t[r] !== 1 << logY || t[r + 1] !== 0) {
                    this.predictLuma(entry, x, y, w, h, mvx, mvy, predA, this.predAWords, 0, 16);
                    this.weighted(0, lumaDst, stride, w, h, t[r], t[r + 1], logY);
                } else this.predictLuma(entry, x, y, w, h, mvx, mvy, data, words, lumaDst, stride);
                if (!chroma) return;
                const logC = weights.chromaLog2Denom;
                if (
                    t[r + 2] !== 1 << logC ||
                    t[r + 3] !== 0 ||
                    t[r + 4] !== 1 << logC ||
                    t[r + 5] !== 0
                ) {
                    this.predictChroma(
                        entry,
                        cx,
                        cy,
                        cw,
                        ch,
                        mvx,
                        mvy,
                        predA,
                        this.predAWords,
                        0,
                        8,
                        16,
                    );
                    this.weighted(0, cbDst, cStride, cw, ch, t[r + 2], t[r + 3], logC);
                    this.weighted(8, crDst, cStride, cw, ch, t[r + 4], t[r + 5], logC);
                    return;
                }
            } else this.predictLuma(entry, x, y, w, h, mvx, mvy, data, words, lumaDst, stride);
            if (chroma)
                this.predictChroma(
                    entry,
                    cx,
                    cy,
                    cw,
                    ch,
                    mvx,
                    mvy,
                    data,
                    words,
                    cbDst,
                    crDst,
                    cStride,
                );
            return;
        }
        const mvx0 = this.mvCache[0][pos * 2];
        const mvy0 = this.mvCache[0][pos * 2 + 1];
        const mvx1 = this.mvCache[1][pos * 2];
        const mvy1 = this.mvCache[1][pos * 2 + 1];
        const bi = this.biWeights;
        if (explicit) {
            const t0 = weights.table[0];
            const t1 = weights.table[1];
            const r0 = this.weightRef(ref0) * 6;
            const r1 = this.weightRef(ref1) * 6;
            for (let c = 0; c < 6; c += 2) {
                bi[c * 2] = t0[r0 + c];
                bi[c * 2 + 1] = t1[r1 + c];
                bi[c * 2 + 2] = (t0[r0 + c + 1] + t1[r1 + c + 1] + 1) >> 1;
                bi[c * 2 + 3] = c ? weights.chromaLog2Denom : weights.lumaLog2Denom;
            }
        } else {
            let w1 = 32;
            if (bSlice && this.ctx.pps.weightedBipredIdc === 2) {
                const table =
                    this.mbaff && this.mbField && this.ctx.implicitWeightsField
                        ? this.ctx.implicitWeightsField[this.mbY & 1]
                        : this.ctx.implicitWeights!;
                w1 = table[ref0 * 32 + ref1];
            }
            for (let c = 0; c < 12; c += 4) {
                bi[c] = 64 - w1;
                bi[c + 1] = w1;
                bi[c + 2] = 0;
                bi[c + 3] = 5;
            }
        }
        if (
            !this.blendFullLuma(entry0, entry1, x, y, w, h, mvx0, mvy0, mvx1, mvy1, lumaDst, stride)
        ) {
            this.predictLuma(entry0, x, y, w, h, mvx0, mvy0, predA, this.predAWords, 0, 16);
            this.predictLuma(entry1, x, y, w, h, mvx1, mvy1, predB, this.predBWords, 0, 16);
            this.combine(0, lumaDst, stride, w, h, 0);
        }
        if (
            !chroma ||
            this.blendFullChroma(
                entry0,
                entry1,
                cx,
                cy,
                cw,
                ch,
                mvx0,
                mvy0,
                mvx1,
                mvy1,
                cbDst,
                crDst,
            )
        ) {
            return;
        }
        this.predictChroma(entry0, cx, cy, cw, ch, mvx0, mvy0, predA, this.predAWords, 0, 8, 16);
        this.predictChroma(entry1, cx, cy, cw, ch, mvx1, mvy1, predB, this.predBWords, 0, 8, 16);
        this.combine(0, cbDst, cStride, cw, ch, 4);
        this.combine(8, crDst, cStride, cw, ch, 8);
    }

    /**
     * Waits for the reference rows a partition at luma row `py` of height `h` reads with vertical
     * vector `mvy`: six-tap rows up to three below the block, the chroma rows within them; every
     * row for field macroblocks.
     */
    private awaitRows(entry: RefEntry, py: number, h: number, mvy: number): void {
        if (this.mbField) {
            this.refWait!(entry.pic, this.mbHeight);
            return;
        }
        const bottom = this.mbY * 16 + py + (mvy >> 2) + h + 3;
        this.refWait!(entry.pic, bottom < 0 ? 0 : bottom >> 4);
    }

    /**
     * Bi-prediction weights of the partition being predicted: w0, w1, offset and logWD for Y, Cb
     * and Cr.
     */
    private readonly biWeights = new Int32Array(12);

    /**
     * Writes the bi-prediction of the blocks at `s` of `predA` and `predB` to the picture at `o`
     * with the weights at `weight` of `biWeights`: the default average when they are, else the
     * weighted sum (8.4.2.3).
     */
    private combine(
        s: number,
        o: number,
        stride: number,
        w: number,
        h: number,
        weight: number,
    ): void {
        const bi = this.biWeights;
        const w0 = bi[weight];
        const w1 = bi[weight + 1];
        const offset = bi[weight + 2];
        const logWD = bi[weight + 3];
        const kernels = this.kernels;
        if (kernels !== null) {
            const a = this.predAAddress + s;
            const b = this.predBAddress + s;
            if (w0 === w1 && w0 === 1 << logWD && offset === 0)
                kernels.avg(a, 16, b, 16, this.picBase + o, stride, w, h);
            else
                kernels.weight2(
                    a,
                    16,
                    b,
                    16,
                    this.picBase + o,
                    stride,
                    w,
                    h,
                    w0,
                    w1,
                    offset,
                    logWD,
                );
            return;
        }
        if (((w | o | s) & 3) === 0 && blendsInLanes(w0, w1, offset, logWD)) {
            const words = this.lumaWords;
            putBlendWords(
                this.predAWords,
                this.predBWords,
                s >> 2,
                words,
                o >> 2,
                stride >> 2,
                w >> 2,
                h,
                w0,
                w1,
                logWD,
            );
        } else if (w0 === w1 && w0 === 1 << logWD && offset === 0) {
            putAverage(this.predA, this.predB, s, this.lumaData, o, stride, w, h);
        } else
            putBiWeighted(
                this.predA,
                this.predB,
                s,
                this.lumaData,
                o,
                stride,
                w,
                h,
                w0,
                w1,
                offset,
                logWD,
            );
    }

    /**
     * Explicit single-list weighting (putWeighted) of the block at `s` of `predA` into the picture
     * at `o`.
     */
    private weighted(
        s: number,
        o: number,
        stride: number,
        w: number,
        h: number,
        weight: number,
        offset: number,
        logWD: number,
    ): void {
        const kernels = this.kernels;
        if (kernels !== null)
            kernels.weight1(
                this.predAAddress + s,
                16,
                this.picBase + o,
                stride,
                w,
                h,
                weight,
                offset,
                logWD,
            );
        else putWeighted(this.predA, s, this.lumaData, o, stride, w, h, weight, offset, logWD);
    }

    /**
     * Reference index into the weight table: MBAFF field macroblocks use the frame index (8.4.2.3).
     */
    private weightRef(ref: number): number {
        return this.mbaff && this.mbField ? ref >> 1 : ref;
    }

    /**
     * Luma prediction of the partition at (px, py) of the macroblock from `entry` with the vector
     * (mvx, mvy).
     */
    private predictLuma(
        entry: RefEntry,
        px: number,
        py: number,
        bw: number,
        bh: number,
        mvx: number,
        mvy: number,
        out: Uint8Array,
        outWords: Uint32Array,
        outOffset: number,
        outStride: number,
    ): void {
        const x = this.mbX * 16 + px + (mvx >> 2);
        const y = (this.mbField ? (this.mbY >> 1) * 16 : this.mbY * 16) + py + (mvy >> 2);
        this.mc.luma(
            entry.luma,
            x,
            y,
            mvx & 3,
            mvy & 3,
            bw,
            bh,
            out,
            outWords,
            outOffset,
            outStride,
        );
    }

    /**
     * Bi-prediction of a luma partition whose two vectors are full-sample, blended straight from
     * the references with the luma `biWeights`; false when it needs the general path.
     */
    private blendFullLuma(
        entry0: RefEntry,
        entry1: RefEntry,
        px: number,
        py: number,
        bw: number,
        bh: number,
        mvx0: number,
        mvy0: number,
        mvx1: number,
        mvy1: number,
        o: number,
        os: number,
    ): boolean {
        if (((mvx0 | mvy0 | mvx1 | mvy1) & 3) !== 0) return false;
        const x = this.mbX * 16 + px;
        const y = (this.mbField ? (this.mbY >> 1) * 16 : this.mbY * 16) + py;
        const bi = this.biWeights;
        return this.mc.blendFullSamples(
            entry0.luma,
            x + (mvx0 >> 2),
            y + (mvy0 >> 2),
            entry1.luma,
            x + (mvx1 >> 2),
            y + (mvy1 >> 2),
            0,
            bw,
            bh,
            this.lumaData,
            this.lumaWords,
            o,
            os,
            bi[0],
            bi[1],
            bi[2],
            bi[3],
        );
    }

    /** blendFullLuma for the Cb and Cr blocks of a partition. */
    private blendFullChroma(
        entry0: RefEntry,
        entry1: RefEntry,
        px: number,
        py: number,
        bw: number,
        bh: number,
        mvx0: number,
        mvy0: number,
        mvx1: number,
        mvy1: number,
        cbOffset: number,
        crOffset: number,
    ): boolean {
        const pos = this.chromaPos;
        this.chromaPosition(entry1, px, py, mvx1, mvy1);
        if ((pos[2] | pos[3]) !== 0) return false;
        const x1 = pos[0];
        const y1 = pos[1];
        this.chromaPosition(entry0, px, py, mvx0, mvy0);
        if ((pos[2] | pos[3]) !== 0) return false;
        const mc = this.mc;
        const data = this.lumaData;
        const words = this.lumaWords;
        const os = this.mbChromaStride;
        const x0 = pos[0];
        const y0 = pos[1];
        const a = entry0.cb;
        const b = entry1.cb;
        const bi = this.biWeights;
        if (
            !mc.blendFullSamples(
                a,
                x0,
                y0,
                b,
                x1,
                y1,
                0,
                bw,
                bh,
                data,
                words,
                cbOffset,
                os,
                bi[4],
                bi[5],
                bi[6],
                bi[7],
            )
        ) {
            return false;
        }
        const shift = entry0.cr.offset - a.offset;
        return mc.blendFullSamples(
            a,
            x0,
            y0,
            b,
            x1,
            y1,
            shift,
            bw,
            bh,
            data,
            words,
            crOffset,
            os,
            bi[8],
            bi[9],
            bi[10],
            bi[11],
        );
    }

    /**
     * Chroma position of a partition: integer x, y and fractions fx, fy (eighths) in `chromaPos`
     * (8.4.1.4, 8.4.2.2.2).
     */
    private readonly chromaPos = new Int32Array(4);

    private chromaPosition(
        entry: RefEntry,
        px: number,
        py: number,
        mvx: number,
        mvy: number,
    ): void {
        let cmvy = mvy;
        if (this.mbField && entry.parity !== PICT_FRAME) {
            const parity = this.mbaff
                ? this.mbY & 1
                    ? PICT_BOTTOM
                    : PICT_TOP
                : this.ctx.structure;
            if (entry.parity !== parity) cmvy += parity === PICT_BOTTOM ? 2 : -2;
        }
        const mbY = this.mbField ? (this.mbY >> 1) * 16 : this.mbY * 16;
        const pos = this.chromaPos;
        pos[0] = this.mbX * 8 + px + (mvx >> 3);
        pos[2] = mvx & 7;
        if (this.chromaFormat === 2) {
            pos[1] = mbY + py + (cmvy >> 2);
            pos[3] = (cmvy & 3) << 1;
        } else {
            pos[1] = (mbY >> 1) + py + (cmvy >> 3);
            pos[3] = cmvy & 7;
        }
    }

    /**
     * Cb and Cr prediction of the chroma partition at (px, py) from `entry` with the luma vector
     * (mvx, mvy).
     */
    private predictChroma(
        entry: RefEntry,
        px: number,
        py: number,
        bw: number,
        bh: number,
        mvx: number,
        mvy: number,
        out: Uint8Array,
        outWords: Uint32Array,
        cbOffset: number,
        crOffset: number,
        outStride: number,
    ): void {
        this.chromaPosition(entry, px, py, mvx, mvy);
        const pos = this.chromaPos;
        this.mc.chroma(
            entry.cb,
            entry.cr.offset - entry.cb.offset,
            pos[0],
            pos[1],
            pos[2],
            pos[3],
            bw,
            bh,
            out,
            outWords,
            cbOffset,
            crOffset,
            outStride,
        );
    }

    private fillGreyPartition(x: number, y: number, w: number, h: number): void {
        const data = this.lumaData;
        for (let r = 0; r < h; r++)
            data.fill(
                128,
                this.lumaOffset + (y + r) * this.mbStride + x,
                this.lumaOffset + (y + r) * this.mbStride + x + w,
            );
        if (this.chromaFormat === 0) return;
        const cw = w >> 1;
        const ch = this.chromaFormat === 2 ? h : h >> 1;
        const cx = x >> 1;
        const cy = this.chromaFormat === 2 ? y : y >> 1;
        for (let plane = 0; plane < 2; plane++) {
            const base = (plane ? this.crBase : this.chromaBase) + this.chromaOffset;
            for (let r = 0; r < ch; r++)
                data.fill(
                    128,
                    base + (cy + r) * this.mbChromaStride + cx,
                    base + (cy + r) * this.mbChromaStride + cx + cw,
                );
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Storing macroblock results

    /**
     * Which internal edges of the current inter macroblock can separate partitions with different
     * motion.
     */
    private motionClassOf(): number {
        if (this.mbTypeFlags & (MB_SKIP | MB_DIRECT16)) {
            if (this.sliceType !== SLICE_B || this.directUniform) return MOTION_UNIFORM;
            return this.direct8x8Inference ? MOTION_8X8 : MOTION_4X4;
        }
        const shape = this.partShape;
        if (shape === SHAPE_16X16) return MOTION_UNIFORM;
        if (shape === SHAPE_16X8) return MOTION_16X8;
        if (shape === SHAPE_8X16) return MOTION_8X16;
        for (let i = 0; i < 4; i++) {
            if (this.mbDirect & (1 << i) ? !this.direct8x8Inference : this.subShape[i] !== SUB_8X8)
                return MOTION_4X4;
        }
        return MOTION_8X8;
    }

    private storeMacroblock(skipped: boolean): void {
        const xy = this.mbXy;
        const pic = this.picture;
        const flags =
            this.mbTypeFlags |
            (this.transform8x8 ? MB_T8X8 : 0) |
            (this.mbField ? MB_FIELD : 0) |
            MB_DECODED;
        pic.mbFlags[xy] = flags;
        this.qp[xy] = this.qpY;
        this.cbp[xy] = this.mbCbp;
        this.chromaMode[xy] = this.mbChromaMode;
        const intra = (flags & MB_INTRA) !== 0;
        const nnz32 = this.nnz32;
        const nnz16 = this.nnz16;
        const nnzCache = this.nnzCache;
        let mask = 0;
        if (skipped) {
            for (let i = xy * 8; i < xy * 8 + 8; i++) nnz32[i] = 0;
            this.dcFlags[xy] = 0;
        } else {
            const cache32 = this.nnzCache32;
            const cache16 = this.nnzCache16;
            for (let row = 0; row < 4; row++) {
                nnz32[xy * 8 + row] = cache32[3 + row * 2];
                nnz16[xy * 16 + 8 + row] = cache16[26 + row * 4];
                nnz16[xy * 16 + 12 + row] = cache16[46 + row * 4];
            }
            for (let i = 0; i < 16; i++) if (nnzCache[cacheAt(i & 3, i >> 2)]) mask |= 1 << i;
            if (this.transform8x8) {
                for (let i8 = 0; i8 < 4; i8++) {
                    const bits = 0x33 << ((i8 >> 1) * 8 + (i8 & 1) * 2);
                    if (mask & bits) mask |= bits;
                }
            }
        }
        this.nzMask[xy] = mask;
        if (intra && !(flags & (MB_INTRA16 | MB_PCM))) {
            const modes = this.intraModes;
            for (let i = 0; i < 16; i++)
                modes[xy * 16 + i] = this.intraCache[cacheAt(i & 3, i >> 2)];
        }
        const listCount = intra ? 0 : this.sliceType === SLICE_B ? 2 : 1;
        const mvdOn = this.cabacMode;
        const b8 = xy * 4;
        const v = xy * 16;
        for (let list = 0; list < 2; list++) {
            const refs = pic.ref[list];
            const refIds = pic.refId[list];
            const mv32 = pic.mv32[list];
            const mvd16 = this.mvd16[list];
            if (list >= listCount) {
                refs[b8] = refs[b8 + 1] = refs[b8 + 2] = refs[b8 + 3] = -1;
                refIds[b8] = refIds[b8 + 1] = refIds[b8 + 2] = refIds[b8 + 3] = -1;
                for (let i = v; i < v + 16; i++) mv32[i] = 0;
                if (mvdOn) for (let i = xy * 8; i < xy * 8 + 8; i++) mvd16[i] = 0;
                continue;
            }
            const refCache = this.refCache[list];
            const entries = this.lists[list];
            for (let i8 = 0; i8 < 4; i8++) {
                const ref = refCache[cacheAt((i8 & 1) * 2, (i8 >> 1) * 2)];
                if (ref >= 0) {
                    refs[b8 + i8] = ref;
                    const entry = entries[ref];
                    refIds[b8 + i8] = entry ? entry.id : -1;
                } else {
                    refs[b8 + i8] = -1;
                    refIds[b8 + i8] = -1;
                }
            }
            const mvCache = this.mvCache32[list];
            for (let row = 0; row < 4; row++) {
                const c = cacheAt(0, row);
                const d = v + row * 4;
                mv32[d] = mvCache[c];
                mv32[d + 1] = mvCache[c + 1];
                mv32[d + 2] = mvCache[c + 2];
                mv32[d + 3] = mvCache[c + 3];
            }
            if (mvdOn && skipped) for (let i = xy * 8; i < xy * 8 + 8; i++) mvd16[i] = 0;
            else if (mvdOn) {
                const mvdCache = this.mvdCache16[list];
                const d = xy * 8;
                const bottom = cacheAt(0, 3);
                mvd16[d] = mvdCache[bottom];
                mvd16[d + 1] = mvdCache[bottom + 1];
                mvd16[d + 2] = mvdCache[bottom + 2];
                mvd16[d + 3] = mvdCache[bottom + 3];
                mvd16[d + 4] = mvdCache[cacheAt(3, 0)];
                mvd16[d + 5] = mvdCache[cacheAt(3, 1)];
                mvd16[d + 6] = mvdCache[cacheAt(3, 2)];
            }
        }
        this.directMask[xy] = intra ? 0 : this.mbDirect;
        if (skipped) this.directMask[xy] = this.sliceType === SLICE_B ? 15 : 0;
        this.motionClass[xy] = intra ? MOTION_UNIFORM : this.motionClassOf();
    }
}

const CHROMA_DC_SCAN_420 = new Uint8Array([0, 1, 2, 3]);

/** Chroma DC 2x4 coefficients in coded order (8.5.11.1): raster positions x + 2 * y. */
const CHROMA_DC_SCAN_422 = new Uint8Array([0, 2, 1, 4, 6, 3, 5, 7]);

/**
 * Context offsets equal to the coded position, and the 4:2:2 chroma DC offsets Min(i / 2, 2)
 * (9.3.3.1.3).
 */
const CTX_IDENTITY = new Uint8Array(64).map((_, i) => i);
const CTX_CHROMA_DC_422 = new Uint8Array([0, 0, 1, 1, 2, 2, 2, 2]);
