import type { ReplayablePcmSource } from './pcm-source.js';
export interface WavLayout {
    readonly dataOffset: number;
    readonly dataLength: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly float: boolean;
}
export declare function readWavLayout(file: Blob, signal?: AbortSignal): Promise<WavLayout | null>;
export declare function readWavLayoutFromBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<WavLayout | null>;
export declare function toFloatChannels(bytes: Uint8Array, layout: WavLayout, frames: number): Float32Array[];
export declare function createWavPcmSource(file: Blob, layout: WavLayout): ReplayablePcmSource;
export interface StreamingWavResult {
    readonly blob: Blob;
    readonly frames: number;
}
export interface WavByteSink {
    write(bytes: Uint8Array<ArrayBuffer>): void | Promise<void>;
    abort?(reason?: unknown): void | Promise<void>;
    close?(): void | Promise<void>;
    drain?(): Promise<void>;
}
export declare function convertWavStreaming(file: Blob, layout: WavLayout, targetRate: number, targetChannels: number, options?: {
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void | Promise<void>;
    sink?: WavByteSink;
}): Promise<StreamingWavResult>;
