/**
 * Audio that MP4-family output carries as the input stated it, without decoding it: MPEG-4 systems
 * object types other than AAC, MPEG audio, Dolby, DTS, Opus and Vorbis (EVRC, QCELP and any other
 * object type), written back with their object type and decoder-specific info, and MPEG-H 3D audio
 * with its configuration record, as ffmpeg copies them.
 */

/** Object types of 8 kHz mono speech codecs, named as ffmpeg names them. */
const NAMED_OBJECT_TYPES: ReadonlyMap<number, string> = new Map([
    [0xd1, 'evrc'],
    [0xe1, 'qcelp'],
]);

/** The codec name of an 'mp4a' entry's object type the library carries without decoding. */
export function carriedAudioCodec(objectType: number): string {
    return (
        NAMED_OBJECT_TYPES.get(objectType) ?? `mp4a-oti-${objectType.toString(16).padStart(2, '0')}`
    );
}

/** The object type an 'mp4a' entry states for a carried codec, or undefined for other codecs. */
export function carriedObjectType(codec: string): number | undefined {
    for (const [objectType, name] of NAMED_OBJECT_TYPES) if (name === codec) return objectType;
    const match = /^mp4a-oti-([0-9a-f]{2})$/.exec(codec);
    return match ? Number.parseInt(match[1]!, 16) : undefined;
}

/** Sample rate and channels a carried speech codec always has, whatever its sample entry states. */
export function carriedAudioShape(
    codec: string,
): { sampleRate: number; channelCount: number } | undefined {
    return NAMED_OBJECT_TYPES.has(carriedObjectType(codec) ?? -1)
        ? { sampleRate: 8000, channelCount: 1 }
        : undefined;
}

/**
 * True for MPEG-H 3D audio, its sample entry or its codec string ('mhm1.0x0D'): 'mha1' holds its
 * configuration, 'mhm1' streams it in band too.
 */
export function isMpegH(codec: string): boolean {
    return /^mh[am]1(\.|$)/.test(codec);
}
