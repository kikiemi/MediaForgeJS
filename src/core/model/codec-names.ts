/**
 * Everyday video codec names and the codec family strings the writers and WebCodecs use for them.
 */
const VIDEO_NAMES: Readonly<Record<string, string>> = {
    h264: 'avc1',
    'h.264': 'avc1',
    avc: 'avc1',
    x264: 'avc1',
    h265: 'hvc1',
    'h.265': 'hvc1',
    hevc: 'hvc1',
    x265: 'hvc1',
    vp9: 'vp09',
    av1: 'av01',
};

/** Everyday audio codec names and the codec strings the writers and WebCodecs use for them. */
const AUDIO_NAMES: Readonly<Record<string, string>> = {
    aac: 'mp4a.40.2',
    'aac-lc': 'mp4a.40.2',
    ac3: 'ac-3',
    eac3: 'ec-3',
    'e-ac-3': 'ec-3',
    mulaw: 'ulaw',
    'mu-law': 'ulaw',
    'µ-law': 'ulaw',
    'a-law': 'alaw',
};

/**
 * av01.P.LLT.DD with the optional .M.CCC.cp.tc.mc.F of the AV1 codec string (P profile, LL level, T
 * tier).
 */
const AV01_CODEC = new RegExp(
    String.raw`^av01(?:\.([0-2])\.(0\d|1\d|2[0-3])([MH])\.(08|10|12)` +
        String.raw`(?:\.([01])\.([01])([01])([0-9])\.\d{2}\.\d{2}\.(\d{2})\.([01]))?)?$`,
);

/**
 * The codec string for a video codec name such as 'h264', 'hevc', 'vp9' or 'av1'; other values are
 * returned as given.
 */
export function canonicalVideoCodec(name: string): string {
    return VIDEO_NAMES[name.trim().toLowerCase()] ?? name;
}

/**
 * The codec string for an audio codec name such as 'aac' or 'ac3'; other values are returned as
 * given.
 */
export function canonicalAudioCodec(name: string): string {
    return AUDIO_NAMES[name.trim().toLowerCase()] ?? name;
}

/** A short everyday name for a codec string: 'avc1.640028' is 'h264', 'mp4a.40.2' is 'aac'. */
export function codecDisplayName(codec: string): string {
    const value = codec.toLowerCase();
    if (value.startsWith('avc')) return 'h264';
    if (value.startsWith('hvc1') || value.startsWith('hev1')) return 'hevc';
    if (value.startsWith('vp09') || value === 'vp9') return 'vp9';
    if (value.startsWith('vp08') || value === 'vp8') return 'vp8';
    if (value.startsWith('av01')) return 'av1';
    if (value.startsWith('mp4a.40') || value === 'aac') return 'aac';
    if (value === 'mp4a.6b' || value === 'mp4a.69' || value === 'mp3') return 'mp3';
    return codec;
}

const VP9_LEVELS = new Set([
    '00',
    '10',
    '11',
    '20',
    '21',
    '30',
    '31',
    '40',
    '41',
    '50',
    '51',
    '52',
    '60',
    '61',
    '62',
]);

/** A codec string with its family folded to lower case: 'AVC1.64001F' is 'avc1.64001F'. */
export const foldCodecString = (s: string): string => {
    const dot = s.indexOf('.');
    return dot < 0 ? s.toLowerCase() : s.slice(0, dot).toLowerCase() + s.slice(dot);
};

/** vp09.PP.LL.DD with the optional chroma, colour and range fields of the VP9 codec string. */
const VP09_CODEC = new RegExp(
    String.raw`^vp09(?:\.(0[0-3])\.(\d{2})\.(08|10|12)` +
        String.raw`(?:\.(0[0-3])\.\d{2}\.\d{2}\.(\d{2})\.(0[01]))?)?$`,
);
/** hvc1/hev1 with profile, compatibility flags, tier and level, and up to six constraint bytes. */
const HEVC_CODEC = new RegExp(
    String.raw`^(hvc1|hev1)(\.[A-Ca-c]?\d{1,3}\.[0-9a-fA-F]{1,8}\.[LH]\d{1,3}` +
        String.raw`(\.[0-9a-fA-F]{1,2}){0,6})?$`,
);

/**
 * Whether `value` (folded) names an audio or video codec: a family name or a complete, consistent
 * codec string.
 */
export const isCodecString = (kind: 'audio' | 'video', value: string): boolean => {
    if (kind === 'audio') {
        return (
            /^(aac|mp3|mp2|mp1|opus|vorbis|flac|pcm|ulaw|alaw|ac-3|ec-3)$/.test(value) ||
            /^mp4a(\.[0-9a-fA-F]{1,2}(\.\d{1,3})?)?$/.test(value)
        );
    }

    if (/^(vp8|vp9)$/.test(value)) return true;
    if (/^(avc1|avc3)(\.[0-9a-fA-F]{6})?$/.test(value)) return true;
    const vp09Match = VP09_CODEC.exec(value);
    if (vp09Match) {
        if (!vp09Match[1]) return true;
        if (!VP9_LEVELS.has(vp09Match[2]!)) return false;
        const vpProfile = vp09Match[1];
        const vpDepth = vp09Match[3]!;
        if ((vpProfile === '00' || vpProfile === '01') && vpDepth !== '08') return false;
        if ((vpProfile === '02' || vpProfile === '03') && vpDepth === '08') return false;
        const vpChroma = vp09Match[4] ?? '01';
        const vpMatrix = vp09Match[5] ?? '01';
        if ((vpProfile === '00' || vpProfile === '02') && vpChroma !== '00' && vpChroma !== '01')
            return false;
        if ((vpProfile === '01' || vpProfile === '03') && vpChroma !== '02' && vpChroma !== '03')
            return false;
        if (vpMatrix === '00' && vpChroma !== '03') return false;
        return true;
    }

    const av01Match = AV01_CODEC.exec(value);
    if (av01Match) {
        if (!av01Match[1]) return true;
        const avProfile = av01Match[1];
        const avLevel = Number(av01Match[2]);
        const avTier = av01Match[3]!;
        const avDepth = av01Match[4]!;
        if (avTier === 'H' && avLevel <= 7) return false;
        if (avDepth === '12' && avProfile !== '2') return false;

        const mono = av01Match[5] ?? '0';
        const subX = av01Match[6] ?? '1';
        const subY = av01Match[7] ?? '1';
        const pos = av01Match[8] ?? '0';
        const matrix = av01Match[9] ?? '01';

        if (pos !== '0' && pos !== '1' && pos !== '2') return false;
        if ((subX !== '1' || subY !== '1') && pos !== '0') return false;
        if (mono === '1') {
            if (avProfile === '1') return false;
            if (subX !== '1' || subY !== '1') return false;
            if (pos !== '0') return false;
        } else if (avProfile === '0') {
            if (subX !== '1' || subY !== '1') return false;
        } else if (avProfile === '1') {
            if (subX !== '0' || subY !== '0') return false;
        } else if (avDepth !== '12') {
            if (subX !== '1' || subY !== '0') return false;
        } else if (subX === '0' && subY === '1') return false;

        if (matrix === '00' && (subX !== '0' || subY !== '0' || mono === '1')) return false;
        return true;
    }

    if (HEVC_CODEC.test(value)) return true;
    return false;
};
