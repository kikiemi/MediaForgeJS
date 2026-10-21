import { u32le } from '../../bytes/byte-fields';
/**
 * SMPTE 331M AES3 sound element: a four-byte header, then 32-bit subframes of eight channels per
 * sample.
 */
export interface Aes3Unwrap {
    /** Channels kept from the eight stored subframes. */
    readonly channels: number;
    /** Output bytes per sample: 2 (16-bit) or 3 (24-bit), little-endian signed PCM. */
    readonly bytesPerSample: 2 | 3;
}

const AES3_HEADER_BYTES = 4;
const AES3_STORED_CHANNELS = 8;

/**
 * Unwraps AES3 subframes (audio in bits 4-27) to interleaved little-endian PCM of the leading
 * channels.
 */
export function unwrapAes3(data: Uint8Array, layout: Aes3Unwrap): Uint8Array {
    const frames = Math.floor((data.length - AES3_HEADER_BYTES) / (AES3_STORED_CHANNELS * 4));
    const channels = Math.min(Math.max(layout.channels, 1), AES3_STORED_CHANNELS);
    const out = new Uint8Array(Math.max(0, frames) * channels * layout.bytesPerSample);
    let at = 0;
    for (let frame = 0; frame < frames; frame++) {
        const base = AES3_HEADER_BYTES + frame * AES3_STORED_CHANNELS * 4;
        for (let channel = 0; channel < channels; channel++) {
            const offset = base + channel * 4;
            const word = u32le(data, offset);
            if (layout.bytesPerSample === 3) {
                const sample = (word >>> 4) & 0xffffff;
                out[at++] = sample & 0xff;
                out[at++] = (sample >>> 8) & 0xff;
                out[at++] = (sample >>> 16) & 0xff;
            } else {
                const sample = (word >>> 12) & 0xffff;
                out[at++] = sample & 0xff;
                out[at++] = (sample >>> 8) & 0xff;
            }
        }
    }
    return out;
}
