import { MediaForgeError } from '../core/errors.js';
import { assertAbortSignal } from '../core/abort.js';
export const audioFormats = ['wav', 'aiff', 'au', 'caf', 'flac', 'aac', 'mp2', 'mp3'];
export function checkSignal(signal) {
    assertAbortSignal(signal);
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
export function snapshotRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new MediaForgeError('Expected a workflow request', 'INPUT');
    const { operation, signal, onProgress } = request;
    checkSignal(signal);
    if (onProgress !== undefined && typeof onProgress !== 'function')
        throw new MediaForgeError('onProgress must be a function', 'INPUT');
    if (operation === 'remux') {
        const { format, mp4Mode, trackIds, targetDuration, maxBufferedBytes, maxBufferedSamples, requireKeyframe } = request;
        return {
            operation,
            format,
            mp4Mode,
            trackIds: Array.isArray(trackIds) ? trackIds.slice() : trackIds,
            targetDuration,
            maxBufferedBytes,
            maxBufferedSamples,
            requireKeyframe,
            signal,
            onProgress: onProgress,
        };
    }
    if (operation === 'convert') {
        const { format, videoCodec, audioCodec, width, height, fps, videoBitrate, allowPrecisionLoss, audioBitrate, audioSampleRate, audioChannels, trackIds, } = request;
        if (typeof format !== 'string' ||
            !format ||
            [videoCodec, audioCodec].some(value => value !== undefined && (typeof value !== 'string' || !value)) ||
            [width, height, videoBitrate, audioBitrate, audioSampleRate, audioChannels].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
            (fps !== undefined && (!Number.isFinite(fps) || fps < 0)) ||
            (allowPrecisionLoss !== undefined && typeof allowPrecisionLoss !== 'boolean') ||
            (trackIds !== undefined &&
                (!Array.isArray(trackIds) ||
                    !trackIds.length ||
                    new Set(trackIds).size !== trackIds.length ||
                    trackIds.some(id => !Number.isSafeInteger(id) || id < 1))))
            throw new MediaForgeError('Invalid native conversion options', 'INPUT');
        return {
            operation,
            format,
            videoCodec,
            audioCodec,
            width,
            height,
            fps,
            videoBitrate,
            allowPrecisionLoss,
            audioBitrate,
            audioSampleRate,
            audioChannels,
            trackIds: trackIds?.slice(),
            signal,
            onProgress: onProgress,
        };
    }
    if (operation !== 'audio')
        throw new MediaForgeError('Workflow operation must be remux, audio or convert', 'INPUT');
    const { format, trackId, sampleRate, channels, bitrateKbps, vbr, allowPrecisionLoss, start, end } = request;
    if (!audioFormats.includes(format))
        throw new MediaForgeError('Unsupported native audio output', 'FORMAT');
    if ((trackId !== undefined && (!Number.isSafeInteger(trackId) || trackId < 1)) ||
        (sampleRate !== undefined && (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000)) ||
        (channels !== undefined && (!Number.isInteger(channels) || channels < 1 || channels > 2)) ||
        (bitrateKbps !== undefined && (!Number.isInteger(bitrateKbps) || bitrateKbps < 1)) ||
        (vbr !== undefined && typeof vbr !== 'boolean') ||
        (allowPrecisionLoss !== undefined && typeof allowPrecisionLoss !== 'boolean') ||
        (start !== undefined && (!Number.isFinite(start) || start < 0)) ||
        (end !== undefined && (!Number.isFinite(end) || end <= (start ?? 0))))
        throw new MediaForgeError('Invalid native audio options', 'INPUT');
    return {
        operation,
        format,
        trackId,
        sampleRate,
        channels,
        bitrateKbps,
        vbr,
        allowPrecisionLoss,
        start,
        end,
        signal,
        onProgress: onProgress,
    };
}
export function outputLimit(options, fallback = 256 * 1024 * 1024) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected output options', 'INPUT');
    const limit = options.maxBytes ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < 1)
        throw new MediaForgeError('maxBytes must be a positive safe integer', 'INPUT');
    return limit;
}
