import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { describeWrittenPcm, type PcmFormat } from '../../core/codec-config/audio/pcm-format';

// The PCM codec IDs of Matroska: how the reader names their samples and the writer states them.

/** The Matroska codec ID and samples of a PCM track the writer copies; undefined otherwise. */
export function describeMatroskaPcm(track: {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
}): (PcmFormat & { codecId: string }) | undefined {
    if (track.codec !== 'pcm' && !track.codec.startsWith('pcm-')) return undefined;
    const format = describeWrittenPcm(track);
    // Matroska states no speaker layout: readers take the default of the channel count, and the
    // copy planner reports another one lost (pcmLayoutLoss).
    if (
        (format.bitsPerSample === 8 && format.signed) ||
        (format.float && !format.littleEndian) ||
        format.validBitsPerSample !== format.bitsPerSample
    ) {
        throw new MediaForgeError(
            'Matroska PCM cannot preserve this signedness, byte order or precision',
            'FORMAT',
        );
    }

    return {
        ...format,
        codecId: format.float
            ? 'A_PCM/FLOAT/IEEE'
            : format.littleEndian
              ? 'A_PCM/INT/LIT'
              : 'A_PCM/INT/BIG',
    };
}

/**
 * G.711 in Matroska: A_MS/ACM whose WAVEFORMATEX has format tag 6 (A-law) or 7 (u-law) and 8-bit
 * samples.
 */
export function matroskaAcmCodec(
    codecId: string,
    config: Uint8Array | undefined,
): 'ulaw' | 'alaw' | undefined {
    if (codecId !== 'A_MS/ACM' || !config || config.length < 16) return undefined;
    const tag = config[0]! | (config[1]! << 8);
    const bits = config[14]! | (config[15]! << 8);
    if ((tag !== 6 && tag !== 7) || bits !== 8) return undefined;
    return tag === 6 ? 'alaw' : 'ulaw';
}

/** The codec of an A_PCM track of `bits` bits; undefined for other codec IDs. */
export function matroskaPcmCodec(codecId: string, bits: number): string | undefined {
    if (!['A_PCM/INT/LIT', 'A_PCM/INT/BIG', 'A_PCM/FLOAT/IEEE'].includes(codecId)) return undefined;
    const float = codecId === 'A_PCM/FLOAT/IEEE';
    if (!(float ? [32, 64] : [8, 16, 24, 32]).includes(bits)) {
        throw new DemuxError('Matroska PCM requires a supported explicit BitDepth');
    }
    return bits === 8
        ? 'pcm-u8'
        : `pcm-${float ? 'f' : 's'}${bits}${codecId === 'A_PCM/INT/BIG' ? 'be' : 'le'}`;
}
