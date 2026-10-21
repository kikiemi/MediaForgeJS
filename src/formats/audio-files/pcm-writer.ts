import type { OutputMuxer } from '../../core/contracts/writer';
import type { PcmAudioBuffer } from '../../core/model/media';

/** Optional PCM sink capability supplied by the selected container writer. */
interface PcmOutputMuxer extends OutputMuxer {
    addPcmBuffer(buffer: PcmAudioBuffer): void;
    addPcmPlanarChunk(
        planes: readonly Float32Array[],
        sampleRate: number,
        timestamp?: number,
    ): void;
}

export function isPcmOutputMuxer(muxer: OutputMuxer): muxer is PcmOutputMuxer {
    const candidate = muxer as Partial<PcmOutputMuxer>;
    return (
        typeof candidate.addPcmBuffer === 'function' &&
        typeof candidate.addPcmPlanarChunk === 'function'
    );
}
