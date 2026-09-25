import type { Sink } from '../types/io.js';
import type { MatroskaPassThrough, TrackType } from '../types/media.js';
import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { MediaTrack, MediaPacket, RemuxOptions, SegmentOptions } from './engine-core.js';
import type { MediaWriters } from './formats.js';
import type { DiagnosticContext } from '../core/diagnostics.js';
export interface RemuxTrack {
    readonly description: MediaTrack;
    readonly info: MP4TrackInfo;
    readonly type: TrackType;
    readonly order?: readonly number[] | Uint32Array;
}
export declare class RemuxPlanner {
    private readonly format;
    private readonly writers;
    private readonly matroskaPassThrough?;
    private readonly matroskaUnsupportedTags;
    private readonly title?;
    constructor(format: string, writers: MediaWriters, matroskaPassThrough?: MatroskaPassThrough | undefined, matroskaUnsupportedTags?: boolean, title?: string | undefined);
    checkTrackMetadata(tracks: readonly RemuxTrack[], format: string, diagnostics: DiagnosticContext): void;
    checkCopy(tracks: readonly RemuxTrack[]): void;
    prepareSegments(tracks: readonly RemuxTrack[], options: SegmentOptions, diagnostics: DiagnosticContext): {
        writer: import("../index.js").CmafWriter;
        configs: import("../index.js").CmafTrack[];
        byteLimit: number;
        sampleLimit: number;
    };
    prepareContainer(tracks: readonly RemuxTrack[], sink: Sink, options: RemuxOptions, diagnostics: DiagnosticContext): {
        muxer: import("../index.js").OutputMuxer;
        routes: Map<number, (packet: MediaPacket) => void>;
        layout: "standard" | "fragmented";
    };
    resolveRemuxFormat(tracks: readonly RemuxTrack[], options: RemuxOptions): RemuxOptions['format'];
}
