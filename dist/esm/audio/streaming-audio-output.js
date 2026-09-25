import { createStreamingAudioOutput } from './streaming-audio-output-core.js';
import { StreamingAacLcEncoder } from './aac-encoder.js';
import { StreamingFlacEncoder } from './flac-encoder.js';
import { StreamingMp2Encoder } from './mp2-encoder.js';
import { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize } from './mp3/engine.js';
const output = createStreamingAudioOutput({
    aac: StreamingAacLcEncoder,
    flac: StreamingFlacEncoder,
    mp2: StreamingMp2Encoder,
    mp3: { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize },
});
export const { streamReplayableAac, encodeReplayablePcm, encodeReplayablePcmToSink } = output;
