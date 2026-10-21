import { DecodeError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import {
    STREAMINFO_BYTES,
    flacCrc16,
    flacStreamInfoRecord,
    isFlacMarker,
    parseFlacFrameHeader,
    readFlacStreamInfo,
    streamInfoBlockAt,
    type FlacFrameHeader,
} from '../../core/codec-config/audio/flac-frame';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec, DecodeOptions } from '../../core/contracts/decoder';
import { DEFAULT_CHANNEL_MASKS } from '../../core/model/channel-layout';
import { yieldEventLoop } from '../../core/io/event-loop';

/** Frames decodeFlac() decodes between yields to the event loop. */
const YIELD_FRAMES = 16;

export interface FlacStreamInfo {
    readonly minBlockSize: number;
    readonly maxBlockSize: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    /** Zero when the stream length is unknown. */
    readonly totalSamples: number;
}

export interface DecodedFlacFrame {
    readonly header: FlacFrameHeader;
    readonly sampleRate: number;
    readonly bitsPerSample: number;
    /** Integer samples per channel after stereo decorrelation. */
    readonly channels: readonly Int32Array[];
    /** Bytes consumed from the frame offset, including the CRC-16. */
    readonly byteLength: number;
}

export interface DecodedFlac {
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly sampleFrames: number;
    /** Planar samples scaled to [-1, 1). */
    readonly channelData: readonly Float32Array[];
}

function readStreamInfoRecord(record: Uint8Array): FlacStreamInfo {
    if (record.length < STREAMINFO_BYTES) throw new DecodeError('FLAC STREAMINFO is truncated');
    const { minBlockSize, maxBlockSize, sampleRate, channels, bitsPerSample, totalSamples } =
        readFlacStreamInfo(record);
    const info: FlacStreamInfo = {
        minBlockSize,
        maxBlockSize,
        sampleRate,
        channels,
        bitsPerSample,
        totalSamples,
    };

    if (
        info.sampleRate < 1 ||
        info.sampleRate > 655350 ||
        info.bitsPerSample < 4 ||
        info.bitsPerSample > 32
    )
        throw new DecodeError('FLAC STREAMINFO has an invalid audio shape');
    return info;
}

/**
 * Reads STREAMINFO from a raw 34-byte record, a stream header starting with fLaC, or a dfLa box
 * payload.
 */
export function parseFlacStreamInfo(config: Uint8Array): FlacStreamInfo {
    const record = flacStreamInfoRecord(config);
    if (!record) throw new DecodeError('FLAC decoder configuration must contain STREAMINFO');
    return readStreamInfoRecord(record);
}

/** MSB-first reader over one frame; the cache keeps its valid bits left-aligned. */
class BitReader {
    private cache = 0;
    private count = 0;
    private position: number;

    constructor(
        private readonly bytes: Uint8Array,
        offset: number,
        private readonly end: number,
    ) {
        this.position = offset;
    }

    private refill(): void {
        while (this.count <= 24 && this.position < this.end) {
            this.cache |= this.bytes[this.position++]! << (24 - this.count);
            this.count += 8;
        }
    }

    /** Unsigned value of the next n bits, 0 <= n <= 32. */
    bits(n: number): number {
        if (n === 0) return 0;
        if (n > 24) return this.bits(n - 16) * 65536 + this.bits(16);
        if (this.count < n) {
            this.refill();
            if (this.count < n) throw new DecodeError('FLAC frame is truncated');
        }
        const value = this.cache >>> (32 - n);
        this.cache <<= n;
        this.count -= n;
        return value;
    }

    signed(n: number): number {
        if (n === 0) return 0;
        const value = this.bits(n);
        if (n === 32) return value | 0;
        const limit = 2 ** (n - 1);
        return value >= limit ? value - limit * 2 : value;
    }

    /** Number of zero bits before the next one bit, which is consumed too. */
    unary(): number {
        let zeros = 0;
        for (;;) {
            if (this.count === 0) {
                this.refill();
                if (this.count === 0) throw new DecodeError('FLAC frame is truncated');
            }
            const leading = Math.clz32(this.cache);
            if (leading < this.count) {
                zeros += leading;
                const consumed = leading + 1;
                this.cache = consumed === 32 ? 0 : this.cache << consumed;
                this.count -= consumed;
                return zeros;
            }
            zeros += this.count;
            this.cache = 0;
            this.count = 0;
        }
    }

    /**
     * Rice-coded residuals with a parameter of at most 24 bits, zigzag-decoded into samples[index,
     * index + count).
     */
    rice(samples: Int32Array, index: number, count: number, parameter: number): void {
        const bytes = this.bytes;
        const end = this.end;
        const scale = 2 ** parameter;
        let cache = this.cache;
        let available = this.count;
        let position = this.position;
        for (let k = 0; k < count; k++) {
            let quotient = 0;
            for (;;) {
                if (available === 0) {
                    while (available <= 24 && position < end) {
                        cache |= bytes[position++]! << (24 - available);
                        available += 8;
                    }
                    if (available === 0) throw new DecodeError('FLAC frame is truncated');
                }
                const leading = Math.clz32(cache);
                if (leading < available) {
                    quotient += leading;
                    cache = leading === 31 ? 0 : cache << (leading + 1);
                    available -= leading + 1;
                    break;
                }
                quotient += available;
                cache = 0;
                available = 0;
            }
            let remainder = 0;
            if (parameter) {
                if (available < parameter) {
                    while (available <= 24 && position < end) {
                        cache |= bytes[position++]! << (24 - available);
                        available += 8;
                    }
                    if (available < parameter) throw new DecodeError('FLAC frame is truncated');
                }
                remainder = cache >>> (32 - parameter);
                cache <<= parameter;
                available -= parameter;
            }
            const value = quotient * scale + remainder;
            samples[index + k] = value < 0x80000000 ? (value >>> 1) ^ -(value & 1) : zigzag(value);
        }
        this.cache = cache;
        this.count = available;
        this.position = position;
    }

    align(): void {
        const partial = this.count & 7;
        if (partial) this.bits(partial);
    }

    /** Byte index of the next unread byte; valid on a byte boundary. */
    get byteOffset(): number {
        return this.position - (this.count >> 3);
    }
}

function zigzag(value: number): number {
    if (value < 0x80000000) return (value >>> 1) ^ -(value & 1);
    const half = Math.floor(value / 2);
    return value % 2 ? -half - 1 : half;
}

function decodeResidual(
    reader: BitReader,
    samples: Int32Array,
    blockSize: number,
    order: number,
): void {
    const method = reader.bits(2);
    if (method > 1) throw new DecodeError('FLAC residual coding method is reserved');
    const parameterBits = method === 0 ? 4 : 5;
    const escape = method === 0 ? 15 : 31;
    const partitionOrder = reader.bits(4);
    const partitions = 1 << partitionOrder;
    const partitionSamples = blockSize >> partitionOrder;
    if (partitionSamples << partitionOrder !== blockSize || partitionSamples < order)
        throw new DecodeError('FLAC residual partitions do not fit the block');
    let index = order;
    for (let partition = 0; partition < partitions; partition++) {
        const count = partition === 0 ? partitionSamples - order : partitionSamples;
        const parameter = reader.bits(parameterBits);
        if (parameter === escape) {
            const width = reader.bits(5);
            if (width === 0) samples.fill(0, index, index + count);
            else for (let k = 0; k < count; k++) samples[index + k] = reader.signed(width);
            index += count;
            continue;
        }
        if (parameter <= 24) reader.rice(samples, index, count, parameter);
        else {
            const scale = 2 ** parameter;
            for (let k = 0; k < count; k++)
                samples[index + k] = zigzag(reader.unary() * scale + reader.bits(parameter));
        }
        index += count;
    }
}

/**
 * Fixed predictors; the last samples ride in locals, each wrapped as an Int32Array store wraps it.
 */
function restoreFixed(samples: Int32Array, blockSize: number, order: number): void {
    if (order === 0 || blockSize <= order) return;
    let s1 = samples[order - 1]!;
    let s2 = order >= 2 ? samples[order - 2]! : 0;
    let s3 = order >= 3 ? samples[order - 3]! : 0;
    let s4 = order >= 4 ? samples[order - 4]! : 0;
    switch (order) {
        case 1:
            for (let i = 1; i < blockSize; i++) samples[i] = s1 = (samples[i]! + s1) | 0;
            return;
        case 2:
            for (let i = 2; i < blockSize; i++) {
                const value = (samples[i]! + (2 * s1 - s2)) | 0;
                samples[i] = value;
                s2 = s1;
                s1 = value;
            }
            return;
        case 3:
            for (let i = 3; i < blockSize; i++) {
                const value = (samples[i]! + (3 * s1 - 3 * s2 + s3)) | 0;
                samples[i] = value;
                s3 = s2;
                s2 = s1;
                s1 = value;
            }
            return;
        default:
            for (let i = 4; i < blockSize; i++) {
                const value = (samples[i]! + (4 * s1 - 6 * s2 + 4 * s3 - s4)) | 0;
                samples[i] = value;
                s4 = s3;
                s3 = s2;
                s2 = s1;
                s1 = value;
            }
    }
}

function restoreLpc(
    samples: Int32Array,
    blockSize: number,
    coefficients: Int32Array,
    shift: number,
): void {
    const order = coefficients.length;

    // The products (at most 15 + 32 bits) and their sums stay exact integers, so any order of
    // summation gives the same prediction; scaling by 2^-shift is exact like the division it
    // replaces.
    const scale = 2 ** -shift;
    if (order >= 8) {
        const c0 = coefficients[0]!;
        const c1 = coefficients[1]!;
        const c2 = coefficients[2]!;
        const c3 = coefficients[3]!;
        const c4 = coefficients[4]!;
        const c5 = coefficients[5]!;
        const c6 = coefficients[6]!;
        const c7 = coefficients[7]!;

        // The last eight samples ride in locals, and the terms of the older ones come first: the
        // sample just restored enters last, so the next one waits on a single product of it.
        let s1 = samples[order - 1]!;
        let s2 = samples[order - 2]!;
        let s3 = samples[order - 3]!;
        let s4 = samples[order - 4]!;
        let s5 = samples[order - 5]!;
        let s6 = samples[order - 6]!;
        let s7 = samples[order - 7]!;
        let s8 = samples[order - 8]!;
        for (let i = order; i < blockSize; i++) {
            let older = 0;
            for (let j = 8; j < order; j++) older += coefficients[j]! * samples[i - 1 - j]!;
            const prediction =
                older +
                (c7 * s8 + c6 * s7) +
                (c5 * s6 + c4 * s5) +
                (c3 * s4 + c2 * s3) +
                c1 * s2 +
                c0 * s1;

            // The wrap of an Int32Array store.
            const value = (samples[i]! + Math.floor(prediction * scale)) | 0;
            samples[i] = value;
            s8 = s7;
            s7 = s6;
            s6 = s5;
            s5 = s4;
            s4 = s3;
            s3 = s2;
            s2 = s1;
            s1 = value;
        }
        return;
    }
    for (let i = order; i < blockSize; i++) {
        let prediction = 0;
        for (let j = 0; j < order; j++) prediction += coefficients[j]! * samples[i - 1 - j]!;
        samples[i]! += Math.floor(prediction * scale);
    }
}

function decodeSubframe(
    reader: BitReader,
    samples: Int32Array,
    blockSize: number,
    bitsPerSample: number,
): void {
    if (reader.bits(1) !== 0) throw new DecodeError('FLAC subframe padding bit is set');
    const type = reader.bits(6);
    const wasted = reader.bits(1) === 1 ? reader.unary() + 1 : 0;
    const bits = bitsPerSample - wasted;
    if (bits < 1 || bits > 32) throw new DecodeError('FLAC subframe bit depth is invalid');
    if (type === 0) {
        samples.fill(reader.signed(bits), 0, blockSize);
    } else if (type === 1) {
        for (let i = 0; i < blockSize; i++) samples[i] = reader.signed(bits);
    } else if ((type & 0x38) === 0x08 && (type & 0x07) <= 4) {
        const order = type & 0x07;
        if (order > blockSize)
            throw new DecodeError('FLAC fixed predictor order exceeds the block');
        for (let i = 0; i < order; i++) samples[i] = reader.signed(bits);
        decodeResidual(reader, samples, blockSize, order);
        restoreFixed(samples, blockSize, order);
    } else if ((type & 0x20) !== 0) {
        const order = (type & 0x1f) + 1;
        if (order > blockSize) throw new DecodeError('FLAC LPC order exceeds the block');
        for (let i = 0; i < order; i++) samples[i] = reader.signed(bits);
        const precision = reader.bits(4) + 1;
        if (precision === 16) throw new DecodeError('FLAC LPC precision is reserved');
        const shift = reader.signed(5);
        if (shift < 0) throw new DecodeError('FLAC LPC shift is negative');
        const coefficients = new Int32Array(order);
        for (let i = 0; i < order; i++) coefficients[i] = reader.signed(precision);
        decodeResidual(reader, samples, blockSize, order);
        restoreLpc(samples, blockSize, coefficients, shift);
    } else {
        throw new DecodeError(`FLAC subframe type ${type} is reserved`);
    }

    if (wasted) {
        const scale = 2 ** wasted;
        for (let i = 0; i < blockSize; i++) samples[i]! *= scale;
    }
}

/** The options of decodeFlacFrame(). */
export interface FlacFrameDecodeOptions {
    /** The stream's STREAMINFO, as parseFlacStreamInfo() reads it. */
    readonly streamInfo: FlacStreamInfo;
}

/**
 * Decodes the FLAC frame at the start of `frame`; its own header wins over STREAMINFO for rate and
 * depth.
 */
export function decodeFlacFrame(
    frame: Uint8Array,
    options: FlacFrameDecodeOptions,
): DecodedFlacFrame {
    return decodeFrameAt(frame, 0, options.streamInfo);
}

/**
 * Decodes the frame at offset. The channels reuse the `scratch` buffers when given, so they stay
 * valid only until the next call with the same scratch.
 */
function decodeFrameAt(
    bytes: Uint8Array,
    offset: number,
    info: FlacStreamInfo,
    scratch?: Int32Array[],
): DecodedFlacFrame {
    const header = parseFlacFrameHeader(bytes, offset);
    if (!header) throw new DecodeError('FLAC frame header is invalid');
    const assignment = (bytes[offset + 3]! >> 4) & 0x0f;
    const sampleRate = header.sampleRate ?? info.sampleRate;
    const bitsPerSample = header.bitsPerSample ?? info.bitsPerSample;
    const { blockSize, channelCount } = header;
    const reader = new BitReader(bytes, offset + header.headerLen, bytes.length);
    const channels: Int32Array[] = [];
    for (let channel = 0; channel < channelCount; channel++) {
        const side =
            (assignment === 8 && channel === 1) ||
            (assignment === 9 && channel === 0) ||
            (assignment === 10 && channel === 1);
        if (side && bitsPerSample >= 32)
            throw new DecodeError('FLAC 32-bit side-coded stereo is not supported');
        let samples: Int32Array;
        if (scratch) {
            if ((scratch[channel]?.length ?? 0) < blockSize)
                scratch[channel] = new Int32Array(blockSize);
            samples = scratch[channel]!.subarray(0, blockSize);
        } else samples = new Int32Array(blockSize);

        decodeSubframe(reader, samples, blockSize, bitsPerSample + (side ? 1 : 0));
        channels.push(samples);
    }

    reader.align();
    const crcOffset = reader.byteOffset;
    if (crcOffset + 2 > bytes.length)
        throw new DecodeError('FLAC frame is truncated before its CRC-16');
    const given = (bytes[crcOffset]! << 8) | bytes[crcOffset + 1]!;
    if (flacCrc16(bytes.subarray(offset, crcOffset)) !== given)
        throw new DecodeError('FLAC frame fails CRC-16');
    if (assignment === 8) {
        const [left, side] = channels as [Int32Array, Int32Array];
        for (let i = 0; i < blockSize; i++) side[i] = left[i]! - side[i]!;
    } else if (assignment === 9) {
        const [side, right] = channels as [Int32Array, Int32Array];
        for (let i = 0; i < blockSize; i++) side[i]! += right[i]!;
    } else if (assignment === 10) {
        const [mid, side] = channels as [Int32Array, Int32Array];
        for (let i = 0; i < blockSize; i++) {
            const difference = side[i]!;
            const sum = mid[i]! * 2 + (difference & 1);
            mid[i] = (sum + difference) >> 1;
            side[i] = (sum - difference) >> 1;
        }
    }

    return { header, sampleRate, bitsPerSample, channels, byteLength: crcOffset + 2 - offset };
}

/** Writes `bitsPerSample`-bit samples into `target` from `at` as v / 2^(bitsPerSample - 1). */
function writeFloats(
    samples: Int32Array,
    bitsPerSample: number,
    target: Float32Array,
    at: number,
): void {
    const scale = 1 / 2 ** (bitsPerSample - 1);
    for (let i = 0; i < samples.length; i++) target[at + i] = samples[i]! * scale;
}

export function flacSamplesToFloat(samples: Int32Array, bitsPerSample: number): Float32Array {
    const out = new Float32Array(samples.length);
    writeFloats(samples, bitsPerSample, out, 0);
    return out;
}

/** Decodes a whole FLAC stream held in memory, yielding to the event loop between frames. */
export async function decodeFlac(
    bytes: Uint8Array,
    options: DecodeOptions = {},
): Promise<DecodedFlac> {
    if (bytes.length < 4 + 4 + STREAMINFO_BYTES || !isFlacMarker(bytes, 0))
        throw new DecodeError('FLAC marker is missing');
    let position = 4;
    let last = false;
    let info: FlacStreamInfo | undefined;
    while (!last) {
        if (position + 4 > bytes.length) throw new DecodeError('FLAC metadata is truncated');
        const flag = bytes[position]!;
        last = (flag & 0x80) !== 0;
        const length =
            (bytes[position + 1]! << 16) | (bytes[position + 2]! << 8) | bytes[position + 3]!;
        if (info === undefined) {
            if (!streamInfoBlockAt(bytes, position))
                throw new DecodeError('FLAC first metadata block is not STREAMINFO');
            info = readStreamInfoRecord(
                bytes.subarray(position + 4, position + 4 + STREAMINFO_BYTES),
            );
        }

        position += 4 + length;
    }

    if (info === undefined || position > bytes.length)
        throw new DecodeError('FLAC metadata is truncated');
    const frames: DecodedFlacFrame[] = [];
    let sampleFrames = 0;
    while (position < bytes.length) {
        throwIfAborted(options.signal);
        const frame = decodeFrameAt(bytes, position, info);
        if (frame.header.channelCount !== info.channels)
            throw new DecodeError('FLAC frame channel count differs from STREAMINFO');
        frames.push(frame);
        sampleFrames += frame.header.blockSize;
        position += frame.byteLength;
        if (frames.length % YIELD_FRAMES === 0) await yieldEventLoop();
    }

    throwIfAborted(options.signal);
    const channelData = Array.from({ length: info.channels }, () => new Float32Array(sampleFrames));
    let written = 0;
    for (const frame of frames) {
        for (let channel = 0; channel < info.channels; channel++)
            writeFloats(
                frame.channels[channel]!,
                frame.bitsPerSample,
                channelData[channel]!,
                written,
            );
        written += frame.header.blockSize;
    }

    return {
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
        sampleFrames,
        channelData,
    };
}

/** Built-in FLAC decoding of demuxed frames (raw FLAC, Ogg, Matroska or MP4 fLaC tracks). */
export function flacAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    if (!track.codecConfig) throw new MediaForgeError('FLAC track carries no STREAMINFO', 'FORMAT');
    const info = parseFlacStreamInfo(track.codecConfig);
    return {
        channelMask: DEFAULT_CHANNEL_MASKS[info.channels - 1],
        create: () => {
            const scratch: Int32Array[] = [];
            return {
                decode(packet) {
                    const frame = decodeFrameAt(packet, 0, info, scratch);
                    if (frame.header.channelCount !== info.channels)
                        throw new DecodeError('FLAC frame channel count differs from STREAMINFO');
                    return [
                        frame.channels.map(samples =>
                            flacSamplesToFloat(samples, frame.bitsPerSample),
                        ),
                    ];
                },
                reset() {},
            };
        },
    };
}
