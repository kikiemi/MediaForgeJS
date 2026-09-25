import { MediaForgeError } from '../core/errors.js';
const DEFINITIONS = [
    {
        id: 'avc',
        type: 'video',
        name: 'H.264 / AVC',
        aliases: ['avc1', 'avc3', 'h264'],
        containers: ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'flv', 'ts', 'avi', 'fmp4'],
    },
    {
        id: 'hevc',
        type: 'video',
        name: 'H.265 / HEVC',
        aliases: ['hvc1', 'hev1', 'h265'],
        containers: ['mp4', 'mov', 'm4v', 'mkv', 'ts', 'fmp4'],
    },
    {
        id: 'av1',
        type: 'video',
        name: 'AV1',
        aliases: ['av01'],
        containers: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'fmp4'],
    },
    { id: 'vp9', type: 'video', name: 'VP9', aliases: ['vp09'], containers: ['mkv', 'webm', 'fmp4'] },
    { id: 'vp8', type: 'video', name: 'VP8', aliases: ['vp08'], containers: ['mkv', 'webm'] },
    {
        id: 'aac',
        type: 'audio',
        name: 'AAC',
        aliases: ['mp4a.40', 'mp4a.66', 'mp4a.67', 'mp4a.68'],
        containers: ['mp4', 'mov', 'm4v', 'm4a', '3gp', 'mkv', 'flv', 'ts', 'aac', 'fmp4'],
    },
    { id: 'opus', type: 'audio', name: 'Opus', aliases: [], containers: ['mkv', 'webm', 'ogg', 'fmp4'] },
    { id: 'vorbis', type: 'audio', name: 'Vorbis', aliases: [], containers: ['mkv', 'webm', 'ogg'] },
    { id: 'flac', type: 'audio', name: 'FLAC', aliases: [], containers: ['flac', 'fmp4'] },
    {
        id: 'mp3',
        type: 'audio',
        name: 'MPEG Audio Layer III',
        aliases: ['mp4a.6b', 'mp4a.69'],
        containers: ['mkv', 'mp3', 'ts'],
    },
    { id: 'mp2', type: 'audio', name: 'MPEG Audio Layer II', aliases: [], containers: ['mp2', 'ts', 'mkv'] },
    { id: 'mp1', type: 'audio', name: 'MPEG Audio Layer I', aliases: [], containers: ['mp1', 'ts', 'mkv'] },
    {
        id: 'ac3',
        type: 'audio',
        name: 'Dolby Digital',
        aliases: ['ac-3'],
        containers: ['mp4', 'mov', 'm4v', 'm4a', 'mkv', 'ts', 'fmp4'],
    },
    {
        id: 'eac3',
        type: 'audio',
        name: 'Dolby Digital Plus',
        aliases: ['ec-3'],
        containers: ['mp4', 'mov', 'm4v', 'm4a', 'mkv', 'ts', 'fmp4'],
    },
    {
        id: 'pcm',
        type: 'audio',
        name: 'PCM16 LE',
        aliases: ['lpcm', 'sowt'],
        containers: ['wav', 'avi', 'aiff', 'au', 'caf'],
    },
    ...[
        'pcm-u8',
        'pcm-s8',
        'pcm-s16le',
        'pcm-s24le',
        'pcm-s32le',
        'pcm-f32le',
        'pcm-f64le',
        'pcm-s16be',
        'pcm-s24be',
        'pcm-s32be',
        'pcm-f32be',
        'pcm-f64be',
    ].map(id => ({
        id,
        type: 'audio',
        name: id,
        aliases: id === 'pcm-s16be' ? ['twos'] : [],
        containers: ['wav', 'aiff', 'au', 'caf'],
    })),
    { id: 'alac', type: 'audio', name: 'Apple Lossless', aliases: [], containers: ['fmp4'] },
    { id: 'dts', type: 'audio', name: 'DTS', aliases: ['dtsc', 'dtsh', 'dtsl', 'dtse'], containers: [] },
    { id: 'vvc', type: 'video', name: 'H.266 / VVC', aliases: ['vvc1', 'vvi1'], containers: [] },
    {
        id: 'dolby-vision',
        type: 'video',
        name: 'Dolby Vision',
        aliases: ['dvh1', 'dvhe', 'dva1', 'dvav'],
        containers: [],
    },
    {
        id: 'prores',
        type: 'video',
        name: 'Apple ProRes',
        aliases: ['apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x'],
        containers: ['mov', 'mkv'],
    },
    {
        id: 'prores-raw',
        type: 'video',
        name: 'Apple ProRes RAW',
        aliases: ['aprn', 'aprh'],
        containers: ['mov'],
    },
    { id: 'mpeg2video', type: 'video', name: 'MPEG-2 Video', aliases: ['mp2v'], containers: [] },
    { id: 'mpeg4video', type: 'video', name: 'MPEG-4 Part 2', aliases: ['mp4v'], containers: [] },
    {
        id: 'webvtt',
        type: 'subtitle',
        name: 'WebVTT',
        aliases: ['wvtt', 'text/webvtt'],
        containers: ['fmp4', 'mkv', 'webm'],
    },
    { id: 'ttml', type: 'subtitle', name: 'TTML', aliases: ['stpp'], containers: ['fmp4'] },
    { id: 'utf8', type: 'subtitle', name: 'UTF-8 text', aliases: ['text/utf8', 'srt', 'subrip'], containers: ['mkv'] },
    { id: 'ass', type: 'subtitle', name: 'ASS / SSA', aliases: ['text/ass', 'text/ssa', 'ssa'], containers: ['mkv'] },
    { id: 'tx3g', type: 'subtitle', name: '3GPP timed text', aliases: [], containers: [] },
    { id: 'cea608', type: 'subtitle', name: 'CEA-608', aliases: ['c608'], containers: [] },
];
export class CodecRegistry {
    entries = new Map();
    names = new Map();
    constructor(descriptors = DEFINITIONS) {
        for (const descriptor of descriptors)
            this.register(descriptor);
    }
    register(descriptor) {
        if (!descriptor || typeof descriptor !== 'object')
            throw new MediaForgeError('Expected a codec descriptor', 'INPUT');
        const { id: requestedId, type, name: label, aliases: requestedAliases, containers: requestedContainers, } = descriptor;
        if (!['video', 'audio', 'subtitle'].includes(type) ||
            typeof label !== 'string' ||
            !label ||
            !Array.isArray(requestedAliases) ||
            !Array.isArray(requestedContainers)) {
            throw new MediaForgeError('Invalid codec descriptor', 'INPUT');
        }
        const id = name(requestedId);
        const aliases = normalizeNames(requestedAliases);
        const containers = normalizeNames(requestedContainers);
        const names = [...new Set([id, ...aliases])];
        const entry = Object.freeze({
            id,
            type,
            name: label,
            aliases: Object.freeze(aliases),
            containers: Object.freeze(containers),
        });
        for (const key of names) {
            if (this.names.has(key))
                throw new MediaForgeError(`Codec name already registered: ${key}`, 'INPUT');
        }
        this.entries.set(id, entry);
        for (const key of names)
            this.names.set(key, id);
    }
    resolve(codec) {
        let key = name(codec);
        for (;;) {
            const id = this.names.get(key);
            if (id)
                return this.entries.get(id);
            const dot = key.lastIndexOf('.');
            if (dot < 0)
                return undefined;
            key = key.slice(0, dot);
        }
    }
    list(type) {
        return [...this.entries.values()].filter(entry => type === undefined || entry.type === type);
    }
    canMux(codec, container) {
        return this.resolve(codec)?.containers.includes(name(container)) ?? false;
    }
}
function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
        throw new MediaForgeError('Codec names must be nonempty strings of at most 256 characters', 'INPUT');
    }
    return value.trim().toLowerCase();
}
function normalizeNames(values) {
    const length = values.length;
    const result = new Array(length);
    for (let index = 0; index < length; index++)
        result[index] = name(values[index]);
    return result;
}
export async function probeNativeCodec(type, operation, config) {
    if (!['video', 'audio'].includes(type) ||
        !['encode', 'decode'].includes(operation) ||
        !config ||
        typeof config !== 'object') {
        throw new MediaForgeError('Codec probe requires a valid type, operation and codec configuration', 'INPUT');
    }
    const key = `${type === 'video' ? 'Video' : 'Audio'}${operation === 'encode' ? 'Encoder' : 'Decoder'}`;
    const host = globalThis;
    try {
        const implementation = host[key];
        const query = implementation?.isConfigSupported;
        if (typeof query !== 'function')
            return { available: false, supported: false };
        const result = await Reflect.apply(query, implementation, [config]);
        return { available: true, supported: result.supported === true, config: result.config };
    }
    catch (error) {
        let reason = 'Codec probe failed';
        try {
            reason = String(error instanceof Error ? error.message : error);
        }
        catch { }
        return { available: true, supported: false, reason };
    }
}
