export interface SidxParseOptions {
    /** Absolute byte offset of this complete sidx box in its resource. Default 0n. */
    readonly offset?: bigint;
    /** Complete box limit, at most 1 MiB. Default 1 MiB. */
    readonly maxBytes?: number;
    /** Maximum reference records, at most 65535. Default 65535. */
    readonly maxReferences?: number;
}
export interface SidxReference {
    /** 0 references media bytes; 1 references another index, which this parser does not follow. */
    readonly referenceType: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    /** Presentation ticks in the containing index's timescale. */
    readonly time: bigint;
    readonly duration: bigint;
    readonly startsWithSap: boolean;
    readonly sapType: number;
    readonly sapDeltaTime: bigint;
}
export interface SidxIndex {
    readonly version: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    readonly headerSize: number;
    readonly referenceId: number;
    readonly timescale: number;
    readonly earliestPresentationTime: bigint;
    readonly firstOffset: bigint;
    readonly references: readonly SidxReference[];
}
/** Parses one complete sidx box without retaining input bytes or following nested index references. */
export declare function parseSidx(input: Uint8Array, options?: SidxParseOptions): SidxIndex;
