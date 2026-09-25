import { MediaForgeError } from '../core/errors.js';
import { getAdtsConfiguration, getAdtsFrameLength, writeAdtsHeader } from '../audio/adts.js';
export class ADTSMuxer {
    chunkCount = 0;
    sink;
    configuration;
    finalized = false;
    constructor(sink, sampleRate, channels) {
        if (!sink || typeof sink.write !== 'function' || typeof sink.close !== 'function') {
            throw new MediaForgeError('ADTS output requires a writable and closeable sink', 'MUX');
        }
        this.sink = sink;
        this.configuration = getAdtsConfiguration(sampleRate, channels, 'MUX');
    }
    addAudioChunk(chunk) {
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addAudioChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        this.sink.write(this.wrapFrame(chunk.data));
        this.chunkCount++;
    }
    async finalize() {
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.chunkCount === 0) {
            throw new MediaForgeError('finalize with no audio chunks', 'MUX');
        }
        this.finalized = true;
        await this.sink.close();
    }
    wrapFrame(aac) {
        const frameLength = getAdtsFrameLength(aac, 'MUX');
        const frame = new Uint8Array(frameLength);
        writeAdtsHeader(frame, 0, frameLength, this.configuration);
        frame.set(aac, 7);
        return frame;
    }
}
