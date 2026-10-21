export function webCodecsAudioCodec(codec: string): string {
    return codec === 'mp2' || codec === 'mp1' ? 'mp3' : codec;
}

export type MpegVideoFamily = 'mpeg1v' | 'mpeg2v' | 'mpeg4v';

/**
 * MPEG-4 systems object type of an MPEG video codec string: 0x20 Part 2, 0x60-0x65 MPEG-2 profiles,
 * 0x6a MPEG-1.
 */
export function mpegVideoObjectType(codec: string): number | null {
    const match = /^mp4v(?:\.([0-9a-f]{2})(?=\.|$)|$)/i.exec(codec);
    if (!match) return null;
    const value = match[1] === undefined ? 0x20 : Number.parseInt(match[1], 16);
    return value === 0x20 || value === 0x6a || (value >= 0x60 && value <= 0x65) ? value : null;
}

export function mpegVideoFamily(codec: string): MpegVideoFamily | null {
    const type = mpegVideoObjectType(codec);
    return type === null ? null : type === 0x20 ? 'mpeg4v' : type === 0x6a ? 'mpeg1v' : 'mpeg2v';
}

export function codecFamily(codec: string): string {
    const mpegVideo = mpegVideoFamily(codec);
    if (mpegVideo) return mpegVideo;
    if (codec === 'aac') return 'mp4a';
    if (codec.startsWith('avc')) return 'avc';
    if (codec.startsWith('hvc')) return 'hvc1';
    if (codec.startsWith('hev')) return 'hev1';
    if (codec.startsWith('av01')) return 'av01';
    if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'vp09';
    if (codec.startsWith('mp4a')) return 'mp4a';
    return codec;
}

/**
 * True for audio whose packets depend on earlier ones except at keyframes, where copies start
 * and which MP4 marks as sync samples: xHE-AAC (USAC), whose keyframes are its immediate playout
 * frames (the first bit, usacIndependencyFlag, set).
 */
export function audioHasKeyframes(codec: string): boolean {
    return mp4aAudioObjectType(codec) === 42;
}

export function mp4aAudioObjectType(codec: string): number | null {
    const match = /^mp4a\.40\.(\d+)$/i.exec(codec.trim());
    if (!match) return null;
    const value = Number.parseInt(match[1]!, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * RFC 6381 codec strings of DTS: core only, core with an extension substream, lossless (XLL) and
 * Express (LBR).
 */
export type DtsCodec = 'dtsc' | 'dtsh' | 'dtsl' | 'dtse';

export function isDtsCodec(codec: string): codec is DtsCodec {
    return codec === 'dtsc' || codec === 'dtsh' || codec === 'dtsl' || codec === 'dtse';
}

/**
 * True for the PCM codec IDs: the explicit 'pcm-s16le', 'pcm-f32be', ... and 'pcm', which is 16-bit
 * little-endian PCM in the default layout of its WAVE description.
 */
export function isPcmCodec(codec: string): boolean {
    return codec === 'pcm' || codec.startsWith('pcm-');
}

/** Apple ProRes 422 and 4444 codec strings (not ProRes RAW). */
export function isProResCodec(codec: string): boolean {
    return /^ap(?:co|cs|cn|ch|4h|4x)$/.test(codec);
}

/** HEVC codec strings in every spelling this library uses, including Dolby Vision base layers. */
export function isHevcCodec(codec: string): boolean {
    return /^(hvc1|hev1|dvh1|dvhe)/i.test(codec);
}
