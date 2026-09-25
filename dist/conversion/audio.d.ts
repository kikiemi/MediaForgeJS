import type { ConversionAudio } from './context.js';
import type { MediaForgeJSConfig } from '../core/converter-config.js';
import type { MP4TrackInfo, MP4Sample } from '../demux/mp4-demuxer.js';
import type { ContainerFormat } from '../types/media.js';
import type { Sink } from '../types/io.js';
import type { ReplayablePcmSource } from '../audio/pcm-source.js';
export type ConversionAudioMetadata = Readonly<Pick<MP4TrackInfo, 'language' | 'name' | 'title' | 'default' | 'forced' | 'commentary'> & {
    movieTitle?: string;
}>;
/** One explicitly installed audio decoder/encoder family. Decoders return replayable PCM. */
export interface ConversionAudioCodec {
    readonly codecs: readonly string[];
    readonly outputs: readonly ContainerFormat[];
    decode?(track: MP4TrackInfo, read: (sample: MP4Sample) => Promise<Uint8Array>, config: MediaForgeJSConfig): Promise<ReplayablePcmSource | null> | ReplayablePcmSource | null;
    encode?(source: ReplayablePcmSource, format: ContainerFormat, sink: Sink, config: MediaForgeJSConfig, metadata?: ConversionAudioMetadata): Promise<void>;
}
/** Composes only the supplied audio families; native browser codec support remains environment-dependent. */
export declare function createAudioConversion(modules: readonly ConversionAudioCodec[]): ConversionAudio;
