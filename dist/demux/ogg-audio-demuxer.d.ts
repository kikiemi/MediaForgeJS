import type { MP4TrackInfo } from './mp4-demuxer.js';
import type { AudioIndexContext } from './standalone-audio-demuxer.js';
export declare function validateOggComments(packet: Uint8Array, opus: boolean): void;
export declare function indexOggAudio(context: AudioIndexContext, requireOpus: boolean): Promise<MP4TrackInfo>;
