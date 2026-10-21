import { DecodeError, MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec } from '../../core/contracts/decoder';
import { quantizeSample } from '../../core/model/pcm-quantize';

/** G.711 companding (ITU-T G.711): one code byte per sample, expanded to 16-bit linear PCM. */
export type G711Codec = 'ulaw' | 'alaw';

function mulawToLinear(code: number): number {
    const value = ~code & 0xff;
    const magnitude = (((value & 0x0f) << 3) + 0x84) << ((value & 0x70) >> 4);
    return value & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
}

function alawToLinear(code: number): number {
    const value = code ^ 0x55;
    const segment = (value & 0x70) >> 4;
    const step = value & 0x0f;
    const magnitude = segment ? (step * 2 + 33) << (segment + 2) : (step * 2 + 1) << 3;
    return value & 0x80 ? magnitude : -magnitude;
}

function expansionTable(expand: (code: number) => number): Int16Array {
    return Int16Array.from({ length: 256 }, (_, code) => expand(code));
}

/**
 * Nearest code for each 14-bit linear value, as common G.711 encoders build it from the expansion
 * table.
 */
function compressionTable(expand: (code: number) => number, mask: number): Uint8Array {
    const table = new Uint8Array(16384);
    table[8192] = mask;
    let step = 1;
    for (let code = 0; code < 127; code++) {
        const edge = (expand(code ^ mask) + expand((code + 1) ^ mask) + 4) >> 3;
        for (; step < edge; step++) {
            table[8192 - step] = code ^ (mask ^ 0x80);
            table[8192 + step] = code ^ mask;
        }
    }
    for (; step < 8192; step++) {
        table[8192 - step] = 127 ^ (mask ^ 0x80);
        table[8192 + step] = 127 ^ mask;
    }
    table[0] = table[1]!;
    return table;
}

const FLOAT = {
    ulaw: Float32Array.from(expansionTable(mulawToLinear), value => value / 32768),
    alaw: Float32Array.from(expansionTable(alawToLinear), value => value / 32768),
};
let compression: { ulaw: Uint8Array; alaw: Uint8Array } | undefined;

/** The options of encodeG711() and decodeG711(). */
export interface G711Options {
    readonly codec: G711Codec;
    /** decodeG711() only: the channels interleaved in the bytes, 1 by default. */
    readonly channels?: number;
}

/** Expands interleaved code bytes into planar float PCM scaled by 1/32768. */
export function decodeG711(bytes: Uint8Array, options: G711Options): Float32Array[] {
    const { codec, channels = 1 } = options;
    checkG711(codec);
    if (!Number.isSafeInteger(channels) || channels < 1)
        throw new MediaForgeError(`G.711 needs a positive channel count, not ${channels}`, 'INPUT');
    const table = FLOAT[codec];
    const frames = Math.floor(bytes.length / channels);
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(frames);
        for (let frame = 0, at = channel; frame < frames; frame++, at += channels)
            plane[frame] = table[bytes[at]!]!;
        planes.push(plane);
    }
    return planes;
}

/**
 * Compresses planar float PCM into interleaved code bytes; samples are rounded to 16 bits and
 * clipped first.
 */
export function encodeG711(
    planes: readonly Float32Array[],
    options: G711Options,
): Uint8Array<ArrayBuffer> {
    const { codec } = options;
    checkG711(codec);
    compression ??= {
        ulaw: compressionTable(mulawToLinear, 0xff),
        alaw: compressionTable(alawToLinear, 0xd5),
    };
    const table = compression[codec];
    const channels = planes.length;
    const frames = planes[0]?.length ?? 0;
    const output = new Uint8Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
        const plane = planes[channel]!;
        for (let frame = 0, at = channel; frame < frames; frame++, at += channels) {
            output[at] = table[(quantizeSample(plane[frame]!, 16) + 32768) >> 2]!;
        }
    }
    return output;
}

export function isG711Codec(codec: string): codec is G711Codec {
    return codec === 'ulaw' || codec === 'alaw';
}

function checkG711(codec: string): void {
    if (!isG711Codec(codec))
        throw new MediaForgeError(
            `G.711 is 'ulaw' or 'alaw', not ${JSON.stringify(codec)}`,
            'INPUT',
        );
}

/** Built-in G.711 expansion of interleaved code bytes. */
export function g711AudioCodec(track: TrackInfo, codec: G711Codec): BuiltinAudioCodec {
    const channels = track.channelCount;
    return {
        create: () => ({
            decode(packet) {
                if (packet.length % channels)
                    throw new DecodeError('G.711 packet ends inside a sample frame');
                return [decodeG711(packet, { codec, channels })];
            },
            reset() {},
        }),
    };
}
