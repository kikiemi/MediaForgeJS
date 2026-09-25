import { MediaEngine as CoreEngine, MediaFile as CoreFile } from './engine-core.js';
import type { MediaEngineOptions, MediaOpenOptions } from './engine-core.js';
import type { Source } from '../types/io.js';
import type { MediaInput } from '../types/media.js';
import type { MP4DemuxResult } from '../demux/mp4-demuxer.js';
import type { DiagnosticContext } from '../core/diagnostics.js';
import { type MediaWriters } from './formats.js';
export type { MediaTrack, MediaPacket, PacketOptions, SampleSearchOptions, MediaOpenOptions, MediaDemuxer, MediaEngineOptions, SegmentOptions, MediaSegment, RemuxOptions, RemuxSupport, RemuxValidationOptions, MediaFormat, MediaMuxer, MediaAudioMuxer, } from './engine-core.js';
/** Includes all built-in formats. Use engine/core for explicit format selection. */
export declare class MediaEngine extends CoreEngine {
    constructor(options?: MediaEngineOptions);
    open(input: Source | MediaInput, options?: MediaOpenOptions): Promise<MediaFile>;
    protected createFile(source: Source, format: string, result: MP4DemuxResult, diagnostics: DiagnosticContext, maxPacketBytes: number, maxSamples: number, releaseSource: () => void, maxIndexBytes: number): MediaFile;
}
export declare class MediaFile extends CoreFile {
    constructor(source: Source, format: string, result: MP4DemuxResult, diagnostics: DiagnosticContext, maxPacketBytes: number, maxSamples: number, releaseSource?: () => void, writers?: MediaWriters, maxIndexBytes?: number);
}
