import type { OutputMuxer } from '../types/container.js';
import type { PcmAudioBuffer } from '../types/media.js';
/** Optional PCM sink capability supplied by the selected container writer. */
export interface PcmOutputMuxer extends OutputMuxer {
    addPCMBuffer(buffer: PcmAudioBuffer): void;
    addPCMPlanarChunk(planes: readonly Float32Array[], sampleRate: number, timestamp?: number): void;
}
export declare function isPcmOutputMuxer(muxer: OutputMuxer): muxer is PcmOutputMuxer;
