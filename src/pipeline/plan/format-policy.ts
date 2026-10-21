import type { ContainerFormat, TrackType } from '../../core/model/media';
import { codecFamily, mp4aAudioObjectType } from '../../core/model/codec-strings';
import { MediaForgeError } from '../../core/errors/errors';

/**
 * The targets each operation writes. Every list of formats the engine and the API branch on is
 * defined here once.
 */

/** The formats the copy operation writes, which the copy defines. */
export { REMUX_FORMATS } from '../copy/copy-formats';

/** Audio files the library encodes: the PCM containers, FLAC, AAC in ADTS and MPEG audio. */
export const AUDIO_FILE_FORMATS = [
    'wav',
    'aiff',
    'au',
    'caf',
    'flac',
    'aac',
    'mp2',
    'mp3',
] as const;

/** Containers that frames from the application (encodeFrames, recordStream) are encoded into. */
export const FRAME_ENCODE_FORMATS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const;

/** HLS and DASH presentations; hls+dash writes one segment set with both. */
export const PACKAGE_FORMATS = ['hls', 'dash', 'hls+dash'] as const;

/** Containers a conversion writes video and audio tracks into. */
export const CONTAINER_TARGETS: ReadonlySet<string> = new Set([
    'mp4',
    'mov',
    'm4a',
    'm4v',
    '3gp',
    'mkv',
    'webm',
    'ts',
    'flv',
    'avi',
    'ivf',
    'iamf',
    'apv',
    'fmp4',
    'ogg',
]);

/**
 * How many tracks of `type` a target holds: MP4 and Matroska any number (M4A audio only), MPEG-TS
 * any number of audio tracks next to one video track, IVF one video track, Ogg and the audio files
 * one audio track, the others one video and one audio track.
 */
export function trackCapacity(format: string, type: TrackType): number {
    if (format === 'm4a') return type === 'audio' ? Infinity : 0;
    if (['mp4', 'mov', 'm4v', '3gp', 'fmp4', 'mkv', 'webm'].includes(format)) return Infinity;
    if (type === 'subtitle') return 0;
    if (format === 'ts') return type === 'audio' ? Infinity : 1;
    if (format === 'ivf') return type === 'video' ? 1 : 0;
    if (format === 'flv' || format === 'avi') return 1;
    return type === 'audio' ? 1 : 0;
}

/**
 * Audio files that keep linear samples: 16-bit output from wider sources needs allowPrecisionLoss.
 */
export const LOSSLESS_AUDIO_FORMATS: ReadonlySet<string> = new Set([
    'wav',
    'aiff',
    'au',
    'caf',
    'flac',
]);

/** Image formats a picture taken from video is encoded to. */
export const FRAME_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

/** Image formats whose encoder takes a quality. */
export const LOSSY_IMAGE_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'webp', 'avif']);

/** Animated image formats, which take video.fps and a range. */
export const ANIMATED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['gif', 'apng']);

/** Codec string written by each audio file format. */
const AUDIO_FORMAT_CODECS: Readonly<Record<string, string>> = {
    mp3: 'mp3',
    mp2: 'mp2',
    aac: 'mp4a.40.2',
    flac: 'flac',
    wav: 'pcm-s16',
    aiff: 'pcm-s16',
    au: 'pcm-s16',
    caf: 'pcm-s16',
};

/** The codec an audio file format writes, or undefined for a format without a fixed codec. */
export function audioFormatCodec(format: string): string | undefined {
    return AUDIO_FORMAT_CODECS[format];
}

export const IMAGE_FORMATS = new Set<ContainerFormat>([
    'png',
    'jpeg',
    'webp',
    'bmp',
    'tiff',
    'ico',
    'gif',
    'apng',
    'avif',
    'heif',
    'jxl',
]);

/**
 * Image formats whose still and animated pictures the host ImageDecoder or the built-in readers
 * decode.
 */
export const CONTAINER_IMAGE_FORMATS = new Set<ContainerFormat>(['webp', 'avif', 'heif', 'jxl']);
export { PCM_AUDIO_FORMATS } from '../../core/model/pcm-files';

export function assertAudioEncodeRequest(codec: string): void {
    const refusal = audioEncodeRefusal(codec);
    if (refusal) throw refusal;
}

/** Why the library encodes no `codec` audio, or undefined where it does. */
function audioEncodeRefusal(codec: string): MediaForgeError | undefined {
    const fam = codecFamily(codec);
    if (fam !== 'mp4a' && codec !== 'aac') {
        if (['opus', 'mp3', 'mp2', 'flac', 'pcm', 'ulaw', 'alaw'].includes(codec)) return undefined;
        return new MediaForgeError(`${codec} audio can be copied but not encoded here`, 'ENCODE');
    }

    if (codec === 'aac' || !codec.includes('.') || mp4aAudioObjectType(codec) === 2)
        return undefined;
    return new MediaForgeError(`No AAC encoder makes '${codec}'`, 'ENCODE', {
        hint: "Ask for 'aac' (mp4a.40.2).",
    });
}

type ContainerCodecPlan = {
    readonly defaultVideo?: string;
    readonly defaultAudio?: string;
    readonly video?: readonly string[];
    readonly audio?: readonly string[];
};

export const CONTAINER_CODEC_PLANS: Partial<Record<ContainerFormat, ContainerCodecPlan>> = {
    mp4: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    mov: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3', 'ulaw', 'alaw', 'pcm'],
    },
    '3gp': {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028'],
        audio: ['mp4a.40.2'],
    },
    m4v: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'av01.0.01M.08'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    m4a: {
        defaultAudio: 'mp4a.40.2',
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
    webm: {
        defaultVideo: 'vp8',
        defaultAudio: 'opus',
        video: ['vp8', 'vp09.00.10.08', 'av01.0.01M.08'],
        audio: ['opus'],
    },
    mkv: {
        defaultVideo: 'vp8',
        defaultAudio: 'opus',
        video: [
            'vp8',
            'vp09.00.10.08',
            'av01.0.01M.08',
            'avc1.640028',
            'avc3.640028',
            'hvc1.1.6.L93.B0',
            'hev1.1.6.L93.B0',
        ],
        audio: ['opus', 'mp4a.40.2', 'ulaw', 'alaw', 'pcm'],
    },
    ogg: {
        defaultAudio: 'opus',
        audio: ['opus', 'flac'],
    },
    avi: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'pcm',
        video: ['avc1.640028'],
        audio: ['pcm'],
    },
    flv: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028'],
        audio: ['mp4a.40.2'],
    },
    ts: {
        defaultVideo: 'avc1.640028',
        defaultAudio: 'mp4a.40.2',
        video: ['avc1.640028', 'hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
    },
};

/**
 * The codec a re-encoded `kind` track gets in `format`: the requested one, else the source's where
 * the container carries it and, for audio, the library encodes it, else the container's default.
 */
export function targetCodec(
    format: string,
    requested: string | undefined,
    source: string | undefined,
    kind: 'video' | 'audio',
): string {
    const defaults = CONTAINER_CODEC_PLANS[format as ContainerFormat];
    const supported = kind === 'video' ? defaults?.video : defaults?.audio;
    const fallback = kind === 'video' ? defaults?.defaultVideo : defaults?.defaultAudio;
    const own = source && encoderCodec(source);
    const kept = kind === 'audio' && own && audioEncodeRefusal(own) ? undefined : own;
    return (
        resolveSupportedCodec(requested || kept, supported, fallback) ??
        (requested || fallback || '')
    );
}

/**
 * The codec that encodes samples of `codec` as they are: 'pcm', the library's PCM coding, for
 * 16-bit little-endian PCM, which it writes; any other codec itself.
 */
export function encoderCodec(codec: string): string {
    return codec === 'pcm-s16le' ? 'pcm' : codec;
}

/**
 * The codec of `supportedCodecs` that encodes `requested` (a request or a source's codec), the
 * fallback without one, or null when none does.
 */
export function resolveSupportedCodec(
    requested: string | undefined,
    supportedCodecs: readonly string[] | undefined,
    fallbackCodec: string | undefined,
): string | null | undefined {
    if (!supportedCodecs || supportedCodecs.length === 0) return fallbackCodec;
    if (!requested) return fallbackCodec;
    const requestedCodec = encoderCodec(requested);

    const requestedFamily = codecFamily(requestedCodec);
    const matchedCodec = supportedCodecs.find(
        candidate => codecFamily(candidate) === requestedFamily,
    );
    if (matchedCodec) {
        return requestedCodec.includes('.') ? requestedCodec : matchedCodec;
    }

    return null;
}
