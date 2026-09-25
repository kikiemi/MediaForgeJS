import type { Sink } from '../types/io.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
/** Native FLAC container writer (STREAMINFO + frames from the built-in encoder). */
export declare class FLACMuxer implements AudioOutputMuxer {
    private chunkCount;
    private readonly sink;
    private readonly sampleRate;
    private readonly channels;
    private readonly bitsPerSample;
    private codecConfig;
    private headerWritten;
    private finalized;
    private fallbackShortFrameSeen;
    private busy;
    private failure?;
    constructor(sink: Sink, sampleRate: number, channels: number, bitsPerSample?: number, codecConfig?: Uint8Array);
    /** Provide the encoder stream header; effective until the first chunk is written. */
    setCodecConfig(codecConfig: Uint8Array): void;
    /** AudioOutputMuxer capability name; retained alongside the legacy alias. */
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private assertOpen;
    private validateCodecConfig;
    private validateFallbackFrame;
    private writeHeader;
}
