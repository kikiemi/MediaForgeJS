import type { Sink } from '../types/io.js';
import type { MuxerConfig, OutputMuxer } from '../types/container.js';
import type { EncodedChunk, PcmAudioBuffer } from '../types/media.js';
/** AVI muxer (strl-ordered streams, explicit 4 GiB limit). */
export declare class AVIMuxer implements OutputMuxer {
    private static readonly START_CODE;
    private readonly sink;
    private readonly cfg;
    private finalized;
    private videoChunks;
    /** Running payload total, checked against the classic-AVI 4 GiB limit. */
    private payloadBytes;
    private audioChunks;
    private codecConfig?;
    private annexBCodecConfig?;
    private nalLengthSize?;
    private observedAudioSampleRate?;
    private observedAudioChannels?;
    private readonly streaming;
    private streamingStarted;
    private streamingHdrlOffset;
    private streamingHdrlLength;
    private streamingMoviSizeOffset;
    private streamingMoviBytes;
    private readonly streamingIndex;
    private streamingVideoFrames;
    private streamingAudioFrames;
    private streamingMaxChunk;
    private streamingMaxVideoChunk;
    private streamingMaxAudioChunk;
    private streamingMediaBytes;
    private streamingFirstVideo;
    private streamingFirstAudio;
    private streamingVideoEnd;
    private streamingAudioEnd;
    private streamingNextVideoTs;
    private streamingNextAudioTs;
    constructor(cfg: MuxerConfig, sink: Sink);
    /** Appends one encoded video chunk; `codecConfig` on the first call carries the decoder configuration record. */
    addVideoChunk(c: EncodedChunk, cfg?: Uint8Array): void;
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(c: EncodedChunk): void;
    private checkPayloadSize;
    private assertOpen;
    private validateBytes;
    private validateEnd;
    private u32;
    private validateTrackConfig;
    private validateAudioShape;
    private validatePCMShape;
    private writeSink;
    private u32le;
    private startStreaming;
    private checkStreamingCounters;
    private appendStreamingChunk;
    /** Appends raw PCM from a PcmAudioBuffer as the audio stream (no encoder involved). */
    addPCMBuffer(buf: PcmAudioBuffer): void;
    /** Appends one bounded planar PCM work unit as signed 16-bit AVI audio. */
    addPCMPlanarChunk(planes: readonly Float32Array[], sampleRate: number, timestamp?: number): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private finalizeStreaming;
    private buildMovi;
    private mergePreparedChunks;
    private prepareVideoChunks;
    private prepareAudioChunks;
    private buildIdx1;
    private buildHdrl;
    private buildAvih;
    private buildVideoStream;
    private buildAudioStream;
    private wrapChunk;
    private wrapList;
    private getVideoRateScale;
    private getConfiguredOrEstimatedVideoFps;
    private estimateVideoFpsFromChunks;
    private fpsToAviRateScale;
    private gcd;
    private getVideoWidth;
    private getVideoHeight;
    private getAudioSampleRate;
    private getAudioChannelCount;
    private getAudioBlockAlign;
    private getAudioBytesPerSec;
    private getAudioChunkSampleFrames;
    private prepareCodecConfig;
    private normalizeH264Chunk;
    private parseAvcDecoderConfigurationRecord;
    private guessAvccNalLengthSize;
    private looksLikeAvccSample;
    private convertAvccSampleToAnnexB;
    private chunkHasSpsPps;
    private findStartCode;
    private concatBytes;
    private concatMany;
    private isFinitePositive;
    private isFiniteNonNegative;
}
