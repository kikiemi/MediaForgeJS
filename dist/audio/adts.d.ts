import { type ErrorCode } from '../core/errors.js';
export interface AdtsFrameHeader {
    sampleRate: number;
    channels: number;
    audioObjectType: number;
    headerLength: number;
    frameLength: number;
    rawDataBlocks: number;
}
export declare function parseAdtsFrameHeader(adts: Uint8Array, offset?: number): AdtsFrameHeader | null;
/** Split an ADTS stream (7/9-byte headers) into raw AAC access units. */
export declare function sliceAdtsFrames(adts: Uint8Array): Uint8Array[];
/** Sampling rate and channel count from the first ADTS header, if any. */
export declare function parseAdtsHeader(adts: Uint8Array): {
    sampleRate: number;
    channels: number;
} | null;
export declare function buildAacConfig(sampleRate: number, channels: number, audioObjectType: number): Uint8Array;
/** Minimal AudioSpecificConfig for AAC-LC. */
export declare function buildAacAsc(sampleRate: number, channels: number): Uint8Array;
export interface AdtsConfiguration {
    frequencyIndex: number;
    channelConfiguration: number;
}
export declare function getAdtsConfiguration(sampleRate: number, channels: number, code: ErrorCode): AdtsConfiguration;
export declare function getAdtsFrameLength(frame: Uint8Array, code: ErrorCode): number;
export declare function writeAdtsHeader(out: Uint8Array, offset: number, frameLength: number, configuration: AdtsConfiguration): void;
export interface ParsedAacAudioSpecificConfig {
    audioObjectType: number;
    coreAudioObjectType: number;
    sampleRate: number;
    coreSampleRate: number;
    channelCount: number;
    samplesPerAccessUnit: number;
}
export declare function parseAacAudioSpecificConfig(config: Uint8Array): ParsedAacAudioSpecificConfig | null;
export declare function readAacAudioObjectType(config: Uint8Array): number | null;
