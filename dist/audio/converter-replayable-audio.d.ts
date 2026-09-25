import type { ContainerFormat } from '../types/media.js';
import type { MediaForgeJSConfig } from '../core/converter-config.js';
import type { CarriedMetadata } from '../core/converter-context.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
import type { Sink } from '../types/io.js';
export interface ConverterReplayableAudioHost {
    getCarried(): CarriedMetadata;
    getDemuxed?(file: Blob): MP4DemuxResult | undefined;
    audioBitrateBps(): number;
    requestedAacCodec(): string;
}
/** Seekable input routes that avoid constructing a duration-sized AudioBuffer. */
export declare class ConverterReplayableAudio {
    private readonly config;
    private readonly host;
    constructor(config: MediaForgeJSConfig, host: ConverterReplayableAudioHost);
    tryEncode(file: File | Blob, fmt: ContainerFormat, inputFmt?: ContainerFormat): Promise<Blob | null>;
    private resolveSource;
    tryEncodeToSink(file: File | Blob, sink: Sink, fmt: ContainerFormat, inputFmt?: ContainerFormat): Promise<boolean>;
    private resolveTarget;
    private encodeSource;
}
