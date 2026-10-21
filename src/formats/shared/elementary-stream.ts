import type { Sink } from '../../core/model/types';
import type { MuxerConfig, OutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { assertMuxCodec } from './capabilities';
import { assertOpen } from './chunk-checks';
import { assertSink } from '../../core/io/sinks/sink-backpressure';

/**
 * A writer of one track as its elementary stream (IVF, IAMF, APV): the track's units one after
 * another, each framed as the format frames it, then the sink closed. The base takes the sink and
 * the one track of its kind, refuses chunks of the other kind, counts the units and closes the
 * sink; a format frames each unit (write()) and may finish the stream before the sink closes
 * (end()).
 */
export abstract class ElementaryStreamMuxer implements OutputMuxer {
    protected readonly sink: Sink;
    /** Units written so far. */
    protected units = 0;
    private finalized = false;

    /**
     * `name` names the format in messages and `unit` its units: the codec, or the kind of track
     * when the format carries several codecs.
     */
    constructor(
        private readonly name: string,
        private readonly unit: string,
        private readonly kind: 'audio' | 'video',
        cfg: MuxerConfig,
        sink: Sink,
    ) {
        assertSink(sink);
        const track = cfg[kind];
        if (
            !track ||
            cfg[kind === 'audio' ? 'video' : 'audio'] ||
            cfg.extraAudioTracks?.length ||
            cfg.extraVideoTracks?.length ||
            cfg.subtitleTracks?.length
        )
            throw new MediaForgeError(`${name} carries exactly one ${unit} track`, 'FORMAT');
        assertMuxCodec(name.toLowerCase(), kind, track.codec);
        this.sink = sink;
    }

    /** Writes one unit as the format frames it. */
    protected abstract write(chunk: EncodedPacket, codecConfig?: Uint8Array): void;

    /** Finishes the stream before the sink closes. */
    protected end(): void {}

    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.add('video', chunk, codecConfig);
    }

    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.add('audio', chunk, codecConfig);
    }

    private add(kind: 'audio' | 'video', chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        if (kind !== this.kind)
            throw new MediaForgeError(`${this.name} carries no ${kind}`, 'FORMAT');
        assertOpen(this.finalized);
        this.write(chunk, codecConfig);
        this.units++;
    }

    async finalize(): Promise<void> {
        assertOpen(this.finalized);
        this.finalized = true;
        if (this.units === 0)
            throw new MediaForgeError(`finalize with no ${this.unit} chunks`, 'MUX');
        this.end();
        await this.sink.close();
    }
}
