import type { AudioTrackConfig } from '../types/container.js';
import type { EncodedChunk } from '../types/media.js';
import type { MP4TrackMetadata } from './mp4-metadata.js';
/** Metadata accumulated during one high-level conversion call. */
export interface CarriedMetadata {
    udta: Uint8Array | null;
    oggComments: Uint8Array | null;
    audioLanguage?: string;
    title?: string;
    audioTrack?: MP4TrackMetadata;
    extraAudio: {
        config: AudioTrackConfig;
        chunks: EncodedChunk[];
    }[];
}
export declare function createCarriedMetadata(): CarriedMetadata;
