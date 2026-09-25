import type { Sink } from '../types/io.js';
import type { MuxerConfig, OutputMuxer } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
/** MPEG-TS muxer (PAT/PMT/PCR cadence, ADTS-wrapped AAC). */
export declare class TSMuxer implements OutputMuxer {
    private videoChunkCount;
    private readonly audioStreams;
    private readonly pat;
    private readonly pmt;
    private readonly sink;
    private readonly cfg;
    private headerWritten;
    private cc;
    private videoConfigCache;
    constructor(cfg: MuxerConfig, sink: Sink);
    /** Appends one encoded video chunk; `codecConfig` on the first call carries the decoder configuration record. */
    addVideoChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    addExtraAudioChunk(index: number, chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    private addAudio;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private normalizeVideoPayload;
    private withParamSets;
    private videoConfigFor;
    private lastPsiTicks;
    private lastPcrTicks;
    private ensureHeader;
    private maybeRepeatTables;
    private pcrPid;
    private nextCC;
    private videoStreamType;
    private audioStreamType;
    private normalizeAacPayload;
    private buildPAT;
    private buildPMT;
    private writeTable;
    private writePcrOnly;
    private bridgeCadence;
    private packetize;
}
