import type { BitReader } from './bit-reader';
import { DEFAULT_INTER_MATRIX, DEFAULT_INTRA_MATRIX, PIXEL_ASPECT } from './tables';
import { ZIGZAG_8X8 } from '../shared/dct-scan';

export const VOP_I = 0;
export const VOP_P = 1;
export const VOP_B = 2;
export const VOP_S = 3;

const SPRITE_STATIC = 1;
export const SPRITE_GMC = 2;

/** Rectangular video object layer parameters, ISO/IEC 14496-2 6.2.3. */
export interface VideoObjectLayer {
    readonly objectType: number;
    readonly parNum: number;
    readonly parDen: number;
    readonly controlParameters: boolean;
    readonly lowDelay: boolean;
    /**
     * vop_time_increment_resolution in ticks per second, and the bit width of vop_time_increment.
     */
    readonly timeResolution: number;
    readonly timeIncrementBits: number;
    readonly width: number;
    readonly height: number;
    readonly interlaced: boolean;
    readonly spriteEnable: number;
    readonly spriteWarpingPoints: number;
    readonly spriteAccuracy: number;
    readonly spriteBrightnessChange: boolean;
    readonly quantPrecision: number;
    readonly mpegQuant: boolean;
    /** Natural-order quantiser matrices; defaults when not loaded. */
    readonly intraMatrix: Uint8Array;
    readonly interMatrix: Uint8Array;
    readonly quarterSample: boolean;
    /**
     * Complexity estimation bits carried by every VOP header, and additionally by non-I and B VOPs.
     */
    readonly estimationBitsAll: number;
    readonly estimationBitsInter: number;
    readonly estimationBitsB: number;
    readonly resyncMarkers: boolean;
    readonly dataPartitioned: boolean;
    readonly reversibleVlc: boolean;
    readonly newPred: boolean;
}

/** Colour description from visual_object's video_signal_type, ISO/IEC 14496-2 6.3.2. */
export interface VideoSignalType {
    readonly fullRange: boolean;
    readonly primaries: number;
    readonly transfer: number;
    readonly matrix: number;
}

/** Encoder identification from user data; -1 when absent. */
export interface EncoderInfo {
    divxVersion: number;
    divxBuild: number;
    divxPacked: boolean;
    xvidBuild: number;
    lavcBuild: number;
}

export function unknownEncoder(): EncoderInfo {
    return { divxVersion: -1, divxBuild: -1, divxPacked: false, xvidBuild: -1, lavcBuild: -1 };
}

function marker(br: BitReader): void {
    br.skip(1);
}

function readMatrix(br: BitReader, fallback: Uint8Array): Uint8Array {
    const matrix = Uint8Array.from(fallback);
    let last = 0;
    let index = 0;
    for (; index < 64; index++) {
        const value = br.read(8);
        if (value === 0) break;
        last = value;
        matrix[ZIGZAG_8X8[index]] = value;
    }
    for (; index < 64; index++) matrix[ZIGZAG_8X8[index]] = last;
    return matrix;
}

function complexityEstimation(br: BitReader): [number, number, number] {
    const start = br.pos;
    const method = br.read(2);
    let all = 0;
    let inter = 0;
    let bidir = 0;
    if (method >= 2) return [0, 0, 0];
    if (!br.read1()) for (let i = 0; i < 6; i++) all += 8 * br.read1();
    if (!br.read1()) {
        all += 8 * br.read1();
        inter += 8 * br.read1();
        inter += 8 * br.read1();
        all += 8 * br.read1();
    }

    if (!br.read1()) {
        br.pos = start;
        return [0, 0, 0];
    }

    if (!br.read1()) {
        all += 8 * br.read1();
        all += 8 * br.read1();
        all += 8 * br.read1();
        all += 4 * br.read1();
    }

    if (!br.read1()) {
        inter += 8 * br.read1();
        inter += 8 * br.read1();
        bidir += 8 * br.read1();
        inter += 8 * br.read1();
        inter += 8 * br.read1();
        inter += 8 * br.read1();
    }

    if (!br.read1()) {
        br.pos = start;
        return [0, 0, 0];
    }

    if (method === 1) {
        all += 8 * br.read1();
        inter += 8 * br.read1();
    }

    return [all, inter, bidir];
}

/**
 * Parses video_object_layer() after its start code. Returns a reason string for layers this decoder
 * cannot reconstruct (non-rectangular shape, studio or N-bit coding, scalability, NEWPRED, reduced
 * resolution).
 */
export function parseVideoObjectLayer(br: BitReader): VideoObjectLayer | string {
    br.skip(1);
    const objectType = br.read(8);
    if (objectType === 14 || objectType === 15) return 'studio profile layers are not supported';
    let verId = 1;
    if (br.read1()) {
        verId = br.read(4);
        br.skip(3);
    }

    const aspect = br.read(4);
    let parNum = 1;
    let parDen = 1;
    if (aspect === 15) {
        parNum = br.read(8);
        parDen = br.read(8);
    } else if (aspect < PIXEL_ASPECT.length && PIXEL_ASPECT[aspect][0]) {
        [parNum, parDen] = PIXEL_ASPECT[aspect];
    }

    if (!parNum || !parDen) {
        parNum = 1;
        parDen = 1;
    }

    const controlParameters = br.read1() === 1;
    let lowDelay = false;
    if (controlParameters) {
        br.skip(2);
        lowDelay = br.read1() === 1;
        if (br.read1()) br.skip(79);
    }

    const shape = br.read(2);
    if (shape !== 0) return 'only rectangular video object layers are supported';
    marker(br);
    const resolution = br.read(16);
    if (!resolution) return 'vop_time_increment_resolution is zero';
    const timeIncrementBits = Math.max(1, 32 - Math.clz32(resolution - 1));
    marker(br);
    if (br.read1()) br.skip(timeIncrementBits);
    marker(br);
    const width = br.read(13);
    marker(br);
    const height = br.read(13);
    marker(br);
    const interlaced = br.read1() === 1;
    br.skip(1);
    const spriteEnable = verId === 1 ? br.read1() : br.read(2);
    let spriteWarpingPoints = 0;
    let spriteAccuracy = 0;
    let spriteBrightnessChange = false;
    if (spriteEnable === SPRITE_STATIC) return 'static sprites are not supported';
    if (spriteEnable === SPRITE_GMC) {
        spriteWarpingPoints = br.read(6);
        if (spriteWarpingPoints > 3) return 'more than three sprite warping points';
        spriteAccuracy = br.read(2);
        spriteBrightnessChange = br.read1() === 1;
    } else if (spriteEnable !== 0) {
        return 'reserved sprite_enable value';
    }

    let quantPrecision = 5;
    if (br.read1()) {
        quantPrecision = br.read(4);
        if (br.read(4) !== 8) return 'only 8-bit video is supported';
        if (quantPrecision < 3 || quantPrecision > 9) quantPrecision = 5;
    }

    const mpegQuant = br.read1() === 1;
    let intraMatrix: Uint8Array = DEFAULT_INTRA_MATRIX;
    let interMatrix: Uint8Array = DEFAULT_INTER_MATRIX;
    if (mpegQuant) {
        if (br.read1()) intraMatrix = readMatrix(br, DEFAULT_INTRA_MATRIX);
        if (br.read1()) interMatrix = readMatrix(br, DEFAULT_INTER_MATRIX);
    }

    const quarterSample = verId !== 1 && br.read1() === 1;
    let estimation: [number, number, number] = [0, 0, 0];
    if (!br.read1()) estimation = complexityEstimation(br);
    const resyncMarkers = br.read1() === 0;
    const dataPartitioned = br.read1() === 1;
    const reversibleVlc = dataPartitioned && br.read1() === 1;
    let newPred = false;
    if (verId !== 1) {
        newPred = br.read1() === 1;
        if (newPred) br.skip(3);
        if (br.read1()) return 'reduced resolution VOPs are not supported';
    }

    if (br.read1()) {
        const start = br.pos;
        br.skip(6);
        const factors = [br.read(5), br.read(5), br.read(5), br.read(5)];
        if (factors.every(Boolean)) return 'scalable layers are not supported';
        br.pos = start;
    }

    if (br.pos > br.end) return 'video object layer header is truncated';
    if (!width || !height) return 'video object layer has no picture size';
    return {
        objectType,
        parNum,
        parDen,
        controlParameters,
        lowDelay,
        timeResolution: resolution,
        timeIncrementBits,
        width,
        height,
        interlaced,
        spriteEnable,
        spriteWarpingPoints,
        spriteAccuracy,
        spriteBrightnessChange,
        quantPrecision,
        mpegQuant,
        intraMatrix,
        interMatrix,
        quarterSample,
        estimationBitsAll: estimation[0],
        estimationBitsInter: estimation[1],
        estimationBitsB: estimation[2],
        resyncMarkers,
        dataPartitioned,
        reversibleVlc,
        newPred,
    };
}

/**
 * The layer ffmpeg assumes for a stream without video_object_layer headers (early OpenDivX in AVI):
 * rectangular, Simple tools, a 4-bit vop_time_increment until a VOP shows otherwise, and the
 * picture size of the container.
 */
export function defaultVideoObjectLayer(width: number, height: number): VideoObjectLayer {
    return {
        objectType: 0,
        parNum: 1,
        parDen: 1,
        controlParameters: false,
        lowDelay: false,
        timeResolution: 16,
        timeIncrementBits: 4,
        width,
        height,
        interlaced: false,
        spriteEnable: 0,
        spriteWarpingPoints: 0,
        spriteAccuracy: 0,
        spriteBrightnessChange: false,
        quantPrecision: 5,
        mpegQuant: false,
        intraMatrix: DEFAULT_INTRA_MATRIX,
        interMatrix: DEFAULT_INTER_MATRIX,
        quarterSample: false,
        estimationBitsAll: 0,
        estimationBitsInter: 0,
        estimationBitsB: 0,
        resyncMarkers: false,
        dataPartitioned: false,
        reversibleVlc: false,
        newPred: false,
    };
}

/**
 * Parses visual_object() after its start code; returns the signal type of video objects when
 * present.
 */
export function parseVisualObject(br: BitReader): VideoSignalType | undefined {
    if (br.read1()) br.skip(7);
    const type = br.read(4);
    if ((type !== 1 && type !== 2) || !br.read1()) return undefined;
    br.skip(3);
    const fullRange = br.read1() === 1;
    if (!br.read1()) return { fullRange, primaries: 2, transfer: 2, matrix: 2 };
    return { fullRange, primaries: br.read(8), transfer: br.read(8), matrix: br.read(8) };
}

/**
 * Reads user_data() text up to the next start code prefix and records recognised encoder
 * signatures.
 */
export function parseUserData(br: BitReader, info: EncoderInfo): void {
    let text = '';
    while (text.length < 255 && br.pos + 8 <= br.end && br.peek(23) !== 0)
        text += String.fromCharCode(br.read(8));
    const divx = /^DivX(\d+)(?:Build|b)(\d+)(p?)/.exec(text);
    if (divx) {
        info.divxVersion = Number(divx[1]);
        info.divxBuild = Number(divx[2]);
        info.divxPacked = divx[3] === 'p';
    }

    const ffmpeg =
        /^FFmpe[^b]+b(\d+)/.exec(text) ??
        /^FFmpeg v\d+\.\d+\.\d+ \/ libavcodec build: (\d+)/.exec(text);
    const lavc = /^Lavc(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (ffmpeg) info.lavcBuild = Number(ffmpeg[1]);
    else if (lavc)
        info.lavcBuild = ((+lavc[1] & 0xff) << 16) | ((+lavc[2] & 0xff) << 8) | (+lavc[3] & 0xff);
    else if (text === 'ffmpeg') info.lavcBuild = 4600;

    const xvid = /^XviD(\d+)/.exec(text);
    if (xvid) info.xvidBuild = Number(xvid[1]);
}

/** Seconds of group_of_vop's time_code, ISO/IEC 14496-2 6.2.4. */
export function parseGroupOfVop(br: BitReader): number | undefined {
    if (br.peek(23) === 0) return undefined;
    const hours = br.read(5);
    const minutes = br.read(6);
    marker(br);
    const seconds = br.read(6);
    return seconds + 60 * (minutes + 60 * hours);
}

/** Source formats of short_video_header pictures (Table 6-25), as [width, height]. */
export const SHORT_HEADER_FORMATS: readonly (readonly [number, number])[] = [
    [0, 0],
    [128, 96],
    [176, 144],
    [352, 288],
    [704, 576],
    [1408, 1152],
];
