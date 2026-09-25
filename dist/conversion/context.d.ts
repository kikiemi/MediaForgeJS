import type { readWavLayout, convertWavStreaming } from '../audio/streaming-wav.js';
import { type MetadataPolicy } from '../core/diagnostics.js';
import type { MediaForgeJSConfig } from '../core/converter-config.js';
import type { PipelineConfig } from '../core/pipeline-config.js';
import type { ConverterAudioDecoder } from '../audio/converter-audio-decoder.js';
import type { ConverterAudioEncoder, ConverterAudioEncoderHost } from '../audio/converter-audio-encoder.js';
import type { ConverterImage, ConverterImageHost } from '../image/converter-image.js';
import type { PipelineAudio, PipelineAudioHost } from '../audio/pipeline-audio.js';
import type { PipelineVideo, PipelineVideoHost } from '../video/pipeline-video.js';
import type { PipelineDom, PipelineDomHost } from '../video/pipeline-dom.js';
import type { ContainerFormat } from '../types/media.js';
import type { MuxerConfig, OutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
import type { NativeDemuxer } from '../core/format-plans.js';
import { type MediaFormat, type MediaWriters } from '../engine/formats.js';
/** Audio conversion implementation; factories share the converter's resolved configuration. */
export interface ConversionAudio {
    /** Optional optimized PCM-to-WAV path; omitted uses the supplied audio factories. */
    readonly wav?: {
        readonly readLayout: typeof readWavLayout;
        readonly convert: typeof convertWavStreaming;
    };
    createDecoder(config: MediaForgeJSConfig, context: ConversionContext): Pick<ConverterAudioDecoder, keyof ConverterAudioDecoder>;
    createEncoder(config: MediaForgeJSConfig, host: ConverterAudioEncoderHost, context: ConversionContext): Pick<ConverterAudioEncoder, keyof ConverterAudioEncoder>;
}
export type ConversionImageFactory = ((config: MediaForgeJSConfig, host: ConverterImageHost) => Pick<ConverterImage, keyof ConverterImage>) & {
    readonly validate?: (file: Blob, format: ContainerFormat, signal?: AbortSignal) => Promise<void>;
};
/** Empty by default. Install formats and the decode/encode stages needed by the application. */
export interface ConversionOptions {
    readonly formats?: readonly MediaFormat[];
    readonly audio?: ConversionAudio;
    readonly image?: ConversionImageFactory;
    readonly pipelineAudio?: (host: PipelineAudioHost) => Pick<PipelineAudio, keyof PipelineAudio>;
    readonly pipelineVideo?: (host: PipelineVideoHost) => Pick<PipelineVideo, keyof PipelineVideo>;
    readonly pipelineDom?: (config: PipelineConfig, host: PipelineDomHost) => Pick<PipelineDom, keyof PipelineDom>;
    /** Extra validation for image formats and the default composition's strict passthrough checks. */
    readonly validate?: (file: Blob, format: ContainerFormat, signal?: AbortSignal) => Promise<void>;
}
export declare function requireConversionComponent<T>(component: T | undefined, name: string): T;
/** Resolved, instance-local format/component composition; no global registrations. */
export declare class ConversionContext {
    private readonly metadataPolicy;
    readonly options: ConversionOptions;
    readonly writers: MediaWriters;
    private readonly readers;
    constructor(options?: ConversionOptions, metadataPolicy?: MetadataPolicy);
    assertFormats(input: ContainerFormat, output: ContainerFormat): void;
    demuxer(format: string): NativeDemuxer | null;
    createMuxer(config: MuxerConfig, sink: Sink): OutputMuxer;
    validate(file: Blob, format: ContainerFormat, signal?: AbortSignal): Promise<void>;
}
