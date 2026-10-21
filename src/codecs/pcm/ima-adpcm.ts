import { DecodeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec } from '../../core/contracts/decoder';

/** Bytes of one channel's block of Apple IMA4 ('ima4'): a 2-byte header and 64 nibbles. */
const IMA4_BLOCK_BYTES = 34;

/** Samples of one channel in an IMA4 block. */
const IMA4_BLOCK_SAMPLES = 64;

/** The step sizes of IMA ADPCM, by step index. */
const STEPS = Int16Array.from([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
    80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
    544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
    2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);

/** How each nibble moves the step index. */
const INDEX_STEPS = Int8Array.of(-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8);

/** The predictor and step index a channel carries from one block to the next. */
export interface Ima4Channel {
    predictor: number;
    index: number;
}

/** A channel's state before its first block. */
export const ima4Channel = (): Ima4Channel => ({ predictor: 0, index: 0 });

function expand(state: Ima4Channel, nibble: number): number {
    const step = STEPS[state.index]!;
    let diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    const predicted = nibble & 8 ? state.predictor - diff : state.predictor + diff;
    state.predictor = predicted < -32768 ? -32768 : predicted > 32767 ? 32767 : predicted;
    const index = state.index + INDEX_STEPS[nibble]!;
    state.index = index < 0 ? 0 : index > 88 ? 88 : index;
    return state.predictor;
}

/**
 * Decodes Apple IMA4 blocks into planar float PCM scaled by 1/32768. A packet holds whole frames,
 * each one block per channel in channel order; a block header states the top nine bits of its
 * predictor and its step index. A header that continues the channel (the same step index, a
 * predictor within its 128-step precision) keeps the channel's full predictor, as Apple's decoder
 * and ffmpeg's do, so the output is exact.
 */
export function decodeIma4(packet: Uint8Array, channels: readonly Ima4Channel[]): Float32Array[] {
    const frameBytes = IMA4_BLOCK_BYTES * channels.length;
    if (packet.length % frameBytes)
        throw new DecodeError('IMA4 packet ends inside a block of its channels');
    const frames = packet.length / frameBytes;
    const planes = channels.map(() => new Float32Array(frames * IMA4_BLOCK_SAMPLES));
    for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels.length; channel++) {
            const at = (frame * channels.length + channel) * IMA4_BLOCK_BYTES;
            const state = channels[channel]!;
            const header = (packet[at]! << 8) | packet[at + 1]!;
            const predictor = ((header & 0xff80) << 16) >> 16;
            const index = header & 0x7f;
            if (index !== state.index || Math.abs(predictor - state.predictor) > 0x7f) {
                state.index = index;
                state.predictor = predictor;
            }
            if (state.index > 88)
                throw new DecodeError(`IMA4 step index ${state.index} is over 88`);
            const plane = planes[channel]!;
            let out = frame * IMA4_BLOCK_SAMPLES;
            for (let byte = at + 2; byte < at + IMA4_BLOCK_BYTES; byte++) {
                const value = packet[byte]!;
                plane[out++] = expand(state, value & 0x0f) / 32768;
                plane[out++] = expand(state, value >> 4) / 32768;
            }
        }
    }
    return planes;
}

/** The built-in decoder of an Apple IMA4 track ('ima4'), whose state runs across packets. */
export function ima4AudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const count = track.channelCount;
    return {
        create: () => {
            let channels = Array.from({ length: count }, ima4Channel);
            return {
                decode: packet => [decodeIma4(packet, channels)],
                reset() {
                    channels = Array.from({ length: count }, ima4Channel);
                },
            };
        },
    };
}
