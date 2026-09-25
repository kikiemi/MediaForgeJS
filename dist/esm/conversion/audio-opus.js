import { createWebCodecsTrackPcmSource } from '../audio/webcodecs-pcm-source.js';
import { encodeReplayableOpusToSink } from '../audio/streaming-opus-output.js';
import { normalizePcmSource } from '../audio/pcm-source.js';
import { MediaForgeError, normalizeBitrateBps } from '../core/errors.js';
export const opusAudio = Object.freeze({
    codecs: Object.freeze(['opus']),
    outputs: Object.freeze(['ogg']),
    decode: (track, read, config) => createWebCodecsTrackPcmSource(track, read, config.signal),
    async encode(source, _format, sink, config) {
        if (config.audioSampleRate !== undefined && config.audioSampleRate !== 48000) {
            throw new MediaForgeError('Opus encodes at 48000 Hz only', 'FORMAT');
        }
        if (config.audioChannels !== undefined && config.audioChannels > 2)
            throw new MediaForgeError('Opus output supports 1-2 channels', 'FORMAT');
        await encodeReplayableOpusToSink(normalizePcmSource(source, 48000, Math.min(2, source.channels)), sink, {
            bitrateBps: normalizeBitrateBps(config.audioBitrate, 'audio') || 128000,
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
