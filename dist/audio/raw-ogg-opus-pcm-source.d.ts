import { ChunkReader } from '../io/chunk-reader.js';
import type { ReplayablePcmSource } from './pcm-source.js';
export { opusPacketFrames } from '../core/opus-packet.js';
export interface OggPage {
    readonly nextOffset: number;
    readonly flags: number;
    readonly serial: number;
    readonly sequence: number;
    readonly granule: number | null;
    readonly lacing: Uint8Array;
    readonly payload: Uint8Array;
}
export declare function readOggPage(reader: ChunkReader, offset: number): Promise<OggPage>;
/** Windowed Ogg Opus source. Every replay re-reads pages and retains <=8 decoded packets. */
export declare function createRawOggOpusPcmSource(file: File | Blob, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
