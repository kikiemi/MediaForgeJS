import type { PcmStreamWindow } from './streaming-pcm.js';
/** A source that can be decoded again for multi-pass, bounded-memory codecs. */
export interface ReplayablePcmSource {
    readonly sampleRate: number;
    readonly channels: number;
    readonly estimatedFrames: number;
    chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]>;
}
/** Adds channel mapping, resampling and presentation trimming to a source. */
export declare function normalizePcmSource(source: ReplayablePcmSource, targetSampleRate: number, targetChannels: number, window?: PcmStreamWindow): ReplayablePcmSource;
