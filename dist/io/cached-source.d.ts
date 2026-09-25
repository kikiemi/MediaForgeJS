import type { Source } from '../types/io.js';
export interface CachedSourceOptions {
    /** Aligned read size in bytes; defaults to 64 KiB. */
    readonly pageBytes?: number;
    /** Maximum retained page bytes; defaults to 4 MiB. Zero disables retention. */
    readonly maxBytes?: number;
}
/** Internal fast path; overridden reads retain their original dispatch and returned bytes remain independent. */
export declare function readCachedSource(source: Source, offset: number, length: number): Uint8Array | undefined;
/** Bounded LRU cache over a stable Source; concurrent page reads are shared, returned bytes are independent. */
export declare class CachedSource implements Source {
    private readonly source;
    readonly size: number;
    private readonly readSource;
    private readonly pageBytes;
    private readonly maxBytes;
    private readonly pages;
    private readonly pending;
    private generation;
    private newest;
    private oldest;
    private retainedBytes;
    constructor(source: Source, options?: CachedSourceOptions);
    get cachedBytes(): number;
    /** Invalidates retained and pending cache entries; existing reads may finish without repopulating this generation. */
    clear(): void;
    read(offset: number, length: number): Promise<Uint8Array>;
    private readRetained;
    private getPage;
    private retain;
    private detach;
    private prepend;
}
