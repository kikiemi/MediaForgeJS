import type { EncodedChunk } from '../types/media.js';
/** Exact numeric sample metadata, without a retained JavaScript object for every packet. */
export declare class MP4SampleTable {
    private readonly pages;
    length: number;
    add(chunk: EncodedChunk, offset: number, retainData: boolean): void;
    clear(): void;
    removeLast(): void;
    timestamp(index: number): number;
    duration(index: number): number;
    decodeTimestamp(index: number): number;
    compositionTimeOffset(index: number): number | undefined;
    byteLength(index: number): number;
    offset(index: number): number;
    setOffset(index: number, offset: number): void;
    isKeyframe(index: number): boolean;
    data(index: number): Uint8Array | undefined;
}
/** Run-length timing tables stay compact for both constant and irregular sample timing. */
export declare class MP4SampleRuns {
    private readonly pages;
    length: number;
    append(value: number): void;
    value(index: number): number;
    count(index: number): number;
    get lastValue(): number;
    replaceLast(value: number): void;
}
