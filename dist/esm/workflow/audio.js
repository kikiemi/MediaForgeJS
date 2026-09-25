import { createWorkflowAudio } from './audio-core.js';
import { StreamingAacLcEncoder } from '../audio/aac-encoder.js';
import { StreamingFlacEncoder } from '../audio/flac-encoder.js';
import { StreamingMp2Encoder } from '../audio/mp2-encoder.js';
import { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize } from '../audio/mp3/engine.js';
export const nativeAudio = createWorkflowAudio({
    aac: StreamingAacLcEncoder,
    flac: StreamingFlacEncoder,
    mp2: StreamingMp2Encoder,
    mp3: { Mp3LevelAnalyzer, Mp3PlanAnalyzer, StreamingMp3Encoder, mp3GaplessInfoFrameSize },
});
