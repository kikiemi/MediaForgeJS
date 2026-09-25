import type { CmafTrack } from './cmaf.js';
export declare function cmafAssert(condition: unknown, message: string): asserts condition;
export declare function integer(value: number, label: string, min?: number, max?: number): number;
export declare function ascii(value: string): Uint8Array;
export declare function join(parts: readonly Uint8Array[]): Uint8Array;
export declare function u32(value: number): Uint8Array;
export declare function box(type: string, ...parts: Uint8Array[]): Uint8Array;
export declare function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array;
export declare function buildCmafInit(tracks: readonly CmafTrack[], title?: string): Uint8Array;
