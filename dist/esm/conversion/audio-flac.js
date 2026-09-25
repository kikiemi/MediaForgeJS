import { StreamingFlacEncoder } from '../audio/flac-encoder.js';
import { createWebCodecsTrackPcmSource } from '../audio/webcodecs-pcm-source.js';
import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
const output = createStreamingAudioOutput({ flac: StreamingFlacEncoder });
export const flacAudio = Object.freeze({
    codecs: Object.freeze(['flac']),
    outputs: Object.freeze(['flac']),
    decode: (track, read, config) => createWebCodecsTrackPcmSource(track, read, config.signal),
    async encode(source, _format, sink, config) {
        await output.encodeReplayablePcmToSink(source, 'flac', sink, {
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
