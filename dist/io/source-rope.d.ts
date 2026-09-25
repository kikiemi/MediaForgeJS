import type { Source } from '../types/io.js';
interface SourceLeaf {
    readonly source: Source;
    readonly read: Source['read'];
    readonly offset: number;
    readonly size: number;
    readonly height: 1;
}
interface SourceBranch {
    readonly left: SourceNode;
    readonly right: SourceNode;
    readonly size: number;
    readonly height: number;
}
export type SourceNode = SourceLeaf | SourceBranch;
export declare function registerSourceRoot(source: Source, read: Source['read'], root: SourceNode | null): void;
export declare function captureSourceRoot(source: Source, name: string): SourceNode | null;
export declare function sourceRangeLength(size: number, offset: number, length: number | undefined, name: string): number;
export declare function joinSourceRoots(left: SourceNode | null, right: SourceNode | null): SourceNode | null;
export declare function sliceSourceRoot(root: SourceNode | null, offset: number, count: number): SourceNode | null;
export declare function readSourceRoot(root: SourceNode | null, size: number, offset: number, length: number, name: string): Promise<Uint8Array>;
export {};
