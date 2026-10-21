import type { RefPlane } from './inter-pred';

/**
 * Memory holding pictures: a kernel arena allocates new ones, a decoding thread views existing
 * ones.
 */
interface PictureMemory {
    readonly buffer: ArrayBufferLike;
    allocate?(size: number): number;
}
import { PICT_BOTTOM, PICT_FRAME, PICT_TOP } from './tables';

/** Per-macroblock flags kept with a picture for later direct prediction and deblocking. */
export const MB_INTRA = 1;
export const MB_FIELD = 2;
export const MB_DECODED = 4;
export const MB_SKIP = 8;
export const MB_DIRECT16 = 16;
export const MB_T8X8 = 32;
export const MB_PCM = 64;
export const MB_INTRA16 = 128;

/** Reference marking of one field. */
export const REF_NONE = 0;
export const REF_SHORT = 1;
export const REF_LONG = 2;

/**
 * A decoded frame (or field pair) in coded size with the motion data later pictures predict from;
 * monochrome pictures carry grey 4:2:0 chroma planes. Macroblock arrays use frame macroblock
 * coordinates; the macroblocks of field pictures and MBAFF pairs interleave by row parity.
 */
export class Picture {
    data!: Uint8Array;
    /** `data` as 32-bit words; plane offsets and strides are multiples of 8 samples. */
    words!: Uint32Array;
    /** `data` saturating stores to 0-255. */
    clamped!: Uint8ClampedArray;
    /**
     * Address of `data` in the kernel memory holding the picture, which then also holds the
     * macroblock arrays and the decoding progress; 0 for a picture in buffers of its own.
     */
    readonly base: number;
    readonly lumaStride: number;
    readonly lumaHeight: number;
    readonly chromaOffset: number;
    readonly chromaStride: number;
    readonly chromaHeight: number;
    readonly crOffset: number;
    mbFlags!: Uint8Array;
    ref!: readonly [Int8Array, Int8Array];
    refId!: readonly [Int32Array, Int32Array];
    mv!: readonly [Int16Array, Int16Array];
    /** `mv` with one (x, y) vector per element. */
    mv32!: readonly [Int32Array, Int32Array];
    /** Slice index of each macroblock of the picture or field being decoded, -1 before decoding. */
    sliceNum!: Int32Array;
    /**
     * Deblocking parameters of each macroblock's slice: disable_deblocking_filter_idc in bits 0-1,
     * then the alpha and beta offsets and the Cb and Cr QP offsets, each plus 16 in five bits
     * (filterParams()).
     */
    filterParams!: Int32Array;
    /** Bit per raster 4x4 luma block with coefficients, for the deblocking filter. */
    nzMask!: Uint16Array;
    qp!: Uint8Array;
    /** MOTION_* class of each macroblock, for the deblocking filter. */
    motionClass!: Uint8Array;
    /**
     * Macroblock state later macroblocks of the picture read while it decodes: coded_block_pattern,
     * DC flags (bit 0 luma, 1 Cb, 2 Cr), intra chroma prediction mode, 16 intra 4x4 modes,
     * coefficient counts (16 luma in raster order, 8 Cb, 8 Cr), the absolute mvds of the bottom row
     * and right column (8 pairs per list) and the direct 8x8 bits.
     */
    cbp!: Uint8Array;
    dcFlags!: Uint8Array;
    chromaMode!: Uint8Array;
    intraModes!: Int8Array;
    nnz!: Uint8Array;
    mvd!: readonly [Uint8Array, Uint8Array];
    directMask!: Uint8Array;
    /**
     * Macroblock rows other threads may read, PROGRESS_DONE once decoded; one element (kernel
     * memory only).
     */
    progress!: Int32Array;
    /** Unique identity of the picture storage. */
    readonly id: number;
    /**
     * Identity of the picture's current use in reference identifiers (serial * 4 + parity); storage
     * reused for a new picture gets a new one, so blocks predicted from the earlier picture never
     * match the new one.
     */
    serial = 0;
    mbaff = false;
    fieldPicture = false;
    poc = 0;
    topPoc = 0;
    bottomPoc = 0;
    frameNum = 0;
    frameNumWrap = 0;
    longTermFrameIdx = 0;
    refTop = REF_NONE;
    refBottom = REF_NONE;
    /** Bit 1 top field decoded, bit 2 bottom field decoded. */
    decodedFields = 0;
    idr = false;
    /**
     * memory_management_control_operation 5 restarted the picture order count at this picture
     * (8.2.1).
     */
    pocReset = false;
    keyFrame = false;
    needsOutput = false;
    nonExisting = false;
    concealed = false;
    timestamp = 0;
    duration = 0;
    topFieldFirst = true;
    /** Slice nal_ref_idc of the picture (0 for non-reference pictures). */
    reference = false;

    constructor(
        id: number,
        readonly mbWidth: number,
        readonly mbHeight: number,
        readonly chromaFormat: number,
        memory: PictureMemory | null = null,
        base = -1,
    ) {
        this.id = id;
        this.lumaStride = mbWidth * 16;
        this.lumaHeight = mbHeight * 16;
        const chromaWidth = chromaFormat === 3 ? 16 : 8;
        const chromaRows = chromaFormat === 2 || chromaFormat === 3 ? 16 : 8;
        this.chromaStride = mbWidth * chromaWidth;
        this.chromaHeight = mbHeight * chromaRows;
        this.chromaOffset = this.lumaStride * this.lumaHeight;
        this.crOffset = this.chromaOffset + this.chromaStride * this.chromaHeight;
        const mbCount = mbWidth * mbHeight;
        if (memory) {
            this.base =
                base >= 0 ? base : memory.allocate!(pictureBytes(mbWidth, mbHeight, chromaFormat));
            this.bind(memory.buffer);
        } else {
            this.base = 0;
            const size = this.crOffset + this.chromaStride * this.chromaHeight;
            this.data = new Uint8Array(size);
            this.words = new Uint32Array(this.data.buffer);
            this.clamped = new Uint8ClampedArray(this.data.buffer);
            this.mbFlags = new Uint8Array(mbCount);
            this.ref = [new Int8Array(mbCount * 4), new Int8Array(mbCount * 4)];
            this.refId = [new Int32Array(mbCount * 4), new Int32Array(mbCount * 4)];
            this.mv = [new Int16Array(mbCount * 32), new Int16Array(mbCount * 32)];
            this.mv32 = [new Int32Array(this.mv[0].buffer), new Int32Array(this.mv[1].buffer)];
            this.sliceNum = new Int32Array(mbCount);
            this.filterParams = new Int32Array(mbCount);
            this.nzMask = new Uint16Array(mbCount);
            this.qp = new Uint8Array(mbCount);
            this.motionClass = new Uint8Array(mbCount);
            this.cbp = new Uint8Array(mbCount);
            this.dcFlags = new Uint8Array(mbCount);
            this.chromaMode = new Uint8Array(mbCount);
            this.intraModes = new Int8Array(mbCount * 16);
            this.nnz = new Uint8Array(mbCount * 32);
            this.mvd = [new Uint8Array(mbCount * 16), new Uint8Array(mbCount * 16)];
            this.directMask = new Uint8Array(mbCount);
            this.progress = new Int32Array(1);
        }

        if (chromaFormat === 0 && base < 0) this.data.fill(128, this.chromaOffset);
    }

    /**
     * Creates the views of a picture in kernel memory over `buffer` (again after a memory that is
     * not shared grew): samples, then the vectors, reference identifiers, reference indices, flags
     * and filter arrays of pictureBytes.
     */
    bind(buffer: ArrayBufferLike): void {
        const mbCount = this.mbWidth * this.mbHeight;
        const size = this.crOffset + this.chromaStride * this.chromaHeight;
        let at = this.base;
        this.data = new Uint8Array(buffer, at, size);
        this.words = new Uint32Array(buffer, at, size >> 2);
        this.clamped = new Uint8ClampedArray(buffer, at, size);
        at += size;
        const mv0 = new Int16Array(buffer, at, mbCount * 32);
        const mv1 = new Int16Array(buffer, at + mbCount * 64, mbCount * 32);
        this.mv = [mv0, mv1];
        this.mv32 = [
            new Int32Array(buffer, at, mbCount * 16),
            new Int32Array(buffer, at + mbCount * 64, mbCount * 16),
        ];
        at += mbCount * 128;
        this.refId = [
            new Int32Array(buffer, at, mbCount * 4),
            new Int32Array(buffer, at + mbCount * 16, mbCount * 4),
        ];
        at += mbCount * 32;
        this.ref = [
            new Int8Array(buffer, at, mbCount * 4),
            new Int8Array(buffer, at + mbCount * 4, mbCount * 4),
        ];
        at += mbCount * 8;
        this.mbFlags = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.sliceNum = new Int32Array(buffer, at, mbCount);
        at += mbCount * 4;
        this.filterParams = new Int32Array(buffer, at, mbCount);
        at += mbCount * 4;
        this.nzMask = new Uint16Array(buffer, at, mbCount);
        at += (mbCount * 2 + 3) & ~3;
        this.qp = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.motionClass = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.cbp = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.dcFlags = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.chromaMode = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.directMask = new Uint8Array(buffer, at, mbCount);
        at += (mbCount + 3) & ~3;
        this.intraModes = new Int8Array(buffer, at, mbCount * 16);
        at += mbCount * 16;
        this.nnz = new Uint8Array(buffer, at, mbCount * 32);
        at += mbCount * 32;
        this.mvd = [
            new Uint8Array(buffer, at, mbCount * 16),
            new Uint8Array(buffer, at + mbCount * 16, mbCount * 16),
        ];
        at += mbCount * 32;
        this.progress = new Int32Array(buffer, at, 1);
    }

    get mbCount(): number {
        return this.mbWidth * this.mbHeight;
    }

    /** Clears the picture-level state before decoding into it again. */
    reset(): void {
        this.mbFlags.fill(0);
        this.decodedFields = 0;
        this.refTop = REF_NONE;
        this.refBottom = REF_NONE;
        this.needsOutput = false;
        this.nonExisting = false;
        this.concealed = false;
        this.idr = false;
        this.pocReset = false;
        this.keyFrame = false;
        this.mbaff = false;
        this.fieldPicture = false;
        this.reference = false;
        this.longTermFrameIdx = 0;
    }

    isReference(): boolean {
        return this.refTop !== REF_NONE || this.refBottom !== REF_NONE;
    }

    isShortTerm(): boolean {
        return this.refTop === REF_SHORT || this.refBottom === REF_SHORT;
    }

    isLongTerm(): boolean {
        return this.refTop === REF_LONG || this.refBottom === REF_LONG;
    }

    refOf(parity: number): number {
        return parity === PICT_TOP
            ? this.refTop
            : parity === PICT_BOTTOM
              ? this.refBottom
              : Math.min(this.refTop, this.refBottom);
    }

    /** POC of a field or of the frame (the smaller field POC). */
    pocOf(parity: number): number {
        return parity === PICT_TOP
            ? this.topPoc
            : parity === PICT_BOTTOM
              ? this.bottomPoc
              : this.poc;
    }

    /** Fills the whole picture with mid grey. */
    fillGrey(): void {
        this.data.fill(128);
    }

    lumaPlane(parity: number): RefPlane {
        if (parity === PICT_FRAME)
            return {
                data: this.data,
                words: this.words,
                base: this.base,
                offset: 0,
                stride: this.lumaStride,
                width: this.lumaStride,
                height: this.lumaHeight,
            };
        return {
            data: this.data,
            words: this.words,
            base: this.base,
            offset: parity === PICT_BOTTOM ? this.lumaStride : 0,
            stride: this.lumaStride * 2,
            width: this.lumaStride,
            height: this.lumaHeight >> 1,
        };
    }

    chromaPlane(parity: number, cr: boolean): RefPlane {
        const base = cr ? this.crOffset : this.chromaOffset;
        if (parity === PICT_FRAME)
            return {
                data: this.data,
                words: this.words,
                base: this.base,
                offset: base,
                stride: this.chromaStride,
                width: this.chromaStride,
                height: this.chromaHeight,
            };
        return {
            data: this.data,
            words: this.words,
            base: this.base,
            offset: base + (parity === PICT_BOTTOM ? this.chromaStride : 0),
            stride: this.chromaStride * 2,
            width: this.chromaStride,
            height: this.chromaHeight >> 1,
        };
    }
}

/** Picture progress once every macroblock row is final. */
export const PROGRESS_DONE = 0x7fffffff;

/**
 * Bytes of a picture in kernel memory: samples, two lists of vectors, reference ids and indices,
 * flags, the filter arrays and the progress.
 */
function pictureBytes(mbWidth: number, mbHeight: number, chromaFormat: number): number {
    const mbCount = mbWidth * mbHeight;
    const chromaSamples = chromaFormat === 3 ? 256 : chromaFormat === 2 ? 128 : 64;
    const bytes = (mbCount + 3) & ~3;
    return (
        mbCount * (256 + 2 * chromaSamples) +
        mbCount * (128 + 32 + 8) +
        bytes +
        mbCount * 8 +
        ((mbCount * 2 + 3) & ~3) +
        6 * bytes +
        mbCount * (16 + 32 + 32) +
        4
    );
}

/** Packs the deblocking parameters of a slice for Picture.filterParams. */
export function filterParams(
    disableIdc: number,
    alphaOffset: number,
    betaOffset: number,
    cbQpOffset: number,
    crQpOffset: number,
): number {
    return (
        disableIdc |
        ((alphaOffset + 16) << 2) |
        ((betaOffset + 16) << 7) |
        ((cbQpOffset + 16) << 12) |
        ((crQpOffset + 16) << 17)
    );
}

/** One entry of a reference picture list. */
export interface RefEntry {
    readonly pic: Picture;
    /** PICT_TOP, PICT_BOTTOM or PICT_FRAME. */
    readonly parity: number;
    readonly poc: number;
    readonly longTerm: boolean;
    /** pic.serial * 4 + parity, matching the identifiers stored per 8x8 block. */
    readonly id: number;
    readonly luma: RefPlane;
    readonly cb: RefPlane;
    readonly cr: RefPlane;
}

export function refEntry(pic: Picture, parity: number, longTerm: boolean): RefEntry {
    return {
        pic,
        parity,
        poc: pic.pocOf(parity),
        longTerm,
        id: pic.serial * 4 + parity,
        luma: pic.lumaPlane(parity),
        cb: pic.chromaPlane(parity, false),
        cr: pic.chromaPlane(parity, true),
    };
}
