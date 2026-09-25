import type { MP4TrackInfo } from '../demux/mp4-demuxer.js';
import type { AudioTrackConfig, VideoTrackConfig } from '../types/container.js';
import type { ContainerFormat } from '../types/media.js';
export declare function encodedAudioSampleCount(track: MP4TrackInfo, targetRate: number): number;
/** Preserve the independent metadata of a byte-copied secondary video track. */
export declare function copiedVideoTrackConfig(track: MP4TrackInfo): VideoTrackConfig;
/** Preserve the independent metadata of a byte-copied secondary audio track. */
export declare function copiedAudioTrackConfig(track: MP4TrackInfo, outputFormat?: ContainerFormat): AudioTrackConfig;
export interface SourceAudioWindow {
    head: number;
    valid: number;
    startOffset: number;
}
/** Exact coded-to-presentation sample window for a source audio track. */
export declare function sourceAudioWindow(src: MP4TrackInfo, rate: number): SourceAudioWindow;
/** True only for an explicit leading presentation discard, not CodecDelay alone. */
export declare function hasSourceAudioPriming(src: MP4TrackInfo): boolean;
/** Derive a Matroska DiscardPadding window from encoded packet durations. */
export declare function sourceAudioRemuxWindow(src: MP4TrackInfo, rate: number, fmt: ContainerFormat): SourceAudioWindow;
export declare function matroskaAudioWindowFitsFinalPacket(track: MP4TrackInfo): boolean;
