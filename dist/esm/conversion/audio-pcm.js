import { createPcmTrackSource } from '../audio/pcm-track-source.js';
import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
const output = createStreamingAudioOutput();
export const pcmAudio = Object.freeze({
    codecs: Object.freeze(['pcm']),
    outputs: Object.freeze(['wav', 'aiff', 'au', 'caf']),
    decode: (track, read, config) => createPcmTrackSource(track, read, config.signal),
    async encode(source, format, sink, config) {
        await output.encodeReplayablePcmToSink(source, format, sink, {
            signal: config.signal,
            onProgress: (fraction, message) => config.onProgress?.(fraction * 100, message),
        });
    },
});
