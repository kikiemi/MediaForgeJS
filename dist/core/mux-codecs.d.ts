import type { TrackType } from '../types/media.js';
/** Shared packet-copy eligibility for the muxers and conversion planners. */
export declare function canMuxCodec(format: string, type: TrackType, codec: string): boolean;
/** Prevents unsupported payloads being silently labeled as the container's default codec. */
export declare function assertMuxCodec(format: string, type: TrackType, codec: string): void;
