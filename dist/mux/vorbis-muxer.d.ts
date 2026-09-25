import type { Sink } from '../types/io.js';
import type { EncodedChunk } from '../types/media.js';
import type { AudioTrackConfig, AudioOutputMuxer } from '../types/container.js';
/** Copies one continuous Vorbis stream; configuration is Matroska/Xiph-laced three-header data. */
export declare class VorbisMuxer implements AudioOutputMuxer {
    private readonly sink;
    private readonly headers;
    private readonly rate;
    private readonly modes;
    private readonly smallBlock;
    private readonly largeBlock;
    private sequence;
    private readonly serial;
    private pending?;
    private previousEnd?;
    private granule;
    private validSamples?;
    private started;
    private finished;
    private busy;
    private failure?;
    constructor(sink: Sink, track: AudioTrackConfig);
    setValidSamples(samples: number): void;
    addAudioChunk(chunk: EncodedChunk): void;
    finalize(): Promise<void>;
    private assertOpen;
    private checkAbort;
    private writePacket;
}
