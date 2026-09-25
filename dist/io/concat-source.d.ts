import type { Source } from '../types/io.js';
export interface SourceRange {
    readonly offset: number;
    /** Omit to select through the end of the source. */
    readonly length?: number;
}
/** Concatenates stable byte sources without reading them; each read returns an independent copy. */
export declare class ConcatSource implements Source {
    readonly size: number;
    private readonly root;
    private static readonly readConcat;
    constructor(sources: readonly Source[]);
    /** Lazily joins selected byte intervals in supplied order, including overlaps and repeats. */
    static fromRanges(source: Source, ranges: readonly SourceRange[]): ConcatSource;
    read(offset: number, length: number): Promise<Uint8Array>;
}
