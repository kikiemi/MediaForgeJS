import { assertAudioEncodeRequest } from '../core/format-plans.js';
import { encodeReplayableM4AToSink } from '../audio/streaming-m4a-output.js';
import { normalizeBitrateBps } from '../core/errors.js';
export const m4aAudio = Object.freeze({
    codecs: Object.freeze([]),
    outputs: Object.freeze(['m4a']),
    async encode(source, _format, sink, config, metadata) {
        assertAudioEncodeRequest(config.audioCodec || 'mp4a.40.2');
        await encodeReplayableM4AToSink(source, sink, {
            bitrateKbps: Math.round((normalizeBitrateBps(config.audioBitrate, 'audio') || 128000) / 1000),
            audioLanguage: metadata?.language,
            title: metadata?.movieTitle,
            audioTrack: metadata,
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
