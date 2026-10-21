import type { Sink } from '../../core/model/types';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import {
    getAdtsConfiguration,
    getAdtsFrameLength,
    writeAdtsHeader,
    type AdtsConfiguration,
} from '../../core/codec-config/audio/adts';
import { assertOpen, checkChunk } from '../shared/chunk-checks';
import { assertSink } from '../../core/io/sinks/sink-backpressure';

/** Raw ADTS (.aac) writer. */
export class AdtsMuxer implements AudioOutputMuxer {
    private chunkCount = 0;
    private readonly sink: Sink;
    private readonly configuration: AdtsConfiguration;
    private finalized = false;

    constructor(sink: Sink, sampleRate: number, channels: number) {
        assertSink(sink);
        this.sink = sink;
        this.configuration = getAdtsConfiguration(sampleRate, channels, 'FORMAT');
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket): void {
        checkChunk('addAudioChunk', chunk, 'audio', this.finalized);
        this.sink.write(this.wrapFrame(chunk.data));
        this.chunkCount++;
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        assertOpen(this.finalized);
        if (this.chunkCount === 0) {
            throw new MediaForgeError('finalize with no audio chunks', 'MUX');
        }
        this.finalized = true;
        await this.sink.close();
    }

    private wrapFrame(aac: Uint8Array): Uint8Array {
        const frameLength = getAdtsFrameLength(aac, 'MUX');
        const frame = new Uint8Array(frameLength);
        writeAdtsHeader(frame, 0, frameLength, this.configuration);
        frame.set(aac, 7);
        return frame;
    }
}
