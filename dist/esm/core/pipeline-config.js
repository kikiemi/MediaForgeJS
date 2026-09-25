import { normalizeMediaForgeConfig } from './converter-config.js';
import { MediaForgeError } from './errors.js';
import { CONTAINER_CODEC_PLANS } from './format-plans.js';
const PIPELINE_KEYS = new Set([
    'videoColour',
    'audioLanguage',
    'videoLanguage',
    'moovUserData',
    'audioTrackIndex',
    'videoCodecUserSet',
    'audioCodecUserSet',
    'videoCodecRequested',
    'audioCodecRequested',
    'preDemuxed',
    'preDemuxedError',
    'allowDomFallback',
    'outputFormat',
    'videoCodec',
    'audioCodec',
    'width',
    'height',
    'fps',
    'videoBitrate',
    'audioBitrate',
    'audioSampleRate',
    'audioChannels',
    'signal',
    'onProgress',
    'metadataPolicy',
]);
export function normalizePipelineConfig(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new MediaForgeError('Pipeline requires a config object', 'FORMAT');
    }
    const config = { ...input };
    for (const key of PIPELINE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(config, key))
            continue;
        const value = input[key];
        if (value !== undefined)
            Object.defineProperty(config, key, { value, enumerable: true, writable: true });
    }
    const normalized = normalizeMediaForgeConfig({
        outputFormat: config.outputFormat,
        metadataPolicy: config.metadataPolicy,
        videoCodec: config.videoCodec === '' ? undefined : config.videoCodec,
        audioCodec: config.audioCodec === '' ? undefined : config.audioCodec,
        width: config.width === 0 ? undefined : config.width,
        height: config.height === 0 ? undefined : config.height,
        fps: config.fps === 0 ? undefined : config.fps,
        videoBitrate: config.videoBitrate === 0 ? undefined : config.videoBitrate,
        audioBitrate: config.audioBitrate === 0 ? undefined : config.audioBitrate,
        audioSampleRate: config.audioSampleRate === 0 ? undefined : config.audioSampleRate,
        audioChannels: config.audioChannels === 0 ? undefined : config.audioChannels,
        audioTrackIndex: config.audioTrackIndex,
        allowDomFallback: config.allowDomFallback,
        signal: config.signal,
        onProgress: config.onProgress,
    });
    if (!CONTAINER_CODEC_PLANS[config.outputFormat]) {
        throw new MediaForgeError(`Pipeline does not support '${config.outputFormat}' output; use MediaForgeConverter`, 'FORMAT');
    }
    for (const key of ['videoCodecUserSet', 'audioCodecUserSet']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') {
            throw new MediaForgeError(`${key} must be a boolean`, 'FORMAT');
        }
    }
    for (const key of ['audioLanguage', 'videoLanguage', 'videoCodecRequested', 'audioCodecRequested']) {
        if (config[key] !== undefined && typeof config[key] !== 'string') {
            throw new MediaForgeError(`${key} must be a string`, 'FORMAT');
        }
    }
    if (config.videoColour !== undefined) {
        const value = config.videoColour;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new MediaForgeError('videoColour must be an object', 'FORMAT');
        }
        const colour = {
            primaries: value.primaries,
            transfer: value.transfer,
            matrix: value.matrix,
            fullRange: value.fullRange,
        };
        for (const key of ['primaries', 'transfer', 'matrix']) {
            if (!Number.isInteger(colour[key]) || colour[key] < 0 || colour[key] > 65535) {
                throw new MediaForgeError(`videoColour.${key} must be an integer in 0..65535`, 'FORMAT');
            }
        }
        if (typeof colour.fullRange !== 'boolean')
            throw new MediaForgeError('videoColour.fullRange must be a boolean', 'FORMAT');
        config.videoColour = colour;
    }
    if (config.moovUserData !== undefined) {
        if (!(config.moovUserData instanceof Uint8Array))
            throw new MediaForgeError('moovUserData must be a Uint8Array', 'FORMAT');
        config.moovUserData = new Uint8Array(config.moovUserData);
    }
    return {
        ...config,
        outputFormat: normalized.outputFormat,
        metadataPolicy: normalized.metadataPolicy,
        videoCodec: normalized.videoCodec ?? '',
        audioCodec: normalized.audioCodec ?? '',
        videoCodecUserSet: config.videoCodecUserSet ?? !!config.videoCodec,
        audioCodecUserSet: config.audioCodecUserSet ?? !!config.audioCodec,
        videoCodecRequested: config.videoCodecRequested ?? (config.videoCodec || undefined),
        audioCodecRequested: config.audioCodecRequested ?? (config.audioCodec || undefined),
        width: normalized.width ?? 0,
        height: normalized.height ?? 0,
        fps: normalized.fps ?? 0,
        videoBitrate: normalized.videoBitrate ?? 0,
        audioBitrate: normalized.audioBitrate ?? 0,
        audioSampleRate: normalized.audioSampleRate ?? 0,
        audioChannels: normalized.audioChannels ?? 0,
    };
}
