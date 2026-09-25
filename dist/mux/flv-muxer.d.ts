import type { Sink } from '../types/io.js';
import type { MuxerConfig, OutputMuxer } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
/** FLV muxer (AVC + AAC, onMetaData duration write-back). */
export declare class FLVMuxer implements OutputMuxer {
    private videoChunkCount;
    private audioChunkCount;
    private readonly sink;
    private readonly cfg;
    private headerWritten;
    private prevTagSize;
    private lastVideoConfig?;
    private lastAudioConfig?;
    private timelineOffsetSeconds;
    private lastVideoDtsMs;
    private lastAudioDtsMs;
    private bytesWritten;
    /** Absolute offset of the 8-byte duration double inside onMetaData. */
    private durationPatchOffset;
    private presentationEndSec;
    private finalized;
    constructor(cfg: MuxerConfig, sink: Sink);
    /** Appends one encoded video chunk; `codecConfig` on the first call carries the decoder configuration record. */
    addVideoChunk(chunk: EncodedChunk, codecCfg?: Uint8Array): void;
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(chunk: EncodedChunk, codecConfig?: Uint8Array): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private assertOpen;
    private ensureHeader;
    private write;
    private writeMetaDataTag;
    private defaultAudioConfig;
    private aacSoundHeader;
    private videoDecodeTimestamp;
    private shiftedTimestampMs;
    private writeTag;
}
