export function webCodecsAudioCodec(codec) {
    return codec === 'mp2' || codec === 'mp1' ? 'mp3' : codec;
}
export function codecFamily(codec) {
    if (codec === 'aac')
        return 'mp4a';
    if (codec.startsWith('avc'))
        return 'avc';
    if (codec.startsWith('hvc'))
        return 'hvc1';
    if (codec.startsWith('hev'))
        return 'hev1';
    if (codec.startsWith('av01'))
        return 'av01';
    if (codec.startsWith('vp09') || codec.startsWith('vp9'))
        return 'vp09';
    if (codec.startsWith('mp4a'))
        return 'mp4a';
    return codec;
}
export function mp4aAudioObjectType(codec) {
    const match = /^mp4a\.40\.(\d+)$/i.exec(codec.trim());
    if (!match)
        return null;
    const value = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}
