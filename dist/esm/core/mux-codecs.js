import { MediaForgeError } from './errors.js';
const VIDEO = {
    mp4: ['avc1', 'avc3', 'hvc1', 'hev1', 'av01'],
    mov: ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x', 'aprn', 'aprh'],
    m4v: ['avc1', 'avc3', 'hvc1', 'hev1', 'av01'],
    '3gp': ['avc1', 'avc3'],
    m4a: [],
    mkv: ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp8', 'vp9', 'vp09', 'apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'],
    webm: ['av01', 'vp8', 'vp9', 'vp09'],
    ts: ['avc1', 'avc3', 'hvc1', 'hev1'],
    flv: ['avc1', 'avc3'],
    avi: ['avc1', 'avc3'],
};
const AUDIO = {
    mp4: ['mp4a', 'ac-3', 'ec-3'],
    mov: ['mp4a', 'ac-3', 'ec-3'],
    m4v: ['mp4a', 'ac-3', 'ec-3'],
    '3gp': ['mp4a'],
    m4a: ['mp4a', 'ac-3', 'ec-3'],
    mkv: [
        'mp4a',
        'opus',
        'vorbis',
        'mp1',
        'mp2',
        'mp3',
        'ac-3',
        'ec-3',
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
    ],
    webm: ['opus', 'vorbis'],
    ts: ['mp4a', 'ac-3', 'ec-3', 'mp1', 'mp2', 'mp3'],
    flv: ['mp4a'],
    avi: ['pcm', 'pcm-s16le'],
};
export function canMuxCodec(format, type, codec) {
    const family = typeof codec === 'string' ? codec.split('.')[0] : '';
    const allowed = type === 'video'
        ? VIDEO[format]
        : type === 'audio'
            ? AUDIO[format]
            : format === 'mkv'
                ? ['text/utf8', 'text/ass', 'text/ssa', 'text/webvtt']
                : format === 'webm'
                    ? ['text/webvtt']
                    : [];
    return allowed?.includes(family) ?? false;
}
export function assertMuxCodec(format, type, codec) {
    if (!canMuxCodec(format, type, codec))
        throw new MediaForgeError(`${format} cannot mux ${type} codec '${codec}'`, 'FORMAT');
}
