import { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize } from '../audio/mp3/engine.js';
import { createWebCodecsTrackPcmSource } from '../audio/webcodecs-pcm-source.js';
import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
import { normalizeBitrateBps } from '../core/errors.js';
const output = createStreamingAudioOutput({
    mp3: { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize },
});
export const mp3Audio = Object.freeze({
    codecs: Object.freeze(['mp3']),
    outputs: Object.freeze(['mp3']),
    decode: (track, read, config) => createWebCodecsTrackPcmSource(track, read, config.signal),
    async encode(source, _format, sink, config) {
        await output.encodeReplayablePcmToSink(source, 'mp3', sink, {
            bitrateKbps: Math.round((normalizeBitrateBps(config.audioBitrate, 'audio') || 256000) / 1000),
            vbr: config.audioVbr,
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
