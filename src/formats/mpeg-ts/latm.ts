import { DemuxError } from '../../core/errors/errors';
import {
    AAC_GA_SPECIFIC_TYPES,
    parseAacAudioSpecificConfig,
} from '../../core/codec-config/audio/adts';

/**
 * Stream configuration of an AAC LATM stream (ISO/IEC 14496-3 1.7.3) with one program and one
 * layer.
 */
interface LatmStreamConfig {
    /** AudioSpecificConfig of the single layer, byte aligned with zero padding. */
    readonly config: Uint8Array;
    readonly audioObjectType: number;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly samplesPerAccessUnit: number;
}

/** Error-resilient object types, whose configuration ends with epConfig. */
const ER_TYPES = new Set([17, 19, 20, 21, 22, 23]);

/** syncExtensionType of an explicitly signalled SBR/PS extension after the core configuration. */
const SYNC_EXTENSION = 0x2b7;

/**
 * Total length of the LOAS AudioSyncStream frame at `offset`, its 3-byte header included; 0 without
 * a sync word.
 */
export function loasFrameLength(data: Uint8Array, offset: number): number {
    if (
        offset < 0 ||
        offset + 3 > data.length ||
        data[offset] !== 0x56 ||
        (data[offset + 1]! & 0xe0) !== 0xe0
    )
        return 0;
    const length = ((data[offset + 1]! & 0x1f) << 8) | data[offset + 2]!;
    return length > 0 ? 3 + length : 0;
}

class Bits {
    position: number;

    constructor(
        private readonly data: Uint8Array,
        start: number,
        private readonly end = data.length * 8,
    ) {
        this.position = start;
    }

    read(count: number): number {
        if (this.position + count > this.end)
            throw new DemuxError('LATM AudioMuxElement is truncated');
        let value = 0;
        for (let index = 0; index < count; index++, this.position++)
            value = value * 2 + ((this.data[this.position >> 3]! >> (7 - (this.position & 7))) & 1);
        return value;
    }

    skip(count: number): void {
        if (this.position + count > this.end)
            throw new DemuxError('LATM AudioMuxElement is truncated');
        this.position += count;
    }

    /** LatmGetValue: a 2-bit byte count minus one, then that many bytes. */
    value(): number {
        const bytes = this.read(2) + 1;
        let value = 0;
        for (let index = 0; index < bytes; index++) value = value * 256 + this.read(8);
        return value;
    }
}

function objectType(bits: Bits): number {
    const type = bits.read(5);
    return type === 31 ? 32 + bits.read(6) : type;
}

function skipFrequency(bits: Bits): void {
    if (bits.read(4) === 15) bits.skip(24);
}

/**
 * Reads past the core of one AudioSpecificConfig. Layouts given by a program config element, object
 * types without a GASpecificConfig and error protection configurations are refused, since their
 * extent cannot be established here.
 */
function skipAudioSpecificConfig(bits: Bits): void {
    let type = objectType(bits);
    skipFrequency(bits);
    const channelConfiguration = bits.read(4);
    if (type === 5 || type === 29) {
        skipFrequency(bits);
        type = objectType(bits);
    }
    if (!AAC_GA_SPECIFIC_TYPES.has(type))
        throw new DemuxError(`LATM AAC audio object type ${type} is not supported`);
    if (channelConfiguration === 0)
        throw new DemuxError(
            'LATM AAC channel layouts given by a program config element are not supported',
        );

    bits.skip(1);
    if (bits.read(1)) bits.skip(14);
    const extension = bits.read(1);
    if (type === 6 || type === 20) bits.skip(3);
    if (extension) {
        if (type === 22) bits.skip(16);
        if (type === 17 || type === 19 || type === 20 || type === 23) bits.skip(3);
        bits.skip(1);
    }
    if (ER_TYPES.has(type) && bits.read(2) >= 2)
        throw new DemuxError('LATM AAC error protection configurations are not supported');
}

/** `count` bits from bit `start` of `data` as bytes, the last one padded with zero bits. */
function copyBits(data: Uint8Array, start: number, count: number): Uint8Array {
    const out = new Uint8Array(Math.ceil(count / 8));
    const shift = start & 7;
    for (let index = 0, from = start >> 3; index < out.length; index++, from++)
        out[index] = shift
            ? ((data[from]! << shift) | ((data[from + 1] ?? 0) >> (8 - shift))) & 0xff
            : data[from]!;
    if (count & 7) out[out.length - 1]! &= 0xff << (8 - (count & 7));
    return out;
}

/**
 * AudioMuxElement reader for LOAS/LATM AAC with in-band configuration (muxConfigPresent 1). It
 * keeps the latest StreamMuxConfig and returns the payloads of each AudioSyncStream frame as raw
 * AAC access units. One program with one layer, frameLengthType 0 and all streams on the same time
 * framing are read, as broadcast streams use them.
 */
export class LatmReader {
    config: LatmStreamConfig | null = null;
    private subFrames = 0;

    /**
     * Access units of the AudioSyncStream frame `frame` (3-byte header included); none before the
     * first config.
     */
    read(frame: Uint8Array): Uint8Array[] {
        const bits = new Bits(frame, 24);
        if (!bits.read(1)) this.readStreamMuxConfig(frame, bits);
        if (!this.config) return [];
        const units: Uint8Array[] = [];
        for (let index = 0; index <= this.subFrames; index++) {
            let length = 0;
            let part: number;
            do {
                part = bits.read(8);
                length += part;
            } while (part === 255);
            if (length === 0) throw new DemuxError('LATM payload is empty');
            const start = bits.position;
            bits.skip(length * 8);
            units.push(copyBits(frame, start, length * 8));
        }
        return units;
    }

    private readStreamMuxConfig(frame: Uint8Array, bits: Bits): void {
        const version = bits.read(1);
        if (version && bits.read(1))
            throw new DemuxError('LATM audioMuxVersionA 1 is not supported');
        if (version) bits.value();
        if (!bits.read(1))
            throw new DemuxError('LATM streams with separate time framing are not supported');
        const subFrames = bits.read(6);
        if (bits.read(4) !== 0 || bits.read(3) !== 0)
            throw new DemuxError('LATM streams with several programs or layers are not supported');
        let config: Uint8Array;
        if (version) {
            const length = bits.value();
            const start = bits.position;
            const within = new Bits(frame, start, start + length);
            skipAudioSpecificConfig(within);

            // An explicit SBR/PS signal follows the core configuration inside the declared length.
            const core = within.position - start;
            const extended = length - core >= 16 && within.read(11) === SYNC_EXTENSION;
            bits.skip(length);
            config = copyBits(frame, start, extended ? length : core);
        } else {
            const start = bits.position;
            skipAudioSpecificConfig(bits);
            config = copyBits(frame, start, bits.position - start);
        }
        if (bits.read(3) !== 0)
            throw new DemuxError('LATM frame length types other than 0 are not supported');
        bits.skip(8);
        if (bits.read(1)) {
            if (version) bits.value();
            else {
                let escape: number;
                do {
                    escape = bits.read(1);
                    bits.skip(8);
                } while (escape);
            }
        }
        if (bits.read(1)) bits.skip(8);
        const parsed = parseAacAudioSpecificConfig(config);
        if (!parsed || parsed.channelCount === 0)
            throw new DemuxError('LATM AudioSpecificConfig is invalid');
        this.subFrames = subFrames;
        this.config = {
            config,
            audioObjectType: parsed.audioObjectType,
            sampleRate: parsed.sampleRate,
            channelCount: parsed.channelCount,
            samplesPerAccessUnit: parsed.samplesPerAccessUnit,
        };
    }
}
