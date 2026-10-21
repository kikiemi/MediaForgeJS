import { DecodeError, MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec } from '../../core/contracts/decoder';
import { ELEMENT_ORDER, ELEMENT_ORDER_MASKS } from '../../core/model/channel-layout';
import { alacCookie } from '../../core/codec-config/audio/alac-packet';

/**
 * AlacSpecificConfig: the 24-byte magic cookie that MP4 'alac' boxes, CAF 'kuki' and Matroska
 * A_ALAC carry.
 */
export interface AlacConfig {
    readonly frameLength: number;
    readonly bitDepth: number;
    readonly riceHistoryMultiplier: number;
    readonly riceInitialHistory: number;
    readonly riceLimit: number;
    readonly channels: number;
    readonly maxRun: number;
    readonly maxFrameBytes: number;
    readonly averageBitrate: number;
    readonly sampleRate: number;
    /** The 24 configuration bytes without any atom header. */
    readonly cookie: Uint8Array;
}

const MAX_FRAME_LENGTH = 65536;

/**
 * Reads the configuration from the bare 24-byte cookie, an 'alac' atom (size, type, version/flags,
 * cookie) or a CAF cookie that starts with a 'frma' atom before the 'alac' atom.
 */
export function parseAlacConfig(input: Uint8Array): AlacConfig {
    const cookie = alacCookie(input);
    if (!cookie) throw new DecodeError('ALAC magic cookie is shorter than 24 bytes');
    const view = new DataView(cookie.buffer);
    const config: AlacConfig = {
        frameLength: view.getUint32(0),
        bitDepth: cookie[5]!,
        riceHistoryMultiplier: cookie[6]!,
        riceInitialHistory: cookie[7]!,
        riceLimit: cookie[8]!,
        channels: cookie[9]!,
        maxRun: view.getUint16(10),
        maxFrameBytes: view.getUint32(12),
        averageBitrate: view.getUint32(16),
        sampleRate: view.getUint32(20),
        cookie,
    };

    if (
        cookie[4] !== 0 ||
        ![16, 20, 24, 32].includes(config.bitDepth) ||
        config.channels < 1 ||
        config.channels > 8 ||
        config.frameLength < 1 ||
        config.frameLength > MAX_FRAME_LENGTH ||
        config.sampleRate < 1 ||
        config.riceLimit < 1 ||
        config.riceLimit > 32
    )
        throw new DecodeError('ALAC magic cookie describes an unsupported stream');
    return config;
}

const QB_SHIFT = 9;
const MAX_PREFIX = 9;

function sign(value: number): number {
    return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Big-endian bit reader over a zero-padded copy of one packet. */
class BitReader {
    bytes = new Uint8Array(0);
    position = 0;
    limit = 0;

    load(packet: Uint8Array): void {
        if (this.bytes.length < packet.length + 8)
            this.bytes = new Uint8Array(packet.length + 1024);
        this.bytes.set(packet);
        this.bytes.fill(0, packet.length, packet.length + 8);
        this.position = 0;
        this.limit = packet.length * 8;
    }

    /** 32 bits starting at the current position, MSB first. */
    peek32(): number {
        const bytes = this.bytes;
        const byte = this.position >>> 3;
        const word =
            ((bytes[byte]! << 24) |
                (bytes[byte + 1]! << 16) |
                (bytes[byte + 2]! << 8) |
                bytes[byte + 3]!) >>>
            0;
        const offset = this.position & 7;
        return offset ? ((word << offset) | (bytes[byte + 4]! >>> (8 - offset))) >>> 0 : word;
    }

    read(bits: number): number {
        if (bits === 0) return 0;
        const value = bits === 32 ? this.peek32() : this.peek32() >>> (32 - bits);
        this.position += bits;
        if (this.position > this.limit) throw new DecodeError('ALAC frame is truncated');
        return value;
    }

    skip(bits: number): void {
        this.position += bits;
        if (this.position > this.limit) throw new DecodeError('ALAC frame is truncated');
    }

    align(): void {
        this.position = (this.position + 7) & ~7;
    }
}

/** Adaptive Golomb-Rice residual decoding into `output`; returns nothing, fails on overruns. */
function decodeResiduals(
    reader: BitReader,
    output: Int32Array,
    count: number,
    sampleBits: number,
    multiplier: number,
    initialHistory: number,
    riceLimit: number,
): void {
    let history = initialHistory;
    let zero = 0;
    let index = 0;
    while (index < count) {
        if (reader.position >= reader.limit)
            throw new DecodeError('ALAC residuals overrun the frame');
        let k = 31 - Math.clz32((history >>> QB_SHIFT) + 3);
        if (k > riceLimit) k = riceLimit;
        const m = 2 ** k - 1;
        const word = reader.peek32();
        const prefix = Math.clz32(~word);
        let value: number;
        if (prefix >= MAX_PREFIX) {
            reader.skip(MAX_PREFIX);
            value = reader.read(sampleBits);
        } else {
            reader.skip(prefix + 1);
            const suffix = k === 32 ? reader.peek32() : reader.peek32() >>> (32 - k);
            if (suffix < 2) {
                value = prefix * m;
                reader.skip(k - 1);
            } else {
                value = prefix * m + suffix - 1;
                reader.skip(k);
            }
        }
        const coded = value + zero;
        output[index++] = coded & 1 ? -Math.floor((coded + 1) / 2) : Math.floor(coded / 2);
        history =
            coded > 0xffff
                ? 0xffff
                : multiplier * coded + history - ((multiplier * history) >>> QB_SHIFT);
        zero = 0;
        if (history < 128 && index < count) {
            // 7 - floor(log2(history)), with log2(0) taken as 0 like the reference decoder, limited
            // to kb.
            const runBits = Math.min(
                riceLimit,
                7 - (history ? 31 - Math.clz32(history) : 0) + ((history + 16) >> 6),
            );
            const runMask = 2 ** runBits - 1;
            const runWord = reader.peek32();
            const runPrefix = Math.clz32(~runWord);
            let run: number;
            if (runPrefix >= MAX_PREFIX) {
                reader.skip(MAX_PREFIX);
                run = reader.read(16);
            } else {
                reader.skip(runPrefix + 1);
                const suffix = runBits === 0 ? 0 : reader.peek32() >>> (32 - runBits);
                if (suffix < 2) {
                    run = runPrefix * runMask;
                    if (runBits) reader.skip(runBits - 1);
                } else {
                    run = runPrefix * runMask + suffix - 1;
                    reader.skip(runBits);
                }
            }
            if (index + run > count) throw new DecodeError('ALAC zero run exceeds the frame');
            output.fill(0, index, index + run);
            index += run;
            zero = run <= 0xffff ? 1 : 0;
            history = 0;
        }
    }
}

/** Adaptive linear prediction (in place when residuals and output share a buffer). */
function predict(
    residuals: Int32Array,
    output: Int32Array,
    count: number,
    coefficients: Int32Array,
    order: number,
    sampleBits: number,
    denominatorShift: number,
): void {
    const shift = 32 - sampleBits;
    output[0] = residuals[0]!;
    if (order === 0) {
        if (residuals !== output) output.set(residuals.subarray(1, count), 1);
        return;
    }
    if (order === 31) {
        let previous = output[0]!;
        for (let index = 1; index < count; index++) {
            previous = ((residuals[index]! + previous) << shift) >> shift;
            output[index] = previous;
        }
        return;
    }
    for (let index = 1; index <= order && index < count; index++)
        output[index] = ((residuals[index]! + output[index - 1]!) << shift) >> shift;
    const half = denominatorShift > 0 ? 1 << (denominatorShift - 1) : 0;
    for (let index = order + 1; index < count; index++) {
        const top = output[index - order - 1]!;
        let sum = 0;
        for (let k = 0; k < order; k++)
            sum = (sum + Math.imul(coefficients[k]!, (output[index - 1 - k]! - top) | 0)) | 0;
        let residual = residuals[index]!;
        const direction = sign(residual);
        output[index] = ((residual + top + ((sum + half) >> denominatorShift)) << shift) >> shift;
        if (direction > 0) {
            for (let k = order - 1; k >= 0; k--) {
                const difference = (top - output[index - 1 - k]!) | 0;
                const step = sign(difference);
                coefficients[k] = ((coefficients[k]! - step) << 16) >> 16;
                residual =
                    (residual -
                        Math.imul(order - k, Math.imul(step, difference) >> denominatorShift)) |
                    0;
                if (residual <= 0) break;
            }
        } else if (direction < 0) {
            for (let k = order - 1; k >= 0; k--) {
                const difference = (top - output[index - 1 - k]!) | 0;
                const step = sign(difference);
                coefficients[k] = ((coefficients[k]! + step) << 16) >> 16;
                residual =
                    (residual -
                        Math.imul(order - k, Math.imul(-step, difference) >> denominatorShift)) |
                    0;
                if (residual >= 0) break;
            }
        }
    }
}

interface ChannelParameters {
    mode: number;
    denominatorShift: number;
    multiplierFactor: number;
    order: number;
    readonly coefficients: Int32Array;
}

/**
 * Stateless per frame: each ALAC packet decodes independently into planar float PCM in WAVE channel
 * order.
 */
export class AlacDecoder {
    readonly config: AlacConfig;
    private readonly reader = new BitReader();
    private readonly residuals: Int32Array;
    private readonly mixU: Int32Array;
    private readonly mixV: Int32Array;
    private readonly shifted: Uint16Array;
    private readonly parameters: [ChannelParameters, ChannelParameters] = [
        {
            mode: 0,
            denominatorShift: 0,
            multiplierFactor: 0,
            order: 0,
            coefficients: new Int32Array(32),
        },
        {
            mode: 0,
            denominatorShift: 0,
            multiplierFactor: 0,
            order: 0,
            coefficients: new Int32Array(32),
        },
    ];
    private readonly scale: number;

    constructor(config: AlacConfig | Uint8Array) {
        this.config = config instanceof Uint8Array ? parseAlacConfig(config) : config;
        const length = this.config.frameLength;
        this.residuals = new Int32Array(length);
        this.mixU = new Int32Array(length);
        this.mixV = new Int32Array(length);
        this.shifted = new Uint16Array(length * 2);
        this.scale = 1 / 2 ** (this.config.bitDepth - 1);
    }

    get channelMask(): number {
        return ELEMENT_ORDER_MASKS[this.config.channels - 1]!;
    }

    /**
     * Decodes one packet; channels missing from the packet are returned as silence, as the
     * reference decoder does.
     */
    decode(packet: Uint8Array): Float32Array[] {
        const { channels, bitDepth } = this.config;
        const reader = this.reader;
        reader.load(packet);
        const order = ELEMENT_ORDER[channels - 1]!;
        const planes: (Float32Array | undefined)[] = new Array(channels);
        let channel = 0;
        let frames = -1;
        for (;;) {
            const tag = reader.read(3);
            if (tag === 7) break;
            if (tag === 0 || tag === 3 || tag === 1) {
                const pair = tag === 1;
                if (channel + (pair ? 2 : 1) > channels)
                    throw new DecodeError('ALAC frame has more channels than configured');
                const count = this.decodeElement(pair, bitDepth);
                if (frames >= 0 && count !== frames)
                    throw new DecodeError('ALAC elements disagree on the frame length');
                frames = count;
                planes[order[channel]!] = this.output(this.mixU, count);
                if (pair) planes[order[channel + 1]!] = this.output(this.mixV, count);
                channel += pair ? 2 : 1;
            } else if (tag === 4) {
                reader.read(4);
                const aligned = reader.read(1);
                let count = reader.read(8);
                if (count === 255) count += reader.read(8);
                if (aligned) reader.align();
                reader.skip(count * 8);
            } else if (tag === 6) {
                let count = reader.read(4);
                if (count === 15) count += reader.read(8) - 1;
                reader.skip(count * 8);
            } else throw new DecodeError(`ALAC element ${tag} is not supported`);

            if (channel === channels) break;
        }

        if (frames < 0) throw new DecodeError('ALAC frame has no audio elements');
        for (let index = 0; index < channels; index++) planes[index] ??= new Float32Array(frames);
        return planes as Float32Array[];
    }

    /**
     * Samples wrap to the bit depth, as the reference decoders store them (stereo decorrelation can
     * overflow it).
     */
    private output(samples: Int32Array, frames: number): Float32Array {
        const plane = new Float32Array(frames);
        const scale = this.scale;
        const shift = 32 - this.config.bitDepth;
        for (let index = 0; index < frames; index++)
            plane[index] = ((samples[index]! << shift) >> shift) * scale;
        return plane;
    }

    private readParameters(target: ChannelParameters): void {
        const reader = this.reader;
        let byte = reader.read(8);
        target.mode = byte >> 4;
        target.denominatorShift = byte & 15;
        byte = reader.read(8);
        target.multiplierFactor = byte >> 5;
        target.order = byte & 31;
        for (let index = 0; index < target.order; index++)
            target.coefficients[index] = (reader.read(16) << 16) >> 16;
    }

    private restore(
        parameters: ChannelParameters,
        output: Int32Array,
        frames: number,
        sampleBits: number,
    ): void {
        const { riceHistoryMultiplier, riceInitialHistory, riceLimit } = this.config;
        decodeResiduals(
            this.reader,
            this.residuals,
            frames,
            sampleBits,
            Math.floor((riceHistoryMultiplier * parameters.multiplierFactor) / 4),
            riceInitialHistory,
            riceLimit,
        );
        if (parameters.mode !== 0)
            predict(
                this.residuals,
                this.residuals,
                frames,
                parameters.coefficients,
                31,
                sampleBits,
                0,
            );
        predict(
            this.residuals,
            output,
            frames,
            parameters.coefficients,
            parameters.order,
            sampleBits,
            parameters.denominatorShift,
        );
    }

    /**
     * Decodes a single-channel (SCE/LFE) or channel-pair (CPE) element into mixU (and mixV);
     * returns its length.
     */
    private decodeElement(pair: boolean, bitDepth: number): number {
        const reader = this.reader;
        reader.read(4);
        if (reader.read(12) !== 0)
            throw new DecodeError('ALAC element header has reserved bits set');
        const flags = reader.read(4);
        const partial = flags >> 3;
        let bytesShifted = (flags >> 1) & 3;
        if (bytesShifted === 3)
            throw new DecodeError('ALAC element shifts out more than two bytes');
        const escape = flags & 1;
        let frames = this.config.frameLength;
        if (partial) frames = reader.read(32);
        if (frames < 1 || frames > this.config.frameLength)
            throw new DecodeError('ALAC frame length exceeds the configuration');
        let mixBits = 0;
        let mixRes = 0;
        if (!escape) {
            const sampleBits = bitDepth - bytesShifted * 8 + (pair ? 1 : 0);
            if (sampleBits > 32)
                throw new DecodeError('ALAC element needs more than 32 bits per predicted sample');
            mixBits = reader.read(8);
            mixRes = (reader.read(8) << 24) >> 24;
            this.readParameters(this.parameters[0]);
            if (pair) this.readParameters(this.parameters[1]);
            let shiftStart = 0;
            if (bytesShifted) {
                shiftStart = reader.position;
                reader.skip(bytesShifted * 8 * frames * (pair ? 2 : 1));
            }

            this.restore(this.parameters[0], this.mixU, frames, sampleBits);
            if (pair) this.restore(this.parameters[1], this.mixV, frames, sampleBits);
            if (bytesShifted) {
                const end = reader.position;
                reader.position = shiftStart;
                const bits = bytesShifted * 8;
                const total = frames * (pair ? 2 : 1);
                for (let index = 0; index < total; index++) this.shifted[index] = reader.read(bits);
                reader.position = end;
            }
        } else {
            const shift = 32 - bitDepth;
            for (let index = 0; index < frames; index++) {
                this.mixU[index] = (reader.read(bitDepth) << shift) >> shift;
                if (pair) this.mixV[index] = (reader.read(bitDepth) << shift) >> shift;
            }
            bytesShifted = 0;
        }

        const u = this.mixU;
        const v = this.mixV;
        if (pair && mixRes !== 0) {
            for (let index = 0; index < frames; index++) {
                const left =
                    (u[index]! + v[index]! - (Math.imul(mixRes, v[index]!) >> mixBits)) | 0;
                v[index] = (left - v[index]!) | 0;
                u[index] = left;
            }
        }

        if (bytesShifted) {
            const bits = bytesShifted * 8;
            const shifted = this.shifted;
            const stride = pair ? 2 : 1;
            for (let index = 0; index < frames; index++) {
                u[index] = (u[index]! << bits) | shifted[index * stride]!;
                if (pair) v[index] = (v[index]! << bits) | shifted[index * stride + 1]!;
            }
        }

        return frames;
    }
}

/**
 * Built-in ALAC decoding of MP4, CAF or Matroska packets; the magic cookie must match the track.
 */
export function alacAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    if (!track.codecConfig)
        throw new MediaForgeError('ALAC track carries no magic cookie', 'FORMAT');
    const config = parseAlacConfig(track.codecConfig);
    if (config.channels !== track.channelCount)
        throw new MediaForgeError(
            'ALAC magic cookie and track disagree on the channel count',
            'FORMAT',
        );
    return {
        channelMask: ELEMENT_ORDER_MASKS[config.channels - 1],
        create: () => {
            const decoder = new AlacDecoder(config);
            return { decode: packet => [decoder.decode(packet)], reset() {} };
        },
    };
}
