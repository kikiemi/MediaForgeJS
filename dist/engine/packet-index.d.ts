import type { MP4Sample } from '../demux/mp4-demuxer.js';
export interface PacketCursor {
    readonly track: number;
    position: number;
    time: number;
}
/** One cursor per track; stable O(log tracks) merge without flattening the sample index. */
export declare class PacketHeap {
    private readonly values;
    push(cursor: PacketCursor): void;
    pop(): PacketCursor | undefined;
}
export declare function decodeTime(sample: MP4Sample): number;
export declare function lowerBound(length: number, value: number, at: (index: number) => number): number;
