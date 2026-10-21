import type { DiagnosticContext } from '../../errors/diagnostics';
/** MSB-first bit reader over one OBU payload; reads past the end return zero and clear `ok`. */
class Bits {
    private position = 0;
    ok = true;

    constructor(
        private readonly data: Uint8Array,
        private readonly end: number,
        start: number,
    ) {
        this.position = start * 8;
    }

    read(count: number): number {
        let value = 0;
        for (let index = 0; index < count; index++) {
            const byte = this.position >> 3;
            if (byte >= this.end) {
                this.ok = false;
                return 0;
            }
            value = value * 2 + ((this.data[byte]! >> (7 - (this.position & 7))) & 1);
            this.position++;
        }
        return value;
    }

    /** uvlc() from the AV1 specification. */
    uvlc(): number {
        let zeros = 0;
        while (this.ok && this.read(1) === 0) if (++zeros >= 32) return ((this.ok = false), 0);
        return zeros ? this.read(zeros) + 2 ** zeros - 1 : 0;
    }
}

export function leb128(
    data: Uint8Array,
    offset: number,
    end: number,
): { value: number; length: number } | undefined {
    let value = 0;
    for (let index = 0; index < 8 && offset + index < end; index++) {
        const byte = data[offset + index]!;
        value += (byte & 0x7f) * 2 ** (7 * index);
        if (!(byte & 0x80)) return { value, length: index + 1 };
    }
    return undefined;
}

export function leb128Bytes(value: number): Uint8Array {
    const bytes: number[] = [];
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 0x80;
        bytes.push(byte);
    } while (value > 0);
    return Uint8Array.from(bytes);
}

const AV1_OBU_SEQUENCE_HEADER = 1;
export const AV1_OBU_TEMPORAL_DELIMITER = 2;
const AV1_OBU_FRAME_HEADER = 3;
const AV1_OBU_METADATA = 5;
const AV1_OBU_FRAME = 6;

const AV1_KEY_FRAME = 0;
const AV1_SWITCH_FRAME = 3;

interface Av1Obu {
    readonly type: number;
    /** Offset of the OBU header within the scanned bytes. */
    readonly start: number;
    readonly payloadStart: number;
    readonly end: number;
    readonly temporalId: number;
    readonly spatialId: number;
    /** Where a `partial` split's last OBU ends by its obu_size, past the scanned bytes. */
    readonly declaredEnd?: number;
}

/**
 * Splits low-overhead bitstream bytes (every OBU carries obu_size, as ISOBMFF, Matroska, IVF and
 * MPEG-TS store them) into OBUs. Returns undefined when a header or size field is malformed or an
 * OBU exceeds the bytes; `partial` instead keeps a final OBU cut by a prefix window.
 */
export function splitAv1Obus(
    data: Uint8Array,
    start = 0,
    end = data.length,
    partial = false,
): Av1Obu[] | undefined {
    const obus: Av1Obu[] = [];
    let offset = start;
    while (offset < end) {
        const header = data[offset]!;
        if (header & 0x80) return undefined;
        const type = (header >> 3) & 15;
        const extension = (header >> 2) & 1;
        const sized = (header >> 1) & 1;
        let payload = offset + 1 + extension;
        if (payload > end) return undefined;
        const temporalId = extension ? data[offset + 1]! >> 5 : 0;
        const spatialId = extension ? (data[offset + 1]! >> 3) & 3 : 0;

        let obuEnd = end;
        if (sized) {
            const size = leb128(data, payload, end);
            if (!size) return undefined;
            payload += size.length;
            obuEnd = payload + size.value;
            if (obuEnd > end) {
                if (!partial) return undefined;
                obus.push({
                    type,
                    start: offset,
                    payloadStart: payload,
                    end,
                    temporalId,
                    spatialId,
                    declaredEnd: obuEnd,
                });
                break;
            }
        } else if (obus.length === 0 && type !== AV1_OBU_TEMPORAL_DELIMITER) return undefined;

        obus.push({
            type,
            start: offset,
            payloadStart: payload,
            end: obuEnd,
            temporalId,
            spatialId,
        });
        offset = obuEnd;
        if (!sized) break;
    }
    return obus;
}

interface Av1SequenceHeader {
    readonly profile: number;
    readonly level: number;
    readonly tier: number;
    readonly highBitDepth: number;
    readonly twelveBit: number;
    readonly monochrome: number;
    readonly subsamplingX: number;
    readonly subsamplingY: number;
    readonly samplePosition: number;
    readonly width: number;
    readonly height: number;
    readonly reducedStillPicture: boolean;
    readonly frameIdLength: number;
    readonly orderHintBits: number;
    readonly decoderModelInfoPresent: boolean;
    readonly bufferRemovalTimeLength: number;
    readonly equalPictureInterval: boolean;
    /**
     * Display tick from timing_info as a fraction of a second; undefined when the stream states no
     * timing.
     */
    readonly tickNumerator?: number;
    readonly tickDenominator?: number;
    readonly framePresentationTimeLength: number;
    readonly operatingPoints: readonly { readonly idc: number; readonly decoderModel: boolean }[];
    readonly forceScreenContentTools: number;
    readonly forceIntegerMv: number;
    readonly colour?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
    /** The complete sequence header OBU including its header and size field. */
    readonly obu: Uint8Array;
}

/**
 * Parses the sequence_header_obu payload at [start, end) of `data`; `obu` is the complete OBU to
 * keep.
 */
function parseAv1SequenceHeader(
    data: Uint8Array,
    start: number,
    end: number,
    obu: Uint8Array,
): Av1SequenceHeader | undefined {
    const bits = new Bits(data, end, start);
    const profile = bits.read(3);
    bits.read(1);
    const reduced = bits.read(1) === 1;
    let level = 0;
    let tier = 0;
    let decoderModel = false;
    let bufferDelayLength = 0;
    let bufferRemovalTimeLength = 0;
    let framePresentationTimeLength = 0;
    let equalPictureInterval = false;
    let tickNumerator: number | undefined;
    let tickDenominator: number | undefined;
    const operatingPoints: { idc: number; decoderModel: boolean }[] = [];

    if (reduced) {
        level = bits.read(5);
        operatingPoints.push({ idc: 0, decoderModel: false });
    } else {
        if (bits.read(1)) {
            const numUnits = bits.read(32);
            const timeScale = bits.read(32);
            equalPictureInterval = bits.read(1) === 1;
            if (equalPictureInterval) bits.uvlc();
            if (numUnits > 0 && timeScale > 0) {
                tickNumerator = numUnits;
                tickDenominator = timeScale;
            }
            decoderModel = bits.read(1) === 1;
            if (decoderModel) {
                bufferDelayLength = bits.read(5) + 1;
                bits.read(32);
                bufferRemovalTimeLength = bits.read(5) + 1;
                framePresentationTimeLength = bits.read(5) + 1;
            }
        }

        const displayDelay = bits.read(1);
        const points = bits.read(5) + 1;
        for (let point = 0; point < points; point++) {
            const idc = bits.read(12);
            const pointLevel = bits.read(5);
            const pointTier = pointLevel > 7 ? bits.read(1) : 0;
            if (point === 0) {
                level = pointLevel;
                tier = pointTier;
            }
            let model = false;
            if (decoderModel) {
                model = bits.read(1) === 1;
                if (model) bits.read(bufferDelayLength * 2 + 1);
            }
            if (displayDelay && bits.read(1)) bits.read(4);
            operatingPoints.push({ idc, decoderModel: model });
        }
    }

    const widthBits = bits.read(4) + 1;
    const heightBits = bits.read(4) + 1;
    const width = bits.read(widthBits) + 1;
    const height = bits.read(heightBits) + 1;
    let frameIdLength = 0;
    if (!reduced && bits.read(1)) {
        const deltaLength = bits.read(4) + 2;
        frameIdLength = bits.read(3) + deltaLength + 1;
    }
    bits.read(3);

    let orderHintBits = 0;
    let forceScreenContentTools = 2;
    let forceIntegerMv = 2;
    if (!reduced) {
        bits.read(4);
        const orderHint = bits.read(1);
        if (orderHint) bits.read(2);
        forceScreenContentTools = bits.read(1) ? 2 : bits.read(1);
        if (forceScreenContentTools > 0) forceIntegerMv = bits.read(1) ? 2 : bits.read(1);
        else forceIntegerMv = 2;
        if (orderHint) orderHintBits = bits.read(3) + 1;
    }

    bits.read(3);
    const highBitDepth = bits.read(1);
    const twelveBit = profile === 2 && highBitDepth ? bits.read(1) : 0;
    const monochrome = profile === 1 ? 0 : bits.read(1);

    let primaries = 2;
    let transfer = 2;
    let matrix = 2;
    const described = bits.read(1) === 1;
    if (described) {
        primaries = bits.read(8);
        transfer = bits.read(8);
        matrix = bits.read(8);
    }

    let subsamplingX = 1;
    let subsamplingY = 1;
    let samplePosition = 0;
    let fullRange = false;
    if (monochrome) fullRange = bits.read(1) === 1;
    else if (primaries === 1 && transfer === 13 && matrix === 0) {
        subsamplingX = 0;
        subsamplingY = 0;
        fullRange = true;
    } else {
        fullRange = bits.read(1) === 1;
        if (profile === 1) subsamplingX = subsamplingY = 0;
        else if (profile === 2) {
            if (twelveBit) {
                subsamplingX = bits.read(1);
                subsamplingY = subsamplingX ? bits.read(1) : 0;
            } else subsamplingY = 0;
        }
        if (subsamplingX && subsamplingY) samplePosition = bits.read(2);
    }

    if (!bits.ok) return undefined;
    return {
        profile,
        level,
        tier,
        highBitDepth,
        twelveBit,
        monochrome,
        subsamplingX,
        subsamplingY,
        samplePosition,
        width,
        height,
        reducedStillPicture: reduced,
        frameIdLength,
        orderHintBits,
        decoderModelInfoPresent: decoderModel,
        bufferRemovalTimeLength,
        equalPictureInterval,
        tickNumerator,
        tickDenominator,
        framePresentationTimeLength,
        operatingPoints,
        forceScreenContentTools,
        forceIntegerMv,
        colour: described ? { primaries, transfer, matrix, fullRange } : undefined,
        obu,
    };
}

/** Av1CodecConfigurationRecord (av1C payload) whose configOBUs hold the sequence header. */
export function av1ConfigFromSequenceHeader(sequence: Av1SequenceHeader): Uint8Array {
    const record = new Uint8Array(4 + sequence.obu.length);
    record[0] = 0x81;
    record[1] = (sequence.profile << 5) | sequence.level;
    record[2] =
        (sequence.tier << 7) |
        (sequence.highBitDepth << 6) |
        (sequence.twelveBit << 5) |
        (sequence.monochrome << 4) |
        (sequence.subsamplingX << 3) |
        (sequence.subsamplingY << 2) |
        sequence.samplePosition;
    record.set(sequence.obu, 4);
    return record;
}

/** The sequence header of a temporal unit's OBUs, or undefined when the unit carries none. */
export function av1SequenceHeaderOf(data: Uint8Array): Av1SequenceHeader | undefined {
    for (const obu of splitAv1Obus(data) ?? []) {
        if (obu.type !== AV1_OBU_SEQUENCE_HEADER) continue;
        return parseAv1SequenceHeader(
            data,
            obu.payloadStart,
            obu.end,
            data.slice(obu.start, obu.end),
        );
    }
    return undefined;
}

/**
 * Av1CodecConfigurationRecord (av1C payload) for a temporal unit that carries a sequence header
 * OBU, as AV1 encoders emit on keyframes. Returns undefined when no complete sequence header is
 * found.
 */
export function av1ConfigFromTemporalUnit(unit: Uint8Array): Uint8Array | undefined {
    const sequence = av1SequenceHeaderOf(unit);
    return sequence ? av1ConfigFromSequenceHeader(sequence) : undefined;
}

/** The sequence header OBU stored in an av1C record's configOBUs, when present. */
export function av1SequenceHeaderFromConfig(
    av1C: Uint8Array | undefined,
): Av1SequenceHeader | undefined {
    if (!av1C || av1C.length < 5 || (av1C[0]! & 0x7f) !== 1) return undefined;
    return av1SequenceHeaderOf(av1C.subarray(4));
}

/** RFC 6381 codec string of an av1C record: av01.P.LLT.DD. */
export function av1CodecString(av1C: Uint8Array | undefined): string | undefined {
    if (!av1C || av1C.length < 4 || (av1C[0]! & 0x7f) !== 1) return undefined;
    const profile = av1C[1]! >>> 5;
    const highBitdepth = (av1C[2]! & 0x40) !== 0;
    const twelveBit = (av1C[2]! & 0x20) !== 0;
    if (profile > 2 || (twelveBit && (!highBitdepth || profile !== 2))) return undefined;
    const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
    const level = String(av1C[1]! & 31).padStart(2, '0');
    const tier = av1C[2]! & 0x80 ? 'H' : 'M';
    return `av01.${profile}.${level}${tier}.${String(depth).padStart(2, '0')}`;
}

export interface Av1TemporalUnitInfo {
    /** A shown key frame starts random access here, directly or through show_existing_frame. */
    readonly keyframe: boolean;
    /** Frame headers were found. */
    readonly frames: number;
}

/**
 * Tracks the reference slots that hold key frames so show_existing_frame of a key frame counts as
 * random access, as the ISOBMFF and Matroska AV1 mappings define sync samples.
 */
export class Av1StreamState {
    private sequence?: Av1SequenceHeader;
    /** The stream's first sequence header, which configures its decoding. */
    first?: Av1SequenceHeader;
    private readonly keyInSlot = new Array<boolean>(8).fill(false);

    get sequenceHeader(): Av1SequenceHeader | undefined {
        return this.sequence;
    }

    /**
     * The av1C record and colour of the first sequence header; without one, `missing` is reported
     * as damage read past.
     */
    configuration(
        diagnostics: DiagnosticContext,
        format: string,
        missing: string,
    ): { codecConfig?: Uint8Array; colour?: Av1SequenceHeader['colour'] } {
        const first = this.first;
        if (first) return { codecConfig: av1ConfigFromSequenceHeader(first), colour: first.colour };
        diagnostics.recover({ code: 'AV1_SEQUENCE_HEADER_MISSING', format, message: missing });
        return {};
    }

    /** Inspects one temporal unit in low-overhead format. */
    inspect(data: Uint8Array, obus = splitAv1Obus(data)): Av1TemporalUnitInfo {
        let keyframe = false;
        let frames = 0;
        for (const obu of obus ?? []) {
            if (obu.type === AV1_OBU_SEQUENCE_HEADER) {
                const parsed = parseAv1SequenceHeader(
                    data,
                    obu.payloadStart,
                    obu.end,
                    data.slice(obu.start, obu.end),
                );
                if (parsed) {
                    this.first ??= parsed;
                    this.sequence = parsed;
                }
                continue;
            }

            if (obu.type !== AV1_OBU_FRAME && obu.type !== AV1_OBU_FRAME_HEADER) continue;
            const sequence = this.sequence;
            if (!sequence) continue;
            frames++;
            if (this.frameHeader(data, obu, sequence)) keyframe = true;
        }
        return { keyframe, frames };
    }

    /**
     * uncompressed_header() up to refresh_frame_flags; returns whether the frame is a shown key
     * frame.
     */
    private frameHeader(data: Uint8Array, obu: Av1Obu, sequence: Av1SequenceHeader): boolean {
        if (sequence.reducedStillPicture) {
            this.keyInSlot.fill(true);
            return true;
        }

        const bits = new Bits(data, obu.end, obu.payloadStart);
        if (bits.read(1)) {
            const slot = bits.read(3);
            return bits.ok && this.keyInSlot[slot] === true;
        }
        const frameType = bits.read(2);
        const showFrame = bits.read(1);
        if (showFrame && sequence.decoderModelInfoPresent && !sequence.equalPictureInterval)
            bits.read(sequence.framePresentationTimeLength);
        if (!showFrame) bits.read(1);

        const intra = frameType === AV1_KEY_FRAME || frameType === 2;
        const errorResilient =
            frameType === AV1_SWITCH_FRAME || (frameType === AV1_KEY_FRAME && showFrame)
                ? 1
                : bits.read(1);
        bits.read(1);

        let screenContent = sequence.forceScreenContentTools;
        if (screenContent === 2) screenContent = bits.read(1);
        if (screenContent) {
            if (sequence.forceIntegerMv === 2) bits.read(1);
        }
        if (sequence.frameIdLength) bits.read(sequence.frameIdLength);
        if (frameType !== AV1_SWITCH_FRAME) bits.read(1);
        bits.read(sequence.orderHintBits);
        if (!intra && !errorResilient) bits.read(3);
        if (sequence.decoderModelInfoPresent && bits.read(1)) {
            for (const point of sequence.operatingPoints) {
                if (!point.decoderModel) continue;
                const inTemporal = (point.idc >> obu.temporalId) & 1;
                const inSpatial = (point.idc >> (obu.spatialId + 8)) & 1;
                if (point.idc === 0 || (inTemporal && inSpatial))
                    bits.read(sequence.bufferRemovalTimeLength);
            }
        }

        const refresh =
            frameType === AV1_SWITCH_FRAME || (frameType === AV1_KEY_FRAME && showFrame)
                ? 0xff
                : bits.read(8);
        if (!bits.ok) return false;
        for (let slot = 0; slot < 8; slot++)
            if (refresh & (1 << slot)) this.keyInSlot[slot] = frameType === AV1_KEY_FRAME;
        return frameType === AV1_KEY_FRAME && showFrame === 1;
    }
}

/** Frame duration in seconds stated by the sequence header timing_info, when it states one. */
export function av1FrameDuration(sequence: Av1SequenceHeader | undefined): number | undefined {
    if (!sequence?.equalPictureInterval || !sequence.tickNumerator || !sequence.tickDenominator)
        return undefined;
    return sequence.tickNumerator / sequence.tickDenominator;
}

/**
 * Converts one Annex B temporal unit (frame units of length-prefixed OBUs without obu_size fields)
 * into the low-overhead format. Returns undefined when the sizes do not add up.
 */
export function av1AnnexBToLowOverhead(unit: Uint8Array): Uint8Array | undefined {
    const parts: Uint8Array[] = [];
    let total = 0;
    let offset = 0;
    while (offset < unit.length) {
        const frameSize = leb128(unit, offset, unit.length);
        if (!frameSize) return undefined;
        offset += frameSize.length;
        const frameEnd = offset + frameSize.value;
        if (frameEnd > unit.length) return undefined;

        while (offset < frameEnd) {
            const obuLength = leb128(unit, offset, frameEnd);
            if (!obuLength || obuLength.value < 1) return undefined;
            offset += obuLength.length;
            const obuEnd = offset + obuLength.value;
            if (obuEnd > frameEnd) return undefined;

            const header = unit[offset]!;
            if (header & 0x80) return undefined;
            const extension = (header >> 2) & 1;
            const sized = (header >> 1) & 1;
            const headerLength = 1 + extension;
            if (sized) {
                parts.push(unit.subarray(offset, obuEnd));
                total += obuEnd - offset;
            } else {
                const payloadLength = obuEnd - offset - headerLength;
                if (payloadLength < 0) return undefined;
                const size = leb128Bytes(payloadLength);
                const rebuilt = new Uint8Array(headerLength + size.length + payloadLength);
                rebuilt[0] = header | 0x02;
                if (extension) rebuilt[1] = unit[offset + 1]!;
                rebuilt.set(size, headerLength);
                rebuilt.set(
                    unit.subarray(offset + headerLength, obuEnd),
                    headerLength + size.length,
                );
                parts.push(rebuilt);
                total += rebuilt.length;
            }

            offset = obuEnd;
        }
    }

    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * Whether bytes start an Annex B length-delimited AV1 stream: temporal unit, frame unit and a
 * temporal delimiter.
 */
export function isAv1AnnexB(h: Uint8Array): boolean {
    const unit = leb128(h, 0, h.length);
    if (!unit || unit.value < 3) return false;
    const frame = leb128(h, unit.length, h.length);
    if (!frame || frame.value < 2 || frame.value > unit.value) return false;
    const at = unit.length + frame.length;
    const obu = leb128(h, at, h.length);
    if (!obu || obu.value !== 1) return false;
    const header = h[at + obu.length];
    return (
        header !== undefined &&
        (header & 0xf8) === AV1_OBU_TEMPORAL_DELIMITER << 3 &&
        (header & 0x02) === 0
    );
}

/**
 * Whether bytes start a low-overhead AV1 stream: a sized temporal delimiter followed by a sized OBU
 * header.
 */
export function isAv1LowOverhead(h: Uint8Array): boolean {
    if (h.length < 3 || h[0] !== 0x12 || h[1] !== 0x00) return false;
    const next = h[2]!;
    const type = (next >> 3) & 15;
    return (
        (next & 0x80) === 0 &&
        (next & 0x02) !== 0 &&
        (type === AV1_OBU_SEQUENCE_HEADER || type === AV1_OBU_METADATA)
    );
}
