import type { Sink } from '../types/io.js';
import type { ReplayablePcmSource } from './pcm-source.js';
export interface StreamingOpusOptions {
    readonly bitrateBps?: number;
    readonly commentPayload?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly onProgress?: (fraction: number, message: string) => void;
}
export interface StreamingOpusDiagnostics {
    readonly inputFrames: number;
    readonly packets: number;
    readonly peakPcmFrames: number;
}
/** One-pass WebCodecs Opus encoder feeding the streaming Ogg muxer. */
export declare function encodeReplayableOpusToSink(source: ReplayablePcmSource, sink: Sink, options?: StreamingOpusOptions): Promise<StreamingOpusDiagnostics>;
