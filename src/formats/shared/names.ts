/** Spellings accepted for formats; the canonical name is what the writers are registered under. */
export const formatAliases: Readonly<Record<string, string>> = {
    matroska: 'mkv',
    mpegts: 'ts',
    m2ts: 'ts',
    mts: 'ts',
    wave: 'wav',
    aif: 'aiff',
    aifc: 'aiff',
    snd: 'au',
    oga: 'ogg',
    opus: 'ogg',
    qt: 'mov',
    quicktime: 'mov',
    adts: 'aac',
    m4b: 'm4a',
    mpeg4: 'mp4',
    fragmented: 'fmp4',
    jpg: 'jpeg',
    jpe: 'jpeg',
    tif: 'tiff',
    m3u8: 'hls',
    mpd: 'dash',
    'dash+hls': 'hls+dash',
};

/** Format names that name their audio codec as well: 'opus' is Ogg that holds Opus only. */
const CODEC_NAMES: Readonly<Record<string, string>> = { opus: 'opus' };

const folded = (value: string): string => value.trim().toLowerCase().replace(/^\./, '');

/** Lower-cased, trimmed format name with a leading dot removed and aliases resolved. */
export function canonicalFormat(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = folded(value);
    return formatAliases[name] ?? name;
}

/** The audio codec a format name requires (Opus for 'opus'), or undefined for other names. */
export function formatAudioCodec(value: unknown): string | undefined {
    return typeof value === 'string' ? CODEC_NAMES[folded(value)] : undefined;
}
