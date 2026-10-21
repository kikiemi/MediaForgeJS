import { annexBToAvcc, isAnnexB, isValidAvccWalk, isValidHevcWalk } from './annexb';
import { isVvcCodec, parseVvcC } from './vvc';
import { MediaForgeError } from '../../errors/errors';
import { restoreProResFrame } from './prores';
import { isProResCodec } from '../../model/codec-strings';

export function normalizeVideoPacket(
    data: Uint8Array,
    codec: string,
    codecConfig: Uint8Array | undefined,
    nalUnitFormat: 'annexb' | 'avcc' | undefined,
    proResHeaderless = false,
): Uint8Array {
    if (proResHeaderless) {
        if (!isProResCodec(codec))
            throw new MediaForgeError('Headerless ProRes packet requires a ProRes track', 'DEMUX');
        return restoreProResFrame(data);
    }
    if (nalUnitFormat !== 'annexb') return data;
    if (!/^(avc|hev1|hvc1|dvh1|dvhe|vvc1|vvi1)/.test(codec) || !isAnnexB(data))
        throw new MediaForgeError('Invalid Annex B video packet', 'DEMUX');
    return annexBToAvcc(data, nalLengthSize(codec, codecConfig));
}

/**
 * True when a packet of a length-prefixed H.264, HEVC or VVC track holds Annex B start codes
 * instead, as some MP4 writers store them: its bytes do not walk as NAL lengths, and ffmpeg's
 * decoder reads them as Annex B.
 */
export function holdsAnnexB(
    data: Uint8Array,
    codec: string,
    codecConfig: Uint8Array | undefined,
): boolean {
    if (
        data.length < 4 ||
        data[0] !== 0 ||
        data[1] !== 0 ||
        (data[2] !== 1 && (data[2] !== 0 || data[3] !== 1))
    )
        return false;
    if (!/^(avc|hev1|hvc1|dvh1|dvhe|vvc1|vvi1)/.test(codec)) return false;
    const size = nalLengthSize(codec, codecConfig);
    return (
        !(codec.startsWith('avc') ? isValidAvccWalk : isValidHevcWalk)(data, size) && isAnnexB(data)
    );
}

/** NAL length field width declared by an avcC, hvcC or vvcC record; four bytes when unknown. */
export function nalLengthSize(codec: string, codecConfig: Uint8Array | undefined): 1 | 2 | 3 | 4 {
    if (isVvcCodec(codec)) return (codecConfig && parseVvcC(codecConfig)?.lengthSize) ?? 4;
    const lengthByte = codecConfig?.[codec.startsWith('avc') ? 4 : 21];
    return (lengthByte === undefined ? 4 : (lengthByte & 3) + 1) as 1 | 2 | 3 | 4;
}
