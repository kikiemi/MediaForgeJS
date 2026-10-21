/**
 * Codec strings of H.264 tracks the built-in decoder takes: avc1 or avc3, optionally with profile
 * and level.
 */
export function isH264Codec(codec: unknown): boolean {
    return typeof codec === 'string' && /^avc[13](\.[0-9a-f]{6})?$/i.test(codec);
}

/** MPEG-1 video (mp4v.6a) and MPEG-2 video (mp4v.60 to mp4v.65). */
export function isMpeg12VideoCodec(codec: unknown): boolean {
    return typeof codec === 'string' && /^mp4v\.6[0-5a]$/i.test(codec);
}

/** MPEG-4 Part 2 Visual (mp4v.20 with an optional profile) and H.263 (s263, h263). */
export function isMpeg4VisualCodec(codec: unknown): boolean {
    return (
        typeof codec === 'string' &&
        (/^mp4v\.20(\.\d{1,3})?$/i.test(codec) || /^(s263|h263)$/i.test(codec))
    );
}
