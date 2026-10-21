import type { Sink } from '../../core/model/types';
import type { ContainerWriterFactory, MuxerConfig } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { ElementaryStreamMuxer } from '../shared/elementary-stream';
import { APV_SIGNATURE } from './access-unit';

/** Raw APV writer of one copied APV track: each access unit after its 32-bit size. */
export class ApvMuxer extends ElementaryStreamMuxer {
    constructor(cfg: MuxerConfig, sink: Sink) {
        super('APV', 'APV', 'video', cfg, sink);
    }

    protected write(chunk: EncodedPacket): void {
        const data = chunk.data;
        const signed =
            data instanceof Uint8Array &&
            data.length >= 4 &&
            new DataView(data.buffer, data.byteOffset, 4).getUint32(0) === APV_SIGNATURE;
        if (!signed) throw new MediaForgeError('APV packets must be access units', 'MUX');
        const size = new Uint8Array(4);
        new DataView(size.buffer).setUint32(0, data.length);
        this.sink.write(size);
        this.sink.write(new Uint8Array(data));
    }
}

/** The apv plugin's 'apv' writer, which its index loads on first use. */
export const createApvMuxer: ContainerWriterFactory = (config, sink) => new ApvMuxer(config, sink);
