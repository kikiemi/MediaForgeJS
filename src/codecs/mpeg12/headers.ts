import type { BitReader } from './bit-reader';
import { ZIGZAG_8X8 } from '../shared/dct-scan';

export const SEQUENCE_EXTENSION_ID = 1;
export const SEQUENCE_DISPLAY_EXTENSION_ID = 2;
export const QUANT_MATRIX_EXTENSION_ID = 3;
export const PICTURE_CODING_EXTENSION_ID = 8;

export interface SequenceHeader {
    readonly horizontalSize: number;
    readonly verticalSize: number;
    readonly aspectRatio: number;
    readonly frameRateCode: number;
    /** Natural-order matrices; null selects the default. */
    readonly intraMatrix: Uint8Array | null;
    readonly nonIntraMatrix: Uint8Array | null;
}

export interface SequenceExtension {
    readonly progressiveSequence: boolean;
    /** 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4. */
    readonly chromaFormat: number;
    readonly horizontalSizeExtension: number;
    readonly verticalSizeExtension: number;
}

export interface SequenceDisplayExtension {
    /**
     * colour_primaries, transfer_characteristics and matrix_coefficients codes, or null when not
     * described.
     */
    readonly colour: readonly [number, number, number] | null;
    readonly displayWidth: number;
    readonly displayHeight: number;
}

export interface PictureHeader {
    temporalReference: number;
    /** 1 = I, 2 = P, 3 = B, 4 = D. */
    codingType: number;
    fullPelForward: number;
    forwardFCode: number;
    fullPelBackward: number;
    backwardFCode: number;
}

export interface PictureCodingExtension {
    /** f_code[s][t] at index s * 2 + t. */
    readonly fCode: Int32Array;
    intraDcPrecision: number;
    /** 1 = top field, 2 = bottom field, 3 = frame. */
    pictureStructure: number;
    topFieldFirst: number;
    framePredFrameDct: number;
    concealmentMotionVectors: number;
    qScaleType: number;
    intraVlcFormat: number;
    alternateScan: number;
    progressiveFrame: number;
}

interface QuantMatrixExtension {
    readonly intra: Uint8Array | null;
    readonly nonIntra: Uint8Array | null;
    readonly chromaIntra: Uint8Array | null;
    readonly chromaNonIntra: Uint8Array | null;
}

/** Reads 64 zig-zag ordered 8-bit weights into natural order; zero weights are forbidden. */
function readMatrix(reader: BitReader): Uint8Array | null {
    const matrix = new Uint8Array(64);
    for (let index = 0; index < 64; index++) {
        const value = reader.read(8);
        if (value === 0) return null;
        matrix[ZIGZAG_8X8[index]] = value;
    }
    return matrix;
}

/** sequence_header() after its start code (ISO/IEC 13818-2 6.2.2.1, 11172-2 2.4.2.3). */
export function readSequenceHeader(reader: BitReader): SequenceHeader | null {
    const horizontalSize = reader.read(12);
    const verticalSize = reader.read(12);
    const aspectRatio = reader.read(4);
    const frameRateCode = reader.read(4);
    reader.skip(18);
    if (reader.read(1) !== 1) return null;
    reader.skip(11);
    let intraMatrix: Uint8Array | null = null;
    let nonIntraMatrix: Uint8Array | null = null;
    if (reader.read(1) === 1 && !(intraMatrix = readMatrix(reader))) return null;
    if (reader.read(1) === 1 && !(nonIntraMatrix = readMatrix(reader))) return null;
    if (horizontalSize === 0 || verticalSize === 0 || aspectRatio === 0) return null;
    return {
        horizontalSize,
        verticalSize,
        aspectRatio,
        frameRateCode,
        intraMatrix,
        nonIntraMatrix,
    };
}

/** sequence_extension() after its identifier (6.2.2.3). */
export function readSequenceExtension(reader: BitReader): SequenceExtension | null {
    reader.skip(8);
    const progressiveSequence = reader.read(1) === 1;
    const chromaFormat = reader.read(2);
    const horizontalSizeExtension = reader.read(2);
    const verticalSizeExtension = reader.read(2);
    reader.skip(12);
    if (reader.read(1) !== 1 || chromaFormat === 0) return null;
    return { progressiveSequence, chromaFormat, horizontalSizeExtension, verticalSizeExtension };
}

/** sequence_display_extension() after its identifier (6.2.2.4). */
export function readSequenceDisplayExtension(reader: BitReader): SequenceDisplayExtension | null {
    reader.skip(3);
    let colour: [number, number, number] | null = null;
    if (reader.read(1) === 1) colour = [reader.read(8), reader.read(8), reader.read(8)];
    const displayWidth = reader.read(14);
    if (reader.read(1) !== 1) return null;
    const displayHeight = reader.read(14);
    return { colour, displayWidth, displayHeight };
}

/** group_of_pictures_header() after its start code: closed_gop and broken_link (6.2.2.6). */
export function readGroupOfPictures(reader: BitReader): {
    closedGop: boolean;
    brokenLink: boolean;
} {
    reader.skip(25);
    return { closedGop: reader.read(1) === 1, brokenLink: reader.read(1) === 1 };
}

/** picture_header() after its start code (6.2.3). */
export function readPictureHeader(reader: BitReader, header: PictureHeader): void {
    header.temporalReference = reader.read(10);
    header.codingType = reader.read(3);
    reader.skip(16);
    header.fullPelForward = 0;
    header.forwardFCode = 0;
    header.fullPelBackward = 0;
    header.backwardFCode = 0;
    if (header.codingType === 2 || header.codingType === 3) {
        header.fullPelForward = reader.read(1);
        header.forwardFCode = reader.read(3);
    }
    if (header.codingType === 3) {
        header.fullPelBackward = reader.read(1);
        header.backwardFCode = reader.read(3);
    }
}

/** picture_coding_extension() after its identifier (6.2.3.1). */
export function readPictureCodingExtension(
    reader: BitReader,
    extension: PictureCodingExtension,
): void {
    for (let index = 0; index < 4; index++) extension.fCode[index] = reader.read(4);
    extension.intraDcPrecision = reader.read(2);
    extension.pictureStructure = reader.read(2);
    extension.topFieldFirst = reader.read(1);
    extension.framePredFrameDct = reader.read(1);
    extension.concealmentMotionVectors = reader.read(1);
    extension.qScaleType = reader.read(1);
    extension.intraVlcFormat = reader.read(1);
    extension.alternateScan = reader.read(1);
    reader.skip(2);
    extension.progressiveFrame = reader.read(1);
}

/** quant_matrix_extension() after its identifier (6.2.3.2). */
export function readQuantMatrixExtension(reader: BitReader): QuantMatrixExtension | null {
    const matrices: (Uint8Array | null)[] = [];
    for (let index = 0; index < 4; index++) {
        let matrix: Uint8Array | null = null;
        if (reader.read(1) === 1 && !(matrix = readMatrix(reader))) return null;
        matrices.push(matrix);
    }
    return {
        intra: matrices[0],
        nonIntra: matrices[1],
        chromaIntra: matrices[2],
        chromaNonIntra: matrices[3],
    };
}
