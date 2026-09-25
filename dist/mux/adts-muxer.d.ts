import type { Sink } from '../types/io.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
/** Raw ADTS (.aac) writer. */
export declare class ADTSMuxer implements AudioOutputMuxer {
    private chunkCount;
    private readonly sink;
    private readonly configuration;
    private finalized;
    constructor(sink: Sink, sampleRate: number, channels: number);
    /** Appends one encoded audio chunk; `codecConfig` on the first call carries decoder configuration where the container stores it. */
    addAudioChunk(chunk: EncodedChunk): void;
    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    finalize(): Promise<void>;
    private wrapFrame;
}
