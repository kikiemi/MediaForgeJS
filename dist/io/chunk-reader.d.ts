import type { Source } from '../types/io.js';
export declare const MAX_ELEMENT_BYTES: number;
export declare const CHUNK_BYTES: number;
export interface ByteReader {
    readonly size: number;
    /** Returned views are borrowed: read only, and never transfer their backing buffers. */
    bytes(pos: number, len: number): Promise<Uint8Array>;
}
export declare class ChunkReader implements ByteReader {
    private readonly source;
    readonly size: number;
    private readonly readSource;
    private readonly cache;
    private readonly pending;
    constructor(source: Source);
    bytes(pos: number, len: number): Promise<Uint8Array>;
    private cachedChunk;
    private chunk;
    private readChunk;
}
