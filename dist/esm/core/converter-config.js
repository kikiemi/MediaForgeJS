import { MediaForgeError, normalizeBitrateBps } from './errors.js';
import { isImageFitMode } from './image-geometry.js';
import { IMAGE_FORMATS, AUDIO_ONLY, PCM_AUDIO_FORMATS, VIDEO_CONTAINERS, mp4FamilyAudioOk } from './format-plans.js';
export const MAX_ANIMATION_PIXELS = 128 * 1024 * 1024;
export function validateImageEncodingOptions(config, outputFormat) {
    if (config.imageDither !== undefined) {
        if (config.imageDither !== 'none' && config.imageDither !== 'floyd-steinberg') {
            throw new MediaForgeError('imageDither must be none or floyd-steinberg', 'FORMAT');
        }
        if (outputFormat !== 'gif') {
            throw new MediaForgeError('imageDither applies only to GIF output', 'FORMAT');
        }
    }
    if (config.imageOptimizeFrames !== undefined) {
        if (typeof config.imageOptimizeFrames !== 'boolean') {
            throw new MediaForgeError('imageOptimizeFrames must be a boolean', 'FORMAT');
        }
        if (outputFormat !== 'apng') {
            throw new MediaForgeError('imageOptimizeFrames applies only to APNG output', 'FORMAT');
        }
    }
    if (config.imageQuality !== undefined) {
        if (typeof config.imageQuality !== 'number' ||
            !Number.isFinite(config.imageQuality) ||
            config.imageQuality < 0 ||
            config.imageQuality > 1) {
            throw new MediaForgeError('imageQuality must be a number between 0 and 1', 'FORMAT');
        }
        if (outputFormat !== 'jpeg' && outputFormat !== 'webp') {
            throw new MediaForgeError('imageQuality applies only to JPEG and WebP output', 'FORMAT');
        }
    }
    if (config.maxAnimationPixels !== undefined) {
        if (typeof config.maxAnimationPixels !== 'number' ||
            !Number.isInteger(config.maxAnimationPixels) ||
            config.maxAnimationPixels < 1 ||
            config.maxAnimationPixels > MAX_ANIMATION_PIXELS) {
            throw new MediaForgeError(`maxAnimationPixels must be a positive integer <= ${MAX_ANIMATION_PIXELS}`, 'FORMAT');
        }
        if (outputFormat !== 'gif' && outputFormat !== 'apng') {
            throw new MediaForgeError('maxAnimationPixels applies only to GIF and APNG output', 'FORMAT');
        }
    }
}
const KNOWN_KEYS = new Set([
    'imageResize',
    'imageFit',
    'imageQuality',
    'imageOptimizeFrames',
    'imageDither',
    'maxAnimationPixels',
    'audioTrackIndex',
    'allowDomFallback',
    'outputFormat',
    'videoCodec',
    'audioCodec',
    'width',
    'height',
    'fps',
    'videoBitrate',
    'audioBitrate',
    'audioVbr',
    'audioSampleRate',
    'audioChannels',
    'signal',
    'onProgress',
    'metadataPolicy',
]);
const KNOWN_FORMATS = new Set([...VIDEO_CONTAINERS, ...AUDIO_ONLY, ...IMAGE_FORMATS]);
const KNOWN_KEY_LIST = [...KNOWN_KEYS];
const KNOWN_FORMAT_LIST = [...KNOWN_FORMATS].join(', ');
const VP9_LEVELS = new Set(['00', '10', '11', '20', '21', '30', '31', '40', '41', '50', '51', '52', '60', '61', '62']);
const posInt = (name, v, max) => {
    if (v === undefined)
        return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > max) {
        throw new MediaForgeError(`'${name}' must be a positive integer <= ${max} (got ${String(v)})`, 'FORMAT');
    }
};
const posNum = (name, v) => {
    if (v === undefined)
        return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new MediaForgeError(`'${name}' must be a positive finite number (got ${String(v)})`, 'FORMAT');
    }
};
const lcName = (s) => {
    const dot = s.indexOf('.');
    return dot < 0 ? s.toLowerCase() : s.slice(0, dot).toLowerCase() + s.slice(dot);
};
const codecShapeOk = (kind, value) => {
    if (kind === 'audio') {
        return (/^(aac|mp3|mp2|mp1|opus|vorbis|flac|pcm|ac-3|ec-3)$/.test(value) ||
            /^mp4a(\.[0-9a-fA-F]{1,2}(\.\d{1,3})?)?$/.test(value));
    }
    if (/^(vp8|vp9)$/.test(value))
        return true;
    if (/^(avc1|avc3)(\.[0-9a-fA-F]{6})?$/.test(value))
        return true;
    const vp09Match = /^vp09(?:\.(0[0-3])\.(\d{2})\.(08|10|12)(?:\.(0[0-3])\.\d{2}\.\d{2}\.(\d{2})\.(0[01]))?)?$/.exec(value);
    if (vp09Match) {
        if (!vp09Match[1])
            return true;
        if (!VP9_LEVELS.has(vp09Match[2]))
            return false;
        const vpProfile = vp09Match[1];
        const vpDepth = vp09Match[3];
        if ((vpProfile === '00' || vpProfile === '01') && vpDepth !== '08')
            return false;
        if ((vpProfile === '02' || vpProfile === '03') && vpDepth === '08')
            return false;
        const vpChroma = vp09Match[4] ?? '01';
        const vpMatrix = vp09Match[5] ?? '01';
        if ((vpProfile === '00' || vpProfile === '02') && vpChroma !== '00' && vpChroma !== '01')
            return false;
        if ((vpProfile === '01' || vpProfile === '03') && vpChroma !== '02' && vpChroma !== '03')
            return false;
        if (vpMatrix === '00' && vpChroma !== '03')
            return false;
        return true;
    }
    const av01Match = /^av01(?:\.([0-2])\.(0\d|1\d|2[0-3])([MH])\.(08|10|12)(?:\.([01])\.([01])([01])([0-9])\.\d{2}\.\d{2}\.(\d{2})\.([01]))?)?$/.exec(value);
    if (av01Match) {
        if (!av01Match[1])
            return true;
        const avProfile = av01Match[1];
        const avLevel = Number(av01Match[2]);
        const avTier = av01Match[3];
        const avDepth = av01Match[4];
        if (avTier === 'H' && avLevel <= 7)
            return false;
        if (avDepth === '12' && avProfile !== '2')
            return false;
        const mono = av01Match[5] ?? '0';
        const subX = av01Match[6] ?? '1';
        const subY = av01Match[7] ?? '1';
        const pos = av01Match[8] ?? '0';
        const matrix = av01Match[9] ?? '01';
        if (pos !== '0' && pos !== '1' && pos !== '2')
            return false;
        if ((subX !== '1' || subY !== '1') && pos !== '0')
            return false;
        if (mono === '1') {
            if (avProfile === '1')
                return false;
            if (subX !== '1' || subY !== '1')
                return false;
            if (pos !== '0')
                return false;
        }
        else if (avProfile === '0') {
            if (subX !== '1' || subY !== '1')
                return false;
        }
        else if (avProfile === '1') {
            if (subX !== '0' || subY !== '0')
                return false;
        }
        else if (avDepth !== '12') {
            if (subX !== '1' || subY !== '0')
                return false;
        }
        else if (subX === '0' && subY === '1')
            return false;
        if (matrix === '00' && (subX !== '0' || subY !== '0' || mono === '1'))
            return false;
        return true;
    }
    if (/^(hvc1|hev1)(\.[A-Ca-c]?\d{1,3}\.[0-9a-fA-F]{1,8}\.[LH]\d{1,3}(\.[0-9a-fA-F]{1,2}){0,6})?$/.test(value))
        return true;
    return false;
};
const FIXED_AUDIO = {
    wav: () => false,
    aiff: () => false,
    au: () => false,
    caf: () => false,
    flac: c => c === 'flac',
    mp3: c => c === 'mp3',
    mp2: c => c === 'mp2',
    ogg: c => c === 'opus',
    m4a: c => mp4FamilyAudioOk(c),
    aac: c => c === 'aac' || c.startsWith('mp4a'),
};
export function snapshotMediaForgeConfig(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new MediaForgeError(`MediaForgeConverter requires a config object (got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input})`, 'FORMAT');
    }
    for (const key of Object.keys(input)) {
        if (KNOWN_KEYS.has(key))
            continue;
        const hint = key === 'format'
            ? 'outputFormat'
            : KNOWN_KEY_LIST.find(k => k.toLowerCase() === key.toLowerCase() ||
                (Math.abs(k.length - key.length) <= 2 &&
                    k.toLowerCase().startsWith(key.toLowerCase().slice(0, 4))));
        throw new MediaForgeError(`Unknown option '${key}'${hint ? ` — did you mean '${hint}'?` : ''} (valid: ${KNOWN_KEY_LIST.join(', ')})`, 'FORMAT');
    }
    const config = { ...input };
    for (const key of KNOWN_KEY_LIST) {
        if (Object.prototype.hasOwnProperty.call(config, key))
            continue;
        const present = key in input;
        const value = input[key];
        if (value !== undefined || present) {
            Object.defineProperty(config, key, { value, enumerable: true, writable: true, configurable: true });
        }
    }
    return config;
}
export function normalizeMediaForgeConfig(input = {}) {
    const config = snapshotMediaForgeConfig(input);
    if (config.metadataPolicy !== undefined && config.metadataPolicy !== 'warn' && config.metadataPolicy !== 'error') {
        throw new MediaForgeError('metadataPolicy must be warn or error', 'FORMAT');
    }
    if (config.outputFormat === undefined && input.format !== undefined) {
        throw new MediaForgeError("Unknown option 'format' — did you mean 'outputFormat'?", 'FORMAT');
    }
    if (!config.outputFormat) {
        throw new MediaForgeError("'outputFormat' is required (e.g. new MediaForgeConverter({ outputFormat: 'mp4' }))", 'FORMAT');
    }
    if (!KNOWN_FORMATS.has(config.outputFormat)) {
        throw new MediaForgeError(`Unknown outputFormat '${config.outputFormat}' (valid: ${KNOWN_FORMAT_LIST})`, 'FORMAT');
    }
    posInt('width', config.width, 16384);
    posInt('height', config.height, 16384);
    if (config.width !== undefined && config.height !== undefined && config.width * config.height > 8192 * 4320) {
        throw new MediaForgeError(`width×height ${config.width}×${config.height} exceeds the supported pixel budget (8192×4320)`, 'FORMAT');
    }
    posInt('audioChannels', config.audioChannels, 8);
    posInt('audioSampleRate', config.audioSampleRate, 192000);
    if (config.audioSampleRate !== undefined && config.audioSampleRate < 8000) {
        throw new MediaForgeError(`'audioSampleRate' must be between 8000 and 192000 (got ${config.audioSampleRate})`, 'FORMAT');
    }
    posNum('fps', config.fps);
    if (config.fps !== undefined && config.fps > 300) {
        throw new MediaForgeError(`'fps' must be <= 300 (got ${String(config.fps)})`, 'FORMAT');
    }
    posNum('videoBitrate', config.videoBitrate);
    posNum('audioBitrate', config.audioBitrate);
    if (config.videoBitrate !== undefined && normalizeBitrateBps(config.videoBitrate, 'video') > 800_000_000) {
        throw new MediaForgeError(`'videoBitrate' must be <= 800 Mbps (got ${String(config.videoBitrate)})`, 'FORMAT');
    }
    if (config.audioBitrate !== undefined && normalizeBitrateBps(config.audioBitrate, 'audio') > 2_000_000) {
        throw new MediaForgeError(`'audioBitrate' must be <= 2 Mbps (got ${String(config.audioBitrate)})`, 'FORMAT');
    }
    for (const [key, v] of [
        ['videoCodec', config.videoCodec],
        ['audioCodec', config.audioCodec],
    ]) {
        if (v !== undefined && (typeof v !== 'string' || v.length === 0 || v.length > 64)) {
            throw new MediaForgeError(`'${key}' must be a non-empty string (got ${typeof v})`, 'FORMAT');
        }
    }
    if (config.onProgress !== undefined && typeof config.onProgress !== 'function') {
        throw new MediaForgeError(`'onProgress' must be a function (got ${typeof config.onProgress})`, 'FORMAT');
    }
    if (config.signal !== undefined && !(typeof AbortSignal !== 'undefined' && config.signal instanceof AbortSignal)) {
        throw new MediaForgeError(`'signal' must be an AbortSignal (got ${typeof config.signal})`, 'FORMAT');
    }
    if (config.audioTrackIndex !== undefined &&
        (typeof config.audioTrackIndex !== 'number' ||
            !Number.isInteger(config.audioTrackIndex) ||
            config.audioTrackIndex < 0)) {
        throw new MediaForgeError(`'audioTrackIndex' must be a non-negative integer (got ${String(config.audioTrackIndex)})`, 'FORMAT');
    }
    if (config.audioVbr !== undefined && typeof config.audioVbr !== 'boolean') {
        throw new MediaForgeError(`'audioVbr' must be a boolean (got ${typeof config.audioVbr})`, 'FORMAT');
    }
    const out = config.outputFormat;
    validateImageEncodingOptions(config, out);
    if (config.imageFit !== undefined) {
        if (!isImageFitMode(config.imageFit)) {
            throw new MediaForgeError('imageFit must be fill, inside or scale-down', 'FORMAT');
        }
        if (!IMAGE_FORMATS.has(out)) {
            throw new MediaForgeError('imageFit applies only to image output', 'FORMAT');
        }
    }
    if (config.imageResize !== undefined) {
        if (config.imageResize !== 'nearest' &&
            config.imageResize !== 'bilinear' &&
            config.imageResize !== 'lanczos3') {
            throw new MediaForgeError('imageResize must be nearest, bilinear or lanczos3', 'FORMAT');
        }
        if (!IMAGE_FORMATS.has(out)) {
            throw new MediaForgeError('imageResize applies only to image output', 'FORMAT');
        }
    }
    const audioCodecLc = config.audioCodec === undefined ? undefined : lcName(config.audioCodec);
    const videoCodecLc = config.videoCodec === undefined ? undefined : lcName(config.videoCodec);
    if (audioCodecLc && !codecShapeOk('audio', audioCodecLc)) {
        throw new MediaForgeError(`'audioCodec' '${config.audioCodec}' is not a recognised codec string - use e.g. 'aac', 'mp4a.40.2', 'opus', 'flac', 'mp3', 'ac-3'`, 'FORMAT');
    }
    if (videoCodecLc && !codecShapeOk('video', videoCodecLc)) {
        throw new MediaForgeError(`'videoCodec' '${config.videoCodec}' does not match any supported codec grammar - e.g. 'avc1.42c01e' (avc1/avc3 + 6 hex), 'vp8', 'vp09.00.10.08', 'av01.0.01M.08', 'hvc1.1.6.L93.B0'`, 'FORMAT');
    }
    if (config.audioVbr === true && out !== 'mp3') {
        throw new MediaForgeError(`'audioVbr' applies only to 'mp3' output (VBR lives in the MP3 encoder); it cannot apply to '${out}'`, 'FORMAT');
    }
    const fixedAudio = FIXED_AUDIO[out];
    if (audioCodecLc && fixedAudio && !fixedAudio(audioCodecLc)) {
        throw new MediaForgeError(PCM_AUDIO_FORMATS.has(out)
            ? `'audioCodec' cannot apply to '${out}' output: decoded PCM output has a fixed sample representation`
            : `'audioCodec' '${config.audioCodec}' cannot apply to '${out}' output (its audio codec is fixed)`, 'FORMAT');
    }
    if (out === 'flac' && config.audioBitrate) {
        throw new MediaForgeError(`'audioBitrate' cannot apply to 'flac' output: FLAC is lossless and has no rate control`, 'FORMAT');
    }
    if (IMAGE_FORMATS.has(out)) {
        if (config.fps !== undefined && out !== 'gif' && out !== 'apng') {
            throw new MediaForgeError(`'fps' cannot apply to still-image '${out}' output`, 'FORMAT');
        }
        if (config.videoBitrate) {
            throw new MediaForgeError(`'videoBitrate' cannot apply to '${out}' output: image and animation formats have no rate control, and an explicit value must not be silently ignored`, 'FORMAT');
        }
        if (config.audioBitrate) {
            throw new MediaForgeError(`'audioBitrate' cannot apply to '${out}' output: it carries no audio`, 'FORMAT');
        }
        if (config.audioSampleRate ||
            config.audioChannels ||
            config.audioCodec ||
            config.audioVbr ||
            config.audioTrackIndex !== undefined) {
            throw new MediaForgeError(`audio options ('audioSampleRate' / 'audioChannels' / 'audioCodec' / 'audioVbr' / 'audioTrackIndex') cannot apply to '${out}' output: it carries no audio`, 'FORMAT');
        }
        if (config.videoCodec) {
            throw new MediaForgeError(`'videoCodec' cannot apply to '${out}' output: the codec is fixed by the format`, 'FORMAT');
        }
    }
    if (AUDIO_ONLY.has(out)) {
        if (config.videoBitrate) {
            throw new MediaForgeError(`'videoBitrate' cannot apply to audio-only '${out}' output`, 'FORMAT');
        }
        if (config.width || config.height) {
            throw new MediaForgeError(`'width'/'height' cannot apply to audio-only '${out}' output`, 'FORMAT');
        }
        if (config.fps) {
            throw new MediaForgeError(`'fps' cannot apply to audio-only '${out}' output`, 'FORMAT');
        }
        if (config.videoCodec) {
            throw new MediaForgeError(`'videoCodec' cannot apply to audio-only '${out}' output`, 'FORMAT');
        }
    }
    if (PCM_AUDIO_FORMATS.has(out)) {
        if (config.audioBitrate) {
            throw new MediaForgeError(`'audioBitrate' cannot apply to '${out}' output: PCM output uses sample rate, channels and bit depth`, 'FORMAT');
        }
    }
    if (config.allowDomFallback !== undefined && typeof config.allowDomFallback !== 'boolean') {
        throw new MediaForgeError(`'allowDomFallback' must be a boolean (got ${typeof config.allowDomFallback})`, 'FORMAT');
    }
    const { maxAnimationPixels, ...otherConfig } = config;
    return {
        ...otherConfig,
        outputFormat: config.outputFormat,
        metadataPolicy: config.metadataPolicy ?? 'warn',
        maxAnimationPixels,
        audioCodec: audioCodecLc,
        videoCodec: videoCodecLc,
    };
}
