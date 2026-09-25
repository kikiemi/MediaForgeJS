import { annexBToAvcc, isAnnexB } from './annexb.js';
import { MediaForgeError } from './errors.js';
import { isProResCodec, restoreProResFrame } from './prores.js';
export function normalizeVideoPacket(data, codec, codecConfig, nalUnitFormat, proResHeaderless = false) {
    if (proResHeaderless) {
        if (!isProResCodec(codec))
            throw new MediaForgeError('Headerless ProRes packet requires a ProRes track', 'DEMUX');
        return restoreProResFrame(data);
    }
    if (nalUnitFormat !== 'annexb')
        return data;
    if (!/^(avc|hev1|hvc1)/.test(codec) || !isAnnexB(data))
        throw new MediaForgeError('Invalid Annex B video packet', 'DEMUX');
    const lengthByte = codecConfig?.[codec.startsWith('avc') ? 4 : 21];
    const lengthSize = (lengthByte === undefined ? 4 : (lengthByte & 3) + 1);
    return annexBToAvcc(data, lengthSize);
}
