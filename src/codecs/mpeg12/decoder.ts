import { DecodeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import type { VideoFramePlane } from '../../core/contracts/picture';
import {
    type BuiltinVideoCodec,
    type BuiltinVideoDecoder,
    type BuiltinVideoDecoderConfig,
} from '../../core/contracts/decoder';
import { BitReader } from './bit-reader';
import {
    PICTURE_CODING_EXTENSION_ID,
    QUANT_MATRIX_EXTENSION_ID,
    SEQUENCE_DISPLAY_EXTENSION_ID,
    SEQUENCE_EXTENSION_ID,
    readGroupOfPictures,
    readPictureCodingExtension,
    readPictureHeader,
    readQuantMatrixExtension,
    readSequenceDisplayExtension,
    readSequenceExtension,
    readSequenceHeader,
    type PictureCodingExtension,
    type PictureHeader,
    type SequenceDisplayExtension,
    type SequenceExtension,
    type SequenceHeader,
} from './headers';
import {
    FRAME_PICTURE,
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    PictureBuffer,
    PictureDecoder,
    type PictureGeometry,
    type PictureParameters,
    type QuantiserMatrices,
} from './picture-decoder';
import { DEFAULT_INTRA_MATRIX, MPEG1_PEL_ASPECT, MPEG2_DISPLAY_ASPECT } from './tables';
import { isMpeg12VideoCodec } from '../../core/model/decoder-codecs';
import { type PlanarVideoColorSpace, type PlanarVideoFrame } from '../../core/contracts/picture';
import { DecoderWarnings } from '../shared/decoder-warnings';
import { unlabelledColour } from '../../core/codec-config/video/colour-codes';

/** Largest decodable luma width or height. */
const MAX_DIMENSION = 4096;
const FLAT_MATRIX = new Uint8Array(64).fill(16);
const PICTURE_START = 0x00;
const USER_DATA_START = 0xb2;
const SEQUENCE_HEADER_START = 0xb3;
const EXTENSION_START = 0xb5;
const SEQUENCE_END = 0xb7;
const GROUP_START = 0xb8;
const CONTEXT_NONE = 0;
const CONTEXT_SEQUENCE = 1;
const CONTEXT_PICTURE = 2;

type Interlacing = 'top-field-first' | 'bottom-field-first';

/** A sequence header with the extensions that followed it. */
interface SequenceHeaders {
    readonly header: SequenceHeader;
    extension: SequenceExtension | null;
    display: SequenceDisplayExtension | null;
}

/** The decodable configuration and presentation metadata one sequence header establishes. */
interface Sequence {
    readonly geometry: PictureGeometry;
    /** Replaced in part by quant matrix extensions until the next sequence header. */
    readonly matrices: QuantiserMatrices;
    readonly format: 'I420' | 'I422';
    readonly layout: readonly [VideoFramePlane, VideoFramePlane, VideoFramePlane];
    readonly visibleRect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly colorSpace: PlanarVideoColorSpace;
}

interface Frame {
    readonly buffer: PictureBuffer;
    readonly sequence: Sequence;
    readonly anchor: boolean;
    readonly keyFrame: boolean;
    /** picture_structure of the first field, or 3 for a frame picture. */
    readonly structure: number;
    readonly interlaced: Interlacing | undefined;
    readonly timestamp: number;
    duration: number;
    predicted: boolean;
    emitted: boolean;
}

const PRIMARIES: Readonly<Record<number, VideoColorPrimaries>> = {
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
    7: 'smpte170m',
};
const TRANSFERS: Readonly<Record<number, VideoTransferCharacteristics>> = {
    1: 'bt709',
    6: 'smpte170m',
    13: 'iec61966-2-1',
};
const MATRICES: Readonly<Record<number, VideoMatrixCoefficients>> = {
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
};

/**
 * colour_description codes of sequence_display_extension (ISO/IEC 13818-2 Tables 6-7 to 6-9) mapped
 * where WebCodecs has a name; otherwise BT.709 for pictures above 1024x576, BT.601 (625-line
 * primaries at 25 and 50 Hz) below.
 */
function colourSpace(
    width: number,
    height: number,
    frameRateCode: number,
    colour: readonly [number, number, number] | null,
): PlanarVideoColorSpace {
    const hd = unlabelledColour(width, height) === 'bt709';
    const pal = frameRateCode === 3 || frameRateCode === 6;
    const primaries = colour ? PRIMARIES[colour[0]] : undefined;
    const transfer = colour ? TRANSFERS[colour[1]] : undefined;
    const matrix = colour ? MATRICES[colour[2]] : undefined;
    return Object.freeze({
        primaries: primaries ?? (hd ? 'bt709' : pal ? 'bt470bg' : 'smpte170m'),
        transfer: transfer ?? (hd ? 'bt709' : 'smpte170m'),
        matrix: matrix ?? (hd ? 'bt709' : pal ? 'bt470bg' : 'smpte170m'),
        fullRange: false,
    });
}

/**
 * Width after the sample aspect ratio: MPEG-1 pel_aspect_ratio, or the MPEG-2 display aspect ratio
 * of the sequence_display_extension region (6.3.3) when that region lies inside the picture and
 * covers at least 15/16 of each dimension, else of the whole picture.
 */
function displayWidthOf(headers: SequenceHeaders, width: number, height: number): number {
    const { header, extension, display } = headers;
    let sampleAspect = 1;
    if (!extension) {
        const pelAspect = MPEG1_PEL_ASPECT[header.aspectRatio];
        if (pelAspect > 0) sampleAspect = 1 / pelAspect;
    } else {
        const ratio = MPEG2_DISPLAY_ASPECT[header.aspectRatio];
        if (ratio) {
            let regionWidth = width;
            let regionHeight = height;
            if (
                display &&
                display.displayWidth <= width &&
                display.displayHeight <= height &&
                display.displayWidth * 16 >= width * 15 &&
                display.displayHeight * 16 >= height * 15
            ) {
                regionWidth = display.displayWidth;
                regionHeight = display.displayHeight;
            }

            sampleAspect = (ratio[0] * regionHeight) / (ratio[1] * regionWidth);
        }
    }

    return Math.abs(sampleAspect - 1) < 1e-9
        ? width
        : Math.max(1, Math.round(width * sampleAspect));
}

/**
 * Decoder for MPEG-1 (ISO/IEC 11172-2) and MPEG-2 Main and 4:2:2 Profile (ISO/IEC 13818-2) video.
 */
class Mpeg12VideoDecoder implements BuiltinVideoDecoder {
    private readonly reader = new BitReader();
    private readonly pictures = new PictureDecoder(this.reader);
    private codes = new Int32Array(1024);
    /** The sequence the description established, restored by reset(). */
    private readonly initial: SequenceHeaders | null;
    private incoming: SequenceHeaders | null = null;
    private lastCommitted: SequenceHeaders | null = null;
    private sequence: Sequence | null = null;
    /** An in-band sequence header declared an undecodable configuration after a decodable one. */
    private suspended = false;
    private readonly header: PictureHeader = {
        temporalReference: 0,
        codingType: 0,
        fullPelForward: 0,
        forwardFCode: 0,
        fullPelBackward: 0,
        backwardFCode: 0,
    };
    private readonly coding: PictureCodingExtension = {
        fCode: new Int32Array(4),
        intraDcPrecision: 0,
        pictureStructure: 0,
        topFieldFirst: 0,
        framePredFrameDct: 0,
        concealmentMotionVectors: 0,
        qScaleType: 0,
        intraVlcFormat: 0,
        alternateScan: 0,
        progressiveFrame: 0,
    };
    private readonly parameters: PictureParameters = {
        codingType: 0,
        structure: FRAME_PICTURE,
        secondField: false,
        fCode: new Int32Array(4),
        fullPelForward: 0,
        fullPelBackward: 0,
        intraDcPrecision: 0,
        framePredFrameDct: 1,
        concealmentMotionVectors: 0,
        qScaleType: 0,
        intraVlcFormat: 0,
        alternateScan: 0,
        topFieldFirst: 1,
    };
    private codingSeen = false;
    private headerPending = false;
    private active = false;
    private secondField = false;
    private frame: Frame | null = null;
    private concealSource: PictureBuffer | null = null;
    private awaitingField: Frame | null = null;
    private past: Frame | null = null;
    private future: Frame | null = null;
    private pool: PictureBuffer[] = [];
    private grey: PictureBuffer | null = null;
    private closedGop = false;
    private brokenLink = false;
    private anchorsSinceGop = 0;
    private predictedSeen = false;
    private slotTimestamp = 0;
    private slotDuration = 0;
    private slotIndex = 0;
    private readonly slotKeys: number[] = [];
    /**
     * Presentation slot of each frame starting in the current packet, in decode order; empty for
     * one frame.
     */
    private readonly slotOrder: number[] = [];
    private chunkDuration = 0;
    private output: PlanarVideoFrame[] = [];
    private readonly warnings: DecoderWarnings;
    private closed = false;

    constructor(description: Uint8Array | undefined, onWarning?: (message: string) => void) {
        this.warnings = new DecoderWarnings(onWarning);
        if (description && description.length > 0) this.process(description, null);
        this.initial = this.sequence ? this.lastCommitted : null;
    }

    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[] {
        if (this.closed) throw new DecodeError('MPEG video decoder is closed');
        const data = chunk?.data;
        if (!(data instanceof Uint8Array))
            throw new DecodeError('MPEG video chunk data must be a Uint8Array');
        const output: PlanarVideoFrame[] = [];
        this.output = output;
        this.process(data, chunk);
        this.output = [];
        return output;
    }

    flush(): readonly PlanarVideoFrame[] {
        if (this.closed) throw new DecodeError('MPEG video decoder is closed');
        const output: PlanarVideoFrame[] = [];
        this.output = output;
        this.completeAwaitingField();
        if (this.future && !this.future.emitted) this.emit(this.future, true);
        this.output = [];
        return output;
    }

    reset(): void {
        if (this.closed) return;
        this.dropPictures();
        if (this.initial) {
            this.incoming = { ...this.initial };
            this.commitSequence();
        }
    }

    close(): void {
        this.closed = true;
        this.dropPictures();
        this.pool = [];
        this.grey = null;
        this.sequence = null;
    }

    private dropPictures(): void {
        this.active = false;
        this.headerPending = false;
        this.frame = null;
        this.concealSource = null;
        this.awaitingField = null;
        this.past = null;
        this.future = null;
        this.incoming = null;
        this.closedGop = false;
        this.brokenLink = false;
        this.anchorsSinceGop = 0;
        this.predictedSeen = false;
    }

    /** Collects the positions of the byte after each 00 00 01 start code prefix. */
    private findStartCodes(data: Uint8Array): number {
        let count = 0;
        const last = data.length - 4;
        let index = 0;
        while (index <= last) {
            const third = data[index + 2];
            if (third > 1) index += 3;
            else if (third === 1 && data[index] === 0 && data[index + 1] === 0) {
                if (count === this.codes.length) {
                    const grown = new Int32Array(count * 2);
                    grown.set(this.codes);
                    this.codes = grown;
                }
                this.codes[count++] = index + 3;
                index += 4;
            } else index++;
        }
        return count;
    }

    /**
     * Counts the frames that start in a packet (frame pictures and first fields) and, when there
     * are several, orders their shares of its duration by group of pictures and temporal_reference.
     */
    private planFrameSlots(data: Uint8Array, count: number): number {
        const keys = this.slotKeys;
        keys.length = 0;
        let groups = 0;
        let openField = this.awaitingField ? this.awaitingField.structure : 0;
        for (let k = 0; k < count; k++) {
            const at = this.codes[k];
            if (data[at] === GROUP_START) groups++;
            if (data[at] !== PICTURE_START) continue;
            let structure = FRAME_PICTURE;
            const next = k + 1 < count ? this.codes[k + 1] : -1;
            if (next > 0 && next + 3 < data.length && data[next] === EXTENSION_START) {
                if (data[next + 1] >> 4 === PICTURE_CODING_EXTENSION_ID)
                    structure = data[next + 3] & 3;
            }

            if (
                structure !== FRAME_PICTURE &&
                structure !== 0 &&
                openField !== 0 &&
                openField !== structure
            ) {
                openField = 0;
                continue;
            }

            openField = structure === FRAME_PICTURE ? 0 : structure;
            keys.push(groups * 1024 + ((data[at + 1] << 2) | (data[at + 2] >> 6)));
        }

        const order = this.slotOrder;
        order.length = 0;
        if (keys.length > 1) {
            const byTime = keys.map((_, index) => index).sort((a, b) => keys[a] - keys[b] || a - b);
            byTime.forEach((frame, slot) => (order[frame] = slot));
        }

        return keys.length;
    }

    /** Parses one packet, or the description when `chunk` (read for its timing only) is null. */
    private process(data: Uint8Array, chunk: EncodedPacket | null): void {
        const reader = this.reader;
        reader.load(data);
        const count = this.findStartCodes(data);
        if (chunk) {
            const starts = this.planFrameSlots(data, count);
            this.slotTimestamp = chunk.timestamp;
            this.slotDuration = starts > 1 ? chunk.duration / starts : chunk.duration;
            this.slotIndex = 0;
            this.chunkDuration = starts === 0 ? chunk.duration : 0;
            if (count === 0) this.warnings.warn('packet without start codes ignored');
        }

        let context = CONTEXT_NONE;
        for (let k = 0; k < count; k++) {
            const at = this.codes[k];
            const code = data[at];
            const end = k + 1 < count ? this.codes[k + 1] - 3 : data.length;
            reader.pos = (at + 1) * 8;
            if (code >= 0x01 && code <= 0xaf) {
                if (!chunk) continue;
                if (this.headerPending) this.startPicture();
                if (this.active && !this.pictures.decodeSlice((at + 1) * 8, end * 8, code)) {
                    this.warnings.warn(`damaged slice at row ${code} concealed`);
                }
                continue;
            }

            switch (code) {
                case PICTURE_START:
                    if (!chunk) break;
                    this.endPicture();
                    this.commitSequence();
                    readPictureHeader(reader, this.header);
                    this.codingSeen = false;
                    this.headerPending = true;
                    context = CONTEXT_PICTURE;
                    break;
                case SEQUENCE_HEADER_START:
                    this.endPicture();
                    this.completeAwaitingField();
                    this.commitSequence();
                    this.readSequenceHeaderAt(end - at - 1);
                    context = CONTEXT_SEQUENCE;
                    break;
                case EXTENSION_START:
                    this.readExtension(context);
                    break;
                case GROUP_START:
                    this.endPicture();
                    this.completeAwaitingField();
                    this.commitSequence();
                    if (end - at - 1 >= 4) {
                        const group = readGroupOfPictures(reader);
                        this.closedGop = group.closedGop;
                        this.brokenLink = group.brokenLink;
                        this.anchorsSinceGop = 0;
                    }

                    context = CONTEXT_NONE;
                    break;
                case SEQUENCE_END:
                    this.endPicture();
                    this.completeAwaitingField();
                    this.commitSequence();
                    this.endSequence();
                    context = CONTEXT_NONE;
                    break;
                case USER_DATA_START:
                    break;
                default:
                    context = CONTEXT_NONE;
            }
        }

        this.endPicture();
        this.commitSequence();
    }

    private readSequenceHeaderAt(length: number): void {
        const header = length >= 8 ? readSequenceHeader(this.reader) : null;
        if (!header) {
            this.warnings.warn('damaged sequence header ignored');
            this.incoming = null;
            return;
        }
        this.incoming = { header, extension: null, display: null };
    }

    private readExtension(context: number): void {
        const reader = this.reader;
        const id = reader.read(4);
        if (id === QUANT_MATRIX_EXTENSION_ID) {
            this.commitSequence();
            const extension = readQuantMatrixExtension(reader);
            if (!extension) this.warnings.warn('damaged quant matrix extension ignored');
            else if (this.sequence) {
                const matrices = this.sequence.matrices;
                if (extension.intra) matrices.intra = matrices.chromaIntra = extension.intra;
                if (extension.nonIntra)
                    matrices.nonIntra = matrices.chromaNonIntra = extension.nonIntra;
                if (extension.chromaIntra) matrices.chromaIntra = extension.chromaIntra;
                if (extension.chromaNonIntra) matrices.chromaNonIntra = extension.chromaNonIntra;
            }

            return;
        }

        if (context === CONTEXT_SEQUENCE && this.incoming) {
            if (id === SEQUENCE_EXTENSION_ID) {
                const extension = readSequenceExtension(reader);
                if (extension) this.incoming.extension = extension;
                else this.warnings.warn('damaged sequence extension ignored');
            } else if (id === SEQUENCE_DISPLAY_EXTENSION_ID) {
                this.incoming.display = readSequenceDisplayExtension(reader);
            }
        } else if (context === CONTEXT_PICTURE && id === PICTURE_CODING_EXTENSION_ID) {
            readPictureCodingExtension(reader, this.coding);
            this.codingSeen = true;
        }
    }

    /**
     * Applies the sequence header read last; a new coded size or chroma format restarts at the next
     * I-picture.
     */
    private commitSequence(): void {
        const headers = this.incoming;
        if (!headers) return;
        this.incoming = null;
        const previous = this.sequence;
        const { header } = headers;
        if (
            !headers.extension &&
            previous?.geometry.mpeg2 &&
            this.lastCommitted?.extension &&
            this.lastCommitted.header.horizontalSize === header.horizontalSize &&
            this.lastCommitted.header.verticalSize === header.verticalSize
        ) {
            headers.extension = this.lastCommitted.extension;
            headers.display ??= this.lastCommitted.display;
        }

        const extension = headers.extension;
        const chromaFormat = extension ? extension.chromaFormat : 1;
        const width =
            header.horizontalSize | ((extension ? extension.horizontalSizeExtension : 0) << 12);
        const height =
            header.verticalSize | ((extension ? extension.verticalSizeExtension : 0) << 12);
        const unsupported =
            chromaFormat === 3
                ? 'MPEG-2 4:4:4 video is not supported'
                : width > MAX_DIMENSION || height > MAX_DIMENSION
                  ? `MPEG video of ${width}x${height} exceeds the ${MAX_DIMENSION} sample limit`
                  : null;

        if (unsupported) {
            if (!previous) throw new DecodeError(unsupported);
            this.warnings.warn(`${unsupported}; skipping to the next sequence header`);
            this.suspended = true;
            return;
        }

        this.suspended = false;
        const mpeg2 = extension !== null;
        const chroma422 = chromaFormat === 2;
        const mbWidth = (width + 15) >> 4;
        const mbHeight =
            mpeg2 && !extension.progressiveSequence ? ((height + 31) >> 5) * 2 : (height + 15) >> 4;
        const codedWidth = mbWidth * 16;
        const codedHeight = mbHeight * 16;
        const chromaWidth = codedWidth >> 1;
        const chromaHeight = chroma422 ? codedHeight : codedHeight >> 1;
        const lumaSize = codedWidth * codedHeight;
        const chromaSize = chromaWidth * chromaHeight;
        const geometry: PictureGeometry = {
            mpeg2,
            chroma422,
            mbWidth,
            mbHeight,
            width: codedWidth,
            height: codedHeight,
            chromaWidth,
            chromaHeight,
            size: lumaSize + chromaSize * 2,
            verticalPositionExtension: height > 2800,
        };

        const intra = header.intraMatrix ?? DEFAULT_INTRA_MATRIX;
        const nonIntra = header.nonIntraMatrix ?? FLAT_MATRIX;
        const sequence: Sequence = {
            geometry,
            matrices: { intra, nonIntra, chromaIntra: intra, chromaNonIntra: nonIntra },
            format: chroma422 ? 'I422' : 'I420',
            layout: Object.freeze([
                Object.freeze({ offset: 0, stride: codedWidth }),
                Object.freeze({ offset: lumaSize, stride: chromaWidth }),
                Object.freeze({ offset: lumaSize + chromaSize, stride: chromaWidth }),
            ] as const),
            visibleRect: Object.freeze({ x: 0, y: 0, width, height }),
            displayWidth: displayWidthOf(headers, width, height),
            displayHeight: height,
            colorSpace: colourSpace(
                width,
                height,
                header.frameRateCode,
                headers.display?.colour ?? null,
            ),
        };

        this.lastCommitted = headers;
        const reconfigure =
            !previous ||
            previous.geometry.mpeg2 !== mpeg2 ||
            previous.geometry.chroma422 !== chroma422 ||
            previous.geometry.width !== codedWidth ||
            previous.geometry.height !== codedHeight;

        if (reconfigure) {
            this.completeAwaitingField();
            if (this.future && !this.future.emitted) this.emit(this.future, true);
            this.past = null;
            this.future = null;
            this.pool = [];
            this.grey = null;
            this.pictures.configure(geometry);
        }

        this.sequence = sequence;
    }

    /**
     * sequence_end_code: the reference picture waiting for display is shown, and no picture of a
     * later sequence predicts from this one, so the B-pictures leading an open GOP after it are
     * skipped.
     */
    private endSequence(): void {
        if (this.future && !this.future.emitted) this.emit(this.future, false);
        if (this.past) this.recycle(this.past);
        this.past = null;
        this.future = null;
    }

    private takeBuffer(sequence: Sequence): PictureBuffer {
        const buffer = this.pool.pop();
        return buffer && buffer.data.length === sequence.geometry.size
            ? buffer
            : new PictureBuffer(sequence.geometry.size);
    }

    private recycle(frame: Frame): void {
        if (
            this.sequence &&
            frame.buffer.data.length === this.sequence.geometry.size &&
            this.pool.length < 2
        ) {
            this.pool.push(frame.buffer);
        }
    }

    private greyPicture(sequence: Sequence): PictureBuffer {
        if (!this.grey || this.grey.data.length !== sequence.geometry.size) {
            this.grey = new PictureBuffer(sequence.geometry.size);
            this.grey.data.fill(128);
        }
        return this.grey;
    }

    /**
     * Validates the picture just parsed, pairs fields, selects references and starts slice
     * decoding.
     */
    private startPicture(): void {
        this.headerPending = false;
        const sequence = this.sequence;
        const header = this.header;
        const type = header.codingType;
        if (!sequence || this.suspended)
            return this.warnings.warn('picture without a decodable sequence header skipped');
        if (type === 4) return this.warnings.warn('MPEG-1 D-picture ignored');
        if (type < PICTURE_I || type > PICTURE_B)
            return this.warnings.warn(`picture_coding_type ${type} skipped`);
        const mpeg2 = sequence.geometry.mpeg2;
        if (mpeg2 && !this.codingSeen)
            return this.warnings.warn('picture without picture_coding_extension skipped');
        const coding = this.coding;
        const structure = mpeg2 ? coding.pictureStructure : FRAME_PICTURE;
        if (
            structure === 0 ||
            (structure !== FRAME_PICTURE && (sequence.geometry.mbHeight & 1) !== 0)
        ) {
            return this.warnings.warn(`picture_structure ${structure} skipped`);
        }

        const parameters = this.parameters;
        const fCode = parameters.fCode;
        if (mpeg2) {
            fCode.set(coding.fCode);
            parameters.fullPelForward = 0;
            parameters.fullPelBackward = 0;
            parameters.intraDcPrecision = coding.intraDcPrecision;
            parameters.framePredFrameDct = coding.framePredFrameDct;
            parameters.concealmentMotionVectors = coding.concealmentMotionVectors;
            parameters.qScaleType = coding.qScaleType;
            parameters.intraVlcFormat = coding.intraVlcFormat;
            parameters.alternateScan = coding.alternateScan;
            parameters.topFieldFirst = coding.topFieldFirst;
        } else {
            fCode[0] = fCode[1] = header.forwardFCode;
            fCode[2] = fCode[3] = header.backwardFCode;
            parameters.fullPelForward = header.fullPelForward;
            parameters.fullPelBackward = header.fullPelBackward;
            parameters.intraDcPrecision = 0;
            parameters.framePredFrameDct = 1;
            parameters.concealmentMotionVectors = 0;
            parameters.qScaleType = 0;
            parameters.intraVlcFormat = 0;
            parameters.alternateScan = 0;
            parameters.topFieldFirst = 1;
        }

        let frame = this.awaitingField;
        let second = false;
        if (frame) {
            this.awaitingField = null;
            if (
                structure !== FRAME_PICTURE &&
                structure !== frame.structure &&
                frame.sequence === sequence &&
                frame.anchor === (type !== PICTURE_B)
            ) {
                second = true;
            } else {
                this.completeLoneField(frame);
                frame = null;
            }
        }

        if (!frame) {
            if (type === PICTURE_P && !this.future)
                return this.warnings.warn('P-picture without a reference skipped');
            if (type === PICTURE_B) {
                const leading = this.anchorsSinceGop === 1;
                if (
                    !this.future ||
                    (leading && this.brokenLink) ||
                    (!this.past && !(leading && this.closedGop))
                ) {
                    return this.warnings.warn('B-picture without its references skipped');
                }
            }

            const interlaced =
                mpeg2 && !coding.progressiveFrame
                    ? structure === FRAME_PICTURE
                        ? coding.topFieldFirst
                            ? 'top-field-first'
                            : 'bottom-field-first'
                        : structure === 1
                          ? 'top-field-first'
                          : 'bottom-field-first'
                    : undefined;

            frame = {
                buffer:
                    type === PICTURE_B
                        ? new PictureBuffer(sequence.geometry.size)
                        : this.takeBuffer(sequence),
                sequence,
                anchor: type !== PICTURE_B,
                keyFrame: type === PICTURE_I,
                structure,
                interlaced,
                timestamp:
                    this.slotTimestamp +
                    (this.slotOrder[this.slotIndex] ?? this.slotIndex) * this.slotDuration,
                duration: this.slotDuration,
                predicted: false,
                emitted: false,
            };
            this.slotIndex++;
        } else if (this.chunkDuration > 0) {
            frame.duration += this.chunkDuration;
            this.chunkDuration = 0;
        }

        if (type !== PICTURE_I) frame.predicted = true;
        let forward = frame.buffer;
        let backward = frame.buffer;
        if (type === PICTURE_B) {
            backward = this.future!.buffer;
            forward = this.past ? this.past.buffer : backward;
            this.concealSource = forward;
        } else if (type === PICTURE_P) {
            forward = this.future ? this.future.buffer : this.greyPicture(sequence);
            backward = forward;
            this.concealSource = this.future ? this.future.buffer : null;
        } else {
            this.concealSource = this.predictedSeen && this.future ? this.future.buffer : null;
        }

        parameters.codingType = type;
        parameters.structure = structure;
        parameters.secondField = second;
        this.pictures.begin(parameters, sequence.matrices, frame.buffer, forward, backward);
        this.frame = frame;
        this.secondField = second;
        this.active = true;
    }

    /**
     * Conceals what the picture's slices left out; completes the frame unless its second field is
     * still to come.
     */
    private endPicture(): void {
        if (this.headerPending) this.startPicture();
        if (!this.active) return;
        this.active = false;
        const frame = this.frame!;
        this.frame = null;
        const concealed = this.pictures.finish(this.concealSource);
        if (concealed > 0) this.warnings.warn(`${concealed} macroblocks concealed`);
        if (frame.structure !== FRAME_PICTURE && !this.secondField) {
            this.awaitingField = frame;
            return;
        }
        this.completeFrame(frame);
    }

    private completeAwaitingField(): void {
        const frame = this.awaitingField;
        if (!frame) return;
        this.awaitingField = null;
        this.completeLoneField(frame);
    }

    /** Fills the lines of a missing second field from the neighbouring lines of the decoded one. */
    private completeLoneField(frame: Frame): void {
        this.warnings.warn('field picture without its second field');
        const { geometry } = frame.sequence;
        const data = frame.buffer.data;
        const missing = frame.structure === 1 ? 1 : 0;
        const planes: [number, number, number][] = [
            [0, geometry.width, geometry.height],
            [geometry.width * geometry.height, geometry.chromaWidth, geometry.chromaHeight],
            [
                geometry.width * geometry.height + geometry.chromaWidth * geometry.chromaHeight,
                geometry.chromaWidth,
                geometry.chromaHeight,
            ],
        ];

        for (const [offset, width, height] of planes) {
            for (let line = missing; line < height; line += 2) {
                const from = offset + (missing === 1 ? line - 1 : line + 1) * width;
                data.copyWithin(offset + line * width, from, from + width);
            }
        }

        this.completeFrame(frame);
    }

    private completeFrame(frame: Frame): void {
        if (frame.anchor) {
            if (this.future && !this.future.emitted) this.emit(this.future, true);
            if (this.past) this.recycle(this.past);
            this.past = this.future;
            this.future = frame;
            this.anchorsSinceGop++;
        } else this.emit(frame, false);
        if (frame.predicted) this.predictedSeen = true;
    }

    private emit(frame: Frame, copy: boolean): void {
        frame.emitted = true;
        const { sequence } = frame;
        const planar: PlanarVideoFrame = {
            format: sequence.format,
            data: copy ? frame.buffer.data.slice() : frame.buffer.data,
            layout: sequence.layout,
            codedWidth: sequence.geometry.width,
            codedHeight: sequence.geometry.height,
            visibleRect: sequence.visibleRect,
            displayWidth: sequence.displayWidth,
            displayHeight: sequence.displayHeight,
            timestamp: frame.timestamp,
            duration: frame.duration,
            keyFrame: frame.keyFrame,
            colorSpace: sequence.colorSpace,
            ...(frame.interlaced ? { interlaced: frame.interlaced } : {}),
        };
        this.output.push(planar);
    }
}

/** MPEG-1 video (codec string mp4v.6a) and MPEG-2 video (mp4v.60 to mp4v.65). */
export const mpeg12VideoCodec: BuiltinVideoCodec = Object.freeze({
    id: 'mpeg2video',
    supports: isMpeg12VideoCodec,
    create(config: BuiltinVideoDecoderConfig): BuiltinVideoDecoder {
        const codec = config?.codec;
        const description = config?.description;
        if (!isMpeg12VideoCodec(codec)) {
            throw new DecodeError(`Unsupported MPEG video codec: ${String(codec)}`);
        }
        if (description !== undefined && !(description instanceof Uint8Array)) {
            throw new DecodeError('MPEG video description must be a Uint8Array');
        }
        return new Mpeg12VideoDecoder(description, config.onWarning);
    },
});
