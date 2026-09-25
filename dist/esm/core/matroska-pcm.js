import { MediaForgeError } from './errors.js';
import { describePcmTrack } from './pcm-format.js';
export function describeMatroskaPcm(track) {
    if (track.codec !== 'pcm' && !track.codec.startsWith('pcm-'))
        return undefined;
    const format = describePcmTrack(track);
    if ((format.bitsPerSample === 8 && format.signed) ||
        (format.float && !format.littleEndian) ||
        format.validBitsPerSample !== format.bitsPerSample ||
        (format.channelMask !== undefined &&
            format.channelMask !== 0 &&
            format.channelMask !== (format.channels === 1 ? 4 : format.channels === 2 ? 3 : -1))) {
        throw new MediaForgeError('Matroska PCM cannot preserve this signedness, byte order, precision or channel layout', 'FORMAT');
    }
    return {
        ...format,
        codecId: format.float ? 'A_PCM/FLOAT/IEEE' : format.littleEndian ? 'A_PCM/INT/LIT' : 'A_PCM/INT/BIG',
    };
}
export function matroskaPcmCodec(codecId, bits) {
    if (!['A_PCM/INT/LIT', 'A_PCM/INT/BIG', 'A_PCM/FLOAT/IEEE'].includes(codecId))
        return undefined;
    const float = codecId === 'A_PCM/FLOAT/IEEE';
    if (!(float ? [32, 64] : [8, 16, 24, 32]).includes(bits)) {
        throw new MediaForgeError('Matroska PCM requires a supported explicit BitDepth', 'DEMUX');
    }
    return bits === 8 ? 'pcm-u8' : `pcm-${float ? 'f' : 's'}${bits}${codecId === 'A_PCM/INT/BIG' ? 'be' : 'le'}`;
}
