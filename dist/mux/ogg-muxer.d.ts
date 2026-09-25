import type { Sink } from '../types/io.js';
import type { MuxerConfig, AudioOutputMuxer } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
/** Ogg/Opus muxer (pre-skip, granule trimming via setValidSamples, OpusTags). */
export declare class OGGMuxer implements AudioOutputMuxer {
    private finalizedFlag;
    private failed;
    private failure;
    private writing;
    private validSamples;
    /** Exact source length in 48 kHz samples; the last granule clamps to it. */
    setValidSamples(samples: number): void;
    private readonly sink;
    private readonly channelCount;
    private readonly inputSampleRate;
    private readonly commentPayload;
    private codecConfig;
    private readonly serialNumber;
    private pendingChunk;
    private headersWritten;
    private samplePosition;
    private preSkip;
    private pageSequenceNumber;
    private pageSegments;
    private pageParts;
    private pageGranule;
    private writtenGranule;
    constructor(cfg: MuxerConfig, sink: Sink);
    /** Provide the encoder's OpusHead; used when building the ID header. */
    setCodecConfig(codecConfig: Uint8Array): void;
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    /** Always throws: Ogg output is audio-only here. */
    addVideoChunk(): void;
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private assertOpen;
    private fail;
    private writePage;
    private writeHeaders;
    private packetSamples;
    private audioGranule;
    private writeAudioPacket;
    private resolveOpusIdHeader;
    private validateOpusIdHeader;
    private queuePacket;
    private flushPage;
    private buildOpusIdHeader;
    private buildOpusCommentHeader;
    private writePacket;
    private buildLacingValues;
    private buildPage;
}
