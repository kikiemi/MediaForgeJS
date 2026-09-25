import { StreamingMp2Encoder } from '../audio/mp2-encoder.js';
import { createMpegTrackPcmSource } from '../audio/mpeg-track-pcm-source.js';
import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
import { normalizeBitrateBps } from '../core/errors.js';
const output = createStreamingAudioOutput({ mp2: StreamingMp2Encoder });
export const mp2Audio = Object.freeze({
    codecs: Object.freeze(['mp1', 'mp2']),
    outputs: Object.freeze(['mp2']),
    decode: (track, read, config) => createMpegTrackPcmSource(track, read, config.signal),
    async encode(source, _format, sink, config) {
        await output.encodeReplayablePcmToSink(source, 'mp2', sink, {
            bitrateKbps: Math.round((normalizeBitrateBps(config.audioBitrate, 'audio') || (source.channels === 1 ? 192000 : 256000)) / 1000),
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
