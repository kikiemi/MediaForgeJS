import type { Sink } from '../../core/model/types';
import type { ContainerWriterFactory, MuxerConfig } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { ElementaryStreamMuxer } from '../shared/elementary-stream';
import { IVF_HEADER_BYTES } from './reader';

/**
 * IVF writer for AV1, VP8 and VP9 frames; the frame count is patched at finalize when the sink
 * supports it.
 */
export class IvfMuxer extends ElementaryStreamMuxer {
    private readonly fourcc: string;
    private readonly width: number;
    private readonly height: number;
    private readonly timebaseNum: number;
    private readonly timebaseDen: number;
    private headerWritten = false;

    constructor(cfg: MuxerConfig, sink: Sink) {
        super('IVF', 'video', 'video', cfg, sink);
        const video = cfg.video!;
        const codec = video.codec.toLowerCase();
        this.fourcc = codec.startsWith('av01') ? 'AV01' : codec.startsWith('vp8') ? 'VP80' : 'VP90';
        if (
            !Number.isInteger(video.width) ||
            !Number.isInteger(video.height) ||
            video.width < 0 ||
            video.height < 0 ||
            video.width > 0xffff ||
            video.height > 0xffff
        )
            throw new MediaForgeError(
                'IVF frame dimensions must be integers up to 65535',
                'FORMAT',
            );

        this.width = video.width;
        this.height = video.height;

        const timescale = video.mediaTimescale;
        if (Number.isInteger(timescale) && timescale! > 0 && timescale! <= 0xffffffff) {
            this.timebaseNum = 1;
            this.timebaseDen = timescale!;
        } else if (
            Number.isInteger(video.framerate) &&
            video.framerate > 0 &&
            video.framerate <= 0xffffffff
        ) {
            this.timebaseNum = 1;
            this.timebaseDen = video.framerate;
        } else {
            this.timebaseNum = 1;
            this.timebaseDen = 1_000_000;
        }
    }

    protected write(chunk: EncodedPacket): void {
        if (chunk.trackType !== 'video')
            throw new MediaForgeError('IVF accepts video chunks only', 'MUX');
        const data = chunk.data;
        if (!(data instanceof Uint8Array))
            throw new MediaForgeError('IVF frame data must be a Uint8Array', 'MUX');
        if (data.length > 0xffffffff)
            throw new MediaForgeError('IVF frame exceeds the 32-bit size field', 'MUX');
        const ticks = Math.round((chunk.timestamp * this.timebaseDen) / this.timebaseNum);
        if (!Number.isSafeInteger(ticks) || ticks < 0)
            throw new MediaForgeError('IVF frame timestamp must be finite and non-negative', 'MUX');
        this.ensureHeader();
        const header = new Uint8Array(12);
        const view = new DataView(header.buffer);
        view.setUint32(0, data.length, true);
        view.setBigUint64(4, BigInt(ticks), true);
        this.sink.write(header);
        this.sink.write(new Uint8Array(data));
    }

    protected end(): void {
        if (!this.sink.patchAt) return;
        const count = new Uint8Array(4);
        new DataView(count.buffer).setUint32(0, Math.min(this.units, 0xffffffff), true);
        this.sink.patchAt(24, count);
    }

    private ensureHeader(): void {
        if (this.headerWritten) return;
        this.headerWritten = true;
        const header = new Uint8Array(IVF_HEADER_BYTES);
        const view = new DataView(header.buffer);
        header.set([0x44, 0x4b, 0x49, 0x46]);
        view.setUint16(4, 0, true);
        view.setUint16(6, IVF_HEADER_BYTES, true);
        for (let index = 0; index < 4; index++) header[8 + index] = this.fourcc.charCodeAt(index);
        view.setUint16(12, this.width, true);
        view.setUint16(14, this.height, true);
        view.setUint32(16, this.timebaseDen, true);
        view.setUint32(20, this.timebaseNum, true);
        view.setUint32(24, 0, true);
        this.sink.write(header);
    }
}

/** The ivf plugin's 'ivf' writer, which its index loads on first use. */
export const createIvfMuxer: ContainerWriterFactory = (config, sink) => new IvfMuxer(config, sink);
