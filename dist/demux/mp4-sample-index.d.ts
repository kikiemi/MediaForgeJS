import { type DemuxIndexBudget } from '../core/demux-guard.js';
import type { SampleIndex } from './sample-index.js';
interface Box {
    type: string;
    offset: number;
    size: number;
}
interface Tables {
    sizes: Box;
    chunks: Box;
    layout: Box;
    timing: Box;
    composition: Box | null;
    sync: Box | null;
}
interface IndexOptions {
    tables: Tables;
    bytes: Uint8Array;
    timescale: number;
    shift: number;
    budget: DemuxIndexBudget;
    breathe: () => Promise<void>;
    fitsMedia: (offset: number, size: number) => boolean;
    missing: (count: number, offset: number) => void;
    strict: boolean;
    fileSize: number;
}
/** Keeps timing runs and numeric byte ranges; no per-sample objects survive open. */
export declare function createClassicSampleIndex(options: IndexOptions): Promise<SampleIndex>;
export {};
