import type { PcmAudioBuffer } from '../types/media.js';
export interface InterleaveProgressOptions {
    chunkFrames?: number;
    /** Optional gain applied while interleaving (avoids a full scaled PCM copy). */
    gain?: number;
    onChunk?: (processedFrames: number, totalFrames: number) => void | Promise<void>;
    signal?: AbortSignal;
}
export declare function yieldToEventLoop(): Promise<void>;
export declare function collectChannelViews(audioBuffer: PcmAudioBuffer, channelCount: number): Float32Array[];
export declare function fillInterleavedBlock(channelViews: readonly Float32Array[], frameOffset: number, frameCount: number, scratch: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer>;
export declare function interleaveAudioBuffer(audioBuffer: PcmAudioBuffer, channelCount: number, options?: InterleaveProgressOptions): Promise<Float32Array>;
export declare function renderAudioBuffer(audioBuffer: PcmAudioBuffer, targetSampleRate: number, targetChannels: number, signal?: AbortSignal): Promise<PcmAudioBuffer>;
export declare function encodeAudioBufferWithEncoder(audioBuffer: PcmAudioBuffer, framesPerChunk: number, handleAudioData: (audioData: AudioData) => void | Promise<void>): Promise<void>;
export declare function createAudioBuffer(channelChunks: readonly Float32Array[][], totalFrames: number, sampleRate: number): PcmAudioBuffer;
export declare function createPcmAudioBufferFromChannels(channels: readonly Float32Array[], sampleRate: number): PcmAudioBuffer;
export declare function consumeAudioChunks(channelChunks: Float32Array[][], totalFrames: number, sampleRate: number): PcmAudioBuffer;
export declare function downmixChannels(sources: Float32Array[], sourceChannels: number, outputChannels: number, length: number): Float32Array[];
