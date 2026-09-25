import { assertAudioEncodeRequest } from '../core/format-plans.js';
import { StreamingAacLcEncoder } from '../audio/aac-encoder.js';
import { createConfiguredAacTrackPcmSource } from '../audio/aac-track-decoder.js';
import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
import { normalizeBitrateBps } from '../core/errors.js';
const output = createStreamingAudioOutput({ aac: StreamingAacLcEncoder });
export const aacAudio = Object.freeze({
    codecs: Object.freeze(['aac']),
    outputs: Object.freeze(['aac']),
    decode: (track, read, config) => createConfiguredAacTrackPcmSource(track, read, { signal: config.signal }),
    async encode(source, _format, sink, config) {
        assertAudioEncodeRequest(config.audioCodec || 'mp4a.40.2');
        await output.encodeReplayablePcmToSink(source, 'aac', sink, {
            bitrateKbps: Math.round((normalizeBitrateBps(config.audioBitrate, 'audio') || 128000) / 1000),
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
