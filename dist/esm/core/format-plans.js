import { codecFamily, mp4aAudioObjectType } from './codec-strings.js';
import { MediaForgeError } from './errors.js';
export const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp', 'bmp', 'tiff', 'ico', 'gif', 'apng']);
export const PCM_AUDIO_FORMATS = new Set(['wav', 'aiff', 'au', 'caf']);
export const AUDIO_ONLY = new Set([...PCM_AUDIO_FORMATS, 'ogg', 'aac', 'flac', 'mp3', 'm4a', 'mp2']);
export const AUDIO_INPUT = new Set([
    ...PCM_AUDIO_FORMATS,
    'ogg',
    'aac',
    'flac',
    'mp3',
    'mp2',
    'mp1',
    'm4a',
]);
export function assertAudioEncodeRequest(codec) {
    const fam = codecFamily(codec);
    if (fam !== 'mp4a' && codec !== 'aac') {
        if (codec === 'opus' || codec === 'mp3' || codec === 'mp2' || codec === 'flac' || codec === 'pcm')
            return;
        throw new MediaForgeError(`cannot encode audio as '${codec}': it is copy-only here - the source must already carry it`, 'ENCODE');
    }
    if (codec === 'aac' || !codec.includes('.'))
        return;
    const aot = mp4aAudioObjectType(codec);
    if (aot === null) {
        throw new MediaForgeError(`No AAC encoder can honor '${codec}': unrecognised MPEG-4 audio object type. Producible: mp4a.40.2 (AAC-LC); MPEG-2 AAC (mp4a.67) and MPEG-1 audio (mp4a.6b) cannot be produced`, 'ENCODE');
    }
    if (aot !== 2) {
        throw new MediaForgeError(`No AAC encoder can honor '${codec}'; only AAC-LC (mp4a.40.2) is producible`, 'ENCODE');
    }
}
export const mp4FamilyAudioOk = (codec) => codec.startsWith('mp4a') || codec === 'aac' || codec === 'ac-3' || codec === 'ec-3';
export const VIDEO_CONTAINERS = new Set([
    'mp4',
    'mov',
    'webm',
    'mkv',
    'avi',
    'flv',
    '3gp',
    'ts',
    'm4v',
]);
export const CONTAINER_CODEC_PLANS = {
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
        audio: ['mp4a.40.2', 'ac-3', 'ec-3'],
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
        audio: ['opus', 'mp4a.40.2'],
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
export function resolveSupportedCodec(requestedCodec, supportedCodecs, fallbackCodec, label) {
    if (!supportedCodecs || supportedCodecs.length === 0)
        return fallbackCodec;
    if (!requestedCodec)
        return fallbackCodec;
    const requestedFamily = codecFamily(requestedCodec);
    const matchedCodec = supportedCodecs.find(candidate => codecFamily(candidate) === requestedFamily);
    if (matchedCodec) {
        return requestedCodec.includes('.') ? requestedCodec : matchedCodec;
    }
    void label;
    return null;
}
