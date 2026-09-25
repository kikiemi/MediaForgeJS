export type { ConversionOptions, ConversionAudio } from './conversion/context.js';
import { type ConversionOptions } from './conversion/context.js';
import type { ContainerFormat, MediaInput } from './types/media.js';
import { type MediaForgeJSConfig } from './core/converter-config.js';
import type { Sink } from './types/io.js';
export { readFlacMetaBlocks, injectFlacMetaBlocks, readId3v2Prefix } from './core/audio-metadata.js';
import { type ReadableStreamSinkOptions } from './io/readable-stream-sink.js';
/** Configuration for MediaForgeConverter; unset numeric fields mean "keep the source value". */
export type { MediaForgeJSConfig } from './core/converter-config.js';
export declare class MediaForgeConverter {
    private config;
    private readonly audioDecoderComponent?;
    private get audioDecoder();
    private readonly components;
    private inFlight;
    private operationFailure;
    private carried;
    private readonly audioEncoderComponent?;
    private get audioEncoder();
    private readonly imageComponent?;
    private get image();
    private detected;
    /** Creates a converter bound to `config`; one conversion at a time per instance. */
    constructor(config?: Partial<MediaForgeJSConfig>, options?: ConversionOptions);
    /** Sniffs the input and returns its container/image format without starting a conversion. */
    detectFormat(input: MediaInput): Promise<ContainerFormat>;
    private hasTransformOptions;
    private beginCall;
    convertToSink(file: MediaInput, sink: Sink): Promise<void>;
    convertToReadableStream(file: MediaInput, options?: ReadableStreamSinkOptions): ReadableStream<Uint8Array>;
    private sinkDelegated;
    private recordFailure;
    private normalizeCancellation;
    private checkCompletion;
    private convertToSinkInner;
    /** Returns converted media as a Blob. Cancellation carries code 'ABORT'; callback failures retain their original reason. */
    convert(file: MediaInput): Promise<Blob>;
    private convertInner;
    private validateLinearPcmWav;
    private streamWavToSink;
    private tryStreamingWav;
    private audioBitrateBps;
    private assertSingleAudioTrack;
    /** Output dimensions: explicit config wins; a single side keeps aspect. */
    convertImage(file: MediaInput, format?: ContainerFormat): Promise<Blob>;
    private chooseNativeDemuxer;
    private validatePassthrough;
    private planningDemux;
    private planningDemuxError;
    private checkOutputMetadata;
    private inspectPrimaryTracks;
    private resolvePipelineCodecs;
    private tryDirectAudioRemux;
    private convertVideo;
    private videoToImage;
    assertAnimatedImageBudget(totalFrames: number, w: number, h: number, fmt: string): void;
    private demuxAndExtractAudio;
    private selectAudioTrack;
    private decodeDemuxedAudioTrack;
    private decodeAudioToBuffer;
    private extractAudio;
}
