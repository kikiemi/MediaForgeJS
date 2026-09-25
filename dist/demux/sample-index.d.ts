import type { MP4Sample, MP4TrackInfo } from './mp4-demuxer.js';
export interface SampleIndex {
    readonly length: number;
    readonly byteLength: number;
    readonly maxSampleSize: number;
    readonly allKeyframes: boolean;
    readonly presentationSorted: boolean;
    readonly decodeSorted: boolean;
    readonly firstPresentation: number;
    readonly lastPresentationEnd: number;
    get(index: number): MP4Sample;
    timestampAt(index: number): number;
    decodeTimeAt(index: number): number;
    isKeyframeAt(index: number): boolean;
}
export declare function enableCompactMP4Index<T extends object>(target: T): T;
export declare function usesCompactMP4Index(target: object): boolean;
export declare function getCompactSampleIndex(track: MP4TrackInfo): SampleIndex | undefined;
/** Accessing the compatibility array materializes owned objects and ends compact ownership. */
export declare function bindCompactSampleIndex(track: MP4TrackInfo, index: SampleIndex, reserve?: () => void): void;
export declare function sampleCount(track: MP4TrackInfo): number;
export declare function sampleAt(track: MP4TrackInfo, position: number): MP4Sample | undefined;
