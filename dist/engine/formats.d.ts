import type { MediaDemuxer } from './engine-core.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { MuxerConfig, OutputMuxer, AudioOutputMuxer } from '../types/container.js';
import type { Sink } from '../types/io.js';
import type { CmafWriter, CmafWriterOptions } from '../streaming/cmaf.js';
export interface MediaMuxerOptions {
    /** Conversion encoders supply decoder configuration with their first output packet. */
    readonly deferCodecConfig?: boolean;
}
export interface MediaMuxer {
    readonly formats: readonly string[];
    /** Validates known configuration without writing; packets and finalize perform output. */
    create(config: MuxerConfig, sink: Sink, options?: MediaMuxerOptions): OutputMuxer;
}
export interface MediaAudioMuxer {
    readonly formats: readonly string[];
    create(format: string, track: MP4TrackInfo, sink: Sink): AudioOutputMuxer;
}
export interface MediaFormat {
    readonly demuxers?: readonly MediaDemuxer[];
    readonly muxers?: readonly MediaMuxer[];
    readonly audioMuxers?: readonly MediaAudioMuxer[];
    readonly createSegmentWriter?: (options: CmafWriterOptions) => CmafWriter;
}
export interface MediaWriters {
    readonly container: ReadonlyMap<string, MediaMuxer['create']>;
    readonly audio: ReadonlyMap<string, MediaAudioMuxer['create']>;
    readonly segments?: MediaFormat['createSegmentWriter'];
}
export declare function createWriters(modules: readonly MediaFormat[]): MediaWriters;
