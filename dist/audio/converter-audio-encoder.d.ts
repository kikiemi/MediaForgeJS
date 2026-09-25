import type { ContainerFormat, PcmAudioBuffer } from '../types/media.js';
import type { Sink } from '../types/io.js';
import type { MediaForgeJSConfig } from '../core/converter-config.js';
import type { CarriedMetadata } from '../core/converter-context.js';
import { type MP4DemuxResult } from '../demux/mp4-demuxer.js';
export interface ConverterAudioEncoderHost {
    getCarried(): CarriedMetadata;
    getDemuxed?(file: Blob): MP4DemuxResult | undefined;
    decodeAudioToBuffer(file: File | Blob, inputFormat?: ContainerFormat): Promise<PcmAudioBuffer>;
    tryDirectAudioRemux(file: File | Blob, inputFormat: ContainerFormat | undefined, outputFormat: 'm4a'): Promise<Blob | null>;
    audioBitrateBps(): number;
}
/** Audio-only encoding and metadata branch used by MediaForgeConverter. */
export declare class ConverterAudioEncoder {
    private readonly config;
    private readonly host;
    private readonly mpegAudioEncoder;
    private readonly replayableAudio;
    constructor(config: MediaForgeJSConfig, host: ConverterAudioEncoderHost);
    private get carried();
    private decodeAudioToBuffer;
    private tryDirectAudioRemux;
    private audioBitrateBps;
    private collectExtraAudioTracks;
    extractAudio(file: File | Blob, fmt: ContainerFormat, preDecodedBuf?: PcmAudioBuffer, inputFmt?: ContainerFormat): Promise<Blob>;
    /** Bounded audio-only route for convertToSink(). */
    extractAudioToSink(file: File | Blob, sink: Sink, fmt: ContainerFormat, inputFmt?: ContainerFormat): Promise<boolean>;
    private encodeOggOpus;
    private requestedAacCodec;
    private renderForOutput;
    private collectAacFrames;
    private tryWebCodecsAac;
    private encodeAacAudio;
    private encodeADTS;
    private encodeFLAC;
    private encodeRealMP3;
    private encodeRealMP2;
}
