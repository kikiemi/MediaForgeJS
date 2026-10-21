import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { describePcmTrack, type PcmFormat } from '../../core/codec-config/audio/pcm-format';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec } from '../../core/contracts/decoder';

export const MAX_PCM_PACKET_BYTES = 64 * 1024 * 1024;

export function* decodePcmPacket(
    bytes: Uint8Array,
    format: PcmFormat,
    signal?: AbortSignal,
): Iterable<Float32Array[]> {
    const { channels, blockAlign, bitsPerSample, float, signed, littleEndian } = format;
    const width = bitsPerSample / 8;
    if (bytes.byteLength > MAX_PCM_PACKET_BYTES || bytes.byteLength % blockAlign !== 0)
        throw new MediaForgeError('PCM decoding requires bounded complete sample frames', 'DECODE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const packetFrames = bytes.byteLength / blockAlign;
    for (let start = 0; start < packetFrames; start += 16384) {
        throwIfAborted(signal);
        const frames = Math.min(16384, packetFrames - start);
        const planes: Float32Array[] = [];
        for (let channel = 0; channel < channels; channel++) {
            const plane = new Float32Array(frames);
            let at = start * blockAlign + channel * width;
            if (float) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign) {
                    const value = Math.fround(
                        bitsPerSample === 64
                            ? view.getFloat64(at, littleEndian)
                            : view.getFloat32(at, littleEndian),
                    );
                    if (!Number.isFinite(value))
                        throw new MediaForgeError('PCM contains nonfinite samples', 'DECODE');
                    plane[frame] = value;
                }
            } else if (bitsPerSample === 16) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = view.getInt16(at, littleEndian) / 32768;
            } else if (bitsPerSample === 8) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = signed ? view.getInt8(at) / 128 : (bytes[at]! - 128) / 128;
            } else if (bitsPerSample === 24) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign) {
                    const raw = littleEndian
                        ? bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
                        : bytes[at + 2]! | (bytes[at + 1]! << 8) | (bytes[at]! << 16);
                    plane[frame] = ((raw << 8) >> 8) / 8388608;
                }
            } else {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = view.getInt32(at, littleEndian) / 2147483648;
            }

            planes.push(plane);
        }

        yield planes;
    }

    throwIfAborted(signal);
}

/** Built-in linear PCM decoding for every storage layout describePcmTrack accepts. */
export function pcmAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const format = describePcmTrack(track);
    return {
        ...(format.channelMask ? { channelMask: format.channelMask } : {}),
        create: () => ({ decode: packet => decodePcmPacket(packet, format), reset() {} }),
    };
}
