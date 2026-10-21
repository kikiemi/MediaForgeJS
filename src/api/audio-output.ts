import { createStreamingAudioOutput } from '../pipeline/codecs/streaming-audio-output-core';
import { lazyAudioEncoder } from '../codecs/shared/lazy-audio-encoder';
export type {
    StreamingSelfHostedAudioFormat,
    StreamingAudioDiagnostics,
    StreamingAudioEncodeOptions,
    StreamingAacResult,
} from '../pipeline/codecs/audio-output-types';

// Each encoder loads with the first output in its format.
const output = createStreamingAudioOutput({
    aac: lazyAudioEncoder(
        async () => (await import('../codecs/aac/encoder')).StreamingAacLcEncoder,
    ),
    flac: lazyAudioEncoder(
        async () => (await import('../codecs/flac/encoder')).StreamingFlacEncoder,
    ),
    mp2: lazyAudioEncoder(
        async () => (await import('../codecs/mpeg-audio/mp2-encoder')).StreamingMp2Encoder,
    ),
    mp3: lazyAudioEncoder(
        async () => (await import('../codecs/mpeg-audio/mp3-encoder')).StreamingMp3Encoder,
    ),
});
export const { streamReplayableAac, encodeReplayablePcm, encodeReplayablePcmToSink } = output;
