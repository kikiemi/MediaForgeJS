import type { Sink } from '../types/io.js';
import type { AudioOutputMuxer } from '../types/container.js';
import type { EncodedChunk, PcmAudioBuffer } from '../types/media.js';
/** Writes encoded audio chunks verbatim (mp3/mp2 elementary streams). */
export declare class RawMuxer implements AudioOutputMuxer {
    private readonly output;
    constructor(sink: Sink);
    addAudioChunk(chunk: EncodedChunk): void;
    finalize(): Promise<void>;
}
export declare function createWavHeader(sampleRate: number, channels: number, totalBytes: number): Uint8Array;
/** Buffers PCM16 WAV data; finalize writes the header and drains each retained block. */
export declare class WAVMuxer {
    private readonly sampleRate;
    private readonly channels;
    private readonly output;
    private pcmData;
    private totalBytes;
    constructor(sink: Sink, sampleRate: number, channels: number);
    /** Copies complete interleaved signed PCM16 little-endian frames. */
    addPCMData(data: Uint8Array): void;
    addAudioBuffer(buffer: PcmAudioBuffer): void;
    /** Converts PCM cooperatively; rejected or cancelled input is never partially appended. */
    addAudioBufferChunked(buffer: PcmAudioBuffer, signal?: AbortSignal): Promise<void>;
    finalize(): Promise<void>;
    private validateAdditionalBytes;
    private readPlanes;
    private validatePlanes;
    private encodeFrames;
    private commit;
}
