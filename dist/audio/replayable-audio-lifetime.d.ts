import type { Sink } from '../types/io.js';
import type { ReplayablePcmSource } from './pcm-source.js';
interface ReplayableAudioOptions {
    readonly signal?: AbortSignal;
    readonly onProgress?: (fraction: number, message: string) => void;
    readonly afterPcmChunk?: () => Promise<void>;
}
export declare function runReplayableAudio<T, O extends ReplayableAudioOptions>(source: ReplayablePcmSource, sink: Sink | undefined, options: O, action: (source: ReplayablePcmSource, sink: Sink | undefined, options: O, perform: <V>(operation: () => V) => V) => Promise<T>): Promise<T>;
export {};
