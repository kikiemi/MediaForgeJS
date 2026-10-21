import type { TrackType } from '../../core/model/media';
import type { Sink } from '../../core/model/types';
import type { MuxerConfig } from '../../core/contracts/writer';
import { MediaForgeError } from '../../core/errors/errors';
import { isPcmCodec, mpegVideoFamily } from '../../core/model/codec-strings';
import {
    WINDOWS_MEDIA_AUDIO_CODECS,
    WINDOWS_MEDIA_VIDEO_CODECS,
} from '../../core/codec-config/windows-media';

/**
 * The ISO base media file formats; their 'mp4a' sample entry carries any MPEG-4 audio object type.
 */
export const MP4_FAMILY: ReadonlySet<string> = new Set(['mp4', 'mov', 'm4a', 'm4v', '3gp']);

/**
 * How a container is written into `sink`, the one rule of copies, conversions and encodes: MP4
 * whole (its index after the media) when the sink can patch, else in fragments; AVI whole; Matroska
 * as it goes, unless it holds several tracks of a kind or subtitles (`several`): then whole, with
 * Cues and its size where the sink can patch. The other writers write either the same way.
 */
export function containerLayout(format: string, sink: Sink, several = false): MuxerConfig['mode'] {
    if (format === 'avi' || (MP4_FAMILY.has(format) && sink.patchAt)) return 'standard';
    return (format === 'mkv' || format === 'webm') && several ? 'standard' : 'fragmented';
}

/**
 * True for ISO base media output, fragmented MP4 included: its user data carries a title and tags.
 */
export function isIsoOutput(format: string): boolean {
    return MP4_FAMILY.has(format) || format === 'fmp4';
}

/**
 * True when `format` stores track names, titles and default/forced/commentary flags, and a
 * container title.
 */
export function carriesTrackMetadata(format: string): boolean {
    return format === 'mkv' || format === 'webm' || isIsoOutput(format);
}

/**
 * Containers whose video track carries a display rotation, so rotating a copied track only rewrites
 * metadata.
 */
const ROTATION_FORMATS: ReadonlySet<string> = new Set(['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm']);

/** True when `format` stores a display rotation for its video track. */
export function carriesRotation(format: string): boolean {
    return ROTATION_FORMATS.has(format);
}

const MPEG_VIDEO = ['mpeg1v', 'mpeg2v', 'mpeg4v'];
const HEVC = ['hvc1', 'hev1'];
const DOLBY_VISION = ['dvh1', 'dvhe'];
const VVC = ['vvc1', 'vvi1'];

/** VP9, which the MP4 family holds in a 'vp09' sample entry with its vpcC record. */
const VP9 = ['vp9', 'vp09'];

/** APV, in an 'apv1' sample entry with its apvC record. */
const APV = 'apv1';
const VIDEO: Readonly<Record<string, readonly string[]>> = {
    mp4: [
        'avc1',
        'avc3',
        ...HEVC,
        ...DOLBY_VISION,
        ...VVC,
        'av01',
        ...VP9,
        APV,
        ...MPEG_VIDEO,
        'mjpeg',
    ],
    mov: [
        'avc1',
        'avc3',
        ...HEVC,
        ...DOLBY_VISION,
        ...VVC,
        'av01',
        ...VP9,
        APV,
        'apco',
        'apcs',
        'apcn',
        'apch',
        'ap4h',
        'ap4x',
        'aprn',
        'aprh',
        ...MPEG_VIDEO,
        'mjpeg',
    ],
    m4v: [
        'avc1',
        'avc3',
        ...HEVC,
        ...DOLBY_VISION,
        ...VVC,
        'av01',
        ...VP9,
        APV,
        ...MPEG_VIDEO,
        'mjpeg',
    ],
    '3gp': ['avc1', 'avc3', 'mpeg4v'],
    m4a: [],
    mkv: [
        'avc1',
        'avc3',
        ...HEVC,
        ...DOLBY_VISION,
        ...VVC,
        'av01',
        'vp8',
        'vp9',
        'vp09',
        'theora',
        'apco',
        'apcs',
        'apcn',
        'apch',
        'ap4h',
        'ap4x',
        ...MPEG_VIDEO,
        ...WINDOWS_MEDIA_VIDEO_CODECS,
        'dvvideo',
        'mjpeg',
    ],
    webm: ['av01', 'vp8', 'vp9', 'vp09'],
    ts: ['avc1', 'avc3', ...HEVC, ...VVC, 'av01', 'vc1', ...MPEG_VIDEO],
    flv: ['avc1', 'avc3', ...HEVC, 'av01'],
    avi: [
        'avc1',
        'avc3',
        ...HEVC,
        ...MPEG_VIDEO,
        ...WINDOWS_MEDIA_VIDEO_CODECS,
        'dvvideo',
        'mjpeg',
    ],
    ivf: ['av01', 'vp8', 'vp9', 'vp09'],
    iamf: [],
    apv: [APV],
};
const DTS = ['dtsc', 'dtsh', 'dtsl', 'dtse'];

/**
 * Audio MP4-family output carries as stated (mp4-carried-audio): speech object types, MPEG-H 3D
 * audio and IAMF.
 */
const CARRIED = ['evrc', 'qcelp', 'mhm1', 'mha1', 'iamf'];

/**
 * PCM of ISO/IEC 23003-5 ('ipcm' and 'fpcm' in MP4): 16-, 24- and 32-bit integers and 32- and
 * 64-bit floats.
 */
const ISO_PCM = ['s16', 's24', 's32', 'f32', 'f64'].flatMap(kind => [
    `pcm-${kind}le`,
    `pcm-${kind}be`,
]);

/** PCM QuickTime describes ('sowt', 'twos', 'raw ', 'in24', 'in32', 'fl32', 'fl64', 'lpcm'). */
const QUICKTIME_PCM = ['pcm', 'pcm-u8', 'pcm-s8', ...ISO_PCM];
const AUDIO: Readonly<Record<string, readonly string[]>> = {
    mp4: [
        'mp4a',
        'ac-3',
        'ec-3',
        'alac',
        'flac',
        'opus',
        'mp1',
        'mp2',
        'mp3',
        ...DTS,
        'mlpa',
        ...CARRIED,
        'pcm',
        ...ISO_PCM,
    ],
    mov: [
        'mp4a',
        'ac-3',
        'ec-3',
        'alac',
        'flac',
        'opus',
        'ulaw',
        'alaw',
        'mp1',
        'mp2',
        'mp3',
        ...DTS,
        ...CARRIED,
        ...QUICKTIME_PCM,
    ],
    m4v: [
        'mp4a',
        'ac-3',
        'ec-3',
        'alac',
        'flac',
        'opus',
        'mp1',
        'mp2',
        'mp3',
        ...DTS,
        ...CARRIED,
        'pcm',
        ...ISO_PCM,
    ],
    '3gp': ['mp4a', 'evrc', 'qcelp'],
    m4a: ['mp4a', 'ac-3', 'ec-3', 'alac', 'flac', 'opus', 'mp1', 'mp2', 'mp3', ...CARRIED],
    mkv: [
        'mp4a',
        'opus',
        'vorbis',
        'flac',
        'alac',
        'ulaw',
        'alaw',
        'mp1',
        'mp2',
        'mp3',
        'ac-3',
        'ec-3',
        ...DTS,
        'mlpa',
        'pcm',
        'pcm-u8',
        'pcm-s16le',
        'pcm-s24le',
        'pcm-s32le',
        'pcm-s16be',
        'pcm-s24be',
        'pcm-s32be',
        'pcm-f32le',
        'pcm-f64le',
        ...WINDOWS_MEDIA_AUDIO_CODECS,
    ],
    webm: ['opus', 'vorbis'],
    // The Ogg writer of conversions; Vorbis is copied by the audio file writer.
    ogg: ['opus', 'flac'],
    ts: ['mp4a', 'ac-3', 'ec-3', 'mp1', 'mp2', 'mp3', ...DTS],
    flv: ['mp4a'],
    avi: ['pcm', 'pcm-s16le', 'mp1', 'mp2', 'mp3', 'ac-3', ...WINDOWS_MEDIA_AUDIO_CODECS],
    ivf: [],
    iamf: ['iamf'],
    apv: [],
};

/** Text subtitle codecs a tx3g track can take, with their packet layout. */
export const TX3G_SOURCE_CODECS: ReadonlySet<string> = new Set([
    'text/utf8',
    'text/ass',
    'text/ssa',
    'text/webvtt',
]);

/** Text an MP4 or MOV holds as 3GPP timed text: that text itself, SubRip, ASS/SSA and WebVTT. */
const TIMED_TEXT = ['tx3g', ...TX3G_SOURCE_CODECS];
const SUBTITLE: Readonly<Record<string, readonly string[]>> = {
    // 3GPP timed text is written as S_TEXT/UTF8.
    mkv: ['text/utf8', 'text/ass', 'text/ssa', 'text/webvtt', 'tx3g'],
    webm: ['text/webvtt'],
    mp4: TIMED_TEXT,
    m4v: TIMED_TEXT,
    mov: TIMED_TEXT,
};

/** Codec families each container writer copies, keyed by container format. */
export function muxCodecTables(): {
    readonly video: Readonly<Record<string, readonly string[]>>;
    readonly audio: Readonly<Record<string, readonly string[]>>;
} {
    return { video: VIDEO, audio: AUDIO };
}

/**
 * MPEG-4 audio object types of the AAC family; other object types (ALS, SLS, CELP, TwinVQ) share
 * 'mp4a'.
 */
const AAC_OBJECT_TYPES = new Set([1, 2, 3, 4, 5, 6, 17, 19, 20, 22, 23, 29, 39, 42]);

/** Shared packet-copy eligibility for the muxers and conversion planners. */
export function canMuxCodec(format: string, type: TrackType, codec: string): boolean {
    const family =
        typeof codec === 'string' ? (mpegVideoFamily(codec) ?? codec.split('.')[0]!) : '';
    const objectType = /^mp4a\.40\.(\d+)$/.exec(family === 'mp4a' ? codec : '')?.[1];
    if (objectType && !MP4_FAMILY.has(format) && !AAC_OBJECT_TYPES.has(Number(objectType)))
        return false;
    // Other MPEG-4 systems object types go back into an 'mp4a' entry as stated.
    if (type === 'audio' && /^mp4a-oti-[0-9a-f]{2}$/.test(codec)) return MP4_FAMILY.has(format);
    const allowed = (type === 'video' ? VIDEO : type === 'audio' ? AUDIO : SUBTITLE)[format];
    return allowed?.includes(family) ?? false;
}

/**
 * MP4 targets that keep text subtitles: as 3GPP timed text, and WebVTT samples ('wvtt') as they are
 * in fragmented MP4.
 */
const FRAGMENTED_SUBTITLES: ReadonlySet<string> = new Set(['mp4', 'm4v', 'fmp4']);

/**
 * True when a copy to `format` keeps a subtitle track of `codec` (converted to the container's text
 * format).
 */
export function carriesSubtitle(format: string, codec: string): boolean {
    if (FRAGMENTED_SUBTITLES.has(format))
        return codec === 'tx3g' || codec === 'wvtt' || TX3G_SOURCE_CODECS.has(codec);
    return canMuxCodec(format, 'subtitle', codec);
}

/** Codec families the fragmented MP4 writer carries (its sample entries in cmaf-boxes). */
const FRAGMENTED: Readonly<Record<'video' | 'audio', readonly string[]>> = {
    video: ['avc1', 'avc3', ...HEVC, 'av01', 'vp09', APV],
    audio: ['mp4a', 'opus', 'Opus', 'flac', 'fLaC', 'alac', 'ac-3', 'ec-3', 'mp1', 'mp2', 'mp3'],
};

/** True when the fragmented MP4 writer carries a track of `codec`. */
export function canFragmentCodec(type: TrackType, codec: string): boolean {
    if (type === 'subtitle') return carriesSubtitle('fmp4', codec);
    return FRAGMENTED[type].includes(codec.split('.')[0]!);
}

/**
 * True when `format` carries `codec` only when a copy is asked for (`copy: true` or the codec
 * named): ISO PCM in MP4 plays in fewer players than the AAC a conversion writes otherwise.
 */
export function copiesOnRequest(format: string, codec: string): boolean {
    return (format === 'mp4' || format === 'm4v') && isPcmCodec(codec);
}

/** Prevents unsupported payloads being silently labeled as the container's default codec. */
export function assertMuxCodec(format: string, type: TrackType, codec: string): void {
    if (!canMuxCodec(format, type, codec))
        throw new MediaForgeError(`${format} cannot mux ${type} codec '${codec}'`, 'FORMAT');
}
