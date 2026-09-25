import type { Sink } from '../types/io.js';
import type { ReplayablePcmSource } from './pcm-source.js';
import { type MP4TrackMetadata } from '../core/mp4-metadata.js';
export interface StreamingM4AOptions {
    readonly bitrateKbps?: number;
    readonly moovUserData?: Uint8Array;
    readonly audioLanguage?: string;
    readonly title?: string;
    readonly audioTrack?: MP4TrackMetadata;
    readonly signal?: AbortSignal;
    readonly onProgress?: (fraction: number, message: string) => void;
}
export interface StreamingM4ADiagnostics {
    readonly passes: number;
    readonly inputFrames: number;
    readonly packets: number;
    readonly peakPcmFrames: number;
    readonly planningBytes: number;
}
export declare function encodeReplayableM4AToSink(source: ReplayablePcmSource, sink: Sink, options?: StreamingM4AOptions): Promise<StreamingM4ADiagnostics>;
