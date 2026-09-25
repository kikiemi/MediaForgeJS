import type { TrackDescriptor } from '../types/media.js';
/** Internal hook for caller-owned public metadata copies; never modifies a prototype. */
export declare function withTrackJson<T extends TrackDescriptor>(track: T): T;
/**
 * Serialize track metadata with decimal-string uint64 UIDs and numeric codecConfig arrays.
 * Reads known fields once on the original receiver. Other enumerable fields follow JSON rules.
 * Limits: 4096 tracks, 1 MiB codecConfig per track, 16 Mi UTF-16 code units of JSON text.
 */
export declare function serializeTracks(tracks: readonly TrackDescriptor[]): string;
/**
 * Restore metadata (not media packets) from serializeTracks or JSON.stringify(file.tracks).
 * Only top-level matroskaTrackUid and codecConfig fields are decoded. Returns owned bytes.
 * Accepts canonical decimal UIDs in 1..2^64-1; numeric UIDs are rejected. Same limits as serializeTracks.
 */
export declare function deserializeTracks(json: string): TrackDescriptor[];
