import type { Sink } from '../../core/model/types';
import type { ContainerWriterFactory, MuxerConfig } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { iamfDescription } from '../../core/codec-config/audio/iamf';
import { ElementaryStreamMuxer } from '../shared/elementary-stream';

/**
 * Raw IAMF writer of one copied IAMF track: its descriptors (the track's configuration), then each
 * packet's temporal unit as it is.
 */
export class IamfMuxer extends ElementaryStreamMuxer {
    private descriptors: Uint8Array | undefined;

    constructor(cfg: MuxerConfig, sink: Sink) {
        super('IAMF', 'IAMF', 'audio', cfg, sink);
        this.descriptors = cfg.audio!.codecConfig;
    }

    protected write(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        if (!(chunk.data instanceof Uint8Array))
            throw new MediaForgeError('IAMF temporal units must be Uint8Arrays', 'MUX');
        if (!this.units) {
            const descriptors = this.descriptors ?? codecConfig;
            if (!descriptors || !iamfDescription(descriptors))
                throw new MediaForgeError(
                    'IAMF output needs the IA sequence descriptors',
                    'FORMAT',
                );
            this.sink.write(new Uint8Array(descriptors));
        }
        this.sink.write(new Uint8Array(chunk.data));
    }

    setAudioCodecConfig(codecConfig: Uint8Array): void {
        this.descriptors = codecConfig;
    }
}

/** The iamf plugin's 'iamf' writer, which its index loads on first use. */
export const createIamfMuxer: ContainerWriterFactory = (config, sink) =>
    new IamfMuxer(config, sink);
