import { idct8x8Add, idct8x8DcOnly, idct8x8Put } from '../shared/idct';
import type { BitReader } from './bit-reader';
import {
    CODED_BLOCK_PATTERN,
    COEFFICIENT_EOB,
    COEFFICIENT_ESCAPE,
    COEFFICIENTS_B14,
    COEFFICIENTS_B15,
    DC_SIZE_CHROMA,
    DC_SIZE_LUMA,
    MB_ADDRESS_INCREMENT,
    MB_BACKWARD,
    MB_ESCAPE,
    MB_FORWARD,
    MB_INTRA,
    MB_PATTERN,
    MB_QUANT,
    MB_STUFFING,
    MB_TYPE_B,
    MB_TYPE_I,
    MB_TYPE_P,
    MOTION_CODE,
    NON_LINEAR_QUANTISER_SCALE,
} from './tables';
import { ZIGZAG_8X8, ALTERNATE_8X8 } from '../shared/dct-scan';

export const PICTURE_I = 1;
export const PICTURE_P = 2;
export const PICTURE_B = 3;
export const FRAME_PICTURE = 3;

const MC_FRAME = 0;
const MC_FIELD = 1;
const MC_16X8 = 2;
const MC_DUAL_PRIME = 3;

/** frame_motion_type and field_motion_type codes 1-3 (ISO/IEC 13818-2 Tables 6-17 and 6-18). */
const FRAME_MOTION_TYPES = [-1, MC_FIELD, MC_FRAME, MC_DUAL_PRIME];
const FIELD_MOTION_TYPES = [-1, MC_FIELD, MC_16X8, MC_DUAL_PRIME];

/**
 * An 8-bit picture of the macroblock-aligned coded size: the Y, Cb and Cr planes back to back
 * without padding, with saturating and four-sample little-endian views of the same memory.
 */
export class PictureBuffer {
    readonly data: Uint8Array;
    readonly pixels: Uint8ClampedArray;
    readonly words: DataView;

    constructor(size: number) {
        this.data = new Uint8Array(size);
        this.pixels = new Uint8ClampedArray(this.data.buffer);
        this.words = new DataView(this.data.buffer);
    }
}

/** Per-byte (a + b + 1) >> 1 of four packed samples. */
function average4(a: number, b: number): number {
    return ((a | b) - (((a ^ b) >>> 1) & 0x7f7f7f7f)) | 0;
}

/** Per-byte (a + b + c + d + 2) >> 2 of four packed samples. */
function average16(a: number, b: number, c: number, d: number): number {
    const low =
        (((a & 0x03030303) +
            (b & 0x03030303) +
            (c & 0x03030303) +
            (d & 0x03030303) +
            0x02020202) >>>
            2) &
        0x03030303;
    return (
        (((a >>> 2) & 0x3f3f3f3f) +
            ((b >>> 2) & 0x3f3f3f3f) +
            ((c >>> 2) & 0x3f3f3f3f) +
            ((d >>> 2) & 0x3f3f3f3f) +
            low) |
        0
    );
}

export interface PictureGeometry {
    readonly mpeg2: boolean;
    readonly chroma422: boolean;
    readonly mbWidth: number;
    /** Frame macroblock rows. */
    readonly mbHeight: number;
    readonly width: number;
    readonly height: number;
    readonly chromaWidth: number;
    readonly chromaHeight: number;
    readonly size: number;
    /** slice_vertical_position_extension is present (vertical_size above 2800). */
    readonly verticalPositionExtension: boolean;
}

export interface QuantiserMatrices {
    intra: Uint8Array;
    nonIntra: Uint8Array;
    chromaIntra: Uint8Array;
    chromaNonIntra: Uint8Array;
}

export interface PictureParameters {
    codingType: number;
    /** picture_structure: 1 top field, 2 bottom field, 3 frame. */
    structure: number;
    secondField: boolean;
    /** f_code[s][t] at s * 2 + t; MPEG-1 repeats forward_f_code and backward_f_code. */
    readonly fCode: Int32Array;
    fullPelForward: number;
    fullPelBackward: number;
    intraDcPrecision: number;
    framePredFrameDct: number;
    concealmentMotionVectors: number;
    qScaleType: number;
    intraVlcFormat: number;
    alternateScan: number;
    topFieldFirst: number;
}

/** Truncating division by two of a half-sample motion vector for subsampled chroma (7.6.3.7). */
function halve(vector: number): number {
    return (vector + (vector >>> 31)) >> 1;
}

/**
 * Decodes the slices of one field or frame picture into a picture buffer and conceals what they
 * leave out.
 */
export class PictureDecoder {
    private mpeg2 = true;
    private chroma422 = false;
    private blockCount = 6;
    private mbWidth = 0;
    private mbHeight = 0;
    private width = 0;
    private height = 0;
    private chromaWidth = 0;
    private chromaHeight = 0;
    private cbOffset = 0;
    private crOffset = 0;
    private verticalPositionExtension = false;

    private codingType = PICTURE_I;
    private frameStructure = true;
    private bottomField = 0;
    private secondField = false;
    private readonly fCode = new Int32Array(4);
    private fullPelForward = 0;
    private fullPelBackward = 0;
    private dcShift = 3;
    private dcReset = 128;
    private framePredFrameDct = 1;
    private concealmentVectors = 0;
    private nonLinearScale = false;
    private intraTable = COEFFICIENTS_B14;
    private scan = ZIGZAG_8X8;
    private topFieldFirst = 1;
    private matrices!: QuantiserMatrices;

    private current!: PictureBuffer;
    private forward!: PictureBuffer;
    private backward!: PictureBuffer;

    private mbRows = 0;
    private mbCount = 0;
    private lineStride = 0;
    private chromaLineStride = 0;
    private limit = 0;
    private mbx = 0;
    private mby = 0;
    private lumaBase = 0;
    private chromaBase = 0;
    private quantiserScale = 0;
    private readonly dcPrediction = new Int32Array(3);
    /** PMV[r][s][t] and vector[r][s][t] at r * 4 + s * 2 + t. */
    private readonly pmv = new Int32Array(8);
    private readonly vector = new Int32Array(8);
    /** motion_vertical_field_select[r][s] at r * 2 + s. */
    private readonly fieldSelect = new Int32Array(4);
    private readonly dualPrime = new Int32Array(2);
    private motionType = MC_FRAME;
    private dctType = 0;
    private previousMotion = 0;
    private corrupt = false;
    private mismatch = 0;
    private readonly block = new Int32Array(64);
    private readonly edge = new PictureBuffer(17 * 17 + 3);
    private decoded = new Uint8Array(0);

    constructor(private readonly reader: BitReader) {}

    configure(geometry: PictureGeometry): void {
        this.mpeg2 = geometry.mpeg2;
        this.chroma422 = geometry.chroma422;
        this.blockCount = geometry.chroma422 ? 8 : 6;
        this.mbWidth = geometry.mbWidth;
        this.mbHeight = geometry.mbHeight;
        this.width = geometry.width;
        this.height = geometry.height;
        this.chromaWidth = geometry.chromaWidth;
        this.chromaHeight = geometry.chromaHeight;
        this.cbOffset = geometry.width * geometry.height;
        this.crOffset = this.cbOffset + geometry.chromaWidth * geometry.chromaHeight;
        this.verticalPositionExtension = geometry.verticalPositionExtension;
        if (this.decoded.length < geometry.mbWidth * geometry.mbHeight) {
            this.decoded = new Uint8Array(geometry.mbWidth * geometry.mbHeight);
        }
    }

    /**
     * Starts a picture. `forward` and `backward` must be usable buffers for every prediction the
     * picture type allows; the caller substitutes stand-ins for missing references.
     */
    begin(
        parameters: PictureParameters,
        matrices: QuantiserMatrices,
        current: PictureBuffer,
        forward: PictureBuffer,
        backward: PictureBuffer,
    ): void {
        this.codingType = parameters.codingType;
        this.frameStructure = parameters.structure === 3;
        this.bottomField = parameters.structure === 2 ? 1 : 0;
        this.secondField = parameters.secondField;
        this.fCode.set(parameters.fCode);
        this.fullPelForward = parameters.fullPelForward;
        this.fullPelBackward = parameters.fullPelBackward;
        this.dcShift = 3 - parameters.intraDcPrecision;
        this.dcReset = 128 << parameters.intraDcPrecision;
        this.framePredFrameDct = parameters.framePredFrameDct;
        this.concealmentVectors = parameters.concealmentMotionVectors;
        this.nonLinearScale = parameters.qScaleType === 1;
        this.intraTable = parameters.intraVlcFormat ? COEFFICIENTS_B15 : COEFFICIENTS_B14;
        this.scan = parameters.alternateScan ? ALTERNATE_8X8 : ZIGZAG_8X8;
        this.topFieldFirst = parameters.topFieldFirst;
        this.matrices = matrices;
        this.current = current;
        this.forward = forward;
        this.backward = backward;
        this.mbRows = this.frameStructure ? this.mbHeight : this.mbHeight >> 1;
        this.mbCount = this.mbWidth * this.mbRows;
        this.lineStride = this.frameStructure ? this.width : this.width * 2;
        this.chromaLineStride = this.frameStructure ? this.chromaWidth : this.chromaWidth * 2;
        this.decoded.fill(0, 0, this.mbCount);
    }

    /**
     * Decodes one slice whose data spans bit positions [start, end) after its start code. Returns
     * false when the slice is damaged; macroblocks it did not complete stay missing for `finish`.
     */
    decodeSlice(start: number, end: number, verticalPosition: number): boolean {
        const reader = this.reader;
        reader.pos = start;
        this.limit = end;
        let row = verticalPosition - 1;
        if (this.verticalPositionExtension) row += reader.read(3) << 7;
        if (row >= this.mbRows || !this.setQuantiser(reader.read(5))) return false;
        if (this.mpeg2 && reader.peek(1) === 1) reader.skip(9);
        while (reader.read(1) === 1) {
            reader.skip(8);
            if (reader.pos > end) return false;
        }
        this.resetDc();
        this.pmv.fill(0);
        this.previousMotion = 0;
        this.corrupt = false;
        let increment = this.readAddressIncrement();
        if (increment < 1 || (this.mpeg2 && increment > this.mbWidth)) return false;
        let address = row * this.mbWidth + increment - 1;
        const rowEnd = this.mpeg2 ? (row + 1) * this.mbWidth : this.mbCount;
        for (;;) {
            if (
                address >= rowEnd ||
                !this.decodeMacroblock(address) ||
                this.corrupt ||
                reader.pos > end
            )
                return false;
            this.decoded[address] = 1;
            if (reader.pos >= end || reader.peek(23) === 0) return true;
            increment = this.readAddressIncrement();
            if (increment < 1 || address + increment >= rowEnd) return false;
            for (let skipped = address + 1; skipped < address + increment; skipped++) {
                if (!this.skipMacroblock(skipped)) return false;
                this.decoded[skipped] = 1;
            }
            address += increment;
        }
    }

    /**
     * Conceals every macroblock no slice completed by copying the co-located samples of `source`,
     * or mid grey without one. Returns the number of concealed macroblocks.
     */
    finish(source: PictureBuffer | null): number {
        let concealed = 0;
        for (let address = 0; address < this.mbCount; address++) {
            if (this.decoded[address] === 0) {
                this.concealMacroblock(address, source);
                concealed++;
            }
        }
        return concealed;
    }

    private setQuantiser(code: number): boolean {
        if (code === 0) return false;
        this.quantiserScale = this.nonLinearScale ? NON_LINEAR_QUANTISER_SCALE[code] : code << 1;
        return true;
    }

    private resetDc(): void {
        this.dcPrediction[0] = this.dcReset;
        this.dcPrediction[1] = this.dcReset;
        this.dcPrediction[2] = this.dcReset;
    }

    private readAddressIncrement(): number {
        const reader = this.reader;
        let increment = 0;
        for (;;) {
            const entry = MB_ADDRESS_INCREMENT[reader.peek(11)];
            if (entry === 0) return -1;
            reader.skip(entry >> 8);
            const value = entry & 255;
            if (value === MB_ESCAPE) increment += 33;
            else if (value !== MB_STUFFING) return increment + value;
            if (reader.pos > this.limit) return -1;
        }
    }

    private setPosition(address: number): void {
        const mbx = address % this.mbWidth;
        const mby = (address - mbx) / this.mbWidth;
        this.mbx = mbx;
        this.mby = mby;
        const fieldOffset = this.frameStructure ? 0 : this.bottomField;
        this.lumaBase = fieldOffset * this.width + mby * 16 * this.lineStride + mbx * 16;
        this.chromaBase =
            fieldOffset * this.chromaWidth +
            mby * (this.chroma422 ? 16 : 8) * this.chromaLineStride +
            mbx * 8;
    }

    private decodeMacroblock(address: number): boolean {
        const reader = this.reader;
        this.setPosition(address);
        const typeTable =
            this.codingType === PICTURE_I
                ? MB_TYPE_I
                : this.codingType === PICTURE_P
                  ? MB_TYPE_P
                  : MB_TYPE_B;
        const entry = typeTable[reader.peek(6)];
        if (entry === 0) return false;
        reader.skip(entry >> 8);
        const flags = entry & 255;
        const motion = flags & (MB_FORWARD | MB_BACKWARD);
        this.dctType = 0;
        if (this.mpeg2) {
            if (motion !== 0) {
                if (this.frameStructure && this.framePredFrameDct) this.motionType = MC_FRAME;
                else {
                    const code = reader.read(2);
                    if (code === 0) return false;
                    this.motionType = this.frameStructure
                        ? FRAME_MOTION_TYPES[code]
                        : FIELD_MOTION_TYPES[code];
                    if (
                        this.motionType === MC_DUAL_PRIME &&
                        (this.codingType !== PICTURE_P || motion !== MB_FORWARD)
                    ) {
                        return false;
                    }
                }
            }
            if (
                this.frameStructure &&
                !this.framePredFrameDct &&
                (flags & (MB_INTRA | MB_PATTERN)) !== 0
            ) {
                this.dctType = reader.read(1);
            }
        } else this.motionType = MC_FRAME;
        if ((flags & MB_QUANT) !== 0 && !this.setQuantiser(reader.read(5))) return false;
        if ((flags & MB_INTRA) !== 0) {
            if (this.concealmentVectors) this.readConcealmentVectors();
            else this.pmv.fill(0);
            this.previousMotion = 0;
            for (let block = 0; block < this.blockCount; block++)
                if (!this.intraBlock(block)) return false;
            return true;
        }
        this.resetDc();
        if (motion === 0) {
            this.pmv.fill(0);
            this.setZeroForwardVector();
        } else {
            if ((motion & MB_FORWARD) !== 0) this.readVectors(0);
            if ((motion & MB_BACKWARD) !== 0) this.readVectors(1);
            if (this.corrupt) return false;
        }
        this.previousMotion = motion === 0 ? MB_FORWARD : motion;
        this.predict(this.previousMotion);
        if ((flags & MB_PATTERN) === 0) return true;
        const patternEntry = CODED_BLOCK_PATTERN[reader.peek(9)];
        if (patternEntry === 0) return false;
        reader.skip(patternEntry >> 8);
        let pattern = patternEntry & 255;
        if (this.chroma422) pattern = (pattern << 2) | reader.read(2);
        for (let block = 0; block < this.blockCount; block++) {
            if ((pattern & (1 << (this.blockCount - 1 - block))) !== 0 && !this.interBlock(block))
                return false;
        }
        return true;
    }

    /**
     * A P-picture macroblock without motion vectors predicts from the same position of the same
     * parity.
     */
    private setZeroForwardVector(): void {
        this.motionType = this.frameStructure ? MC_FRAME : MC_FIELD;
        this.vector[0] = 0;
        this.vector[1] = 0;
        this.fieldSelect[0] = this.bottomField;
    }

    private skipMacroblock(address: number): boolean {
        this.setPosition(address);
        this.resetDc();
        if (this.codingType === PICTURE_P) {
            this.pmv.fill(0);
            this.setZeroForwardVector();
            this.predict(MB_FORWARD);
            return true;
        }
        if (this.previousMotion === 0) return false;
        this.motionType = this.frameStructure ? MC_FRAME : MC_FIELD;
        const forwardShift = this.fullPelForward;
        const backwardShift = this.fullPelBackward;
        this.vector[0] = this.pmv[0] << forwardShift;
        this.vector[1] = this.pmv[1] << forwardShift;
        this.vector[2] = this.pmv[2] << backwardShift;
        this.vector[3] = this.pmv[3] << backwardShift;
        this.fieldSelect[0] = this.bottomField;
        this.fieldSelect[1] = this.bottomField;
        this.predict(this.previousMotion);
        return true;
    }

    private readConcealmentVectors(): void {
        const reader = this.reader;
        if (!this.frameStructure) reader.skip(1);
        const pmv = this.pmv;
        pmv[0] = pmv[4] = this.readMotionComponent(this.fCode[0], pmv[0]);
        pmv[1] = pmv[5] = this.readMotionComponent(this.fCode[1], pmv[1]);
        reader.skip(1);
    }

    /** Decodes motion_vectors(s) for the current motion type and updates the predictors (7.6.3). */
    private readVectors(s: number): void {
        const reader = this.reader;
        const pmv = this.pmv;
        const vector = this.vector;
        const fx = this.fCode[s * 2];
        const fy = this.fCode[s * 2 + 1];
        const p = s * 2;
        switch (this.motionType) {
            case MC_FRAME: {
                const x = this.readMotionComponent(fx, pmv[p]);
                const y = this.readMotionComponent(fy, pmv[p + 1]);
                pmv[p] = pmv[p + 4] = x;
                pmv[p + 1] = pmv[p + 5] = y;
                const fullPel = s === 0 ? this.fullPelForward : this.fullPelBackward;
                vector[p] = x << fullPel;
                vector[p + 1] = y << fullPel;
                break;
            }
            case MC_FIELD:
                if (this.frameStructure) {
                    for (let r = 0; r < 2; r++) {
                        const q = r * 4 + p;
                        this.fieldSelect[r * 2 + s] = reader.read(1);
                        const x = this.readMotionComponent(fx, pmv[q]);
                        const y = this.readMotionComponent(fy, pmv[q + 1] >> 1);
                        pmv[q] = x;
                        pmv[q + 1] = y * 2;
                        vector[q] = x;
                        vector[q + 1] = y;
                    }
                } else {
                    this.fieldSelect[s] = reader.read(1);
                    const x = this.readMotionComponent(fx, pmv[p]);
                    const y = this.readMotionComponent(fy, pmv[p + 1]);
                    pmv[p] = pmv[p + 4] = x;
                    pmv[p + 1] = pmv[p + 5] = y;
                    vector[p] = x;
                    vector[p + 1] = y;
                }
                break;
            case MC_16X8:
                for (let r = 0; r < 2; r++) {
                    const q = r * 4 + p;
                    this.fieldSelect[r * 2 + s] = reader.read(1);
                    const x = this.readMotionComponent(fx, pmv[q]);
                    const y = this.readMotionComponent(fy, pmv[q + 1]);
                    pmv[q] = x;
                    pmv[q + 1] = y;
                    vector[q] = x;
                    vector[q + 1] = y;
                }
                break;
            default: {
                const x = this.readMotionComponent(fx, pmv[0]);
                this.dualPrime[0] = this.readDualPrimeComponent();
                const y = this.readMotionComponent(fy, this.frameStructure ? pmv[1] >> 1 : pmv[1]);
                this.dualPrime[1] = this.readDualPrimeComponent();
                pmv[0] = pmv[4] = x;
                pmv[1] = pmv[5] = this.frameStructure ? y * 2 : y;
                vector[0] = x;
                vector[1] = y;
            }
        }
    }

    /**
     * One motion vector component: motion_code, motion_residual and the wrap into the f_code range
     * (7.6.3.1). f_code values outside 1-9 mark a direction the picture does not use.
     */
    private readMotionComponent(fCode: number, prediction: number): number {
        const reader = this.reader;
        const entry = MOTION_CODE[reader.peek(10)];
        if (entry === 0 || fCode < 1 || fCode > 9) {
            this.corrupt = true;
            return prediction;
        }
        reader.skip(entry >> 8);
        const magnitude = entry & 255;
        if (magnitude === 0) return prediction;
        const negative = reader.read(1);
        const rSize = fCode - 1;
        const delta = rSize > 0 ? ((magnitude - 1) << rSize) + reader.read(rSize) + 1 : magnitude;
        const shift = 27 - rSize;
        return ((prediction + (negative ? -delta : delta)) << shift) >> shift;
    }

    /** dmvector (Table B.11). */
    private readDualPrimeComponent(): number {
        const reader = this.reader;
        if (reader.read(1) === 0) return 0;
        return reader.read(1) === 1 ? -1 : 1;
    }

    /**
     * Forms the prediction of the current macroblock for the given directions, averaging
     * bidirectional ones.
     */
    private predict(directions: number): void {
        if ((directions & MB_FORWARD) !== 0) this.predictDirection(0, false);
        if ((directions & MB_BACKWARD) !== 0)
            this.predictDirection(1, (directions & MB_FORWARD) !== 0);
    }

    /** The picture holding reference field `field` for direction s (7.6.2.1). */
    private reference(s: number, field: number): PictureBuffer {
        if (s === 1) return this.backward;
        if (this.secondField && this.codingType === PICTURE_P && field !== this.bottomField)
            return this.current;
        return this.forward;
    }

    private predictDirection(s: number, average: boolean): void {
        const vector = this.vector;
        const x = this.mbx * 16;
        const lumaBase = this.lumaBase;
        const chromaBase = this.chromaBase;
        const p = s * 2;
        switch (this.motionType) {
            case MC_FRAME:
                this.predictBlock(
                    this.reference(s, 0),
                    -1,
                    x,
                    this.mby * 16,
                    16,
                    vector[p],
                    vector[p + 1],
                    lumaBase,
                    this.lineStride,
                    chromaBase,
                    this.chromaLineStride,
                    average,
                );
                break;
            case MC_FIELD:
                if (this.frameStructure) {
                    for (let r = 0; r < 2; r++) {
                        const field = this.fieldSelect[r * 2 + s];
                        this.predictBlock(
                            this.reference(s, field),
                            field,
                            x,
                            this.mby * 8,
                            8,
                            vector[r * 4 + p],
                            vector[r * 4 + p + 1],
                            lumaBase + r * this.width,
                            this.width * 2,
                            chromaBase + r * this.chromaWidth,
                            this.chromaWidth * 2,
                            average,
                        );
                    }
                } else {
                    const field = this.fieldSelect[s];
                    this.predictBlock(
                        this.reference(s, field),
                        field,
                        x,
                        this.mby * 16,
                        16,
                        vector[p],
                        vector[p + 1],
                        lumaBase,
                        this.lineStride,
                        chromaBase,
                        this.chromaLineStride,
                        average,
                    );
                }
                break;
            case MC_16X8: {
                const chromaRows = this.chroma422 ? 8 : 4;
                for (let r = 0; r < 2; r++) {
                    const field = this.fieldSelect[r * 2 + s];
                    this.predictBlock(
                        this.reference(s, field),
                        field,
                        x,
                        this.mby * 16 + r * 8,
                        8,
                        vector[r * 4 + p],
                        vector[r * 4 + p + 1],
                        lumaBase + r * 8 * this.lineStride,
                        this.lineStride,
                        chromaBase + r * chromaRows * this.chromaLineStride,
                        this.chromaLineStride,
                        average,
                    );
                }
                break;
            }
            default:
                this.predictDualPrime();
        }
    }

    /**
     * Dual-prime prediction (7.6.3.6): the same-parity prediction averaged with the derived
     * opposite-parity one.
     */
    private predictDualPrime(): void {
        const mx = this.vector[0];
        const my = this.vector[1];
        const dx = this.dualPrime[0];
        const dy = this.dualPrime[1];
        const x = this.mbx * 16;
        if (this.frameStructure) {
            const y = this.mby * 8;
            const width = this.width;
            const chromaWidth = this.chromaWidth;
            for (let field = 0; field < 2; field++) {
                this.predictBlock(
                    this.forward,
                    field,
                    x,
                    y,
                    8,
                    mx,
                    my,
                    this.lumaBase + field * width,
                    width * 2,
                    this.chromaBase + field * chromaWidth,
                    chromaWidth * 2,
                    false,
                );
            }
            for (let field = 0; field < 2; field++) {
                const scale = (field === 0) === (this.topFieldFirst === 1) ? 1 : 3;
                this.predictBlock(
                    this.forward,
                    1 - field,
                    x,
                    y,
                    8,
                    ((mx * scale + (mx > 0 ? 1 : 0)) >> 1) + dx,
                    ((my * scale + (my > 0 ? 1 : 0)) >> 1) + dy + (field === 0 ? -1 : 1),
                    this.lumaBase + field * width,
                    width * 2,
                    this.chromaBase + field * chromaWidth,
                    chromaWidth * 2,
                    true,
                );
            }
            return;
        }
        const parity = this.bottomField;
        const y = this.mby * 16;
        this.predictBlock(
            this.reference(0, parity),
            parity,
            x,
            y,
            16,
            mx,
            my,
            this.lumaBase,
            this.lineStride,
            this.chromaBase,
            this.chromaLineStride,
            false,
        );
        this.predictBlock(
            this.reference(0, 1 - parity),
            1 - parity,
            x,
            y,
            16,
            ((mx + (mx > 0 ? 1 : 0)) >> 1) + dx,
            ((my + (my > 0 ? 1 : 0)) >> 1) + dy + (parity === 0 ? -1 : 1),
            this.lumaBase,
            this.lineStride,
            this.chromaBase,
            this.chromaLineStride,
            true,
        );
    }

    /**
     * Predicts a 16-wide luma block of `rows` lines at (x, y) of a reference frame (field -1) or
     * field, and the matching chroma blocks, into the current picture.
     */
    private predictBlock(
        reference: PictureBuffer,
        field: number,
        x: number,
        y: number,
        rows: number,
        mvx: number,
        mvy: number,
        lumaTarget: number,
        lumaStride: number,
        chromaTarget: number,
        chromaStride: number,
        average: boolean,
    ): void {
        const fieldPicture = field >= 0;
        const width = this.width;
        const height = fieldPicture ? this.height >> 1 : this.height;
        this.predictPlane(
            reference,
            fieldPicture ? field * width : 0,
            fieldPicture ? width * 2 : width,
            width,
            height,
            x,
            y,
            mvx,
            mvy,
            16,
            rows,
            lumaTarget,
            lumaStride,
            average,
        );
        const chromaWidth = this.chromaWidth;
        const chromaHeight = fieldPicture ? this.chromaHeight >> 1 : this.chromaHeight;
        const chromaSourceStride = fieldPicture ? chromaWidth * 2 : chromaWidth;
        const fieldOffset = fieldPicture ? field * chromaWidth : 0;
        const cx = x >> 1;
        const cmvx = halve(mvx);
        const cy = this.chroma422 ? y : y >> 1;
        const chromaRows = this.chroma422 ? rows : rows >> 1;
        const cmvy = this.chroma422 ? mvy : halve(mvy);
        for (
            let plane = this.cbOffset;
            plane <= this.crOffset;
            plane += this.crOffset - this.cbOffset
        ) {
            this.predictPlane(
                reference,
                plane + fieldOffset,
                chromaSourceStride,
                chromaWidth,
                chromaHeight,
                cx,
                cy,
                cmvx,
                cmvy,
                8,
                chromaRows,
                plane + chromaTarget,
                chromaStride,
                average,
            );
        }
    }

    /**
     * Half-sample prediction of a width x rows block (7.6.4) with the standard (a + b + 1) >> 1 and
     * (a + b + c + d + 2) >> 2 rounding, four samples at a time; averaging with the existing
     * samples forms bidirectional predictions. Samples outside the reference repeat its edge.
     */
    private predictPlane(
        reference: PictureBuffer,
        base: number,
        stride: number,
        planeWidth: number,
        planeHeight: number,
        x: number,
        y: number,
        mvx: number,
        mvy: number,
        width: number,
        rows: number,
        target: number,
        targetStride: number,
        average: boolean,
    ): void {
        const hx = mvx & 1;
        const hy = mvy & 1;
        const sx = x + (mvx >> 1);
        const sy = y + (mvy >> 1);
        let src = reference.words;
        let index: number;
        let srcStride = stride;
        if (sx < 0 || sy < 0 || sx + width + hx > planeWidth || sy + rows + hy > planeHeight) {
            const source = reference.data;
            const edge = this.edge.data;
            const edgeStride = width + 1;
            for (let j = 0; j <= rows; j++) {
                const row = sy + j < 0 ? 0 : sy + j >= planeHeight ? planeHeight - 1 : sy + j;
                const rowStart = base + row * stride;
                for (let i = 0; i <= width; i++) {
                    const column = sx + i < 0 ? 0 : sx + i >= planeWidth ? planeWidth - 1 : sx + i;
                    edge[j * edgeStride + i] = source[rowStart + column];
                }
            }
            src = this.edge.words;
            index = 0;
            srcStride = edgeStride;
        } else index = base + sy * stride + sx;
        const out = this.current.words;
        const mode = (hy << 1) | hx;
        for (let j = 0; j < rows; j++, index += srcStride, target += targetStride) {
            for (let k = 0; k < width; k += 4) {
                const i = index + k;
                let value: number;
                if (mode === 0) value = src.getInt32(i, true);
                else if (mode === 1)
                    value = average4(src.getInt32(i, true), src.getInt32(i + 1, true));
                else if (mode === 2)
                    value = average4(src.getInt32(i, true), src.getInt32(i + srcStride, true));
                else {
                    value = average16(
                        src.getInt32(i, true),
                        src.getInt32(i + 1, true),
                        src.getInt32(i + srcStride, true),
                        src.getInt32(i + srcStride + 1, true),
                    );
                }
                if (average) value = average4(out.getInt32(target + k, true), value);
                out.setInt32(target + k, value, true);
            }
        }
    }

    /**
     * Sample offset and line stride of coded block n of the current macroblock (6.1.3, Figures 6-13
     * and 6-14).
     */
    private blockTarget(block: number): number {
        const field = this.dctType;
        if (block < 4) {
            const rowOffset = field ? block >> 1 : (block >> 1) * 8;
            return this.lumaBase + rowOffset * this.lineStride + (block & 1) * 8;
        }
        const plane = (block & 1) === 0 ? this.cbOffset : this.crOffset;
        if (block < 6) return plane + this.chromaBase;
        return plane + this.chromaBase + (field ? 1 : 8) * this.chromaLineStride;
    }

    private blockStride(block: number): number {
        const lines = block < 4 ? this.lineStride : this.chromaLineStride;
        return this.dctType && (block < 4 || this.chroma422) ? lines * 2 : lines;
    }

    private intraBlock(block: number): boolean {
        const reader = this.reader;
        const component = block < 4 ? 0 : (block & 1) + 1;
        const bits = reader.peek32();
        const sizeEntry = (component === 0 ? DC_SIZE_LUMA : DC_SIZE_CHROMA)[bits >>> 22];
        let length = sizeEntry >> 8;
        const size = sizeEntry & 255;
        let differential = 0;
        if (size !== 0) {
            differential = (bits << length) >>> (32 - size);
            if (differential < 1 << (size - 1)) differential -= (1 << size) - 1;
            length += size;
        }
        reader.skip(length);
        const dc = this.dcPrediction[component] + differential;
        this.dcPrediction[component] = dc;
        let value = dc << this.dcShift;
        if (value > 2047) value = 2047;
        else if (value < -2048) value = -2048;
        const coefficients = this.block;
        coefficients[0] = value;
        this.mismatch = value;
        const matrix = component === 0 ? this.matrices.intra : this.matrices.chromaIntra;
        const last = this.readCoefficients(this.intraTable, 1, matrix, true);
        if (last < 0) {
            coefficients.fill(0);
            return false;
        }
        const target = this.blockTarget(block);
        const stride = this.blockStride(block);
        if (last === 0 && coefficients[63] === 0) {
            const sample = idct8x8DcOnly(value);
            const packed = (sample < 0 ? 0 : sample > 255 ? 255 : sample) * 0x01010101;
            const words = this.current.words;
            coefficients[0] = 0;
            for (let row = 0, o = target; row < 8; row++, o += stride) {
                words.setInt32(o, packed, true);
                words.setInt32(o + 4, packed, true);
            }
            return true;
        }
        idct8x8Put(coefficients, this.current.pixels, target, stride);
        coefficients.fill(0);
        return true;
    }

    private interBlock(block: number): boolean {
        const matrix = block < 4 ? this.matrices.nonIntra : this.matrices.chromaNonIntra;
        this.mismatch = 0;
        const last = this.readCoefficients(COEFFICIENTS_B14, 0, matrix, false);
        const coefficients = this.block;
        if (last < 0) {
            coefficients.fill(0);
            return false;
        }
        const target = this.blockTarget(block);
        const stride = this.blockStride(block);
        const pixels = this.current.pixels;
        if (last === 0 && coefficients[63] === 0) {
            const residual = idct8x8DcOnly(coefficients[0]);
            coefficients[0] = 0;
            if (residual === 0) return true;
            for (let row = 0, o = target; row < 8; row++, o += stride) {
                for (let i = o; i < o + 8; i++) pixels[i] = pixels[i] + residual;
            }
            return true;
        }
        idct8x8Add(coefficients, pixels, target, stride);
        coefficients.fill(0);
        return true;
    }

    /**
     * Decodes run/level pairs from scan position `first` into this.block with inverse quantisation
     * (7.4): MPEG-2 saturation and mismatch control, or MPEG-1 oddification. Returns the last scan
     * position, or -1 when damaged.
     */
    private readCoefficients(
        table: Int32Array,
        first: number,
        matrix: Uint8Array,
        intra: boolean,
    ): number {
        const reader = this.reader;
        const words = reader.words;
        const block = this.block;
        const scan = this.scan;
        const scale = this.quantiserScale;
        const mpeg2 = this.mpeg2;
        let pos = reader.pos;
        let mismatch = this.mismatch;
        let i = first - 1;
        for (;;) {
            const index = pos >>> 5;
            const shift = pos & 31;
            const bits = (words[index] << shift) | ((words[index + 1] >>> 1) >>> (31 - shift));
            let level: number;
            let negative: number;
            if (i < 0 && bits < 0) {
                i = 0;
                level = 1;
                negative = (bits >>> 30) & 1;
                pos += 2;
            } else {
                let entry = table[bits >>> 22];
                if (entry < 0) entry = table[1024 + ((bits >>> 16) & 511)];
                const run = (entry >> 5) & 63;
                if (run < 32) {
                    const length = entry & 31;
                    if (length === 0) return -1;
                    i += run + 1;
                    level = entry >>> 11;
                    negative = (bits >>> (32 - length)) & 1;
                    pos += length;
                } else if (run === COEFFICIENT_EOB) {
                    pos += entry & 31;
                    break;
                } else if (run === COEFFICIENT_ESCAPE) {
                    i += ((bits >>> 20) & 63) + 1;
                    if (mpeg2) {
                        level = (bits << 12) >> 20;
                        pos += 24;
                    } else {
                        level = (bits << 12) >> 24;
                        if ((level & 127) === 0) {
                            level = level === 0 ? (bits >>> 4) & 255 : ((bits >>> 4) & 255) - 256;
                            pos += 28;
                        } else pos += 20;
                    }
                    if (level === 0) return -1;
                    negative = level < 0 ? 1 : 0;
                    if (negative) level = -level;
                } else return -1;
            }
            if (i > 63) return -1;
            const j = scan[i];
            let value = intra
                ? (level * matrix[j] * scale) >> 4
                : ((level * 2 + 1) * matrix[j] * scale) >> 5;
            if (mpeg2) {
                if (negative) value = -value;
                if (value > 2047) value = 2047;
                else if (value < -2048) value = -2048;
                mismatch ^= value;
            } else {
                if (value !== 0) value = (value - 1) | 1;
                if (negative) value = value > 2048 ? -2048 : -value;
                else if (value > 2047) value = 2047;
            }
            block[j] = value;
        }
        reader.pos = pos;
        if (mpeg2 && (mismatch & 1) === 0) block[63] ^= 1;
        return i;
    }

    private concealMacroblock(address: number, source: PictureBuffer | null): void {
        this.setPosition(address);
        const out = this.current.data;
        const from = source ? source.data : null;
        const chromaRows = this.chroma422 ? 16 : 8;
        for (let row = 0, o = this.lumaBase; row < 16; row++, o += this.lineStride) {
            if (from) out.set(from.subarray(o, o + 16), o);
            else out.fill(128, o, o + 16);
        }
        for (const plane of [this.cbOffset, this.crOffset]) {
            for (
                let row = 0, o = plane + this.chromaBase;
                row < chromaRows;
                row++, o += this.chromaLineStride
            ) {
                if (from) out.set(from.subarray(o, o + 8), o);
                else out.fill(128, o, o + 8);
            }
        }
    }
}
