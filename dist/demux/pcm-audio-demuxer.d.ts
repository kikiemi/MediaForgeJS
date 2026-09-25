import type { MP4TrackInfo } from './mp4-demuxer.js';
import type { AudioIndexContext } from './standalone-audio-demuxer.js';
interface PcmIndexFormat {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly blockAlign: number;
    readonly codecConfig?: Uint8Array;
}
export declare function indexPcmAudio(context: AudioIndexContext, format: PcmIndexFormat, dataOffset: number, dataLength: number): Promise<MP4TrackInfo>;
/** Indexes supported AIFF/AIFC PCM without reading or converting its sample payload. */
export declare function indexAiff(context: AudioIndexContext): Promise<MP4TrackInfo>;
/** Indexes AU signed integer and IEEE float PCM, including the unknown-size sentinel. */
export declare function indexAu(context: AudioIndexContext): Promise<MP4TrackInfo>;
export {};
